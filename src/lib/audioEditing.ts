export interface AudioEditSettings {
  trimStart: number;
  trimEnd: number | null;
  fadeIn: number;
  fadeOut: number;
}

export interface AudioLoopRange { start: number; end: number }
export const DEFAULT_AUDIO_EDIT: AudioEditSettings = { trimStart: 0, trimEnd: null, fadeIn: 0, fadeOut: 0 };
export const MIN_AUDIO_SELECTION = 0.05;

export function validateAudioEdit(value: unknown): AudioEditSettings {
  if (value === undefined) return { ...DEFAULT_AUDIO_EDIT };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Audio edit settings must be an object.');
  const raw = value as Record<string, unknown>;
  const result = { ...DEFAULT_AUDIO_EDIT };
  for (const key of Object.keys(result) as (keyof AudioEditSettings)[]) {
    if (key === 'trimEnd' && raw[key] === null) continue;
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 604800) {
      throw new Error(`${key} must be a time from 0 to 604800 seconds.`);
    }
    Object.assign(result, { [key]: number });
  }
  if (result.trimEnd !== null && result.trimEnd - result.trimStart < MIN_AUDIO_SELECTION) {
    throw new Error('Keep at least 0.05 seconds between the trim start and end.');
  }
  return result;
}

export function resolveAudioEdit(edit: AudioEditSettings, sourceDuration: number, speed: number) {
  const result = validateAudioEdit(edit);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('Could not determine the audio duration. Prepare the source again.');
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('Invalid audio playback speed.');
  // The media probe rounds to centiseconds; tolerate that rounding at the end.
  const end = result.trimEnd === null ? sourceDuration : Math.min(result.trimEnd, sourceDuration);
  if ((result.trimEnd !== null && result.trimEnd > sourceDuration + 0.02) || result.trimStart >= end) {
    throw new Error('The trim selection must be inside the source audio.');
  }
  const duration = (end - result.trimStart) / speed;
  if (result.fadeIn + result.fadeOut > duration + 0.000001) throw new Error('The fades must fit inside the selected audio at this speed.');
  return { ...result, trimEnd: end, duration };
}

// Interactive changes keep a valid selection and shorten fades when a user
// shortens the clip or increases its speed. The API validates instead of clamping.
export function fitAudioEdit(edit: AudioEditSettings, sourceDuration: number, speed: number): AudioEditSettings {
  if (!(sourceDuration > 0)) return { ...DEFAULT_AUDIO_EDIT };
  const gap = Math.min(MIN_AUDIO_SELECTION, sourceDuration);
  const end = Math.max(gap, Math.min(sourceDuration, edit.trimEnd ?? sourceDuration));
  const start = Math.max(0, Math.min(end - gap, edit.trimStart));
  const duration = (end - start) / speed;
  const totalFades = Math.max(0, edit.fadeIn) + Math.max(0, edit.fadeOut);
  const factor = totalFades > duration ? duration / totalFades : 1;
  return { trimStart: start, trimEnd: edit.trimEnd === null ? null : end, fadeIn: Math.max(0, edit.fadeIn) * factor, fadeOut: Math.max(0, edit.fadeOut) * factor };
}

export function fitAudioLoop(range: AudioLoopRange, edit: AudioEditSettings, sourceDuration: number): AudioLoopRange {
  const end = Math.min(sourceDuration, edit.trimEnd ?? sourceDuration);
  const length = Math.min(end - edit.trimStart, Math.max(MIN_AUDIO_SELECTION, range.end - range.start));
  const start = Math.max(edit.trimStart, Math.min(range.start, end - length));
  return { start, end: start + length };
}

export function getAudioFadeGain(sourceTime: number, edit: AudioEditSettings, sourceDuration: number, speed: number): number {
  const end = edit.trimEnd ?? sourceDuration;
  if (sourceTime < edit.trimStart || sourceTime > end) return 0;
  const elapsed = (sourceTime - edit.trimStart) / speed;
  const remaining = (end - sourceTime) / speed;
  return Math.max(0, Math.min(1, edit.fadeIn > 0 ? elapsed / edit.fadeIn : 1, edit.fadeOut > 0 ? remaining / edit.fadeOut : 1));
}

export function formatAudioTime(seconds: number): string {
  const hundredths = Math.round(Math.max(0, seconds) * 100);
  const minutes = Math.floor(hundredths / 6000);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}
