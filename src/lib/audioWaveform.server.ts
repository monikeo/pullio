import { open } from 'node:fs/promises';

// Read bounded windows from the prepared PCM WAV. Long recordings never need
// to be downloaded or decoded in browser memory just to draw an overview.
export async function readAudioWaveform(filePath: string): Promise<{ peaks: number[]; duration: number }> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    const header = Buffer.alloc(64);
    await file.read(header, 0, 12, 0);
    if (!['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Waveform requires a prepared WAV preview.');
    let offset = 12;
    let channels = 0; let rate = 0; let frameBytes = 0;
    let dataStart = 0; let dataSize = 0;
    for (let index = 0; index < 64 && offset + 8 <= stat.size; index++) {
      await file.read(header, 0, 8, offset);
      const chunk = header.toString('ascii', 0, 4);
      const size = header.readUInt32LE(4);
      if (chunk === 'fmt ') {
        if (size < 16) throw new Error('Invalid WAV format.');
        await file.read(header, 0, Math.min(size, 40), offset + 8);
        const format = header.readUInt16LE(0);
        channels = header.readUInt16LE(2); rate = header.readUInt32LE(4); frameBytes = header.readUInt16LE(12);
        if ((format !== 1 && !(format === 65534 && size >= 40 && header.readUInt16LE(24) === 1)) || header.readUInt16LE(14) !== 16) throw new Error('Waveform requires PCM16 audio.');
      }
      if (chunk === 'data') { dataStart = offset + 8; dataSize = Math.min(size, stat.size - dataStart); break; }
      offset += 8 + size + size % 2;
    }
    if (!dataStart || channels < 1 || channels > 8 || frameBytes !== channels * 2 || rate <= 0) throw new Error('The preview waveform is unavailable.');
    const frames = Math.floor(dataSize / frameBytes);
    if (!frames) throw new Error('The preview contains no audio samples.');
    const points = Math.min(400, frames);
    const buffer = Buffer.alloc(8192);
    const peaks: number[] = [];
    for (let index = 0; index < points; index++) {
      const first = Math.floor(index * frames / points);
      const last = Math.floor((index + 1) * frames / points);
      const count = Math.min(last - first, Math.floor(buffer.length / frameBytes));
      const start = first + Math.floor((last - first - count) / 2);
      const { bytesRead } = await file.read(buffer, 0, count * frameBytes, dataStart + start * frameBytes);
      let peak = 0;
      for (let sample = 0; sample + 1 < bytesRead; sample += 2) peak = Math.max(peak, Math.abs(buffer.readInt16LE(sample)) / 32768);
      peaks.push(Number(peak.toFixed(4)));
    }
    return { peaks, duration: frames / rate };
  } finally { await file.close(); }
}
