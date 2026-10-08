export type ProviderType = 'youtube' | 'tiktok' | 'douyin' | 'facebook' | 'instagram' | 'bilibili' | 'twitter' | 'reddit' | 'vimeo' | 'pinterest' | 'xiaohongshu' | 'soundcloud' | 'generic' | 'unknown';

export interface Formats {
  itag: number | string;
  quality: string;
  type: 'video' | 'audio' | 'video-only';
  fps?: number;
  width?: number;
  height?: number;
  vcodec?: string;
  acodec?: string;
  bitrate?: number;
  filesize?: number | string;
  ext?: string;
  sourceExt?: string;
}

export interface SubtitleTrack {
  lang: string;
  name: string;
  url?: string;
}

export interface PlaylistItem {
  id: string;
  title: string;
  thumbnail: string;
  duration: number;
  url: string;
  filesize?: number;
}

export interface VideoMetadata {
  provider: ProviderType;
  url: string;
  title: string;
  thumbnail: string;
  author: string;
  duration: number;
  formats: Formats[];
  subtitles?: SubtitleTrack[];
  isPlaylist?: boolean;
  playlistItems?: PlaylistItem[];
}

export interface DownloadState {
  jobId: string;
  isDownloading: boolean;
  progress: number;
  speed: string;
  eta: string;
  status: 'queued' | 'paused' | 'downloading' | 'completed' | 'failed';
  queuePosition?: number;
  error?: string;
  downloadUrl?: string;
  fileSize?: string;
  bytesDownloaded?: string;
  format?: string;
  formatSelector?: string;
  title?: string;
  thumbnail?: string;
  type?: 'video' | 'audio';
  url?: string;
  provider?: ProviderType;
}

export interface DownloadHistoryItem {
  id: string;
  jobId: string;
  url: string;
  title: string;
  thumbnail: string;
  provider: ProviderType;
  format: string;
  type: 'video' | 'audio';
  fileSize: string;
  timestamp: number;
  downloadUrl: string;
}

export interface UserPreferences {
  defaultFormat: 'best' | '1080p' | '720p' | 'audio-320' | 'audio-128';
  defaultContainer: 'mp4' | 'mkv' | 'webm' | 'mp3';
  maxConcurrentDownloads: 1 | 2 | 3 | 4;
  filenameTemplate: string;
  autoAnalyzeOnPaste: boolean;
  notifyOnComplete: boolean;
}

export type TargetVideoFormat = 'mp4' | 'mkv' | 'webm' | 'mov' | 'avi' | 'flv' | 'wmv' | 'gif';
export type TargetAudioFormat = 'mp3' | 'wav' | 'flac' | 'aac' | 'm4a' | 'ogg' | 'opus';
export type TargetMediaFormat = TargetVideoFormat | TargetAudioFormat;

export interface ConversionOptions {
  targetFormat: TargetMediaFormat;
  qualityPreset?: string;
  audioBitrate?: string;
  videoResolution?: string;
}

export interface ConversionItem {
  id: string;
  file?: File;
  uploadId?: string;
  fileName: string;
  fileSize: number;
  fileSizeFormatted: string;
  sourceExt: string;
  mediaType: 'video' | 'audio' | 'unknown';
  options: ConversionOptions;
  status: 'idle' | 'uploading' | 'queued' | 'converting' | 'completed' | 'failed';
  uploadProgress: number;
  convertProgress: number;
  speed?: string;
  eta?: string;
  error?: string;
  convertedFileName?: string;
  convertedFileSize?: string;
  downloadUrl?: string;
  duration?: number;
}
