import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from 'motion/react';
import { AudioLines, Download, Loader2, RotateCcw, X, AlertCircle, Check } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { validateMediaUpload } from '../lib/security';
import { AudioPreviewGraph, setAudioPlaybackSettings } from '../lib/audioPreview';
import { AUDIO_EXPORT_QUALITIES, DEFAULT_AUDIO_ENHANCEMENT, AudioEnhancementSettings, AudioExportFormat, AudioSourceReference, AudioStudioSource, getAudioCleanupSignature, hasAudioCleanup, getAudioToneSettings, validateAudioEnhancement } from '../lib/audioEnhancement';

const PRESET_KEY = 'pullio.audio-studio.preset.v1';
const studioSections = [{ id: 'cleanup', label: 'Clean up' }, { id: 'tone', label: 'Tone & level' }, { id: 'export', label: 'Export' }] as const;
function readSavedPreset(): AudioEnhancementSettings | null {
  try {
    const stored = localStorage.getItem(PRESET_KEY);
    return stored ? validateAudioEnhancement(JSON.parse(stored)) : null;
  } catch { return null; }
}

type StudioJob = { jobId: string; status: string; progress: number; eta?: string; outputFileName?: string; outputFileSize?: string; outputBytes?: number; duration?: number };
type Preparation = { phase: 'uploading' | 'preparing' | 'ready' | 'failed'; progress: number; error?: string };
type AppliedCleanup = { jobId: string; url: string; signature: string };
type CleanupProgress = { phase: 'off' | 'waiting' | 'processing' | 'ready' | 'failed'; progress: number; error?: string };
const cleanupEffects = [
  { toggle: 'noiseRemoval', intensity: 'noiseIntensity', label: 'Noise reduction', description: 'Adaptive denoising for steady hiss and background noise.' },
  { toggle: 'humRemoval', intensity: 'humIntensity', label: 'Hum removal', description: 'Reduce electrical buzz and its harmonics.' },
  { toggle: 'noiseGate', intensity: 'gateIntensity', label: 'Quiet pauses', description: 'Lower background sound between words.' },
  { toggle: 'clickRemoval', intensity: 'clickIntensity', label: 'Click cleanup', description: 'Repair short clicks, pops, and crackle.' },
  { toggle: 'deEss', intensity: 'deEssIntensity', label: 'Soften sibilance', description: 'Tame sharp “s” and “sh” sounds.' },
] as const;
const effects = [
  { toggle: 'voiceFocus', intensity: 'voiceIntensity', label: 'Voice focus', description: 'Bring speech forward with EQ.' },
  { toggle: 'bassBoost', intensity: 'bassIntensity', label: 'Bass boost', description: 'Add warmth and low-end weight.' },
  { toggle: 'clarity', intensity: 'clarityIntensity', label: 'Clarity', description: 'Balance brightness and dynamics.' },
] as const;

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}

async function startStudioJob(route: string, payload: unknown, signal: AbortSignal) {
  const response = await fetch(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || (response.status === 404 ? 'Restart the Pullio server to enable the updated Audio Studio.' : 'Could not start audio processing.'));
  if (typeof data?.jobId !== 'string') throw new Error('The server did not confirm this audio job.');
  return data.jobId as string;
}

async function waitForStudioJob(jobId: string, signal: AbortSignal, onProgress: (job: StudioJob) => void): Promise<StudioJob> {
  const deadline = Date.now() + 20 * 60 * 1000;
  let connectionFailures = 0;
  while (!signal.aborted && Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetch(`/api/convert/status/${encodeURIComponent(jobId)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      connectionFailures = 0;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (++connectionFailures >= 3) throw new Error('The audio server stopped responding. Check your connection and retry.');
      await delay(connectionFailures * 1500, signal);
      continue;
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || 'This audio job is unavailable. Try again.');
    if (data?.job?.jobId !== jobId || !['queued', 'converting', 'completed', 'failed', 'cancelled'].includes(data.job.status)) {
      throw new Error('The server returned an invalid audio job status.');
    }
    onProgress(data.job);
    if (data.job.status === 'completed') return data.job;
    if (data.job.status === 'failed' || data.job.status === 'cancelled') throw new Error(data.job.error || 'Audio processing was cancelled.');
    await delay(700, signal);
  }
  if (signal.aborted) throw signal.reason;
  throw new Error('Audio processing timed out. Try a shorter file or retry.');
}

function deleteStudioJob(jobId: string, uploadId?: string) {
  const suffix = uploadId ? `?uploadId=${encodeURIComponent(uploadId)}` : '';
  return fetch(`/api/convert/${encodeURIComponent(jobId)}${suffix}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
}

function uploadStudioFile(file: File, signal: AbortSignal, onProgress: (progress: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const validation = validateMediaUpload(file);
    if (!validation.valid) { reject(new Error(validation.error)); return; }
    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', cancel);
    xhr.open('POST', '/api/convert/upload');
    xhr.timeout = 15 * 60 * 1000;
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => { cleanup(); reject(new Error('Audio upload failed. Check your connection and retry.')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('Audio upload timed out. Retry with a smaller file.')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled.', 'AbortError')); };
    xhr.onload = () => {
      cleanup();
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(data?.error || 'Could not upload audio.');
        if (!/^[a-f0-9]{32}$/i.test(data?.files?.[0]?.uploadId || '')) throw new Error('The server did not confirm the uploaded source.');
        resolve(data.files[0].uploadId);
      } catch (error) { reject(error); }
    };
    const body = new FormData();
    body.append('files', file);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', cancel, { once: true });
    xhr.send(body);
  });
}

export default function AudioEnhancerStudio({ source, onClose }: { source: AudioStudioSource; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<AudioPreviewGraph | null>(null);
  const sourceRef = useRef<AudioSourceReference | null>(null);
  const ownedUploadRef = useRef<string | null>(null);
  const exportControllerRef = useRef<AbortController | null>(null);
  const exportJobRef = useRef<string | null>(null);
  const cleanupControllerRef = useRef<AbortController | null>(null);
  const cleanupJobIdsRef = useRef(new Set<string>());
  const pendingCleanupIdRef = useRef<string | null>(null);
  const appliedCleanupRef = useRef<AppliedCleanup | null>(null);
  const playbackRestoreRef = useRef<{ time: number; resume: boolean } | null>(null);
  const reduceMotion = useReducedMotion();
  const [settings, setSettings] = useState<AudioEnhancementSettings>({ ...DEFAULT_AUDIO_ENHANCEMENT });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [bypass, setBypass] = useState(false);
  const bypassRef = useRef(bypass);
  bypassRef.current = bypass;
  const [playing, setPlaying] = useState(false);
  const [preparation, setPreparation] = useState<Preparation>({ phase: 'preparing', progress: 0 });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [appliedCleanup, setAppliedCleanup] = useState<AppliedCleanup | null>(null);
  const [cleanupProgress, setCleanupProgress] = useState<CleanupProgress>({ phase: 'off', progress: 0 });
  const [cleanupAttempt, setCleanupAttempt] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [format, setFormat] = useState<AudioExportFormat>('mp3');
  const [quality, setQuality] = useState('320k');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<StudioJob | null>(null);
  const [exportResult, setExportResult] = useState<StudioJob | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [section, setSection] = useState<(typeof studioSections)[number]['id']>('cleanup');
  const [savedPreset, setSavedPreset] = useState(readSavedPreset);
  const [presetMessage, setPresetMessage] = useState('');
  const ready = preparation.phase === 'ready';
  const cleanupSignature = getAudioCleanupSignature(settings);
  const cleanupWanted = hasAudioCleanup(settings);
  const cleanupMatches = !cleanupWanted || appliedCleanup?.signature === cleanupSignature;
  const activePreviewUrl = bypass ? previewUrl : appliedCleanup?.url || previewUrl;
  useEffect(() => { contentRef.current?.scrollTo({ top: 0, behavior: 'auto' }); }, [section]);

  const rememberPlayback = () => {
    const audio = audioRef.current;
    if (audio) playbackRestoreRef.current = { time: audio.currentTime, resume: !audio.paused };
  };

  const clearRetiredCleanupJobs = () => {
    for (const id of cleanupJobIdsRef.current) {
      if (id === appliedCleanupRef.current?.jobId || id === pendingCleanupIdRef.current) continue;
      cleanupJobIdsRef.current.delete(id);
      void deleteStudioJob(id);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      audioRef.current?.pause();
      graphRef.current?.close();
      graphRef.current = null;
      exportControllerRef.current?.abort();
      cleanupControllerRef.current?.abort();
      for (const id of cleanupJobIdsRef.current) void deleteStudioJob(id);
      cleanupJobIdsRef.current.clear();
      if (exportJobRef.current) void deleteStudioJob(exportJobRef.current);
      if (ownedUploadRef.current) void deleteStudioJob(crypto.randomUUID(), ownedUploadRef.current);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const previewJobId = crypto.randomUUID();
    setPlaying(false);
    graphRef.current?.close();
    graphRef.current = null;
    setPreviewUrl(null);
    sourceRef.current = null;
    appliedCleanupRef.current = null;
    setAppliedCleanup(null);
    playbackRestoreRef.current = null;
    for (const id of cleanupJobIdsRef.current) void deleteStudioJob(id);
    cleanupJobIdsRef.current.clear();
    setPreviewError(null);
    setPreparation({ phase: source.kind === 'local' && !ownedUploadRef.current ? 'uploading' : 'preparing', progress: 0 });
    const prepare = async () => {
      try {
        let reference: AudioSourceReference;
        if (source.kind === 'local') {
          const id = ownedUploadRef.current || await uploadStudioFile(source.file, controller.signal, (progress) => {
            if (!controller.signal.aborted) setPreparation({ phase: 'uploading', progress });
          });
          ownedUploadRef.current = id;
          if (controller.signal.aborted) { void deleteStudioJob(crypto.randomUUID(), id); return; }
          reference = { kind: 'upload', id };
        } else reference = { kind: source.kind, id: source.id };
        sourceRef.current = reference;
        setPreparation({ phase: 'preparing', progress: 0 });
        const id = await startStudioJob('/api/audio/prepare', { jobId: previewJobId, source: reference }, controller.signal);
        await waitForStudioJob(id, controller.signal, (job) => setPreparation({ phase: 'preparing', progress: job.progress }));
        if (controller.signal.aborted) return;
        setPreviewUrl(`/api/audio/preview/${encodeURIComponent(id)}`);
        setPreparation({ phase: 'ready', progress: 100 });
      } catch (error) {
        if (!controller.signal.aborted) {
          if (source.kind === 'local' && ownedUploadRef.current) {
            void deleteStudioJob(crypto.randomUUID(), ownedUploadRef.current);
            ownedUploadRef.current = null;
          }
          setPreparation({ phase: 'failed', progress: 0, error: error instanceof Error ? error.message : 'Could not prepare audio.' });
        }
      }
    };
    void prepare();
    return () => { controller.abort(); void deleteStudioJob(previewJobId); };
  }, [source, prepareAttempt]);

  useEffect(() => {
    if (!previewUrl) return;
    const keepAlive = () => {
      for (const url of [previewUrl, appliedCleanup?.url].filter(Boolean)) {
        void fetch(url!, { method: 'HEAD', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      }
    };
    const timer = setInterval(keepAlive, 60_000);
    return () => clearInterval(timer);
  }, [previewUrl, appliedCleanup?.url]);

  useEffect(() => {
    if (!ready || !sourceRef.current) return;
    if (!cleanupWanted) {
      if (appliedCleanupRef.current) {
        if (!bypassRef.current) rememberPlayback();
        appliedCleanupRef.current = null;
        setAppliedCleanup(null);
        if (bypassRef.current) clearRetiredCleanupJobs();
      }
      setCleanupProgress({ phase: 'off', progress: 0 });
      return;
    }
    if (appliedCleanupRef.current?.signature === cleanupSignature) {
      setCleanupProgress({ phase: 'ready', progress: 100 });
      return;
    }
    const controller = new AbortController();
    cleanupControllerRef.current = controller;
    const jobId = crypto.randomUUID();
    const reference = { ...sourceRef.current };
    const snapshot = { ...settingsRef.current };
    setCleanupProgress({ phase: 'waiting', progress: 0 });
    const timer = setTimeout(async () => {
      cleanupJobIdsRef.current.add(jobId);
      pendingCleanupIdRef.current = jobId;
      try {
        setCleanupProgress({ phase: 'processing', progress: 0 });
        await startStudioJob('/api/audio/cleanup-preview', { source: reference, settings: snapshot, jobId }, controller.signal);
        await waitForStudioJob(jobId, controller.signal, (job) => setCleanupProgress({ phase: 'processing', progress: job.progress }));
        if (controller.signal.aborted) return;
        if (!bypassRef.current) rememberPlayback();
        const applied = { jobId, url: `/api/audio/preview/${encodeURIComponent(jobId)}`, signature: cleanupSignature };
        appliedCleanupRef.current = applied;
        pendingCleanupIdRef.current = null;
        setAppliedCleanup(applied);
        setCleanupProgress({ phase: 'ready', progress: 100 });
        if (bypassRef.current) clearRetiredCleanupJobs();
      } catch (error) {
        if (!controller.signal.aborted) {
          setCleanupProgress({ phase: 'failed', progress: 0, error: error instanceof Error ? error.message : 'Could not update the cleanup preview.' });
          void deleteStudioJob(jobId);
          cleanupJobIdsRef.current.delete(jobId);
        }
      } finally {
        if (pendingCleanupIdRef.current === jobId) pendingCleanupIdRef.current = null;
      }
    }, 700);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (cleanupControllerRef.current === controller) cleanupControllerRef.current = null;
      if (pendingCleanupIdRef.current === jobId) pendingCleanupIdRef.current = null;
      if (appliedCleanupRef.current?.jobId !== jobId) {
        cleanupJobIdsRef.current.delete(jobId);
        void deleteStudioJob(jobId);
      }
    };
  }, [ready, source, cleanupSignature, cleanupWanted, cleanupAttempt]);

  useEffect(() => {
    if (audioRef.current) {
      setAudioPlaybackSettings(audioRef.current, bypass ? 1 : settings.speed, bypass || settings.keepPitch);
    }
    graphRef.current?.apply(settings, bypass);
  }, [settings, bypass]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const data = new Uint8Array(512);
    let frame = 0;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffffff';
    const draw = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineWidth = 2;
      context.strokeStyle = color;
      context.beginPath();
      if (playing && graphRef.current && !reduceMotion) {
        graphRef.current.analyser.getByteTimeDomainData(data);
        for (let i = 0; i < data.length; i++) {
          const x = i * canvas.width / (data.length - 1);
          const y = (data[i] / 255) * canvas.height;
          if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
      } else { context.moveTo(0, canvas.height / 2); context.lineTo(canvas.width, canvas.height / 2); }
      context.stroke();
      if (playing && !reduceMotion) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [playing, reduceMotion, previewUrl]);

  const startPreview = async () => {
    if (!audioRef.current) return;
    try {
      if (!graphRef.current) graphRef.current = new AudioPreviewGraph(audioRef.current);
      graphRef.current.apply(settings, bypass);
      await graphRef.current.resume();
      setPreviewError(null);
      setPlaying(true);
    } catch (error) {
      audioRef.current.pause();
      setPreviewError(error instanceof Error ? error.message : 'Could not start the audio preview.');
    }
  };

  const setComparison = (original: boolean) => {
    if (original !== bypass) rememberPlayback();
    setBypass(original);
  };

  const update = <K extends keyof AudioEnhancementSettings>(key: K, value: AudioEnhancementSettings[K]) => {
    if (bypass) setComparison(false);
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const applyCleanupPreset = (preset: 'speech' | 'hiss' | 'hum') => {
    if (bypass) setComparison(false);
    setSettings((current) => ({
      ...getAudioToneSettings(current),
      noiseRemoval: preset !== 'hum', noiseIntensity: preset === 'speech' ? 70 : 55,
      humRemoval: preset === 'hum', humIntensity: 85,
      noiseGate: preset === 'speech', gateIntensity: 55,
      clickRemoval: preset === 'speech', clickIntensity: 40,
      deEss: preset === 'speech', deEssIntensity: 35,
    }));
  };

  const restorePlayback = () => {
    const audio = audioRef.current;
    const restore = playbackRestoreRef.current;
    playbackRestoreRef.current = null;
    if (audio) {
      setAudioPlaybackSettings(audio, bypassRef.current ? 1 : settingsRef.current.speed, bypassRef.current || settingsRef.current.keepPitch);
      if (restore && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(restore.time, Math.max(0, audio.duration - 0.01));
        if (restore.resume) void audio.play().catch(() => setPreviewError('Press Play to continue listening to the updated preview.'));
      }
    }
    clearRetiredCleanupJobs();
  };

  const exportAudio = async () => {
    if (exportControllerRef.current || !sourceRef.current || !cleanupMatches) return;
    const controller = new AbortController();
    const jobId = crypto.randomUUID();
    exportControllerRef.current = controller;
    exportJobRef.current = jobId;
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    setExportProgress({ jobId, status: 'queued', progress: 0 });
    try {
      await startStudioJob('/api/audio/enhance', { jobId, source: sourceRef.current, settings, format, quality }, controller.signal);
      const result = await waitForStudioJob(jobId, controller.signal, setExportProgress);
      if (controller.signal.aborted) return;
      setExportResult(result);
      const store = useAppStore.getState();
      store.addConversionItems([{
        id: jobId, fileName: result.outputFileName || `audio_enhanced.${format}`, fileSize: result.outputBytes || 0,
        fileSizeFormatted: result.outputFileSize || 'Ready', sourceExt: format, mediaType: 'audio',
        options: { targetFormat: format, qualityPreset: quality }, status: 'completed',
        uploadProgress: 100, convertProgress: 100, convertedFileName: result.outputFileName,
        convertedFileSize: result.outputFileSize, duration: result.duration, downloadUrl: `/api/convert/download/${jobId}`,
      }]);
      exportJobRef.current = null;
      const anchor = document.createElement('a');
      anchor.href = `/api/convert/download/${encodeURIComponent(jobId)}`;
      anchor.download = result.outputFileName || '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      void deleteStudioJob(jobId);
      if (!controller.signal.aborted) setExportError(error instanceof Error ? error.message : 'Audio export failed.');
    } finally {
      if (exportControllerRef.current === controller) {
        exportControllerRef.current = null;
        exportJobRef.current = null;
        setExporting(false);
      }
    }
  };

  const cancelExport = () => {
    exportControllerRef.current?.abort();
    if (exportJobRef.current) void deleteStudioJob(exportJobRef.current);
  };

  const savePreset = () => {
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(settings));
      setSavedPreset({ ...settings });
      setPresetMessage('Your preset is saved on this device.');
    } catch { setPresetMessage('This browser could not save your preset. Your current settings are still available.'); }
  };

  const controlClass = 'w-full min-w-0 rounded-lg border border-white/15 bg-[var(--bg-base)] px-3 py-2.5 text-sm text-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]';

  const renderEffect = (effect: (typeof cleanupEffects)[number] | (typeof effects)[number]) => (
    <div key={effect.toggle} className={`p-4 rounded-xl border ${settings[effect.toggle] ? 'border-[var(--accent)]/40 bg-[var(--accent)]/5' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex items-start justify-between gap-3">
        <div><label htmlFor={`effect-${effect.toggle}`} className="text-sm font-bold text-white">{effect.label}</label><p className="text-xs text-neutral-400 mt-1 leading-relaxed">{effect.description}</p></div>
        <input id={`effect-${effect.toggle}`} type="checkbox" role="switch" checked={settings[effect.toggle]} onChange={(event) => update(effect.toggle, event.target.checked)} className="size-5 shrink-0 accent-[var(--accent)] mt-0.5" />
      </div>
      <div className="flex justify-between items-center mt-4 mb-2 text-xs text-neutral-400"><label htmlFor={`intensity-${effect.toggle}`}>Intensity</label><output htmlFor={`intensity-${effect.toggle}`}>{settings[effect.intensity]}%</output></div>
      <input id={`intensity-${effect.toggle}`} type="range" min={0} max={100} step={1} value={settings[effect.intensity]} disabled={!settings[effect.toggle]} onChange={(event) => update(effect.intensity, Number(event.target.value))} className="audio-studio-range w-full accent-[var(--accent)] disabled:opacity-30" aria-label={`${effect.label} intensity`} />
      {effect.toggle === 'humRemoval' && <div className="mt-2"><label htmlFor="hum-frequency" className="block text-xs text-neutral-400 mb-1">Power frequency</label><select id="hum-frequency" className={controlClass} value={settings.humFrequency} disabled={!settings.humRemoval} onChange={(event) => update('humFrequency', Number(event.target.value) as 50 | 60)}><option value={50}>50 Hz</option><option value={60}>60 Hz</option></select></div>}
    </div>
  );

  return createPortal(
    <dialog ref={dialogRef} onCancel={(event) => { event.preventDefault(); onClose(); }} aria-labelledby="audio-studio-title" className="audio-studio-dialog">
      <div className="audio-studio-surface">
        <header className="audio-studio-header shrink-0 bg-[var(--studio-surface)] flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--accent)] font-bold mb-1">Pullio / Audio studio</p>
            <h2 id="audio-studio-title" className="text-lg font-bold text-white flex items-center gap-2"><AudioLines className="size-5 shrink-0" /> Shape your sound</h2>
            <p className="text-xs text-neutral-400 mt-1 break-words">{source.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close audio studio" className="p-2.5 rounded-lg text-neutral-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"><X className="size-5" /></button>
        </header>
        <div className="px-4 pt-3 sm:px-6 shrink-0">
          <section aria-label="Audio preview" className="rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            {!ready ? (
              <div className="flex flex-col items-center gap-3 py-5 text-center" role={preparation.phase === 'failed' ? 'alert' : 'status'}>
                {preparation.phase === 'failed' ? <AlertCircle className="size-6 text-red-300" /> : <Loader2 className="size-6 text-[var(--accent)] animate-spin" />}
                <p className="text-sm text-neutral-200">{preparation.error || `${preparation.phase === 'uploading' ? 'Uploading source' : 'Preparing compatible audio preview'} · ${Math.round(preparation.progress)}%`}</p>
                {preparation.phase === 'failed' && <button onClick={() => setPrepareAttempt((attempt) => attempt + 1)} className="px-4 py-2 rounded-lg border border-white/20 text-sm text-white hover:bg-white/10">Try again</button>}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                  <span className="text-xs text-neutral-400">{bypass ? (playing ? 'Listening to original' : 'Original selected') : !cleanupMatches ? (appliedCleanup ? 'Previous cleanup · updating' : 'Original audio · cleanup pending') : (playing ? 'Listening with your settings' : 'Preview your settings')}</span>
                  <button type="button" aria-pressed={bypass} onClick={() => setComparison(!bypass)} className={`px-3 py-2 rounded-lg text-xs font-bold border ${bypass ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-white/15 text-neutral-200'} focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]`}>Compare original</button>
                </div>
                <canvas ref={canvasRef} width={960} height={70} aria-hidden="true" className="w-full h-7 sm:h-10" />
                <audio key={previewUrl} ref={audioRef} src={activePreviewUrl!} controls controlsList="nodownload" preload="metadata" onLoadedMetadata={restorePlayback} onPlay={() => void startPreview()} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setPreviewError('The preview is unavailable or expired. Prepare it again to continue listening.')} className="w-full h-11 mt-2" aria-label="Audio preview player" />
                {cleanupWanted && (
                  <div className="mt-3 text-xs space-y-2" role={cleanupProgress.phase === 'failed' ? 'alert' : 'status'}>
                    {cleanupProgress.phase === 'waiting' || cleanupProgress.phase === 'processing' ? <>
                      <p className="flex items-center gap-2 text-neutral-300"><Loader2 className="size-3.5 animate-spin shrink-0" />{cleanupProgress.phase === 'waiting' ? 'Waiting for your adjustments' : `Updating cleanup preview · ${Math.round(cleanupProgress.progress)}%`}</p>
                      <progress className="w-full h-1.5 accent-[var(--accent)]" max={100} value={cleanupProgress.progress} aria-label="Cleanup preview progress" />
                      <button type="button" onClick={() => setSettings((current) => getAudioToneSettings(current))} className="underline text-neutral-400">Cancel cleanup</button>
                    </> : cleanupProgress.phase === 'failed' ? <><p className="text-red-300">{cleanupProgress.error}</p><button type="button" onClick={() => setCleanupAttempt((attempt) => attempt + 1)} className="underline text-neutral-300">Retry cleanup preview</button></> : cleanupMatches && <p className="flex items-center gap-2 text-neutral-300"><Check className="size-3.5 text-[var(--accent)]" />Cleanup preview ready · compare to hear the difference</p>}
                  </div>
                )}
                {previewError && <div role="alert" className="text-xs text-red-300 mt-3"><p>{previewError}</p><button className="underline mt-2" onClick={() => setPrepareAttempt((attempt) => attempt + 1)}>Prepare preview again</button></div>}
              </>
            )}
          </section>
        </div>
        <div role="tablist" aria-label="Audio studio sections" className="grid grid-cols-3 gap-1 border-b border-white/10 px-4 pt-3 sm:px-6 shrink-0">
          {studioSections.map((item, index) => <button key={item.id} type="button" role="tab" id={`studio-tab-${item.id}`} aria-controls={`studio-panel-${item.id}`} aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => setSection(item.id)} onKeyDown={(event) => {
            const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? studioSections.length - 1 : (index + offset + studioSections.length) % studioSections.length;
            if (offset || event.key === 'Home' || event.key === 'End') {
              event.preventDefault(); setSection(studioSections[next].id);
              document.getElementById(`studio-tab-${studioSections[next].id}`)?.focus();
            }
          }} className={`min-h-11 px-2 py-2.5 text-xs sm:text-sm font-semibold border-b-2 transition-colors ${section === item.id ? 'border-[var(--accent)] text-white' : 'border-transparent text-neutral-400 hover:text-white'}`}>{item.label}</button>)}
        </div>
        <div ref={contentRef} className="audio-studio-content p-4 sm:px-6">
          <fieldset disabled={exporting} className="min-w-0 space-y-4 disabled:opacity-60">
            <legend className="sr-only">Audio enhancement and export settings</legend>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex gap-2 flex-wrap">
                <button type="button" onClick={savePreset} className="text-xs px-3 min-h-10 rounded-lg border border-white/15 text-neutral-200 hover:bg-white/5">Save my preset</button>
                {savedPreset && <button type="button" onClick={() => { setSettings({ ...savedPreset }); setComparison(false); setPresetMessage('Your saved preset is applied.'); }} className="text-xs px-3 min-h-10 rounded-lg border border-white/15 text-neutral-200 hover:bg-white/5">Use my preset</button>}
              </div>
              <button type="button" onClick={() => { setSettings({ ...DEFAULT_AUDIO_ENHANCEMENT }); setComparison(false); }} className="text-xs text-neutral-300 flex items-center gap-1.5 px-2 py-2 rounded-lg hover:bg-white/5"><RotateCcw className="size-3.5" /> Reset</button>
            </div>
            {presetMessage && <p role="status" className="text-xs text-neutral-400">{presetMessage}</p>}
            <section role="tabpanel" id="studio-panel-cleanup" aria-labelledby="studio-tab-cleanup" hidden={section !== 'cleanup'} className="space-y-4">
            <p className="text-xs text-neutral-400 leading-relaxed">Cleanup updates automatically after you stop adjusting. Wait for “Cleanup preview ready” before comparing. Tone and speed controls stay live.</p>
            <div className="flex flex-wrap gap-2" aria-label="Audio cleanup presets">
              <button type="button" onClick={() => applyCleanupPreset('speech')} className="px-3 py-2 rounded-lg border border-white/15 text-xs text-neutral-200 hover:bg-white/5">Clean speech</button>
              <button type="button" onClick={() => applyCleanupPreset('hiss')} className="px-3 py-2 rounded-lg border border-white/15 text-xs text-neutral-200 hover:bg-white/5">Background hiss</button>
              <button type="button" onClick={() => applyCleanupPreset('hum')} className="px-3 py-2 rounded-lg border border-white/15 text-xs text-neutral-200 hover:bg-white/5">Electrical hum</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{cleanupEffects.map(renderEffect)}</div>
            <p className="text-[11px] text-neutral-400 leading-relaxed">Start with moderate strength. Strong denoising can soften speech; strong pause cleanup can cut quiet words. Match hum removal to the recording’s 50 or 60 Hz power frequency.</p>
            </section>
            <section role="tabpanel" id="studio-panel-tone" aria-labelledby="studio-tab-tone" hidden={section !== 'tone'} className="space-y-4">
            <div className="rounded-xl border border-white/10 p-4 space-y-3">
              <div className="flex justify-between items-start gap-3"><div><label htmlFor="audio-leveling" className="text-sm font-bold text-white">Loudness leveling</label><p className="text-xs text-neutral-400 mt-1">Balance overall loudness before tone and gain. Updates the processed preview.</p></div><input id="audio-leveling" type="checkbox" role="switch" checked={settings.normalizeLoudness} onChange={(event) => update('normalizeLoudness', event.target.checked)} className="size-5 shrink-0 accent-[var(--accent)]" /></div>
              <label htmlFor="audio-loudness-target" className="block text-xs text-neutral-400">Loudness target</label>
              <select id="audio-loudness-target" disabled={!settings.normalizeLoudness} value={settings.loudnessTarget} onChange={(event) => update('loudnessTarget', Number(event.target.value) as -14 | -16 | -23)} className={controlClass}><option value={-16}>Balanced · −16 LUFS</option><option value={-14}>Louder · −14 LUFS</option><option value={-23}>Broadcast · −23 LUFS</option></select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {effects.map(renderEffect)}
            </div>
            <div className="rounded-xl border border-white/10 p-4 space-y-3">
              <div className="flex justify-between gap-3"><label htmlFor="audio-output-gain" className="text-sm font-bold text-white">Output gain · live</label><output htmlFor="audio-output-gain" className="text-xs text-neutral-300 font-mono">{settings.outputGain > 0 ? '+' : ''}{settings.outputGain.toFixed(1)} dB</output></div>
              <input id="audio-output-gain" type="range" min={-12} max={12} step={0.5} value={settings.outputGain} onChange={(event) => update('outputGain', Number(event.target.value))} className="audio-studio-range w-full accent-[var(--accent)]" />
              <p className="text-xs text-neutral-400">Adjust the final level. A safety limiter protects peaks; large boosts can reduce dynamics.</p>
            </div>
            <div className="rounded-xl border border-white/10 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap"><label htmlFor="audio-studio-speed" className="text-sm font-bold text-white">Playback speed <span className="ml-2 text-[var(--accent)] font-mono">{settings.speed.toFixed(2)}×</span></label><div className="flex gap-1.5 flex-wrap">{[0.75, 1, 1.25, 1.5].map((speed) => <button type="button" key={speed} onClick={() => update('speed', speed)} aria-pressed={settings.speed === speed} className={`rounded-md border px-2 py-1.5 text-xs ${settings.speed === speed ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-white/10 text-neutral-300'}`}>{speed}×</button>)}</div></div>
              <input id="audio-studio-speed" type="range" min={0.5} max={2} step={0.05} value={settings.speed} onChange={(event) => update('speed', Number(event.target.value))} className="audio-studio-range w-full accent-[var(--accent)]" />
              <label className="flex items-center gap-2 text-xs text-neutral-300"><input type="checkbox" checked={settings.keepPitch} onChange={(event) => update('keepPitch', event.target.checked)} className="size-4 accent-[var(--accent)]" /> Keep original pitch</label>
            </div>
            <p className="text-[11px] leading-relaxed text-neutral-400">Voice focus uses EQ rather than separating vocals from music. Clarity changes tone and dynamics; it cannot restore lost detail. Preview and export may sound slightly different.</p>
            </section>
            <section role="tabpanel" id="studio-panel-export" aria-labelledby="studio-tab-export" hidden={section !== 'export'} className="space-y-4">
            <p className="text-xs leading-relaxed text-neutral-400">Choose a format and quality, then export. You can keep listening while the file processes.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><label htmlFor="audio-export-format" className="block text-xs text-neutral-400 mb-2">Export format</label><select id="audio-export-format" value={format} onChange={(event) => { const next = event.target.value as AudioExportFormat; setFormat(next); setQuality(AUDIO_EXPORT_QUALITIES[next][0].value); }} className={controlClass}>{Object.keys(AUDIO_EXPORT_QUALITIES).map((item) => <option key={item} value={item}>{item === 'm4a' ? 'M4A (AAC)' : item.toUpperCase()}</option>)}</select></div>
              <div><label htmlFor="audio-export-quality" className="block text-xs text-neutral-400 mb-2">Quality</label><select id="audio-export-quality" value={quality} onChange={(event) => setQuality(event.target.value)} className={controlClass}>{AUDIO_EXPORT_QUALITIES[format].map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
            </div>
            <p className="text-xs leading-relaxed text-neutral-400">MP3 works almost everywhere. M4A packages AAC for easy playback; AAC exports a raw ADTS file. OGG uses Vorbis; Opus is efficient for speech and music. WAV and FLAC preserve the processed audio without adding lossy compression.</p>
            <p className="text-xs leading-relaxed text-neutral-400">Exports process the original source and appear in your converter queue. Closing the studio during export cancels that export.</p>
            </section>
          </fieldset>
        </div>
          <footer className="audio-studio-export shrink-0 border-t border-white/10 px-4 py-3 sm:px-6 space-y-2 bg-[var(--studio-surface)]">
            {exporting ? (
              <div role="status" className="space-y-3">
                <div className="flex justify-between items-center gap-3 text-xs text-neutral-200"><span>{exportProgress?.status === 'queued' ? 'Waiting in conversion queue' : 'Exporting audio'} · {Math.round(exportProgress?.progress || 0)}%</span><button type="button" onClick={cancelExport} className="px-3 py-2 rounded-lg border border-white/20">Cancel export</button></div>
                <progress className="w-full h-1.5 accent-[var(--accent)]" max={100} value={exportProgress?.progress || 0} aria-label="Audio export progress" />
              </div>
            ) : <button type="button" onClick={() => void exportAudio()} disabled={!ready || !cleanupMatches} className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 bg-[var(--accent)] text-[var(--accent-text)] text-sm font-bold btn-accent disabled:opacity-40 disabled:cursor-not-allowed"><Download className="size-4" /> {!cleanupMatches ? 'Waiting for cleanup preview' : `Export enhanced ${format.toUpperCase()}`}</button>}
            {exportError && <p role="alert" className="text-xs text-red-300 flex items-start gap-2"><AlertCircle className="size-4 shrink-0" />{exportError}</p>}
            {exportResult && <div role="status" className="rounded-lg border border-white/15 p-3 text-xs text-neutral-300 space-y-2"><p className="flex items-center gap-2"><Check className="size-4 text-[var(--accent)]" /> Export ready; also saved in your converter queue.</p><a href={`/api/convert/download/${encodeURIComponent(exportResult.jobId)}`} download className="inline-flex gap-2 items-center text-[var(--accent)] underline break-all">Save {exportResult.outputFileName || 'enhanced audio'} ({exportResult.outputFileSize})</a></div>}
            {exporting && <p className="text-[11px] text-neutral-400">Closing the studio cancels this export.</p>}
          </footer>
      </div>
    </dialog>, document.body
  );
}
