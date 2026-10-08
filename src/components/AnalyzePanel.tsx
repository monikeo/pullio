import React, { useState, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { formatDuration, cn, canEmbed } from '../lib/utils';
import { 
  Download, MonitorPlay, Music, AlertCircle, ListVideo, Layers, Play, Eye, 
  Sparkles, SlidersHorizontal, Image, Subtitles, Search, CheckSquare, Square, 
  ArrowLeftRight, FileVideo, ShieldCheck, Zap
} from 'lucide-react';
import { motion } from 'motion/react';
import VideoPreviewModal from './VideoPreviewModal';
import type { Formats } from '../types';
import { getMediaErrorGuidance } from '../lib/mediaErrors';

function formatFileSize(value?: number | string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const bytes = Number(text);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return /\b(?:bytes?|kb|kib|mb|mib|gb|gib)\b/i.test(text) ? text : null;
  }
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function conciseQuality(quality: string): string {
  return quality.replace(/\s*·\s*(?:audio included|merge best audio|video only)$/i, '');
}

function formatHeight(format: Formats): number {
  if (format.height) return format.height;
  return Number(format.quality.match(/(?:^|\D)(\d{3,4})p\b/i)?.[1] || 0);
}

function videoOutputContainer(format: Formats, preferredContainer: string): string {
  if (['mp4', 'mkv', 'webm'].includes(preferredContainer)) return preferredContainer;
  const sourceContainer = String(format.ext || '').toLowerCase();
  return ['mp4', 'mkv', 'webm'].includes(sourceContainer) ? sourceContainer : 'mkv';
}

const PROVIDER_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  douyin: 'Douyin 抖音',
  facebook: 'Facebook',
  instagram: 'Instagram',
  bilibili: 'Bilibili 哔哩哔哩',
  twitter: 'X (Twitter)',
  reddit: 'Reddit',
  vimeo: 'Vimeo',
  pinterest: 'Pinterest',
  xiaohongshu: 'XiaoHongShu 小红书',
  soundcloud: 'SoundCloud',
  generic: 'Universal Web',
  unknown: 'Universal Media'
};

function formatProviderName(p: string): string {
  return PROVIDER_NAMES[p.toLowerCase()] || p.toUpperCase();
}

export default function AnalyzePanel() {
  const { metadata, startRealtimeDownload, preferences } = useAppStore();
  const [mode, setMode] = useState<'smart' | 'advanced'>('smart');
  const [selectedItag, setSelectedItag] = useState<string | number | null>(null);
  const [playlistDownloadType, setPlaylistDownloadType] = useState<'video' | 'audio'>('video');
  const [isQueueing, setIsQueueing] = useState(false);
  const [isQueueingPlaylist, setIsQueueingPlaylist] = useState(false);
  const [playlistQueueProgress, setPlaylistQueueProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [selectedTracks, setSelectedTracks] = useState<Record<string, boolean>>({});
  const [playlistQuality, setPlaylistQuality] = useState<string>('best');
  const [playlistAudioQuality, setPlaylistAudioQuality] = useState<string>('audio-320');
  const [playlistSearch, setPlaylistSearch] = useState('');
  const [selectedSubtitle, setSelectedSubtitle] = useState<string>('');

  // Automatically select all playlist tracks when metadata loads
  React.useEffect(() => {
    if (metadata && metadata.isPlaylist && metadata.playlistItems) {
      const defaultState: Record<string, boolean> = {};
      metadata.playlistItems.forEach(item => {
        defaultState[item.id] = true;
      });
      setSelectedTracks(defaultState);
    }

    // Apply default format preference
    if (metadata && !metadata.isPlaylist && metadata.formats?.length > 0) {
      const pref = preferences?.defaultFormat;
      if (pref) {
        const found = metadata.formats.find(f => String(f.itag).includes(pref));
        if (found) {
          setSelectedItag(found.itag);
        } else {
          // Default to first video or best
          setSelectedItag(metadata.formats[0].itag);
        }
      } else {
        setSelectedItag(metadata.formats[0].itag);
      }
    }
  }, [metadata, preferences]);

  // Filtered playlist items based on search query
  const filteredPlaylistItems = useMemo(() => {
    if (!metadata?.playlistItems) return [];
    if (!playlistSearch.trim()) return metadata.playlistItems;
    const q = playlistSearch.toLowerCase();
    return metadata.playlistItems.filter(item => item.title.toLowerCase().includes(q));
  }, [metadata?.playlistItems, playlistSearch]);

  const selectedPlaylistItems = useMemo(
    () => metadata?.playlistItems?.filter(item => selectedTracks[item.id]) || [],
    [metadata?.playlistItems, selectedTracks]
  );
  const selectedPlaylistDuration = selectedPlaylistItems.reduce((total, item) => total + (Number(item.duration) || 0), 0);
  const selectedPlaylistSize = useMemo(() => {
    const knownSizes = selectedPlaylistItems
      .map(item => Number(item.filesize))
      .filter(size => Number.isFinite(size) && size > 0);
    return {
      knownBytes: knownSizes.reduce((total, size) => total + size, 0),
      knownCount: knownSizes.length,
      unknownCount: selectedPlaylistItems.length - knownSizes.length,
    };
  }, [selectedPlaylistItems]);

  if (!metadata) return null;

  const toggleTrack = (trackId: string) => {
    setSelectedTracks(prev => ({
      ...prev,
      [trackId]: !prev[trackId]
    }));
  };

  const selectAllTracks = () => {
    if (!metadata.playlistItems) return;
    const nextState: Record<string, boolean> = {};
    metadata.playlistItems.forEach(item => {
      nextState[item.id] = true;
    });
    setSelectedTracks(nextState);
  };

  const unselectAllTracks = () => {
    if (!metadata.playlistItems) return;
    const nextState: Record<string, boolean> = {};
    metadata.playlistItems.forEach(item => {
      nextState[item.id] = false;
    });
    setSelectedTracks(nextState);
  };

  const invertTrackSelection = () => {
    if (!metadata.playlistItems) return;
    const nextState: Record<string, boolean> = {};
    metadata.playlistItems.forEach(item => {
      nextState[item.id] = !selectedTracks[item.id];
    });
    setSelectedTracks(nextState);
  };

  const handleDownload = async (customUrl?: string, customTitle?: string, customThumbnail?: string, customType?: 'video' | 'audio', formatOverride?: string | number) => {
    const chosenItag = formatOverride ?? selectedItag;
    const selectedFormat = metadata.formats.find(format => format.itag === chosenItag);
    const firstVideoFormat = metadata.formats.find(format => format.type === 'video');
    const firstAudioFormat = metadata.formats.find(format => format.type === 'audio');
    let targetItag = chosenItag || (playlistDownloadType === 'video' ? 'best' : 'audio-320');
    if (customType === 'audio' && selectedFormat?.type !== 'audio') {
      targetItag = firstAudioFormat?.itag || 'audio-320';
    } else if (customType === 'video' && selectedFormat?.type === 'audio') {
      targetItag = firstVideoFormat?.itag || 'best';
    }
    const targetUrl = customUrl || metadata.url;
    const targetTitle = customTitle || metadata.title;
    const targetThumbnail = customThumbnail || metadata.thumbnail;
    const isAudio = customType === 'audio' || (customType !== 'video' && selectedFormat?.type === 'audio') ||
      String(targetItag).toLowerCase().startsWith('yt:audio:') || String(targetItag).toLowerCase().startsWith('audio');
    const isOriginalAudio = String(targetItag).toLowerCase().startsWith('yt:audio-source:');
    const preferredContainer = preferences?.defaultContainer;
    const sourceContainer = String(selectedFormat?.ext || '').toLowerCase();
    const targetContainer = isAudio
      ? (isOriginalAudio ? undefined : 'mp3')
      : ['mp4', 'mkv', 'webm'].includes(preferredContainer || '')
        ? preferredContainer
        : ['mp4', 'mkv', 'webm'].includes(sourceContainer) ? sourceContainer : 'mkv';

    setIsQueueing(true);
    setError(null);

    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        signal: AbortSignal.timeout(45_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          itag: targetItag,
          title: targetTitle,
          thumbnail: targetThumbnail,
          provider: metadata.provider,
          type: isAudio ? 'audio' : 'video',
          targetContainer,
          maxConcurrentDownloads: preferences.maxConcurrentDownloads,
          filenameTemplate: preferences.filenameTemplate,
          filenameQuality: selectedFormat?.quality || (isAudio ? String(targetItag) : 'best'),
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to queue download');
      if (!data || typeof data.jobId !== 'string' || !data.jobId) {
        throw new Error('The download server returned an invalid job response. Please retry.');
      }

      startRealtimeDownload(data.jobId, targetTitle, targetThumbnail, isAudio ? 'audio' : 'video', targetUrl, metadata.provider, data.queuePosition);
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error && err.name === 'TimeoutError'
        ? 'The server took too long to queue this download. Please retry.'
        : err instanceof Error ? err.message : 'Error queueing job');
    } finally {
      setIsQueueing(false);
    }
  };

  const handleBatchDownload = async () => {
    if (!metadata.playlistItems) return;
    const tracksToDownload = metadata.playlistItems.filter(item => selectedTracks[item.id]);
    if (tracksToDownload.length === 0) {
      setError("Please select at least one track to download.");
      return;
    }

    const targetItag = playlistDownloadType === 'video' ? playlistQuality : playlistAudioQuality;
    const isAudio = playlistDownloadType === 'audio';
    const playlistVideoContainer = ['mp4', 'mkv', 'webm'].includes(preferences?.defaultContainer || '')
      ? preferences.defaultContainer
      : 'mkv';
    setError(null);
    setIsQueueing(true);
    setIsQueueingPlaylist(true);
    setPlaylistQueueProgress({ completed: 0, total: tracksToDownload.length });
    const failedTracks: string[] = [];
    let queuedCount = 0;

    try {
      for (const [index, track] of tracksToDownload.entries()) {
        try {
          const res = await fetch('/api/queue', {
            method: 'POST',
            signal: AbortSignal.timeout(45_000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: track.url,
              itag: targetItag,
              title: track.title,
              thumbnail: track.thumbnail,
              provider: metadata.provider,
              type: isAudio ? 'audio' : 'video',
              targetContainer: isAudio ? 'mp3' : playlistVideoContainer,
              maxConcurrentDownloads: preferences.maxConcurrentDownloads,
              filenameTemplate: preferences.filenameTemplate,
              filenameQuality: isAudio ? String(targetItag) : String(playlistQuality),
            }),
          });

          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error || `Failed to queue ${track.title}`);
          if (typeof data?.jobId !== 'string' || !data.jobId) throw new Error(`The server did not confirm ${track.title}`);

          startRealtimeDownload(data.jobId, track.title, track.thumbnail, isAudio ? 'audio' : 'video', track.url, metadata.provider, data.queuePosition);
          queuedCount++;
        } catch (err: any) {
          console.error(`Playlist item queue failed for ${track.title}:`, err);
          failedTracks.push(track.title);
        } finally {
          setPlaylistQueueProgress({ completed: index + 1, total: tracksToDownload.length });
        }
      }
      if (failedTracks.length > 0) {
        setError(`Queued ${queuedCount}/${tracksToDownload.length}. ${failedTracks.length} item${failedTracks.length === 1 ? '' : 's'} could not be queued: ${failedTracks.slice(0, 3).join(', ')}${failedTracks.length > 3 ? '…' : ''}`);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Error queueing playlist items');
    } finally {
      setIsQueueingPlaylist(false);
      setIsQueueing(false);
    }
  };

  const videoFormats = metadata.formats.filter(f => f.type === 'video');
  const videoOnlyFormats = metadata.formats.filter(f => f.type === 'video-only');
  const audioFormats = metadata.formats.filter(f => f.type === 'audio');
  const bestVideoFormat = videoFormats[0];
  const smallerVideoFormat = videoFormats.find(format => formatHeight(format) > 0 && formatHeight(format) <= 720)
    || videoFormats[videoFormats.length - 1];
  const bestAudioFormat = metadata.formats.find(format => format.itag === 'audio-320') || audioFormats[0];

  return (
    <>
    <motion.div 
      initial={{ opacity: 0, y: 20 }} 
      animate={{ opacity: 1, y: 0 }} 
      exit={{ opacity: 0, y: -20 }} 
      className="glass-panel p-4 sm:p-6 md:p-7 w-full max-w-4xl mx-auto mt-6 relative overflow-hidden"
    >
      <div 
        className="absolute top-0 right-0 w-32 h-32 bg-[var(--accent)]/5 blur-3xl pointer-events-none rounded-full transition-all duration-1000 transform-gpu"
        style={{ boxShadow: `0 0 80px 20px rgba(var(--accent-rgb), 0.08)` }}
      ></div>

      {metadata.isPlaylist ? (
        /* ─── PLAYLIST INTERFACE ────────────────────────────────────────────── */
        <div className="flex flex-col md:flex-row gap-5 sm:gap-6 w-full">
          {/* Left Playlist Summary Card */}
          <div className="md:w-5/12 lg:w-1/3 shrink-0 flex flex-col justify-between">
            <div>
              <div className="relative rounded-[10px] overflow-hidden aspect-video bg-black/40 border border-white/5 group mb-4">
                {metadata.thumbnail ? (
                  <img src={metadata.thumbnail} alt={metadata.title} className="w-full h-full object-cover opacity-75 group-hover:scale-105 transition-transform duration-700" />
                ) : (
                  <div className="flex items-center justify-center w-full h-full text-neutral-500">
                    <AlertCircle className="size-8 opacity-50" />
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="size-12 bg-black/60 rounded-full flex items-center justify-center shadow-lg border border-white/10 backdrop-blur-sm">
                    <ListVideo className="size-5 text-[var(--accent)] transition-colors duration-700" />
                  </div>
                </div>
                <div className="absolute bottom-2 right-2 bg-black/80 px-2 py-0.5 rounded-[4px] text-[10px] font-bold tracking-wider font-mono flex items-center gap-1 border border-white/10">
                  <Layers className="size-3 text-[var(--accent)]" /> {metadata.playlistItems?.length || 0} TRACKS
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2 text-xs text-[var(--accent)] font-bold uppercase tracking-widest mb-1.5 transition-colors duration-700">
                  <ListVideo className="size-3.5" />
                  <span>{formatProviderName(metadata.provider)} Playlist</span>
                </div>
                <h3 className="text-base sm:text-lg font-bold leading-snug line-clamp-2 text-white" title={metadata.title}>{metadata.title}</h3>
                <p className="text-gray-400 text-xs sm:text-sm mt-1">{metadata.author}</p>
                <div className="mt-3 p-3 rounded-[8px] bg-white/5 border border-white/5 space-y-1">
                  <p className="text-[11px] text-neutral-200 font-semibold">
                    Review: {selectedPlaylistItems.length} of {metadata.playlistItems?.length || 0} items · {formatDuration(selectedPlaylistDuration)} total
                  </p>
                  <p className="text-[10px] text-gray-400">
                    Estimated source size: {selectedPlaylistSize.knownCount > 0
                      ? `~${formatFileSize(selectedPlaylistSize.knownBytes) || 'unknown'} known${selectedPlaylistSize.unknownCount > 0 ? ` · ${selectedPlaylistSize.unknownCount} item${selectedPlaylistSize.unknownCount === 1 ? '' : 's'} without an estimate` : ''}`
                      : 'unavailable from playlist metadata'}
                  </p>
                  <p className="text-[9px] text-gray-500 leading-relaxed">Review the track list and unselect anything you do not want. Source estimates can differ from the selected output quality.</p>
                </div>
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-white/5 flex flex-col gap-3.5">
              <div>
                <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider">Target Format</span>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button 
                    onClick={() => setPlaylistDownloadType('video')}
                    className={cn(
                      "py-2 text-xs font-bold border transition-all flex items-center justify-center gap-1.5 rounded-[8px] cursor-pointer",
                      playlistDownloadType === 'video' 
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]" 
                        : "border-white/5 bg-white/5 text-neutral-400 hover:text-white"
                    )}
                  >
                    <MonitorPlay className="size-3.5" /> Video · best quality
                  </button>
                  <button 
                    onClick={() => setPlaylistDownloadType('audio')}
                    className={cn(
                      "py-2 text-xs font-bold border transition-all flex items-center justify-center gap-1.5 rounded-[8px] cursor-pointer",
                      playlistDownloadType === 'audio' 
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]" 
                        : "border-white/5 bg-white/5 text-neutral-400 hover:text-white"
                    )}
                  >
                    <Music className="size-3.5" /> Audio MP3
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider">
                  {playlistDownloadType === 'video' ? 'Select Resolution' : 'Bitrate Quality'}
                </span>
                {playlistDownloadType === 'video' ? (
                  <select 
                    value={playlistQuality}
                    onChange={(e) => setPlaylistQuality(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-[8px] px-3 py-2 text-xs font-bold text-neutral-200 outline-none focus:border-[var(--accent)] cursor-pointer"
                  >
                    <option value="best">Best available · full resolution</option>
                    <option value="4320p">Up to 4320p · 8K</option>
                    <option value="2160p">Up to 2160p · 4K</option>
                    <option value="1440p">Up to 1440p · QHD</option>
                    <option value="1080p">1080p Full HD</option>
                    <option value="720p">720p HD</option>
                    <option value="480p">480p SD</option>
                    <option value="360p">360p SD</option>
                  </select>
                ) : (
                  <select 
                    value={playlistAudioQuality}
                    onChange={(e) => setPlaylistAudioQuality(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-[8px] px-3 py-2 text-xs font-bold text-neutral-200 outline-none focus:border-[var(--accent)] cursor-pointer"
                  >
                    <option value="audio-320">MP3 · 320 kbps target</option>
                    <option value="audio-256">MP3 · 256 kbps target</option>
                    <option value="audio-128">MP3 · 128 kbps target</option>
                  </select>
                )}
              </div>

              {/* Side Selection Buttons */}
              <div className="flex gap-2">
                <button 
                  onClick={selectAllTracks}
                  className="flex-1 py-2 rounded-[8px] bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-neutral-300 hover:text-white transition-colors cursor-pointer"
                >
                  Select All ({metadata.playlistItems?.length || 0})
                </button>
                <button 
                  onClick={unselectAllTracks}
                  className="flex-1 py-2 rounded-[8px] bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-neutral-300 hover:text-white transition-colors cursor-pointer"
                >
                  Clear All
                </button>
              </div>

              <button 
                onClick={handleBatchDownload}
                disabled={isQueueing || !metadata.playlistItems?.some(item => selectedTracks[item.id])}
                className="w-full py-3.5 rounded-[8px] bg-[var(--accent)] text-[var(--accent-text)] font-bold text-xs uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 flex items-center justify-center gap-2 cursor-pointer btn-accent shadow-md"
              >
                <Download className="size-4 text-[var(--accent-text)]" />
                {isQueueingPlaylist ? `Queueing ${playlistQueueProgress.completed}/${playlistQueueProgress.total}...` : `Queue Selected (${metadata.playlistItems?.filter(item => selectedTracks[item.id]).length || 0} of ${metadata.playlistItems?.length || 0})`}
              </button>
              {isQueueingPlaylist && (
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden" role="progressbar" aria-label="Queueing playlist downloads" aria-valuemin={0} aria-valuemax={playlistQueueProgress.total} aria-valuenow={playlistQueueProgress.completed}>
                  <motion.div
                    className="h-full bg-[var(--accent)] rounded-full"
                    animate={{ width: `${playlistQueueProgress.total ? (playlistQueueProgress.completed / playlistQueueProgress.total) * 100 : 0}%` }}
                    transition={{ duration: 0.2 }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Right Playlist Tracks Table */}
          <div className="flex-1 flex flex-col border-t md:border-t-0 md:border-l border-white/10 md:pl-6 pt-6 md:pt-0">
            {/* Sticky Header with Controls */}
            <div className="sticky top-0 z-10 bg-black/80 backdrop-blur-md pb-3 border-b border-white/5 mb-3 flex flex-col gap-2">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="text-xs font-bold uppercase tracking-widest text-gray-400 flex items-center gap-2">
                    <Layers className="size-4 text-[var(--accent)]" /> Tracks
                  </h4>
                  <span className="text-[10px] font-mono font-bold bg-[var(--accent)]/15 text-[var(--accent)] px-2 py-0.5 rounded-full border border-[var(--accent)]/20">
                    {metadata.playlistItems?.filter(item => selectedTracks[item.id]).length || 0} of {metadata.playlistItems?.length || 0} selected
                  </span>
                </div>
                
                {metadata.playlistItems && metadata.playlistItems.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button 
                      onClick={selectAllTracks}
                      className="px-2.5 py-1.5 bg-[var(--accent)]/15 border border-[var(--accent)]/30 rounded-[6px] text-[10px] font-bold uppercase tracking-wider text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--accent-text)] transition-all cursor-pointer shadow-sm"
                    >
                      ✓ Select All
                    </button>
                    <button 
                      onClick={unselectAllTracks}
                      className="px-2.5 py-1.5 bg-white/5 border border-white/10 rounded-[6px] text-[10px] font-bold uppercase tracking-wider text-neutral-300 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
                    >
                      ✕ Unselect All
                    </button>
                    <button 
                      onClick={invertTrackSelection}
                      className="px-2.5 py-1.5 bg-white/5 border border-white/10 rounded-[6px] text-[10px] font-bold uppercase tracking-wider text-neutral-300 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
                      title="Invert Selection"
                    >
                      ⇄ Invert
                    </button>
                  </div>
                )}
              </div>

              {/* Filter Search */}
              <div className="relative">
                <Search className="size-3.5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filter tracks by keyword..."
                  value={playlistSearch}
                  onChange={(e) => setPlaylistSearch(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-[6px] pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-gray-500 outline-none focus:border-[var(--accent)]/50"
                />
              </div>
            </div>
            
            <div className="flex flex-col gap-2 overflow-y-auto max-h-[420px] pr-1 sm:pr-2">
              {filteredPlaylistItems.map((track, i) => {
                const trackFormat = playlistDownloadType === 'video' ? playlistQuality : (playlistAudioQuality === 'audio-320' ? '320kbps' : playlistAudioQuality === 'audio-256' ? '256kbps' : '128kbps');
                const trackExt = playlistDownloadType === 'video' ? 'video' : 'MP3';

                return (
                  <div 
                    key={track.id} 
                    className={cn(
                      "p-2.5 sm:p-3 bg-white/5 border rounded-[10px] flex items-center justify-between gap-2.5 sm:gap-3 hover:bg-white/[0.08] transition-all cursor-pointer",
                      selectedTracks[track.id] ? "border-[var(--accent)]/30 bg-white/[0.07]" : "border-white/5"
                    )}
                    onClick={() => toggleTrack(track.id)}
                  >
                    <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                      <input 
                        type="checkbox"
                        checked={!!selectedTracks[track.id]}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleTrack(track.id);
                        }}
                        className="size-4 rounded border-white/10 bg-white/5 text-[var(--accent)] focus:ring-[var(--accent)] cursor-pointer accent-[var(--accent)] shrink-0"
                      />
                      <div className="size-5 rounded-full bg-white/10 flex items-center justify-center text-[9px] font-mono font-bold text-gray-400 shrink-0">
                        {i + 1}
                      </div>
                      <div className="size-11 sm:size-12 rounded-[6px] overflow-hidden bg-black shrink-0 relative border border-white/5">
                        <img src={track.thumbnail} alt={track.title} className="w-full h-full object-cover opacity-80" />
                        <div className="absolute bottom-0.5 right-0.5 bg-black/90 px-1 py-0.2 rounded text-[7px] font-mono text-gray-400">
                          {formatDuration(track.duration)}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                        <h5 className="font-bold text-xs sm:text-sm text-white truncate pr-1" title={track.title}>{track.title}</h5>
                        <span className="text-[9px] uppercase font-mono text-neutral-400 font-bold tracking-wider block truncate">
                          {playlistDownloadType === 'video' ? 'Video' : 'Audio'} · {trackFormat} {trackExt}
                        </span>
                        <span className="text-[9px] font-mono text-gray-500 block truncate">
                          {track.filesize ? `Source estimate · ${formatFileSize(track.filesize)}` : 'Source size estimate unavailable'}
                        </span>
                      </div>
                    </div>

                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(track.url, track.title, track.thumbnail, playlistDownloadType);
                      }}
                      disabled={isQueueing}
                      className="size-8 rounded-[8px] bg-[var(--accent)] flex items-center justify-center shrink-0 btn-accent transition-all cursor-pointer disabled:opacity-50"
                      title="Download this track"
                    >
                      <Download className="size-3.5 text-[var(--accent-text)]" />
                    </button>
                  </div>
                );
              })}
            </div>

            {error && (
              <div className="mt-3 p-3 bg-red-950/40 border border-red-500/20 text-red-400 text-xs rounded-[10px] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>{error}</span>
                </div>
                <button 
                  onClick={() => setError(null)} 
                  className="text-gray-400 hover:text-white text-xs px-2 py-0.5 rounded cursor-pointer"
                  title="Dismiss error"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ─── SINGLE MEDIA INTERFACE ────────────────────────────────────────── */
        <>
          <div className="flex flex-col md:flex-row gap-5 sm:gap-6 w-full">
            {/* Left Media Thumbnail / Info Card */}
            <div className="md:w-5/12 lg:w-1/3 shrink-0">
              <button
                onClick={() => setShowPreview(true)}
                className="relative rounded-[10px] overflow-hidden aspect-video bg-black/40 border border-white/10 group w-full block cursor-pointer transition-all duration-300 hover:border-[var(--accent)]/40 shadow-lg"
                title="Click to preview"
              >
                {metadata.thumbnail ? (
                  <img
                    src={metadata.thumbnail}
                    alt={metadata.title}
                    className="w-full h-full object-cover opacity-70 group-hover:opacity-90 group-hover:scale-105 transition-all duration-700"
                  />
                ) : (
                  <div className="flex items-center justify-center w-full h-full text-neutral-500">
                    <AlertCircle className="size-8 opacity-50" />
                  </div>
                )}

                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="size-12 rounded-full bg-[var(--accent)]/90 flex items-center justify-center shadow-2xl">
                      <Play className="size-5 text-[var(--accent-text)] ml-0.5" />
                    </div>
                    <span className="text-white text-[9px] font-bold uppercase tracking-widest bg-black/60 px-2.5 py-0.5 rounded-full backdrop-blur-sm">
                      {canEmbed(metadata.provider) ? 'Play Preview' : 'View Info'}
                    </span>
                  </div>
                </div>

                <div className="absolute bottom-2 right-2 bg-black/80 px-2 py-0.5 rounded-[4px] text-[10px] font-bold font-mono tracking-wider border border-white/5">
                  {formatDuration(metadata.duration)}
                </div>

                <div className="absolute top-2 left-2">
                  {canEmbed(metadata.provider) ? (
                    <div className="flex items-center gap-1 bg-green-500/20 border border-green-500/30 px-1.5 py-0.5 rounded-[4px]">
                      <Play className="size-2.5 text-green-400" />
                      <span className="text-[8px] font-bold uppercase tracking-wider text-green-400">Live Preview</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 bg-orange-500/20 border border-orange-500/30 px-1.5 py-0.5 rounded-[4px]">
                      <Eye className="size-2.5 text-orange-400" />
                      <span className="text-[8px] font-bold uppercase tracking-wider text-orange-400">Direct Link</span>
                    </div>
                  )}
                </div>
              </button>

              {/* Auxiliary Quick Actions below thumbnail */}
              <div className="mt-3.5 flex flex-col gap-2">
                {/* Download High-Res Thumbnail */}
                {metadata.thumbnail && (
                  <a
                    href={`/api/thumbnail?url=${encodeURIComponent(metadata.thumbnail)}&title=${encodeURIComponent(metadata.title)}`}
                    download
                    className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-[8px] bg-white/5 hover:bg-white/10 border border-white/5 text-[10px] font-bold uppercase tracking-wider text-gray-300 hover:text-white transition-all cursor-pointer"
                  >
                    <Image className="size-3.5 text-[var(--accent)]" /> Download HD Thumbnail
                  </a>
                )}
                
                <button
                  onClick={() => setShowPreview(true)}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-[8px] bg-white/5 hover:bg-white/10 border border-white/5 text-[10px] font-bold uppercase tracking-wider text-gray-300 hover:text-white transition-all cursor-pointer"
                >
                  {canEmbed(metadata.provider) ? <Play className="size-3.5" /> : <Eye className="size-3.5" />}
                  {canEmbed(metadata.provider) ? 'Watch Preview' : 'Open Source'}
                </button>
              </div>
            </div>
            
            {/* Right Options and Formats Area */}
            <div className="flex flex-col flex-1 gap-3.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-xs text-[var(--accent)] font-bold uppercase tracking-widest mb-1 transition-colors duration-700">
                    <MonitorPlay className="size-3.5" />
                    <span>{formatProviderName(metadata.provider)} Detected</span>
                  </div>
                  <h3 className="text-base sm:text-lg font-bold leading-snug line-clamp-2 text-white" title={metadata.title}>{metadata.title}</h3>
                  <p className="text-gray-400 text-xs mt-0.5">{metadata.author}</p>
                </div>

                {/* Mode Selector Pill */}
                <div className="flex items-center bg-black/60 p-1 rounded-[8px] border border-white/10 shrink-0 self-start sm:self-auto gap-0.5">
                  <button
                    onClick={() => setMode('smart')}
                    className={cn(
                      "px-3 py-1 rounded-[6px] text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5",
                      mode === 'smart' 
                        ? "bg-[var(--accent)] text-[var(--accent-text)] font-bold shadow" 
                        : "text-gray-400 hover:text-white"
                    )}
                  >
                    <Sparkles className="size-3" /> Smart
                  </button>
                  <button
                    onClick={() => setMode('advanced')}
                    className={cn(
                      "px-3 py-1 rounded-[6px] text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5",
                      mode === 'advanced' 
                        ? "bg-[var(--accent)] text-[var(--accent-text)] font-bold shadow" 
                        : "text-gray-400 hover:text-white"
                    )}
                  >
                    <SlidersHorizontal className="size-3" /> Advanced
                  </button>
                </div>
              </div>

              {/* Subtitles Track Bar if available */}
              {metadata.subtitles && metadata.subtitles.length > 0 && (
                <div className="p-3 bg-white/5 border border-white/5 rounded-[8px] flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 text-gray-300">
                    <Subtitles className="size-4 text-[var(--accent)]" />
                    <span className="font-bold text-[11px] uppercase tracking-wide">Subtitles:</span>
                    <span className="text-gray-400 text-[11px]">{metadata.subtitles.length} tracks detected</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedSubtitle}
                      onChange={(e) => setSelectedSubtitle(e.target.value)}
                      className="bg-black/60 border border-white/10 rounded-[6px] px-2 py-1 text-[10px] font-mono text-gray-200 outline-none"
                    >
                      <option value="">Select Language</option>
                      {metadata.subtitles.map(sub => (
                        <option key={sub.lang} value={sub.url || sub.lang}>{sub.name || sub.lang}</option>
                      ))}
                    </select>
                    {selectedSubtitle && (
                      <a
                        href={selectedSubtitle}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded-[6px] text-[10px] font-bold uppercase text-white"
                      >
                        Download
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Formats Grid */}
              <div className="flex flex-col gap-4 flex-1 pt-1">
                {/* Quick presets keep the common choices visible and explicit. */}
                <div className="p-2.5 bg-gradient-to-r from-[var(--accent)]/10 via-purple-500/10 to-indigo-500/10 border border-[var(--accent)]/25 rounded-[10px]">
                  <p className="text-[9px] text-gray-400 font-bold uppercase tracking-widest mb-2">Quick download presets</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      onClick={() => {
                        const itag = bestVideoFormat?.itag || 'best';
                        setSelectedItag(itag);
                        void handleDownload(undefined, undefined, undefined, 'video', itag);
                      }}
                      disabled={isQueueing}
                      className="py-2.5 px-3 bg-[var(--accent)] text-[var(--accent-text)] font-extrabold text-xs rounded-[8px] flex items-center justify-center gap-2 shadow-lg btn-accent hover:opacity-95 transition-all cursor-pointer disabled:opacity-50"
                      title="Download the highest video quality available"
                    >
                      <Zap className="size-4 fill-current shrink-0" />
                      <span className="truncate">Best video · {bestVideoFormat ? conciseQuality(bestVideoFormat.quality) : 'best available'}</span>
                    </button>

                    <button
                      onClick={() => {
                        if (!smallerVideoFormat) return;
                        setSelectedItag(smallerVideoFormat.itag);
                        void handleDownload(undefined, undefined, undefined, 'video', smallerVideoFormat.itag);
                      }}
                      disabled={isQueueing || !smallerVideoFormat}
                      className="py-2.5 px-3 bg-white/10 hover:bg-white/15 text-white font-extrabold text-xs rounded-[8px] border border-white/10 flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                      title="Choose a compact video stream at 720p or the lowest available resolution"
                    >
                      <MonitorPlay className="size-4 text-[var(--accent)] shrink-0" />
                      <span className="truncate">Smaller video · {smallerVideoFormat ? conciseQuality(smallerVideoFormat.quality) : 'unavailable'}</span>
                    </button>

                    <button
                      onClick={() => {
                        const itag = bestAudioFormat?.itag || 'audio';
                        setSelectedItag(itag);
                        void handleDownload(undefined, undefined, undefined, 'audio', itag);
                      }}
                      disabled={isQueueing}
                      className="py-2.5 px-3 bg-white/10 hover:bg-white/15 text-white font-extrabold text-xs rounded-[8px] border border-white/10 flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                      title="Download audio only as MP3 when the encoder target is available"
                    >
                      <Music className="size-4 text-[var(--accent)] shrink-0" />
                      <span className="truncate">Audio only · {bestAudioFormat?.quality || 'best available'}</span>
                    </button>
                  </div>
                  <p className="text-[9px] text-gray-500 mt-2">Presets start the download immediately. Use the format list below to review options first.</p>
                </div>

                {/* 1. Merged Video + Audio (High Quality) */}
                <div>
                   <h4 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-2">
                     <MonitorPlay className="size-4 text-[var(--accent)]" /> 
                     {mode === 'smart' ? 'Best Quality (Video + Audio Merged)' : 'Video Streams with FFmpeg Audio Merge'}
                   </h4>
                   <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {videoFormats.length > 0 ? videoFormats.map(f => (
                        <button 
                          key={f.itag} 
                          onClick={() => setSelectedItag(f.itag)}
                          className={cn(
                            "p-2.5 bg-white/5 rounded-[8px] border flex items-center justify-between transition-all cursor-pointer text-left",
                            selectedItag === f.itag 
                              ? "border-[var(--accent)] shadow-[0_0_12px_rgba(var(--accent-rgb),0.2)] bg-[var(--accent)]/10 text-white" 
                              : "border-white/5 hover:border-white/10 text-neutral-300 hover:text-white"
                          )}
                        >
                          <div className="min-w-0 pr-2">
                             <div className="font-bold text-xs flex items-center gap-1.5 min-w-0">
                               <span className="truncate">{conciseQuality(f.quality)}</span>
                               {f.fps && f.fps >= 50 && (
                                 <span className="text-[9px] bg-red-500/20 text-red-400 px-1 rounded font-mono font-bold">{f.fps}fps</span>
                               )}
                             </div>
                             <span className="text-[9px] text-gray-400 font-mono block truncate">
                               {mode === 'advanced' && f.vcodec ? `${f.vcodec.split('.')[0]} · ` : ''}
                               {formatFileSize(f.filesize) ? `Source ~${formatFileSize(f.filesize)} · ` : 'Source size unavailable · '}
                               {f.quality.toLowerCase().includes('audio included')
                                 ? 'Audio included'
                                 : f.quality.toLowerCase().includes('merge best audio')
                                   ? 'Best audio merged'
                                   : 'Audio added when required'}
                               {' · '}Output {videoOutputContainer(f, preferences?.defaultContainer || 'mkv').toUpperCase()}
                             </span>
                          </div>
                          <div className={cn(
                            "size-3.5 rounded-full border flex items-center justify-center shrink-0",
                            selectedItag === f.itag ? "border-[var(--accent)]" : "border-white/20"
                          )}>
                             {selectedItag === f.itag && <div className="size-2 bg-[var(--accent)] rounded-full"></div>}
                          </div>
                        </button>
                      )) : <span className="text-xs text-neutral-500">None available</span>}
                   </div>
                </div>

                {/* 2. Audio Extraction */}
                <div>
                   <h4 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-2">
                     <Music className="size-4 text-[var(--accent)]" /> Audio streams & MP3 extraction
                   </h4>
                   <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {audioFormats.map(f => (
                        <button 
                          key={f.itag} 
                          onClick={() => setSelectedItag(f.itag)}
                          className={cn(
                            "p-2.5 bg-white/5 rounded-[8px] border flex items-center justify-between transition-all cursor-pointer text-left",
                            selectedItag === f.itag 
                              ? "border-[var(--accent)] shadow-[0_0_12px_rgba(var(--accent-rgb),0.2)] bg-[var(--accent)]/10 text-white" 
                              : "border-white/5 hover:border-white/10 text-neutral-300 hover:text-white"
                          )}
                        >
                          <div className="min-w-0 pr-2">
                             <div className="font-bold text-xs">{f.quality}</div>
                             <span className="text-[9px] text-gray-400 font-mono block truncate">
                                {String(f.itag).startsWith('yt:audio-source:')
                                  ? `${mode === 'advanced' && f.acodec ? `${f.acodec.split('.')[0]} · ` : ''}Original ${String(f.ext || f.sourceExt || 'audio').toUpperCase()}${formatFileSize(f.filesize) ? ` · Source ~${formatFileSize(f.filesize)}` : ''}`
                                  : `${mode === 'advanced' && f.acodec ? `${f.acodec.split('.')[0]} · ` : ''}MP3 output · size calculated after encoding`}
                             </span>
                          </div>
                          <div className={cn(
                            "size-3.5 rounded-full border flex items-center justify-center shrink-0",
                            selectedItag === f.itag ? "border-[var(--accent)]" : "border-white/20"
                          )}>
                             {selectedItag === f.itag && <div className="size-2 bg-[var(--accent)] rounded-full"></div>}
                          </div>
                        </button>
                      ))}
                   </div>
                </div>

                {/* 3. Raw Video Stream (Muted) - Only in Advanced Mode or when relevant */}
                {mode === 'advanced' && videoOnlyFormats.length > 0 && (
                  <div>
                     <h4 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-2">
                       <Layers className="size-4 text-[var(--accent)]" /> Raw Video Track (Muted Stream)
                     </h4>
                     <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {videoOnlyFormats.map(f => (
                          <button 
                            key={f.itag} 
                            onClick={() => setSelectedItag(f.itag)}
                            className={cn(
                              "p-2.5 bg-white/5 rounded-[8px] border flex items-center justify-between transition-all cursor-pointer text-left",
                              selectedItag === f.itag 
                                ? "border-[var(--accent)] shadow-[0_0_12px_rgba(var(--accent-rgb),0.2)] bg-[var(--accent)]/10 text-white" 
                                : "border-white/5 hover:border-white/10 text-neutral-300 hover:text-white"
                            )}
                          >
                            <div className="min-w-0 pr-2">
                               <div className="font-bold text-xs">{f.quality}</div>
                               <span className="text-[9px] text-gray-400 font-mono block truncate">
                                 No audio · {String(f.ext || 'source').toUpperCase()}{formatFileSize(f.filesize) ? ` · Source ~${formatFileSize(f.filesize)}` : ''}
                               </span>
                            </div>
                            <div className={cn(
                              "size-3.5 rounded-full border flex items-center justify-center shrink-0",
                              selectedItag === f.itag ? "border-[var(--accent)]" : "border-white/20"
                            )}>
                               {selectedItag === f.itag && <div className="size-2 bg-[var(--accent)] rounded-full"></div>}
                            </div>
                          </button>
                        ))}
                     </div>
                  </div>
                )}
              </div>

              {error && (
                <div className="p-3 bg-red-950/40 border border-red-500/20 text-red-400 text-xs rounded-[8px] flex items-center justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <AlertCircle className="size-4 shrink-0" />
                    <div className="min-w-0">
                      <p>{error}</p>
                      <p className="text-[10px] text-red-200/70 mt-1 leading-relaxed">{getMediaErrorGuidance(error)}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setError(null)} 
                    className="text-gray-400 hover:text-white text-xs px-2 py-0.5 rounded cursor-pointer"
                    title="Dismiss error"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Submit Download Button */}
              <div className="pt-2 border-t border-white/5">
                <button 
                  onClick={() => handleDownload()} 
                  disabled={!selectedItag || isQueueing} 
                  className="w-full py-3.5 rounded-[8px] flex items-center justify-center gap-2 font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--accent)] text-[var(--accent-text)] hover:opacity-90 uppercase tracking-widest text-xs btn-accent cursor-pointer shadow-lg"
                >
                  <Download className="size-4 text-[var(--accent-text)]" />
                  {isQueueing ? 'Queueing Download...' : selectedItag ? 'Start Download' : 'Select Quality Format'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </motion.div>

    {/* Video Preview Modal */}
    {showPreview && (
      <VideoPreviewModal
        metadata={metadata}
        onClose={() => setShowPreview(false)}
      />
    )}
    </>
  );
}
