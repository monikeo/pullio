// URL clean-up shared by the API: extract a link from share text, strip tracking, and
// rewrite platform share links into the canonical form yt-dlp extracts best.

/** Normalizes platform-specific web share links (YouTube, Facebook, Instagram, Douyin, etc.) into canonical extractor URLs */
export function normalizeMediaUrl(rawUrl: string): string {
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
export function cleanMediaTrackingParams(rawUrl: string): string {
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
export function extractMediaUrlFromText(input: string): string {
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

