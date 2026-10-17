import React, { useState, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { motion, AnimatePresence } from 'motion/react';
import { 
  History, Trash2, Download, ExternalLink, Copy, Check, Video, Music, 
  Search, FileDown, ArrowRight, Play, AudioLines
} from 'lucide-react';

import { sanitizeUrl } from '../lib/security';

export default function HistoryPanel() {
  const { downloadHistory, deleteHistoryItem, clearHistory, setUrl, analyzeUrl, setActiveTab, setAudioStudioSource } = useAppStore() as any;
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const handleCopy = (url: string, id: string) => {
    const safe = sanitizeUrl(url);
    if (safe !== '#') {
      navigator.clipboard.writeText(safe);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const handleReanalyze = (url: string) => {
    const safe = sanitizeUrl(url);
    if (safe !== '#' && safe.startsWith('http')) {
      setUrl(safe);
      setActiveTab('downloader');
      if (analyzeUrl) analyzeUrl(safe);
    }
  };

  const filteredHistory = useMemo(() => {
    if (!searchQuery.trim()) return downloadHistory;
    const q = searchQuery.toLowerCase();
    return downloadHistory.filter((item: any) => 
      item.title?.toLowerCase().includes(q) || item.provider?.toLowerCase().includes(q)
    );
  }, [downloadHistory, searchQuery]);

  const handleExportJSON = () => {
    const safeData = JSON.stringify(downloadHistory, null, 2);
    const blob = new Blob([safeData], { type: 'application/json' });
    const blobUrl = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", blobUrl);
    downloadAnchor.setAttribute("download", `pullio_history_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      className="glass-panel p-4 sm:p-6 md:p-8 w-full max-w-4xl mx-auto mt-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-white/10 gap-3 mb-4">
        <div className="flex items-center gap-2">
          <History className="size-5 text-[var(--accent)]" />
          <h2 className="text-base font-bold text-white tracking-wide">Download History</h2>
          <span className="text-xs bg-white/10 px-2 py-0.5 rounded-full font-mono font-bold text-gray-400">
            {downloadHistory.length}
          </span>
        </div>

        {downloadHistory.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportJSON}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer border border-white/10 min-h-[36px]"
              title="Export history as JSON"
            >
              <FileDown className="size-3.5" /> Export
            </button>
            <button
              onClick={clearHistory}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer border border-red-500/20 min-h-[36px]"
            >
              <Trash2 className="size-3.5" /> Clear All
            </button>
          </div>
        )}
      </div>

      {downloadHistory.length > 0 && (
        <div className="relative mb-4">
          <Search className="size-3.5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search downloads by title or platform..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-[8px] pl-8 pr-3 py-2 text-xs text-white placeholder:text-gray-500 outline-none focus:border-[var(--accent)]/50 min-h-[38px]"
          />
        </div>
      )}

      {downloadHistory.length === 0 ? (
        <div className="text-center py-16 flex flex-col items-center justify-center">
          <div className="size-14 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-gray-500 mb-4">
            <History className="size-6" />
          </div>
          <h3 className="text-base font-bold text-neutral-300">No Download History Yet</h3>
          <p className="text-xs text-gray-500 mt-1 max-w-xs">
            Downloaded media files will be tracked here so you can easily access them again.
          </p>
          <button
            onClick={() => setActiveTab('downloader')}
            className="mt-4 px-4 py-2.5 bg-[var(--accent)] text-[var(--accent-text)] rounded-[8px] font-bold text-xs uppercase tracking-wider transition-all btn-accent min-h-[40px]"
          >
            Start Downloading
          </button>
        </div>
      ) : filteredHistory.length === 0 ? (
        <div className="text-center py-10 text-gray-500 text-xs">
          No history items match "{searchQuery}"
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence mode="popLayout">
            {filteredHistory.map((item: any) => {
              const dateStr = new Date(item.timestamp).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              });

              return (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="p-3 sm:p-3.5 bg-white/5 hover:bg-white/[0.08] border border-white/5 rounded-[10px] flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Thumbnail */}
                    <div className="size-14 rounded-[8px] overflow-hidden bg-black/60 shrink-0 relative border border-white/10">
                      {item.thumbnail ? (
                        <img src={item.thumbnail} alt={item.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-500">
                          {item.type === 'audio' ? <Music className="size-5" /> : <Video className="size-5" />}
                        </div>
                      )}
                      <div className="absolute bottom-1 right-1 bg-black/80 px-1 py-0.2 rounded text-[8px] font-mono font-bold text-[var(--accent)] uppercase">
                        {item.type === 'audio' ? 'MP3' : 'MP4'}
                      </div>
                    </div>

                    <div className="min-w-0 flex-1">
                      <h4 className="font-bold text-xs sm:text-sm text-white truncate leading-snug" title={item.title}>
                        {item.title}
                      </h4>
                      <div className="flex flex-wrap items-center gap-2 mt-1 text-[10px] font-mono text-gray-400">
                        <span className="uppercase text-[var(--accent)] font-bold">{item.provider}</span>
                        <span>•</span>
                        <span>{item.format}</span>
                        <span>•</span>
                        <span>{item.fileSize}</span>
                        <span>•</span>
                        <span className="text-gray-500">{dateStr}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                    <button onClick={() => setAudioStudioSource({ kind: 'download', id: item.jobId, name: item.title })} className="p-2 min-h-[36px] min-w-[36px] rounded-[8px] bg-white/5 hover:bg-white/15 text-neutral-300 border border-white/10" title="Enhance this download's audio" aria-label={`Enhance audio for ${item.title}`}><AudioLines className="size-3.5" /></button>
                    <a
                      href={sanitizeUrl(item.downloadUrl)}
                      download
                      className="p-2 sm:px-3 sm:py-2 rounded-[8px] bg-[var(--accent)] text-[var(--accent-text)] hover:opacity-90 transition-all font-bold btn-accent flex items-center gap-1.5 text-xs uppercase min-h-[36px]"
                      title="Download file again"
                    >
                      <Download className="size-3.5 text-[var(--accent-text)]" />
                      <span className="hidden sm:inline">Save</span>
                    </a>

                    <button
                      onClick={() => handleCopy(item.url, item.id)}
                      className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-[8px] bg-white/5 hover:bg-white/15 text-gray-300 hover:text-white transition-colors border border-white/5 cursor-pointer"
                      title="Copy original URL"
                    >
                      {copiedId === item.id ? <Check className="size-3.5 text-green-400" /> : <Copy className="size-3.5" />}
                    </button>

                    <button
                      onClick={() => handleReanalyze(item.url)}
                      className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-[8px] bg-white/5 hover:bg-white/15 text-gray-300 hover:text-white transition-colors border border-white/5 cursor-pointer"
                      title="Re-open in Downloader"
                    >
                      <ArrowRight className="size-3.5" />
                    </button>

                    <a
                      href={sanitizeUrl(item.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-[8px] bg-white/5 hover:bg-white/15 text-gray-300 hover:text-white transition-colors border border-white/5"
                      title="Open on Source Platform"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>

                    <button
                      onClick={() => deleteHistoryItem(item.id)}
                      className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-[8px] bg-white/5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors border border-white/5 cursor-pointer"
                      title="Remove from history"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}
