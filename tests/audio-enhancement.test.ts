import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import { AUDIO_EXPORT_QUALITIES, DEFAULT_AUDIO_ENHANCEMENT, buildAudioEnhancementFilters, buildAudioCleanupFilters, validateAudioEnhancement, validateAudioExport } from '../src/lib/audioEnhancement';
import { DEFAULT_AUDIO_EDIT, fitAudioEdit, fitAudioLoop, getAudioFadeGain, resolveAudioEdit, validateAudioEdit } from '../src/lib/audioEditing';

test('trim, fade and loop boundaries stay valid across speed and selection changes', () => {
  for (const edit of [null, [], { ...DEFAULT_AUDIO_EDIT, trimStart: '1:movie=/secret' }, { ...DEFAULT_AUDIO_EDIT, trimStart: NaN }, { ...DEFAULT_AUDIO_EDIT, fadeIn: Infinity }, { ...DEFAULT_AUDIO_EDIT, trimStart: 2, trimEnd: 1 }]) assert.throws(() => validateAudioEdit(edit));
  assert.deepEqual(validateAudioEdit(undefined), DEFAULT_AUDIO_EDIT);
  assert.throws(() => resolveAudioEdit({ ...DEFAULT_AUDIO_EDIT, trimEnd: 12 }, 10, 1));
  assert.throws(() => resolveAudioEdit({ ...DEFAULT_AUDIO_EDIT, fadeIn: 3, fadeOut: 3 }, 10, 2));
  const fitted = fitAudioEdit({ trimStart: 1, trimEnd: 3, fadeIn: 2, fadeOut: 2 }, 10, 2);
  assert.equal(fitted.fadeIn, 0.5); assert.equal(fitted.fadeOut, 0.5);
  assert.deepEqual(fitAudioLoop({ start: 0, end: 20 }, fitted, 10), { start: 1, end: 3 });
  const nearEnd = fitAudioLoop({ start: 9, end: 10 }, fitted, 10);
  assert.ok(nearEnd.start >= 1 && nearEnd.start < nearEnd.end && nearEnd.end <= 3);
  assert.deepEqual(nearEnd, { start: 2, end: 3 });
  assert.deepEqual(fitAudioLoop({ start: 3, end: 4 }, { ...DEFAULT_AUDIO_EDIT, trimStart: 8, trimEnd: 12 }, 20), { start: 8, end: 9 });
  assert.equal(getAudioFadeGain(1, fitted, 10, 2), 0);
  assert.equal(getAudioFadeGain(1.5, fitted, 10, 2), 0.5);
  assert.equal(getAudioFadeGain(2, fitted, 10, 2), 1);
  assert.equal(getAudioFadeGain(3, fitted, 10, 2), 0);
});

test('export trims the correct source section and fades at the chosen playback speed', () => {
  for (const keepPitch of [true, false]) {
    const settings = { ...DEFAULT_AUDIO_ENHANCEMENT, speed: 2, keepPitch };
    const edit = { trimStart: 4, trimEnd: 8, fadeIn: 0.5, fadeOut: 0.5 };
    const filters = buildAudioEnhancementFilters(settings, edit, 9);
    const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,3)\\,0.4*sin(2*PI*220*t)\\,0.4*sin(2*PI*880*t)):s=48000:d=9', '-af', filters.join(','), '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 2 * 1024 * 1024 });
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.ok(Math.abs(samples.length / 48000 - 2) < 0.06);
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let index = Math.floor(from * 48000); index < Math.floor(to * 48000); index++) sum += samples[index] ** 2;
      return Math.sqrt(sum / Math.floor((to - from) * 48000));
    };
    const middle = rms(0.9, 1.1);
    assert.ok(rms(0.01, 0.03) < middle * 0.1);
    assert.ok(rms(1.97, 1.99) < middle * 0.1);
    assert.ok(rms(0.24, 0.26) / middle > 0.47 && rms(0.24, 0.26) / middle < 0.53);
    let sine = 0; let cosine = 0;
    for (let index = 40000; index < 50000; index++) {
      const phase = 2 * Math.PI * (keepPitch ? 880 : 1760) * index / 48000;
      sine += samples[index] * Math.sin(phase); cosine += samples[index] * Math.cos(phase);
    }
    assert.ok(Math.hypot(sine, cosine) / 10000 > 0.1, 'Trim must keep the later high tone, with the requested pitch behavior');
  }
});

test('untrusted settings and mismatched format qualities cannot enter the processor', () => {
  for (const value of [NaN, Infinity, 0, 2.1, '1;movie=secret']) {
    assert.throws(() => validateAudioEnhancement({ ...DEFAULT_AUDIO_ENHANCEMENT, speed: value }));
  }
  assert.throws(() => validateAudioEnhancement({ ...DEFAULT_AUDIO_ENHANCEMENT, bassIntensity: 101 }));
  assert.throws(() => validateAudioEnhancement({ ...DEFAULT_AUDIO_ENHANCEMENT, keepPitch: 'true' }));
  assert.throws(() => validateAudioEnhancement({ ...DEFAULT_AUDIO_ENHANCEMENT, humFrequency: 55 }));
  assert.throws(() => validateAudioEnhancement({ ...DEFAULT_AUDIO_ENHANCEMENT, clickIntensity: '1:movie=/secret' }));
  assert.throws(() => validateAudioEnhancement({ ...DEFAULT_AUDIO_ENHANCEMENT, outputGain: 13 }));
  assert.throws(() => validateAudioEnhancement({ ...DEFAULT_AUDIO_ENHANCEMENT, loudnessTarget: -99 }));
  assert.throws(() => validateAudioExport('wav', '320k'));
  assert.throws(() => validateAudioExport('__proto__', 'lossless'));
});

test('real FFmpeg effects attenuate rumble and preserve pitch when requested', () => {
  const render = (settings: typeof DEFAULT_AUDIO_ENHANCEMENT) => {
    const filters = buildAudioEnhancementFilters(settings);
    const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*60*t)+0.2*sin(2*PI*2200*t)+0.2*sin(2*PI*14000*t):s=48000:d=3', ...(filters.length ? ['-af', filters.join(',')] : []), '-f', 'f32le', '-'], { maxBuffer: 4 * 1024 * 1024 });
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const amplitude = (samples: Float32Array, frequency: number) => {
    let sine = 0; let cosine = 0;
    for (let i = 9600; i < samples.length - 9600; i++) {
      const phase = 2 * Math.PI * frequency * i / 48000;
      sine += samples[i] * Math.sin(phase); cosine += samples[i] * Math.cos(phase);
    }
    return Math.hypot(sine, cosine) / (samples.length - 19200);
  };
  const original = render({ ...DEFAULT_AUDIO_ENHANCEMENT });
  const filtered = render({ ...DEFAULT_AUDIO_ENHANCEMENT, noiseRemoval: true, noiseIntensity: 100 });
  assert.ok(amplitude(filtered, 60) / amplitude(filtered, 2200) < amplitude(original, 60) / amplitude(original, 2200) * 0.3, 'Low rumble should drop relative to speech frequencies');
  const tempo = render({ ...DEFAULT_AUDIO_ENHANCEMENT, speed: 1.5, keepPitch: true });
  const pitch = render({ ...DEFAULT_AUDIO_ENHANCEMENT, speed: 1.5, keepPitch: false });
  assert.ok(Math.abs(tempo.length / 48000 - 2) < 0.08);
  assert.ok(Math.abs(pitch.length / 48000 - 2) < 0.08);
  assert.ok(amplitude(tempo, 2200) > amplitude(tempo, 3300) * 5, 'Pitch-preserving speed should retain 2200 Hz');
  assert.ok(amplitude(pitch, 3300) > amplitude(pitch, 2200) * 5, 'Unpreserved pitch should shift 2200 Hz to 3300 Hz');
  const maximumEffects = render({ ...DEFAULT_AUDIO_ENHANCEMENT, noiseRemoval: true, noiseIntensity: 100, voiceFocus: true, voiceIntensity: 100, bassBoost: true, bassIntensity: 100, clarity: true, clarityIntensity: 100 });
  assert.ok(maximumEffects.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 0.951), 'Combined effects should remain finite and below the limiter ceiling');
});

test('adaptive denoising reduces broadband noise within the voice band while retaining voiced audio', (t) => {
  const render = (settings: typeof DEFAULT_AUDIO_ENHANCEMENT) => {
    const filters = buildAudioCleanupFilters(settings);
    const expression = `[0:a][1:a]amix=inputs=2:normalize=0,${filters.length ? filters.join(',') : 'anull'}[out]`;
    const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.04:duration=4:sample_rate=48000:seed=11', '-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(2*PI*440*t)*between(t\\,1\\,3):s=48000:d=4', '-filter_complex', expression, '-map', '[out]', '-f', 'f32le', '-'], { maxBuffer: 4 * 1024 * 1024 });
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const rms = (samples: Float32Array, start: number, end: number) => {
    let sum = 0;
    for (let i = start * 48000; i < end * 48000; i++) sum += samples[i] ** 2;
    return Math.sqrt(sum / ((end - start) * 48000));
  };
  const original = render({ ...DEFAULT_AUDIO_ENHANCEMENT });
  const cleaned = render({ ...DEFAULT_AUDIO_ENHANCEMENT, noiseRemoval: true, noiseIntensity: 70 });
  const noiseRatio = rms(cleaned, 3.5, 3.9) / rms(original, 3.5, 3.9);
  const voiceRatio = rms(cleaned, 1.5, 2.5) / rms(original, 1.5, 2.5);
  t.diagnostic(`Noise reduction: ${(-20 * Math.log10(noiseRatio)).toFixed(1)} dB; voiced level retained: ${(voiceRatio * 100).toFixed(1)}%`);
  assert.ok(noiseRatio < 0.5, 'Broadband background noise should fall by at least 6 dB');
  assert.ok(voiceRatio > 0.75, 'Voiced sections should retain most of their level');
});

test('hum cleanup rejects 50/60 Hz mains buzz while keeping voice frequencies', () => {
  for (const frequency of [50, 60] as const) {
    const filters = buildAudioCleanupFilters({ ...DEFAULT_AUDIO_ENHANCEMENT, humRemoval: true, humIntensity: 85, humFrequency: frequency });
    const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=0.3*sin(2*PI*${frequency}*t)+0.3*sin(2*PI*440*t):s=48000:d=2`, '-af', filters.join(','), '-f', 'f32le', '-'], { maxBuffer: 2 * 1024 * 1024 });
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const amplitude = (hz: number) => {
      let sine = 0; let cosine = 0;
      for (let i = 24000; i < 72000; i++) { sine += samples[i] * Math.sin(2 * Math.PI * hz * i / 48000); cosine += samples[i] * Math.cos(2 * Math.PI * hz * i / 48000); }
      return Math.hypot(sine, cosine) / 24000;
    };
    assert.ok(amplitude(frequency) < 0.06, 'Hum should fall by more than 14 dB');
    assert.ok(amplitude(440) > 0.27, 'Voice-band tone should retain at least 90% of its amplitude');
  }
});

test('pause cleanup attenuates quiet background noise without gating louder speech', () => {
  const filters = buildAudioCleanupFilters({ ...DEFAULT_AUDIO_ENHANCEMENT, noiseGate: true, gateIntensity: 60 });
  const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.001*sin(2*PI*1200*t)+0.3*sin(2*PI*440*t)*between(t\\,1\\,3):s=48000:d=4', '-af', filters.join(','), '-f', 'f32le', '-'], { maxBuffer: 2 * 1024 * 1024 });
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rms = (start: number, end: number) => {
    let sum = 0;
    for (let i = start * 48000; i < end * 48000; i++) sum += samples[i] ** 2;
    return Math.sqrt(sum / ((end - start) * 48000));
  };
  assert.ok(rms(0.5, 0.9) < 0.0001);
  assert.ok(rms(1.5, 2.5) > 0.19);
});

test('click repair removes isolated impulses while preserving the underlying tone', () => {
  const filters = buildAudioCleanupFilters({ ...DEFAULT_AUDIO_ENHANCEMENT, clickRemoval: true, clickIntensity: 100 });
  const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*440*t)+if(eq(mod(n\\,16000)\\,0)\\,0.8\\,0):s=48000:d=2', '-af', filters.join(','), '-f', 'f32le', '-'], { maxBuffer: 2 * 1024 * 1024 });
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(samples.slice(24000, 72000).every((sample) => Math.abs(sample) < 0.3), 'Isolated click peaks should be repaired');
  let sum = 0;
  for (const sample of samples.slice(24000, 72000)) sum += sample ** 2;
  assert.ok(Math.sqrt(sum / 48000) > 0.06, 'The underlying tone should remain audible');
});

test('sibilance cleanup reduces harsh high-frequency bursts while preserving the low voice band', (t) => {
  const render = (filters: string[]) => {
    const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*440*t)+0.4*sin(2*PI*6500*t)*between(t\\,0.5\\,1.5):s=48000:d=2', '-af', filters.length ? filters.join(',') : 'anull', '-f', 'f32le', '-'], { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 });
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const amplitude = (samples: Float32Array, hz: number) => {
    let sine = 0; let cosine = 0;
    for (let i = 36000; i < 60000; i++) { sine += samples[i] * Math.sin(2 * Math.PI * hz * i / 48000); cosine += samples[i] * Math.cos(2 * Math.PI * hz * i / 48000); }
    return Math.hypot(sine, cosine) / 12000;
  };
  const original = render([]);
  const cleaned = render(buildAudioCleanupFilters({ ...DEFAULT_AUDIO_ENHANCEMENT, deEss: true, deEssIntensity: 100 }));
  const highRatio = amplitude(cleaned, 6500) / amplitude(original, 6500);
  const lowRatio = amplitude(cleaned, 440) / amplitude(original, 440);
  t.diagnostic(`Sibilant band retained: ${(highRatio * 100).toFixed(1)}%; low voice band retained: ${(lowRatio * 100).toFixed(1)}%`);
  assert.ok(highRatio < 0.75);
  assert.ok(lowRatio > 0.75);
});

test('leveling raises quiet audio to its target and output gain changes level with safe peaks', () => {
  const render = (settings: typeof DEFAULT_AUDIO_ENHANCEMENT) => {
    const filters = buildAudioEnhancementFilters(settings);
    const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.01*sin(2*PI*440*t):s=48000:d=4', ...(filters.length ? ['-af', filters.join(',')] : []), '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 4 * 1024 * 1024 });
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  const dry = render({ ...DEFAULT_AUDIO_ENHANCEMENT });
  const boosted = render({ ...DEFAULT_AUDIO_ENHANCEMENT, outputGain: 6 });
  assert.ok(Math.abs(20 * Math.log10(rms(boosted) / rms(dry)) - 6) < 0.1);
  const leveled = render({ ...DEFAULT_AUDIO_ENHANCEMENT, normalizeLoudness: true, loudnessTarget: -16 });
  const quieter = render({ ...DEFAULT_AUDIO_ENHANCEMENT, normalizeLoudness: true, loudnessTarget: -23 });
  assert.ok(rms(leveled) > rms(dry) * 10, 'Leveling must actually raise quiet source audio');
  assert.ok(Math.abs(20 * Math.log10(rms(leveled) / rms(quieter)) - 7) < 0.3, 'Targets should differ by 7 LU');
  assert.ok(leveled.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 0.951));
});

test('studio API prepares seekable previews, exports every offered quality, and handles cancellation and missing audio', { timeout: 120_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pullio-audio-check-'));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const child = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'server.ts'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-6000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-6000); });
  const base = `http://127.0.0.1:${port}`;
  const jobs = new Set<string>();
  const uploads = new Set<string>();
  const json = async (route: string, body: unknown) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    for (const jobId of jobs) await fetch(`${base}/api/convert/${jobId}`, { method: 'DELETE' }).catch(() => undefined);
    for (const uploadId of uploads) await fetch(`${base}/api/convert/${crypto.randomUUID()}?uploadId=${uploadId}`, { method: 'DELETE' }).catch(() => undefined);
    child.kill();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}pullio-audio-check-`));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  let running = false;
  for (let i = 0; i < 150; i++) {
    try { running = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (running) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(running, logs);
  const audioPath = path.join(directory, 'studio-fixture.wav');
  execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000', '-ac', '2', audioPath]);
  const upload = async (filePath: string, mime: string) => {
    const form = new FormData();
    form.append('files', new Blob([fs.readFileSync(filePath)], { type: mime }), path.basename(filePath));
    const response = await fetch(base + '/api/convert/upload', { method: 'POST', body: form });
    assert.equal(response.status, 200);
    const data = await response.json();
    const id = data.files[0].uploadId;
    uploads.add(id);
    return { kind: 'upload', id };
  };
  const source = await upload(audioPath, 'audio/wav');
  const wait = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const response = await fetch(`${base}/api/convert/status/${id}`);
      assert.equal(response.status, 200);
      const { job } = await response.json();
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Audio processing did not complete. ' + logs);
  };
  const start = async (route: string, body: Record<string, unknown>) => {
    const jobId = crypto.randomUUID(); jobs.add(jobId);
    const result = await json(route, { jobId, ...body });
    assert.equal(result.status, 202, JSON.stringify(result.body));
    return jobId;
  };
  const previewId = await start('/api/audio/prepare', { source });
  assert.equal((await wait(previewId)).status, 'completed');
  const preview = await fetch(`${base}/api/audio/preview/${previewId}`, { headers: { Range: 'bytes=0-127' } });
  assert.equal(preview.status, 206);
  assert.match(preview.headers.get('Content-Type')!, /audio\/wav/);
  assert.equal((await preview.arrayBuffer()).byteLength, 128);
  const head = await fetch(`${base}/api/audio/preview/${previewId}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const waveform = await fetch(`${base}/api/audio/waveform/${previewId}`);
  assert.equal(waveform.status, 200);
  const waveformData = await waveform.json();
  assert.equal(waveformData.peaks.length, 400);
  assert.ok(waveformData.peaks.every((peak: number) => peak > 0 && peak <= 1));
  assert.ok(Math.abs(waveformData.duration - 3) < 0.001);
  await fetch(`${base}/api/convert/${previewId}`, { method: 'DELETE' });
  assert.equal((await fetch(`${base}/api/audio/waveform/${previewId}`)).status, 404);

  const cleanupSettings = { ...DEFAULT_AUDIO_ENHANCEMENT, speed: 1.25, noiseRemoval: true, humRemoval: true, noiseGate: true, clickRemoval: true, deEss: true, normalizeLoudness: true };
  const cleanupId = await start('/api/audio/cleanup-preview', { source, settings: cleanupSettings });
  const cleanupJob = await wait(cleanupId);
  assert.equal(cleanupJob.status, 'completed', cleanupJob.error);
  assert.equal(cleanupJob.duration, 3, 'Cleanup preview must not bake in playback speed or tone controls');
  const cleanupResponse = await fetch(`${base}/api/audio/preview/${cleanupId}`);
  assert.equal(cleanupResponse.status, 200);
  const cleanedPath = path.join(directory, 'cleaned-preview.wav');
  fs.writeFileSync(cleanedPath, Buffer.from(await cleanupResponse.arrayBuffer()));
  const matchingExportId = await start('/api/audio/enhance', { source, settings: { ...cleanupSettings, speed: 1 }, format: 'wav', quality: '24bit' });
  const matchingExport = await wait(matchingExportId);
  assert.equal(matchingExport.status, 'completed', matchingExport.error);
  const exportedPath = path.join(directory, 'matching-cleanup.wav');
  fs.writeFileSync(exportedPath, Buffer.from(await (await fetch(`${base}/api/convert/download/${matchingExportId}`)).arrayBuffer()));
  const decode = (file: string) => {
    const bytes = execFileSync(ffmpeg!, ['-v', 'error', '-i', file, '-ar', '48000', '-ac', '2', '-f', 'f32le', '-'], { maxBuffer: 4 * 1024 * 1024 });
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const editedId = await start('/api/audio/enhance', { source, settings: { ...DEFAULT_AUDIO_ENHANCEMENT, speed: 1.25 }, edit: { trimStart: 0.5, trimEnd: 2.5, fadeIn: 0.25, fadeOut: 0.5 }, format: 'wav', quality: '24bit' });
  const editedJob = await wait(editedId);
  assert.equal(editedJob.status, 'completed', editedJob.error);
  assert.equal(editedJob.duration, 1.6);
  const editedFile = path.join(directory, 'edited.wav');
  fs.writeFileSync(editedFile, Buffer.from(await (await fetch(`${base}/api/convert/download/${editedId}`)).arrayBuffer()));
  assert.ok(Math.abs(decode(editedFile).length / (48000 * 2) - 1.6) < 0.05);
  const invalidEdit = await start('/api/audio/enhance', { source, settings: DEFAULT_AUDIO_ENHANCEMENT, edit: { ...DEFAULT_AUDIO_EDIT, trimStart: 4 }, format: 'wav', quality: '24bit' });
  assert.match((await wait(invalidEdit)).error, /trim selection/);
  assert.equal((await json('/api/audio/enhance', { source, settings: DEFAULT_AUDIO_ENHANCEMENT, edit: { ...DEFAULT_AUDIO_EDIT, fadeOut: '1;movie=/secret' }, format: 'wav', quality: '24bit' })).status, 400);
  const previewSamples = decode(cleanedPath);
  const exportSamples = decode(exportedPath);
  assert.equal(previewSamples.length, exportSamples.length);
  let difference = 0;
  for (let i = 0; i < previewSamples.length; i++) difference = Math.max(difference, Math.abs(previewSamples[i] - exportSamples[i]));
  assert.ok(difference < 0.0001, 'Cleanup preview should match the export apart from WAV quantization');

  const settings = { ...DEFAULT_AUDIO_ENHANCEMENT, speed: 1.25, noiseRemoval: true, voiceFocus: true, bassBoost: true, clarity: true, noiseIntensity: 100, voiceIntensity: 100, bassIntensity: 100, clarityIntensity: 100 };
  let completedId = '';
  for (const [format, qualities] of Object.entries(AUDIO_EXPORT_QUALITIES)) {
    for (const { value: quality } of qualities) {
      const id = await start('/api/audio/enhance', { source, format, quality, settings });
      const job = await wait(id);
      assert.equal(job.status, 'completed', JSON.stringify(job));
      const response = await fetch(`${base}/api/convert/download/${id}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Disposition')!, /enhanced/);
      const output = path.join(directory, `${id}.${format}`);
      fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
      const details = spawnSync(ffmpeg!, ['-hide_banner', '-i', output, '-f', 'null', '-'], { encoding: 'utf8' });
      assert.equal(details.status, 0, details.stderr);
      // ADTS has no exact duration index: FFmpeg's input banner estimates from
      // bitrate. Decode samples to check the actual length for every format.
      const decodedDuration = decode(output).length / (48000 * 2);
      assert.ok(Math.abs(decodedDuration - 2.4) < 0.08, `${format}/${quality}: decoded duration ${decodedDuration} should match the selected speed`);
      const expectedCodec = format === 'wav' ? quality === '24bit' ? 'pcm_s24le' : 'pcm_s16le' : { mp3: 'mp3', m4a: 'aac', flac: 'flac', ogg: 'vorbis', opus: 'opus', aac: 'aac' }[format];
      assert.ok(details.stderr.includes(`Audio: ${expectedCodec}`), `Expected ${expectedCodec} in ${details.stderr}`);
      assert.ok(fs.statSync(output).size > 100);
      assert.equal(job.outputBytes, fs.statSync(output).size, 'Converter queue size should match the actual enhanced file');
      assert.ok(Math.abs(job.duration - 2.4) < 0.08);
      completedId = id;
    }
  }
  // Converted audio can be enhanced again without a browser download and re-upload.
  const convertedPreviewId = await start('/api/audio/prepare', { source: { kind: 'conversion', id: completedId } });
  assert.equal((await wait(convertedPreviewId)).status, 'completed');
  const cancelledId = await start('/api/audio/prepare', { source });
  assert.equal((await fetch(`${base}/api/convert/${cancelledId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/convert/status/${cancelledId}`)).status, 404);
  assert.equal((await json('/api/audio/enhance', { source, format: 'wav', quality: '320k', settings })).status, 400);
  assert.equal((await json('/api/audio/enhance', { source, format: 'mp3', quality: '320k', settings: { ...settings, speed: '1;movie=/etc/passwd' } })).status, 400);
  assert.equal((await json('/api/audio/prepare', { source: { kind: 'upload', id: '../../server.ts' } })).status, 400);
  const silentPath = path.join(directory, 'silent-video.mp4');
  execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=1', '-an', silentPath]);
  const silentId = await start('/api/audio/prepare', { source: await upload(silentPath, 'video/mp4') });
  const silentJob = await wait(silentId);
  assert.equal(silentJob.status, 'failed');
  assert.match(silentJob.error, /audio track/);
});
