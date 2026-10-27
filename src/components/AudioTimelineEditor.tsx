import React, { useEffect, useId, useMemo, useState } from 'react';
import { Repeat2, RotateCcw } from 'lucide-react';
import { AudioEditSettings, AudioLoopRange, DEFAULT_AUDIO_EDIT, MIN_AUDIO_SELECTION, fitAudioEdit, fitAudioLoop, formatAudioTime } from '../lib/audioEditing';

function TimeField({ label, value, min = 0, max, onChange }: { label: string; value: number; min?: number; max: number; onChange: (value: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value.toFixed(2));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!focused) setDraft(value.toFixed(2)); }, [value, focused]);
  const commit = () => {
    if (draft === value.toFixed(2)) { setFocused(false); setError(''); return; }
    const next = Number(draft);
    if (!draft.trim() || !Number.isFinite(next) || next < min - 0.0050001 || next > max + 0.0050001) {
      setError(`Enter ${min.toFixed(2)}–${max.toFixed(2)} seconds.`);
      setDraft(value.toFixed(2));
    } else { setError(''); onChange(Math.max(min, Math.min(max, next))); }
    setFocused(false);
  };
  return <div className="min-w-0">
    <label htmlFor={id} className="block text-xs text-neutral-300 mb-2">{label} <span className="text-neutral-500">(seconds)</span></label>
    <input id={id} type="number" inputMode="decimal" step="0.01" min={Number(min.toFixed(2))} max={Number(max.toFixed(2))} value={draft} onFocus={() => setFocused(true)} onChange={(event) => { setDraft(event.target.value); setError(''); }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} className="w-full min-w-0 min-h-11 rounded-lg border border-white/15 bg-[var(--bg-base)] px-3 py-2 text-sm text-white font-mono" />
    {error && <p id={`${id}-error`} role="alert" className="text-xs text-red-300 mt-1">{error}</p>}
  </div>;
}

export default function AudioTimelineEditor({ duration, currentTime, peaks, waveformStatus, edit, speed, loop, loopEnabled, onEdit, onLoop, onLoopEnabled, onSeek, onRetryWaveform }: {
  duration: number; currentTime: number; peaks: number[]; waveformStatus: 'loading' | 'ready' | 'failed';
  edit: AudioEditSettings; speed: number; loop: AudioLoopRange; loopEnabled: boolean;
  onEdit: (edit: AudioEditSettings) => void; onLoop: (range: AudioLoopRange) => void;
  onLoopEnabled: (enabled: boolean) => void; onSeek: (time: number) => void; onRetryWaveform: () => void;
}) {
  const end = edit.trimEnd ?? duration;
  const outputDuration = Math.max(0, end - edit.trimStart) / speed;
  const gap = Math.min(MIN_AUDIO_SELECTION, duration);
  const selectedLoop = fitAudioLoop(loop, edit, duration);
  const update = (next: Partial<AudioEditSettings>) => onEdit(fitAudioEdit({ ...edit, ...next }, duration, speed));
  const percentage = (time: number) => duration > 0 ? Math.max(0, Math.min(100, time / duration * 100)) : 0;
  const path = useMemo(() => {
    const maximum = Math.max(0.01, ...peaks);
    return peaks.map((peak, index) => {
      const x = (index + 0.5) * 800 / peaks.length;
      const height = Math.max(1, Math.sqrt(peak / maximum) * 38);
      return `M${x.toFixed(1)},${(48 - height).toFixed(1)}v${(height * 2).toFixed(1)}`;
    }).join('');
  }, [peaks]);
  const setHandle = (side: 'start' | 'end', time: number) => update(side === 'start'
    ? { trimStart: Math.max(0, Math.min(end - gap, time)) }
    : { trimEnd: Math.max(edit.trimStart + gap, Math.min(duration, time)) });
  const chooseLoop = (seconds?: number) => {
    const length = Math.min(seconds ?? end - edit.trimStart, end - edit.trimStart);
    const start = seconds === undefined ? edit.trimStart : Math.max(edit.trimStart, Math.min(currentTime, end - length));
    onLoop({ start, end: start + length }); onLoopEnabled(true); onSeek(start);
  };
  return <div className="space-y-5">
    <section aria-label="Trim selection" className="rounded-xl border border-white/10 p-3 sm:p-4 space-y-4">
      <div className="flex justify-between items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1 basis-44"><h3 className="text-sm font-bold text-white">Keep the part you want</h3><p className="mt-1 text-xs text-neutral-400 leading-relaxed">Drag the edges or enter exact times. Tap the waveform to seek.</p></div>
        <button type="button" onClick={() => onEdit({ ...DEFAULT_AUDIO_EDIT })} className="inline-flex items-center gap-1.5 min-h-10 px-2 text-xs text-neutral-300 rounded-lg hover:bg-white/5"><RotateCcw className="size-3.5" />Reset clip</button>
      </div>
      <div className="px-5">
        <div className="audio-edit-waveform relative h-28 select-none" role="group" aria-label="Audio trim waveform">
          <div className="absolute inset-0 rounded-lg border border-white/10 overflow-hidden bg-black/30">
            <svg viewBox="0 0 800 96" preserveAspectRatio="none" aria-hidden="true" className="w-full h-full text-neutral-500"><path d={path || 'M0,48H800'} stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
            <div aria-hidden="true" className="absolute inset-y-0 bg-[var(--accent)]/10 border-y border-[var(--accent)]/50" style={{ left: `${percentage(edit.trimStart)}%`, right: `${100 - percentage(end)}%` }} />
            {(edit.fadeIn > 0 || edit.fadeOut > 0) && <svg viewBox="0 0 800 96" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 w-full h-full text-[var(--accent)] pointer-events-none"><path d={`M${percentage(edit.trimStart) * 8},${edit.fadeIn > 0 ? 94 : 3}L${percentage(edit.trimStart + edit.fadeIn * speed) * 8},3L${percentage(end - edit.fadeOut * speed) * 8},3L${percentage(end) * 8},${edit.fadeOut > 0 ? 94 : 3}`} stroke="currentColor" strokeWidth="2" fill="none" /></svg>}
            {loopEnabled && <div aria-hidden="true" className="absolute bottom-0 h-1 bg-indigo-300" style={{ left: `${percentage(selectedLoop.start)}%`, width: `${percentage(selectedLoop.end - selectedLoop.start)}%` }} />}
            <div aria-hidden="true" className="absolute inset-y-0 w-px bg-[var(--accent)] pointer-events-none" style={{ left: `${percentage(currentTime)}%` }} />
            <button type="button" aria-label="Seek to the middle of the audio waveform" className="absolute inset-0 cursor-crosshair" onClick={(event) => {
              if (event.detail === 0) { onSeek((edit.trimStart + end) / 2); return; }
              const rect = event.currentTarget.getBoundingClientRect(); onSeek(Math.max(edit.trimStart, Math.min(end, (event.clientX - rect.left) / rect.width * duration)));
            }} />
          </div>
          {(['start', 'end'] as const).map((side) => <button key={side} type="button" role="slider" aria-label={`Trim ${side} handle`} aria-valuemin={side === 'start' ? 0 : edit.trimStart + gap} aria-valuemax={side === 'start' ? end - gap : duration} aria-valuenow={side === 'start' ? edit.trimStart : end} aria-valuetext={formatAudioTime(side === 'start' ? edit.trimStart : end)} aria-orientation="horizontal" className="audio-edit-handle absolute inset-y-0 w-11 -translate-x-1/2 touch-none cursor-ew-resize flex items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]" style={{ left: `${percentage(side === 'start' ? edit.trimStart : end)}%` }}
            onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const rect = event.currentTarget.parentElement!.getBoundingClientRect(); setHandle(side, (event.clientX - rect.left) / rect.width * duration);
            }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
            onKeyDown={(event) => {
              const value = side === 'start' ? edit.trimStart : end;
              const step = event.shiftKey ? 1 : 0.1;
              const next = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? value + step : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? value - step : event.key === 'Home' ? 0 : event.key === 'End' ? duration : null;
              if (next !== null) { event.preventDefault(); setHandle(side, next); }
            }}><span aria-hidden="true" className="w-2.5 h-full rounded-sm bg-[var(--accent)] border border-black/40 flex justify-center items-center"><span className="h-5 w-px bg-[var(--accent-text)]" /></span></button>)}
        </div>
      </div>
      {waveformStatus !== 'ready' && <p role="status" className="text-xs text-neutral-400">{waveformStatus === 'loading' ? 'Loading waveform… Time controls are ready to use.' : <>Waveform unavailable. Time controls still work. <button type="button" onClick={onRetryWaveform} className="underline min-h-9">Retry waveform</button></>}</p>}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3">
        <div><TimeField label="Trim start" value={edit.trimStart} max={Math.max(0, end - gap)} onChange={(time) => update({ trimStart: time })} /><button type="button" onClick={() => setHandle('start', currentTime)} className="text-xs text-neutral-400 min-h-10 underline">Set start from playhead</button></div>
        <div><TimeField label="Trim end" value={end} min={edit.trimStart + gap} max={duration} onChange={(time) => update({ trimEnd: time })} /><button type="button" onClick={() => setHandle('end', currentTime)} className="text-xs text-neutral-400 min-h-10 underline">Set end from playhead</button></div>
      </div>
      <p className="text-xs text-neutral-300 font-mono break-words">{formatAudioTime(edit.trimStart)} → {formatAudioTime(end)} <span className="text-neutral-500">· Export {formatAudioTime(outputDuration)} at {speed.toFixed(2)}×</span></p>
    </section>

    <section aria-label="Audio fades" className="rounded-xl border border-white/10 p-3 sm:p-4 space-y-4">
      <h3 className="text-sm font-bold text-white">A smooth beginning &amp; ending</h3>
      <div className="flex gap-2 flex-wrap" aria-label="Fade presets">{[0, 0.5, 1, 2].map((seconds) => <button type="button" key={seconds} onClick={() => update({ fadeIn: seconds, fadeOut: seconds })} className="min-h-10 px-3 rounded-lg border border-white/15 text-xs text-neutral-300 hover:bg-white/5">{seconds ? `${seconds} sec each` : 'No fades'}</button>)}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {(['fadeIn', 'fadeOut'] as const).map((key) => {
          const label = key === 'fadeIn' ? 'Fade in' : 'Fade out';
          const max = Math.max(0, outputDuration - (key === 'fadeIn' ? edit.fadeOut : edit.fadeIn));
          return <div key={key}><TimeField label={label} value={edit[key]} max={max} onChange={(time) => update({ [key]: time })} /><input type="range" min={0} max={max} step="0.01" value={edit[key]} aria-label={`${label} duration`} onChange={(event) => update({ [key]: Number(event.target.value) })} className="audio-studio-range w-full mt-2 accent-[var(--accent)]" /></div>;
        })}
      </div>
      <p className="text-xs text-neutral-400 leading-relaxed">Fade times use the exported playback speed. They shorten automatically if you shorten the clip or increase its speed. Compare original bypasses the fades.</p>
    </section>

    <section aria-label="Comparison loop settings" className="rounded-xl border border-white/10 p-3 sm:p-4 space-y-4">
      <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-bold text-white flex items-center gap-2"><Repeat2 className="size-4" />Loop comparison</h3><p className="mt-1 text-xs text-neutral-400 leading-relaxed">Repeat a short section, then switch Compare original to hear your changes. The loop only affects preview.</p></div><input type="checkbox" role="switch" aria-label="Loop comparison" checked={loopEnabled} onChange={(event) => onLoopEnabled(event.target.checked)} className="size-5 shrink-0 accent-[var(--accent)]" /></div>
      <div className="flex flex-wrap gap-2">{[5, 10, 15].map((seconds) => <button type="button" key={seconds} onClick={() => chooseLoop(seconds)} className="min-h-10 px-3 rounded-lg border border-white/15 text-xs text-neutral-300 hover:bg-white/5">Loop {seconds} sec here</button>)}<button type="button" onClick={() => chooseLoop()} className="min-h-10 px-3 rounded-lg border border-white/15 text-xs text-neutral-300 hover:bg-white/5">Loop whole clip</button></div>
      {loopEnabled && <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3"><TimeField label="Loop start" value={selectedLoop.start} min={edit.trimStart} max={selectedLoop.end - Math.min(gap, selectedLoop.end - selectedLoop.start)} onChange={(time) => onLoop({ ...selectedLoop, start: time })} /><TimeField label="Loop end" value={selectedLoop.end} min={selectedLoop.start + Math.min(gap, selectedLoop.end - selectedLoop.start)} max={end} onChange={(time) => onLoop({ ...selectedLoop, end: time })} /></div>}
      <p className="text-xs text-neutral-400">Press Play above to listen. Original and enhanced playback use the same source section; enhanced playback follows your speed setting.</p>
    </section>
  </div>;
}
