export type DownloadStage = 'queued' | 'extracting' | 'video' | 'audio' | 'downloading' | 'merging' | 'converting' | 'finalizing' | 'paused' | 'completed' | 'failed';
export const DOWNLOAD_STAGE_LABELS: Record<DownloadStage, string> = {
  queued: 'Waiting in queue', extracting: 'Reading media details', video: 'Downloading video', audio: 'Downloading audio',
  downloading: 'Downloading media', merging: 'Merging video & audio', converting: 'Converting media', finalizing: 'Preparing file',
  paused: 'Paused', completed: 'Ready to save', failed: 'Download failed',
};

export interface DownloadRecord {
  jobId: string; url: string; itag: string | number; targetContainer?: string; provider: string;
  progress: number; stageProgress?: number; stage: DownloadStage; speed: string; eta: string;
  status: 'queued' | 'paused' | 'downloading' | 'completed' | 'failed'; queuePosition?: number;
  fileSize: string; bytesDownloaded: string; downloadedBytes?: number; totalBytes?: number;
  error?: string; filePath?: string; fileName?: string; mimeType?: string;
  title: string; thumbnail: string; type: 'video' | 'audio'; filenameTemplate: string;
  filenameQuality?: string; outputFileName?: string; retryCount?: number;
  createdAt: number; updatedAt: number; recoveryMessage?: string;
}

export function isDemoMediaUrl(value: string, enabled = false): boolean {
  if (!enabled) return false;
  try {
    const url = new URL(value);
    return value.length <= 8000 && url.origin === 'https://demo.pullio.invalid' && !url.username && !url.password && /^\/(video|audio|playlist)$/.test(url.pathname);
  } catch { return false; }
}

export function canonicalMediaIdentity(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    const id = host === 'youtu.be' ? parts[0] : url.searchParams.get('v') || (['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : '');
    if (id) return `youtube:${id}`;
  }
  if (host === 'bilibili.com') {
    const id = url.pathname.match(/\/video\/((?:BV|av)[A-Za-z0-9]+)/i)?.[1];
    if (id) return `bilibili:${id}:part=${url.searchParams.get('p') || '1'}`;
  }
  if (host === 'tiktok.com' || host === 'douyin.com') {
    const id = url.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1] || (host === 'douyin.com' ? url.searchParams.get('modal_id') : null);
    if (id) return `${host}:${id}`;
  }
  if (['facebook.com', 'web.facebook.com'].includes(host)) {
    const id = url.searchParams.get('v') || url.pathname.match(/\/(?:reel|videos)\/(\d+)/)?.[1];
    if (id) return `facebook:${id}`;
  }
  const knownHost = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'bilibili.com', 'tiktok.com', 'douyin.com', 'facebook.com', 'instagram.com', 'vimeo.com', 'pinterest.com', 'xiaohongshu.com', 'twitter.com', 'x.com', 'soundcloud.com'].includes(host);
  if (knownHost) url.hostname = host;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['fbclid', 'gclid'].includes(key) || knownHost && ['si', 'igsh', 'spm_id_from', 'vd_source', 'share_token'].includes(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function downloadIdentity(job: Pick<DownloadRecord, 'url' | 'type' | 'itag' | 'targetContainer'>): string {
  return JSON.stringify([canonicalMediaIdentity(job.url), job.type, String(job.itag), job.targetContainer || (job.type === 'audio' ? 'mp3' : 'mkv')]);
}

export function publicDownloadRecord(job: DownloadRecord) {
  const { filePath, fileName, ...publicJob } = job;
  return { ...publicJob, downloadUrl: job.status === 'completed' ? `/api/files/${job.jobId}` : undefined };
}

export function decodeDownloadProgress(line: string): { downloaded: number; total: number; speed: number; eta: number; stage: DownloadStage; finished: boolean } | null {
  const marker = '__PULLIO_PROGRESS__';
  const start = line.indexOf(marker);
  if (start < 0) return null;
  try {
    const raw = JSON.parse(line.slice(start + marker.length));
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    return {
      downloaded: number(raw.downloaded), total: number(raw.total) || number(raw.estimate), speed: number(raw.speed), eta: number(raw.eta),
      stage: raw.video && raw.video !== 'none' && raw.video !== 'NA' ? (raw.audio && raw.audio !== 'none' && raw.audio !== 'NA' ? 'downloading' : 'video') : 'audio',
      finished: raw.status === 'finished',
    };
  } catch { return null; }
}

export function postprocessStage(line: string): DownloadStage | null {
  if (/\[Merger\]|\bFFmpegMerger\b|"postprocessor"\s*:\s*"Merger"/.test(line)) return 'merging';
  if (/\[(ExtractAudio|VideoConvertor|VideoRemuxer)\]|"postprocessor"\s*:\s*"(?:FFmpeg)?(?:ExtractAudio|VideoConvertor|VideoRemuxer)"/.test(line)) return 'converting';
  if (/__PULLIO_POST__|\[MoveFiles\]/.test(line)) return 'finalizing';
  return null;
}
