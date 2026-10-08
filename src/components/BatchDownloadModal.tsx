import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Layers, Download, X, Plus, Trash2, Clipboard, MonitorPlay, Music, AlertCircle, CheckCircle2, Sparkles, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { ProviderType } from '../types';
import { cn, detectMediaProvider } from '../lib/utils';
import { expandBatchUrl } from '../lib/batch';

interface BatchDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialUrls?: string[];
}

const EMPTY_URLS: string[] = [];

export default function BatchDownloadModal({ isOpen, onClose, initialUrls = EMPTY_URLS }: BatchDownloadModalProps) {
  const { startRealtimeDownload, setActiveTab, preferences } = useAppStore();
  const [rawText, setRawText] = useState(initialUrls.join('\n'));
  const [formatType, setFormatType] = useState<'video' | 'audio'>('video');
  const [videoQuality, setVideoQuality] = useState('best');
  const [audioQuality, setAudioQuality] = useState('audio-320');
  const [container, setContainer] = useState('mp4');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueProgress, setQueueProgress] = useState({ completed: 0, total: 0 });

  // Reset the editor on every open, including when the new batch is empty.
  React.useEffect(() => {
    if (isOpen) {
      setRawText(initialUrls.join('\n'));
      setError(null);
      setQueueProgress({ completed: 0, total: 0 });
    }
  }, [isOpen, initialUrls]);

  const detectProvider = (url: string): ProviderType => {
    return detectMediaProvider(url);
  };

  // Extract valid URLs from raw textarea text
  const parsedUrls = React.useMemo(() => {
    return rawText
      .split(/[\r\n\s]+/)
      .map(s => s.trim())
      .filter(s => s.startsWith('http://') || s.startsWith('https://'));
  }, [rawText]);

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const existing = rawText.trim();
      setRawText(existing ? `${existing}\n${text.trim()}` : text.trim());
    } catch (err) {
      console.warn('Clipboard read error:', err);
    }
  };

  const handleRemoveUrl = (indexToRemove: number) => {
    const updated = parsedUrls.filter((_, idx) => idx !== indexToRemove);
    setRawText(updated.join('\n'));
  };

  const handleQueueBatch = async () => {
    if (parsedUrls.length === 0) {
      setError('Please add at least one valid video URL.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setQueueProgress({ completed: 0, total: parsedUrls.length });

    const targetItag = formatType === 'video' ? videoQuality : audioQuality;
    const isAudio = formatType === 'audio';

    let queuedCount = 0;
    const failedUrls: string[] = [];

    try {
      for (const [index, itemUrl] of parsedUrls.entries()) {
        let mediaItems;
        try {
          mediaItems = await expandBatchUrl(itemUrl);
        } catch (err) {
          console.warn('Batch link could not be expanded:', err);
          failedUrls.push(itemUrl);
          setQueueProgress({ completed: index + 1, total: parsedUrls.length });
          continue;
        }

        for (const mediaItem of mediaItems) {
          try {
            const res = await fetch('/api/queue', {
              method: 'POST',
              signal: AbortSignal.timeout(45_000),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: mediaItem.url,
                itag: targetItag,
                title: mediaItem.title || `Batch ${mediaItem.provider.toUpperCase()} Item`,
                thumbnail: mediaItem.thumbnail,
                provider: mediaItem.provider,
                type: isAudio ? 'audio' : 'video',
                targetContainer: container,
                maxConcurrentDownloads: preferences.maxConcurrentDownloads,
                filenameTemplate: preferences.filenameTemplate,
                filenameQuality: String(targetItag),
              }),
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok || typeof data?.jobId !== 'string' || !data.jobId) {
              failedUrls.push(mediaItem.url);
              continue;
            }
            queuedCount++;
            startRealtimeDownload(
              data.jobId,
              mediaItem.title || `Batch ${mediaItem.provider.toUpperCase()} Item`,
              mediaItem.thumbnail,
              isAudio ? 'audio' : 'video',
              mediaItem.url,
              mediaItem.provider,
              data.queuePosition
            );
          } catch (err) {
            console.warn('Batch item could not be queued:', err);
            failedUrls.push(mediaItem.url);
          }
        }
        setQueueProgress({ completed: index + 1, total: parsedUrls.length });
      }

      if (failedUrls.length > 0) {
        setError(`Queued ${queuedCount} download${queuedCount === 1 ? '' : 's'}. ${failedUrls.length} link${failedUrls.length === 1 ? '' : 's'} failed and remain available to retry.`);
        setRawText(failedUrls.join('\n'));
      } else {
        setRawText('');
        onClose();
        setActiveTab('transfers');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Error scheduling batch jobs');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => { if (!isSubmitting) onClose(); }}
          className="absolute inset-0 bg-black/80 backdrop-blur-md cursor-pointer"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ type: 'spring', stiffness: 350, damping: 25 }}
          className="relative glass-panel w-full max-w-2xl p-5 sm:p-7 overflow-hidden bg-neutral-900 border border-white/10 shadow-2xl z-10 max-h-[90vh] flex flex-col"
        >
          {/* Top Glow Ribbon */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-1 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent blur-sm rounded-full" />

          {/* Modal Header */}
          <div className="flex items-center justify-between pb-4 border-b border-white/5 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="size-9 rounded-[8px] bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)]">
                <Layers className="size-5" />
              </div>
              <div>
                <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                  Multi-Video Batch Downloader
                </h3>
                <p className="text-xs text-gray-400">
                  Paste video links or playlist links from supported platforms
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              disabled={isSubmitting}
              className="size-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
              aria-label="Close modal"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="overflow-y-auto flex flex-col gap-4 pt-4 pr-1 flex-1">
            {/* Customization Settings Bar */}
            <div className="p-3.5 rounded-[10px] bg-white/5 border border-white/5 flex flex-col gap-3">
              <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider block">
                Batch Quality & Format Customization
              </span>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {/* Format Type */}
                <div>
                  <label className="text-[9px] font-mono text-gray-400 uppercase tracking-wider block mb-1">
                    Output Stream
                  </label>
                  <div className="grid grid-cols-2 gap-1 bg-black/40 p-1 rounded-[8px] border border-white/5">
                    <button
                      type="button"
                      onClick={() => { setFormatType('video'); setContainer('mp4'); }}
                      className={cn(
                        "py-1.5 text-xs font-bold rounded-[6px] transition-all flex items-center justify-center gap-1 cursor-pointer min-h-[36px]",
                        formatType === 'video' ? "bg-[var(--accent)] text-[var(--accent-text)]" : "text-gray-400 hover:text-white"
                      )}
                    >
                      <MonitorPlay className="size-3.5" /> Video
                    </button>
                    <button
                      type="button"
                      onClick={() => { setFormatType('audio'); setContainer('mp3'); }}
                      className={cn(
                        "py-1.5 text-xs font-bold rounded-[6px] transition-all flex items-center justify-center gap-1 cursor-pointer min-h-[36px]",
                        formatType === 'audio' ? "bg-[var(--accent)] text-[var(--accent-text)]" : "text-gray-400 hover:text-white"
                      )}
                    >
                      <Music className="size-3.5" /> Audio
                    </button>
                  </div>
                </div>

                {/* Quality Select */}
                <div>
                  <label className="text-[9px] font-mono text-gray-400 uppercase tracking-wider block mb-1">
                    {formatType === 'video' ? 'Max Resolution' : 'Audio Bitrate'}
                  </label>
                  {formatType === 'video' ? (
                    <select
                      value={videoQuality}
                      onChange={(e) => setVideoQuality(e.target.value)}
                      className="w-full bg-black/40 border border-white/10 rounded-[8px] px-3 py-2 text-xs font-bold text-neutral-200 outline-none focus:border-[var(--accent)] cursor-pointer"
                    >
                      <option value="best">Best available · full resolution</option>
                      <option value="4320p">Up to 4320p · 8K</option>
                      <option value="2160p">Up to 2160p · 4K</option>
                      <option value="1440p">Up to 1440p · QHD</option>
                      <option value="1080p">1080p Full HD</option>
                      <option value="720p">720p HD</option>
                      <option value="480p">480p SD</option>
                      <option value="360p">360p Compact</option>
                    </select>
                  ) : (
                    <select
                      value={audioQuality}
                      onChange={(e) => setAudioQuality(e.target.value)}
                      className="w-full bg-black/40 border border-white/10 rounded-[8px] px-3 py-2 text-xs font-bold text-neutral-200 outline-none focus:border-[var(--accent)] cursor-pointer"
                    >
                      <option value="audio-320">MP3 · 320 kbps target</option>
                      <option value="audio-256">MP3 · 256 kbps target</option>
                      <option value="audio-128">MP3 · 128 kbps target</option>
                    </select>
                  )}
                </div>

                {/* Container Select */}
                <div>
                  <label className="text-[9px] font-mono text-gray-400 uppercase tracking-wider block mb-1">
                    Target Container
                  </label>
                  <select
                    value={container}
                    onChange={(e) => setContainer(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-[8px] px-3 py-2 text-xs font-bold text-neutral-200 outline-none focus:border-[var(--accent)] cursor-pointer uppercase font-mono"
                  >
                    {formatType === 'video' ? (
                      <>
                        <option value="mp4">MP4 (Universal)</option>
                        <option value="mkv">MKV (Flexible)</option>
                        <option value="webm">WEBM (Open Source)</option>
                      </>
                    ) : (
                      <>
                        <option value="mp3">MP3 (Universal)</option>
                        <option value="m4a">M4A (High Fidelity)</option>
                      </>
                    )}
                  </select>
                </div>
              </div>
            </div>

            {/* URL Input Textarea Area */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-bold text-white flex items-center gap-1.5">
                  Media URLs <span className="text-[10px] font-mono text-gray-400">({parsedUrls.length} detected)</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handlePasteClipboard}
                    className="text-[10px] font-bold text-neutral-300 hover:text-white px-2.5 py-1 rounded-[6px] bg-white/5 hover:bg-white/10 border border-white/10 flex items-center gap-1 transition-colors cursor-pointer min-h-[30px]"
                  >
                    <Clipboard className="size-3 text-[var(--accent)]" /> Paste Clipboard
                  </button>
                  {parsedUrls.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setRawText('')}
                      className="text-[10px] font-bold text-red-400 hover:text-red-300 px-2 py-1 rounded-[6px] bg-red-950/20 border border-red-500/20 transition-colors cursor-pointer min-h-[30px]"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <textarea
                rows={4}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="Paste media links here (one URL per line)&#10;https://www.youtube.com/watch?v=...&#10;https://www.tiktok.com/@.../video/...&#10;https://www.instagram.com/reel/..."
                className="w-full bg-black/50 border border-white/10 rounded-[10px] p-3 text-xs font-mono text-white placeholder:text-gray-500 outline-none focus:border-[var(--accent)] resize-none transition-all leading-relaxed"
              />
            </div>

            {/* Parsed URLs Breakdown List */}
            {parsedUrls.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider block">
                  Batch Items Review ({parsedUrls.length})
                </span>
                <div className="flex flex-col gap-1.5 max-h-[160px] overflow-y-auto pr-1">
                  {parsedUrls.map((itemUrl, idx) => {
                    const prov = detectProvider(itemUrl);
                    return (
                      <div
                        key={idx}
                        className="p-2 bg-white/5 border border-white/5 rounded-[8px] flex items-center justify-between gap-2 text-xs hover:bg-white/[0.08] transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-[9px] font-mono font-bold text-gray-400 w-4 text-right">
                            {idx + 1}.
                          </span>
                          <span className="text-[9px] uppercase font-bold font-mono px-1.5 py-0.5 rounded-[4px] bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30 shrink-0">
                            {prov}
                          </span>
                          <span className="font-mono text-[11px] text-gray-300 truncate" title={itemUrl}>
                            {itemUrl}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemoveUrl(idx)}
                          className="text-gray-400 hover:text-red-400 p-1 rounded transition-colors cursor-pointer shrink-0"
                          title="Remove from batch"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-950/40 border border-red-500/20 text-red-400 text-xs rounded-[8px] flex items-center gap-2">
                <AlertCircle className="size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {isSubmitting && (
              <div className="flex flex-col gap-2" role="status" aria-live="polite">
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-400">
                  <span>Expanding playlists and queueing links</span>
                  <span>{queueProgress.completed}/{queueProgress.total}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-label="Batch link processing" aria-valuemin={0} aria-valuemax={queueProgress.total} aria-valuenow={queueProgress.completed}>
                  <motion.div
                    className="h-full rounded-full bg-[var(--accent)]"
                    animate={{ width: `${queueProgress.total ? (queueProgress.completed / queueProgress.total) * 100 : 0}%` }}
                    transition={{ duration: 0.2 }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Modal Footer */}
          <div className="pt-4 mt-3 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
            <span className="text-xs text-gray-400 text-center sm:text-left">
              Concurrency engine throttles up to 2 items at a time to prevent IP blocks.
            </span>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="flex-1 sm:flex-none px-4 py-2.5 rounded-[8px] bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold uppercase tracking-wider text-neutral-300 hover:text-white transition-all cursor-pointer min-h-[40px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleQueueBatch}
                disabled={isSubmitting || parsedUrls.length === 0}
                className="flex-1 sm:flex-none px-6 py-2.5 rounded-[8px] bg-[var(--accent)] text-[var(--accent-text)] text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 flex items-center justify-center gap-2 cursor-pointer btn-accent shadow-lg min-h-[40px]"
              >
                {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {isSubmitting ? `Queueing ${queueProgress.completed}/${queueProgress.total}` : `Queue All (${parsedUrls.length})`}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
