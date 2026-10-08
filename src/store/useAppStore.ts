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

  // Multi-tab navigation
  activeTab: 'downloader' | 'converter' | 'transfers' | 'history' | 'settings';
  setActiveTab: (tab: 'downloader' | 'converter' | 'transfers' | 'history' | 'settings') => void;

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

  startRealtimeDownload: (jobId: string, title?: string, thumbnail?: string, type?: 'video' | 'audio', originalUrl?: string, provider?: ProviderType, queuePosition?: number) => void;
  ensureWebSocketConnected: () => WebSocket | null;
  subscribeConversionJobs: (jobIds: string[]) => void;
  retryJob: (jobId: string) => Promise<void>;
  cancelDownload: (jobId?: string) => void;
  removeJob: (jobId: string) => void;
  clearCompletedJobs: () => void;
  pauseJob: (jobId: string) => Promise<void>;
  resumeJob: (jobId: string) => Promise<void>;
  reorderQueuedJob: (jobId: string, direction: 'up' | 'down') => Promise<void>;
  reset: () => void;
}

import { sanitizeHistoryItem, sanitizeUserPreferences } from '../lib/security';

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

  activeTab: 'downloader',
  setActiveTab: (activeTab) => set({ activeTab }),

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

          const targetJob = get().activeJobs[msgJobId];
          const formatSelector = String(itag || targetJob?.formatSelector || targetJob?.format || 'best');
          const jobProvider: ProviderType = targetJob?.provider || (get().metadata?.provider as ProviderType) || get().provider || 'generic';
          const updatedJob: DownloadState = {
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
            url: targetJob?.url || '',
            provider: jobProvider,
            queuePosition: Number.isInteger(queuePosition) ? queuePosition : undefined,
            downloadUrl: `/api/files/${msgJobId}`,
          };

          const jobs = { ...get().activeJobs, [msgJobId]: updatedJob };

          set({
            activeJobs: jobs,
            downloadState: get().activeJobId === msgJobId ? updatedJob : get().downloadState,
          });

          // Handle completion: add to persistent history and auto-save for single transfers
          if (status === 'completed') {
            get().addToHistory({
              id: msgJobId,
              jobId: msgJobId,
              url: updatedJob.url || get().url || '',
              title: updatedJob.title || 'Downloaded Media',
              thumbnail: updatedJob.thumbnail || '',
              provider: jobProvider,
              format: updatedJob.format || 'Best',
              type: updatedJob.type || 'video',
              fileSize: updatedJob.fileSize || 'Complete',
              timestamp: Date.now(),
              downloadUrl: `/api/files/${msgJobId}`,
            });

            // Only auto-trigger browser download if single item to avoid browser popup blocks
            const currentJobKeys = Object.keys(get().activeJobs);
            if (currentJobKeys.length <= 1) {
              const link = document.createElement('a');
              link.href = `/api/files/${msgJobId}`;
              link.setAttribute('download', '');
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            }
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
          get().ensureWebSocketConnected();
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

  startRealtimeDownload: (jobId, title, thumbnail, type = 'video', originalUrl, provider, queuePosition) => {
    const ws = get().ensureWebSocketConnected();

    // Subscribe to the new job immediately if socket is already open
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', jobId }));
    }

    const targetTitle = title || get().metadata?.title || 'Media Download';
    const targetThumbnail = thumbnail || get().metadata?.thumbnail || '';
    const jobProvider = provider || (get().metadata?.provider as ProviderType) || get().provider || 'generic';
    const newJob: DownloadState = {
      jobId,
      isDownloading: true,
      progress: 0,
      speed: 'Starting...',
      eta: 'Calculating...',
      status: 'queued',
      fileSize: '0 MB',
      bytesDownloaded: '0 MB',
      format: 'Best',
      title: targetTitle,
      thumbnail: targetThumbnail,
      type,
      url: originalUrl || get().metadata?.url || '',
      provider: jobProvider,
      queuePosition,
      downloadUrl: `/api/files/${jobId}`
    };

    const currentJobs = { ...get().activeJobs, [jobId]: newJob };
    set({
      activeJobId: jobId,
      activeJobs: currentJobs,
      downloadState: newJob,
      activeTab: 'transfers',
    });
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
          }),
        });
        const queueData = await queueRes.json().catch(() => null);
        if (queueRes.ok && typeof queueData?.jobId === 'string' && queueData.jobId) {
          get().removeJob(jobId);
          get().startRealtimeDownload(
            queueData.jobId,
            job.title,
            job.thumbnail,
            job.type || 'video',
            job.url,
            job.provider,
            queueData.queuePosition
          );
          return;
        }
        throw new Error('Failed to re-queue job on server');
      }

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

  removeJob: (jobId: string) => {
    // Notify server to cancel running processes and purge temp files
    fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});

    const remainingJobs = { ...get().activeJobs };
    delete remainingJobs[jobId];
    set({
      activeJobs: remainingJobs,
      downloadState: get().activeJobId === jobId ? null : get().downloadState,
      activeJobId: get().activeJobId === jobId ? null : get().activeJobId,
    });
  },

  clearCompletedJobs: () => {
    const remainingJobs: Record<string, DownloadState> = {};
    Object.entries(get().activeJobs).forEach(([id, job]) => {
      if (job.status !== 'completed' && job.status !== 'failed') {
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
        [jobId]: { ...job, status: 'paused', isDownloading: false, queuePosition: undefined, speed: 'Paused', eta: 'Waiting to resume' },
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
      const resumedJob = {
        ...job,
        status,
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

    // Notify server to kill process
    fetch(`/api/jobs/${targetId}`, { method: 'DELETE' }).catch(() => {});

    const remainingJobs = { ...get().activeJobs };
    delete remainingJobs[targetId];

    set({
      activeJobs: remainingJobs,
      downloadState: get().activeJobId === targetId ? null : get().downloadState,
      activeJobId: get().activeJobId === targetId ? null : get().activeJobId,
    });
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
