import { create } from 'zustand';
import { 
  ProviderType, VideoMetadata, DownloadState, DownloadHistoryItem, UserPreferences,
  ConversionItem, TargetMediaFormat 
} from '../types';

interface AppState {
  url: string;
  setUrl: (url: string) => void;
  provider: ProviderType;
  setProvider: (provider: ProviderType) => void;
  metadata: VideoMetadata | null;
  setMetadata: (metadata: VideoMetadata | null) => void;
  isAnalyzing: boolean;
  setIsAnalyzing: (state: boolean) => void;
  downloadState: DownloadState | null;
  setDownloadState: (state: DownloadState | null) => void;
  activeJobId: string | null;
  setActiveJobId: (jobId: string | null) => void;
  activeJobs: Record<string, DownloadState>;
  wsInstance: WebSocket | null;
  queueRecoveryError: string | null;
  downloadNotice: string | null;
  duplicateJobId: string | null;
  recoverDownloads: () => Promise<void>;
  acceptDownloadResponse: (data: any) => void;
  downloadAnotherCopy: (jobId: string) => Promise<void>;
  dismissDownloadNotice: () => void;

  // Multi-tab navigation
  activeTab: 'downloader' | 'converter' | 'transfers' | 'history' | 'settings';
  setActiveTab: (tab: 'downloader' | 'converter' | 'transfers' | 'history' | 'settings') => void;
  audioStudioSource: AudioStudioSource | null;
  setAudioStudioSource: (source: AudioStudioSource | null) => void;

  // Converter Queue
  conversionQueue: ConversionItem[];
  addConversionItems: (items: ConversionItem[]) => void;
  updateConversionItem: (id: string, updates: Partial<ConversionItem>) => void;
  removeConversionItem: (id: string) => void;
  clearConversionQueue: () => void;
  setBatchTargetFormat: (format: TargetMediaFormat, qualityPreset?: string) => void;

  // Download History
  downloadHistory: DownloadHistoryItem[];
  addToHistory: (item: DownloadHistoryItem) => void;
  deleteHistoryItem: (id: string) => void;
  clearHistory: () => void;

  // User Preferences
  preferences: UserPreferences;
  updatePreferences: (updates: Partial<UserPreferences>) => void;
  resetPreferences: () => void;

  // PWA Install Prompt
  pwaInstallPrompt: any;
  setPwaInstallPrompt: (prompt: any) => void;
  isPwaInstalled: boolean;
  setIsPwaInstalled: (installed: boolean) => void;
  triggerInstall: () => Promise<boolean>;

  ensureWebSocketConnected: () => WebSocket | null;
  subscribeConversionJobs: (jobIds: string[]) => void;
  retryJob: (jobId: string) => Promise<void>;
  cancelDownload: (jobId?: string) => void;
  removeJob: (jobId: string) => Promise<void>;
  clearCompletedJobs: () => Promise<void>;
  pauseJob: (jobId: string) => Promise<void>;
  resumeJob: (jobId: string) => Promise<void>;
  reorderQueuedJob: (jobId: string, direction: 'up' | 'down') => Promise<void>;
  reset: () => void;
}

import { sanitizeHistoryItem, sanitizeUserPreferences } from '../lib/security';
import type { AudioStudioSource } from '../lib/audioEnhancement';
import { DOWNLOAD_STAGE_LABELS, DownloadStage } from '../lib/downloads';

let recoveryRequest: Promise<void> | null = null;
const dismissedDownloadIds = new Set<string>();
const autoSavedDownloadIds = new Set<string>();

function rememberCompletedDownload(job: DownloadState, autoSave = false) {
  const store = useAppStore.getState();
  if (!store.downloadHistory.some(item => item.jobId === job.jobId)) store.addToHistory({
    id: job.jobId, jobId: job.jobId, url: job.url || '', title: job.title || 'Downloaded media', thumbnail: job.thumbnail || '',
    provider: job.provider || 'generic', format: job.format || 'Best', type: job.type || 'video', fileSize: job.fileSize || 'Complete',
    timestamp: job.updatedAt || Date.now(), downloadUrl: `/api/files/${job.jobId}`,
  });
  if (autoSave && !autoSavedDownloadIds.has(job.jobId) && Object.keys(store.activeJobs).length <= 1) {
    autoSavedDownloadIds.add(job.jobId);
    const link = document.createElement('a'); link.href = `/api/files/${job.jobId}`; link.download = ''; document.body.appendChild(link); link.click(); link.remove();
  }
}

function savedActiveTab(): AppState['activeTab'] {
  try { const tab = localStorage.getItem('pullio_active_tab'); if (['downloader', 'converter', 'transfers', 'history', 'settings'].includes(tab || '')) return tab as AppState['activeTab']; } catch {}
  return 'downloader';
}

function stateFromServer(raw: any): DownloadState | null {
  if (!raw || typeof raw.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.jobId) || !['queued', 'paused', 'downloading', 'completed', 'failed'].includes(raw.status)) return null;
  const formatSelector = String(raw.itag || raw.formatSelector || 'best');
  return {
    jobId: raw.jobId, status: raw.status, isDownloading: raw.status === 'queued' || raw.status === 'downloading',
    stage: Object.hasOwn(DOWNLOAD_STAGE_LABELS, raw.stage) ? raw.stage as DownloadStage : raw.status === 'downloading' ? 'downloading' : raw.status,
    stageProgress: typeof raw.stageProgress === 'number' && Number.isFinite(raw.stageProgress) ? Math.max(0, Math.min(100, raw.stageProgress)) : undefined,
    progress: typeof raw.progress === 'number' ? Math.max(0, Math.min(100, raw.progress)) : 0,
    speed: raw.speed || '', eta: raw.eta || '--:--', title: raw.title || 'Media Download', thumbnail: raw.thumbnail || '',
    url: raw.url || '', provider: raw.provider || 'generic', type: raw.type === 'audio' ? 'audio' : 'video',
    fileSize: raw.fileSize || 'Unknown', bytesDownloaded: raw.bytesDownloaded || '0 MB', formatSelector, format: describeFormatSelector(formatSelector),
    queuePosition: Number.isInteger(raw.queuePosition) ? raw.queuePosition : undefined, error: raw.error,
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, recoveryMessage: raw.recoveryMessage,
    targetContainer: raw.targetContainer, downloadUrl: `/api/files/${raw.jobId}`,
  };
}

const describeFormatSelector = (selector: string): string => {
  const stream = selector.match(/^yt:(video|merge|raw|audio-source):([A-Za-z0-9_.-]+)$/);
  if (stream) {
    const [, kind, formatId] = stream;
    if (kind === 'merge') return `Video + best audio (${formatId})`;
    if (kind === 'raw') return `Video only (${formatId})`;
    if (kind === 'audio-source') return `Original audio (${formatId})`;
    return `Video with audio (${formatId})`;
  }
  const mp3Target = selector.match(/^audio-(\d+)$/i);
  if (mp3Target) return `MP3 · ${mp3Target[1]} kbps target`;
  if (selector.toLowerCase() === 'best') return 'Best available';
  if (selector.toLowerCase() === 'audio' || selector.toLowerCase() === 'bestaudio') return 'Best audio';
  return selector;
};

async function requestJobQueueAction(jobId: string, action: 'pause' | 'resume' | 'reorder', direction?: 'up' | 'down') {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json' },
    ...(direction ? { body: JSON.stringify({ direction }) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Could not update the download queue.');
  if (!data || typeof data !== 'object') throw new Error('The server returned an invalid queue response.');
  return data;
}

function applyQueueSnapshot(jobs: Record<string, DownloadState>, queue: unknown): Record<string, DownloadState> {
  if (!Array.isArray(queue)) return jobs;
  const updated = { ...jobs };
  queue.forEach((item) => {
    if (typeof item?.jobId !== 'string' || !Number.isInteger(item?.queuePosition)) return;
    const job = updated[item.jobId];
    if (job?.status === 'queued') updated[item.jobId] = { ...job, queuePosition: item.queuePosition };
  });
  return updated;
}

// Helper to load localStorage safely with strict schema sanitization
const loadSavedHistory = (): DownloadHistoryItem[] => {
  try {
    const raw = localStorage.getItem('mediagrabber_history');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeHistoryItem)
      .filter((item): item is DownloadHistoryItem => item !== null);
  } catch {
    return [];
  }
};

const loadSavedPreferences = (): UserPreferences => {
  try {
    const raw = localStorage.getItem('mediagrabber_prefs');
    if (raw) return sanitizeUserPreferences(JSON.parse(raw));
  } catch {}
  return sanitizeUserPreferences(null);
};

export const useAppStore = create<AppState>((set, get) => ({
  url: '',
  setUrl: (url) => set({ url }),
  provider: 'unknown',
  setProvider: (provider) => set({ provider }),
  metadata: null,
  setMetadata: (metadata) => set({ metadata }),
  isAnalyzing: false,
  setIsAnalyzing: (isAnalyzing) => set({ isAnalyzing }),
  downloadState: null,
  setDownloadState: (downloadState) => set({ downloadState }),
  activeJobId: null,
  setActiveJobId: (activeJobId) => set({ activeJobId }),
  activeJobs: {},
  wsInstance: null,
  queueRecoveryError: null, downloadNotice: null, duplicateJobId: null,
  dismissDownloadNotice: () => set({ downloadNotice: null, duplicateJobId: null }),
  recoverDownloads: () => {
    if (recoveryRequest) return recoveryRequest;
    const before = new Set(Object.keys(get().activeJobs));
    recoveryRequest = (async () => {
      let recoveryFailure = 'The saved queue is temporarily unavailable. Pullio will reconnect when the server returns; you can also retry recovery.';
      try {
        const response = await fetch('/api/jobs', { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
        if (!response.headers.get('content-type')?.includes('application/json')) {
          recoveryFailure = 'The download queue API is unavailable. Restart the updated Pullio server, then retry recovery.';
          throw new Error(recoveryFailure);
        }
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.jobs)) throw new Error('The saved transfer queue could not be loaded.');
        const recovered: Record<string, DownloadState> = {};
        for (const raw of data.jobs) {
          const job = stateFromServer(raw); if (!job || dismissedDownloadIds.has(job.jobId)) continue;
          const current = get().activeJobs[job.jobId];
          recovered[job.jobId] = current && (current.updatedAt || 0) > (job.updatedAt || 0) ? current : job;
        }
        for (const [id, current] of Object.entries(get().activeJobs)) if (!before.has(id) && !recovered[id]) recovered[id] = current;
        set({ activeJobs: recovered, downloadState: recovered[get().activeJobId || ''] || null, queueRecoveryError: data.persistenceError || null });
        for (const job of Object.values(recovered)) if (job.status === 'completed') rememberCompletedDownload(job);
        if (Object.keys(recovered).length) {
          const ws = get().ensureWebSocketConnected();
          if (ws?.readyState === WebSocket.OPEN) for (const id of Object.keys(recovered)) ws.send(JSON.stringify({ type: 'subscribe', jobId: id }));
        }
      } catch { set({ queueRecoveryError: recoveryFailure }); }
      finally { recoveryRequest = null; }
    })();
    return recoveryRequest;
  },
  acceptDownloadResponse: (data) => {
    const job = stateFromServer(data?.job);
    if (!job || job.jobId !== data.jobId) throw new Error('The server did not return valid transfer details. Restart the updated Pullio server and retry.');
    set({ activeJobs: { ...get().activeJobs, [job.jobId]: job }, activeJobId: job.jobId, downloadState: job, activeTab: 'transfers',
      ...(data.duplicate ? { downloadNotice: `This media and format are already ${job.status === 'completed' ? 'downloaded' : 'in your queue'}. The existing transfer was opened.`, duplicateJobId: job.jobId } : {}) });
    get().setActiveTab('transfers');
    if (job.status === 'completed') rememberCompletedDownload(job, !data.duplicate);
    const ws = get().ensureWebSocketConnected();
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', jobId: job.jobId }));
  },
  downloadAnotherCopy: async (jobId) => {
    const job = get().activeJobs[jobId]; if (!job) throw new Error('This download is unavailable.');
    const response = await fetch('/api/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45_000), body: JSON.stringify({
      url: job.url, itag: job.formatSelector || 'best', type: job.type, provider: job.provider, title: job.title, thumbnail: job.thumbnail,
      targetContainer: job.targetContainer, filenameTemplate: get().preferences.filenameTemplate, allowDuplicate: true,
    }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not queue another copy.');
    get().acceptDownloadResponse(data); get().dismissDownloadNotice();
  },

  activeTab: savedActiveTab(),
  setActiveTab: (activeTab) => { set({ activeTab }); try { localStorage.setItem('pullio_active_tab', activeTab); } catch {} },
  audioStudioSource: null,
  setAudioStudioSource: (audioStudioSource) => set({ audioStudioSource }),

  conversionQueue: [],
  addConversionItems: (items) => {
    set({ conversionQueue: [...get().conversionQueue, ...items] });
  },
  updateConversionItem: (id, updates) => {
    set({
      conversionQueue: get().conversionQueue.map((item) =>
        item.id === id || item.uploadId === id ? { ...item, ...updates } : item
      ),
    });
  },
  removeConversionItem: (id) => {
    set({
      conversionQueue: get().conversionQueue.filter((item) => item.id !== id && item.uploadId !== id),
    });
  },
  clearConversionQueue: () => {
    set({ conversionQueue: [] });
  },
  setBatchTargetFormat: (format, qualityPreset) => {
    set({
      conversionQueue: get().conversionQueue.map((item) => {
        if (item.status === 'converting' || item.status === 'uploading') return item;
        const preset = qualityPreset || item.options.qualityPreset;
        const audioBitrate = ['320k', '256k', '192k', '128k'].includes(preset || '')
          ? preset
          : item.options.audioBitrate;
        const videoResolution = ['original', '4320p', '2160p', '1440p', '1080p', '720p', '480p', '360p'].includes(preset || '')
          ? preset
          : item.options.videoResolution;
        return {
          ...item,
          options: {
            ...item.options,
            targetFormat: format,
            qualityPreset: preset,
            audioBitrate,
            videoResolution,
          },
        };
      }),
    });
  },

  downloadHistory: loadSavedHistory(),
  addToHistory: (item) => {
    const sanitized = sanitizeHistoryItem(item);
    if (!sanitized) return;
    const updated = [sanitized, ...get().downloadHistory.filter(h => h.id !== sanitized.id)].slice(0, 100);
    set({ downloadHistory: updated });
    try {
      localStorage.setItem('mediagrabber_history', JSON.stringify(updated));
    } catch {}
  },
  deleteHistoryItem: (id) => {
    const updated = get().downloadHistory.filter(h => h.id !== id);
    set({ downloadHistory: updated });
    try {
      localStorage.setItem('mediagrabber_history', JSON.stringify(updated));
    } catch {}
  },
  clearHistory: () => {
    set({ downloadHistory: [] });
    try {
      localStorage.removeItem('mediagrabber_history');
    } catch {}
  },

  preferences: loadSavedPreferences(),
  updatePreferences: (updates) => {
    const updated = { ...get().preferences, ...updates };
    set({ preferences: updated });
    try {
      localStorage.setItem('mediagrabber_prefs', JSON.stringify(updated));
    } catch {}
  },
  resetPreferences: () => {
    const defaults = sanitizeUserPreferences(null);
    set({ preferences: defaults });
    try {
      localStorage.setItem('mediagrabber_prefs', JSON.stringify(defaults));
    } catch {}
  },

  pwaInstallPrompt: null,
  setPwaInstallPrompt: (pwaInstallPrompt) => set({ pwaInstallPrompt }),
  isPwaInstalled: false,
  setIsPwaInstalled: (isPwaInstalled) => set({ isPwaInstalled }),
  triggerInstall: async () => {
    const prompt = get().pwaInstallPrompt;
    if (!prompt) return false;
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      set({ pwaInstallPrompt: null, isPwaInstalled: outcome === 'accepted' });
      return outcome === 'accepted';
    } catch (err) {
      console.warn('PWA installation prompt could not be completed:', err);
      set({ pwaInstallPrompt: null });
      return false;
    }
  },

  ensureWebSocketConnected: () => {
    let ws = get().wsInstance;

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return ws;
    }

    if (ws) {
      try { ws.close(); } catch {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    ws = new WebSocket(wsUrl);
    set({ wsInstance: ws });

    ws.onopen = () => {
      void get().recoverDownloads();
      // Re-subscribe to all currently active or pending jobs
      const currentActive = get().activeJobs;
      Object.keys(currentActive).forEach((id) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'subscribe', jobId: id }));
        }
      });
      get().conversionQueue
        .filter((item) => item.status === 'queued' || item.status === 'converting')
        .forEach((item) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'subscribe-convert', jobId: item.id }));
          }
        });
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'progress' && message.job) {
          const { jobId: msgJobId, progress, speed, eta, status, error, fileSize, bytesDownloaded, itag, title: msgTitle, thumbnail: msgThumbnail, queuePosition } = message.job;
          if (dismissedDownloadIds.has(msgJobId)) return;

          const targetJob = get().activeJobs[msgJobId];
          const formatSelector = String(itag || targetJob?.formatSelector || targetJob?.format || 'best');
          const jobProvider: ProviderType = targetJob?.provider || (get().metadata?.provider as ProviderType) || get().provider || 'generic';
          const updatedJob: DownloadState = {
            ...targetJob,
            jobId: msgJobId,
            isDownloading: status === 'downloading' || status === 'queued',
            progress: typeof progress === 'number' ? progress : 0,
            speed: speed || '0 MB/s',
            eta: eta || '--:--',
            status: status || 'downloading',
            error,
            fileSize: fileSize || targetJob?.fileSize || '0 MB',
            bytesDownloaded: bytesDownloaded || targetJob?.bytesDownloaded || '0 MB',
            format: describeFormatSelector(formatSelector),
            formatSelector,
            title: msgTitle || targetJob?.title || get().metadata?.title || 'Media Download',
            thumbnail: msgThumbnail || targetJob?.thumbnail || get().metadata?.thumbnail || '',
            type: targetJob?.type || 'video',
            url: message.job.url || targetJob?.url || '',
            provider: jobProvider,
            queuePosition: Number.isInteger(queuePosition) ? queuePosition : undefined,
            downloadUrl: `/api/files/${msgJobId}`,
            stage: message.job.stage, stageProgress: message.job.stageProgress, createdAt: message.job.createdAt,
            updatedAt: message.job.updatedAt, recoveryMessage: message.job.recoveryMessage, targetContainer: message.job.targetContainer,
          };

          const jobs = { ...get().activeJobs, [msgJobId]: updatedJob };

          set({
            activeJobs: jobs,
            downloadState: get().activeJobId === msgJobId ? updatedJob : get().downloadState,
          });

          // Handle completion: add to persistent history and auto-save for single transfers
          if (status === 'completed' && targetJob?.status !== 'completed') {
            rememberCompletedDownload(updatedJob, Boolean(targetJob));
          }
        }

        if (message.type === 'convert-progress' && message.job) {
          const { jobId: convJobId, status, progress, speed, eta, error, outputFileName, outputFileSize, downloadUrl } = message.job;
          get().updateConversionItem(convJobId, {
            status,
            convertProgress: typeof progress === 'number' ? progress : 0,
            speed: speed || '',
            eta: eta || '',
            error,
            convertedFileName: outputFileName,
            convertedFileSize: outputFileSize,
            downloadUrl: downloadUrl || `/api/convert/download/${convJobId}`,
          });
        }
      } catch (err) {
        console.error('Error handling WebSocket progress packet:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('WebSocket connection notice:', err);
    };

    ws.onclose = () => {
      if (get().wsInstance !== ws) return;
      set({ wsInstance: null });
      // Auto-reconnect if any transfers are still in progress
      const pending = Object.values(get().activeJobs).filter(
        j => j.status === 'downloading' || j.status === 'queued'
      );
      const pendingConversions = get().conversionQueue.some(
        (item) => item.status === 'queued' || item.status === 'converting'
      );
      if (pending.length > 0 || pendingConversions) {
        setTimeout(() => {
            if (get().wsInstance === null) get().ensureWebSocketConnected();
        }, 1500);
      }
    };

    return ws;
  },

  subscribeConversionJobs: (jobIds) => {
    const ws = get().ensureWebSocketConnected();
    const sendSubscriptions = () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      jobIds.forEach((jobId) => {
        ws.send(JSON.stringify({ type: 'subscribe-convert', jobId }));
      });
    };

    if (ws?.readyState === WebSocket.OPEN) {
      sendSubscriptions();
    } else {
      ws?.addEventListener('open', sendSubscriptions, { once: true });
    }
  },

  retryJob: async (jobId: string) => {
    const job = get().activeJobs[jobId];
    if (!job) return;

    // Set optimistic retrying state
    const retryingJob: DownloadState = {
      ...job,
      status: 'queued',
      progress: 0,
      speed: '0 MB/s',
      eta: 'Re-queueing...',
      error: undefined,
      isDownloading: true,
    };

    set({
      activeJobs: { ...get().activeJobs, [jobId]: retryingJob },
      downloadState: get().activeJobId === jobId ? retryingJob : get().downloadState,
    });

    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, {
        method: 'POST',
        signal: AbortSignal.timeout(45_000),
      });
      const retryData = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status !== 404) throw new Error(retryData?.error || 'Could not retry this transfer.');
        // Fallback: If job was purged from server memory (e.g. after server restart), re-queue via /api/queue
        const queueRes = await fetch('/api/queue', {
          method: 'POST',
          signal: AbortSignal.timeout(45_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: job.url,
            itag: job.formatSelector || job.format || 'best',
            title: job.title,
            thumbnail: job.thumbnail,
            provider: job.provider || 'generic',
            maxConcurrentDownloads: get().preferences.maxConcurrentDownloads,
            filenameTemplate: get().preferences.filenameTemplate,
            filenameQuality: job.format || 'best',
            type: job.type, targetContainer: job.targetContainer,
          }),
        });
        const queueData = await queueRes.json().catch(() => null);
        if (queueRes.ok && typeof queueData?.jobId === 'string' && queueData.jobId) {
          await get().removeJob(jobId);
          get().acceptDownloadResponse(queueData);
          return;
        }
        throw new Error('Failed to re-queue job on server');
      }

      if (retryData?.job) get().acceptDownloadResponse(retryData);
      if (Number.isInteger(retryData?.queuePosition)) {
        const queuedJob = { ...get().activeJobs[jobId], queuePosition: retryData.queuePosition };
        set({
          activeJobs: { ...get().activeJobs, [jobId]: queuedJob },
          downloadState: get().activeJobId === jobId ? queuedJob : get().downloadState,
        });
      }

      // Re-subscribe on active socket
      const ws = get().ensureWebSocketConnected();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribe', jobId }));
      }
    } catch (err: any) {
      console.error('Job retry failed:', err);
      const retryError = err instanceof Error && err.name === 'TimeoutError'
        ? 'The server took too long to retry this download.'
        : err instanceof Error ? err.message : 'Server error';
      const failedJob: DownloadState = {
        ...job,
        status: 'failed',
        error: `Retry failed: ${retryError}`,
        isDownloading: false,
      };
      set({
        activeJobs: { ...get().activeJobs, [jobId]: failedJob },
        downloadState: get().activeJobId === jobId ? failedJob : get().downloadState,
      });
    }
  },

  removeJob: async (jobId: string) => {
    const previous = get().activeJobs[jobId];
    dismissedDownloadIds.add(jobId);
    const remainingJobs = { ...get().activeJobs };
    delete remainingJobs[jobId];
    set({
      activeJobs: remainingJobs,
      downloadState: get().activeJobId === jobId ? null : get().downloadState,
      activeJobId: get().activeJobId === jobId ? null : get().activeJobId,
    });
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('The transfer could not be removed from the server.');
    } catch {
      dismissedDownloadIds.delete(jobId);
      set({ activeJobs: previous ? { ...get().activeJobs, [jobId]: previous } : get().activeJobs,
        queueRecoveryError: 'The transfer could not be removed. Check the connection and try again.' });
    }
  },

  clearCompletedJobs: async () => {
    const ids = Object.values(get().activeJobs).filter(job => job.status === 'completed' || job.status === 'failed').map(job => job.jobId);
    if (!ids.length) return;
    const response = await fetch('/api/jobs', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000), body: JSON.stringify({ jobIds: ids }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not clear finished transfers.');
    ids.forEach(id => dismissedDownloadIds.add(id));
    const remainingJobs: Record<string, DownloadState> = {};
    Object.entries(get().activeJobs).forEach(([id, job]) => {
      if (!ids.includes(id)) {
        remainingJobs[id] = job;
      }
    });
    set({
      activeJobs: remainingJobs,
      downloadState: remainingJobs[get().activeJobId || ''] || null,
    });
  },

  pauseJob: async (jobId) => {
    const data = await requestJobQueueAction(jobId, 'pause');
    set((state) => {
      const job = state.activeJobs[jobId];
      if (!job) return {};
      const updatedJobs = applyQueueSnapshot({
        ...state.activeJobs,
        [jobId]: stateFromServer(data.job) || { ...job, stage: 'paused', status: 'paused', isDownloading: false, queuePosition: undefined, speed: 'Paused', eta: 'Waiting to resume' },
      }, data.queue);
      return {
        activeJobs: updatedJobs,
        downloadState: state.activeJobId ? updatedJobs[state.activeJobId] || state.downloadState : state.downloadState,
      };
    });
  },

  resumeJob: async (jobId) => {
    const data = await requestJobQueueAction(jobId, 'resume');
    set((state) => {
      const job = state.activeJobs[jobId];
      if (!job) return {};
      const status: DownloadState['status'] = data.status === 'downloading' ? 'downloading' : 'queued';
      const resumedJob: DownloadState = stateFromServer(data.job) || {
        ...job,
        status,
        stage: 'queued',
        isDownloading: status === 'queued' || status === 'downloading',
        queuePosition: Number.isInteger(data.queuePosition) ? data.queuePosition : undefined,
        speed: status === 'queued' ? '0 MB/s' : 'Starting...',
        eta: status === 'queued' ? 'Waiting in queue' : 'Calculating...',
      };
      const updatedJobs = applyQueueSnapshot({ ...state.activeJobs, [jobId]: resumedJob }, data.queue);
      return {
        activeJobs: updatedJobs,
        downloadState: state.activeJobId ? updatedJobs[state.activeJobId] || state.downloadState : state.downloadState,
      };
    });
  },

  reorderQueuedJob: async (jobId, direction) => {
    const data = await requestJobQueueAction(jobId, 'reorder', direction);
    set((state) => {
      const updatedJobs = applyQueueSnapshot(state.activeJobs, data.queue);
      return {
        activeJobs: updatedJobs,
        downloadState: state.activeJobId ? updatedJobs[state.activeJobId] || state.downloadState : state.downloadState,
      };
    });
  },

  cancelDownload: (jobId) => {
    const targetId = jobId || get().activeJobId;
    if (!targetId) return;

    void get().removeJob(targetId);
  },

  reset: () => {
    const ws = get().wsInstance;
    if (ws) {
      try { ws.close(); } catch {}
    }
    set({
      url: '',
      provider: 'unknown',
      metadata: null,
      isAnalyzing: false,
      downloadState: null,
      activeJobId: null,
      activeJobs: {},
      wsInstance: null,
    });
  }
}));
