import { AudioEnhancementSettings, getAudioMacros, getAudioToneSettings } from './audioEnhancement';

export function setAudioPlaybackSettings(audio: HTMLAudioElement, speed: number, keepPitch: boolean) {
  audio.playbackRate = speed;
  audio.preservesPitch = keepPitch;
  const legacy = audio as HTMLAudioElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
  if ('webkitPreservesPitch' in legacy) legacy.webkitPreservesPitch = keepPitch;
  if ('mozPreservesPitch' in legacy) legacy.mozPreservesPitch = keepPitch;
}

export class AudioPreviewGraph {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  private source: MediaElementAudioSourceNode;
  private dry: GainNode;
  private wet: GainNode;
  private headroom: GainNode;
  private filters: BiquadFilterNode[];
  private compressor: DynamicsCompressorNode;
  private guard: DynamicsCompressorNode;

  constructor(private audio: HTMLAudioElement) {
    const Context = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new Error('Live audio effects are unavailable in this browser. You can still export your settings.');
    this.context = new Context();
    this.source = this.context.createMediaElementSource(audio);
    this.dry = this.context.createGain();
    this.wet = this.context.createGain();
    this.headroom = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.filters = ['highpass', 'lowpass', 'peaking', 'lowshelf', 'peaking', 'highshelf'].map((type) => {
      const filter = this.context.createBiquadFilter();
      filter.type = type as BiquadFilterType;
      return filter;
    });
    this.filters[2].frequency.value = 2200;
    this.filters[2].Q.value = 1.1;
    this.filters[3].frequency.value = 95;
    this.filters[4].frequency.value = 350;
    this.filters[4].Q.value = 1.4;
    this.filters[5].frequency.value = 10000;
    this.compressor = this.context.createDynamicsCompressor();
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.2;
    this.guard = this.context.createDynamicsCompressor();
    this.guard.threshold.value = -1;
    this.guard.knee.value = 0;
    this.guard.ratio.value = 20;
    this.guard.attack.value = 0.003;
    this.guard.release.value = 0.05;
    this.source.connect(this.dry).connect(this.analyser);
    let last: AudioNode = this.source.connect(this.headroom);
    for (const filter of this.filters) last = last.connect(filter);
    last.connect(this.compressor).connect(this.guard).connect(this.wet).connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.wet.gain.value = 0;
  }

  apply(settings: AudioEnhancementSettings, bypass: boolean) {
    // Cleanup is rendered by FFmpeg into the media source. Do not apply a second,
    // weaker EQ approximation that would make the preview differ from export.
    const m = getAudioMacros(getAudioToneSettings(settings));
    const now = this.context.currentTime;
    const ramp = (param: AudioParam, value: number) => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, 0.02);
    };
    const nyquist = this.context.sampleRate / 2;
    ramp(this.filters[0].frequency, m.voice ? m.voiceHighPass : 0);
    ramp(this.filters[1].frequency, m.voice ? Math.min(nyquist, m.voiceLowPass) : nyquist);
    ramp(this.filters[2].gain, m.voiceGain);
    ramp(this.filters[3].gain, m.bassGain);
    ramp(this.filters[4].gain, m.mudGain);
    ramp(this.filters[5].gain, m.airGain);
    ramp(this.headroom.gain, Math.pow(10, m.headroomDb / 20));
    ramp(this.compressor.threshold, m.clarity ? m.compressorThresholdDb : 0);
    ramp(this.compressor.ratio, m.clarity ? m.compressorRatio : 1);
    ramp(this.compressor.knee, m.clarity ? 6 : 0);
    const wet = !bypass && m.active;
    ramp(this.dry.gain, wet ? 0 : 1);
    ramp(this.wet.gain, wet ? 1 : 0);
    setAudioPlaybackSettings(this.audio, bypass ? 1 : settings.speed, bypass || settings.keepPitch);
  }

  async resume() { await this.context.resume(); }

  close() {
    this.audio.pause();
    this.source.disconnect();
    this.analyser.disconnect();
    void this.context.close().catch(() => undefined);
  }
}
