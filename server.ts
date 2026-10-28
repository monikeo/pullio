import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import http from "http";
import { isIP } from "net";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import https from "https";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import ffmpegPath from "ffmpeg-static";
import multer from "multer";
import { AudioEnhancementSettings, AudioExportFormat, buildAudioEnhancementFilters, buildAudioCleanupFilters, getAudioEncoderArgs, validateAudioEnhancement, validateAudioExport } from "./src/lib/audioEnhancement";
import { AudioEditSettings, resolveAudioEdit, validateAudioEdit } from './src/lib/audioEditing';
import { readAudioWaveform } from './src/lib/audioWaveform.server';
import { ZipFile } from 'yazl';
import { DownloadRecord, downloadIdentity, isDemoMediaUrl, publicDownloadRecord } from './src/lib/downloads';
import { DownloadJournal } from './src/lib/downloadJournal.server';
import { runDownloadWorker } from './src/lib/downloadWorker.server';

const execFileAsync = promisify(execFile);

// Path to static ffmpeg binary directory
const FFMPEG_DIR = ffmpegPath ? path.dirname(ffmpegPath) : "";

// Path to the bundled yt-dlp binary shipped with youtube-dl-exec
const YT_DLP_PATH = path.join(
  process.cwd(),
  "node_modules",
  "youtube-dl-exec",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

// Optional Netscape cookies file for content accessible to the account that owns the session.
const COOKIES_FILE = path.join(process.cwd(), "cookies.txt");

/** Normalizes platform-specific web share links (YouTube, Facebook, Instagram, Douyin, etc.) into canonical extractor URLs */
function normalizeMediaUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  let url = rawUrl.trim();

  // YouTube: Normalize mobile links and shortlinks to canonical watch links
  if (url.includes('youtu.be/')) {
    const ytMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/i);
    if (ytMatch && ytMatch[1]) {
      return `https://www.youtube.com/watch?v=${ytMatch[1]}`;
    }
  }
  if (url.includes('m.youtube.com/watch')) {
    url = url.replace('m.youtube.com', 'www.youtube.com');
  }

  // Facebook: Normalize mobile domains to www
  if (url.includes('m.facebook.com') || url.includes('mobile.facebook.com') || url.includes('web.facebook.com')) {
    url = url.replace(/\/\/(m|mobile|web)\.facebook\.com/i, '//www.facebook.com');
  }

  // Instagram: Normalize mobile domains and clean plural /reels/ to /reel/
  if (url.includes('m.instagram.com')) {
    url = url.replace('m.instagram.com', 'www.instagram.com');
  }
  if (url.includes('instagram.com/reels/')) {
    url = url.replace('instagram.com/reels/', 'instagram.com/reel/');
  }

  // Douyin: Handle modal_id query param (e.g. /jingxuan?modal_id=123, /recommend?modal_id=123, /user/...?modal_id=123)
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) {
    const modalMatch = url.match(/[?&]modal_id=(\d+)/i);
    if (modalMatch && modalMatch[1]) {
      return `https://www.douyin.com/video/${modalMatch[1]}`;
    }
    const noteMatch = url.match(/\/note\/(\d+)/i);
    if (noteMatch && noteMatch[1]) {
      return `https://www.douyin.com/video/${noteMatch[1]}`;
    }
    const shareMatch = url.match(/iesdouyin\.com\/share\/video\/(\d+)/i);
    if (shareMatch && shareMatch[1]) {
      return `https://www.douyin.com/video/${shareMatch[1]}`;
    }
    const mobileVideoMatch = url.match(/douyin\.com\/share\/video\/(\d+)/i);
    if (mobileVideoMatch && mobileVideoMatch[1]) {
      return `https://www.douyin.com/video/${mobileVideoMatch[1]}`;
    }
  }

  // Bilibili: bvid in query params or short links
  if (url.includes('bilibili.com') && !url.includes('/video/')) {
    const bvidMatch = url.match(/[?&]bvid=(BV[a-zA-Z0-9]+)/i);
    if (bvidMatch && bvidMatch[1]) {
      const part = url.match(/[?&]p=(\d+)/)?.[1];
      return `https://www.bilibili.com/video/${bvidMatch[1]}${part ? `?p=${part}` : ''}`;
    }
  }

  // Pinterest: Normalize pin IDs and clean trailing query noise
  if (url.includes('pinterest.com/pin/')) {
    const pinMatch = url.match(/pinterest\.com\/pin\/(\d+)/i);
    if (pinMatch && pinMatch[1]) {
      return `https://www.pinterest.com/pin/${pinMatch[1]}/`;
    }
  }

  return url;
}

/** Remove aggressive tracking queries from media URLs */
function cleanMediaTrackingParams(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const trackingParams = [
      'spm_id_from', 'vd_source', 'trackid', 'from_source', 'share_source',
      'igsh', 'utm_source', 'utm_medium', 'utm_campaign', 'si', 'share_token',
      'mid', 'sender_device', 'is_from_webapp', 'previous_page', 'app_code',
      'enter_from', 'tab_name', 'extra_params', 'share_app_id', 'mibextid',
      'ref', '_rdr', 'extid', 'sfnsn', 'paipv', 'rdid', 'feature', 'pp', 'img_index'
    ];
    for (const p of trackingParams) {
      parsed.searchParams.delete(p);
    }
    return normalizeMediaUrl(parsed.toString());
  } catch {
    return normalizeMediaUrl(rawUrl);
  }
}

/** Extracts valid HTTP(S) media URL out of arbitrary user clipboard text (mobile share text) */
function extractMediaUrlFromText(input: string): string {
  if (!input) return '';
  const sanitized = input.replace(/\uff1b/g, ';');
  const trimmed = sanitized.trim();
  let candidate = trimmed;
  const match = trimmed.match(/https?:\/\/[^\s\u4e00-\u9fa5\r\n\t]+/i);
  if (match) {
    candidate = match[0];
  }
  candidate = candidate.replace(/[)\]}>,.!?;:，。！？；\uff1b]+$/, '');
  return cleanMediaTrackingParams(candidate);
}

/** Resolve short links (fb.watch, v.douyin.com, xhslink.com, pin.it, b23.tv, vt.tiktok.com, etc.) by following HTTP redirects */
async function resolveShortMediaUrl(targetUrl: string): Promise<string> {
  if (!targetUrl) return targetUrl;
  let currentUrl = targetUrl;
  const shortLinkDomains = [
    "fb.watch", "facebook.com", "v.douyin.com", "douyin.com", "xhslink.com",
    "pin.it", "b23.tv", "tiktok.com", "t.co", "bit.ly",
  ];

  try {
    const initial = new URL(targetUrl);
    const initialHost = initial.hostname.toLowerCase();
    const isShortlink = shortLinkDomains.some(domain => initialHost === domain || initialHost.endsWith(`.${domain}`));
    if (!isShortlink) return targetUrl;

    // Resolve one redirect at a time so every destination is checked before
    // the server makes a request to it.
    for (let redirectCount = 0; redirectCount < 6; redirectCount++) {
      const urlCheck = isValidMediaUrl(currentUrl);
      if (!urlCheck.valid) throw new Error(urlCheck.error || "Invalid short-link destination");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      let res: Response;
      try {
        res = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        const nextUrl = new URL(location, currentUrl).toString();
        const nextCheck = isValidMediaUrl(nextUrl);
        if (!nextCheck.valid) throw new Error(nextCheck.error || "Invalid short-link destination");
        currentUrl = nextUrl;
        continue;
      }

      await res.body?.cancel();
      return currentUrl;
    }
    throw new Error("Short link redirected too many times");
  } catch (error) {
    throw new Error(`Could not safely resolve the short link: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validate media URL for safety and SSRF prevention */
function isValidMediaUrl(inputUrl: string): { valid: boolean; error?: string } {
  if (typeof inputUrl !== 'string' || inputUrl.length > 8000) return { valid: false, error: 'Enter a media URL of up to 8,000 characters.' };
  try {
    const parsed = new URL(inputUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Only HTTP and HTTPS protocols are supported.' };
    }
    const hostname = parsed.hostname.toLowerCase();
    const address = hostname.replace(/^\[|\]$/g, "");
    const ipVersion = isIP(address);
    const ipv4Parts = ipVersion === 4 ? address.split(".").map(Number) : [];
    const isPrivateIpv4 = ipVersion === 4 && (
      ipv4Parts[0] === 0 || ipv4Parts[0] === 10 || ipv4Parts[0] === 127 ||
      (ipv4Parts[0] === 169 && ipv4Parts[1] === 254) ||
      (ipv4Parts[0] === 172 && ipv4Parts[1] >= 16 && ipv4Parts[1] <= 31) ||
      (ipv4Parts[0] === 192 && ipv4Parts[1] === 168) ||
      (ipv4Parts[0] === 100 && ipv4Parts[1] >= 64 && ipv4Parts[1] <= 127) ||
      (ipv4Parts[0] >= 224)
    );
    const normalizedIpv6 = address.toLowerCase().split("%", 1)[0];
    const isPrivateIpv6 = ipVersion === 6 && (
      normalizedIpv6 === "::" || normalizedIpv6 === "::1" ||
      normalizedIpv6.startsWith("::ffff:") || normalizedIpv6.startsWith("fc") ||
      normalizedIpv6.startsWith("fd") || /^fe[89ab]/.test(normalizedIpv6) || normalizedIpv6.startsWith("ff")
    );
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      isPrivateIpv4 ||
      isPrivateIpv6
    ) {
      return { valid: false, error: 'Access to private or local network hosts is restricted.' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format.' };
  }
}

// Structured logger with timestamps and levels (debug-log skill)
const log = {
  info: (tag: string, msg: string, data?: any) => {
    const d = data !== undefined ? ` | Data: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
    console.log(`[${new Date().toISOString()}] [INFO] [${tag}] ${msg}${d}`);
  },
  warn: (tag: string, msg: string, data?: any) => {
    const d = data !== undefined ? ` | Data: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
    console.warn(`[${new Date().toISOString()}] [WARN] [${tag}] ${msg}${d}`);
  },
  error: (tag: string, msg: string, err?: any) => {
    const e = err ? ` | Error: ${err.message || err}` : '';
    console.error(`[${new Date().toISOString()}] [ERROR] [${tag}] ${msg}${e}`);
  },
  debug: (tag: string, msg: string, data?: any) => {
    if (process.env.DEBUG) {
      const d = data !== undefined ? ` | Data: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
      console.log(`[${new Date().toISOString()}] [DEBUG] [${tag}] ${msg}${d}`);
    }
  }
};

export interface ClassifiedError {
  category: 'BOT_CHECK' | 'RATE_LIMIT' | 'AUTH_REQUIRED' | 'PRIVATE_VIDEO' | 'GEO_BLOCKED' | 'FORMAT_UNAVAILABLE' | 'NOT_FOUND' | 'TIMEOUT' | 'UNKNOWN';
  message: string;
  retryable: boolean;
  suggestedFallback?: string;
}

/** Categorize yt-dlp stderr output into user-friendly diagnostic messages (debug-error skill) */
export function classifyMediaError(rawError: string | Error | any, provider = 'generic'): ClassifiedError {
  const combined = `${rawError?.stderr || ''} ${rawError?.message || ''} ${String(rawError || '')}`;
  const str = combined.toLowerCase();

  if ((provider === 'bilibili' || str.includes('bilibili')) && (str.includes('412') || str.includes('precondition failed'))) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Bilibili returned HTTP 412 (a precondition or security check). Confirm the video opens in your browser; if it is account-restricted, configure your own valid Bilibili session cookies. This app cannot bypass platform challenges.',
      retryable: false
    };
  }

  if (
    (provider === 'douyin' || str.includes('douyin') || str.includes('iesdouyin')) &&
    (str.includes('verify') || str.includes('验证') || str.includes('验证码') || str.includes('captcha') ||
      str.includes('slide') || str.includes('risk control') || str.includes('风险') || str.includes('ttwid') ||
      str.includes('s_v_web_id') || str.includes('fresh cookies') || str.includes('403') || str.includes('412'))
  ) {
    return {
      category: 'BOT_CHECK',
      message: 'Douyin returned a security or verification challenge. Complete checks through Douyin’s official site or app; this downloader cannot bypass them. Your own valid session may help only with content your account is allowed to access.',
      retryable: false
    };
  }

  if (str.includes('429') || str.includes('too many requests') || str.includes('rate-limit')) {
    return {
      category: 'RATE_LIMIT',
      message: `${provider.toUpperCase()} rate limit reached (HTTP 429). Please pause briefly before queueing more transfers.`,
      retryable: false
    };
  }

  if ((provider === 'bilibili' || str.includes('bilibili')) && str.includes('403')) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Bilibili denied access (HTTP 403). Check that the video opens for your account; if it is account-restricted, configure your own valid Bilibili session cookies. This app cannot bypass platform challenges.',
      retryable: false
    };
  }

  if (str.includes('403') || str.includes('forbidden')) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'The platform denied access (HTTP 403). Check that the link opens for your account and that the post is public or otherwise authorized.',
      retryable: false
    };
  }

  if (str.includes('412') || str.includes('precondition failed')) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'The platform returned HTTP 412 (a precondition or security check). Confirm the link opens in your browser and retry only if the platform permits access. This app cannot bypass platform challenges.',
      retryable: false
    };
  }

  if (str.includes('sign in to confirm') || str.includes('not a bot') || str.includes('po token') || str.includes('captcha')) {
    return {
      category: 'BOT_CHECK',
      message: `${provider.toUpperCase()} requires a platform verification or challenged this request. Complete checks through the official site; this app cannot bypass them. Retry only if you are authorized and the platform permits downloading.`,
      retryable: false
    };
  }

  // Instagram anti-scraping / session verification check
  if (
    (str.includes('instagram') || provider === 'instagram') &&
    (str.includes('empty media response') || str.includes('not granting access') || str.includes('checkpoint_required') || str.includes('login_required') || str.includes('cookies for the authentication'))
  ) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Instagram anti-crawler protection: Instagram requires session cookies for access. Please add your Instagram session cookies (sessionid) in Settings to download.',
      retryable: false
    };
  }

  // Facebook anti-scraping / login check
  if (
    (str.includes('facebook') || provider === 'facebook') &&
    (str.includes('login') || str.includes('checkpoint') || str.includes('private') || str.includes('friends-only') || str.includes('log in to continue'))
  ) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Facebook privacy restriction: This video is private/friends-only or requires authentication. Please check post visibility or add Facebook cookies in Settings.',
      retryable: false
    };
  }

  // Non-ASCII / Latin-1 encoding errors (e.g. Chinese full-width semicolons in cookies or headers)
  if (
    str.includes('unicodeencodeerror') ||
    str.includes('latin-1') ||
    str.includes('ordinal not in range') ||
    str.includes('\uff1b') ||
    str.includes('\\uff1b')
  ) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Invalid cookie or header character encoding: Full-width Chinese punctuation (；) or non-ASCII characters detected. Pullio has auto-sanitized the cookies — please retry.',
      retryable: true
    };
  }

  // XiaoHongShu (小红书) image note vs video note classification
  if (
    (str.includes('xiaohongshu') || str.includes('xhs') || provider === 'xiaohongshu') &&
    (str.includes('no video') || str.includes('extract_note') || str.includes('not a video') || str.includes('extractorerror'))
  ) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'This XiaoHongShu note (小红书笔记) appears to be an image gallery (图文笔记) or requires login cookies to access. Only video notes can be extracted as video.',
      retryable: false
    };
  }

  // Vimeo password protected or domain restricted
  if (
    (str.includes('vimeo') || provider === 'vimeo') &&
    (str.includes('password') || str.includes('private') || str.includes('403') || str.includes('forbidden'))
  ) {
    return {
      category: 'PRIVATE_VIDEO',
      message: 'This Vimeo video is password protected, private, or domain-restricted by its creator.',
      retryable: false
    };
  }

  // Pinterest static pin
  if (
    (str.includes('pinterest') || provider === 'pinterest') &&
    (str.includes('no video') || str.includes('format not available'))
  ) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'This Pinterest pin is a static image or GIF without an MP4 video stream.',
      retryable: false
    };
  }

  if (str.includes('private video') || str.includes('this video is private') || str.includes('members-only')) {
    return {
      category: 'PRIVATE_VIDEO',
      message: 'This video is private, members-only, or restricted by the creator.',
      retryable: false
    };
  }

  if (str.includes('not available in your country') || str.includes('geo-restricted') || str.includes('geo blocked')) {
    return {
      category: 'GEO_BLOCKED',
      message: 'This media is geo-restricted and not licensed for streaming in this region.',
      retryable: false
    };
  }

  if (str.includes('requested format is not available') || str.includes('format not available')) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'The requested resolution stream was not provided by the host. Auto-retrying with best standard stream...',
      retryable: true,
      suggestedFallback: 'best'
    };
  }

  if (
    str.includes('video is unavailable') ||
    str.includes('video unavailable') ||
    str.includes('this video is unavailable') ||
    str.includes('does not exist') ||
    str.includes('not found') ||
    str.includes('404')
  ) {
    return {
      category: 'NOT_FOUND',
      message: 'Media not found. The video or playlist may have been deleted, set to private, or the URL is invalid.',
      retryable: false
    };
  }

  if (str.includes('timed out') || str.includes('timeout') || str.includes('socket hang up') || str.includes('econnreset')) {
    return {
      category: 'TIMEOUT',
      message: 'Connection timed out while extracting media streams. Retrying usually succeeds.',
      retryable: true
    };
  }

  let cleanMsg = rawError?.stderr || rawError?.message || String(rawError || '');
  cleanMsg = cleanMsg.replace(/^Command failed:.*?yt-dlp(\.exe)?\s+/is, '');
  const lines = cleanMsg.split(/[\r\n]+/).map((l: string) => l.trim()).filter((l: string) => l.length > 0);
  const errorLine = lines.find((l: string) => l.startsWith('ERROR:')) || lines[0] || 'Failed to process media request.';

  return {
    category: 'UNKNOWN',
    message: errorLine.replace(/^ERROR:\s*/i, ''),
    retryable: false
  };
}

/** Strips non-ASCII / non-latin1 characters and converts Chinese full-width punctuation to standard ASCII */
function sanitizeCookieContent(raw: string): string {
  if (!raw) return "";
  return raw
    // Replace full-width semicolon (；) with standard semicolon (;)
    .replace(/\uff1b/g, ';')
    // Replace full-width colon (：) with standard colon (:)
    .replace(/\uff1a/g, ':')
    // Replace full-width equals (＝) with standard equals (=)
    .replace(/\uff1d/g, '=')
    // Replace full-width comma (，) with standard comma (,)
    .replace(/\uff0c/g, ',')
    // Replace full-width spaces and non-breaking spaces with standard space
    .replace(/[\u3000\u00a0]/g, ' ')
    // Replace curly quotes with standard double quotes
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

let lastSanitizedMtime = 0;

/** Sanitizes on-disk cookies.txt to guarantee pure Latin-1 / ASCII compliance and eliminate UnicodeEncodeError */
function sanitizeExistingCookiesFile(): void {
  if (!fs.existsSync(COOKIES_FILE)) return;
  try {
    const stats = fs.statSync(COOKIES_FILE);
    if (stats.mtimeMs === lastSanitizedMtime && lastSanitizedMtime > 0) return;

    const raw = fs.readFileSync(COOKIES_FILE, "utf-8");
    const sanitized = sanitizeCookieContent(raw);
    const lines = sanitized.split(/[\r\n]+/);
    const cleanLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return trimmed;
      const parts = trimmed.split("\t");
      if (parts.length >= 7) {
        // parts[5] is name, parts[6] is value
        parts[5] = parts[5].replace(/[^\x20-\x7E]/g, '');
        parts[6] = parts[6].replace(/[^\x20-\x7E]/g, '');
        return parts.join("\t");
      }
      return trimmed.replace(/[^\x20-\x7E]/g, '');
    }).filter(Boolean);

    const result = cleanLines.join("\n") + "\n";
    const normalizedRaw = raw.replace(/\r\n/g, "\n").trim();
    const normalizedResult = result.trim();

    if (normalizedResult !== normalizedRaw) {
      fs.writeFileSync(COOKIES_FILE, result, "utf-8");
      lastSanitizedMtime = fs.statSync(COOKIES_FILE).mtimeMs;
      log.info("AUTH", "Auto-sanitized existing cookies.txt for ASCII Latin-1 compliance");
    } else {
      lastSanitizedMtime = stats.mtimeMs;
    }
  } catch (err: any) {
    log.warn("AUTH", "Failed to sanitize cookies.txt", err.message);
  }
}

/** Parses raw cookie string (from browser DevTools or extension) into standard Netscape cookie format */
function parseRawCookieStringToNetscape(cookieStr: string, defaultDomain = ".bilibili.com"): string {
  const sanitized = sanitizeCookieContent(cookieStr.trim());

  if (sanitized.includes("\t") || sanitized.startsWith("# Netscape")) {
    const lines = sanitized.split(/[\r\n]+/);
    const cleanLines = lines.map(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) return trimmedLine;
      const parts = trimmedLine.split("\t");
      if (parts.length >= 7) {
        parts[5] = parts[5].replace(/[^\x20-\x7E]/g, '');
        parts[6] = parts[6].replace(/[^\x20-\x7E]/g, '');
        return parts.join("\t");
      }
      return trimmedLine.replace(/[^\x20-\x7E]/g, '');
    }).filter(Boolean);
    return cleanLines.join("\n") + "\n";
  }

  const expiry = Math.floor(Date.now() / 1000) + 365 * 24 * 3600; // 1 year
  const lines = [
    "# Netscape HTTP Cookie File",
    "# http://curl.haxx.se/rfc/cookie_spec.html",
    "# Generated by Pullio Cookie Manager for platform authentication",
  ];

  const pairs = sanitized.split(/[;\r\n]+/).map((s) => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      let name = pair.slice(0, eqIdx).trim();
      let value = pair.slice(eqIdx + 1).trim();
      // Strip any non-ASCII characters to prevent Python Latin-1 UnicodeEncodeError
      name = name.replace(/[^\x20-\x7E]/g, '');
      value = value.replace(/[^\x20-\x7E]/g, '');
      if (name && value) {
        lines.push(`${defaultDomain}\tTRUE\t/\tFALSE\t${expiry}\t${name}\t${value}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

/** Return status and summary of active cookies.txt configuration */
function getCookiesSummary() {
  if (!fs.existsSync(COOKIES_FILE)) {
    return { configured: false, size: 0, domains: [] as string[], updatedAt: null as number | null };
  }
  try {
    const stats = fs.statSync(COOKIES_FILE);
    const content = fs.readFileSync(COOKIES_FILE, "utf-8");
    const domainSet = new Set<string>();
    const lines = content.split(/[\r\n]+/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed) continue;
      const parts = trimmed.split("\t");
      if (parts.length >= 1 && parts[0]) {
        domainSet.add(parts[0].replace(/^\./, ""));
      }
    }
    return {
      configured: true,
      size: stats.size,
      updatedAt: stats.mtimeMs,
      domains: Array.from(domainSet),
    };
  } catch {
    return { configured: false, size: 0, domains: [] as string[], updatedAt: null as number | null };
  }
}

/** Use yt-dlp's native extractor defaults and a supported JS runtime for YouTube challenges. */
function getYtDlpRuntimeArgs(): string[] {
  const args: string[] = [];
  const nodeMajorVersion = Number(process.versions.node.split(".")[0]);

  // yt-dlp requires Node 22+ for its YouTube EJS challenge solver. Pass the
  // exact Node executable running this server instead of relying on PATH.
  if (nodeMajorVersion >= 22) {
    args.push("--js-runtimes", `node:${process.execPath}`);
  }

  if (fs.existsSync(COOKIES_FILE)) {
    sanitizeExistingCookiesFile();
    args.push("--cookies", COOKIES_FILE);
  }

  return args;
}

/** Fetch video metadata and formats, retrying network failures over IPv4 once. */
async function getYtDlpInfo(url: string, retry = 0): Promise<any> {
  const args = [
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "30",
    ...(retry > 0 ? ["--force-ipv4"] : []),
    ...getYtDlpRuntimeArgs(),
    url,
  ];
  try {
    const { stdout } = await execFileAsync(YT_DLP_PATH, args, { timeout: 90000, maxBuffer: 15 * 1024 * 1024 });
    return JSON.parse(stdout.trim());
  } catch (err: any) {
    const errorText = `${err?.code || ''} ${err?.message || ''} ${err?.stderr || ''}`.toLowerCase();
    const isNetworkFailure = /econnreset|econnrefused|ehostunreach|enetunreach|eai_again|etimedout|socket hang up|network is unreachable/.test(errorText);
    if (retry < 1 && isNetworkFailure) {
      log.warn("YT-DLP", `Analysis attempt ${retry + 1} failed for ${url}. Retrying over IPv4...`, err.message);
      return getYtDlpInfo(url, retry + 1);
    }
    throw err;
  }
}

/** Get the yt-dlp format selection argument based on selected quality and media type */
function isAudioFormatToken(itag: string | number): boolean {
  const value = String(itag).toLowerCase();
  if (value.startsWith("yt:")) {
    return value.startsWith("yt:audio:") || value.startsWith("yt:audio-source:");
  }
  return /^(?:audio(?:-|$)|bestaudio(?:$|\/))/.test(value) || value.includes("mp3");
}

function getYtDlpFormatArg(itag: string | number, type: 'video' | 'audio'): string {
  const itagStr = String(itag).toLowerCase().trim();

  // These opaque IDs are generated from yt-dlp's own format list. Limit the
  // alphabet before handing a format ID back to yt-dlp's format parser.
  const streamMatch = String(itag).match(/^yt:(video|merge|raw|audio|audio-source):([A-Za-z0-9_.-]{1,128})$/);
  if (streamMatch) {
    const [, streamType, formatId] = streamMatch;
    if (streamType === "merge") return `${formatId}+bestaudio/${formatId}`;
    return formatId;
  }

  // Audio extraction: always select best audio source for transcoding
  if (type === 'audio' || itagStr.startsWith('audio') || itagStr.includes('mp3')) {
    return 'bestaudio/best';
  }

  if (itagStr === 'bestaudio') return 'bestaudio/best';
  if (itagStr === 'best') {
    return 'bestvideo*+bestaudio/best';
  }

  // Explicit Facebook / social platform quality identifiers (HD vs SD)
  if (itagStr === 'hd' || itagStr.startsWith('hd-')) {
    const isVideoOnly = itagStr.includes('video-only') || itagStr.includes('muted');
    if (isVideoOnly) {
      return 'hd[vcodec!=none]/bestvideo[height>=720]/bestvideo[width>=720]/best[height>=720]/best';
    }
    return 'hd/bestvideo[height>=720]+bestaudio/bestvideo[width>=720]+bestaudio/best[height>=720]/best[width>=720]/best';
  }
  if (itagStr === 'sd' || itagStr.startsWith('sd-')) {
    const isVideoOnly = itagStr.includes('video-only') || itagStr.includes('muted');
    if (isVideoOnly) {
      return 'sd[vcodec!=none]/bestvideo[height<=576]/bestvideo[width<=576]/best[height<=576]/best';
    }
    return 'sd/bestvideo[height<=576]+bestaudio/bestvideo[width<=576]+bestaudio/best[height<=576]/best[width<=576]/best';
  }

  const heightMatch = itagStr.match(/(\d+)/);
  if (heightMatch) {
    const res = parseInt(heightMatch[1], 10);
    const isVideoOnly = itagStr.includes('video-only') || itagStr.includes('muted');

    if (isVideoOnly) {
      return [
        `bestvideo[height<=${res}][aspect_ratio>=1][ext=mp4]`,
        `bestvideo[width<=${res}][aspect_ratio<1][ext=mp4]`,
        `bestvideo[height<=${res}][aspect_ratio>=1]`,
        `bestvideo[width<=${res}][aspect_ratio<1]`,
        `bestvideo[height<=${res}]`,
        `bestvideo[width<=${res}]`,
        `best[height<=${res}]`,
        `best[width<=${res}]`
      ].join('/');
    }

    // Cap landscape streams by height and portrait streams by width.
    return [
      `bestvideo[height<=${res}][aspect_ratio>=1][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[width<=${res}][aspect_ratio<1][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${res}][aspect_ratio>=1]+bestaudio`,
      `bestvideo[width<=${res}][aspect_ratio<1]+bestaudio`,
      `bestvideo[height<=${res}]+bestaudio`,
      `bestvideo[width<=${res}]+bestaudio`,
      `best[height<=${res}]`,
      `best[width<=${res}]`
    ].join('/');
  }

  if (itagStr.includes('video-only') || itagStr.includes('muted')) {
    return 'bestvideo/best';
  }

  return 'bestvideo+bestaudio/best';
}

/** Return the actual downloadable stream choices exposed by yt-dlp. */
function buildMediaFormatList(info: any) {
  const videoFormats: any[] = [];
  const videoOnlyFormats: any[] = [];
  const audioFormats: any[] = [];
  const rawFormats = (Array.isArray(info.formats) ? info.formats : [])
    .filter((f: any) => {
      const formatId = String(f.format_id || "");
      return f.ext !== "mhtml" && f.protocol !== "mhtml" && f.format_note !== "storyboard" &&
        ((f.vcodec && f.vcodec !== "none") || (f.acodec && f.acodec !== "none")) &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(formatId);
    })
    .sort((a: any, b: any) => {
      const aResolution = Math.max(a.height || 0, a.width || 0);
      const bResolution = Math.max(b.height || 0, b.width || 0);
      if (bResolution !== aResolution) return bResolution - aResolution;
      if ((b.fps || 0) !== (a.fps || 0)) return (b.fps || 0) - (a.fps || 0);
      return (b.tbr || b.vbr || b.abr || 0) - (a.tbr || a.vbr || a.abr || 0);
    });

  for (const f of rawFormats) {
    const formatId = String(f.format_id);
    const hasVideo = Boolean(f.vcodec && f.vcodec !== "none" && f.video_ext !== "none");
    const hasAudio = Boolean(f.acodec && f.acodec !== "none" && f.audio_ext !== "none");
    const width = Number(f.width || 0) || undefined;
    const height = Number(f.height || 0) || undefined;
    const resRank = width && height ? Math.min(width, height) : Math.max(width || 0, height || 0);
    const dimensions = width && height ? `${width}×${height}` : f.resolution || "";
    const effectiveResolution = resRank ? `${resRank}p` : (f.format_note || "Video");
    const fps = Number(f.fps || 0) || undefined;
    const codec = String(f.vcodec || "").split(".")[0];
    const ext = String(f.ext || "").toUpperCase();
    const fpsLabel = fps ? ` · ${fps} fps` : "";
    const dimensionsLabel = dimensions ? ` · ${dimensions}` : "";
    const codecLabel = codec && codec !== "none" ? ` · ${codec}` : "";
    const extLabel = ext ? ` · ${ext}` : "";
    const filesize = f.filesize || f.filesize_approx;

    if (hasVideo) {
      const quality = `${effectiveResolution}${dimensionsLabel}${fpsLabel}${codecLabel}${extLabel}`;
      videoFormats.push({
        itag: hasAudio ? `yt:video:${formatId}` : `yt:merge:${formatId}`,
        quality: hasAudio ? `${quality} · audio included` : `${quality} · merge best audio`,
        type: "video",
        fps,
        width,
        height,
        vcodec: f.vcodec,
        acodec: f.acodec,
        bitrate: Number(f.tbr || f.vbr || 0) || undefined,
        filesize,
        ext: f.ext,
        resRank,
      });

      if (!hasAudio) {
        videoOnlyFormats.push({
          itag: `yt:raw:${formatId}`,
          quality: `${quality} · video only`,
          type: "video-only",
          fps,
          width,
          height,
          vcodec: f.vcodec,
          bitrate: Number(f.tbr || f.vbr || 0) || undefined,
          filesize,
          ext: f.ext,
          resRank,
        });
      }
    } else if (hasAudio) {
      const abr = Number(f.abr || 0);
      const audioCodec = String(f.acodec || "Audio").split(".")[0];
      audioFormats.push({
        itag: `yt:audio-source:${formatId}`,
        quality: `${abr ? `${Math.round(abr)} kbps · ` : ""}${audioCodec}${extLabel} · original audio`,
        type: "audio",
        acodec: f.acodec,
        bitrate: Number(f.abr || f.tbr || 0) || undefined,
        filesize,
        ext: f.ext,
        sourceExt: f.ext,
        resRank: abr,
      });
    }
  }

  // Keep explicit MP3 encoder targets for playlist and legacy UI controls.
  const mp3Targets = [
    { itag: "audio-320", quality: "MP3 · 320 kbps target", type: "audio", ext: "mp3" },
    { itag: "audio-256", quality: "MP3 · 256 kbps target", type: "audio", ext: "mp3" },
    { itag: "audio-128", quality: "MP3 · 128 kbps target", type: "audio", ext: "mp3" },
  ];

  if (videoFormats.length === 0) {
    videoFormats.push({ itag: "best", quality: "Best available video and audio", type: "video", resRank: 0 });
  }
  if (audioFormats.length === 0) {
    audioFormats.push({ itag: "audio", quality: "Best available audio · MP3 output", type: "audio", ext: "mp3" });
  }

  videoFormats.sort((a, b) => (b.resRank || 0) - (a.resRank || 0) || (b.fps || 0) - (a.fps || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  videoOnlyFormats.sort((a, b) => (b.resRank || 0) - (a.resRank || 0) || (b.fps || 0) - (a.fps || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  audioFormats.sort((a, b) => (b.resRank || 0) - (a.resRank || 0));

  return [...videoFormats, ...videoOnlyFormats, ...audioFormats, ...mp3Targets];
}

/** Check if a given URL is a playlist, album, collection, or showcase */
function isPlaylistUrl(url: string, provider: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("list=") ||
    lower.includes("playlist") ||
    lower.includes("album") ||
    lower.includes("showcase/") ||
    lower.includes("channels/") ||
    lower.includes("medialist") ||
    lower.includes("collectiondetail") ||
    lower.includes("seriesdetail") ||
    (lower.includes("pinterest.com") && lower.includes("/boards/")) ||
    (lower.includes("soundcloud.com") && lower.includes("/sets/"))
  );
}

/** Fetch playlist metadata and entries, retrying network failures over IPv4 once. */
async function getYtDlpPlaylistInfo(url: string, retry = 0): Promise<any> {
  const listMatch = url.match(/[?&]list=([^&#]+)/);
  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const targetUrl = (listMatch && isYouTube) ? `https://www.youtube.com/playlist?list=${listMatch[1]}` : url;

  const args = [
    "--dump-single-json",
    "--flat-playlist",
    "--yes-playlist",
    "--no-warnings",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "30",
    ...(retry > 0 ? ["--force-ipv4"] : []),
    ...getYtDlpRuntimeArgs(),
    targetUrl,
  ];
  try {
    const { stdout } = await execFileAsync(YT_DLP_PATH, args, { timeout: 120000, maxBuffer: 30 * 1024 * 1024 });
    return JSON.parse(stdout.trim());
  } catch (err: any) {
    if (retry < 1) {
      log.warn("YT-DLP", `Playlist extraction attempt ${retry + 1} failed for ${targetUrl}. Retrying over IPv4...`, err.message);
      return getYtDlpPlaylistInfo(url, retry + 1);
    }
    throw err;
  }
}

/** Helper to clean up any files associated with a jobId (e.g., partial or failed downloads) */
function cleanJobFiles(jobId: string) {
  try {
    const downloadsDir = DOWNLOADS_DIR;
    if (!fs.existsSync(downloadsDir)) return;
    const files = fs.readdirSync(downloadsDir);
    files.forEach(f => {
      if (f.startsWith(`${jobId}.`) && !archiveInputs.has(path.join(downloadsDir, f))) {
        fs.unlinkSync(path.join(downloadsDir, f));
      }
    });
  } catch (err) {
    console.error(`Error cleaning up files for job ${jobId}:`, err);
  }
}

function serveMockPlaylist(res: any, provider: string, url: string, activeTrack?: any, playlistId?: string) {
  let title = "Media Playlist Showcase";
  let author = "Flux Curated";
  let thumbnail = "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&q=80&w=400";
  
  if (provider === "youtube") {
    title = "Curated Music Playlist";
    author = "Lofi Vibes";
    thumbnail = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&q=80&w=400";
  } else if (provider === "instagram") {
    title = "Summer Travel Highlights";
    author = "@globe_trotter";
    thumbnail = "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&q=80&w=400";
  }

  const listId = playlistId || "playlist";
  const playlistItems = [];

  // If a single video was successfully extracted from the URL, place it as the first track!
  if (activeTrack) {
    playlistItems.push(activeTrack);
  }

  // Add highly premium organic mock tracks to populate the list
  playlistItems.push(
    {
      id: `pl-${listId}-1`,
      title: activeTrack ? `Sunrise Serenade (Curated B-Side)` : `Track 1: Ambient Sunrise Serenade`,
      thumbnail: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=80&w=200",
      duration: 195,
      url: 'https://demo.pullio.invalid/video?item=1'
    },
    {
      id: `pl-${listId}-2`,
      title: `Track 2: Midnight City Drives`,
      thumbnail: "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&q=80&w=200",
      duration: 242,
      url: 'https://demo.pullio.invalid/audio?item=2'
    },
    {
      id: `pl-${listId}-3`,
      title: `Track 3: Neon Rain Chillout`,
      thumbnail: "https://images.unsplash.com/photo-1515621061946-eff1c2a352bd?auto=format&fit=crop&q=80&w=200",
      duration: 178,
      url: 'https://demo.pullio.invalid/audio?item=3'
    }
  );

  return res.json({
    provider,
    url,
    title: activeTrack ? `Playlist: ${activeTrack.title} & Mix` : title,
    thumbnail: activeTrack ? activeTrack.thumbnail : thumbnail,
    author: activeTrack ? `Mix Curated for ${activeTrack.title}` : author,
    formats: [
      { itag: "1080p", quality: "1080p Full HD", type: "video" },
      { itag: "1080p-video-only", quality: "1080p Full HD (Video Only)", type: "video-only" },
      { itag: "720p", quality: "720p HD", type: "video" },
      { itag: "720p-video-only", quality: "720p HD (Video Only)", type: "video-only" },
      { itag: "480p", quality: "480p SD", type: "video" },
      { itag: "480p-video-only", quality: "480p SD (Video Only)", type: "video-only" },
      { itag: "360p", quality: "360p SD", type: "video" },
      { itag: "360p-video-only", quality: "360p SD (Video Only)", type: "video-only" },
      { itag: "audio-320", quality: "320kbps MP3", type: "audio" },
      { itag: "audio-128", quality: "128kbps MP3", type: "audio" }
    ],
    isPlaylist: true,
    playlistItems,
  });
}

function serveMockSingleVideo(res: any, provider: string, url: string) {
  let title = `Sample ${provider.toUpperCase()} Video`;
  let author = `${provider.toUpperCase()} Creator`;
  let thumbnail = "https://images.unsplash.com/photo-1611162617474-5b21e879e113?auto=format&fit=crop&q=80&w=400";
  let duration = 145;
  
  if (provider === "tiktok") {
    title = "Aesthetic Culinary & Kitchen Organization ASMR";
    author = "@minimal_lifestyle";
    thumbnail = "https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&q=80&w=400";
    duration = 58;
  } else if (provider === "instagram") {
    title = "Cinematic Drone Footage over Swiss Alps";
    author = "@aerial_beauty";
    thumbnail = "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&q=80&w=400";
    duration = 42;
  } else if (provider === "facebook") {
    title = "Satisfying Kinetic Woodworking Stream";
    author = "Crafty Hands";
    thumbnail = "https://images.unsplash.com/photo-1534224039826-c7a0dea0e66a?auto=format&fit=crop&q=80&w=400";
    duration = 360;
  } else if (provider === "bilibili") {
    title = "Synthwave Neon Cityscape Animation Loop 4K";
    author = "Bili_Otaku_Mixer";
    thumbnail = "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=400";
    duration = 180;
  } else if (provider === "douyin") {
    title = "Chongqing Cyberpunk Hongyadong Night View 4K (重庆洪崖洞夜景)";
    author = "@travel_china_douyin";
    thumbnail = "https://images.unsplash.com/photo-1544644181-1484b3fdfc62?auto=format&fit=crop&q=80&w=400";
    duration = 35;
  } else if (provider === "xiaohongshu") {
    title = "Tokyo Minimalist Coffee Walk & Cafe Vlog (东京探店Vlog)";
    author = "@tokyo_daily_notes";
    thumbnail = "https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?auto=format&fit=crop&q=80&w=400";
    duration = 48;
  } else if (provider === "pinterest") {
    title = "Aesthetic Interior Design & Scandinavian Living Inspiration";
    author = "Nordic Living Studio";
    thumbnail = "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&q=80&w=400";
    duration = 25;
  } else if (provider === "vimeo") {
    title = "Cinematic 35mm Film Showcase — The North Sea Odyssey";
    author = "Kasper Film Works";
    thumbnail = "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&q=80&w=400";
    duration = 210;
  }

  return res.json({
    provider,
    url,
    title,
    thumbnail,
    author,
    duration,
    formats: [
      { itag: "1080p", quality: "1080p Full HD", type: "video" },
      { itag: "1080p-video-only", quality: "1080p Full HD (Video Only)", type: "video-only" },
      { itag: "720p", quality: "720p HD", type: "video" },
      { itag: "720p-video-only", quality: "720p HD (Video Only)", type: "video-only" },
      { itag: "360p", quality: "360p SD", type: "video" },
      { itag: "360p-video-only", quality: "360p SD (Video Only)", type: "video-only" },
      { itag: "audio", quality: "320kbps MP3", type: "audio" }
    ],
    isPlaylist: false,
  });
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.K_SERVICE ? "0.0.0.0" : "127.0.0.1");
const STORAGE_ROOT = path.resolve(process.env.PULLIO_STORAGE_DIR || process.cwd());
const DOWNLOADS_DIR = path.join(STORAGE_ROOT, "downloads");
const UPLOADS_DIR = path.join(STORAGE_ROOT, "uploads");
const CONVERTED_DIR = path.join(STORAGE_ROOT, "converted");

// Ensure directories exist
[DOWNLOADS_DIR, UPLOADS_DIR, CONVERTED_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Allowed media extensions whitelist and dangerous extension blacklist
const ALLOWED_UPLOAD_EXTS = new Set([
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'gif',
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff'
]);

const DANGEROUS_UPLOAD_EXTS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'php', 'js', 'vbs', 'ps1', 'jar', 'pif', 'scr', 'html', 'htm', 'svg', 'dll', 'com', 'msi', 'reg'
]);

function isPermittedUploadFile(originalName: string): boolean {
  if (!originalName || originalName.includes('\0')) return false;
  const parts = originalName.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return false;
  // Inspect every extension segment to prevent double-extension evasion
  for (const part of parts.slice(1)) {
    if (DANGEROUS_UPLOAD_EXTS.has(part)) return false;
  }
  const primaryExt = parts[parts.length - 1];
  return ALLOWED_UPLOAD_EXTS.has(primaryExt);
}

function isValidJobId(jobId: string): boolean {
  return typeof jobId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(jobId);
}

function isValidUploadId(uploadId: string): boolean {
  return typeof uploadId === 'string' && /^[a-f0-9]{32}$/i.test(uploadId);
}

// Configure Multer for File Uploads
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueId = crypto.randomUUID().replace(/-/g, '');
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 100);
    cb(null, `${uniqueId}_${sanitized}`);
  },
});

const mediaUpload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB
    files: 20,
  },
  fileFilter: (_req, file, cb) => {
    if (isPermittedUploadFile(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("File rejected: only valid audio and video media files are permitted by security policy."));
    }
  },
});

export interface ConversionJob {
  jobId: string;
  uploadId: string;
  inputPath: string;
  originalName: string;
  originalSize: number;
  targetFormat: string;
  qualityPreset?: string;
  videoResolution?: string;
  audioBitrate?: string;
  studioPurpose?: 'preview' | 'cleanup-preview' | 'enhancement';
  enhancementSettings?: AudioEnhancementSettings;
  audioEdit?: AudioEditSettings;
  exportQuality?: string;
  status: 'queued' | 'converting' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  speed?: string;
  eta?: string;
  error?: string;
  outputPath?: string;
  outputFileName?: string;
  outputFileSize?: string;
  outputBytes?: number;
  duration?: number;
  createdAt: number;
}

const conversionJobs = new Map<string, ConversionJob>();
const studioWaveforms = new WeakMap<ConversionJob, ReturnType<typeof readAudioWaveform>>();
const uploadedFiles = new Map<string, { path: string; originalName: string; size: number }>();
const activeConversionProcesses = new Map<string, any>();
const lastConvertBroadcastTime = new Map<string, number>();
let globalWss: WebSocketServer | null = null;

function broadcastConvertUpdate(jobId: string, force = false) {
  const job = conversionJobs.get(jobId);
  if (!job) return;

  const now = Date.now();
  const lastTime = lastConvertBroadcastTime.get(jobId) || 0;
  if (!force && job.status !== 'completed' && job.status !== 'failed' && (now - lastTime < 150)) {
    return;
  }
  lastConvertBroadcastTime.set(jobId, now);

  const payload = JSON.stringify({
    type: "convert-progress",
    job: {
      ...job,
      downloadUrl: `/api/convert/download/${job.jobId}`,
    },
  });

  const subscribers = wsSubscriptions.get(jobId);
  if (subscribers) {
    subscribers.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch {}
      }
    });
  }

  if (globalWss) {
    globalWss.clients.forEach((client: any) => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch {}
      }
    });
  }
}

function getMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const args = ["-protocol_whitelist", "file,pipe", "-i", filePath];
    execFile(ffmpegPath || "ffmpeg", args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (_err, _stdout, stderr) => {
      const output = stderr || "";
      const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (durMatch) {
        const hours = parseFloat(durMatch[1]);
        const mins = parseFloat(durMatch[2]);
        const secs = parseFloat(durMatch[3]);
        return resolve(hours * 3600 + mins * 60 + secs);
      }
      resolve(0);
    });
  });
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const MAX_CONCURRENT_CONVERSIONS = 2;
let activeConversionsCount = 0;
const pendingConversionQueue: string[] = [];
const pendingConversionJobIds = new Set<string>();

function enqueueConversionJob(jobId: string) {
  if (pendingConversionJobIds.has(jobId) || activeConversionProcesses.has(jobId)) return;
  pendingConversionQueue.push(jobId);
  pendingConversionJobIds.add(jobId);
  tryProcessNextConversion();
}

function tryProcessNextConversion() {
  if (activeConversionsCount >= MAX_CONCURRENT_CONVERSIONS || pendingConversionQueue.length === 0) return;
  const jobId = pendingConversionQueue.shift();
  if (jobId) pendingConversionJobIds.delete(jobId);
  if (jobId) {
    activeConversionsCount++;
    processConversionJob(jobId).finally(() => {
      activeConversionsCount--;
      tryProcessNextConversion();
    });
  }
}

async function processConversionJob(jobId: string) {
  const job = conversionJobs.get(jobId);
  if (!job) return;

  job.status = "converting";
  job.progress = 0;
  job.speed = "Starting...";
  job.eta = "Calculating...";
  broadcastConvertUpdate(jobId, true);

  try {
    if (!fs.existsSync(job.inputPath)) {
      throw new Error("Input source file missing or removed from server.");
    }

    const sourceDuration = await getMediaDuration(job.inputPath);
    if (conversionJobs.get(jobId) !== job) return;
    const totalDuration = job.studioPurpose === 'enhancement'
      ? resolveAudioEdit(job.audioEdit || validateAudioEdit(undefined), sourceDuration, job.enhancementSettings?.speed || 1).duration
      : sourceDuration;
    job.duration = totalDuration;

    const baseName = path.parse(job.originalName).name.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100) || 'audio';
    const targetExt = job.targetFormat.toLowerCase();
    const suffix = job.studioPurpose === 'enhancement' ? 'enhanced' : job.studioPurpose === 'cleanup-preview' ? 'cleaned_preview' : job.studioPurpose === 'preview' ? 'preview' : 'converted';
    const outputFileName = `${baseName}_${suffix}.${targetExt}`;
    const outputPath = path.join(CONVERTED_DIR, `${jobId}_${outputFileName}`);
    job.outputPath = outputPath;
    job.outputFileName = outputFileName;

    const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'];
    const args: string[] = ["-y", "-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", job.inputPath];

    if (job.studioPurpose) {
      args.push('-map', '0:a:0', '-vn', '-map_metadata', '-1');
      if (job.enhancementSettings) {
        const filters = job.studioPurpose === 'cleanup-preview'
          ? buildAudioCleanupFilters(job.enhancementSettings)
          : buildAudioEnhancementFilters(job.enhancementSettings, job.audioEdit, sourceDuration);
        if (filters.length) args.push('-af', filters.join(','));
      }
      if (job.studioPurpose === 'preview' || job.studioPurpose === 'cleanup-preview') args.push('-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2');
      else args.push(...getAudioEncoderArgs(targetExt as AudioExportFormat, job.exportQuality!));
    } else if (AUDIO_FORMATS.includes(targetExt)) {
      args.push("-vn");
      const bitrate = job.audioBitrate || (job.qualityPreset?.includes('k') ? job.qualityPreset : '320k');
      if (targetExt === 'mp3') {
        args.push("-c:a", "libmp3lame", "-b:a", bitrate);
      } else if (targetExt === 'wav') {
        args.push("-c:a", "pcm_s16le");
      } else if (targetExt === 'flac') {
        args.push("-c:a", "flac");
      } else if (targetExt === 'aac' || targetExt === 'm4a') {
        args.push("-c:a", "aac", "-b:a", bitrate || '256k');
      } else if (targetExt === 'ogg') {
        args.push("-c:a", "libvorbis", "-b:a", bitrate || '192k');
      } else if (targetExt === 'opus') {
        args.push("-c:a", "libopus", "-b:a", bitrate || '192k');
      } else {
        args.push("-c:a", "libmp3lame", "-b:a", "320k");
      }
    } else if (targetExt === 'gif') {
      args.push("-vf", "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse");
    } else {
      // Target is video
      let scaleFilter = "";
      const resolutionMatch = job.videoResolution?.match(/^(4320|2160|1440|1080|720|480|360)p$/);
      if (resolutionMatch) {
        // Cap output height at the chosen resolution without upscaling smaller sources.
        scaleFilter = `scale=-2:min(${resolutionMatch[1]}\\,ih)`;
      }

      if (scaleFilter) {
        args.push("-vf", scaleFilter);
      }

      if (targetExt === 'mp4') {
        args.push("-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
      } else if (targetExt === 'mkv') {
        args.push("-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-b:a", "192k");
      } else if (targetExt === 'webm') {
        args.push("-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-c:a", "libopus", "-b:a", "128k");
      } else if (targetExt === 'mov') {
        args.push("-c:v", "libx264", "-preset", "fast", "-c:a", "aac", "-b:a", "192k");
      } else if (targetExt === 'avi') {
        args.push("-c:v", "mpeg4", "-q:v", "4", "-c:a", "libmp3lame", "-b:a", "192k");
      } else if (targetExt === 'flv') {
        args.push("-c:v", "flv1", "-c:a", "mp3", "-b:a", "128k");
      } else if (targetExt === 'wmv') {
        args.push("-c:v", "wmv2", "-b:v", "2M", "-c:a", "wmav2", "-b:a", "192k");
      } else {
        args.push("-c:v", "libx264", "-preset", "fast", "-c:a", "aac");
      }
    }

    args.push(outputPath);

    log.info("CONVERT", `Starting conversion job ${jobId} -> ${targetExt}`);
    const child = spawn(ffmpegPath || "ffmpeg", args, { timeout: 15 * 60 * 1000 });
    activeConversionProcesses.set(jobId, child);

    let stderrData = "";
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      child.stderr.on("data", (chunk) => {
      const line = chunk.toString();
      stderrData = (stderrData + line).slice(-32_000);

      const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      const speedMatch = line.match(/speed=\s*([0-9.]+x)/);

      let updated = false;

      if (timeMatch && totalDuration > 0) {
        const curHours = parseFloat(timeMatch[1]);
        const curMins = parseFloat(timeMatch[2]);
        const curSecs = parseFloat(timeMatch[3]);
        const curTotal = curHours * 3600 + curMins * 60 + curSecs;
        const pct = Math.min(99, Math.max(1, (curTotal / totalDuration) * 100));
        job.progress = Math.round(pct * 10) / 10;
        updated = true;

        if (speedMatch) {
          job.speed = speedMatch[1];
          const speedNum = parseFloat(speedMatch[1]);
          if (speedNum > 0) {
            const remSecs = Math.max(0, Math.ceil((totalDuration - curTotal) / speedNum));
            job.eta = `${String(Math.floor(remSecs / 60)).padStart(2, "0")}:${String(remSecs % 60).padStart(2, "0")}`;
          }
        }
      } else if (timeMatch) {
        job.progress = Math.min(95, job.progress + 2);
        updated = true;
      }

      if (updated) {
        broadcastConvertUpdate(jobId);
      }
      });

      child.on("close", (code) => {
      activeConversionProcesses.delete(jobId);
      try {
        if (conversionJobs.get(jobId) !== job) {
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
          return;
        }
        if (code === 0 && fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          job.status = "completed";
          job.progress = 100;
          job.speed = "0x";
          job.eta = "00:00";
          job.outputFileSize = formatBytes(stats.size);
          job.outputBytes = stats.size;
          broadcastConvertUpdate(jobId, true);
          log.info("CONVERT", `Conversion job ${jobId} completed successfully! Size: ${job.outputFileSize}`);
        } else {
          job.status = "failed";
          job.error = /matches no streams|does not contain any stream/i.test(stderrData)
            ? 'This source does not contain a decodable audio track.'
            : job.studioPurpose ? 'Audio processing failed. Check that the source has a supported audio track and try again.'
            : `FFmpeg conversion failed (code ${code}). ${stderrData.slice(-120)}`;
          broadcastConvertUpdate(jobId, true);
          log.error("CONVERT", `Conversion job ${jobId} failed with code ${code}`);
        }
      } catch (err: any) {
        if (conversionJobs.get(jobId) === job) {
          job.status = "failed";
          job.error = err.message || "Failed to finalize conversion output.";
          broadcastConvertUpdate(jobId, true);
        }
      } finally {
        finish();
      }
      });

      child.on("error", (err) => {
      activeConversionProcesses.delete(jobId);
      if (conversionJobs.get(jobId) === job) {
        job.status = "failed";
        job.error = `Failed to spawn FFmpeg: ${err.message}`;
        broadcastConvertUpdate(jobId, true);
        log.error("CONVERT", `FFmpeg spawn error for job ${jobId}: ${err.message}`);
      }
      finish();
      });
    });

  } catch (err: any) {
    activeConversionProcesses.delete(jobId);
    if (conversionJobs.get(jobId) !== job) return;
    job.status = "failed";
    job.error = err.message || "Conversion failed";
    broadcastConvertUpdate(jobId, true);
    log.error("CONVERT", `Unexpected conversion error for job ${jobId}: ${err.message}`);
  }
}


type DownloadJob = DownloadRecord;

const DEFAULT_FILENAME_TEMPLATE = "{title} - {platform}";
const FILENAME_TEMPLATE_TOKENS = new Set(["title", "platform", "date", "quality", "ext"]);

function validateFilenameTemplate(value: unknown): string | null {
  if (value === undefined) return DEFAULT_FILENAME_TEMPLATE;
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 120) return null;
  const template = value.trim();
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(template)) return null;
  const withoutTokens = template.replace(/\{([^{}]+)\}/g, (_match, token: string) => {
    if (!FILENAME_TEMPLATE_TOKENS.has(token)) return "\u0000";
    return "";
  });
  return /[{}\u0000]/.test(withoutTokens) ? null : template;
}

function makeDownloadFileName(job: DownloadJob, extension: string): string {
  const qualityText = String(job.itag);
  const inferredQuality = job.type === "audio"
    ? (qualityText.match(/(?:audio-)?(\d{2,3})/)?.[1] ? `${qualityText.match(/(?:audio-)?(\d{2,3})/)?.[1]}kbps` : "audio")
    : (qualityText.match(/(\d{3,4})p/i)?.[0] || "best");
  const values: Record<string, string> = {
    title: job.title,
    platform: job.provider,
    date: new Date().toISOString().slice(0, 10),
    quality: job.filenameQuality || inferredQuality,
    ext: extension.replace(/^\./, "").toLowerCase(),
  };
  const expanded = job.filenameTemplate.replace(/\{(title|platform|date|quality|ext)\}/g, (_match, token: string) => values[token]);
  let safeName = expanded
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 150)
    .trim();
  if (!safeName || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName)) safeName = `_${safeName || "download"}`;
  const safeExtension = extension.replace(/^\./, "").toLowerCase();
  return job.filenameTemplate.includes("{ext}") ? safeName : `${safeName}.${safeExtension}`;
}

const jobQueue = new Map<string, DownloadJob>();
const downloadJournal = new DownloadJournal(path.join(STORAGE_ROOT, 'pullio-data', 'download-queue.json'));
let lastQueueSave = 0;
let shuttingDown = false;
const archiveInputs = new Map<string, number>();
const isDemoUrl = (url: string) => isDemoMediaUrl(url, process.env.PULLIO_ENABLE_DEMOS === '1' && process.env.NODE_ENV !== 'production');

function persistDownloadQueue(force = false) {
  if (!force && Date.now() - lastQueueSave < 1000) return;
  lastQueueSave = Date.now();
  downloadJournal.save({ version: 1, maxConcurrentDownloads, jobs: [...jobQueue.values()] });
}

async function recoverDownloadQueue() {
  const saved = await downloadJournal.load() as any;
  if (!saved || saved.version !== 1 || !Array.isArray(saved.jobs)) return;
  if (Number.isInteger(saved.maxConcurrentDownloads) && saved.maxConcurrentDownloads >= 1 && saved.maxConcurrentDownloads <= 4) maxConcurrentDownloads = saved.maxConcurrentDownloads;
  const restored: DownloadJob[] = [];
  for (const raw of saved.jobs.slice(0, 500)) {
    if (!raw || !/^[a-f0-9-]{36}$/i.test(raw.jobId) || typeof raw.url !== 'string' || raw.url.length > 8000 || !isValidMediaUrl(raw.url).valid || !['video', 'audio'].includes(raw.type) || !['queued', 'downloading', 'paused', 'completed', 'failed'].includes(raw.status)) continue;
    if (!(typeof raw.itag === 'string' && raw.itag.length > 0 && raw.itag.length <= 256) && !(typeof raw.itag === 'number' && Number.isFinite(raw.itag))) continue;
    const status = raw.status === 'downloading' ? 'queued' : raw.status;
    const text = (value: unknown, fallback: string, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, max) : fallback;
    const job: DownloadJob = {
      jobId: raw.jobId, url: raw.url, itag: raw.itag, type: raw.type, status, stage: status,
      provider: text(raw.provider, 'generic', 30), title: text(raw.title, 'Recovered download'), thumbnail: text(raw.thumbnail, '', 2000),
      targetContainer: ['mp4', 'mkv', 'webm', 'mp3', 'm4a'].includes(raw.targetContainer) ? raw.targetContainer : raw.type === 'audio' ? 'mp3' : 'mkv',
      filenameTemplate: validateFilenameTemplate(raw.filenameTemplate) || DEFAULT_FILENAME_TEMPLATE, filenameQuality: text(raw.filenameQuality, '', 32),
      progress: Math.max(0, Math.min(100, Number(raw.progress) || 0)), speed: status === 'paused' ? 'Paused' : '0 MB/s', eta: status === 'queued' ? 'Recovering queue…' : '--:--',
      fileSize: text(raw.fileSize, 'Unknown', 32), bytesDownloaded: text(raw.bytesDownloaded, '0 MB', 32), downloadedBytes: Number.isFinite(raw.downloadedBytes) ? Math.max(0, raw.downloadedBytes) : 0,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(), updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
      queuePosition: Number.isInteger(raw.queuePosition) ? raw.queuePosition : undefined,
      outputFileName: text(raw.outputFileName, '', 180), mimeType: text(raw.mimeType, 'application/octet-stream', 100),
      error: raw.status === 'failed' ? text(raw.error, 'Download interrupted') : undefined,
      recoveryMessage: status === 'queued' ? 'Recovered after server restart. Continuing available partial files.' : status === 'paused' ? 'Recovered paused download.' : undefined,
    };
    if (typeof raw.fileName === 'string' && path.basename(raw.fileName) === raw.fileName && raw.fileName.startsWith(`${job.jobId}.`)) {
      const candidate = path.join(DOWNLOADS_DIR, raw.fileName);
      if (fs.existsSync(candidate)) {
        const resolved = fs.realpathSync(candidate);
        if (resolved.startsWith(`${fs.realpathSync(DOWNLOADS_DIR)}${path.sep}`) && fs.statSync(resolved).isFile()) {
          job.fileName = raw.fileName; job.filePath = resolved;
        }
      }
    }
    if (status === 'completed' && (!job.filePath || !fs.existsSync(job.filePath))) {
      job.status = 'failed'; job.stage = 'failed'; job.error = 'The saved file has expired or was removed. Retry to download it again.';
    }
    if (status === 'completed') job.progress = 100;
    if (jobQueue.has(job.jobId)) continue;
    jobQueue.set(job.jobId, job); restored.push(job);
  }
  restored.filter(job => job.status === 'queued').sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || a.createdAt - b.createdAt).forEach(job => {
    pendingDownloadQueue.push(job.jobId); pendingDownloadJobIds.add(job.jobId);
  });
  refreshPendingDownloadQueuePositions();
}

function duplicateDownload(candidate: DownloadJob, allowDuplicate: unknown): DownloadJob | undefined {
  if (allowDuplicate === true) return;
  const identity = downloadIdentity(candidate);
  return [...jobQueue.values()].find(job => job.status !== 'failed' && downloadIdentity(job) === identity && (job.status !== 'completed' || Boolean(job.filePath && fs.existsSync(job.filePath))));
}

async function stopDownloadProcess(jobId: string) {
  const child = activeChildProcesses.get(jobId);
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 5000);
    child.once('close', finish);
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => { if (child.exitCode !== null) finish(); });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { finish(); } } }
  });
}

function resolveAudioStudioSource(value: unknown): { path: string; originalName: string; size: number; uploadId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an audio source first.');
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  if (typeof id !== 'string' || !['download', 'conversion', 'upload'].includes(String(kind))) throw new Error('Invalid audio source reference.');
  let source: { path: string; originalName: string; size: number; uploadId: string } | undefined;
  let root: string;
  if (kind === 'upload') {
    if (!isValidUploadId(id)) throw new Error('Invalid upload ID.');
    const upload = uploadedFiles.get(id);
    if (upload) source = { ...upload, uploadId: id };
    root = UPLOADS_DIR;
  } else if (kind === 'download') {
    if (!isValidJobId(id)) throw new Error('Invalid download ID.');
    const job = jobQueue.get(id);
    if (job?.status === 'completed' && job.filePath) {
      source = { path: job.filePath, originalName: job.outputFileName || `${job.title}${path.extname(job.filePath)}`, size: 0, uploadId: '' };
    }
    root = DOWNLOADS_DIR;
  } else {
    if (!isValidJobId(id)) throw new Error('Invalid conversion ID.');
    const job = conversionJobs.get(id);
    if (job?.status === 'completed' && job.outputPath) {
      source = { path: job.outputPath, originalName: job.outputFileName || `audio.${job.targetFormat}`, size: 0, uploadId: '' };
    }
    root = CONVERTED_DIR;
  }
  if (!source || !fs.existsSync(source.path)) throw new Error('The source is unavailable or has expired. Upload it again or download it again.');
  const resolved = path.resolve(source.path);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid source file.');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error('The source file is empty or unavailable.');
  return { ...source, path: resolved, originalName: path.basename(source.originalName), size: stat.size };
}

const wsSubscriptions = new Map<string, Set<WebSocket>>();
const activeChildProcesses = new Map<string, any>();
const lastBroadcastTime = new Map<string, number>();

/** Throttled WebSocket broadcaster to eliminate event-loop saturation and UI lag */
function broadcastJobUpdate(jobId: string, force = false) {
  const job = jobQueue.get(jobId);
  if (!job) return;
  job.updatedAt = Date.now();
  persistDownloadQueue(force);

  const now = Date.now();
  const lastTime = lastBroadcastTime.get(jobId) || 0;
  // Throttle updates to at most once per 150ms per job, unless status change or terminal state
  if (!force && job.status !== 'completed' && job.status !== 'failed' && (now - lastTime < 150)) {
    return;
  }
  lastBroadcastTime.set(jobId, now);

  const subscribers = wsSubscriptions.get(jobId);
  if (subscribers) {
    const payload = JSON.stringify({
      type: "progress",
      job: publicDownloadRecord(job),
    });
    subscribers.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch (err) {
          log.warn("WS", `Broadcast send error for job ${jobId}`, err);
        }
      }
    });
  }
}

interface ExtWebSocket extends WebSocket {
  isAlive?: boolean;
}

async function startServer() {
  await recoverDownloadQueue();
  const app = express();
  const server = http.createServer(app);

  // Initialize WebSocket Server
  const wss = new WebSocketServer({ noServer: true });
  globalWss = wss;

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // WebSocket Heartbeat Sweep to reap ghost connections and avoid memory leaks
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((client: any) => {
      if (client.isAlive === false) {
        log.info("WS", "Reaping inactive zombie WebSocket connection");
        return client.terminate();
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {}
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  wss.on("connection", (ws: ExtWebSocket) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    const subscribedJobs = new Set<string>();

    ws.on("message", (messageStr) => {
      try {
        const data = JSON.parse(messageStr.toString());
        if ((data.type === "subscribe" || data.type === "subscribe-convert") && data.jobId) {
          const jobId = data.jobId;
          subscribedJobs.add(jobId);

          if (!wsSubscriptions.has(jobId)) {
            wsSubscriptions.set(jobId, new Set());
          }
          wsSubscriptions.get(jobId)!.add(ws);

          // Immediately send current download job status if known
          const job = jobQueue.get(jobId);
          if (job && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "progress", job: publicDownloadRecord(job) }));
            } catch {}
          }

          // Immediately send current conversion job status if known
          const convJob = conversionJobs.get(jobId);
          if (convJob && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({
                type: "convert-progress",
                job: {
                  ...convJob,
                  downloadUrl: `/api/convert/download/${convJob.jobId}`,
                }
              }));
            } catch {}
          }
        }
      } catch (err) {
        log.error("WS", "Failed to parse incoming WS message", err);
      }
    });

    ws.on("close", () => {
      subscribedJobs.forEach((jobId) => {
        const set = wsSubscriptions.get(jobId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            wsSubscriptions.delete(jobId);
          }
        }
      });
      subscribedJobs.clear();
    });
  });

  // ─── SECURITY HEADERS & CONTENT SECURITY POLICY ─────────────────────────
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "connect-src 'self' ws: wss: http: https: blob:",
        "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.bilibili.com https://player.vimeo.com",
        "frame-ancestors 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ")
    );
    next();
  });

  // Explicit route for Service Worker with no-cache headers to ensure timely updates
  app.get("/sw.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.sendFile(path.join(process.cwd(), "public", "sw.js"));
  });

  app.use(express.json());
  const archiveTickets = new Map<string, { ids: string[]; expires: number }>();
  let activeArchives = 0;

  const archiveFiles = (ids: string[]) => ids.map(id => {
    const job = jobQueue.get(id);
    if (!job || job.status !== 'completed' || !job.filePath || !fs.existsSync(job.filePath)) throw new Error('One or more files are unavailable. Refresh Transfers and retry.');
    const resolved = fs.realpathSync(job.filePath);
    if (!resolved.startsWith(`${fs.realpathSync(DOWNLOADS_DIR)}${path.sep}`)) throw new Error('Invalid download file.');
    return { path: resolved, name: path.basename((job.outputFileName || makeDownloadFileName(job, path.extname(resolved))).replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_'), size: fs.statSync(resolved).size };
  });

  app.post('/api/downloads/archive', (req, res) => {
    for (const [ticket, data] of archiveTickets) if (data.expires < Date.now()) archiveTickets.delete(ticket);
    const ids = req.body?.jobIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || !ids.every(id => typeof id === 'string' && isValidJobId(id))) return res.status(400).json({ error: 'Choose 1–500 completed downloads.' });
    if (archiveTickets.size >= 20) return res.status(429).json({ error: 'Too many ZIP requests. Wait a moment and retry.' });
    if (activeArchives >= 4) return res.status(429).json({ error: 'Other ZIP downloads are running. Retry in a moment.' });
    try {
      const unique = [...new Set<string>(ids)]; archiveFiles(unique);
      const ticket = crypto.randomUUID();
      archiveTickets.set(ticket, { ids: unique, expires: Date.now() + 5 * 60_000 });
      res.json({ downloadUrl: `/api/downloads/archive/${ticket}`, count: unique.length });
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });

  app.get('/api/downloads/archive/:ticket', (req, res) => {
    const ticket = archiveTickets.get(req.params.ticket);
    if (!ticket || ticket.expires < Date.now()) return res.status(404).json({ error: 'This ZIP request expired. Create it again from Transfers.' });
    if (activeArchives >= 4) return res.status(429).json({ error: 'Other ZIP downloads are running. Retry in a moment.' });
    let cleanup: (() => void) | undefined;
    try {
      const files = archiveFiles(ticket.ids);
      if (req.method === 'HEAD') return res.type('application/zip').setHeader('Cache-Control', 'no-store').end();
      archiveTickets.delete(req.params.ticket); activeArchives++;
      const zip = new ZipFile(); const readers = new Set<fs.ReadStream>(); let finished = false;
      const release = () => {
        if (finished) return; finished = true; activeArchives--;
        for (const file of files) { const count = (archiveInputs.get(file.path) || 1) - 1; if (count) archiveInputs.set(file.path, count); else archiveInputs.delete(file.path); }
        for (const reader of readers) reader.destroy();
        (zip.outputStream as any).destroy();
      };
      cleanup = release;
      for (const file of files) {
        archiveInputs.set(file.path, (archiveInputs.get(file.path) || 0) + 1);
        try { fs.utimesSync(file.path, new Date(), new Date()); } catch {}
      }
      res.once('finish', release); res.once('close', release);
      zip.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Could not read a ZIP input file.' }); else res.destroy(); release(); });
      zip.outputStream.on('error', () => { res.destroy(); release(); });
      const names = new Set<string>();
      for (const file of files) {
        const extension = path.extname(file.name); const base = path.basename(file.name, extension).replace(/^\.+$/, '') || 'download';
        let name = `${base}${extension}`; let index = 2;
        while (names.has(name.toLowerCase())) name = `${base} (${index++})${extension}`;
        names.add(name.toLowerCase());
        zip.addReadStreamLazy(name, { size: file.size, compress: false }, (callback) => {
          if (finished) { callback(new Error('ZIP download was closed.'), undefined as any); return; }
          const reader = fs.createReadStream(file.path); readers.add(reader); reader.once('close', () => readers.delete(reader)); callback(null, reader);
        });
      }
      res.attachment(`Pullio-downloads-${new Date().toISOString().slice(0, 10)}.zip`); res.type('application/zip'); res.setHeader('Cache-Control', 'no-store');
      zip.outputStream.pipe(res); zip.end();
    } catch (error) { cleanup?.(); if (res.headersSent) res.destroy(); else res.status(409).json({ error: (error as Error).message }); }
  });

  app.get('/api/jobs', (_req, res) => {
    for (const job of jobQueue.values()) {
      if (job.status === 'completed' && (!job.filePath || !fs.existsSync(job.filePath))) {
        job.status = 'failed'; job.stage = 'failed'; job.error = 'The saved file has expired or was removed. Retry to download it again.';
        job.filePath = undefined; job.fileName = undefined; broadcastJobUpdate(job.jobId, true);
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ jobs: [...jobQueue.values()].map(publicDownloadRecord), persistenceError: downloadJournal.error || downloadJournal.recoveryWarning, maxConcurrentDownloads });
  });

  app.delete('/api/jobs', async (req, res) => {
    const ids = req.body?.jobIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(id => typeof id === 'string' && isValidJobId(id))) return res.status(400).json({ error: 'Choose 1–500 finished transfers to clear.' });
    const unique = [...new Set<string>(ids)];
    if (unique.some(id => { const job = jobQueue.get(id); return job && !['completed', 'failed'].includes(job.status); })) return res.status(409).json({ error: 'A selected transfer is still active. Refresh Transfers and try again.' });
    for (const id of unique) { jobQueue.delete(id); cleanJobFiles(id); lastBroadcastTime.delete(id); wsSubscriptions.delete(id); }
    persistDownloadQueue(true); await downloadJournal.flush();
    res.json({ removedIds: unique });
  });

  app.post("/api/queue/config", async (req, res) => {
    const requestedLimit = req.body?.maxConcurrentDownloads;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 4) {
      return res.status(400).json({ error: "maxConcurrentDownloads must be an integer from 1 to 4." });
    }
    setMaxConcurrentDownloads(requestedLimit);
    await downloadJournal.flush();
    return res.json({ maxConcurrentDownloads, activeDownloads: activeDownloadsCount });
  });

  // Serve static assets from public/ folder for PWA (manifest, icons, offline.html)
  app.use(express.static(path.join(process.cwd(), "public")));

  // Silently absorb YouTube analytics pings — long opaque hash paths with no dot/extension
  // that YouTube's player JS sends to the parent-frame origin (localhost:3000)
  app.use((req, res, next) => {
    const p = req.path;
    if (
      p.length > 80 &&
      !p.includes(".") &&
      !p.startsWith("/api/") &&
      !p.startsWith("/src/") &&
      !p.startsWith("/@") &&
      !p.startsWith("/node_modules/")
    ) {
      return res.status(204).end();
    }
    next();
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      timestamp: Date.now(),
      uptime: process.uptime(),
      ffmpeg: Boolean(ffmpegPath),
      ytDlp: fs.existsSync(YT_DLP_PATH),
      version: "2.0.0"
    });
  });

  app.post("/api/analyze", async (req, res) => {
    try {
      let { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }

      // Automatically extract URL if raw mobile share text was submitted
      url = extractMediaUrlFromText(url);
      const isMockUrl = isDemoUrl(url);

      if (!isMockUrl) {
        const initialUrlCheck = isValidMediaUrl(url);
        if (!initialUrlCheck.valid) {
          return res.status(400).json({ error: initialUrlCheck.error });
        }
        url = await resolveShortMediaUrl(url);
        url = normalizeMediaUrl(url);
      }

      const urlCheck = isValidMediaUrl(url);
      if (!urlCheck.valid) {
        return res.status(400).json({ error: urlCheck.error });
      }

      // Comprehensive provider detection
      let provider = "unknown";
      if (url.includes("youtube.com") || url.includes("youtu.be")) {
        provider = "youtube";
      } else if (url.includes("tiktok.com") || url.includes("vt.tiktok.com") || url.includes("vm.tiktok.com")) {
        provider = "tiktok";
      } else if (url.includes("douyin.com") || url.includes("iesdouyin.com")) {
        provider = "douyin";
      } else if (url.includes("facebook.com") || url.includes("fb.watch")) {
        provider = "facebook";
      } else if (url.includes("instagram.com")) {
        provider = "instagram";
      } else if (url.includes("bilibili.com") || url.includes("b23.tv")) {
        provider = "bilibili";
      } else if (url.includes("twitter.com") || url.includes("x.com")) {
        provider = "twitter";
      } else if (url.includes("reddit.com")) {
        provider = "reddit";
      } else if (url.includes("vimeo.com")) {
        provider = "vimeo";
      } else if (url.includes("pinterest.com") || url.includes("pin.it")) {
        provider = "pinterest";
      } else if (url.includes("xiaohongshu.com") || url.includes("xhslink.com")) {
        provider = "xiaohongshu";
      } else if (url.includes("soundcloud.com")) {
        provider = "soundcloud";
      }

      const isPlaylist = isPlaylistUrl(url, provider);

      if (isPlaylist) {
        if (isMockUrl) {
          return serveMockPlaylist(res, provider, url);
        }

        try {
          const info = await getYtDlpPlaylistInfo(url);
          
          if (info._type === "video" || !info.entries || info.entries.length === 0) {
            console.warn(`[Analyze Playlist] Resolved to a single video instead of a playlist. Invoking watch fallback...`);
            throw new Error("Resolved to single video");
          }
          
          const entries = info.entries || [];
          const playlistItems = entries.map((entry: any, index: number) => {
            const entryId = entry.id || entry.url;
            let videoUrl = entry.url || "";
            if (!videoUrl || !videoUrl.startsWith("http")) {
              if (provider === "youtube" || !provider || provider === "unknown") {
                videoUrl = `https://www.youtube.com/watch?v=${entryId}`;
              } else if (provider === "bilibili") {
                videoUrl = `https://www.bilibili.com/video/${entryId}`;
              } else if (provider === "vimeo") {
                videoUrl = `https://vimeo.com/${entryId}`;
              } else if (provider === "pinterest") {
                videoUrl = `https://www.pinterest.com/pin/${entryId}/`;
              } else {
                videoUrl = `https://${provider}.com/watch?v=${entryId}`;
              }
            }
            
            let thumbnail = "";
            if (entry.thumbnails && Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
              thumbnail = entry.thumbnails[entry.thumbnails.length - 1].url || entry.thumbnails[0].url;
            } else if (entry.thumbnail) {
              thumbnail = entry.thumbnail;
            } else if (entryId && (provider === "youtube" || !provider)) {
              thumbnail = `https://img.youtube.com/vi/${entryId}/hqdefault.jpg`;
            }
            
            const fileSizeBytes = Number(entry.filesize || entry.filesize_approx);
            return {
              id: entryId || `track-${index}-${crypto.randomUUID().slice(0, 4)}`,
              title: entry.title || `Track ${index + 1}`,
              thumbnail: thumbnail || "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=80&w=200",
              duration: entry.duration || 0,
              ...(Number.isFinite(fileSizeBytes) && fileSizeBytes > 0 ? { filesize: fileSizeBytes } : {}),
              url: videoUrl
            };
          });

          let thumbnail = info.thumbnail || "";
          if (!thumbnail && playlistItems.length > 0) {
            thumbnail = playlistItems[0].thumbnail;
          }

          return res.json({
            provider,
            url,
            title: info.title || "Media Playlist",
            thumbnail,
            author: info.uploader || info.channel || "Unknown Curator",
            duration: playlistItems.reduce((acc: number, item: any) => acc + item.duration, 0),
            formats: [
              { itag: "1080p", quality: "1080p Full HD", type: "video" },
              { itag: "1080p-video-only", quality: "1080p Full HD (Video Only)", type: "video-only" },
              { itag: "720p", quality: "720p HD", type: "video" },
              { itag: "720p-video-only", quality: "720p HD (Video Only)", type: "video-only" },
              { itag: "480p", quality: "480p SD", type: "video" },
              { itag: "480p-video-only", quality: "480p SD (Video Only)", type: "video-only" },
              { itag: "360p", quality: "360p SD", type: "video" },
              { itag: "360p-video-only", quality: "360p SD (Video Only)", type: "video-only" },
              { itag: "audio-320", quality: "320kbps MP3", type: "audio" },
              { itag: "audio-128", quality: "128kbps MP3", type: "audio" }
            ],
            isPlaylist: true,
            playlistItems,
          });
        } catch (err: any) {
          console.warn(`[Analyze Playlist] Real playlist extraction failed for ${provider}: ${err.message} — checking watch fallback`);
          
          let singleVideoItem: any = null;
          const vMatch = url.match(/[?&]v=([^&#]+)/);
          const listMatch = url.match(/[?&]list=([^&#]+)/);
          const playlistId = listMatch ? listMatch[1] : "playlist";

          if (vMatch) {
            const videoId = vMatch[1];
            try {
              const singleUrl = `https://www.youtube.com/watch?v=${videoId}`;
              const info = await getYtDlpInfo(singleUrl);
              
              // Generate formats for this single video fallback
              const formats = buildMediaFormatList(info);
              
              let thumbnail = info.thumbnail || "";
              if (!thumbnail && info.thumbnails && info.thumbnails.length > 0) {
                thumbnail = info.thumbnails[info.thumbnails.length - 1].url;
              }
              if (!thumbnail && provider === "youtube") {
                thumbnail = `https://img.youtube.com/vi/${info.id}/maxresdefault.jpg`;
              }
              
              console.log(`[Analyze Playlist Fallback] Successfully parsed watch video as single video fallback!`);
              return res.json({
                provider,
                url: singleUrl,
                title: info.title || "Untitled Media",
                thumbnail,
                author: info.uploader || info.channel || "Unknown Creator",
                duration: info.duration || 0,
                formats,
                isPlaylist: false,
              });
            } catch (singleErr) {
              console.warn(`[Analyze Playlist Fallback] Could not fetch single video info:`, singleErr);
            }
          }

          throw new Error(`Failed to extract playlist: ${err.message}`);
        }
      }

      // Single Media Handler (Supports all media sites via yt-dlp)
      if (urlCheck.valid) {
        if (isMockUrl) {
          return serveMockSingleVideo(res, provider, url);
        }

        try {
          const info = await getYtDlpInfo(url);

          // Infer provider from extractor if not yet known
          if (provider === "unknown" && (info.extractor_key || info.extractor)) {
            const ext = (info.extractor_key || info.extractor || "").toLowerCase();
            if (ext.includes("youtube")) provider = "youtube";
            else if (ext.includes("tiktok")) provider = "tiktok";
            else if (ext.includes("douyin")) provider = "douyin";
            else if (ext.includes("facebook")) provider = "facebook";
            else if (ext.includes("instagram")) provider = "instagram";
            else if (ext.includes("bilibili")) provider = "bilibili";
            else if (ext.includes("twitter")) provider = "twitter";
            else if (ext.includes("reddit")) provider = "reddit";
            else if (ext.includes("vimeo")) provider = "vimeo";
            else if (ext.includes("pinterest")) provider = "pinterest";
            else if (ext.includes("xiaohongshu") || ext.includes("xhs")) provider = "xiaohongshu";
            else if (ext.includes("soundcloud")) provider = "soundcloud";
            else provider = "generic";
          }

          // Preserve each distinct stream and its actual resolution, frame rate, codec, and container.
          const formats = buildMediaFormatList(info);

          // Extract subtitles
          const subtitles: { lang: string; name: string; url?: string }[] = [];
          const allSubs = { ...(info.subtitles || {}), ...(info.automatic_captions || {}) };
          for (const [lang, subList] of Object.entries(allSubs)) {
            const first = (subList as any[])?.[0];
            if (first) {
              subtitles.push({
                lang,
                name: first.name || lang,
                url: first.url
              });
            }
          }

          let thumbnail = info.thumbnail || "";
          if (!thumbnail && info.thumbnails && info.thumbnails.length > 0) {
            thumbnail = info.thumbnails[info.thumbnails.length - 1].url;
          }
          if (!thumbnail && provider === "youtube") {
            thumbnail = `https://img.youtube.com/vi/${info.id}/maxresdefault.jpg`;
          }

          return res.json({
            provider,
            url,
            title: info.title || info.description || "Untitled Media",
            thumbnail,
            author: info.uploader || info.channel || info.creator || info.artist || "Unknown Creator",
            duration: info.duration || 0,
            formats,
            subtitles: subtitles.slice(0, 15),
            isPlaylist: false,
          });
        } catch (err: any) {
          const classified = classifyMediaError(err, provider);
          log.warn("ANALYZE", `Real media extraction failed for ${provider}: [${classified.category}] ${classified.message}`);
          return res.status(400).json({ 
            provider,
            error: classified.message,
            category: classified.category,
            retryable: classified.retryable,
            suggestedFallback: classified.suggestedFallback
          });
        }
      }

      throw new Error(`Unsupported or invalid URL`);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Unknown error" });
    }
  });

  // Asynchronous Download Queue Enqueuer Endpoint
  app.post("/api/queue", async (req, res) => {
    try {
      let { url, itag, title, thumbnail, provider, type, targetContainer, filenameQuality, filenameTemplate: requestedFilenameTemplate, maxConcurrentDownloads: requestedLimit } = req.body;
      if (!url || !itag) {
        return res.status(400).json({ error: "URL and itag are required" });
      }
      if ((typeof itag !== 'string' || !itag.length || itag.length > 256) && !(typeof itag === 'number' && Number.isFinite(itag))) return res.status(400).json({ error: 'Choose a valid media format.' });
      if ([title, thumbnail, provider].some(value => value !== undefined && typeof value !== 'string')) return res.status(400).json({ error: 'Invalid media details.' });
      title = title?.slice(0, 300); thumbnail = thumbnail?.slice(0, 2000); provider = provider?.slice(0, 30);
      if (type !== undefined && type !== 'video' && type !== 'audio') {
        return res.status(400).json({ error: "Type must be video or audio." });
      }
      const filenameTemplate = validateFilenameTemplate(requestedFilenameTemplate);
      if (!filenameTemplate) return res.status(400).json({ error: "Filename template must use supported tokens, be 1–120 characters, and contain no file path characters." });
      if (requestedLimit !== undefined) {
        requestedLimit = Number(requestedLimit);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 4) {
          return res.status(400).json({ error: "maxConcurrentDownloads must be an integer from 1 to 4." });
        }
        setMaxConcurrentDownloads(requestedLimit);
      }

      url = extractMediaUrlFromText(url);
      const isMock = isDemoUrl(url);
      if (!isMock) {
        const initialUrlCheck = isValidMediaUrl(url);
        if (!initialUrlCheck.valid) {
          return res.status(400).json({ error: initialUrlCheck.error });
        }
        url = await resolveShortMediaUrl(url);
        url = normalizeMediaUrl(url);
        const urlCheck = isValidMediaUrl(url);
        if (!urlCheck.valid) {
          return res.status(400).json({ error: urlCheck.error });
        }
      }

      const jobId = crypto.randomUUID();
      const isAudio = type === "video" ? false : type === "audio" || isAudioFormatToken(itag);
      const allowedContainers = isAudio ? new Set(['mp3', 'm4a']) : new Set(['mp4', 'mkv', 'webm']);
      if (targetContainer !== undefined && !allowedContainers.has(String(targetContainer).toLowerCase())) {
        return res.status(400).json({ error: "Unsupported output container for this media type." });
      }
      targetContainer = targetContainer ? String(targetContainer).toLowerCase() : (isAudio ? 'mp3' : 'mkv');
      const ext = targetContainer;
      const fileName = `${jobId}.${ext}`;
      const filePath = path.join(DOWNLOADS_DIR, fileName);

      const newJob: DownloadJob = {
        jobId,
        stage: 'queued', createdAt: Date.now(), updatedAt: Date.now(),
        url,
        itag,
        targetContainer,
        provider: provider || "unknown",
        progress: 0,
        speed: "0 MB/s",
        eta: "Starting...",
        status: "queued",
        fileSize: "0 MB",
        bytesDownloaded: "0 MB",
        title: title || "Media Download",
        thumbnail: thumbnail || "",
        type: isAudio ? "audio" : "video",
        filenameTemplate,
        filenameQuality: typeof filenameQuality === "string" ? filenameQuality.slice(0, 32) : undefined,
        filePath,
        fileName,
        mimeType: isAudio
          ? (targetContainer === 'm4a' ? "audio/mp4" : "audio/mpeg")
          : targetContainer === 'mkv' ? "video/x-matroska" : `video/${targetContainer}`,
      };

      const duplicate = duplicateDownload(newJob, req.body.allowDuplicate);
      if (duplicate) return res.json({ jobId: duplicate.jobId, duplicate: true, job: publicDownloadRecord(duplicate), status: duplicate.status, queuePosition: duplicate.queuePosition });
      if (jobQueue.size >= 500) return res.status(429).json({ error: 'The queue is full. Clear finished downloads before adding more.' });
      jobQueue.set(jobId, newJob);

      // Trigger background download worker via concurrency limiter
      enqueueDownloadJob(jobId);

      persistDownloadQueue(true); await downloadJournal.flush();
      return res.json({ jobId, status: newJob.status, queuePosition: newJob.queuePosition, job: publicDownloadRecord(newJob) });
    } catch (err: any) {
      console.error("Queueing error:", err);
      res.status(500).json({ error: err.message || "Queue insertion failed" });
    }
  });

  // 1-Click Direct Download Endpoint: Analyzes & enqueues best quality automatically
  app.post("/api/queue/direct", async (req, res) => {
    try {
      let { url, quality = '1080p', type = 'video', filenameTemplate: requestedFilenameTemplate, maxConcurrentDownloads: requestedLimit } = req.body;
      if (!['video', 'audio'].includes(type) || typeof quality !== 'string' || quality.length > 256) return res.status(400).json({ error: 'Choose a valid media type and quality.' });
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }
      const filenameTemplate = validateFilenameTemplate(requestedFilenameTemplate);
      if (!filenameTemplate) return res.status(400).json({ error: "Filename template must use supported tokens, be 1–120 characters, and contain no file path characters." });
      if (requestedLimit !== undefined) {
        requestedLimit = Number(requestedLimit);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 4) {
          return res.status(400).json({ error: "maxConcurrentDownloads must be an integer from 1 to 4." });
        }
        setMaxConcurrentDownloads(requestedLimit);
      }

      url = extractMediaUrlFromText(url);
      const isMock = isDemoUrl(url);
      if (!isMock) {
        const initialUrlCheck = isValidMediaUrl(url);
        if (!initialUrlCheck.valid) {
          return res.status(400).json({ error: initialUrlCheck.error });
        }
        url = await resolveShortMediaUrl(url);
        url = normalizeMediaUrl(url);
      }

      const urlCheck = isValidMediaUrl(url);
      if (!urlCheck.valid) {
        return res.status(400).json({ error: urlCheck.error });
      }

      // Infer provider
      let provider = "unknown";
      if (url.includes("youtube.com") || url.includes("youtu.be")) provider = "youtube";
      else if (url.includes("tiktok.com") || url.includes("vt.tiktok.com") || url.includes("vm.tiktok.com")) provider = "tiktok";
      else if (url.includes("douyin.com") || url.includes("iesdouyin.com")) provider = "douyin";
      else if (url.includes("facebook.com") || url.includes("fb.watch")) provider = "facebook";
      else if (url.includes("instagram.com")) provider = "instagram";
      else if (url.includes("bilibili.com") || url.includes("b23.tv")) provider = "bilibili";
      else if (url.includes("twitter.com") || url.includes("x.com")) provider = "twitter";
      else if (url.includes("reddit.com")) provider = "reddit";
      else if (url.includes("vimeo.com")) provider = "vimeo";
      else if (url.includes("pinterest.com") || url.includes("pin.it")) provider = "pinterest";
      else if (url.includes("xiaohongshu.com") || url.includes("xhslink.com")) provider = "xiaohongshu";
      else if (url.includes("soundcloud.com")) provider = "soundcloud";

      let title = "Direct Media Download";
      let thumbnail = "";
      let duration = 0;
      let matchedItag = type === 'audio'
        ? (['audio-128', 'audio-192', 'audio-256', 'audio-320'].includes(String(quality)) ? String(quality) : 'audio-320')
        : quality;

      if (!isMock) {
        try {
          const info = await getYtDlpInfo(url);
          title = info.title || info.description || "Direct Media Download";
          duration = info.duration || 0;
          if (info.thumbnail) thumbnail = info.thumbnail;
          else if (info.thumbnails && info.thumbnails.length > 0) thumbnail = info.thumbnails[info.thumbnails.length - 1].url;

          // Select smart best format
          if (type === 'audio') {
            matchedItag = ['audio-128', 'audio-192', 'audio-256', 'audio-320'].includes(String(quality))
              ? String(quality)
              : 'audio-320';
          } else {
            // Use yt-dlp's top available stream for "best"; otherwise honor the requested height.
            const availableFormats = buildMediaFormatList(info).filter((f: any) => f.type === 'video');
            const targetHeight = parseInt(quality, 10);
            const chosen = Number.isFinite(targetHeight)
              ? availableFormats.find((f: any) => (f.resRank || 0) <= targetHeight) || availableFormats[availableFormats.length - 1]
              : availableFormats[0];
            matchedItag = chosen ? chosen.itag : 'best';
          }
        } catch (err: any) {
          log.warn("DIRECT_QUEUE", `Direct metadata analysis failed for ${url}: ${err.message}. Falling back to universal adaptive stream.`);
          matchedItag = type === 'audio' ? 'bestaudio' : 'best';
        }
      }

      const jobId = crypto.randomUUID();
      const isAudio = type === 'audio' || (type !== 'video' && isAudioFormatToken(matchedItag));
      const ext = isAudio ? "mp3" : "mp4";
      const fileName = `${jobId}.${ext}`;
      const filePath = path.join(DOWNLOADS_DIR, fileName);

      const newJob: DownloadJob = {
        jobId,
        stage: 'queued', createdAt: Date.now(), updatedAt: Date.now(), targetContainer: ext,
        url,
        itag: matchedItag,
        provider,
        progress: 0,
        speed: "0 MB/s",
        eta: "Starting...",
        status: "queued",
        fileSize: "0 MB",
        bytesDownloaded: "0 MB",
        title,
        thumbnail,
        type: isAudio ? "audio" : "video",
        filenameTemplate,
        filenameQuality: String(quality).slice(0, 32),
        filePath,
        fileName,
        mimeType: isAudio ? "audio/mpeg" : "video/mp4",
      };

      const duplicate = duplicateDownload(newJob, req.body.allowDuplicate);
      if (duplicate) return res.json({ jobId: duplicate.jobId, duplicate: true, job: publicDownloadRecord(duplicate), status: duplicate.status, queuePosition: duplicate.queuePosition, title: duplicate.title });
      if (jobQueue.size >= 500) return res.status(429).json({ error: 'The queue is full. Clear finished downloads before adding more.' });
      jobQueue.set(jobId, newJob);
      enqueueDownloadJob(jobId);
      persistDownloadQueue(true); await downloadJournal.flush();

      return res.json({
        success: true,
        jobId,
        title,
        thumbnail,
        provider,
        duration,
        format: { itag: matchedItag, quality: `${matchedItag} ${ext.toUpperCase()}`, type: isAudio ? 'audio' : 'video' },
        status: newJob.status,
        queuePosition: newJob.queuePosition,
        job: publicDownloadRecord(newJob)
      });
    } catch (err: any) {
      log.error("DIRECT_QUEUE", "Direct queue error", err);
      res.status(500).json({ error: err.message || "Direct queue insertion failed" });
    }
  });

  // Direct In-Browser Media Stream Pipe (Zero Server-Disk Retention Stream)
  app.get("/api/stream", async (req, res) => {
    try {
      let targetUrl = req.query.url as string;
      const itag = (req.query.itag as string) || "best";
      const type = (req.query.type as 'video' | 'audio') || "video";

      if (!targetUrl) {
        return res.status(400).send("Target URL is required");
      }

      targetUrl = extractMediaUrlFromText(targetUrl);
      targetUrl = await resolveShortMediaUrl(targetUrl);
      targetUrl = normalizeMediaUrl(targetUrl);

      const urlCheck = isValidMediaUrl(targetUrl);
      if (!urlCheck.valid) {
        return res.status(400).send(urlCheck.error);
      }

      const isAudio = type === 'audio' || isAudioFormatToken(itag);
      const ext = isAudio ? 'mp3' : 'mp4';
      const formatArg = getYtDlpFormatArg(itag, isAudio ? 'audio' : 'video');

      res.header("Content-Disposition", `attachment; filename="stream_${Date.now()}.${ext}"`);
      res.header("Content-Type", isAudio ? "audio/mpeg" : "video/mp4");
      res.header("X-Content-Type-Options", "nosniff");

      const runtimeArgs = getYtDlpRuntimeArgs();
      const args = [
        "--no-playlist",
        "--no-warnings",
        ...runtimeArgs,
        "-f", formatArg,
        "-o", "-",
        targetUrl
      ];

      const child = spawn(YT_DLP_PATH, args);

      child.stdout.pipe(res);

      req.on("close", () => {
        try { child.kill(); } catch {}
      });

      child.on("error", (err) => {
        log.error("STREAM", "Stream child error", err);
        if (!res.headersSent) res.status(500).send("Streaming process error");
      });
    } catch (err: any) {
      log.error("STREAM", "Stream error", err);
      if (!res.headersSent) res.status(500).send("Streaming initialization failed");
    }
  });

  // Serve completed downloaded files
  app.get(["/api/files/:jobId", "/api/download/:jobId"], (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) {
      return res.status(400).send("Invalid job ID format.");
    }

    const job = jobQueue.get(jobId);
    if (!job || job.status !== "completed" || !job.filePath || !fs.existsSync(job.filePath)) {
      return res.status(404).send("File not found or still downloading.");
    }

    const actualExt = job.filePath ? path.extname(job.filePath).replace('.', '').toLowerCase() : (job.type === "audio" ? "mp3" : "mp4");
    res.attachment(job.outputFileName || makeDownloadFileName(job, actualExt));
    res.header("Content-Type", job.mimeType || "application/octet-stream");
    res.header("X-Content-Type-Options", "nosniff");
    res.setHeader('Cache-Control', 'no-store');
    try { const now = new Date(); fs.utimesSync(job.filePath, now, now); } catch {}
    res.sendFile(job.filePath);
  });

  // Serve high-resolution thumbnail proxy download with SSRF and size safeguards
  app.get("/api/thumbnail", (req, res) => {
    const targetUrl = req.query.url as string;
    const title = (req.query.title as string) || "thumbnail";
    if (!targetUrl || !targetUrl.startsWith("http")) {
      return res.status(400).send("Valid thumbnail URL required");
    }

    const check = isValidMediaUrl(targetUrl);
    if (!check.valid) {
      return res.status(400).send(check.error);
    }

    // Sanitize title to prevent HTTP header CRLF injection
    const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

    try {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const proxyReq = client.get(targetUrl, (imgRes) => {
        if (imgRes.statusCode !== 200) {
          return res.status(imgRes.statusCode || 400).send("Failed to retrieve remote thumbnail");
        }

        const contentType = imgRes.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
          return res.status(400).send("Remote resource is not an image");
        }

        const contentLength = parseInt(imgRes.headers['content-length'] || '0', 10);
        if (contentLength > 10 * 1024 * 1024) {
          return res.status(400).send("Thumbnail image exceeds maximum size limit (10MB)");
        }

        res.header("Content-Disposition", `attachment; filename="${safeTitle || 'thumbnail'}_thumb.jpg"`);
        res.header("Content-Type", contentType);
        res.header("X-Content-Type-Options", "nosniff");

        imgRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        log.error("THUMB", "Thumbnail proxy fetch error", err);
        if (!res.headersSent) res.status(500).send("Failed to retrieve thumbnail");
      });

      proxyReq.setTimeout(10000, () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).send("Thumbnail fetch timed out");
      });
    } catch {
      res.status(400).send("Invalid thumbnail request");
    }
  });

  // Get job status via HTTP polling fallback
  app.get("/api/jobs/:jobId", (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) {
      return res.status(400).json({ error: "Invalid job ID format" });
    }
    const job = jobQueue.get(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    return res.json(publicDownloadRecord(job));
  });

  app.post("/api/jobs/:jobId/pause", async (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) return res.status(400).json({ error: "Invalid job ID format" });
    const job = jobQueue.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== 'queued' && job.status !== 'downloading') {
      return res.status(409).json({ error: 'Only active or queued downloads can be paused.' });
    }

    removePendingDownloadJob(jobId);
    job.status = "paused";
    job.stage = 'paused';
    job.queuePosition = undefined;
    job.speed = "Paused";
    job.eta = "Waiting to resume";
    broadcastJobUpdate(jobId, true);
    await stopDownloadProcess(jobId);
    await activeDownloadWorkers.get(jobId);
    persistDownloadQueue(true); await downloadJournal.flush();
    return res.json({ jobId, status: job.status, job: publicDownloadRecord(job), queue: getPendingDownloadQueueSnapshot() });
  });

  app.post("/api/jobs/:jobId/resume", async (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) return res.status(400).json({ error: "Invalid job ID format" });
    const job = jobQueue.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "paused") return res.status(409).json({ error: "This job is not paused." });
    if (activeChildProcesses.has(jobId) || activeDownloadSlots.has(jobId)) return res.status(409).json({ error: 'This download is still pausing. Retry in a moment.' });

    job.status = "queued";
    job.stage = 'queued'; job.error = undefined;
    job.speed = "0 MB/s";
    job.eta = "Waiting in queue";
    enqueueDownloadJob(jobId);
    broadcastJobUpdate(jobId, true);
    persistDownloadQueue(true); await downloadJournal.flush();
    return res.json({ jobId, status: job.status, job: publicDownloadRecord(job), queuePosition: job.queuePosition, queue: getPendingDownloadQueueSnapshot() });
  });

  app.post("/api/jobs/:jobId/reorder", async (req, res) => {
    const { jobId } = req.params;
    const direction = req.body?.direction;
    if (!isValidJobId(jobId)) return res.status(400).json({ error: "Invalid job ID format" });
    if (direction !== "up" && direction !== "down") {
      return res.status(400).json({ error: "Direction must be up or down." });
    }
    const job = jobQueue.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "queued" || !pendingDownloadJobIds.has(jobId)) {
      return res.status(409).json({ error: "Only jobs waiting in the queue can be reordered." });
    }

    const currentIndex = pendingDownloadQueue.indexOf(jobId);
    const targetIndex = currentIndex + (direction === "up" ? -1 : 1);
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= pendingDownloadQueue.length) {
      return res.status(409).json({ error: "This job is already at the end of the waiting queue." });
    }

    [pendingDownloadQueue[currentIndex], pendingDownloadQueue[targetIndex]] = [pendingDownloadQueue[targetIndex], pendingDownloadQueue[currentIndex]];
    refreshPendingDownloadQueuePositions();
    await downloadJournal.flush();
    return res.json({ jobId, queuePosition: job.queuePosition, queue: getPendingDownloadQueueSnapshot() });
  });

  // Re-enqueue/retry a failed job with adaptive recovery
  app.post("/api/jobs/:jobId/retry", async (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) {
      return res.status(400).json({ error: "Invalid job ID format" });
    }

    const job = jobQueue.get(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (job.status !== 'failed') {
      return res.status(409).json({ error: 'Only failed downloads can be retried. Resume paused downloads or create another copy of completed files.' });
    }

    job.status = "queued";
    job.stage = 'queued';
    job.speed = "0 MB/s";
    job.eta = "Re-queueing...";
    job.error = undefined;
    job.retryCount = (job.retryCount || 0) + 1;

    enqueueDownloadJob(jobId);
    broadcastJobUpdate(jobId, true);
    log.info("QUEUE", `Manual retry triggered for job ${jobId} (Attempt ${job.retryCount + 1})`);
    persistDownloadQueue(true); await downloadJournal.flush();

    return res.json({ jobId, status: job.status, job: publicDownloadRecord(job), queuePosition: job.queuePosition, message: "Job re-queued successfully" });
  });

  // Cancel running job or clear from server memory
  app.delete("/api/jobs/:jobId", async (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) {
      return res.status(400).json({ error: "Invalid job ID format" });
    }

    removePendingDownloadJob(jobId);
    jobQueue.delete(jobId);
    await stopDownloadProcess(jobId);
    await activeDownloadWorkers.get(jobId);
    cleanJobFiles(jobId);
    lastBroadcastTime.delete(jobId);
    wsSubscriptions.delete(jobId);
    persistDownloadQueue(true); await downloadJournal.flush();

    return res.json({ success: true, message: "Job cancelled and purged from server" });
  });

  // Batch URLs analyzer endpoint
  app.post("/api/analyze-batch", async (req, res) => {
    try {
      const { urls } = req.body;
      if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: "urls array is required" });
      }
      const results = [];
      for (const rawItem of urls.slice(0, 8)) {
        let itemUrl = extractMediaUrlFromText(rawItem);
        itemUrl = await resolveShortMediaUrl(itemUrl);

        const check = isValidMediaUrl(itemUrl);
        if (!check.valid) {
          results.push({ url: itemUrl, error: check.error, valid: false });
          continue;
        }
        try {
          const info = await getYtDlpInfo(itemUrl);
          results.push({
            url: itemUrl,
            valid: true,
            title: info.title || "Untitled Media",
            thumbnail: info.thumbnail || "",
            author: info.uploader || info.channel || "Creator",
            duration: info.duration || 0
          });
        } catch (err: any) {
          results.push({ url: itemUrl, error: err.message, valid: false });
        }
      }
      return res.json({ items: results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── COOKIE & AUTHENTICATION ENDPOINTS (Bilibili, YouTube, etc.) ────
  app.get("/api/cookies", (_req, res) => {
    return res.json(getCookiesSummary());
  });

  app.post("/api/cookies", (req, res) => {
    try {
      const { cookies, domain } = req.body;
      if (!cookies || typeof cookies !== "string" || !cookies.trim()) {
        return res.status(400).json({ error: "Cookie string or Netscape content is required" });
      }

      const formatted = parseRawCookieStringToNetscape(cookies.trim(), domain || ".bilibili.com");
      fs.writeFileSync(COOKIES_FILE, formatted, "utf-8");
      log.info("AUTH", "Saved cookies.txt for platform authentication");

      return res.json({
        success: true,
        message: "Cookies configured successfully",
        ...getCookiesSummary(),
      });
    } catch (err: any) {
      log.error("AUTH", "Failed to save cookies", err);
      return res.status(500).json({ error: err.message || "Failed to save cookies" });
    }
  });

  app.delete("/api/cookies", (_req, res) => {
    try {
      if (fs.existsSync(COOKIES_FILE)) {
        fs.unlinkSync(COOKIES_FILE);
      }
      log.info("AUTH", "Cleared cookies.txt");
      return res.json({ success: true, message: "Cookies cleared", configured: false });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to clear cookies" });
    }
  });

  // ─── CONVERTER API ENDPOINTS ─────────────────────────────────────────

  // File upload for single or batch media files
  app.post("/api/convert/upload", (req, res) => {
    mediaUpload.array("files", 20)(req, res, (err: any) => {
      if (err) {
        const partialFiles = Array.isArray((req as any).files) ? (req as any).files as Express.Multer.File[] : [];
        partialFiles.forEach((file) => {
          try { fs.unlinkSync(file.path); } catch {}
        });
        log.warn("UPLOAD", `Upload rejected: ${err.message}`);
        return res.status(400).json({ error: err.message || "Invalid upload request" });
      }

      try {
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
          return res.status(400).json({ error: "No files uploaded" });
        }

        const results = files.map((file) => {
          const uploadId = path.basename(file.filename).split("_")[0];
          const ext = path.extname(file.originalname).slice(1).toLowerCase();
          const isAudio = file.mimetype.startsWith("audio/") || ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(ext);
          const isVideo = file.mimetype.startsWith("video/") || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'gif'].includes(ext);

          uploadedFiles.set(uploadId, {
            path: file.path,
            originalName: file.originalname,
            size: file.size,
          });

          return {
            uploadId,
            originalName: file.originalname,
            size: file.size,
            sizeFormatted: formatBytes(file.size),
            ext,
            mediaType: isAudio ? "audio" : isVideo ? "video" : "unknown",
            mimeType: file.mimetype,
          };
        });

        return res.json({ success: true, files: results });
      } catch (err: any) {
        log.error("CONVERT", "Upload error", err);
        res.status(500).json({ error: err.message || "Failed to upload files" });
      }
    });
  });

  // Studio jobs use trusted server file references and the existing bounded conversion queue.
  app.post(['/api/audio/prepare', '/api/audio/cleanup-preview', '/api/audio/enhance'], (req, res) => {
    try {
      const isPreview = req.path !== '/api/audio/enhance';
      const isCleanupPreview = req.path === '/api/audio/cleanup-preview';
      const { source, jobId: requestedJobId, settings, format, quality, edit } = req.body || {};
      const jobId = requestedJobId || crypto.randomUUID();
      if (!isValidJobId(jobId)) return res.status(400).json({ error: 'Invalid audio job ID.' });
      if (conversionJobs.has(jobId)) return res.status(409).json({ error: 'This audio job already exists.' });
      const waitingStudioJobs = Array.from(conversionJobs.values()).filter((job) => job.studioPurpose && ['queued', 'converting'].includes(job.status));
      if (waitingStudioJobs.length >= 20) return res.status(429).json({ error: 'The audio queue is full. Wait for a job to finish and retry.' });
      const options = isPreview ? { format: 'wav' as const, quality: '16bit' } : validateAudioExport(format, quality);
      const enhancementSettings = isPreview && !isCleanupPreview ? undefined : validateAudioEnhancement(settings);
      const audioEdit = isPreview ? undefined : validateAudioEdit(edit);
      const fileInfo = resolveAudioStudioSource(source);
      const job: ConversionJob = {
        jobId, uploadId: '', inputPath: fileInfo.path,
        originalName: fileInfo.originalName, originalSize: fileInfo.size,
        targetFormat: options.format, exportQuality: options.quality,
        studioPurpose: isCleanupPreview ? 'cleanup-preview' : isPreview ? 'preview' : 'enhancement', enhancementSettings, audioEdit,
        status: 'queued', progress: 0, createdAt: Date.now(), eta: 'Waiting in queue',
      };
      conversionJobs.set(jobId, job);
      enqueueConversionJob(jobId);
      res.status(202).json({ jobId, status: job.status });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not start audio processing.' });
    }
  });

  app.get('/api/audio/waveform/:jobId', async (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) return res.status(400).json({ error: 'Invalid audio job ID.' });
    const job = conversionJobs.get(jobId);
    if (!job || job.studioPurpose !== 'preview' || job.status !== 'completed' || !job.outputPath) return res.status(404).json({ error: 'Prepare the source again to load its waveform.' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      let waveform = studioWaveforms.get(job);
      if (!waveform) {
        waveform = readAudioWaveform(job.outputPath);
        studioWaveforms.set(job, waveform);
      }
      const data = await waveform;
      if (conversionJobs.get(jobId) !== job) return res.status(404).json({ error: 'This preview has expired.' });
      res.json(data);
    } catch {
      studioWaveforms.delete(job);
      res.status(422).json({ error: 'Waveform unavailable. You can still trim using the time controls.' });
    }
  });

  app.get('/api/audio/preview/:jobId', (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) return res.status(400).json({ error: 'Invalid audio job ID.' });
    const job = conversionJobs.get(jobId);
    if (!job || !['preview', 'cleanup-preview'].includes(job.studioPurpose || '') || job.status !== 'completed' || !job.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: 'Audio preview is unavailable. Prepare the source again.' });
    }
    res.type('audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    const touchedAt = new Date();
    try {
      fs.utimesSync(job.outputPath, touchedAt, touchedAt);
      if (fs.existsSync(job.inputPath)) fs.utimesSync(job.inputPath, touchedAt, touchedAt);
    } catch {}
    // sendFile supports byte ranges so large audio can be scrubbed without loading it all into memory.
    res.sendFile(job.outputPath);
  });

  // Start conversion for batch or single items
  app.post("/api/convert/process", (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Items array is required" });
      }
      if (items.length > 20) {
        return res.status(400).json({ error: "A conversion request can contain at most 20 files." });
      }

      const allowedFormats = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'gif', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus']);
      const allowedBitrates = new Set(['320k', '256k', '192k', '128k']);
      const allowedResolutions = new Set(['original', '4320p', '2160p', '1440p', '1080p', '720p', '480p', '360p']);
      const allowedPresets = new Set([...allowedBitrates, ...allowedResolutions, 'lossless']);
      const resolvedItems: Array<{
        item: any;
        fileInfo: { path: string; originalName: string; size: number };
        jobId: string;
        targetFormat: string;
      }> = [];
      const requestedJobIds = new Set<string>();

      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return res.status(400).json({ error: "Each conversion item must be an object." });
        }
        const uploadId = item.uploadId;
        if (!isValidUploadId(uploadId)) {
          return res.status(400).json({ error: "A valid upload ID is required for every conversion item." });
        }

        const targetFormat = typeof item.targetFormat === 'string' ? item.targetFormat.toLowerCase() : '';
        if (!allowedFormats.has(targetFormat)) {
          return res.status(400).json({ error: `Unsupported output format: ${targetFormat || 'empty'}.` });
        }
        if (item.audioBitrate !== undefined && !allowedBitrates.has(item.audioBitrate)) {
          return res.status(400).json({ error: "Unsupported audio bitrate." });
        }
        if (item.qualityPreset !== undefined && !allowedPresets.has(item.qualityPreset)) {
          return res.status(400).json({ error: "Unsupported conversion quality preset." });
        }
        if (item.videoResolution !== undefined && !allowedResolutions.has(item.videoResolution)) {
          return res.status(400).json({ error: "Unsupported video resolution." });
        }

        let fileInfo = uploadedFiles.get(uploadId);

        // Fallback: search uploads folder if not found in memory
        if (!fileInfo) {
          try {
            const uFiles = fs.readdirSync(UPLOADS_DIR);
            const found = uFiles.find((f) => f.startsWith(`${uploadId}_`));
            if (found) {
              const p = path.resolve(UPLOADS_DIR, found);
              if (!p.startsWith(`${path.resolve(UPLOADS_DIR)}${path.sep}`)) {
                return res.status(400).json({ error: "Invalid uploaded file path." });
              }
              const stats = fs.statSync(p);
              fileInfo = {
                path: p,
                originalName: found.replace(`${uploadId}_`, ""),
                size: stats.size,
              };
              uploadedFiles.set(uploadId, fileInfo);
            }
          } catch {}
        }

        if (!fileInfo) {
          return res.status(404).json({ error: "One or more uploaded files could not be found. Upload the files again and retry." });
        }
        const uploadsRoot = `${path.resolve(UPLOADS_DIR)}${path.sep}`;
        const inputPath = path.resolve(fileInfo.path);
        if (!inputPath.startsWith(uploadsRoot) || !fs.existsSync(inputPath)) {
          return res.status(400).json({ error: "Invalid uploaded file path." });
        }
        fileInfo.path = inputPath;

        const jobId = item.jobId || crypto.randomUUID();
        if (!isValidJobId(jobId)) {
          return res.status(400).json({ error: "Invalid conversion job ID." });
        }
        const existingJob = conversionJobs.get(jobId);
        if (requestedJobIds.has(jobId) || (existingJob && existingJob.status !== 'failed')) {
          return res.status(409).json({ error: "A conversion job with this ID already exists." });
        }
        requestedJobIds.add(jobId);
        resolvedItems.push({ item, fileInfo, jobId, targetFormat });
      }

      const createdJobs: any[] = [];
      for (const { item, fileInfo, jobId, targetFormat } of resolvedItems) {
        const previousJob = conversionJobs.get(jobId);
        if (previousJob?.outputPath && fs.existsSync(previousJob.outputPath)) {
          try { fs.unlinkSync(previousJob.outputPath); } catch {}
        }

        const convJob: ConversionJob = {
          jobId,
          uploadId: item.uploadId,
          inputPath: fileInfo.path,
          originalName: fileInfo.originalName,
          originalSize: fileInfo.size,
          targetFormat,
          qualityPreset: item.qualityPreset || item.audioBitrate || "320k",
          videoResolution: item.videoResolution || "original",
          audioBitrate: allowedBitrates.has(item.audioBitrate)
            ? item.audioBitrate
            : allowedBitrates.has(item.qualityPreset) ? item.qualityPreset : "320k",
          status: "queued",
          progress: 0,
          speed: "0x",
          eta: "Queueing...",
          createdAt: Date.now(),
        };

        conversionJobs.set(jobId, convJob);
        enqueueConversionJob(jobId);

        createdJobs.push({
          jobId,
          uploadId: item.uploadId,
          originalName: convJob.originalName,
          targetFormat: convJob.targetFormat,
          status: "queued",
          fileIndex: createdJobs.length,
        });
      }

      if (createdJobs.length === 0) {
        return res.status(404).json({ error: "Could not find uploaded files on server to process" });
      }

      return res.json({ success: true, jobs: createdJobs });
    } catch (err: any) {
      log.error("CONVERT", "Process error", err);
      res.status(500).json({ error: err.message || "Failed to process conversions" });
    }
  });

  // Query conversion job status
  app.get("/api/convert/status/:jobId", (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) {
      return res.status(400).json({ error: "Invalid job ID format" });
    }

    const job = conversionJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: "Conversion job not found" });
    }
    return res.json({
      success: true,
      job: {
        ...job,
        downloadUrl: `/api/convert/download/${job.jobId}`,
      },
    });
  });

  // Download converted file
  app.get("/api/convert/download/:jobId", (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) {
      return res.status(400).send("Invalid job ID format");
    }

    const job = conversionJobs.get(jobId);
    if (!job || job.status !== "completed" || !job.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).send("Converted file not found or still processing");
    }

    const ext = job.targetFormat.toLowerCase();
    const mimeTypes: Record<string, string> = {
      mp4: "video/mp4",
      mkv: "video/x-matroska",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      flv: "video/x-flv",
      wmv: "video/x-ms-wmv",
      gif: "image/gif",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      flac: "audio/flac",
      aac: "audio/aac",
      m4a: "audio/mp4",
      ogg: "audio/ogg",
      opus: "audio/opus",
    };

    res.attachment(job.outputFileName || `${jobId}.${ext}`);
    res.header("Content-Type", mimeTypes[ext] || "application/octet-stream");
    res.header("X-Content-Type-Options", "nosniff");

    const stream = fs.createReadStream(job.outputPath);
    stream.pipe(res);
  });

  // Cancel conversion job or delete files
  app.delete("/api/convert/:jobId", (req, res) => {
    const { jobId } = req.params;
    if (!isValidJobId(jobId)) {
      return res.status(400).json({ error: "Invalid job ID format" });
    }

    const job = conversionJobs.get(jobId);
    const requestedUploadId = typeof req.query.uploadId === 'string' ? req.query.uploadId : '';
    const uploadId = isValidUploadId(requestedUploadId) ? requestedUploadId : job?.uploadId;
    const outputPath = job?.outputPath;
    if (job) job.status = "cancelled";

    pendingConversionJobIds.delete(jobId);
    for (let index = pendingConversionQueue.length - 1; index >= 0; index--) {
      if (pendingConversionQueue[index] === jobId) pendingConversionQueue.splice(index, 1);
    }

    const child = activeConversionProcesses.get(jobId);
    conversionJobs.delete(jobId);
    const cleanupFiles = () => {
      if (outputPath && fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch {}
      }
      if (!uploadId || Array.from(conversionJobs.values()).some((activeJob) => activeJob.uploadId === uploadId)) return;
      const uploaded = uploadedFiles.get(uploadId);
      if (!uploaded) return;
      uploadedFiles.delete(uploadId);
      const uploadsRoot = `${path.resolve(UPLOADS_DIR)}${path.sep}`;
      const inputPath = path.resolve(uploaded.path);
      if (inputPath.startsWith(uploadsRoot) && fs.existsSync(inputPath)) {
        try { fs.unlinkSync(inputPath); } catch {}
      }
    };

    if (child) {
      child.once('close', cleanupFiles);
      try { child.kill("SIGKILL"); } catch { cleanupFiles(); }
    } else {
      cleanupFiles();
    }

    return res.json({ success: true, message: "Conversion job cancelled and removed" });
  });

  // Global API error handler (prevents stack trace leaks)
  app.use("/api", (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error("API", "Request error", err);
    res.status(err.status || 400).json({
      error: err.message || "Request processing failed",
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            '**/cookies.txt',
            '**/cookies*.txt',
            '**/*.txt',
            '**/downloads/**',
            '**/downloads/*',
            '**/uploads/**',
            '**/converted/**',
            '**/pullio-data/**',
            '**/scratch/**',
            '**/*.log'
          ]
        }
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    tryProcessNextJob();
  });
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    persistDownloadQueue(true); await downloadJournal.flush();
    await Promise.all([...activeChildProcesses.keys()].map(stopDownloadProcess));
    await Promise.all(activeDownloadWorkers.values());
    await downloadJournal.flush();
    server.close(); wss.close(); process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

// Shared job failure helper — safe to call from inside callbacks
function failJob(jobId: string, reason: string) {
  const job = jobQueue.get(jobId);
  if (!job || job.status === "completed" || job.status === "failed" || job.status === 'paused') return;
  job.status = "failed";
  job.stage = 'failed';
  job.queuePosition = undefined;
  job.error = reason;
  activeChildProcesses.delete(jobId);
  broadcastJobUpdate(jobId, true);
  log.warn("QUEUE", `Job ${jobId} failed: ${reason}`);
}

// Concurrency queue to prevent YouTube bot detection from concurrent requests
let maxConcurrentDownloads = 2;
let activeDownloadsCount = 0;
const pendingDownloadQueue: string[] = [];
const pendingDownloadJobIds = new Set<string>();
const activeDownloadSlots = new Set<string>();
const activeDownloadWorkers = new Map<string, Promise<void>>();

function setMaxConcurrentDownloads(limit: number) {
  maxConcurrentDownloads = limit;
  persistDownloadQueue(true);
  log.info("QUEUE", `Maximum concurrent downloads set to ${limit}`);
  tryProcessNextJob();
}

function getPendingDownloadQueueSnapshot() {
  return pendingDownloadQueue.map((jobId, index) => ({ jobId, queuePosition: index + 1 }));
}

function refreshPendingDownloadQueuePositions() {
  pendingDownloadQueue.forEach((jobId, index) => {
    const job = jobQueue.get(jobId);
    if (!job || job.status !== "queued") return;
    job.queuePosition = index + 1;
    broadcastJobUpdate(jobId, true);
  });
}

function removePendingDownloadJob(jobId: string) {
  const index = pendingDownloadQueue.indexOf(jobId);
  if (index >= 0) pendingDownloadQueue.splice(index, 1);
  pendingDownloadJobIds.delete(jobId);
  if (index >= 0) refreshPendingDownloadQueuePositions();
}

function enqueueDownloadJob(jobId: string) {
  if (activeDownloadSlots.has(jobId) || pendingDownloadJobIds.has(jobId)) return;
  const job = jobQueue.get(jobId);
  if (!job || job.status === "paused") return;
  pendingDownloadQueue.push(jobId);
  pendingDownloadJobIds.add(jobId);
  refreshPendingDownloadQueuePositions();
  tryProcessNextJob();
}

function tryProcessNextJob() {
  if (shuttingDown) return;
  while (activeDownloadsCount < maxConcurrentDownloads && pendingDownloadQueue.length > 0) {
    const jobId = pendingDownloadQueue.shift();
    if (!jobId) continue;
    pendingDownloadJobIds.delete(jobId);
    if (jobQueue.get(jobId)?.status !== 'queued') continue;
    if (activeDownloadSlots.has(jobId)) continue;
    activeDownloadSlots.add(jobId);
    activeDownloadsCount++;
    refreshPendingDownloadQueuePositions();
    const worker = processDownloadJob(jobId).catch((err) => {
      log.error("QUEUE", `Unhandled worker error for job ${jobId}`, err);
      failJob(jobId, `Worker exception: ${err?.message || 'Unknown error'}`);
      releaseDownloadSlot(jobId);
    }).finally(() => { if (activeDownloadWorkers.get(jobId) === worker) activeDownloadWorkers.delete(jobId); });
    activeDownloadWorkers.set(jobId, worker);
  }
}

function releaseDownloadSlot(jobId: string) {
  if (!activeDownloadSlots.delete(jobId)) return;
  activeDownloadsCount = Math.max(0, activeDownloadsCount - 1);
  tryProcessNextJob();
}

// Download workers preserve partial files and report explicit processing stages.
async function processDownloadJob(jobId: string) {
  const job = jobQueue.get(jobId);
  if (!job || job.status !== 'queued') { releaseDownloadSlot(jobId); return; }
  job.status = 'downloading'; job.queuePosition = undefined;
  try {
    const demo = isDemoUrl(job.url);
    await runDownloadWorker(job, {
      directory: DOWNLOADS_DIR, executable: YT_DLP_PATH, format: getYtDlpFormatArg(job.itag, job.type),
      runtimeArgs: demo ? [] : getYtDlpRuntimeArgs(), ffmpeg: ffmpegPath || '', ffmpegDirectory: FFMPEG_DIR,
      demo, processes: activeChildProcesses,
      current: () => jobQueue.get(jobId) === job && job.status === 'downloading' && !shuttingDown,
      update: (force) => broadcastJobUpdate(jobId, force),
      stop: () => stopDownloadProcess(jobId),
      complete: (filePath) => {
        const extension = path.extname(filePath).toLowerCase();
        const mime: Record<string, string> = {
          '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime',
          '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
          '.flac': 'audio/flac', '.aac': 'audio/aac', '.wav': 'audio/wav',
        };
        job.filePath = filePath; job.fileName = path.basename(filePath);
        job.outputFileName = makeDownloadFileName(job, extension);
        job.mimeType = mime[extension] || 'application/octet-stream';
        job.status = 'completed'; job.stage = 'completed'; job.progress = 100; job.stageProgress = 100;
        job.downloadedBytes = fs.statSync(filePath).size; job.totalBytes = job.downloadedBytes;
        job.fileSize = formatBytes(job.downloadedBytes); job.bytesDownloaded = job.fileSize;
        job.speed = '0 MB/s'; job.eta = '00:00'; job.error = undefined; job.recoveryMessage = undefined;
        broadcastJobUpdate(jobId, true);
      },
    });
  } catch (error) {
    if (jobQueue.get(jobId) !== job || job.status !== 'downloading' || shuttingDown) return;
    const reason = error instanceof Error ? error.message : 'The download could not finish.';
    const classified = classifyMediaError(reason, job.provider);
    if ((job.retryCount || 0) < 1 && classified.retryable) {
      job.retryCount = (job.retryCount || 0) + 1;
      job.status = 'queued'; job.stage = 'queued'; job.eta = 'Retrying the requested format…';
      broadcastJobUpdate(jobId, true);
      setTimeout(() => { if (jobQueue.get(jobId) === job && job.status === 'queued') enqueueDownloadJob(jobId); }, 800);
    } else failJob(jobId, reason.startsWith('This download stopped') ? reason : classified.message);
  } finally {
    releaseDownloadSlot(jobId);
  }
}

// Automatic 1-minute Storage Cleanup Worker
setInterval(() => {
  try {
    const now = Date.now();
    const expiryMs = 15 * 60 * 1000; // 15 minutes
    const activeConversions = Array.from(conversionJobs.values()).filter(
      (job) => job.status === 'queued' || job.status === 'converting'
    );
    const activeInputPaths = new Set(activeConversions.map((job) => path.resolve(job.inputPath)));

    // Clean downloads directory
    if (fs.existsSync(DOWNLOADS_DIR)) {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      files.forEach((file) => {
        const filePath = path.join(DOWNLOADS_DIR, file);
        const stats = fs.statSync(filePath);
        if (activeInputPaths.has(path.resolve(filePath))) return;
        if (!stats.isFile() || archiveInputs.has(filePath)) return;
        const fileJobId = file.split('.')[0];
        const owner = jobQueue.get(fileJobId);
        if (owner && ['downloading', 'queued', 'paused'].includes(owner.status)) return;
        if (now - stats.mtimeMs > 24 * 60 * 60_000) {
          fs.unlinkSync(filePath);
          if (owner?.status === 'completed') {
            owner.status = 'failed'; owner.stage = 'failed'; owner.error = 'The saved file expired after 24 hours. Retry to download it again.';
            owner.filePath = undefined; owner.fileName = undefined; broadcastJobUpdate(owner.jobId, true);
          }
        }
      });
    }

    // Clean uploads and converted directories
    const activeConversionIds = new Set(activeConversions.map((job) => job.jobId));
    const activeUploadIds = new Set(activeConversions.map((job) => job.uploadId));
    [UPLOADS_DIR, CONVERTED_DIR].forEach((targetDir) => {
      if (!fs.existsSync(targetDir)) return;
      const cFiles = fs.readdirSync(targetDir);
      cFiles.forEach((file) => {
        const filePath = path.join(targetDir, file);
        const stats = fs.statSync(filePath);
        if (!stats.isFile() || now - stats.mtimeMs <= expiryMs) return;
        if (activeInputPaths.has(path.resolve(filePath))) return;

        const fileId = file.split("_")[0];
        if (targetDir === UPLOADS_DIR && activeUploadIds.has(fileId)) return;
        if (targetDir === CONVERTED_DIR && activeConversionIds.has(fileId)) return;

        try { fs.unlinkSync(filePath); } catch {}
        if (targetDir === UPLOADS_DIR) {
          uploadedFiles.delete(fileId);
        } else {
          conversionJobs.delete(fileId);
        }
      });
    });
  } catch (err) {
    console.error("Cleanup daemon encountered an error:", err);
  }
}, 60 * 1000);

startServer();
