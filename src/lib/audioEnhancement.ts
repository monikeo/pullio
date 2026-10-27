import { AudioEditSettings, resolveAudioEdit } from './audioEditing';

export interface AudioEnhancementSettings {
  speed: number;
  keepPitch: boolean;
  noiseRemoval: boolean;
  noiseIntensity: number;
  humRemoval: boolean;
  humIntensity: number;
  humFrequency: 50 | 60;
  noiseGate: boolean;
  gateIntensity: number;
  clickRemoval: boolean;
  clickIntensity: number;
  deEss: boolean;
  deEssIntensity: number;
  voiceFocus: boolean;
  voiceIntensity: number;
  bassBoost: boolean;
  bassIntensity: number;
  clarity: boolean;
  clarityIntensity: number;
  normalizeLoudness: boolean;
  loudnessTarget: -14 | -16 | -23;
  outputGain: number;
}

export type AudioExportFormat = 'mp3' | 'wav' | 'flac' | 'm4a' | 'ogg' | 'opus' | 'aac';
export interface AudioSourceReference { kind: 'download' | 'conversion' | 'upload'; id: string }
export type AudioStudioSource = (AudioSourceReference | { kind: 'local'; file: File }) & { name: string };

export const DEFAULT_AUDIO_ENHANCEMENT: AudioEnhancementSettings = {
  speed: 1, keepPitch: true,
  noiseRemoval: false, noiseIntensity: 60,
  humRemoval: false, humIntensity: 70, humFrequency: 50,
  noiseGate: false, gateIntensity: 40,
  clickRemoval: false, clickIntensity: 40,
  deEss: false, deEssIntensity: 40,
  voiceFocus: false, voiceIntensity: 50,
  bassBoost: false, bassIntensity: 40,
  clarity: false, clarityIntensity: 40,
  normalizeLoudness: false, loudnessTarget: -16, outputGain: 0,
};

export const AUDIO_EXPORT_QUALITIES: Record<AudioExportFormat, { value: string; label: string }[]> = {
  mp3: [{ value: '320k', label: '320 kbps' }, { value: '192k', label: '192 kbps' }, { value: '128k', label: '128 kbps · smaller' }],
  wav: [{ value: '16bit', label: '16-bit / 44.1 kHz' }, { value: '24bit', label: '24-bit / 48 kHz' }],
  flac: [{ value: 'lossless', label: 'Lossless compression' }],
  m4a: [{ value: '256k', label: '256 kbps AAC' }, { value: '128k', label: '128 kbps AAC' }],
  ogg: [{ value: '192k', label: '192 kbps Vorbis' }, { value: '320k', label: '320 kbps Vorbis' }],
  opus: [{ value: '192k', label: '192 kbps Opus' }, { value: '128k', label: '128 kbps Opus · smaller' }],
  aac: [{ value: '256k', label: '256 kbps AAC' }, { value: '128k', label: '128 kbps AAC · smaller' }],
};

export function validateAudioEnhancement(value: unknown): AudioEnhancementSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Audio settings are required.');
  const raw = value as Record<string, unknown>;
  const settings = { ...DEFAULT_AUDIO_ENHANCEMENT };
  const addedKeys = new Set(['humRemoval', 'humIntensity', 'humFrequency', 'noiseGate', 'gateIntensity', 'clickRemoval', 'clickIntensity', 'deEss', 'deEssIntensity', 'normalizeLoudness', 'loudnessTarget', 'outputGain']);
  for (const key of Object.keys(settings) as (keyof AudioEnhancementSettings)[]) {
    // Older clients can omit newly introduced controls; supplied values are always validated.
    if (raw[key] === undefined && addedKeys.has(key)) continue;
    if (key === 'humFrequency') {
      if (raw[key] !== 50 && raw[key] !== 60) throw new Error('Hum frequency must be 50 or 60 Hz.');
      settings.humFrequency = raw[key];
      continue;
    }
    if (key === 'loudnessTarget') {
      if (raw[key] !== -14 && raw[key] !== -16 && raw[key] !== -23) throw new Error('Choose a supported loudness target.');
      settings.loudnessTarget = raw[key];
      continue;
    }
    if (typeof settings[key] === 'boolean') {
      if (typeof raw[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
    } else {
      const min = key === 'speed' ? 0.5 : key === 'outputGain' ? -12 : 0;
      const max = key === 'speed' ? 2 : key === 'outputGain' ? 12 : 100;
      if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max) {
        throw new Error(`${key} must be a number from ${min} to ${max}.`);
      }
    }
    Object.assign(settings, { [key]: raw[key] });
  }
  return settings;
}

export function validateAudioExport(format: unknown, quality: unknown): { format: AudioExportFormat; quality: string } {
  if (typeof format !== 'string' || !Object.hasOwn(AUDIO_EXPORT_QUALITIES, format)) throw new Error('Unsupported audio export format.');
  const choices = AUDIO_EXPORT_QUALITIES[format as AudioExportFormat];
  if (typeof quality !== 'string' || !choices.some((choice) => choice.value === quality)) throw new Error('Unsupported quality for this audio format.');
  return { format: format as AudioExportFormat, quality };
}

// Tone macros drive browser preview and FFmpeg export. Cleanup is rendered by
// FFmpeg for both paths; browser compressor and resampling can still differ.
export function getAudioMacros(settings: AudioEnhancementSettings) {
  const voice = settings.voiceFocus ? settings.voiceIntensity / 100 : 0;
  const bass = settings.bassBoost ? settings.bassIntensity / 100 : 0;
  const clarity = settings.clarity ? settings.clarityIntensity / 100 : 0;
  return {
    voice, bass, clarity,
    voiceHighPass: 20 + voice * 160,
    voiceLowPass: 18000 - voice * 12500,
    voiceGain: voice * 6,
    bassGain: bass * 10,
    mudGain: clarity * -4.5,
    airGain: clarity * 5,
    headroomDb: -(bass * 10 + voice * 6 + clarity * 5) * 0.5 + settings.outputGain,
    compressorThresholdDb: -18 - clarity * 8,
    compressorRatio: 1 + clarity * 3.5,
    active: hasAudioCleanup(settings) || voice > 0 || bass > 0 || clarity > 0 || settings.outputGain !== 0,
  };
}

export function getAudioCleanupSignature(settings: AudioEnhancementSettings): string {
  return JSON.stringify([
    settings.noiseRemoval ? settings.noiseIntensity : 0,
    settings.humRemoval ? settings.humIntensity : 0,
    settings.humRemoval && settings.humIntensity > 0 ? settings.humFrequency : 50,
    settings.noiseGate ? settings.gateIntensity : 0,
    settings.clickRemoval ? settings.clickIntensity : 0,
    settings.deEss ? settings.deEssIntensity : 0,
    settings.normalizeLoudness ? settings.loudnessTarget : 0,
  ]);
}

export function hasAudioCleanup(settings: AudioEnhancementSettings): boolean {
  return Boolean((settings.noiseRemoval && settings.noiseIntensity > 0) || (settings.humRemoval && settings.humIntensity > 0) ||
    (settings.noiseGate && settings.gateIntensity > 0) || (settings.clickRemoval && settings.clickIntensity > 0) || (settings.deEss && settings.deEssIntensity > 0) || settings.normalizeLoudness);
}

export function getAudioToneSettings(settings: AudioEnhancementSettings): AudioEnhancementSettings {
  return { ...settings, noiseRemoval: false, humRemoval: false, noiseGate: false, clickRemoval: false, deEss: false, normalizeLoudness: false };
}

export function buildAudioCleanupFilters(settings: AudioEnhancementSettings): string[] {
  const s = validateAudioEnhancement(settings);
  const filters: string[] = [];
  // Repair impulses before learning the continuous noise floor.
  if (s.clickRemoval && s.clickIntensity > 0) filters.push(`adeclick=t=${(6 - s.clickIntensity / 100 * 4.5).toFixed(2)}:b=2`);
  if (s.humRemoval && s.humIntensity > 0) {
    for (let harmonic = 1; harmonic <= 4; harmonic++) {
      filters.push(`equalizer=f=${s.humFrequency * harmonic}:t=q:w=20:g=${(-s.humIntensity / 100 * 30).toFixed(2)}`);
    }
  }
  if (s.noiseRemoval && s.noiseIntensity > 0) {
    const strength = s.noiseIntensity / 100;
    filters.push(`highpass=f=${20 + strength * 100}`);
    // Adaptive wavelet profiling follows the recording's noise level instead of
    // relying on an assumed fixed dB floor. Leave some dry signal at maximum strength.
    filters.push(`afwtdn=sigma=0:percent=${(strength * 95).toFixed(2)}:adaptive=1:softness=1`);
  }
  if (s.deEss && s.deEssIntensity > 0) {
    const strength = s.deEssIntensity / 100;
    // Keep the detector conservative; large intensity values also duck the
    // lower voice band on strong sibilants in FFmpeg's broadband implementation.
    filters.push(`deesser=i=${(strength * 0.3).toFixed(3)}:m=0.5:f=0.5`);
  }
  if (s.noiseGate && s.gateIntensity > 0) {
    const strength = s.gateIntensity / 100;
    filters.push(`agate=threshold=${Math.pow(10, (-65 + strength * 40) / 20).toFixed(6)}:ratio=${2 + strength * 6}:range=${Math.pow(10, -strength * 40 / 20).toFixed(6)}:attack=10:release=250:makeup=1`);
  }
  if (s.normalizeLoudness) filters.push(`loudnorm=I=${s.loudnessTarget}:TP=-1.5:LRA=11`);
  return filters;
}

export function buildAudioEnhancementFilters(settings: AudioEnhancementSettings, edit?: AudioEditSettings, sourceDuration?: number): string[] {
  const s = validateAudioEnhancement(settings);
  const m = getAudioMacros(s);
  const filters = buildAudioCleanupFilters(s);
  const selection = edit ? resolveAudioEdit(edit, sourceDuration!, s.speed) : null;
  if (selection && (selection.trimStart > 0 || selection.trimEnd !== sourceDuration)) {
    filters.push(`atrim=start=${selection.trimStart}:end=${selection.trimEnd}`, 'asetpts=PTS-STARTPTS');
  }
  if (s.speed !== 1) {
    if (s.keepPitch) filters.push(`atempo=${s.speed}`);
    else filters.push('aresample=48000', `asetrate=${Math.round(48000 * s.speed)}`, 'aresample=48000');
  }
  if (m.active) filters.push(`volume=${m.headroomDb}dB`);
  if (m.voice > 0) filters.push(`highpass=f=${m.voiceHighPass}`, `lowpass=f=${m.voiceLowPass}`, `equalizer=f=2200:t=q:w=1.1:g=${m.voiceGain}`);
  if (m.bass > 0) filters.push(`bass=f=95:g=${m.bassGain}`);
  if (m.clarity > 0) {
    filters.push(`equalizer=f=350:t=q:w=1.4:g=${m.mudGain}`, `treble=f=10000:g=${m.airGain}`);
    filters.push(`acompressor=threshold=${Math.pow(10, m.compressorThresholdDb / 20).toFixed(6)}:ratio=${m.compressorRatio}:attack=10:release=200:makeup=1`);
  }
  if (m.active) filters.push('alimiter=limit=0.95:level=false:latency=true');
  if (selection?.fadeIn) filters.push(`afade=t=in:st=0:d=${selection.fadeIn}`);
  if (selection?.fadeOut) filters.push(`afade=t=out:st=${Math.max(0, selection.duration - selection.fadeOut)}:d=${selection.fadeOut}`);
  return filters;
}

export function getAudioEncoderArgs(format: AudioExportFormat, quality: string): string[] {
  validateAudioExport(format, quality);
  switch (format) {
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', quality];
    case 'm4a': return ['-c:a', 'aac', '-b:a', quality, '-movflags', '+faststart'];
    case 'ogg': return ['-c:a', 'libvorbis', '-b:a', quality];
    case 'opus': return ['-c:a', 'libopus', '-b:a', quality, '-ar', '48000'];
    case 'aac': return ['-c:a', 'aac', '-b:a', quality, '-f', 'adts'];
    case 'wav': return ['-c:a', quality === '24bit' ? 'pcm_s24le' : 'pcm_s16le', '-ar', quality === '24bit' ? '48000' : '44100'];
    case 'flac': return ['-c:a', 'flac', '-compression_level', '5'];
  }
}
