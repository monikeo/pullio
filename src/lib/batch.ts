import { detectMediaProvider } from './utils';
import type { ProviderType } from '../types';

export interface BatchMediaItem {
  url: string;
  title: string;
  thumbnail: string;
  provider: ProviderType;
}

function looksLikePlaylistUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('list=') || lower.includes('playlist') || lower.includes('album') ||
    lower.includes('showcase/') || lower.includes('channels/') || lower.includes('medialist') ||
    lower.includes('collectiondetail') || lower.includes('seriesdetail') ||
    (lower.includes('pinterest.com') && lower.includes('/boards/')) ||
    (lower.includes('soundcloud.com') && lower.includes('/sets/'));
}

/** Expand recognized playlist links so batch actions queue every item, not only the first one. */
export async function expandBatchUrl(url: string): Promise<BatchMediaItem[]> {
  const provider = detectMediaProvider(url);
  if (!looksLikePlaylistUrl(url)) {
    return [{ url, title: '', thumbnail: '', provider }];
  }

  let response: Response;
  try {
    response = await fetch('/api/analyze', {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('Playlist analysis timed out. Check your connection and retry.');
    }
    throw error;
  }
  const metadata = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(metadata?.error || 'Could not read this playlist.');
  }
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('The extractor returned an invalid playlist response. Please retry.');
  }

  if (!metadata.isPlaylist) {
    return [{ url: metadata.url || url, title: metadata.title || '', thumbnail: metadata.thumbnail || '', provider: metadata.provider || provider }];
  }

  const items = Array.isArray(metadata.playlistItems) ? metadata.playlistItems : [];
  if (items.length === 0) {
    throw new Error('This playlist did not return any downloadable items.');
  }

  return items
    .filter((item: any) => typeof item?.url === 'string' && /^https?:\/\//i.test(item.url))
    .map((item: any) => ({
      url: item.url,
      title: typeof item.title === 'string' ? item.title : '',
      thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail : '',
      provider: metadata.provider || provider,
    }));
}
