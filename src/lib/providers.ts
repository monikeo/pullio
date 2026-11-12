import type { ProviderType } from '../types';

/**
 * Hostname suffixes for each supported platform. Matching is done on the parsed
 * hostname (exact match or a subdomain), never on raw substrings, so hosts such
 * as `dropbox.com` or `netflix.com` are not mistaken for `x.com`.
 */
const PROVIDER_HOSTS: ReadonlyArray<readonly [Exclude<ProviderType, 'generic' | 'unknown'>, readonly string[]]> = [
  ['youtube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']],
  ['tiktok', ['tiktok.com']],
  ['douyin', ['douyin.com', 'iesdouyin.com']],
  ['facebook', ['facebook.com', 'fb.watch', 'fb.com']],
  ['instagram', ['instagram.com', 'instagr.am']],
  ['bilibili', ['bilibili.com', 'b23.tv', 'bilibili.tv']],
  ['twitter', ['twitter.com', 'x.com']],
  ['reddit', ['reddit.com', 'redd.it']],
  ['vimeo', ['vimeo.com']],
  ['pinterest', ['pinterest.com', 'pin.it']],
  ['xiaohongshu', ['xiaohongshu.com', 'xhslink.com']],
  ['soundcloud', ['soundcloud.com']],
];

export function hostMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === domain || host.endsWith(`.${domain}`);
}

/** Detect the media platform from a URL by its hostname. Returns `unknown` for unparsable input. */
export function detectProviderFromUrl(rawUrl: string): ProviderType {
  const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!value) return 'unknown';
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname;
  } catch {
    return 'unknown';
  }
  // Pinterest serves many country-code domains (pinterest.co.uk, pinterest.de, …).
  if (/(^|\.)pinterest\.[a-z.]{2,6}$/i.test(hostname)) return 'pinterest';
  for (const [provider, domains] of PROVIDER_HOSTS) {
    if (domains.some((domain) => hostMatches(hostname, domain))) return provider;
  }
  return 'generic';
}

/** Map a yt-dlp extractor key (e.g. `Youtube`, `TikTok`, `BiliBili`) to a provider. */
export function providerFromExtractor(extractor: unknown): ProviderType {
  const key = String(extractor || '').toLowerCase();
  if (!key) return 'generic';
  const table: Array<[string, ProviderType]> = [
    ['youtube', 'youtube'], ['tiktok', 'tiktok'], ['douyin', 'douyin'], ['facebook', 'facebook'],
    ['instagram', 'instagram'], ['bilibili', 'bilibili'], ['twitter', 'twitter'], ['reddit', 'reddit'],
    ['vimeo', 'vimeo'], ['pinterest', 'pinterest'], ['xiaohongshu', 'xiaohongshu'], ['soundcloud', 'soundcloud'],
  ];
  for (const [needle, provider] of table) if (key.includes(needle)) return provider;
  if (key === 'xhs' || key.startsWith('xhs')) return 'xiaohongshu';
  return 'generic';
}
