import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { WebSocket } from 'ws';
import { detectProviderFromUrl, providerFromExtractor } from '../src/lib/providers';
import { assertPublicMediaUrl, isPrivateAddress, isValidMediaUrl } from '../src/lib/netSafety.server';
import { isAllowedHostHeader, isSameOriginRequest } from '../src/lib/requestGuard.server';
import { metadataEmbedArgs } from '../src/lib/downloads';
import { pickPreferredFormat } from '../src/lib/formats';
import { isValidSubtitleLanguage, selectSubtitleTracks } from '../src/lib/subtitles.server';
import { MediaEngine } from '../src/lib/engine.server';
import { buildMediaFormatList } from '../src/lib/mediaFormats.server';
import { classifyMediaError } from '../src/lib/mediaErrors.server';
import { extractMediaUrlFromText, normalizeMediaUrl } from '../src/lib/mediaUrls';
import type { Formats } from '../src/types';

test('provider detection uses hostnames, not substrings', () => {
  assert.equal(detectProviderFromUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), 'youtube');
  assert.equal(detectProviderFromUrl('https://youtu.be/aqz-KE-bpKQ'), 'youtube');
  assert.equal(detectProviderFromUrl('https://music.youtube.com/watch?v=1'), 'youtube');
  assert.equal(detectProviderFromUrl('https://x.com/user/status/1'), 'twitter');
  assert.equal(detectProviderFromUrl('https://m.facebook.com/watch/?v=1'), 'facebook');
  assert.equal(detectProviderFromUrl('https://www.pinterest.co.uk/pin/123/'), 'pinterest');
  assert.equal(detectProviderFromUrl('vimeo.com/76979871'), 'vimeo');
  // These used to be misdetected as X/Twitter because they contain "x.com".
  assert.equal(detectProviderFromUrl('https://www.dropbox.com/s/abc/video.mp4'), 'generic');
  assert.equal(detectProviderFromUrl('https://www.netflix.com/title/1'), 'generic');
  assert.equal(detectProviderFromUrl('https://example.com/?next=youtube.com'), 'generic');
  assert.equal(detectProviderFromUrl('not a url at all'), 'unknown');
  assert.equal(providerFromExtractor('BiliBili'), 'bilibili');
  assert.equal(providerFromExtractor('XHS'), 'xiaohongshu');
  assert.equal(providerFromExtractor('Generic'), 'generic');
});

test('private address detection covers IPv4, IPv6, and embedded IPv4 forms', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '[::1]']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('media URL validation rejects local targets, including encoded forms', () => {
  assert.equal(isValidMediaUrl('https://www.youtube.com/watch?v=x').valid, true);
  for (const url of ['http://localhost/x', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/', 'http://router/', 'http://nas.local/',
    'http://printer.lan/', 'ftp://example.com/a.mp4', 'file:///etc/passwd', 'javascript:alert(1)', '']) {
    assert.equal(isValidMediaUrl(url).valid, false, url);
  }
  assert.equal(isValidMediaUrl(`https://example.com/${'a'.repeat(8001)}`).valid, false);
});

test('DNS check refuses public names that resolve to private addresses', async () => {
  const resolveTo = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
  await assert.rejects(assertPublicMediaUrl('https://rebind.example/video', resolveTo('127.0.0.1')), /private or local/);
  await assert.rejects(assertPublicMediaUrl('https://rebind.example/video', resolveTo('::1')), /private or local/);
  await assert.doesNotReject(assertPublicMediaUrl('https://media.example/video', resolveTo('93.184.216.34')));
  await assert.rejects(assertPublicMediaUrl('https://missing.example/', async () => { throw new Error('ENOTFOUND'); }), /Could not resolve/);
});

test('request guard enforces loopback hosts and same-origin requests', () => {
  const loopback = { bindHost: '127.0.0.1' };
  assert.equal(isAllowedHostHeader('localhost:3000', loopback), true);
  assert.equal(isAllowedHostHeader('127.0.0.1:3000', loopback), true);
  assert.equal(isAllowedHostHeader('[::1]:3000', loopback), true);
  assert.equal(isAllowedHostHeader('attacker.example:3000', loopback), false);
  assert.equal(isAllowedHostHeader(undefined, loopback), false);
  assert.equal(isAllowedHostHeader('media.example.com', { bindHost: '0.0.0.0' }), true);
  const listed = { bindHost: '0.0.0.0', allowedHosts: 'media.example.com, .corp.example' };
  assert.equal(isAllowedHostHeader('media.example.com', listed), true);
  assert.equal(isAllowedHostHeader('app.corp.example:8443', listed), true);
  assert.equal(isAllowedHostHeader('other.example', listed), false);
  assert.equal(isSameOriginRequest(undefined, 'localhost:3000'), true);
  assert.equal(isSameOriginRequest('http://localhost:3000', 'localhost:3000'), true);
  assert.equal(isSameOriginRequest('https://attacker.example', 'localhost:3000'), false);
  assert.equal(isSameOriginRequest('null', 'localhost:3000'), false);
});

test('metadata embedding only requests cover art for containers that support it', () => {
  assert.deepEqual(metadataEmbedArgs({ type: 'audio', itag: 'audio-320', targetContainer: 'mp3' }), ['--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg']);
  assert.deepEqual(metadataEmbedArgs({ type: 'video', itag: 'yt:merge:137', targetContainer: 'mkv' }), ['--embed-metadata', '--embed-chapters', '--embed-thumbnail', '--convert-thumbnails', 'jpg']);
  assert.deepEqual(metadataEmbedArgs({ type: 'video', itag: 'best', targetContainer: 'webm' }), ['--embed-metadata', '--embed-chapters']);
  assert.deepEqual(metadataEmbedArgs({ type: 'audio', itag: 'yt:audio-source:251', targetContainer: undefined }), ['--embed-metadata']);
  assert.deepEqual(metadataEmbedArgs({ type: 'audio', itag: 'audio-320', targetContainer: 'mp3', embedMetadata: false }), []);
});

test('quality preference picks the best stream at or below the target', () => {
  const formats: Formats[] = [
    { itag: 'yt:merge:313', quality: '2160p', type: 'video', width: 3840, height: 2160 },
    { itag: 'yt:merge:137', quality: '1080p', type: 'video', width: 1920, height: 1080 },
    { itag: 'yt:video:18', quality: '360p', type: 'video', width: 640, height: 360 },
    { itag: 'yt:audio-source:251', quality: '160 kbps opus', type: 'audio' },
    { itag: 'audio-320', quality: 'MP3 · 320 kbps target', type: 'audio' },
  ];
  assert.equal(pickPreferredFormat(formats, 'best')?.itag, 'yt:merge:313');
  assert.equal(pickPreferredFormat(formats, '1080p')?.itag, 'yt:merge:137');
  assert.equal(pickPreferredFormat(formats, '1440p')?.itag, 'yt:merge:137');
  assert.equal(pickPreferredFormat(formats, '720p')?.itag, 'yt:video:18');
  assert.equal(pickPreferredFormat(formats, '240p')?.itag, 'yt:video:18');
  assert.equal(pickPreferredFormat(formats, 'audio-320')?.itag, 'audio-320');
  // A 1080×1920 portrait video is 1080p, not 1920p.
  const portrait: Formats[] = [{ itag: 'p', quality: '1080p', type: 'video', width: 1080, height: 1920 }, { itag: 'q', quality: '720p', type: 'video', width: 720, height: 1280 }];
  assert.equal(pickPreferredFormat(portrait, '1080p')?.itag, 'p');
});

test('subtitle selection keeps creator tracks and original-language captions only', () => {
  const translations = Object.fromEntries(['af', 'de', 'fr', 'ja', 'zh-Hans'].map((lang) => [lang, [{ ext: 'vtt', name: `${lang} from English` }]]));
  const tracks = selectSubtitleTracks({
    language: 'en',
    subtitles: { 'es': [{ ext: 'vtt', name: 'Spanish' }], live_chat: [{ ext: 'json' }] },
    automatic_captions: { ...translations, 'en-orig': [{ ext: 'vtt', name: 'English (Original)' }], en: [{ ext: 'vtt', name: 'English' }] },
  });
  assert.deepEqual(tracks.map((track) => `${track.auto ? 'auto' : 'sub'}:${track.lang}`), ['sub:es', 'auto:en-orig', 'auto:en']);
  assert.equal(selectSubtitleTracks({ automatic_captions: { en: [{ ext: 'vtt' }] }, language: 'en' })[0].name, 'English (auto-generated)');
  assert.equal(isValidSubtitleLanguage('en-US'), true);
  assert.equal(isValidSubtitleLanguage('.*'), false);
  assert.equal(isValidSubtitleLanguage('en,all'), false);
});

test('format builder detects combined, video-only, codec-less, and audio streams', () => {
  const formats = buildMediaFormatList({
    vcodec: 'h264',
    formats: [
      // TikTok/YouTube progressive: yt-dlp reports audio_ext "none" even though audio is present.
      { format_id: 'h264_540p_992286-0', ext: 'mp4', vcodec: 'h264', acodec: 'aac', video_ext: 'mp4', audio_ext: 'none', width: 576, height: 1024 },
      // DASH video-only stream.
      { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', video_ext: 'mp4', audio_ext: 'none', width: 1920, height: 1080, fps: 30 },
      // Facebook progressive MP4s: no codec fields and no dimensions.
      { format_id: 'sd', ext: 'mp4', video_ext: 'mp4', audio_ext: 'none', quality: -3 },
      { format_id: 'hd', ext: 'mp4', video_ext: 'mp4', audio_ext: 'none', quality: -2 },
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', video_ext: 'none', audio_ext: 'm4a', abr: 129 },
      { format_id: 'sb0', ext: 'mhtml', format_note: 'storyboard', vcodec: 'none', acodec: 'none' },
    ],
  });
  const byItag = Object.fromEntries(formats.map((f: any) => [f.itag, f]));
  assert.match(byItag['yt:video:h264_540p_992286-0'].quality, /^576p · 576×1024 · h264 · MP4 · audio included$/);
  assert.match(byItag['yt:merge:137'].quality, /merge best audio$/);
  assert.ok(byItag['yt:raw:137'], 'video-only streams are also offered without audio');
  assert.match(byItag['yt:merge:hd'].quality, /^HD · MP4 · best available audio$/);
  assert.ok(byItag['yt:merge:sd']);
  assert.ok(byItag['yt:audio-source:140']);
  assert.equal(formats.some((f: any) => String(f.itag).includes('sb0')), false);
  // Highest first; codec-less HD/SD rank as 720p/360p.
  const videoOrder = formats.filter((f: any) => f.type === 'video').map((f: any) => f.itag);
  assert.deepEqual(videoOrder, ['yt:merge:137', 'yt:merge:hd', 'yt:video:h264_540p_992286-0', 'yt:merge:sd']);
  // Audio-only sources (SoundCloud, MP3 links) offer no video choices.
  const audioOnly = buildMediaFormatList({ vcodec: 'none', formats: [{ format_id: 'http_mp3_128', ext: 'mp3', vcodec: 'none', acodec: 'mp3', audio_ext: 'mp3', video_ext: 'none', abr: 128 }] });
  assert.equal(audioOnly.some((f: any) => f.type === 'video'), false);
});

test('format builder keeps one copy of mirrored renditions, preferring yt-dlp’s choice', () => {
  const formats = buildMediaFormatList({ formats: [
    { format_id: 'hls-akfire_interconnect_quic-audio-high-English', vcodec: 'none', protocol: 'm3u8_native', ext: 'mp4', audio_ext: 'mp4', video_ext: 'none' },
    { format_id: 'hls-fastly_skyfire-audio-high-English', vcodec: 'none', protocol: 'm3u8_native', ext: 'mp4', audio_ext: 'mp4', video_ext: 'none' },
    { format_id: 'hls-fastly_skyfire-audio-low-English', vcodec: 'none', protocol: 'm3u8_native', ext: 'mp4', audio_ext: 'mp4', video_ext: 'none' },
    { format_id: 'hls-akfire_interconnect_quic-407', vcodec: 'avc1.42C01E', acodec: 'none', width: 480, height: 270, tbr: 407, protocol: 'm3u8_native', ext: 'mp4' },
    { format_id: 'hls-fastly_skyfire-407', vcodec: 'avc1.42C01E', acodec: 'none', width: 480, height: 270, tbr: 407, protocol: 'm3u8_native', ext: 'mp4' },
    { format_id: 'h264_540p_992286-0', vcodec: 'h264', acodec: 'aac', width: 576, height: 1024, tbr: 992, protocol: 'https', ext: 'mp4' },
    { format_id: 'h264_540p_992286-1', vcodec: 'h264', acodec: 'aac', width: 576, height: 1024, tbr: 992, protocol: 'https', ext: 'mp4' },
    { format_id: '140-drc', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129.757, protocol: 'https', ext: 'm4a', audio_ext: 'm4a' },
    { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129.796, protocol: 'https', ext: 'm4a', audio_ext: 'm4a' },
    { format_id: 'drm-1080', vcodec: 'avc1', acodec: 'none', width: 1920, height: 1080, tbr: 5000, has_drm: true, ext: 'mp4' },
    { format_id: 'sd', ext: 'mp4', video_ext: 'mp4' },
    { format_id: 'hd', ext: 'mp4', video_ext: 'mp4' },
  ] });
  const itags = formats.map((f: any) => String(f.itag));
  assert.ok(itags.includes('yt:merge:hls-fastly_skyfire-407'));
  assert.equal(itags.includes('yt:merge:hls-akfire_interconnect_quic-407'), false);
  assert.ok(itags.includes('yt:audio-source:hls-fastly_skyfire-audio-high-English'));
  assert.ok(itags.includes('yt:audio-source:hls-fastly_skyfire-audio-low-English'), 'distinct audio qualities are kept');
  assert.equal(itags.includes('yt:audio-source:hls-akfire_interconnect_quic-audio-high-English'), false);
  assert.deepEqual(itags.filter((itag) => itag.includes('h264_540p')), ['yt:video:h264_540p_992286-1']);
  assert.deepEqual(itags.filter((itag) => itag.startsWith('yt:audio-source:140')), ['yt:audio-source:140']);
  assert.equal(itags.some((itag) => itag.includes('drm-1080')), false, 'DRM formats are never offered');
  assert.ok(itags.includes('yt:merge:hd') && itags.includes('yt:merge:sd'), 'Facebook HD and SD stay separate');
});

test('error classifier explains the real cause, not words from yt-dlp help text', () => {
  const vimeo = classifyMediaError('ERROR: [vimeo] 76979871: The web client only works when logged-in. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (vimeo) to provide account credentials.', 'vimeo');
  assert.equal(vimeo.category, 'AUTH_REQUIRED');
  assert.doesNotMatch(vimeo.message, /password protected/);
  assert.match(vimeo.message, /\.vimeo\.com/);
  const douyin = classifyMediaError('ERROR: [Douyin] 6961737553342991651: Fresh cookies (not necessarily logged in) are needed', 'douyin');
  assert.equal(douyin.category, 'AUTH_REQUIRED');
  assert.match(douyin.message, /fresh browser cookies/);
  const reddit = classifyMediaError('ERROR: [Reddit] 6rrwyj: Account authentication is required. Use --cookies-from-browser or --cookies for the authentication.');
  assert.equal(reddit.category, 'AUTH_REQUIRED');
  assert.match(reddit.message, /^Reddit requires a signed-in session/);
  const bot = classifyMediaError("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.", 'youtube');
  assert.equal(bot.category, 'BOT_CHECK');
  const privateVideo = classifyMediaError("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.", 'youtube');
  assert.equal(privateVideo.category, 'PRIVATE_VIDEO');
  const age = classifyMediaError('ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', 'youtube');
  assert.equal(age.category, 'AUTH_REQUIRED');
  assert.match(age.message, /age-restricted/);
  const instagram = classifyMediaError('ERROR: [Instagram] CWqAgUZgCku: Instagram sent an empty media response.', 'instagram');
  assert.match(instagram.message, /sessionid/);
  const tiktok = classifyMediaError('ERROR: [TikTok] 1: Unable to download webpage: HTTP Error 403: Forbidden', 'tiktok');
  assert.equal(tiktok.retryable, true);
  const unknown = classifyMediaError('ERROR: [Foo] 1: Something odd happened; please report this issue on https://github.com/yt-dlp/yt-dlp/issues');
  assert.equal(unknown.message, '[Foo] 1: Something odd happened');
});

test('URL normalization produces the links yt-dlp extracts best', () => {
  // Vimeo pages are kept as-is: the player endpoint only serves DRM streams for many videos.
  assert.equal(normalizeMediaUrl('https://vimeo.com/76979871'), 'https://vimeo.com/76979871');
  assert.equal(extractMediaUrlFromText('Watch this https://youtu.be/jNQXAC9IVRw?si=abc123 !'), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(extractMediaUrlFromText('https://www.youtube.com/shorts/r-tZnHuRC0I?feature=share'), 'https://www.youtube.com/shorts/r-tZnHuRC0I');
  assert.equal(normalizeMediaUrl('https://www.douyin.com/jingxuan?modal_id=7123456789012345678'), 'https://www.douyin.com/video/7123456789012345678');
  assert.equal(normalizeMediaUrl('https://m.facebook.com/watch/?v=1'), 'https://www.facebook.com/watch/?v=1');
  // XiaoHongShu links only work with their access token, so it must survive tracking clean-up.
  assert.match(extractMediaUrlFromText('看看 https://www.xiaohongshu.com/explore/671d03d3000000001b02dd32?xsec_token=CBSw%3D&xsec_source=app_share 复制'), /xsec_token=CBSw/);
  assert.equal(extractMediaUrlFromText('https://www.instagram.com/reels/CWqAgUZgCku/?igsh=xyz'), 'https://www.instagram.com/reel/CWqAgUZgCku/');
});

test('engine version age is derived from the yt-dlp release date', () => {
  assert.equal(MediaEngine.versionAgeDays('2026.08.19', Date.UTC(2026, 7, 29)), 10);
  assert.equal(MediaEngine.versionAgeDays('2026.08.19.232338', Date.UTC(2026, 7, 19)), 0);
  assert.equal(MediaEngine.versionAgeDays(null), null);
  assert.equal(MediaEngine.versionAgeDays('nightly'), null);
});

test('server API rejects cross-site use, merges cookies per site, and hides file paths', { timeout: 120_000 }, async (t) => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'pullio-hardening-'));
  const cookiesFile = path.join(storage, 'cookies.txt');
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const child = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'server.ts'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', PULLIO_STORAGE_DIR: storage, PULLIO_COOKIES_FILE: cookiesFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-6000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-6000); });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    // Wait for the server to exit so Windows releases its handles before the folder is removed.
    if (child.exitCode === null) await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill(); });
    const resolved = path.resolve(storage);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}pullio-hardening-`));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  let running = false;
  for (let i = 0; i < 150 && !running; i++) {
    try { running = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (!running) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(running, logs);
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });

  // Cross-site requests and DNS-rebinding hosts are refused before any work is done.
  assert.equal((await post('/api/analyze', { url: 'https://www.youtube.com/watch?v=x' }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/jobs`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const rebinding = await new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/jobs', headers: { Host: `attacker.example:${port}` } }, (response) => { response.resume(); resolve(response.statusCode || 0); }).on('error', reject);
  });
  assert.equal(rebinding, 421);

  // Local and private targets are rejected with a 400, not a 500.
  for (const url of ['http://127.0.0.1:22/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/']) {
    const response = await post('/api/analyze', { url });
    assert.equal(response.status, 400, url);
    assert.match((await response.json()).error, /private or local/);
  }
  assert.equal((await fetch(`${base}/api/thumbnail?url=${encodeURIComponent('http://127.0.0.1/a.jpg')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/stream`)).status, 400);
  assert.equal((await fetch(`${base}/api/subtitles?url=${encodeURIComponent('https://www.youtube.com/watch?v=x')}&lang=${encodeURIComponent('.*')}`)).status, 400);

  // Saving a second site's cookies keeps the first; removal is per site.
  let response = await post('/api/cookies', { cookies: 'SID=youtube-session; HSID=abc', domain: '.youtube.com' });
  assert.equal(response.status, 200);
  response = await post('/api/cookies', { cookies: 'SESSDATA=bili-session', domain: '.bilibili.com' });
  let summary = await response.json();
  assert.deepEqual(summary.domains, ['bilibili.com', 'youtube.com']);
  assert.equal(summary.cookieCount, 3);
  response = await post('/api/cookies', { cookies: 'SID=replaced', domain: '.youtube.com' });
  summary = await response.json();
  assert.equal(summary.cookieCount, 2);
  assert.match(fs.readFileSync(cookiesFile, 'utf8'), /\tSID\treplaced/);
  assert.doesNotMatch(fs.readFileSync(cookiesFile, 'utf8'), /youtube-session/);
  assert.equal((await post('/api/cookies', { cookies: 'a=b', domain: '.evil.com\nx' })).status, 400);
  summary = await (await fetch(`${base}/api/cookies?domain=youtube.com`, { method: 'DELETE' })).json();
  assert.deepEqual(summary.domains, ['bilibili.com']);
  summary = await (await fetch(`${base}/api/cookies`, { method: 'DELETE' })).json();
  assert.equal(summary.configured, false);
  assert.equal(fs.existsSync(cookiesFile), false);

  // Engine status reports the bundled tools.
  const engine = await (await fetch(`${base}/api/engine`, { signal: AbortSignal.timeout(60_000) })).json();
  assert.match(String(engine.ytDlp.version), /^\d{4}\.\d{2}\.\d{2}/);
  assert.ok(engine.ffmpeg.version);
  assert.equal(typeof engine.ytDlp.ageDays, 'number');

  // WebSocket upgrades from another origin are refused; same-origin clients connect.
  const connect = (origin?: string) => new Promise<'open' | 'rejected'>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    socket.once('open', () => { socket.close(); resolve('open'); });
    socket.once('error', () => resolve('rejected'));
  });
  assert.equal(await connect('https://attacker.example'), 'rejected');
  assert.equal(await connect(`http://127.0.0.1:${port}`), 'open');

  // Conversion status and progress never expose server file paths.
  const fixture = path.join(storage, 'tone.wav');
  execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', fixture]);
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(fixture)], { type: 'audio/wav' }), 'tone.wav');
  const upload = await (await fetch(`${base}/api/convert/upload`, { method: 'POST', body: form })).json();
  const uploadId = upload.files[0].uploadId;
  const conversion = await (await post('/api/convert/process', { items: [{ uploadId, targetFormat: 'mp3', audioBitrate: '128k' }] })).json();
  const jobId = conversion.jobs[0].jobId;
  let status: any;
  for (let i = 0; i < 100; i++) {
    status = (await (await fetch(`${base}/api/convert/status/${jobId}`)).json()).job;
    if (status.status === 'completed' || status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status.status, 'completed', JSON.stringify(status));
  assert.equal('inputPath' in status, false);
  assert.equal('outputPath' in status, false);
  const download = await fetch(`${base}/api/convert/download/${jobId}`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(download.status, 206);
  await download.arrayBuffer();
  await fetch(`${base}/api/convert/${jobId}`, { method: 'DELETE' });
});
