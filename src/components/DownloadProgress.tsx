import React, { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { DownloadCloud, XCircle, AlertTriangle, CheckCircle2, RefreshCw, Download, ArrowLeft, Pause, Play, ChevronUp, ChevronDown, AudioLines, Archive, Loader2, Info } from 'lucide-react';
import { getMediaErrorGuidance } from '../lib/mediaErrors';
import { DOWNLOAD_STAGE_LABELS } from '../lib/downloads';

type TransferFilter = 'all' | 'active' | 'paused' | 'failed' | 'completed';

export default function DownloadProgress() {
  const { activeJobs, cancelDownload, removeJob, clearCompletedJobs, setActiveTab, retryJob, pauseJob, resumeJob, reorderQueuedJob, setAudioStudioSource,
    queueRecoveryError, recoverDownloads, downloadNotice, duplicateJobId, downloadAnotherCopy, dismissDownloadNotice } = useAppStore();
  const reduceMotion = useReducedMotion();
  const [filter, setFilter] = useState<TransferFilter>('all');
  const [isRetryingFailed, setIsRetryingFailed] = useState(false);
  const [busyQueueAction, setBusyQueueAction] = useState<string | null>(null);
  const [busyQueueKind, setBusyQueueKind] = useState<'pause' | 'resume' | 'up' | 'down' | null>(null);
  const [queueActionError, setQueueActionError] = useState<string | null>(null);
  const [isPreparingZip, setIsPreparingZip] = useState(false);
  const [zipSelection, setZipSelection] = useState<Set<string>>(() => new Set());

  const jobsList = Object.values(activeJobs).sort((a, b) => {
    const order: Record<string, number> = { downloading: 0, queued: 1, paused: 2, failed: 3, completed: 4 };
    const statusOrder = (order[a.status] ?? 5) - (order[b.status] ?? 5);
    if (statusOrder !== 0) return statusOrder;
    if (a.status === 'queued' && b.status === 'queued') return (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER);
    return 0;
  });
  const completedJobs = jobsList.filter(j => j.status === 'completed');
  const selectedCompleted = completedJobs.filter(job => zipSelection.has(job.jobId));
  const archiveJobs = selectedCompleted.length ? selectedCompleted : completedJobs;
  const failedJobs = jobsList.filter(j => j.status === 'failed');
  const pausedCount = jobsList.filter(j => j.status === 'paused').length;
  const queuedCount = jobsList.filter(j => j.status === 'queued').length;
  const activeCount = jobsList.filter(j => j.status === 'downloading' || j.status === 'queued').length;
  const visibleJobs = jobsList.filter((job) => {
    if (filter === 'active') return job.status === 'downloading' || job.status === 'queued';
    if (filter === 'paused') return job.status === 'paused';
    if (filter === 'failed') return job.status === 'failed';
    if (filter === 'completed') return job.status === 'completed';
    return true;
  });

  const retryFailedJobs = async () => {
    if (isRetryingFailed || failedJobs.length === 0) return;
    setIsRetryingFailed(true);
    try {
      // Re-queue one at a time to avoid launching a burst of extractor processes.
      for (const job of failedJobs) await retryJob(job.jobId);
    } finally {
      setIsRetryingFailed(false);
    }
  };

  const runQueueAction = async (jobId: string, action: 'pause' | 'resume' | 'up' | 'down') => {
    if (busyQueueAction) return;
    setBusyQueueAction(jobId);
    setBusyQueueKind(action);
    setQueueActionError(null);
    try {
      if (action === 'pause') await pauseJob(jobId);
      else if (action === 'resume') await resumeJob(jobId);
      else await reorderQueuedJob(jobId, action);
    } catch (error) {
      setQueueActionError(error instanceof Error ? error.message : 'Could not update the queue. Please try again.');
    } finally {
      setBusyQueueAction(null);
      setBusyQueueKind(null);
    }
  };

  const handleDownloadAllCompleted = async () => {
    if (isPreparingZip) return;
    setIsPreparingZip(true); setQueueActionError(null);
    try {
      const response = await fetch('/api/downloads/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000), body: JSON.stringify({ jobIds: archiveJobs.map(job => job.jobId) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not prepare the ZIP. Please try again.');
      if (typeof data.downloadUrl !== 'string' || !/^\/api\/downloads\/archive\/[a-f0-9-]+$/i.test(data.downloadUrl)) throw new Error('The server returned an invalid ZIP link.');
      const link = document.createElement('a'); link.href = data.downloadUrl; link.download = ''; document.body.appendChild(link); link.click(); link.remove();
    } catch (error) { setQueueActionError(error instanceof Error ? error.message : 'Could not save these downloads as ZIP.'); }
    finally { setIsPreparingZip(false); }
  };

  if (jobsList.length === 0 && !queueRecoveryError && !downloadNotice) {
    return (
      <div className="w-full max-w-4xl mx-auto mt-8 text-center p-8 sm:p-12 glass-panel">
        <div className="size-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto text-gray-500 mb-3">
          <DownloadCloud className="size-6" />
        </div>
        <h3 className="text-sm font-bold text-gray-300">No Active Transfers</h3>
        <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
          Jobs currently downloading will appear here in real-time.
        </p>
        <button
          onClick={() => setActiveTab('downloader')}
          className="mt-4 px-4 py-2.5 bg-white/10 hover:bg-white/15 text-white text-xs font-bold uppercase tracking-wider rounded-[8px] transition-all cursor-pointer inline-flex items-center gap-1.5 min-h-[40px]"
        >
          <ArrowLeft className="size-3.5" /> Back to Downloader
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto mt-6 flex flex-col gap-4 px-2 sm:px-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
        <h3 className="text-xs font-bold uppercase tracking-widest text-neutral-400 flex items-center gap-2">
          <DownloadCloud className="size-4 text-[var(--accent)] animate-pulse" />
          <span>Transfers ({jobsList.length}) {activeCount > 0 && `· ${activeCount} Active or Queued`}</span>
        </h3>

        <div className="flex items-center gap-2 flex-wrap">
          {failedJobs.length > 0 && (
            <button
              onClick={retryFailedJobs}
              disabled={isRetryingFailed}
              className="text-xs px-3 py-2 rounded-[6px] bg-red-500/15 hover:bg-red-500/25 text-red-200 border border-red-500/25 font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 min-h-[36px]"
            >
              <RefreshCw className={`size-3.5 ${isRetryingFailed ? 'animate-spin' : ''}`} />
              {isRetryingFailed ? 'Retrying…' : `Retry Failed (${failedJobs.length})`}
            </button>
          )}

          {completedJobs.length > 0 && (
            <button
              onClick={() => void handleDownloadAllCompleted()}
              disabled={isPreparingZip}
              className="text-xs px-3 py-2 rounded-[6px] bg-[var(--accent)] text-[var(--accent-text)] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer btn-accent shadow-sm min-h-11 disabled:opacity-60"
            >
              {isPreparingZip ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
              {isPreparingZip ? 'Preparing ZIP…' : `${selectedCompleted.length ? 'Save selected ZIP' : 'Save all as ZIP'} (${archiveJobs.length})`}
            </button>
          )}

          <button
            onClick={() => setActiveTab('downloader')}
            className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer font-medium px-2.5 py-1.5 min-h-[36px]"
          >
            <ArrowLeft className="size-3.5" /> New Download
          </button>
        </div>
      </div>
      {selectedCompleted.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
        <span>{selectedCompleted.length} selected for ZIP</span><button className="min-h-11 px-2 text-[var(--accent)]" onClick={() => setZipSelection(new Set())}>Clear selection</button>
      </div>}
      
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter transfers">
        {([
          ['all', 'All', jobsList.length],
          ['active', 'Active', activeCount],
          ['paused', 'Paused', pausedCount],
          ['failed', 'Failed', failedJobs.length],
          ['completed', 'Completed', completedJobs.length],
        ] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={`px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-colors cursor-pointer min-h-11 ${filter === value ? 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-white' : 'bg-white/5 border-white/10 text-gray-400 hover:text-white'}`}
          >
            {label} <span className="opacity-70">{count}</span>
          </button>
        ))}
      </div>

      {queueRecoveryError && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-200">
        <AlertTriangle className="size-4 shrink-0" /><p className="min-w-0 flex-1">{queueRecoveryError}</p>
        <button onClick={() => void recoverDownloads()} className="min-h-11 px-2 underline">Retry recovery</button>
      </div>}
      {downloadNotice && <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-neutral-300">
        <Info className="size-4 shrink-0 text-[var(--accent)]" /><p className="min-w-0 flex-1 basis-52">{downloadNotice}</p>
        {duplicateJobId && <button disabled={Boolean(busyQueueAction)} onClick={async () => {
          setBusyQueueAction(duplicateJobId); setQueueActionError(null);
          try { await downloadAnotherCopy(duplicateJobId); } catch (error) { setQueueActionError(error instanceof Error ? error.message : 'Could not queue another copy.'); }
          finally { setBusyQueueAction(null); }
        }} className="min-h-11 px-2 font-semibold text-[var(--accent)] disabled:opacity-50">Download another copy</button>}
        <button onClick={dismissDownloadNotice} className="min-h-11 px-2 text-neutral-400">Dismiss</button>
      </div>}

      {queueActionError && (
        <div className="flex items-center justify-between gap-3 rounded-[8px] border border-red-500/20 bg-red-950/30 px-3 py-2 text-[11px] text-red-200" role="alert">
          <span>{queueActionError}</span>
          <button type="button" onClick={() => setQueueActionError(null)} className="text-red-200/70 hover:text-white cursor-pointer">Dismiss</button>
        </div>
      )}

      {visibleJobs.length === 0 ? (
        <div className="glass-panel p-6 text-center text-xs text-gray-400">
          <p>No {filter === 'all' ? '' : `${filter} `}transfers to show.</p>
          {filter !== 'all' && <button onClick={() => setFilter('all')} className="mt-2 text-[var(--accent)] hover:underline cursor-pointer">Show all transfers</button>}
        </div>
      ) : <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AnimatePresence mode="popLayout">
          {visibleJobs.map((job) => {
            const isQueued = job.status === 'queued';
            const isPaused = job.status === 'paused';
            const isFailed = job.status === 'failed';
            const isCompleted = job.status === 'completed';
            const isProcessing = ['extracting', 'merging', 'converting', 'finalizing'].includes(job.stage || '');
            const statusLabel = isPaused
              ? 'Paused'
              : isQueued
                ? `Queued${job.queuePosition ? ` · #${job.queuePosition}` : ''}`
                : isFailed ? 'Failed' : isCompleted ? 'Completed' : DOWNLOAD_STAGE_LABELS[job.stage || 'downloading'];

            return (
              <motion.div
                key={job.jobId}
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -15 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
                className="glass-panel p-4 sm:p-5 relative overflow-hidden flex flex-col justify-between min-h-[165px] border border-white/5"
              >
                {/* Background blurred cover */}
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none">
                  {job.thumbnail && (
                    <img src={job.thumbnail} className="w-full h-full object-cover blur-md scale-110" alt="" />
                  )}
                </div>

                <div className="relative z-10 flex gap-3.5 min-w-0 flex-1">
                  {/* Miniature Thumbnail */}
                  {job.thumbnail && (
                    <div className="size-16 rounded-[8px] overflow-hidden bg-black/40 shrink-0 relative border border-white/10">
                      <img src={job.thumbnail} className="w-full h-full object-cover opacity-80" alt="" />
                      {isFailed ? (
                        <div className="absolute inset-0 bg-red-950/80 flex items-center justify-center text-red-400">
                          <AlertTriangle className="size-5" />
                        </div>
                      ) : isCompleted ? (
                        <div className="absolute inset-0 bg-green-950/80 flex items-center justify-center text-green-400">
                          <CheckCircle2 className="size-5" />
                        </div>
                      ) : isPaused ? (
                        <div className="absolute inset-0 bg-amber-950/80 flex items-center justify-center text-amber-300">
                          <Pause className="size-5" />
                        </div>
                      ) : (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-[var(--accent)]">
                          <DownloadCloud className="size-5 text-[var(--accent)] animate-bounce" />
                        </div>
                      )}
                    </div>
                  )}

                  <div className="min-w-0 flex-1 pr-6">
                    <h4 className="font-bold text-xs sm:text-sm text-white truncate leading-snug" title={job.title}>
                      {job.title}
                    </h4>
                    <p className="text-[10px] text-gray-400 leading-relaxed mt-1 break-words">
                      {job.format || 'Best available'}
                    </p>
                    <p className={`text-xs mt-1 font-medium ${isFailed ? 'text-red-300' : isCompleted ? 'text-green-400' : isPaused ? 'text-amber-300' : 'text-[var(--accent)]'}`}>
                      {statusLabel}{!isQueued && !isPaused && !isFailed && !isCompleted && !isProcessing && job.stageProgress !== undefined ? ` · ${Math.round(job.stageProgress)}%` : ''}
                    </p>
                    {job.recoveryMessage && !isCompleted && !isFailed && <p className="text-[10px] text-neutral-500 leading-relaxed mt-1">{job.recoveryMessage}</p>}
                    {!isQueued && !isPaused && !isCompleted && !isFailed && <button
                      type="button" onClick={() => void runQueueAction(job.jobId, 'pause')} disabled={Boolean(busyQueueAction)}
                      className="mt-2 inline-flex items-center gap-1.5 min-h-11 px-3 rounded-lg border border-white/10 bg-white/5 text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-50"
                      aria-label={`Pause ${job.title}`}
                    ><Pause className="size-3.5" />{busyQueueAction === job.jobId && busyQueueKind === 'pause' ? 'Pausing…' : 'Pause'}</button>}

                    {isQueued && typeof job.queuePosition === 'number' && (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[9px] text-gray-500 font-mono">Waiting position {job.queuePosition}</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void runQueueAction(job.jobId, 'up')}
                            disabled={Boolean(busyQueueAction) || job.queuePosition <= 1}
                            className="size-11 flex items-center justify-center rounded-[6px] border border-white/10 bg-white/5 text-gray-300 hover:text-white disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
                            title="Move earlier in the queue"
                            aria-label={`Move ${job.title} earlier in queue`}
                          ><ChevronUp className="size-3.5" /></button>
                          <button
                            type="button"
                            onClick={() => void runQueueAction(job.jobId, 'down')}
                            disabled={Boolean(busyQueueAction) || job.queuePosition >= queuedCount}
                            className="size-11 flex items-center justify-center rounded-[6px] border border-white/10 bg-white/5 text-gray-300 hover:text-white disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
                            title="Move later in the queue"
                            aria-label={`Move ${job.title} later in queue`}
                          ><ChevronDown className="size-3.5" /></button>
                          <button
                            type="button"
                            onClick={() => void runQueueAction(job.jobId, 'pause')}
                            disabled={Boolean(busyQueueAction)}
                            className="ml-1 inline-flex items-center gap-1 min-h-11 rounded-[6px] border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-300 hover:text-white disabled:opacity-50 cursor-pointer"
                            title="Pause this waiting download"
                          ><Pause className="size-3" /> Pause</button>
                        </div>
                      </div>
                    )}
                    {isPaused && (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[9px] text-amber-300 font-mono">Paused · not using a download slot</span>
                        <button
                          type="button"
                          onClick={() => void runQueueAction(job.jobId, 'resume')}
                          disabled={Boolean(busyQueueAction)}
                          className="inline-flex items-center gap-1 min-h-11 rounded-[6px] border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white hover:bg-[var(--accent)]/20 disabled:opacity-50 cursor-pointer"
                          title="Resume this download"
                        ><Play className="size-3" /> {busyQueueAction === job.jobId && busyQueueKind === 'resume' ? 'Resuming…' : 'Resume'}</button>
                      </div>
                    )}
                    
                    {isFailed && job.error ? (
                      <div className="mt-1.5 bg-red-950/20 border border-red-500/10 p-1 rounded-[6px]">
                        <p className="text-[9px] text-red-300 line-clamp-2 leading-relaxed font-medium" title={job.error}>{job.error}</p>
                        <p className="text-[9px] text-red-200/60 line-clamp-2 leading-relaxed mt-0.5">{getMediaErrorGuidance(job.error)}</p>
                      </div>
                    ) : null}
                  </div>

                  <button
                    onClick={() => {
                      if (isCompleted || isFailed) {
                        removeJob(job.jobId);
                      } else {
                        cancelDownload(job.jobId);
                      }
                    }}
                    className="absolute top-2 right-2 text-neutral-400 hover:text-red-400 transition-colors p-2 cursor-pointer"
                    title={isCompleted ? "Dismiss" : "Cancel download"}
                    aria-label={isCompleted ? "Dismiss" : "Cancel download"}
                  >
                    <XCircle className="size-4" />
                  </button>
                </div>

                {/* Direct Save Button when complete (Mobile iOS & Android essential fallback) */}
                {isCompleted && (
                  <div className="relative z-10 mt-3 pt-2 border-t border-white/5 flex items-center justify-between gap-2 flex-wrap">
                    <label className="text-xs min-h-11 text-green-400 flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={zipSelection.has(job.jobId)} aria-label={`Include ${job.title} in ZIP`}
                        className="size-4 accent-[var(--accent)]" onChange={event => {
                          const checked = event.currentTarget.checked;
                          setZipSelection(current => { const next = new Set(current); if (checked) next.add(job.jobId); else next.delete(job.jobId); return next; });
                        }} />
                      <CheckCircle2 className="size-3.5" /> Ready · select for ZIP
                    </label>
                    <button onClick={() => setAudioStudioSource({ kind: 'download', id: job.jobId, name: job.title || 'Downloaded audio' })} className="px-3 py-2 rounded-[6px] bg-white/5 hover:bg-white/10 border border-white/10 text-neutral-200 text-xs font-bold flex items-center gap-1.5 min-h-[36px]">
                      <AudioLines className="size-3.5 text-[var(--accent)]" /> Enhance audio
                    </button>
                    <a
                      href={`/api/files/${job.jobId}`}
                      download
                      className="px-3.5 py-2 rounded-[6px] bg-[var(--accent)] text-[var(--accent-text)] font-bold text-xs uppercase tracking-wider flex items-center gap-1.5 btn-accent min-h-[36px]"
                    >
                      <Download className="size-3.5 text-[var(--accent-text)]" /> Save File
                    </a>
                  </div>
                )}

                {/* Instant 1-Click Retry Transfer Button when failed */}
                {isFailed && (
                  <div className="relative z-10 mt-3 pt-2 border-t border-white/5 flex items-center justify-between">
                    <span className="text-[10px] font-mono font-bold text-red-400 flex items-center gap-1">
                      <AlertTriangle className="size-3.5" /> Transfer Failed
                    </span>
                    <button
                      onClick={() => retryJob(job.jobId)}
                      className="px-3 py-1.5 rounded-[6px] bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 font-bold text-xs uppercase tracking-wider flex items-center gap-1.5 transition-all cursor-pointer min-h-[36px]"
                      title="Retry this transfer with automatic format recovery"
                    >
                      <RefreshCw className="size-3.5" /> Retry
                    </button>
                  </div>
                )}

                {!isCompleted && !isFailed && !isPaused && (
                  <div className="relative z-10 w-full mt-4 flex flex-col gap-2">
                    {/* Glowing Animated Progress Bar */}
                    <div role="progressbar" aria-label={`${job.title}: ${statusLabel}`} aria-valuemin={0} aria-valuemax={100}
                      aria-valuenow={isQueued || isProcessing ? undefined : job.stageProgress} aria-valuetext={statusLabel}
                      className="w-full h-1.5 bg-white/5 border border-white/5 rounded-full overflow-hidden relative">
                      {isQueued || isProcessing ? (
                        <div className="h-full w-full bg-[var(--accent)]/10 animate-shimmer"></div>
                      ) : (
                        <motion.div
                          className="h-full bg-[var(--accent)] relative shadow-[0_0_8px_var(--accent)]"
                          style={{
                            background: 'var(--accent-gradient)',
                          }}
                          initial={{ width: 0 }}
                          animate={{ width: `${job.stageProgress ?? job.progress}%` }}
                          transition={{ ease: "easeOut", duration: reduceMotion ? 0 : 0.2 }}
                        >
                          <div className="absolute inset-0 bg-white/20 animate-shimmer opacity-30"></div>
                        </motion.div>
                      )}
                    </div>

                    <div className="flex flex-wrap justify-between gap-2 font-mono text-[10px] text-gray-500">
                      <span>
                        {isQueued
                          ? 'Queueing...'
                          : isProcessing ? 'Working on your file…' : `${job.bytesDownloaded || '0.0 MB'} / ${job.fileSize || 'Unknown'} · ${job.speed}`}
                      </span>
                      <span>
                        {isQueued || isProcessing ? '' : `ETA: ${job.eta}`}
                      </span>
                    </div>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>}
      
      {/* Global clear completed button */}
      {jobsList.some(j => j.status === 'failed' || j.status === 'completed') && (
        <div className="flex justify-end pt-2">
          <button
            disabled={Boolean(busyQueueAction)}
            onClick={async () => {
              setBusyQueueAction('clear'); setQueueActionError(null);
              try { await clearCompletedJobs(); } catch (error) { setQueueActionError(error instanceof Error ? error.message : 'Could not clear finished transfers.'); }
              finally { setBusyQueueAction(null); }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-white transition-all cursor-pointer min-h-[36px]"
          >
            <RefreshCw className="size-3.5" /> Clear Finished
          </button>
        </div>
      )}
    </div>
  );
}
