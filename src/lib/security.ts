import { DownloadHistoryItem, UserPreferences } from '../types';

/**
 * Permitted video & audio media file extensions.
 * Strictly whitelist allowed media containers to prevent arbitrary or executable file uploads.
 */
export const ALLOWED_MEDIA_EXTENSIONS = new Set([
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'gif',
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff'
]);

/** Dangerous extensions that must never be processed */
export const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'bash', 'bin', 'msi', 'com', 'scr', 'pif',
  'php', 'php3', 'php4', 'php5', 'phtml', 'asp', 'aspx', 'jsp', 'cgi', 'pl',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'html', 'htm', 'xhtml', 'svg',
  'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'jar', 'apk', 'iso', 'dll'
]);

export const MAX_UPLOAD_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GB

/**
 * Sanitizes an arbitrary URL string to prevent DOM XSS (javascript:, data:, vbscript: protocols).
 * Returns '#' if the URL is invalid or unsafe.
 */
export function sanitizeUrl(url: string | null | undefined): string {
  if (!url || typeof url !== 'string') return '#';
  const trimmed = url.trim();
  if (!trimmed) return '#';

  // Allow safe relative paths
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    // Strictly whitelist safe schemes
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    // Safe blob: URLs for internal client-generated previews
    if (parsed.protocol === 'blob:' && parsed.origin === window.location.origin) {
      return parsed.href;
    }
  } catch {
    // Malformed URL
  }

  return '#';
}

/**
 * Validates that an input URL is a well-formed HTTP/HTTPS URL and not a private or loopback host.
 */
export function isSafeHttpUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    // Prevent SSRF / local address probing
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.endsWith('.localhost') ||
      host === '169.254.169.254' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes a filename to prevent path traversal, control character injection, or null bytes.
 */
export function sanitizeFilename(rawName: string | null | undefined): string {
  if (!rawName || typeof rawName !== 'string') return 'media_file';
  // Strip path traversal sequences and backslashes
  let clean = rawName
    .replace(/\\/g, '/')
    .split('/')
    .pop() || 'media_file';
  
  // Remove null bytes and control chars
  clean = clean.replace(/[\x00-\x1f\x7f]/g, '');
  // Replace unsafe shell/filesystem characters with underscores
  clean = clean.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Avoid leading dots (hidden files)
  clean = clean.replace(/^\.+/, '');

  return clean.slice(0, 120) || 'media_file';
}

/**
 * Validates a client-side File object before queueing or uploading.
 */
export function validateMediaUpload(file: File): { valid: boolean; error?: string } {
  if (!file) {
    return { valid: false, error: 'No file provided.' };
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
    return { 
      valid: false, 
      error: `File "${file.name}" exceeds the maximum allowed size of 1 GB.` 
    };
  }

  const nameParts = file.name.split('.');
  if (nameParts.length < 2) {
    return { 
      valid: false, 
      error: `File "${file.name}" has no file extension.` 
    };
  }

  const ext = nameParts.pop()!.toLowerCase().trim();
  const secondaryExt = nameParts.length > 1 ? nameParts[nameParts.length - 1].toLowerCase().trim() : '';

  // Check for dangerous extensions (e.g. video.mp4.exe or script.svg)
  if (DANGEROUS_EXTENSIONS.has(ext) || DANGEROUS_EXTENSIONS.has(secondaryExt)) {
    return { 
      valid: false, 
      error: `Security Alert: File type ".${ext}" is prohibited.` 
    };
  }

  // Whitelist check
  if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
    return { 
      valid: false, 
      error: `Unsupported file type ".${ext}". Please upload a supported audio or video file.` 
    };
  }

  return { valid: true };
}

/**
 * Strictly sanitizes an item loaded from localStorage to prevent stored XSS or state pollution.
 */
export function sanitizeHistoryItem(raw: any): DownloadHistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;

  const id = typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.id)
    ? raw.id
    : null;
  if (!id) return null;

  const title = typeof raw.title === 'string' 
    ? raw.title.slice(0, 200).replace(/<[^>]*>/g, '') 
    : 'Media Download';

  const rawUrl = typeof raw.url === 'string' ? raw.url : '';
  const safeUrl = isSafeHttpUrl(rawUrl) ? rawUrl : '#';

  const rawDownloadUrl = typeof raw.downloadUrl === 'string' ? raw.downloadUrl : '';
  const safeDownloadUrl = sanitizeUrl(rawDownloadUrl);

  const rawThumbnail = typeof raw.thumbnail === 'string' ? raw.thumbnail : '';
  const safeThumbnail = sanitizeUrl(rawThumbnail);

  const type: 'video' | 'audio' = raw.type === 'audio' ? 'audio' : 'video';
  const provider = typeof raw.provider === 'string' ? raw.provider.slice(0, 20) : 'unknown';
  const format = typeof raw.format === 'string' ? raw.format.slice(0, 50) : 'Standard';
  const fileSize = typeof raw.fileSize === 'string' ? raw.fileSize.slice(0, 30) : 'Unknown';
  const timestamp = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) 
    ? raw.timestamp 
    : Date.now();

  const jobId = typeof raw.jobId === 'string' && raw.jobId ? raw.jobId.slice(0, 64) : id;

  return {
    id,
    jobId,
    title,
    url: safeUrl,
    downloadUrl: safeDownloadUrl,
    thumbnail: safeThumbnail === '#' ? '' : safeThumbnail,
    type,
    provider: provider as any,
    format,
    fileSize,
    timestamp,
  };
}

/**
 * Validates and sanitizes UserPreferences loaded from storage.
 */
export function sanitizeUserPreferences(raw: any): UserPreferences {
  const defaults: UserPreferences = {
    defaultFormat: 'best',
    defaultContainer: 'mp4',
    maxConcurrentDownloads: 2,
    filenameTemplate: '{title} - {platform}',
    autoAnalyzeOnPaste: true,
    notifyOnComplete: true,
  };

  if (!raw || typeof raw !== 'object') return defaults;

  const allowedFormats = ['best', '1080p', '720p', '480p', '360p', 'audio-320', 'audio-128'];
  const allowedContainers = ['mp4', 'mkv', 'webm', 'mp3'];
  const allowedConcurrentDownloadLimits = [1, 2, 3, 4];

  return {
    defaultFormat: allowedFormats.includes(raw.defaultFormat) ? raw.defaultFormat : defaults.defaultFormat,
    defaultContainer: allowedContainers.includes(raw.defaultContainer) ? raw.defaultContainer : defaults.defaultContainer,
    maxConcurrentDownloads: allowedConcurrentDownloadLimits.includes(raw.maxConcurrentDownloads) ? raw.maxConcurrentDownloads : defaults.maxConcurrentDownloads,
    filenameTemplate: typeof raw.filenameTemplate === 'string' && raw.filenameTemplate.length > 0 && raw.filenameTemplate.length <= 120
      ? raw.filenameTemplate
      : defaults.filenameTemplate,
    autoAnalyzeOnPaste: Boolean(raw.autoAnalyzeOnPaste),
    notifyOnComplete: Boolean(raw.notifyOnComplete),
  };
}
