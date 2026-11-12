export interface ClassifiedError {
  category: 'BOT_CHECK' | 'RATE_LIMIT' | 'AUTH_REQUIRED' | 'PRIVATE_VIDEO' | 'GEO_BLOCKED' | 'FORMAT_UNAVAILABLE' | 'NOT_FOUND' | 'TIMEOUT' | 'UNKNOWN';
  message: string;
  retryable: boolean;
  suggestedFallback?: string;
}

const PROVIDER_NAMES: Record<string, string> = {
  youtube: 'YouTube', tiktok: 'TikTok', douyin: 'Douyin', facebook: 'Facebook', instagram: 'Instagram',
  bilibili: 'Bilibili', twitter: 'X (Twitter)', reddit: 'Reddit', vimeo: 'Vimeo', pinterest: 'Pinterest',
  xiaohongshu: 'XiaoHongShu', soundcloud: 'SoundCloud',
};

const COOKIE_DOMAINS: Record<string, string> = {
  youtube: '.youtube.com', tiktok: '.tiktok.com', douyin: '.douyin.com', facebook: '.facebook.com', instagram: '.instagram.com',
  bilibili: '.bilibili.com', twitter: '.x.com', reddit: '.reddit.com', vimeo: '.vimeo.com', pinterest: '.pinterest.com',
  xiaohongshu: '.xiaohongshu.com', soundcloud: '.soundcloud.com',
};

/** Infer the platform from yt-dlp's `[Extractor]` prefix when the caller did not know it. */
function providerFromMessage(text: string, fallback: string): string {
  if (fallback && fallback !== 'generic' && fallback !== 'unknown') return fallback;
  const extractor = text.match(/\[([a-z0-9:_-]+)\]/i)?.[1]?.toLowerCase() || '';
  return Object.keys(PROVIDER_NAMES).find((key) => extractor.includes(key) || (key === 'xiaohongshu' && extractor.includes('xhs'))) || fallback;
}

/** Categorize yt-dlp stderr output into user-friendly diagnostic messages. */
export function classifyMediaError(rawError: string | Error | any, provider = 'generic'): ClassifiedError {
  const combined = `${rawError?.stderr || ''} ${rawError?.message || ''} ${String(rawError || '')}`;
  const str = combined.toLowerCase();
  // yt-dlp appends help text such as "Use --cookies, --username and --password"; option names
  // must not be mistaken for the actual problem (e.g. a "password-protected" video).
  const prose = str.replace(/--[a-z][a-z0-9-]*/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const platform = providerFromMessage(combined, provider);
  const name = PROVIDER_NAMES[platform] || 'The platform';
  const cookieDomain = COOKIE_DOMAINS[platform];
  const addCookies = cookieDomain
    ? `Sign in to ${name} in your browser, export its cookies, and save them in Settings for ${cookieDomain}.`
    : 'Sign in to the site in your browser, export its cookies, and save them in Settings.';

  if (platform === 'bilibili' && (str.includes('412') || str.includes('precondition failed'))) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Bilibili returned HTTP 412 (a precondition or security check). Confirm the video opens in your browser; if it is account-restricted, configure your own valid Bilibili session cookies. This app cannot bypass platform challenges.',
      retryable: false,
    };
  }

  if (platform === 'douyin' && prose.includes('fresh cookies')) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Douyin needs fresh browser cookies (no login required). Open douyin.com in your browser, play any video, export the cookies, and save them in Settings for .douyin.com. Saved Douyin cookies expire after a while.',
      retryable: false,
    };
  }

  if (
    (platform === 'douyin' || str.includes('iesdouyin')) &&
    (str.includes('verify') || str.includes('验证') || str.includes('captcha') || str.includes('slide') || str.includes('risk control') ||
      str.includes('风险') || str.includes('ttwid') || str.includes('s_v_web_id') || str.includes('403') || str.includes('412'))
  ) {
    return {
      category: 'BOT_CHECK',
      message: 'Douyin returned a security or verification challenge. Complete checks through Douyin’s official site or app; this downloader cannot bypass them. Fresh cookies from your own browser may help with content your account can access.',
      retryable: false,
    };
  }

  if (str.includes('429') || str.includes('too many requests') || str.includes('rate-limit') || str.includes('rate limit')) {
    return {
      category: 'RATE_LIMIT',
      message: `${name} is limiting requests right now (HTTP 429). Wait a few minutes before queueing more downloads.`,
      retryable: false,
    };
  }

  if (platform === 'instagram' && /empty media response|not granting access|checkpoint_required|login_required|for the authentication|requires authentication|login required/.test(prose)) {
    return {
      category: 'AUTH_REQUIRED',
      message: `Instagram requires a signed-in session for this post. ${addCookies} Include the sessionid cookie.`,
      retryable: false,
    };
  }

  // These YouTube messages also end with "Use --cookies … for the authentication", so they are
  // matched before the generic sign-in rule below.
  if (prose.includes('private video') || prose.includes('this video is private') || prose.includes('members-only') || prose.includes('members only') || prose.includes('join this channel')) {
    return { category: 'PRIVATE_VIDEO', message: 'This video is private, members-only, or restricted by the creator.', retryable: false };
  }

  if (/confirm your age|age[- ]restricted|inappropriate for some users/.test(prose)) {
    return {
      category: 'AUTH_REQUIRED',
      message: `This video is age-restricted. ${addCookies}`,
      retryable: false,
    };
  }

  if (prose.includes('not a bot') || prose.includes('po token') || prose.includes('captcha') || prose.includes('sign in to confirm')) {
    return {
      category: 'BOT_CHECK',
      message: `${name} asked for a verification check on this request. Check that the link opens in your browser, keep the download engine updated (Settings → Download Engine), and if needed add your own cookies in Settings. This app cannot bypass platform checks.`,
      retryable: false,
    };
  }

  // Generic "you must be signed in" responses (Vimeo, Reddit, X, …).
  if (/only works when logged[- ]in|account authentication is required|authentication is required|login required|requires (?:a )?login|log ?in to (?:continue|view|watch)|sign in to view|you need to log in|this content isn.t available to everyone|cookies for the authentication/.test(prose)
    || /use\s+(?:--cookies|--cookies-from-browser)\b/.test(str)) {
    return {
      category: 'AUTH_REQUIRED',
      message: `${name} requires a signed-in session for this media. ${addCookies}`,
      retryable: false,
    };
  }

  if (platform === 'bilibili' && str.includes('403')) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Bilibili denied access (HTTP 403). Check that the video opens for your account; if it is account-restricted, configure your own valid Bilibili session cookies. This app cannot bypass platform challenges.',
      retryable: false,
    };
  }

  if (platform === 'facebook' && /checkpoint|friends-only|private|login/.test(prose)) {
    return {
      category: 'AUTH_REQUIRED',
      message: `This Facebook video is private, friends-only, or needs a signed-in session. Check the post's visibility, or ${addCookies.charAt(0).toLowerCase()}${addCookies.slice(1)}`,
      retryable: false,
    };
  }

  if (platform === 'vimeo' && /password[- ]protected|video password|requires a password|private video|this video is private|embed.*(?:only|restricted)|domain[- ]restrict/.test(prose)) {
    return {
      category: 'PRIVATE_VIDEO',
      message: 'This Vimeo video is password protected, private, or limited to specific websites by its creator.',
      retryable: false,
    };
  }

  if (str.includes('403') || str.includes('forbidden')) {
    return {
      category: 'AUTH_REQUIRED',
      message: `${name} denied access (HTTP 403). Retry in a moment; if it keeps failing, check that the link opens in your browser and update the download engine in Settings.`,
      retryable: platform === 'tiktok',
    };
  }

  if (str.includes('412') || str.includes('precondition failed')) {
    return {
      category: 'AUTH_REQUIRED',
      message: `${name} returned HTTP 412 (a precondition or security check). Confirm the link opens in your browser and retry only if the platform permits access. This app cannot bypass platform challenges.`,
      retryable: false,
    };
  }

  // Non-ASCII / Latin-1 encoding errors (e.g. Chinese full-width semicolons in cookies or headers)
  if (str.includes('unicodeencodeerror') || str.includes('latin-1') || str.includes('ordinal not in range') || str.includes('；') || str.includes('\\uff1b')) {
    return {
      category: 'AUTH_REQUIRED',
      message: 'Invalid cookie or header character encoding: Full-width Chinese punctuation (；) or non-ASCII characters detected. Pullio has auto-sanitized the cookies — please retry.',
      retryable: true,
    };
  }

  if (platform === 'xiaohongshu' && /no video|extract_note|not a video|no video formats|extractorerror/.test(prose)) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'This XiaoHongShu note (小红书笔记) has no video, or it needs its full share link. Use Share → Copy link in the app so the link includes its access token, or add XiaoHongShu cookies in Settings. Image notes (图文笔记) cannot be downloaded as video.',
      retryable: false,
    };
  }

  if (platform === 'pinterest' && (prose.includes('no video') || prose.includes('format not available') || prose.includes('no video formats'))) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'This Pinterest pin is a static image or GIF without an MP4 video stream.',
      retryable: false,
    };
  }

  if (platform === 'twitter' && /no video could be found|no video|does not contain/.test(prose)) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'This post has no downloadable video. Open the post itself (not a reply or quote) that contains the video.',
      retryable: false,
    };
  }

  if (prose.includes('not available in your country') || prose.includes('geo-restricted') || prose.includes('geo restricted') || prose.includes('geo blocked')) {
    return { category: 'GEO_BLOCKED', message: 'This media is geo-restricted and not licensed for streaming in this region.', retryable: false };
  }

  if (/drm protected|this video is drm|widevine|playready|fairplay/.test(prose)) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'This stream is copy-protected (DRM) and cannot be downloaded. Choose another quality; if every quality is protected, the platform does not allow downloads of this media.',
      retryable: false,
    };
  }

  if (prose.includes('requested format is not available') || prose.includes('format not available')) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'The requested resolution stream was not provided by the host. Auto-retrying with best standard stream...',
      retryable: true,
      suggestedFallback: 'best',
    };
  }

  if (/video is unavailable|video unavailable|does not exist|not found|\b404\b|has been removed|was deleted/.test(prose)) {
    return {
      category: 'NOT_FOUND',
      message: 'Media not found. The video or playlist may have been deleted, set to private, or the URL is invalid.',
      retryable: false,
    };
  }

  if (/timed out|timeout|socket hang up|econnreset|connection reset|temporarily unavailable|\b50[234]\b/.test(prose)) {
    return {
      category: 'TIMEOUT',
      message: 'The connection to the platform failed or timed out. Retrying usually succeeds.',
      retryable: true,
    };
  }

  if (/unsupported url/.test(prose)) {
    return {
      category: 'FORMAT_UNAVAILABLE',
      message: 'This link is not a supported media page. Open the post or video itself and copy its link.',
      retryable: false,
    };
  }

  let cleanMsg = rawError?.stderr || rawError?.message || String(rawError || '');
  cleanMsg = cleanMsg.replace(/^Command failed:.*?yt-dlp(\.exe)?\s+/is, '');
  const lines = cleanMsg.split(/[\r\n]+/).map((line: string) => line.trim()).filter((line: string) => line.length > 0);
  const errorLine = lines.find((line: string) => line.startsWith('ERROR:')) || lines[0] || 'Failed to process media request.';

  return {
    category: 'UNKNOWN',
    message: errorLine.replace(/^ERROR:\s*/i, '').replace(/;\s*please report this issue on.*$/i, '').slice(0, 400),
    retryable: false,
  };
}
