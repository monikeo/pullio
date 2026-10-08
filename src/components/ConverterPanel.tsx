import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Repeat, Upload, FileVideo, FileAudio, Check, AlertCircle, 
  Loader2, Download, Trash2, ArrowRight, Sparkles, Layers,
  Sliders, Music, Video, RefreshCw, X, Play, HardDrive, Zap,
  CheckCircle2, ChevronDown
} from 'lucide-react';
import { cn } from '../lib/utils';
import { TargetMediaFormat, ConversionItem, ConversionOptions } from '../types';
import { validateMediaUpload, sanitizeFilename, sanitizeUrl } from '../lib/security';

const VIDEO_FORMATS: { format: TargetMediaFormat; label: string; desc: string }[] = [
  { format: 'mp4', label: 'MP4', desc: 'Universal H.264 + AAC' },
  { format: 'mkv', label: 'MKV', desc: 'Matroska High Fidelity' },
  { format: 'webm', label: 'WEBM', desc: 'Modern Web / VP9' },
  { format: 'mov', label: 'MOV', desc: 'Apple QuickTime' },
  { format: 'avi', label: 'AVI', desc: 'Classic Audio Video' },
  { format: 'flv', label: 'FLV', desc: 'Flash Video Container' },
  { format: 'wmv', label: 'WMV', desc: 'Windows Media Video' },
  { format: 'gif', label: 'GIF', desc: 'Animated 15fps Loop' },
];

const AUDIO_FORMATS: { format: TargetMediaFormat; label: string; desc: string }[] = [
  { format: 'mp3', label: 'MP3', desc: 'Universal 320k Studio' },
  { format: 'wav', label: 'WAV', desc: 'Uncompressed Studio PCM' },
  { format: 'flac', label: 'FLAC', desc: 'Lossless Audio Master' },
  { format: 'aac', label: 'AAC', desc: 'Advanced Audio Coding' },
  { format: 'm4a', label: 'M4A', desc: 'Apple Lossy Container' },
  { format: 'ogg', label: 'OGG', desc: 'Vorbis Open Container' },
  { format: 'opus', label: 'OPUS', desc: 'Ultra-low Latency HD' },
];

const AUDIO_BITRATES = [
  { value: '320k', label: '320 kbps', hint: 'Studio High Fidelity' },
  { value: '256k', label: '256 kbps', hint: 'High Quality' },
  { value: '192k', label: '192 kbps', hint: 'Standard Balance' },
  { value: '128k', label: '128 kbps', hint: 'Compact Streaming' },
];

const VIDEO_RESOLUTIONS = [
  { value: 'original', label: 'Original', hint: 'Match Source Dimensions' },
  { value: '4320p', label: '4320p 8K', hint: 'Up to 7680 × 4320' },
  { value: '2160p', label: '2160p 4K', hint: 'Up to 3840 × 2160' },
  { value: '1440p', label: '1440p QHD', hint: 'Up to 2560 × 1440' },
  { value: '1080p', label: '1080p FHD', hint: '1920 × 1080' },
  { value: '720p', label: '720p HD', hint: '1280 × 720' },
  { value: '480p', label: '480p SD', hint: '854 × 480' },
  { value: '360p', label: '360p', hint: '640 × 360' },
];

function uploadConversionFiles(items: ConversionItem[], onProgress: (percent: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    items.forEach((item) => {
      if (item.file) formData.append('files', item.file);
    });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/convert/upload');
    // Allow slow connections to upload large (up to 1 GB) files while still
    // surfacing a stalled connection instead of leaving the queue spinning forever.
    xhr.timeout = 15 * 60 * 1000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onerror = () => reject(new Error('Upload connection failed. Check the server connection and retry.'));
    xhr.onabort = () => reject(new Error('Upload was cancelled.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out. Check your connection and retry.'));
    xhr.onload = () => {
      let response: any;
      try {
        response = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error('The upload server returned an invalid response.'));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(response?.error || 'Failed to upload media file'));
        return;
      }
      resolve(response);
    };
    xhr.send(formData);
  });
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function ConverterPanel() {
  const { 
    conversionQueue, 
    addConversionItems, 
    updateConversionItem, 
    removeConversionItem, 
    clearConversionQueue, 
    setBatchTargetFormat,
    ensureWebSocketConnected,
    subscribeConversionJobs
  } = useAppStore();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [activeFormatTab, setActiveFormatTab] = useState<'video' | 'audio'>('audio');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isProcessingBatch, setIsProcessingBatch] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Helper to detect media type from file extension
  const detectType = (ext: string): 'video' | 'audio' | 'unknown' => {
    const e = ext.toLowerCase();
    if (['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'gif'].includes(e)) return 'video';
    if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff'].includes(e)) return 'audio';
    return 'unknown';
  };

  // Handle local file picking
  const handleFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;

    const newItems: ConversionItem[] = [];
    const count = Math.min(files.length, 20);

    for (let i = 0; i < count; i++) {
      const file = files[i];
      const validation = validateMediaUpload(file);
      if (!validation.valid) {
        showToast(validation.error || `File ${file.name} rejected by security policy`);
        continue;
      }

      const safeName = sanitizeFilename(file.name);
      const nameParts = safeName.split('.');
      const ext = nameParts.length > 1 ? nameParts.pop()!.toLowerCase() : '';
      const mediaType = detectType(ext);

      // Default target: if video, offer MP3 audio extraction or MP4; if audio, offer MP3
      const defaultTarget: TargetMediaFormat = mediaType === 'video' ? 'mp3' : 'wav';

      const item: ConversionItem = {
        id: crypto.randomUUID(),
        file,
        fileName: safeName,
        fileSize: file.size,
        fileSizeFormatted: formatBytes(file.size),
        sourceExt: ext || 'media',
        mediaType,
        options: {
          targetFormat: defaultTarget,
          qualityPreset: '320k',
          audioBitrate: '320k',
          videoResolution: 'original',
        },
        status: 'idle',
        uploadProgress: 0,
        convertProgress: 0,
      };
      newItems.push(item);
    }

    if (newItems.length > 0) {
      addConversionItems(newItems);
      showToast(`Added ${newItems.length} file${newItems.length > 1 ? 's' : ''} to converter queue`);
    }
  }, [addConversionItems]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  };

  // Upload single item and start conversion
  const startSingleConversion = async (item: ConversionItem) => {
    if (!item.file && !item.uploadId) return;

    ensureWebSocketConnected();

    try {
      let uploadId = item.uploadId;

      // Upload file to server if not uploaded yet
      if (!uploadId && item.file) {
        updateConversionItem(item.id, { status: 'uploading', uploadProgress: 10 });
        const uploadData = await uploadConversionFiles([item], (uploadProgress) => {
          updateConversionItem(item.id, { uploadProgress });
        });
        if (!uploadData?.files?.[0]) {
          throw new Error(uploadData.error || 'Failed to upload media file');
        }

        uploadId = uploadData.files[0].uploadId;
        updateConversionItem(item.id, { 
          uploadId, 
          uploadProgress: 100, 
          status: 'queued' 
        });
        if (!useAppStore.getState().conversionQueue.some((queuedItem) => queuedItem.id === item.id)) {
          await fetch(`/api/convert/${encodeURIComponent(item.id)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => undefined);
          return;
        }
      }

      // Trigger conversion process on server
      if (!useAppStore.getState().conversionQueue.some((queuedItem) => queuedItem.id === item.id)) {
        if (uploadId) {
          await fetch(`/api/convert/${encodeURIComponent(item.id)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => undefined);
        }
        return;
      }
      updateConversionItem(item.id, { status: 'queued', convertProgress: 0 });

      const procRes = await fetch('/api/convert/process', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            jobId: item.id,
            uploadId,
            originalName: item.fileName,
            targetFormat: item.options.targetFormat,
            qualityPreset: item.options.qualityPreset,
            videoResolution: item.options.videoResolution,
            audioBitrate: item.options.audioBitrate,
          }],
        }),
      });

      const procData = await procRes.json().catch(() => null);
      if (!procRes.ok) {
        throw new Error(procData?.error || 'Failed to start media conversion');
      }
      if (!Array.isArray(procData?.jobs) || !procData.jobs.some((job: any) => job?.jobId === item.id && job.status === 'queued')) {
        throw new Error('The server did not confirm this conversion job. Please retry.');
      }
      if (!useAppStore.getState().conversionQueue.some((queuedItem) => queuedItem.id === item.id)) {
        if (uploadId) {
          await fetch(`/api/convert/${encodeURIComponent(item.id)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => undefined);
        }
        return;
      }
      subscribeConversionJobs([item.id]);

      showToast(`Conversion started: ${item.fileName.slice(0, 25)}...`);
    } catch (err: unknown) {
      console.error('Conversion start failed:', err);
      const message = err instanceof Error && err.name === 'TimeoutError'
        ? 'The server took too long to start the conversion. Please retry.'
        : err instanceof Error ? err.message : 'Conversion error occurred';
      updateConversionItem(item.id, {
        status: 'failed',
        error: message,
      });
      showToast(`⚠️ ${message}`);
    }
  };

  // Batch process all idle / pending items
  const handleConvertAll = async () => {
    const pendingItems = conversionQueue.filter(
      (item) => item.status === 'idle' || item.status === 'failed'
    );
    if (pendingItems.length === 0) return;

    setIsProcessingBatch(true);
    ensureWebSocketConnected();

    let queuedCount = 0;
    const failures: string[] = [];

    try {
      // The upload and process endpoints both accept up to 20 items per request.
      for (let offset = 0; offset < pendingItems.length; offset += 20) {
        const chunk = pendingItems.slice(offset, offset + 20);
        const itemsToUpload = chunk.filter((item) => !item.uploadId && item.file);
        const uploadedIds = new Map<string, string>();

        try {
          if (itemsToUpload.length > 0) {
            itemsToUpload.forEach((item) => {
              updateConversionItem(item.id, { status: 'uploading', uploadProgress: 0 });
            });

            const uploadData = await uploadConversionFiles(itemsToUpload, (uploadProgress) => {
              itemsToUpload.forEach((item) => updateConversionItem(item.id, { uploadProgress }));
            });
            if (!Array.isArray(uploadData?.files) || uploadData.files.length !== itemsToUpload.length) {
              throw new Error('The server did not confirm every uploaded file. Retry this batch.');
            }

            // Multer preserves multipart file order, so duplicate filenames stay distinct.
            itemsToUpload.forEach((item, index) => {
              const uploaded = uploadData.files[index];
              if (!uploaded?.uploadId) throw new Error(`Upload confirmation is missing for ${item.fileName}.`);
              uploadedIds.set(item.id, uploaded.uploadId);
              updateConversionItem(item.id, {
                uploadId: uploaded.uploadId,
                uploadProgress: 100,
                status: 'queued',
              });
            });
          }

          const liveChunk = chunk.filter((item) =>
            useAppStore.getState().conversionQueue.some((queuedItem) => queuedItem.id === item.id)
          );
          const cancelledItems = chunk.filter((item) => !liveChunk.some((liveItem) => liveItem.id === item.id));
          await Promise.allSettled(cancelledItems.map((item) => {
            const uploadId = uploadedIds.get(item.id) || item.uploadId;
            return uploadId
              ? fetch(`/api/convert/${encodeURIComponent(item.id)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' })
              : Promise.resolve();
          }));
          if (liveChunk.length === 0) {
            continue;
          }

          const payloadItems = liveChunk.map((item) => ({
            jobId: item.id,
            uploadId: uploadedIds.get(item.id) || item.uploadId,
            originalName: item.fileName,
            targetFormat: item.options.targetFormat,
            qualityPreset: item.options.qualityPreset,
            videoResolution: item.options.videoResolution,
            audioBitrate: item.options.audioBitrate,
          }));
          if (payloadItems.some((item) => !item.uploadId)) {
            throw new Error('One or more queue items have no uploaded source file.');
          }

          liveChunk.forEach((item) => updateConversionItem(item.id, { status: 'queued', convertProgress: 0 }));
          const procRes = await fetch('/api/convert/process', {
            method: 'POST',
            signal: AbortSignal.timeout(30_000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: payloadItems }),
          });
          const procData = await procRes.json().catch(() => null);
          if (!procRes.ok) throw new Error(procData?.error || 'Failed to start batch conversion');
          if (!Array.isArray(procData?.jobs) || procData.jobs.length !== liveChunk.length) {
            throw new Error('The server did not confirm every conversion job. Retry this batch.');
          }
          if (procData.jobs.some((job: any) => !liveChunk.some((item) => item.id === job?.jobId) || job.status !== 'queued')) {
            throw new Error('The server returned an incomplete conversion batch response. Retry this batch.');
          }

          const stillQueued = payloadItems.filter((item) =>
            useAppStore.getState().conversionQueue.some((queuedItem) => queuedItem.id === item.jobId)
          );
          const cancelled = payloadItems.filter((item) => !stillQueued.some((activeItem) => activeItem.jobId === item.jobId));
          await Promise.allSettled(cancelled.map((item) =>
            fetch(`/api/convert/${encodeURIComponent(item.jobId)}?uploadId=${encodeURIComponent(item.uploadId!)}`, { method: 'DELETE' })
          ));
          subscribeConversionJobs(stillQueued.map((item) => item.jobId));
          queuedCount += stillQueued.length;
        } catch (err: any) {
          const message = err?.message || 'Conversion request failed.';
          chunk.forEach((item) => updateConversionItem(item.id, { status: 'failed', error: message }));
          failures.push(`${chunk.length} file${chunk.length === 1 ? '' : 's'}: ${message}`);
        }
      }

      showToast(failures.length > 0
        ? `Started ${queuedCount}/${pendingItems.length}; ${failures.join(' ')}`
        : `Batch processing ${queuedCount} media conversion${queuedCount === 1 ? '' : 's'}!`);
    } finally {
      setIsProcessingBatch(false);
    }
  };

  // Download all completed files
  const handleDownloadAll = () => {
    const completedItems = conversionQueue.filter(
      (item) => item.status === 'completed' && item.downloadUrl
    );
    if (completedItems.length === 0) return;

    completedItems.forEach((item, index) => {
      setTimeout(() => {
        const link = document.createElement('a');
        link.href = item.downloadUrl!;
        link.setAttribute('download', item.convertedFileName || '');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }, index * 350);
    });

    showToast(`Downloading ${completedItems.length} converted files...`);
  };

  const handleRemoveItem = (item: ConversionItem) => {
    if (item.uploadId) {
      void fetch(`/api/convert/${encodeURIComponent(item.id)}?uploadId=${encodeURIComponent(item.uploadId)}`, { method: 'DELETE' })
        .catch((err) => console.warn('Could not cancel conversion cleanup:', err));
    }
    removeConversionItem(item.id);
  };

  const handleClearQueue = () => {
    const queuedItems = useAppStore.getState().conversionQueue;
    queuedItems.forEach((item) => {
      if (item.uploadId) {
        void fetch(`/api/convert/${encodeURIComponent(item.id)}?uploadId=${encodeURIComponent(item.uploadId)}`, { method: 'DELETE' })
          .catch((err) => console.warn('Could not cancel conversion cleanup:', err));
      }
    });
    clearConversionQueue();
  };

  // Overall batch metrics
  const totalItems = conversionQueue.length;
  const completedCount = conversionQueue.filter((i) => i.status === 'completed').length;
  const convertingCount = conversionQueue.filter((i) => i.status === 'converting' || i.status === 'queued').length;
  const totalSizeFormatted = useMemo(() => {
    const sum = conversionQueue.reduce((acc, i) => acc + (i.fileSize || 0), 0);
    return formatBytes(sum);
  }, [conversionQueue]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ ease: [0.16, 1, 0.3, 1], duration: 0.5 }}
      className="w-full max-w-5xl mx-auto flex flex-col gap-6 pt-2 pb-16"
    >
      {/* ─── HERO HEADER ──────────────────────────────────────────────────────── */}
      <div className="text-center max-w-2xl mx-auto flex flex-col gap-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[11px] font-bold uppercase tracking-wider text-neutral-300 self-center">
          <Zap className="size-3.5 text-[var(--accent)]" /> FFmpeg Media Transcoder Engine
        </div>
        <h2 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-white">
          Universal <span className="text-[var(--accent)]">Media Converter</span>
        </h2>
        <p className="text-xs sm:text-sm text-neutral-400 max-w-lg mx-auto">
          Convert any video to MP4, MKV, GIF or extract high-fidelity MP3, WAV &amp; FLAC audio. Full batch support with customizable bitrates and resolutions.
        </p>
      </div>

      {/* ─── DRAG & DROP UPLOAD ZONE ────────────────────────────────────────── */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          "relative group cursor-pointer rounded-2xl border-2 border-dashed p-6 sm:p-10 transition-all duration-300 text-center flex flex-col items-center justify-center gap-3 backdrop-blur-xl overflow-hidden",
          isDragOver 
            ? "border-[var(--accent)] bg-[var(--accent)]/10 scale-[1.01]" 
            : "border-white/15 bg-white/[0.02] hover:border-white/30 hover:bg-white/[0.04]"
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,.gif,.mp4,.mkv,.webm,.mov,.avi,.flv,.wmv,.m4v,.3gp,.ts,.mp3,.wav,.flac,.aac,.m4a,.ogg,.opus,.wma,.aiff"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.currentTarget.value = '';
          }}
        />

        <div className="size-14 sm:size-16 rounded-2xl bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)] group-hover:scale-110 transition-transform duration-300 shadow-lg">
          <Upload className="size-7" />
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-sm sm:text-base font-bold text-white tracking-wide">
            Click to upload or drag &amp; drop video &amp; audio files
          </p>
          <p className="text-xs text-neutral-400">
            Supports MP4, MKV, WEBM, MOV, AVI, MP3, WAV, FLAC, AAC, M4A, OGG &amp; more (up to 1 GB each)
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 pt-2 text-[10px] font-mono uppercase tracking-wider text-neutral-500">
          <span className="px-2 py-0.5 rounded bg-white/5 border border-white/5">Video to Video</span>
          <span>•</span>
          <span className="px-2 py-0.5 rounded bg-white/5 border border-white/5">Video to Audio</span>
          <span>•</span>
          <span className="px-2 py-0.5 rounded bg-white/5 border border-white/5">Audio to Audio</span>
          <span>•</span>
          <span className="px-2 py-0.5 rounded bg-white/5 border border-white/5">Multi-File Batch</span>
        </div>
      </div>

      {/* ─── BATCH CONTROLS & QUEUE STATUS ──────────────────────────────────── */}
      {totalItems > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-panel p-4 sm:p-5 rounded-2xl flex flex-col gap-4"
        >
          {/* Top Row: Metrics & Action Buttons */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-xl bg-white/10 flex items-center justify-center text-[var(--accent)] font-bold">
                <Layers className="size-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  Batch Queue ({totalItems} {totalItems === 1 ? 'File' : 'Files'})
                  <span className="text-[11px] font-normal text-neutral-400 font-mono">
                    [{totalSizeFormatted}]
                  </span>
                </h3>
                <p className="text-[11px] text-neutral-400">
                  {completedCount} completed · {convertingCount} processing · {totalItems - completedCount - convertingCount} pending
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              {completedCount > 0 && (
                <button
                  onClick={handleDownloadAll}
                  className="flex-1 sm:flex-none px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer border border-white/10"
                >
                  <Download className="size-3.5 text-green-400" />
                  Download All ({completedCount})
                </button>
              )}

              <button
                onClick={handleConvertAll}
                disabled={isProcessingBatch || totalItems === completedCount}
                className="flex-1 sm:flex-none px-5 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-text)] text-xs font-bold uppercase tracking-wider btn-accent transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-md"
              >
                {isProcessingBatch ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3.5" />
                    Convert All
                  </>
                )}
              </button>

              <button
                onClick={handleClearQueue}
                className="p-2 rounded-xl text-neutral-400 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer border border-transparent hover:border-red-500/20"
                title="Clear all queue items"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>

          {/* Batch Quick Format Applicator */}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] uppercase font-bold tracking-wider text-neutral-400 flex items-center gap-1.5">
              <Sliders className="size-3 text-[var(--accent)]" /> 1-Click Apply Target Format to Entire Batch:
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-neutral-500 uppercase font-mono mr-1">Audio:</span>
              {AUDIO_FORMATS.map(({ format: fmt }) => (
                <button
                  key={fmt}
                  onClick={() => {
                    const quality = fmt === 'wav' || fmt === 'flac' ? 'lossless' : '320k';
                    setBatchTargetFormat(fmt, quality);
                    showToast(`Applied ${fmt.toUpperCase()} format to all queue items`);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-xs font-mono font-bold uppercase tracking-wider text-neutral-300 hover:text-white transition-all cursor-pointer"
                >
                  {fmt}
                </button>
              ))}

              <span className="text-[10px] text-neutral-500 uppercase font-mono mx-1">Video:</span>
              {VIDEO_FORMATS.map(({ format: fmt }) => (
                <button
                  key={fmt}
                  onClick={() => {
                    setBatchTargetFormat(fmt as TargetMediaFormat, fmt === 'mp4' ? '1080p' : 'original');
                    showToast(`Applied ${fmt.toUpperCase()} format to all queue items`);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-xs font-mono font-bold uppercase tracking-wider text-neutral-300 hover:text-white transition-all cursor-pointer"
                >
                  {fmt}
                </button>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {/* ─── QUEUE ITEM CARDS ───────────────────────────────────────────────── */}
      {totalItems > 0 && (
        <div className="flex flex-col gap-3">
          <AnimatePresence>
            {conversionQueue.map((item) => {
              const isAudio = item.mediaType === 'audio';
              const targetIsAudio = AUDIO_FORMATS.some((a) => a.format === item.options.targetFormat);

              return (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="glass-panel p-4 sm:p-5 rounded-2xl border border-white/10 flex flex-col gap-3 relative group"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    {/* Left: Media Icon & Title */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={cn(
                        "size-11 rounded-xl flex items-center justify-center shrink-0 border",
                        isAudio 
                          ? "bg-purple-950/40 border-purple-500/30 text-purple-300" 
                          : "bg-blue-950/40 border-blue-500/30 text-blue-300"
                      )}>
                        {isAudio ? <FileAudio className="size-5" /> : <FileVideo className="size-5" />}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-white truncate max-w-[240px] sm:max-w-md">
                            {item.fileName}
                          </h4>
                          <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-mono font-bold bg-white/10 text-neutral-300 border border-white/5 shrink-0">
                            {item.sourceExt}
                          </span>
                        </div>
                        <p className="text-[11px] text-neutral-400 font-mono mt-0.5">
                          {item.fileSizeFormatted}
                          {item.convertedFileSize && (
                            <span className="text-green-400 ml-2 font-bold">
                              ➔ {item.convertedFileSize}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* Right: Target Format Pipeline Indicator & Trigger */}
                    <div className="flex items-center gap-2 sm:gap-2.5 shrink-0 self-end sm:self-center flex-wrap">
                      <div className="flex items-center gap-1.5 bg-black/40 border border-white/10 rounded-xl px-2.5 py-1.5">
                        <span className="text-[11px] font-mono font-bold text-neutral-400 uppercase">
                          {item.sourceExt}
                        </span>
                        <ArrowRight className="size-3.5 text-[var(--accent)]" />
                        <span className="text-xs font-mono font-bold text-[var(--accent)] uppercase">
                          {item.options.targetFormat}
                        </span>
                        <span className="text-[10px] text-neutral-400 font-mono">
                          ({item.options.qualityPreset})
                        </span>
                      </div>

                      {/* Customize button */}
                      <button
                        onClick={() => setEditingItemId(editingItemId === item.id ? null : item.id)}
                        disabled={item.status === 'converting' || item.status === 'uploading'}
                        className="px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold text-neutral-300 hover:text-white transition-all cursor-pointer disabled:opacity-40"
                        title="Customize format & options"
                      >
                        <Sliders className="size-3.5" />
                      </button>

                      {/* Action Button: Convert, Download, or Status */}
                      {item.status === 'completed' && item.downloadUrl ? (
                        <a
                          href={sanitizeUrl(item.downloadUrl)}
                          download={sanitizeFilename(item.convertedFileName || 'media')}
                          className="px-3.5 py-1.5 rounded-xl bg-green-500/20 hover:bg-green-500/30 border border-green-500/40 text-green-300 text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer shadow-md"
                        >
                          <Download className="size-3.5" />
                          Download
                        </a>
                      ) : item.status === 'converting' || item.status === 'uploading' ? (
                        <div className="px-3 py-1.5 rounded-xl bg-white/5 text-[var(--accent)] text-xs font-bold uppercase font-mono flex items-center gap-1.5">
                          <Loader2 className="size-3.5 animate-spin" />
                          {item.status === 'uploading' ? `${item.uploadProgress}%` : `${item.convertProgress}%`}
                        </div>
                      ) : (
                        <button
                          onClick={() => startSingleConversion(item)}
                          className="px-3.5 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-text)] text-xs font-bold uppercase tracking-wider btn-accent transition-all flex items-center gap-1.5 cursor-pointer shadow-md"
                        >
                          <Play className="size-3.5 fill-current" />
                          Convert
                        </button>
                      )}

                      {/* Delete */}
                      <button
                        onClick={() => handleRemoveItem(item)}
                        className="p-1.5 text-neutral-500 hover:text-red-400 transition-colors cursor-pointer"
                        title="Remove"
                        aria-label={`Cancel and remove ${item.fileName}`}
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  </div>

                  {/* Inline Format & Quality Customizer Dropdown Panel */}
                  <AnimatePresence>
                    {editingItemId === item.id && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="pt-3 border-t border-white/10 flex flex-col gap-3 overflow-hidden"
                      >
                        {/* Format Tabs (Video vs Audio) */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setActiveFormatTab('audio')}
                            className={cn(
                              "px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1 cursor-pointer",
                              activeFormatTab === 'audio' 
                                ? "bg-[var(--accent)] text-[var(--accent-text)]" 
                                : "bg-white/5 text-neutral-400 hover:text-white"
                            )}
                          >
                            <Music className="size-3" /> Audio Formats
                          </button>
                          <button
                            onClick={() => setActiveFormatTab('video')}
                            className={cn(
                              "px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1 cursor-pointer",
                              activeFormatTab === 'video' 
                                ? "bg-[var(--accent)] text-[var(--accent-text)]" 
                                : "bg-white/5 text-neutral-400 hover:text-white"
                            )}
                          >
                            <Video className="size-3" /> Video Formats
                          </button>
                        </div>

                        {/* Format Pill Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
                          {(activeFormatTab === 'audio' ? AUDIO_FORMATS : VIDEO_FORMATS).map((f) => {
                            const isSelected = item.options.targetFormat === f.format;
                            return (
                              <button
                                key={f.format}
                                onClick={() => {
                                  const nextIsAudio = AUDIO_FORMATS.some((audioFormat) => audioFormat.format === f.format);
                                  const nextPreset = nextIsAudio
                                    ? (f.format === 'wav' || f.format === 'flac' ? 'lossless' : item.options.audioBitrate || '320k')
                                    : item.options.videoResolution || 'original';
                                  updateConversionItem(item.id, {
                                    options: {
                                      ...item.options,
                                      targetFormat: f.format,
                                      qualityPreset: nextPreset,
                                      audioBitrate: nextIsAudio ? (item.options.audioBitrate || '320k') : item.options.audioBitrate,
                                      videoResolution: nextIsAudio ? item.options.videoResolution : (item.options.videoResolution || 'original'),
                                    },
                                  });
                                }}
                                className={cn(
                                  "p-2 rounded-xl text-left border transition-all cursor-pointer",
                                  isSelected 
                                    ? "bg-[var(--accent)]/15 border-[var(--accent)] text-white" 
                                    : "bg-white/5 border-white/5 hover:border-white/15 text-neutral-300"
                                )}
                              >
                                <div className="text-xs font-bold uppercase font-mono flex items-center justify-between">
                                  {f.label}
                                  {isSelected && <Check className="size-3 text-[var(--accent)]" />}
                                </div>
                                <div className="text-[10px] text-neutral-500 truncate mt-0.5">
                                  {f.desc}
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        {/* Quality & Bitrate Options */}
                        <div className="pt-2 border-t border-white/5 flex flex-wrap items-center gap-3">
                          <span className="text-[11px] font-bold uppercase text-neutral-400 tracking-wider">
                            Quality Tuning:
                          </span>

                          {targetIsAudio ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {AUDIO_BITRATES.map((b) => (
                                <button
                                  key={b.value}
                                  onClick={() => {
                                    updateConversionItem(item.id, {
                                      options: {
                                        ...item.options,
                                        qualityPreset: b.value,
                                        audioBitrate: b.value,
                                      },
                                    });
                                  }}
                                  className={cn(
                                    "px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold transition-all cursor-pointer border",
                                    item.options.qualityPreset === b.value
                                      ? "bg-[var(--accent)] text-[var(--accent-text)] border-[var(--accent)]"
                                      : "bg-white/5 border-white/10 text-neutral-400 hover:text-white"
                                  )}
                                >
                                  {b.label}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {VIDEO_RESOLUTIONS.map((r) => (
                                <button
                                  key={r.value}
                                  onClick={() => {
                                    updateConversionItem(item.id, {
                                      options: {
                                        ...item.options,
                                        qualityPreset: r.value,
                                        videoResolution: r.value,
                                      },
                                    });
                                  }}
                                  className={cn(
                                    "px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold transition-all cursor-pointer border",
                                    item.options.qualityPreset === r.value
                                      ? "bg-[var(--accent)] text-[var(--accent-text)] border-[var(--accent)]"
                                      : "bg-white/5 border-white/10 text-neutral-400 hover:text-white"
                                  )}
                                >
                                  {r.label}
                                </button>
                              ))}
                            </div>
                          )}

                          <button
                            onClick={() => setEditingItemId(null)}
                            className="ml-auto px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase cursor-pointer"
                          >
                            Done
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Progress Bar (Active During Uploading or Converting) */}
                  {(item.status === 'converting' || item.status === 'uploading') && (
                    <div className="flex flex-col gap-1.5 pt-1">
                      <div
                        className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden"
                        role="progressbar"
                        aria-label={`${item.status === 'uploading' ? 'Uploading' : 'Converting'} ${item.fileName}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={item.status === 'uploading' ? item.uploadProgress : item.convertProgress}
                      >
                        <motion.div
                          className="h-full bg-gradient-to-r from-[var(--accent)] to-indigo-500 rounded-full"
                          initial={{ width: '0%' }}
                          animate={{ 
                            width: `${item.status === 'uploading' ? item.uploadProgress : item.convertProgress}%` 
                          }}
                          transition={{ duration: 0.2 }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono text-neutral-400">
                        <span>
                          {item.status === 'uploading' ? 'Uploading file to conversion engine...' : 'Transcoding media streams...'}
                        </span>
                        <span>
                          {item.speed && `Speed: ${item.speed} · `}
                          {item.eta && `ETA: ${item.eta} · `}
                          <strong className="text-[var(--accent)]">
                            {item.status === 'uploading' ? `${item.uploadProgress}%` : `${item.convertProgress}%`}
                          </strong>
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Error Notification */}
                  {item.status === 'failed' && (
                    <div className="p-2.5 rounded-xl bg-red-950/40 border border-red-500/30 flex items-center justify-between gap-2 text-xs text-red-300">
                      <div className="flex items-center gap-2 min-w-0">
                        <AlertCircle className="size-4 text-red-400 shrink-0" />
                        <span className="truncate">{item.error || 'Conversion encountered an error.'}</span>
                      </div>
                      <button
                        onClick={() => startSingleConversion(item)}
                        className="px-2.5 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/30 text-[10px] font-bold uppercase tracking-wider shrink-0 cursor-pointer"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* ─── TOAST NOTIFICATION ────────────────────────────────────────────── */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-20 md:bottom-8 right-1/2 translate-x-1/2 md:translate-x-0 md:right-8 z-50 px-4 py-2.5 rounded-xl bg-black/95 border border-white/20 text-white text-xs font-bold shadow-2xl backdrop-blur-xl flex items-center gap-2 pointer-events-none"
          >
            <Sparkles className="size-4 text-[var(--accent)] shrink-0" />
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
