import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function getYouTubeVideoId(url: string): string | null {
  const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  if (match && match[2] && /^[a-zA-Z0-9_-]{11}$/.test(match[2])) {
    return match[2];
  }
  return null;
}

export function getYouTubeEmbedUrl(url: string): string | null {
  const id = getYouTubeVideoId(url);
  return id ? `https://www.youtube.com/embed/${id}?autoplay=1&rel=0&modestbranding=1` : null;
}

export function getBilibiliVideoId(url: string): string | null {
  const bvMatch = url.match(/BV([a-zA-Z0-9]+)/i);
  if (bvMatch && bvMatch[1]) return `BV${bvMatch[1]}`;
  const avMatch = url.match(/av(\d+)/i);
  if (avMatch && avMatch[1]) return `av${avMatch[1]}`;
  return null;
}

export function getBilibiliEmbedUrl(url: string): string | null {
  const bv = getBilibiliVideoId(url);
  if (!bv) return null;
  if (bv.toLowerCase().startsWith('av')) {
    const aid = bv.slice(2);
    if (/^\d+$/.test(aid)) {
      return `https://player.bilibili.com/player.html?aid=${aid}&page=1&high_quality=1`;
    }
  }
  if (/^BV[a-zA-Z0-9]+$/i.test(bv)) {
    return `https://player.bilibili.com/player.html?bvid=${bv}&page=1&high_quality=1`;
  }
  return null;
}

export function getVimeoVideoId(url: string): string | null {
  const match = url.match(/(?:vimeo\.com\/|player\.vimeo\.com\/video\/)(\d+)/i);
  return match && match[1] ? match[1] : null;
}

export function getVimeoEmbedUrl(url: string): string | null {
  const id = getVimeoVideoId(url);
  return id ? `https://player.vimeo.com/video/${id}?autoplay=1` : null;
}

export function getEmbedUrl(provider: string, url: string): string | null {
  if (provider === 'youtube') return getYouTubeEmbedUrl(url);
  if (provider === 'bilibili') return getBilibiliEmbedUrl(url);
  if (provider === 'vimeo') return getVimeoEmbedUrl(url);
  return null; // Douyin, TikTok, Instagram, Facebook, Pinterest, XiaoHongShu don't support open iframe embeds
}

export function canEmbed(provider: string): boolean {
  return provider === 'youtube' || provider === 'bilibili' || provider === 'vimeo';
}

/** Normalizes platform-specific web share links (such as Douyin modal_id URLs) into canonical extractor URLs */
export function normalizeMediaUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  let url = rawUrl.trim();

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
      return `https://www.bilibili.com/video/${bvidMatch[1]}`;
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
export function cleanMediaTrackingParams(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const trackingParams = [
      'spm_id_from', 'vd_source', 'trackid', 'from_source', 'share_source',
      'igsh', 'utm_source', 'utm_medium', 'utm_campaign', 'si', 'share_token',
      'mid', 'sender_device', 'is_from_webapp', 'previous_page', 'app_code',
      'enter_from', 'tab_name', 'extra_params', 'share_app_id'
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
export function extractMediaUrl(input: string): string {
  if (!input) return '';
  // Replace full-width semicolons or colons
  const sanitized = input.replace(/\uff1b/g, ';');
  const trimmed = sanitized.trim();

  let candidate = trimmed;
  // Look for URL embedded within messy share text (e.g., Douyin, XiaoHongShu, Pinterest, TikTok app shares)
  const match = trimmed.match(/https?:\/\/[^\s\u4e00-\u9fa5\r\n\t]+/i);
  if (match) {
    candidate = match[0];
  }

  // Clean trailing punctuation or brackets often attached in mobile share messages (including full-width ；)
  candidate = candidate.replace(/[)\]}>,.!?;:，。！？；\uff1b]+$/, '');
  return cleanMediaTrackingParams(candidate);
}

/** Detect media provider with support for Douyin, Pinterest, Vimeo, XiaoHongShu */
export function detectMediaProvider(targetUrl: string): import('../types').ProviderType {
  const cleanUrl = targetUrl.toLowerCase().trim();
  if (!cleanUrl) return 'unknown';
  if (cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be')) return 'youtube';
  if (cleanUrl.includes('tiktok.com') || cleanUrl.includes('vt.tiktok.com') || cleanUrl.includes('vm.tiktok.com')) return 'tiktok';
  if (cleanUrl.includes('douyin.com') || cleanUrl.includes('iesdouyin.com')) return 'douyin';
  if (cleanUrl.includes('facebook.com') || cleanUrl.includes('fb.watch')) return 'facebook';
  if (cleanUrl.includes('instagram.com')) return 'instagram';
  if (cleanUrl.includes('bilibili.com') || cleanUrl.includes('b23.tv')) return 'bilibili';
  if (cleanUrl.includes('twitter.com') || cleanUrl.includes('x.com')) return 'twitter';
  if (cleanUrl.includes('reddit.com')) return 'reddit';
  if (cleanUrl.includes('vimeo.com')) return 'vimeo';
  if (cleanUrl.includes('pinterest.com') || cleanUrl.includes('pin.it')) return 'pinterest';
  if (cleanUrl.includes('xiaohongshu.com') || cleanUrl.includes('xhslink.com')) return 'xiaohongshu';
  if (cleanUrl.includes('soundcloud.com')) return 'soundcloud';
  return 'generic';
}

export * from './security';

