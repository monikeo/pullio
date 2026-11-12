import type { Formats } from '../types';

/** The "p" resolution of a format: the short side, so a 1080×1920 portrait video counts as 1080p. */
export function formatResolution(format: Formats): number {
  if (format.width && format.height) return Math.min(format.width, format.height);
  if (format.height) return format.height;
  return Number(String(format.quality || '').match(/(?:^|\D)(\d{3,4})p\b/i)?.[1] || 0);
}

/**
 * Choose the format matching a quality preference such as `best`, `1080p`, or `audio-320`.
 * For a resolution, this is the best stream at or below it (never an upscale), falling back
 * to the smallest stream when everything is larger.
 */
export function pickPreferredFormat(formats: Formats[], preference?: string): Formats | undefined {
  if (!formats.length) return undefined;
  const pref = String(preference || 'best').toLowerCase();
  const videos = formats.filter((format) => format.type === 'video');
  if (pref.startsWith('audio')) {
    return formats.find((format) => String(format.itag).toLowerCase() === pref)
      || formats.find((format) => format.type === 'audio')
      || formats[0];
  }
  const target = parseInt(pref, 10);
  if (pref === 'best' || !Number.isFinite(target)) return videos[0] || formats[0];
  // Stable sort keeps the server's frame-rate/bitrate ordering within one resolution.
  const ranked = [...videos].sort((a, b) => formatResolution(b) - formatResolution(a));
  return ranked.find((format) => {
    const resolution = formatResolution(format);
    return resolution > 0 && resolution <= target;
  }) || ranked[ranked.length - 1] || formats[0];
}
