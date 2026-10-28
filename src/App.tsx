import React, { lazy, Suspense, useEffect, useState, useCallback, useRef } from 'react';
import { useAppStore } from './store/useAppStore';
import BatchDownloadModal from './components/BatchDownloadModal';
import FooterGroup from './components/FooterGroup';
import { useScrollNavigation } from './lib/useScrollNavigation';
import { motion, AnimatePresence, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { 
  Link2, Sparkles, Loader2, Info, DownloadCloud, History, 
  Settings as SettingsIcon, Download, Smartphone, Check, AlertCircle, Layers,
  Compass, WifiOff, ArrowUp, Repeat, Zap
} from 'lucide-react';
import { cn, extractMediaUrl, detectMediaProvider } from './lib/utils';
import { expandBatchUrl } from './lib/batch';
import { getMediaErrorGuidance, mediaErrorNeedsCookies } from './lib/mediaErrors';
import { ProviderType } from './types';

const AnalyzePanel = lazy(() => import('./components/AnalyzePanel'));
const DownloadProgress = lazy(() => import('./components/DownloadProgress'));
const HistoryPanel = lazy(() => import('./components/HistoryPanel'));
const SettingsPanel = lazy(() => import('./components/SettingsPanel'));
const ConverterPanel = lazy(() => import('./components/ConverterPanel'));
const AudioEnhancerStudio = lazy(() => import('./components/AudioEnhancerStudio'));
const AboutModal = lazy(() => import('./components/AboutModal'));
const PwaInstallModal = lazy(() => import('./components/PwaInstallModal'));

function PanelLoading() {
  return (
    <div className="glass-panel w-full max-w-4xl mx-auto mt-6 p-6 text-center text-sm text-neutral-400" role="status" aria-live="polite">
      Loading…
    </div>
  );
}

// Fast public test sample links for 1-click testing
const SAMPLE_LINKS = [
  { label: 'YouTube 4K 60fps', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  { label: 'YouTube Music Track', url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk' },
  { label: 'Vimeo Showcase', url: 'https://vimeo.com/76979871' },
  { label: 'Public Domain MP3', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' }
];

const SUPPORTED_PLATFORMS = [
  { name: 'YouTube', href: 'https://www.youtube.com' },
  { name: 'TikTok', href: 'https://www.tiktok.com' },
  { name: 'Douyin 抖音', href: 'https://www.douyin.com' },
  { name: 'Bilibili 哔哩哔哩', href: 'https://www.bilibili.com' },
  { name: 'Instagram', href: 'https://www.instagram.com' },
  { name: 'Facebook', href: 'https://www.facebook.com' },
  { name: 'Vimeo', href: 'https://vimeo.com' },
  { name: 'Pinterest', href: 'https://www.pinterest.com' },
  { name: 'XiaoHongShu 小红书', href: 'https://www.xiaohongshu.com' },
  { name: 'X / Twitter', href: 'https://x.com' },
];

export default function App() {
  const { 
    url, setUrl, 
    provider, setProvider,
    metadata, setMetadata,
    isAnalyzing, setIsAnalyzing,
    activeJobs,
    activeTab, setActiveTab,
    conversionQueue,
    audioStudioSource, setAudioStudioSource,
    pwaInstallPrompt, setPwaInstallPrompt,
    isPwaInstalled, setIsPwaInstalled, triggerInstall,
    preferences, acceptDownloadResponse, recoverDownloads
  } = useAppStore();

  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isPwaModalOpen, setIsPwaModalOpen] = useState(false);
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [batchModalUrls, setBatchModalUrls] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [batchUrlsDetected, setBatchUrlsDetected] = useState<string[]>([]);
  const [isAnalyzingBatch, setIsAnalyzingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 });
  const [busyAction, setBusyAction] = useState<'analyze' | 'direct' | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastAnalyzedUrlRef = useRef<string>('');
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeJobsCount = Object.keys(activeJobs).length;
  useEffect(() => {
    void recoverDownloads();
    const recover = () => { if (!document.hidden) void recoverDownloads(); };
    window.addEventListener('online', recover); window.addEventListener('focus', recover);
    const timer = setInterval(() => { if (useAppStore.getState().activeTab === 'transfers') recover(); }, 30_000);
    return () => { clearInterval(timer); window.removeEventListener('online', recover); window.removeEventListener('focus', recover); };
  }, [recoverDownloads]);
  const navigationHidden = useScrollNavigation(`${activeTab}:${isAnalyzing}`);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'auto' }); }, [activeTab]);

  // ─── SCROLL EXPERIENCE HOOKS (60fps GPU Hardware Acceleration) ─────────────
  const shouldReduceMotion = useReducedMotion();
  const { scrollY, scrollYProgress } = useScroll();

  // Parallax shifts for ambient visual depth (clamped if reduced motion requested)
  const rawOrb1Y = useTransform(scrollYProgress, [0, 1], [0, -120]);
  const rawOrb2Y = useTransform(scrollYProgress, [0, 1], [0, 90]);
  const orb1Y = shouldReduceMotion ? 0 : rawOrb1Y;
  const orb2Y = shouldReduceMotion ? 0 : rawOrb2Y;

  // Subtle header elevation on scroll
  const headerBg = useTransform(scrollY, [0, 60], ['rgba(3, 3, 3, 0.4)', 'rgba(8, 8, 8, 0.88)']);
  const headerBorder = useTransform(scrollY, [0, 60], ['rgba(255, 255, 255, 0.04)', 'rgba(255, 255, 255, 0.1)']);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToastMessage(null), 3000);
  };

  const cancelCurrentRequest = () => {
    requestIdRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  };

  const clearLink = () => {
    if (busyAction === 'direct' || isAnalyzingBatch) return;
    cancelCurrentRequest();
    lastAnalyzedUrlRef.current = '';
    setUrl('');
    setMetadata(null);
    setProvider('unknown');
    setIsAnalyzing(false);
    setAnalyzeError(null);
    setBusyAction(null);
    setBatchUrlsDetected([]);
    setActiveTab('downloader');
    setToastMessage(null);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    window.scrollTo({ top: 0, behavior: shouldReduceMotion ? 'auto' : 'smooth' });
    searchInputRef.current?.focus({ preventScroll: true });
  };

  const detectProvider = useCallback((targetUrl: string): ProviderType => {
    return detectMediaProvider(targetUrl);
  }, []);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawVal = e.target.value;
    // If raw mobile share text with enclosed URL was pasted/typed, cleanly extract
    const extracted = extractMediaUrl(rawVal);
    const val = (extracted && rawVal.includes('http') && rawVal.length > extracted.length + 5) ? extracted : rawVal;
    setUrl(val);
    
    // Check if multiple lines/URLs pasted
    const lines = val.split(/[\r\n\s]+/).filter(s => s.startsWith('http://') || s.startsWith('https://'));
    if (lines.length > 1) {
      setBatchUrlsDetected(lines);
    } else {
      setBatchUrlsDetected([]);
      const detected = detectProvider(val);
      setProvider(detected);
    }
  };

  const analyzeUrl = async (targetUrl: string) => {
    const cleanUrl = extractMediaUrl(targetUrl);
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
      setAnalyzeError('Enter a valid video, audio, or playlist URL to continue.');
      return;
    }
    lastAnalyzedUrlRef.current = cleanUrl;
    cancelCurrentRequest();
    const requestId = requestIdRef.current;
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const timeoutId = window.setTimeout(() => {
      controller.abort(new DOMException('Media analysis timed out. Please retry the link.', 'TimeoutError'));
    }, 90_000);
    setBusyAction('analyze');
    setIsAnalyzing(true);
    setMetadata(null);
    setAnalyzeError(null);
    setBatchUrlsDetected([]);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (requestId !== requestIdRef.current) return;
      
      if (!res.ok) {
        if (data?.provider && data.provider !== 'unknown') {
          setProvider(data.provider as ProviderType);
        }
        throw new Error(data?.error || 'Failed to analyze URL');
      }
      if (typeof data?.title !== 'string' || !Array.isArray(data?.formats)) {
        throw new Error('The extractor returned incomplete media details. Please retry the link.');
      }
      
      setProvider(data.provider as ProviderType);
      setMetadata(data);
      setActiveTab('downloader');
      showToast(`Analyzed: ${(data.title || 'Media').slice(0, 35)}...`);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      if (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return;
      console.error(err);
      const errMsg = controller.signal.reason?.message || err?.message || 'Error analyzing URL';
      setAnalyzeError(errMsg);
      showToast(`⚠️ ${errMsg.slice(0, 45)}`);
      const fallbackProvider = detectProvider(cleanUrl);
      if (fallbackProvider !== 'unknown') {
        setProvider(fallbackProvider);
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === requestIdRef.current) {
        requestControllerRef.current = null;
        setBusyAction(null);
        setIsAnalyzing(false);
      }
    }
  };

  const handleDirectDownload = async (targetUrl?: string) => {
    const raw = targetUrl || url;
    const cleanUrl = extractMediaUrl(raw);
    if (!cleanUrl) return;

    cancelCurrentRequest();
    const requestId = requestIdRef.current;
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const timeoutId = window.setTimeout(() => {
      controller.abort(new DOMException('The download request timed out. Please retry.', 'TimeoutError'));
    }, 45_000);
    setBusyAction('direct');
    setIsAnalyzing(true);
    setAnalyzeError(null);
    showToast("⚡ Starting direct download...");

    try {
      const res = await fetch('/api/queue/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: cleanUrl,
          quality: preferences?.defaultFormat || '1080p',
          type: preferences?.defaultFormat?.startsWith('audio-') ? 'audio' : 'video',
          maxConcurrentDownloads: preferences.maxConcurrentDownloads,
          filenameTemplate: preferences.filenameTemplate,
          filenameQuality: preferences?.defaultFormat || 'best',
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (requestId !== requestIdRef.current) return;
      if (!res.ok) throw new Error(data?.error || 'Failed to start direct download');
      if (typeof data?.jobId !== 'string' || !data.jobId) {
        throw new Error('The server did not confirm the download job. Please retry.');
      }

      acceptDownloadResponse(data);
      setActiveTab('transfers');
      showToast(data.duplicate ? 'Opened the existing transfer for this media and format.' : `Queued: ${(data.title || 'Media').slice(0, 30)}…`);
      setUrl('');
      setMetadata(null);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      if (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return;
      console.error(err);
      const errMsg = controller.signal.reason?.message || err?.message || 'Direct download failed';
      setAnalyzeError(errMsg);
      showToast(`⚠️ ${errMsg.slice(0, 45)}`);
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === requestIdRef.current) {
        requestControllerRef.current = null;
        setBusyAction(null);
        setIsAnalyzing(false);
      }
    }
  };

  useEffect(() => () => {
    requestControllerRef.current?.abort();
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
  }, []);

  // Dynamic Smart Analyze: Automatically analyzes when a valid URL is typed or pasted
  useEffect(() => {
    const clean = extractMediaUrl(url);
    if (!clean || (!clean.startsWith('http://') && !clean.startsWith('https://'))) {
      lastAnalyzedUrlRef.current = '';
      return;
    }
    if (clean.length < 14) return;
    if (isAnalyzing) return;
    if (lastAnalyzedUrlRef.current === clean) return;
    if (metadata && metadata.url === clean) return;
    if (batchUrlsDetected.length > 1) return;

    const timer = setTimeout(() => {
      lastAnalyzedUrlRef.current = clean;
      analyzeUrl(clean);
    }, 650);

    return () => clearTimeout(timer);
  }, [url, metadata?.url, isAnalyzing, batchUrlsDetected.length]);

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      const extracted = extractMediaUrl(trimmed);
      const urlToUse = (extracted && trimmed.includes('http') && trimmed.length > extracted.length + 5) ? extracted : trimmed;
      setUrl(urlToUse);
      
      const lines = trimmed.split(/[\r\n\s]+/).filter(s => s.startsWith('http://') || s.startsWith('https://'));
      if (lines.length > 1) {
        setBatchUrlsDetected(lines);
        showToast(`${lines.length} URLs detected from clipboard!`);
      } else {
        setBatchUrlsDetected([]);
        const detected = detectProvider(urlToUse);
        setProvider(detected);
        if (preferences.autoAnalyzeOnPaste && (urlToUse.startsWith('http') || extracted.startsWith('http'))) {
          analyzeUrl(extracted || urlToUse);
        } else {
          showToast(extracted && extracted !== trimmed ? "Cleaned & pasted URL from share text" : "Pasted URL from clipboard");
        }
      }
    } catch (err) {
      console.warn("Clipboard access denied or unsupported:", err);
      showToast('Clipboard access is unavailable. Paste the link into the input field.');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (batchUrlsDetected.length > 1) {
        handleBatchProcess(batchUrlsDetected);
      } else {
        analyzeUrl(url);
      }
    }
  };

  // Drag and Drop URL handler
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const text = e.dataTransfer.getData('text');
    if (text) {
      const extracted = extractMediaUrl(text.trim());
      const clean = extracted || text.trim();
      setUrl(clean);
      const detected = detectProvider(clean);
      setProvider(detected);
      if (clean.startsWith('http')) {
        analyzeUrl(clean);
      }
    }
  };

  // Batch URLs downloader
  const handleBatchProcess = async (urls: string[]) => {
    if (!urls || urls.length === 0) return;
    setIsAnalyzingBatch(true);
    setAnalyzeError(null);
    setBatchProgress({ completed: 0, total: urls.length });
    const failedUrls: string[] = [];
    let queuedCount = 0;
    let firstError = '';

    try {
      for (const [index, itemUrl] of urls.entries()) {
        let mediaItems;
        try {
          mediaItems = await expandBatchUrl(itemUrl);
          if (!Array.isArray(mediaItems) || mediaItems.length === 0) {
            throw new Error('No downloadable media was found at this URL.');
          }
        } catch (err: any) {
          console.error(`Batch playlist could not be expanded for ${itemUrl}:`, err);
          failedUrls.push(itemUrl);
          if (!firstError) firstError = err?.message || 'Could not read this playlist.';
          setBatchProgress({ completed: index + 1, total: urls.length });
          continue;
        }

        for (const mediaItem of mediaItems) {
          try {
            const preferredFormat = preferences.defaultFormat || 'best';
            const isAudio = String(preferredFormat).startsWith('audio');
            const targetContainer = isAudio
              ? 'mp3'
              : ['mp4', 'mkv', 'webm'].includes(preferences.defaultContainer)
                ? preferences.defaultContainer
                : 'mkv';
            const res = await fetch('/api/queue', {
              method: 'POST',
              signal: AbortSignal.timeout(45_000),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: mediaItem.url,
                itag: preferredFormat,
                title: mediaItem.title || `Batch ${mediaItem.provider.toUpperCase()} Item`,
                thumbnail: mediaItem.thumbnail,
                provider: mediaItem.provider,
                type: isAudio ? 'audio' : 'video',
                targetContainer,
                maxConcurrentDownloads: preferences.maxConcurrentDownloads,
                filenameTemplate: preferences.filenameTemplate,
                filenameQuality: preferredFormat,
              }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'The server rejected this link.');
            if (typeof data?.jobId !== 'string' || !data.jobId) {
              throw new Error('The server did not confirm a download job.');
            }
            useAppStore.getState().acceptDownloadResponse(data);
            queuedCount++;
          } catch (err: any) {
            console.error(`Batch queue failed for ${mediaItem.url}:`, err);
            failedUrls.push(mediaItem.url);
            if (!firstError) firstError = err?.message || 'Could not queue this link.';
          }
        }
        setBatchProgress({ completed: index + 1, total: urls.length });
      }

      setBatchUrlsDetected(failedUrls);
      setUrl('');
      setProvider('unknown');
      if (firstError) setAnalyzeError(`Could not queue ${failedUrls.length} link${failedUrls.length === 1 ? '' : 's'}: ${firstError}`);
      setActiveTab(queuedCount > 0 ? 'transfers' : 'downloader');
      showToast(failedUrls.length > 0
        ? `Queued ${queuedCount} downloads. Failed links are ready to retry.`
        : `Added or reused ${queuedCount} transfer${queuedCount === 1 ? '' : 's'}.`);
    } catch (err: any) {
      console.error('Batch processing stopped unexpectedly:', err);
      setAnalyzeError(err?.message || 'Batch processing stopped. Retry the remaining links.');
      showToast('Batch processing stopped. Your queue may contain completed items.');
    } finally {
      setIsAnalyzingBatch(false);
    }
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: shouldReduceMotion ? 'auto' : 'smooth' });
  };

  // PWA, Network & Keyboard Listeners
  useEffect(() => {
    const standaloneQuery = window.matchMedia('(display-mode: standalone)');
    const syncInstalledState = () => {
      const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
      setIsPwaInstalled(standaloneQuery.matches || iosStandalone);
    };
    syncInstalledState();
    standaloneQuery.addEventListener?.('change', syncInstalledState);

    // 1. Capture PWA beforeinstallprompt
    const handleBeforeInstall = (e: any) => {
      e.preventDefault();
      setPwaInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    // 2. Capture appinstalled
    const handleAppInstalled = () => {
      setIsPwaInstalled(true);
      setPwaInstallPrompt(null);
      showToast("Pullio installed as an app!");
    };
    window.addEventListener('appinstalled', handleAppInstalled);

    // 3. Online / Offline network listeners
    const handleOnline = () => {
      setIsOnline(true);
      showToast("✓ Connection Restored");
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast("⚡ Offline Mode — Serving Cached Shell");
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // 4. Scroll position listener for scroll-to-top button
    const handleScroll = () => {
      if (window.scrollY > 300) {
        setShowScrollTop(true);
      } else {
        setShowScrollTop(false);
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    // 5. Handle PWA Share Target & Query Parameters
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get('url') || params.get('text');
    const tabParam = params.get('tab');

    if (tabParam === 'converter' || tabParam === 'transfers' || tabParam === 'history' || tabParam === 'settings') {
      setActiveTab(tabParam as any);
    }

    if (sharedUrl) {
      const urlMatch = sharedUrl.match(/https?:\/\/[^\s]+/i);
      const target = urlMatch ? urlMatch[0] : sharedUrl;
      if (/^https?:\/\//i.test(target)) {
        setUrl(target);
        setProvider(detectProvider(target));
        analyzeUrl(target);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }

    // 6. Global error handling and keyboard shortcuts
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { name?: string; message?: string } | undefined;
      if (reason?.name === 'AbortError') return;
      console.error('Unhandled Pullio promise rejection:', event.reason);
      showToast('Something unexpected happened. Please retry that action.');
    };
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleAppInstalled);
      standaloneQuery.removeEventListener?.('change', syncInstalledState);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    fetch('/api/queue/config', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrentDownloads: preferences.maxConcurrentDownloads }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || data?.maxConcurrentDownloads !== preferences.maxConcurrentDownloads) {
          throw new Error(data?.error || 'The server did not apply the saved download queue limit.');
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn('Could not apply the saved download queue limit:', error);
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [preferences.maxConcurrentDownloads]);

  useEffect(() => {
    document.documentElement.setAttribute('data-provider', provider);
  }, [provider]);

  return (
      <div className="min-h-screen flex flex-col relative font-sans overflow-x-clip selection:bg-[var(--accent)] selection:text-black bg-[#030303] text-neutral-100">
      
      {/* ─── SCROLL EXPERIENCE: TOP PROGRESS BAR ──────────────────────────── */}
      <motion.div
        style={{ scaleX: scrollYProgress }}
        className="fixed top-0 left-0 right-0 h-[2.5px] bg-gradient-to-r from-[var(--accent)] via-indigo-500 to-purple-500 z-[100] origin-left shadow-[0_0_12px_var(--accent)] pointer-events-none"
      />

      {/* ─── SCROLL EXPERIENCE: PARALLAX AMBIENT GLOWS ─────────────────────── */}
      <motion.div 
        style={{ y: orb1Y }}
        className="hidden sm:block absolute top-[-10vw] right-[-10vw] w-[360px] h-[360px] bg-[var(--accent)]/[0.08] rounded-full blur-[90px] pointer-events-none -z-10 transition-colors duration-200 ease-out transform-gpu will-change-transform"
      />
      <motion.div 
        style={{ y: orb2Y }}
        className="hidden md:block absolute bottom-[-10vw] left-[-10vw] w-[320px] h-[320px] bg-indigo-600/[0.04] rounded-full blur-[80px] pointer-events-none -z-10 transform-gpu will-change-transform"
      />

      {/* ─── OFFLINE NOTIFICATION PILL ─────────────────────────────────────── */}
      {!isOnline && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 bg-amber-500/20 border border-amber-500/40 rounded-full text-amber-300 text-[10px] font-bold uppercase tracking-wider flex items-center gap-2 shadow-2xl backdrop-blur-xl"
        >
          <WifiOff className="size-3.5 text-amber-400 animate-pulse" />
          <span>Offline Mode · Cached PWA Shell Active</span>
        </motion.div>
      )}

      {/* ─── DESKTOP & TABLET HEADER BAR ─────────────────────────────────────── */}
      <motion.header
        data-scroll-hidden={navigationHidden}
        style={{ backgroundColor: headerBg, borderColor: headerBorder }}
        className="app-header sticky top-0 p-3 sm:p-4 md:px-8 lg:px-10 flex justify-between items-center z-40 w-full backdrop-blur-xl border-b"
      >
        <div className="w-full max-w-7xl mx-auto flex justify-between items-center gap-2 sm:gap-4">
          {/* Logo */}
          <button
            type="button"
            onClick={() => { setActiveTab('downloader'); }}
            className="flex items-center gap-2.5 cursor-pointer group shrink-0"
            aria-label="Pullio home"
          >
            <img src="/favicon.svg" alt="" className="size-8 rounded-[8px] shadow-md" width="32" height="32" />
            <span className="text-lg sm:text-xl font-bold tracking-tight">
              Pull<span className="text-[var(--accent)] transition-colors duration-200">io</span>
            </span>
          </button>

          {/* Navigation Tabs Pill (Desktop & Tablet) */}
          <nav aria-label="Main navigation" className="hidden lg:flex items-center bg-black/60 border border-white/10 rounded-[10px] p-1 gap-0.5">
            <button
              onClick={() => setActiveTab('downloader')}
              className={cn(
                "px-2.5 lg:px-3.5 py-1.5 rounded-[8px] text-[11px] lg:text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer",
                activeTab === 'downloader'
                  ? "bg-[var(--accent)] text-[var(--accent-text)] shadow"
                  : "text-neutral-400 hover:text-white"
              )}
              title="Downloader"
            >
              <Sparkles className="size-3.5" />
              <span className="hidden lg:inline">Downloader</span>
            </button>

            <button
              onClick={() => setActiveTab('converter')}
              className={cn(
                "px-2.5 lg:px-3.5 py-1.5 rounded-[8px] text-[11px] lg:text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer relative",
                activeTab === 'converter'
                  ? "bg-[var(--accent)] text-[var(--accent-text)] shadow"
                  : "text-neutral-400 hover:text-white"
              )}
              title="Converter"
            >
              <Repeat className="size-3.5" />
              <span className="hidden lg:inline">Converter</span>
              {conversionQueue.length > 0 && (
                <span className="ml-0.5 lg:ml-1 px-1.5 py-0.2 rounded-full text-[9px] bg-indigo-500 text-white font-mono font-bold">
                  {conversionQueue.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('transfers')}
              className={cn(
                "px-2.5 lg:px-3.5 py-1.5 rounded-[8px] text-[11px] lg:text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer relative",
                activeTab === 'transfers'
                  ? "bg-[var(--accent)] text-[var(--accent-text)] shadow"
                  : "text-neutral-400 hover:text-white"
              )}
              title="Transfers"
            >
              <DownloadCloud className="size-3.5" />
              <span className="hidden lg:inline">Transfers</span>
              {activeJobsCount > 0 && (
                <span className="ml-0.5 lg:ml-1 px-1.5 py-0.2 rounded-full text-[9px] bg-red-500 text-white font-mono font-bold animate-pulse">
                  {activeJobsCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className={cn(
                "px-2.5 lg:px-3.5 py-1.5 rounded-[8px] text-[11px] lg:text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer",
                activeTab === 'history'
                  ? "bg-[var(--accent)] text-[var(--accent-text)] shadow"
                  : "text-neutral-400 hover:text-white"
              )}
              title="History"
            >
              <History className="size-3.5" />
              <span className="hidden lg:inline">History</span>
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={cn(
                "px-2.5 lg:px-3.5 py-1.5 rounded-[8px] text-[11px] lg:text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer",
                activeTab === 'settings'
                  ? "bg-[var(--accent)] text-[var(--accent-text)] shadow"
                  : "text-neutral-400 hover:text-white"
              )}
              title="Settings"
            >
              <SettingsIcon className="size-3.5" />
              <span className="hidden lg:inline">Settings</span>
            </button>
          </nav>

          {/* Header Action Buttons: Batch, PWA Install & Engine Modal */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              onClick={() => { setBatchModalUrls([]); setIsBatchModalOpen(true); }}
              className="flex items-center gap-1.5 py-1.5 px-2.5 sm:px-3 bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white border border-white/10 rounded-[8px] text-xs font-bold uppercase tracking-wider transition-all cursor-pointer"
              title="Open Multi-URL Batch Downloader"
            >
              <Layers className="size-3.5 text-[var(--accent)]" />
              <span className="hidden sm:inline">Batch</span>
            </button>

            {!isPwaInstalled && (
              <button
                onClick={() => setIsPwaModalOpen(true)}
                className="hidden xl:flex items-center gap-1.5 py-1.5 px-3 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-500/40 rounded-[8px] text-xs font-bold uppercase tracking-wider transition-all cursor-pointer"
              >
                <Smartphone className="size-3.5" /> Install PWA
              </button>
            )}

            <button 
              onClick={() => setIsAboutOpen(true)}
              className="hover:text-white transition-all cursor-pointer font-bold uppercase tracking-wider text-xs flex items-center gap-1.5 py-1.5 px-2.5 sm:px-3 bg-white/5 border border-white/10 rounded-[8px] text-gray-400"
              title="Engine Information"
            >
              <Info className="size-3.5 text-[var(--accent)] transition-colors duration-700" />
              <span className="hidden sm:inline">Engine</span>
            </button>
          </div>
        </div>
      </motion.header>

      {/* ─── MAIN CONTENT ────────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col items-center justify-start px-4 w-full min-w-0 z-10 pb-12 lg:pb-20 pt-4 max-w-7xl mx-auto">
        {activeTab === 'converter' && (
          <div className="w-full">
            <Suspense fallback={<PanelLoading />}><ConverterPanel /></Suspense>
          </div>
        )}

        {activeTab === 'transfers' && (
          <div className="w-full">
            <Suspense fallback={<PanelLoading />}><DownloadProgress /></Suspense>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="w-full">
            <Suspense fallback={<PanelLoading />}><HistoryPanel /></Suspense>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="w-full">
            <Suspense fallback={<PanelLoading />}><SettingsPanel /></Suspense>
          </div>
        )}

        {activeTab === 'downloader' && (
          <>
            {/* Hero Section with Scroll Reveal */}
            <AnimatePresence mode="wait">
              {!metadata && !isAnalyzing && (
                <motion.div 
                  key="hero" 
                  initial={{ opacity: 0, y: 15 }} 
                  animate={{ opacity: 1, y: 0 }} 
                  exit={{ opacity: 0, y: -15, scale: 0.98 }} 
                  transition={{ ease: [0.16, 1, 0.3, 1], duration: 0.35 }}
                  className="text-center w-full max-w-4xl pt-4 sm:pt-8 pb-3"
                >
                  <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold tracking-tighter mb-3 text-white leading-tight">
                    Download Media <span className="text-[var(--accent)] transition-colors duration-200">Instantly</span>
                  </h1>
                  <p className="text-gray-400 text-xs sm:text-base md:text-lg mb-6 max-w-xl mx-auto leading-relaxed">
                    Universal video &amp; audio extractor. Supports YouTube, TikTok, Douyin (抖音), Instagram, Facebook, Bilibili, Vimeo, Pinterest, XiaoHongShu (小红书), and X.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Smart Search Bar Container */}
            <motion.div 
              className={cn(
                "w-full transition-[max-width,margin] duration-200 ease-out z-20",
                metadata || isAnalyzing ? "max-w-3xl" : "max-w-2xl mt-0"
              )}
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragOver(false);
      }}
              onDrop={handleDrop}
            >
              <div className="relative group">
                <div 
                  className="absolute inset-0 bg-[var(--accent)]/[0.08] blur-xl rounded-[10px] transition-opacity duration-200 opacity-75 pointer-events-none transform-gpu"
                  style={{
                    boxShadow: `0 0 40px 10px rgba(var(--accent-rgb), 0.15)`,
                  }}
                ></div>
                
                <div className={cn(
                  "relative bg-[#0b0b0b]/90 border rounded-[10px] p-1.5 sm:p-2 flex items-center transition-[border-color,box-shadow] duration-150",
                  isDragOver ? "border-[var(--accent)] scale-[1.01]" : "border-white/10"
                )}>
                  <div className="pl-3 pr-1 sm:pl-4 sm:pr-2 text-neutral-400 shrink-0">
                    <Link2 className="size-5 text-[var(--accent)] transition-colors duration-700" />
                  </div>
                  
                  <input 
                    ref={searchInputRef}
                    type="url" 
                    placeholder="Paste video, audio or playlist URL (press / to focus)..." 
                    className="flex-1 bg-transparent border-none outline-none text-white text-xs sm:text-base placeholder:text-neutral-500 py-2 px-1 sm:px-2 appearance-none min-w-0" 
                    value={url} 
                    onChange={handleUrlChange} 
                    onKeyDown={handleKeyDown} 
                    disabled={isAnalyzing}
                  />
                  
                  {(url || metadata || batchUrlsDetected.length > 0 || analyzeError) && (
                    <button 
                      onClick={clearLink}
                      title="Clear link and return to the downloader home"
                      aria-label="Clear link and return to the downloader home"
                      disabled={busyAction === 'direct' || isAnalyzingBatch}
                      className="p-1 sm:p-2 text-neutral-500 hover:text-white transition-colors text-xs sm:text-sm shrink-0 mr-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ✕
                    </button>
                  )}

                  <div className="pr-1 flex items-center gap-1.5 sm:gap-2 shrink-0">
                    {url && (!metadata || url !== metadata.url) && batchUrlsDetected.length === 0 && (
                      <div className="flex items-center gap-1.5 sm:gap-2">
                        <button 
                          onClick={() => handleDirectDownload(url)}
                          disabled={isAnalyzing}
                          className="h-9 sm:h-10 px-3 sm:px-4 bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold transition-all flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer disabled:opacity-50 shadow-md rounded-[8px]"
                          title="1-Click Direct Download (Best 1080p MP4)"
                        >
                          <Zap className="size-4 fill-black" />
                          <span className="hidden sm:inline">Direct</span>
                        </button>

                        <button 
                          onClick={() => analyzeUrl(url)}
                          disabled={isAnalyzing}
                          className="h-9 sm:h-10 px-3.5 sm:px-6 bg-[var(--accent)] text-[var(--accent-text)] font-bold transition-all flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm cursor-pointer hover:opacity-90 disabled:opacity-50 btn-accent shadow-lg"
                        >
                          {isAnalyzing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                          Analyze
                        </button>
                      </div>
                    )}

                    {!url && (
                      <div className="flex items-center gap-1.5">
                        <button 
                          onClick={() => { setBatchModalUrls([]); setIsBatchModalOpen(true); }}
                          className="h-9 sm:h-10 px-3 sm:px-4 rounded-[8px] bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white text-xs sm:text-sm font-bold transition-all flex items-center gap-1.5 cursor-pointer border border-white/5"
                          title="Open Multi-URL Batch Downloader"
                        >
                          <Layers className="size-3.5 text-[var(--accent)]" />
                          Batch
                        </button>
                        <button 
                          onClick={handlePaste} 
                          className="h-9 sm:h-10 px-3.5 sm:px-6 rounded-[8px] bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-bold transition-all flex items-center gap-1.5 sm:gap-2 cursor-pointer"
                        >
                          Paste
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Sample Link Quick Pills (Helpful for instant testing) */}
              {!metadata && !isAnalyzing && !url && (
                <div className="mt-3 flex items-center justify-center flex-wrap gap-2 text-[11px] text-gray-500">
                  <span className="flex items-center gap-1">
                    <Compass className="size-3 text-[var(--accent)]" /> Try test links:
                  </span>
                  {SAMPLE_LINKS.map(s => (
                    <button
                      key={s.label}
                      onClick={() => {
                        setUrl(s.url);
                        setProvider(detectProvider(s.url));
                        analyzeUrl(s.url);
                      }}
                      className="px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white border border-white/5 transition-all cursor-pointer font-medium"
                    >
                      {s.label}
                    </button>
                  ))}
                  <p className="basis-full text-center text-[10px] text-gray-600 mt-0.5">
                    Paste a link, choose a format, then save the file. Use Batch for multiple links.
                  </p>
                </div>
              )}

              {/* Multi-URL / Batch Detected Notification */}
              {batchUrlsDetected.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-3 p-4 rounded-[10px] bg-white/5 border border-white/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2.5">
                    <Layers className="size-5 text-[var(--accent)] shrink-0" />
                    <div>
                      <h4 className="text-xs font-bold text-white">
                        Batch URLs Detected ({batchUrlsDetected.length} Link{batchUrlsDetected.length === 1 ? '' : 's'})
                      </h4>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        {batchUrlsDetected.length === 1
                          ? 'This link could not be queued. Retry it or customize its output.'
                          : 'Some links could not be queued. Retry them or customize their output.'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <button
                      onClick={() => {
                        setBatchModalUrls(batchUrlsDetected);
                        setIsBatchModalOpen(true);
                      }}
                      className="flex-1 sm:flex-none px-3.5 py-2 rounded-[8px] bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5"
                    >
                      <Sparkles className="size-3.5 text-[var(--accent)]" />
                      Customize
                    </button>
                    <button
                      onClick={() => handleBatchProcess(batchUrlsDetected)}
                      disabled={isAnalyzingBatch}
                      className="flex-1 sm:flex-none px-4 py-2 rounded-[8px] bg-[var(--accent)] text-[var(--accent-text)] text-xs font-bold uppercase tracking-wider btn-accent transition-all cursor-pointer shrink-0 disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-md"
                    >
                      {isAnalyzingBatch ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                      {isAnalyzingBatch ? `Queueing ${batchProgress.completed}/${batchProgress.total}` : 'Download All'}
                    </button>
                  </div>
                  {isAnalyzingBatch && (
                    <div className="basis-full w-full h-1 bg-white/10 rounded-full overflow-hidden" role="status" aria-live="polite">
                      <motion.div
                        className="h-full bg-[var(--accent)]"
                        initial={{ width: 0 }}
                        animate={{ width: `${batchProgress.total ? (batchProgress.completed / batchProgress.total) * 100 : 0}%` }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                      />
                    </div>
                  )}
                </motion.div>
              )}

              {/* Inline Analysis Error Banner with Actionable Recovery */}
              {analyzeError && !isAnalyzing && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-3 p-3.5 rounded-[10px] bg-red-950/40 border border-red-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-start gap-2.5 text-red-300 min-w-0 flex-1">
                    <AlertCircle className="size-4 text-red-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="leading-relaxed font-medium">{analyzeError}</p>
                      <p className="text-[10px] text-red-200/70 mt-1 leading-relaxed">{getMediaErrorGuidance(analyzeError)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto justify-end">
                    {mediaErrorNeedsCookies(analyzeError) && (
                      <button
                        onClick={() => {
                          setActiveTab('settings');
                          setAnalyzeError(null);
                        }}
                        className="px-3 py-1.5 rounded-[6px] bg-[var(--accent)] text-[var(--accent-text)] text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 shadow-md btn-accent"
                      >
                        <SettingsIcon className="size-3" />
                        Configure Cookies
                      </button>
                    )}
                    <button
                      onClick={() => setAnalyzeError(null)}
                      className="px-2.5 py-1 text-gray-400 hover:text-white text-xs cursor-pointer"
                    >
                      Dismiss
                    </button>
                    {url && (
                      <button
                        onClick={() => analyzeUrl(url)}
                        className="px-3 py-1.5 rounded-[6px] bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/30 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1"
                      >
                        Try Again
                      </button>
                    )}
                  </div>
                </motion.div>
              )}
            </motion.div>

            {/* Analyzing Indicator */}
            <AnimatePresence mode="wait">
               {isAnalyzing && (
                 <motion.div 
                   initial={{ opacity: 0, y: 12 }} 
                   animate={{ opacity: 1, y: 0 }} 
                   exit={{ opacity: 0 }} 
                   className="flex flex-col items-center text-[var(--accent)] py-6"
                   role="status"
                   aria-live="polite"
                 >
                   <Loader2 className="size-8 animate-spin mb-3 text-[var(--accent)]" />
                   <p className="font-mono text-xs uppercase tracking-widest text-neutral-400">Extracting available media streams…</p>
                 </motion.div>
               )}
            </AnimatePresence>

            {/* Analyze Panel (Single or Playlist) */}
            <AnimatePresence mode="wait">
              {metadata && !isAnalyzing && (
                <motion.div
                  key={metadata.url}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: shouldReduceMotion ? 0 : 0.22, ease: 'easeOut' }}
                  className="w-full"
                >
                  <Suspense fallback={<PanelLoading />}><AnalyzePanel /></Suspense>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </main>

      {/* ─── NATIVE MOBILE BOTTOM NAVIGATION BAR (Phones) ──────────────────────── */}
      <nav aria-label="Mobile and tablet navigation" data-scroll-hidden={navigationHidden} className="app-bottom-nav lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#080808]/95 backdrop-blur-lg border-t border-white/10 px-1 py-1.5 flex items-center justify-around shadow-2xl safe-area-pb">
        <button
          onClick={() => setActiveTab('downloader')}
          className={cn(
            "flex flex-col items-center justify-center gap-1 py-1 px-2 min-h-[44px] rounded-[8px] transition-all cursor-pointer flex-1",
            activeTab === 'downloader' ? "text-[var(--accent)] font-bold" : "text-gray-400 hover:text-white"
          )}
        >
          <Sparkles className="size-5" />
          <span className="text-[10px] tracking-wider uppercase font-semibold">Download</span>
        </button>

        <button
          onClick={() => setActiveTab('converter')}
          className={cn(
            "flex flex-col items-center justify-center gap-1 py-1 px-2 min-h-[44px] rounded-[8px] transition-all cursor-pointer relative flex-1",
            activeTab === 'converter' ? "text-[var(--accent)] font-bold" : "text-gray-400 hover:text-white"
          )}
        >
          <div className="relative">
            <Repeat className="size-5" />
            {conversionQueue.length > 0 && (
              <span className="absolute -top-1 -right-2 px-1 py-0.2 rounded-full text-[8px] bg-indigo-500 text-white font-mono font-bold">
                {conversionQueue.length}
              </span>
            )}
          </div>
          <span className="text-[10px] tracking-wider uppercase font-semibold">Convert</span>
        </button>

        <button
          onClick={() => setActiveTab('transfers')}
          className={cn(
            "flex flex-col items-center justify-center gap-1 py-1 px-2 min-h-[44px] rounded-[8px] transition-all cursor-pointer relative flex-1",
            activeTab === 'transfers' ? "text-[var(--accent)] font-bold" : "text-gray-400 hover:text-white"
          )}
        >
          <div className="relative">
            <DownloadCloud className="size-5" />
            {activeJobsCount > 0 && (
              <span className="absolute -top-1 -right-2 px-1.5 py-0.2 rounded-full text-[8px] bg-red-500 text-white font-mono font-bold animate-pulse">
                {activeJobsCount}
              </span>
            )}
          </div>
          <span className="text-[10px] tracking-wider uppercase font-semibold">Transfers</span>
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={cn(
            "flex flex-col items-center justify-center gap-1 py-1 px-2 min-h-[44px] rounded-[8px] transition-all cursor-pointer flex-1",
            activeTab === 'history' ? "text-[var(--accent)] font-bold" : "text-gray-400 hover:text-white"
          )}
        >
          <History className="size-5" />
          <span className="text-[10px] tracking-wider uppercase font-semibold">History</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={cn(
            "flex flex-col items-center justify-center gap-1 py-1 px-2 min-h-[44px] rounded-[8px] transition-all cursor-pointer flex-1",
            activeTab === 'settings' ? "text-[var(--accent)] font-bold" : "text-gray-400 hover:text-white"
          )}
        >
          <SettingsIcon className="size-5" />
          <span className="text-[10px] tracking-wider uppercase font-semibold">Settings</span>
        </button>
      </nav>

      {/* ─── SCROLL EXPERIENCE: FLOATING SCROLL TO TOP BUTTON ───────────────── */}
      <AnimatePresence>
        {showScrollTop && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={scrollToTop}
            className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] lg:bottom-8 right-4 z-40 p-2.5 rounded-full bg-black/80 hover:bg-black border border-white/15 text-white shadow-2xl backdrop-blur-xl transition-colors cursor-pointer hover:border-[var(--accent)]"
            title="Scroll to top"
            aria-label="Scroll to top"
          >
            <ArrowUp className="size-4 text-[var(--accent)]" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ─── RESPONSIVE FOOTER ───────────────────────────────────────────────── */}
      <footer className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-10 pt-4 pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-6 z-10" aria-label="Site footer">
        <div className="rounded-2xl border border-white/10 bg-white/[0.025] px-4 py-2 sm:px-6 sm:py-6">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(15rem,1fr)] gap-2 sm:gap-6 lg:gap-10">
            <FooterGroup title="Supported platforms" detail="10 platforms · video & audio">
              <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
                {SUPPORTED_PLATFORMS.map((platform) => (
                  <a
                    key={platform.name}
                    href={platform.href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center min-h-11 sm:min-h-9 rounded-lg sm:rounded-full border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] sm:text-xs font-semibold text-neutral-400 transition-colors hover:border-[var(--accent)]/40 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    {platform.name}
                  </a>
                ))}
              </div>
            </FooterGroup>

            <div className="border-t border-white/10 pt-2 sm:pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
              <FooterGroup title="Media tools" detail="Download, convert & enhance">
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Video & audio', action: () => { setActiveTab('downloader'); scrollToTop(); } },
                    { label: 'Batch downloads', action: () => { setBatchModalUrls([]); setIsBatchModalOpen(true); } },
                    { label: 'File converter', action: () => { setActiveTab('converter'); scrollToTop(); } },
                    { label: 'Audio studio', action: () => { setActiveTab('converter'); scrollToTop(); showToast('Add a file, then choose Enhance audio to open the studio.'); } },
                  ].map((tool) => <button key={tool.label} type="button" onClick={tool.action} className="min-h-11 rounded-lg border border-white/10 px-3 py-2 text-left text-xs text-neutral-300 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">{tool.label}</button>)}
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">Powered by yt-dlp &amp; FFmpeg.</p>
              </FooterGroup>
            </div>
          </div>
          <div className="mt-3 sm:mt-5 border-t border-white/10 pt-3 pb-2 sm:pb-0 flex flex-col sm:flex-row gap-1 sm:justify-between text-[10px] leading-relaxed text-neutral-500"><span>Use content you own or have permission to save.</span><span>&copy; {new Date().getFullYear()} Pullio</span></div>
        </div>
      </footer>

      {/* Interactive Toast Notification */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] lg:bottom-8 right-1/2 translate-x-1/2 lg:translate-x-0 lg:right-8 z-50 px-4 py-2.5 rounded-[10px] bg-black/90 border border-white/15 text-white text-xs font-bold shadow-2xl backdrop-blur-lg flex items-center gap-2 pointer-events-none max-w-[calc(100vw-2rem)]"
          >
            <Sparkles className="size-3.5 text-[var(--accent)]" />
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Engine Info Modal */}
      {isAboutOpen && (
        <Suspense fallback={null}>
          <AboutModal isOpen onClose={() => setIsAboutOpen(false)} />
        </Suspense>
      )}

      {/* PWA Install Sheet Modal */}
      {isPwaModalOpen && (
        <Suspense fallback={null}>
          <PwaInstallModal isOpen onClose={() => setIsPwaModalOpen(false)} />
        </Suspense>
      )}

      {/* Customizable Multi-Video Batch Downloader Modal */}
      {audioStudioSource && (
        <Suspense fallback={<PanelLoading />}>
          <AudioEnhancerStudio source={audioStudioSource} onClose={() => setAudioStudioSource(null)} />
        </Suspense>
      )}
      <BatchDownloadModal 
        isOpen={isBatchModalOpen} 
        onClose={() => setIsBatchModalOpen(false)} 
        initialUrls={batchModalUrls} 
      />
    </div>
  );
}
