import { useCallback, useEffect, useState } from 'react';
import { Cpu, RefreshCw, Loader2, CheckCircle2, AlertTriangle, HardDrive } from 'lucide-react';

interface EngineInfo {
  ytDlp: { available: boolean; version: string | null; ageDays: number | null };
  ffmpeg: { available: boolean; version: string | null };
  node: string;
  app: string;
  platform: string;
  updating: boolean;
  disk: { freeBytes: number; totalBytes: number } | null;
  activeDownloads: number;
  lastUpdate: { at: number; ok: boolean; message: string } | null;
}

/** yt-dlp releases often; extractors older than this commonly fail on YouTube and TikTok. */
const STALE_AFTER_DAYS = 45;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

export default function EngineStatusCard() {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError?: boolean } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/engine', { signal: signal ?? AbortSignal.timeout(20_000), cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ytDlp) throw new Error(data?.error || 'Engine status is unavailable.');
      setEngine(data);
      setLoadError(null);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      setLoadError(error instanceof Error ? error.message : 'Engine status is unavailable.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleUpdate = async () => {
    setIsUpdating(true);
    setMessage(null);
    try {
      const response = await fetch('/api/engine/update', { method: 'POST', signal: AbortSignal.timeout(200_000) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || data?.message || 'The engine update did not finish.');
      setMessage({ text: data?.message || 'The engine is up to date.' });
    } catch (error) {
      setMessage({
        text: error instanceof Error && error.name === 'TimeoutError' ? 'The update is taking longer than expected. Check again in a minute.' : error instanceof Error ? error.message : 'The engine update did not finish.',
        isError: true,
      });
    } finally {
      setIsUpdating(false);
      void load();
    }
  };

  const age = engine?.ytDlp.ageDays ?? null;
  const stale = age !== null && age > STALE_AFTER_DAYS;
  const busy = isUpdating || engine?.updating;
  const diskLow = engine?.disk ? engine.disk.freeBytes < 2 * 1024 ** 3 : false;

  return (
    <div className="p-5 rounded-[12px] bg-white/5 border border-white/10 flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="size-9 rounded-[8px] bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)] shrink-0">
            <Cpu className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Download Engine</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">Sites change often. Keep yt-dlp current to avoid failed or blocked downloads.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleUpdate()}
          disabled={Boolean(busy) || !engine?.ytDlp.available}
          className="px-3.5 py-2 rounded-[8px] bg-[var(--accent)] text-[var(--accent-text)] text-xs font-bold uppercase tracking-wider btn-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 min-h-[36px] shrink-0"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {busy ? 'Updating…' : 'Check for update'}
        </button>
      </div>

      {loadError && !engine && <p className="text-[11px] text-red-300" role="alert">{loadError}</p>}

      {engine && (
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
          <div className="p-3 rounded-[8px] bg-black/40 border border-white/5">
            <dt className="text-gray-500 font-bold uppercase tracking-wider text-[9px]">yt-dlp</dt>
            <dd className="mt-1 font-mono text-white flex items-center gap-1.5">
              {engine.ytDlp.version || 'Not found'}
              {engine.ytDlp.available && (stale
                ? <AlertTriangle className="size-3.5 text-amber-400" aria-hidden="true" />
                : <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden="true" />)}
            </dd>
            {age !== null && <dd className={stale ? 'text-amber-300 mt-0.5' : 'text-gray-500 mt-0.5'}>{age === 0 ? 'Released today' : `Released ${age} day${age === 1 ? '' : 's'} ago`}{stale ? ' · update recommended' : ''}</dd>}
          </div>
          <div className="p-3 rounded-[8px] bg-black/40 border border-white/5">
            <dt className="text-gray-500 font-bold uppercase tracking-wider text-[9px]">FFmpeg</dt>
            <dd className="mt-1 font-mono text-white truncate" title={engine.ffmpeg.version || undefined}>{engine.ffmpeg.version || 'Not found'}</dd>
            <dd className="text-gray-500 mt-0.5">Node {engine.node} · Pullio {engine.app}</dd>
          </div>
          <div className="p-3 rounded-[8px] bg-black/40 border border-white/5">
            <dt className="text-gray-500 font-bold uppercase tracking-wider text-[9px] flex items-center gap-1"><HardDrive className="size-3" aria-hidden="true" /> Storage</dt>
            <dd className={`mt-1 font-mono ${diskLow ? 'text-amber-300' : 'text-white'}`}>{engine.disk ? `${formatBytes(engine.disk.freeBytes)} free` : 'Unknown'}</dd>
            <dd className="text-gray-500 mt-0.5">{engine.disk ? `of ${formatBytes(engine.disk.totalBytes)}${diskLow ? ' · running low' : ''}` : engine.platform}</dd>
          </div>
        </dl>
      )}

      {engine && engine.activeDownloads > 0 && !busy && (
        <p className="text-[10px] text-gray-500">Updating waits until active downloads are paused or finished.</p>
      )}
      {message && (
        <p className={`text-[11px] ${message.isError ? 'text-red-300' : 'text-emerald-300'}`} role={message.isError ? 'alert' : 'status'}>{message.text}</p>
      )}
    </div>
  );
}
