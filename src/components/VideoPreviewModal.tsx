import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Play, ExternalLink, AlertCircle, MonitorPlay } from 'lucide-react';
import { VideoMetadata } from '../types';
import { getEmbedUrl, canEmbed, formatDuration } from '../lib/utils';
import { sanitizeUrl } from '../lib/security';

const PROVIDER_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  douyin: 'Douyin · 抖音',
  facebook: 'Facebook',
  instagram: 'Instagram',
  bilibili: 'Bilibili',
  twitter: 'X / Twitter',
  reddit: 'Reddit',
  vimeo: 'Vimeo',
  pinterest: 'Pinterest',
  xiaohongshu: 'XiaoHongShu · 小红书',
  soundcloud: 'SoundCloud',
  generic: 'Web Media',
  unknown: 'Media Provider',
};

interface VideoPreviewModalProps {
  metadata: VideoMetadata;
  onClose: () => void;
}

export default function VideoPreviewModal({ metadata, onClose }: VideoPreviewModalProps) {
  const rawEmbedUrl = getEmbedUrl(metadata.provider, metadata.url);
  const supportsEmbed = canEmbed(metadata.provider);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeTimedOut, setIframeTimedOut] = useState(false);

  // Strictly verify embed URL matches trusted video player origins
  const isTrustedEmbedOrigin = (target: string | null): boolean => {
    if (!target) return false;
    try {
      const parsed = new URL(target);
      return (
        parsed.hostname === 'www.youtube.com' ||
        parsed.hostname === 'www.youtube-nocookie.com' ||
        parsed.hostname === 'player.bilibili.com' ||
        parsed.hostname === 'player.vimeo.com'
      );
    } catch {
      return false;
    }
  };

  const embedUrl = isTrustedEmbedOrigin(rawEmbedUrl) ? rawEmbedUrl : null;
  const safeSourceUrl = sanitizeUrl(metadata.url);
  const safeThumbnail = metadata.thumbnail ? sanitizeUrl(metadata.thumbnail) : null;

  useEffect(() => {
    if (!supportsEmbed || !embedUrl || iframeLoaded) return;
    const timeoutId = window.setTimeout(() => setIframeTimedOut(true), 12_000);
    return () => window.clearTimeout(timeoutId);
  }, [embedUrl, iframeLoaded, supportsEmbed]);

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto p-4 md:p-8">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/90 backdrop-blur-xl cursor-pointer"
        />

        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.92, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 24 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="video-preview-title"
          className="relative w-full max-w-4xl max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain flex flex-col z-10"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Glow ring */}
          <div
            className="absolute -inset-px rounded-[12px] pointer-events-none transition-all duration-700"
            style={{
              boxShadow: `0 0 60px 8px rgba(var(--accent-rgb), 0.2), 0 0 0 1px rgba(var(--accent-rgb), 0.15)`,
            }}
          />

          {/* Header bar */}
          <div className="relative flex items-center justify-between px-5 py-3.5 bg-[#0d0d0d]/95 border border-white/10 border-b-0 rounded-t-[12px] backdrop-blur-md">
            <div className="flex items-center gap-3 min-w-0">
              <div className="size-6 rounded-[6px] bg-[var(--accent)] flex items-center justify-center shrink-0 transition-colors duration-700">
                <MonitorPlay className="size-3.5 text-[var(--accent-text)]" />
              </div>
              <div className="min-w-0">
                <p id="video-preview-title" className="text-white font-bold text-sm truncate pr-4" title={metadata.title}>
                  {metadata.title}
                </p>
                <p className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">
                  {PROVIDER_LABELS[metadata.provider]} · {metadata.author} · {formatDuration(metadata.duration)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <a
                href={safeSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-gray-300 hover:text-white transition-all cursor-pointer min-h-[36px]"
              >
                <ExternalLink className="size-3" /> Open Source
              </a>
              <button
                onClick={onClose}
                className="size-8 rounded-[8px] flex items-center justify-center bg-white/5 hover:bg-white/15 border border-white/10 text-gray-400 hover:text-white transition-all cursor-pointer"
                aria-label="Close preview"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Video / Embed area */}
          <div className="relative bg-black border border-white/10 border-t-0 rounded-b-[12px] overflow-hidden" style={{ aspectRatio: '16/9' }}>
            {supportsEmbed && embedUrl ? (
              <>
                {/* Skeleton while iframe loads */}
                {!iframeLoaded && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0a0a0a] z-10">
                    <div className="size-14 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/20 flex items-center justify-center mb-4 animate-pulse">
                      <Play className="size-6 text-[var(--accent)] ml-0.5" />
                    </div>
                    <div className="h-1.5 w-48 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full w-full animate-shimmer bg-gradient-to-r from-white/5 via-white/10 to-white/5 bg-[length:200%_100%]" />
                    </div>
                    <p className="text-[10px] text-gray-400 font-mono uppercase tracking-widest mt-3 text-center">
                      {iframeTimedOut ? 'The player is taking too long to load.' : 'Loading player...'}
                    </p>
                    {iframeTimedOut && (
                      <a href={safeSourceUrl} target="_blank" rel="noopener noreferrer" className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-xs font-bold text-white hover:bg-white/20">
                        Open source video
                      </a>
                    )}
                  </div>
                )}
                <iframe
                  src={embedUrl}
                  className="w-full h-full"
                  sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  onLoad={() => {
                    setIframeLoaded(true);
                    setIframeTimedOut(false);
                  }}
                  style={{ border: 'none' }}
                  title={metadata.title}
                />
              </>
            ) : (
              /* Fallback for platforms that block embeds (TikTok, Instagram, Facebook) */
              <div className="relative w-full h-full flex flex-col items-center justify-center">
                {/* Blurred thumbnail background */}
                {safeThumbnail && (
                  <img
                    src={safeThumbnail}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover opacity-25 blur-md scale-110"
                  />
                )}

                {/* Centered card */}
                <div className="relative z-10 flex flex-col items-center gap-5 max-w-sm text-center px-6">
                  {safeThumbnail && (
                    <div className="size-32 rounded-[12px] overflow-hidden border border-white/15 shadow-2xl">
                      <img src={safeThumbnail} alt={metadata.title} className="w-full h-full object-cover" />
                    </div>
                  )}

                  <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-500/10 border border-orange-500/20 rounded-full">
                    <AlertCircle className="size-3.5 text-orange-400" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-orange-400">
                      In-browser preview not supported
                    </span>
                  </div>

                  <div>
                    <p className="text-white font-bold text-base leading-snug">{metadata.title}</p>
                    <p className="text-gray-500 text-sm mt-1">{metadata.author}</p>
                  </div>

                  <p className="text-gray-600 text-xs leading-relaxed">
                    {PROVIDER_LABELS[metadata.provider]} restricts embedding. Open the original link to preview.
                  </p>

                  <a
                    href={safeSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-5 py-2.5 rounded-[10px] bg-[var(--accent)] text-[var(--accent-text)] font-bold text-xs uppercase tracking-wider transition-all btn-accent cursor-pointer shadow-lg min-h-[40px]"
                  >
                    <ExternalLink className="size-3.5" />
                    Open on {PROVIDER_LABELS[metadata.provider]}
                  </a>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
