import { RefObject, useEffect, useRef, useState } from 'react';
import { AudioEditSettings, AudioLoopRange, fitAudioLoop, getAudioFadeGain } from './audioEditing';
import { AudioPreviewGraph } from './audioPreview';

export function useAudioEditorPlayback(options: {
  audio: RefObject<HTMLAudioElement | null>; graph: RefObject<AudioPreviewGraph | null>;
  previewUrl: string | null; duration: number; edit: AudioEditSettings;
  loop: AudioLoopRange; loopEnabled: boolean; bypass: boolean; speed: number;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [currentTime, setCurrentTime] = useState(0);
  const lastPaint = useRef(0);
  const synchronize = (immediate = false, starting = false) => {
    const state = latest.current;
    const audio = state.audio.current;
    if (!audio || !(state.duration > 0) || audio.readyState < 1) return;
    const bounds = state.loopEnabled ? fitAudioLoop(state.loop, state.edit, state.duration)
      : { start: state.edit.trimStart, end: state.edit.trimEnd ?? state.duration };
    const pastEnd = audio.currentTime >= bounds.end - 0.002;
    if (audio.currentTime < bounds.start - 0.002 || ((state.loopEnabled || starting) && pastEnd)) {
      audio.currentTime = bounds.start;
      immediate = true;
    } else if (pastEnd) {
      if (!audio.paused) audio.pause();
      if (audio.currentTime > bounds.end) audio.currentTime = Math.min(bounds.end, audio.duration);
    }
    state.graph.current?.applyFade(state.bypass ? 1 : getAudioFadeGain(audio.currentTime, state.edit, state.duration, state.speed), immediate);
    if (immediate || performance.now() - lastPaint.current > 90) {
      lastPaint.current = performance.now();
      setCurrentTime(audio.currentTime);
    }
  };
  const synchronizeRef = useRef(synchronize);
  synchronizeRef.current = synchronize;

  useEffect(() => {
    const audio = options.audio.current;
    if (!audio) return;
    let frame = 0; let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => { synchronizeRef.current(); if (!audio.paused) frame = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(frame); clearInterval(timer); synchronizeRef.current(true); };
    const start = () => {
      cancelAnimationFrame(frame); clearInterval(timer);
      synchronizeRef.current(true, true);
      frame = requestAnimationFrame(tick);
      // Background tabs throttle animation frames, but a comparison loop still
      // needs to obey its bounds. Native timeupdate remains a third fallback.
      timer = setInterval(() => { if (document.hidden) synchronizeRef.current(); }, 40);
    };
    const seek = () => synchronizeRef.current(true);
    const update = () => synchronizeRef.current();
    const ended = () => {
      if (latest.current.loopEnabled) {
        synchronizeRef.current(true, true);
        void audio.play().catch(() => undefined);
      } else stop();
    };
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('seeking', seek);
    audio.addEventListener('ended', ended);
    return () => {
      cancelAnimationFrame(frame); clearInterval(timer);
      audio.removeEventListener('play', start); audio.removeEventListener('pause', stop);
      audio.removeEventListener('timeupdate', update); audio.removeEventListener('seeking', seek); audio.removeEventListener('ended', ended);
    };
  }, [options.previewUrl]);

  useEffect(() => { synchronizeRef.current(true); }, [options.edit, options.loop, options.loopEnabled, options.bypass, options.speed, options.duration]);

  return { currentTime, synchronize: () => synchronizeRef.current(true), seek: (time: number) => {
    const audio = options.audio.current;
    if (audio && audio.readyState >= 1) { audio.currentTime = time; synchronizeRef.current(true); }
  } };
}
