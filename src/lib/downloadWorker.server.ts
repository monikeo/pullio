import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { DownloadRecord, DownloadStage, decodeDownloadProgress, postprocessStage } from './downloads';
import { StallWatchdog } from './downloadJournal.server';

// Missing yt-dlp fields otherwise render as bare NA, which is not valid JSON.
const PROGRESS_TEMPLATE = 'download:__PULLIO_PROGRESS__{"downloaded":%(progress.downloaded_bytes|null)j,"total":%(progress.total_bytes|null)j,"estimate":%(progress.total_bytes_estimate|null)j,"speed":%(progress.speed|null)j,"eta":%(progress.eta|null)j,"status":%(progress.status|null)j,"video":%(info.vcodec|null)j,"audio":%(info.acodec|null)j}';
const MEDIA_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.m4v', '.ts', '.gif', '.m4a', '.mp3', '.ogg', '.opus', '.flac', '.aac', '.wav']);

export async function runDownloadWorker(job: DownloadRecord, options: {
  directory: string; executable: string; format: string; runtimeArgs: string[]; ffmpeg: string; ffmpegDirectory: string;
  demo: boolean; processes: Map<string, any>; current: () => boolean; update: (force?: boolean) => void;
  stop: () => Promise<void>; complete: (filePath: string) => void;
}) {
  job.stage = options.demo ? 'converting' : 'extracting'; job.stageProgress = undefined;
  job.speed = 'Starting…'; job.eta = '--:--'; options.update(true);
  const out = path.join(options.directory, `${job.jobId}.%(ext)s`);
  const args = ['--newline', '--progress', '--no-playlist', '--no-warnings', '--continue', '--part', '--no-mtime',
    '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3',
    '--progress-template', PROGRESS_TEMPLATE,
    '--progress-template', 'postprocess:__PULLIO_POST__{"postprocessor":%(progress.postprocessor|null)j,"status":%(progress.status|null)j}',
    '--print', 'after_move:__PULLIO_FILE__%(filepath)j', ...options.runtimeArgs, '-f', options.format, '-o', out];
  if (options.ffmpegDirectory) args.push('--ffmpeg-location', options.ffmpegDirectory);
  const originalAudio = String(job.itag).toLowerCase().startsWith('yt:audio-source:');
  if (job.type === 'audio' && !originalAudio && options.ffmpegDirectory) {
    const bitrate = String(job.itag).match(/(?:audio-)?(128|192|256|320)/)?.[1] || '320';
    args.push('-x', '--audio-format', job.targetContainer || 'mp3', '--audio-quality', `${bitrate}k`);
  } else if (job.type === 'video' && options.ffmpegDirectory) {
    args.push('--merge-output-format', job.targetContainer || 'mkv', '--remux-video', job.targetContainer || 'mkv');
  }
  args.push('--', job.url);
  const demoFile = path.join(options.directory, `${job.jobId}.${job.targetContainer || (job.type === 'audio' ? 'mp3' : 'mp4')}`);
  const demoVideoEncoder = job.targetContainer === 'webm' ? ['-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac'];
  const demoArgs = job.type === 'audio'
    ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', job.targetContainer === 'm4a' ? 'aac' : 'libmp3lame']
    : ['-f', 'lavfi', '-i', 'color=c=0x121212:s=640x360:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', ...demoVideoEncoder, '-shortest'];
  const child: ChildProcess = options.demo
    ? spawn(options.ffmpeg || 'ffmpeg', ['-y', '-nostdin', '-hide_banner', ...demoArgs, '-progress', 'pipe:1', demoFile], { detached: process.platform !== 'win32', windowsHide: true })
    : spawn(options.executable, args, { detached: process.platform !== 'win32', windowsHide: true });
  options.processes.set(job.jobId, child);
  let stderr = ''; let stdoutBuffer = ''; let stderrBuffer = ''; let reportedFile = ''; let stallError = '';
  const stdoutDecoder = new StringDecoder('utf8'); const stderrDecoder = new StringDecoder('utf8');
  let lastDownloaded = -1; let lastStreamStage = '';
  const envTimeout = Number(process.env.PULLIO_DOWNLOAD_STALL_MS);
  const transferTimeout = Number.isFinite(envTimeout) && envTimeout >= 1000 ? Math.min(envTimeout, 30 * 60_000) : 3 * 60_000;
  const processing = () => ['merging', 'converting', 'finalizing'].includes(job.stage);
  const watchdog = new StallWatchdog(() => processing() ? Math.max(transferTimeout, process.env.NODE_ENV === 'test' ? transferTimeout : 10 * 60_000) : transferTimeout, () => {
    if (!options.current()) return;
    stallError = 'This download stopped making progress. Check the connection and retry; available partial files are retained.';
    void options.stop();
  });
  const sizes = new Map<string, string>();
  const fileActivity = setInterval(() => {
    if (!options.current()) return;
    try {
      for (const name of fs.readdirSync(options.directory)) {
        if (!name.startsWith(`${job.jobId}.`)) continue;
        const stat = fs.statSync(path.join(options.directory, name));
        const signature = `${stat.size}:${stat.mtimeMs}`;
        if (sizes.get(name) !== signature) { sizes.set(name, signature); watchdog.activity(); }
      }
    } catch {}
  }, 1000);
  const stage = (next: DownloadStage) => {
    if (job.stage === next) return;
    job.stage = next; job.stageProgress = undefined; job.eta = '--:--'; watchdog.activity(); options.update(true);
  };
  const parse = (line: string) => {
    if (!options.current()) return;
    const progress = decodeDownloadProgress(line);
    if (progress) {
      if (progress.downloaded > lastDownloaded || progress.stage !== lastStreamStage) watchdog.activity();
      lastDownloaded = progress.downloaded; lastStreamStage = progress.stage;
      stage(progress.stage);
      job.downloadedBytes = progress.downloaded; job.totalBytes = progress.total;
      job.bytesDownloaded = `${(progress.downloaded / 1048576).toFixed(1)} MB`;
      job.fileSize = progress.total ? `${(progress.total / 1048576).toFixed(1)} MB` : 'Unknown';
      job.speed = `${(progress.speed / 1048576).toFixed(1)} MB/s`;
      job.eta = progress.eta ? `${Math.floor(progress.eta / 60)}:${String(Math.round(progress.eta % 60)).padStart(2, '0')}` : '--:--';
      const ratio = progress.total ? Math.max(0, Math.min(1, progress.downloaded / progress.total)) : 0;
      job.stageProgress = progress.total ? Math.round(ratio * 1000) / 10 : undefined;
      const overall = progress.stage === 'video' ? 5 + ratio * 55 : progress.stage === 'audio' && job.type === 'video' ? 60 + ratio * 15 : 5 + ratio * 75;
      job.progress = Math.min(95, Math.max(job.progress, overall)); options.update();
      if (progress.finished) { stage('finalizing'); job.progress = Math.max(job.progress, 80); }
      return;
    }
    const post = postprocessStage(line);
    if (post) { stage(post); job.progress = Math.max(job.progress, post === 'merging' ? 82 : post === 'converting' ? 88 : 96); return; }
    const marker = '__PULLIO_FILE__';
    if (line.includes(marker)) {
      try { reportedFile = JSON.parse(line.slice(line.indexOf(marker) + marker.length)); } catch {}
      stage('finalizing');
    }
    if (options.demo && line.startsWith('out_time_us=')) {
      const time = Number(line.slice(12));
      if (time > 0) { watchdog.activity(); job.progress = Math.min(95, time / 120000); options.update(); }
    }
  };
  const lines = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const decoded = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk);
    if (stream === 'stderr') stderr = (stderr + decoded).slice(-32000);
    const text = (stream === 'stdout' ? stdoutBuffer : stderrBuffer) + decoded;
    const parts = text.split(/[\r\n]+/); const rest = (parts.pop() || '').slice(-65536);
    if (stream === 'stdout') stdoutBuffer = rest; else stderrBuffer = rest;
    for (const line of parts) parse(line);
  };
  child.stdout?.on('data', (chunk) => lines(chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => lines(chunk, 'stderr'));
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (!options.current()) return;
    parse(stdoutBuffer + stdoutDecoder.end()); parse(stderrBuffer + stderrDecoder.end());
    if (code !== 0 || stallError) throw new Error(stallError || stderr || `Download engine exited with code ${code}.`);
    const candidate = options.demo ? demoFile : reportedFile;
    if (typeof candidate !== 'string' || !candidate) throw new Error('The download finished but its output file is unavailable.');
    const resolved = fs.realpathSync(candidate);
    if (!resolved.startsWith(`${fs.realpathSync(options.directory)}${path.sep}`) || !path.basename(resolved).startsWith(`${job.jobId}.`) || !MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase()) || !fs.statSync(resolved).size) throw new Error('The download returned an invalid output file.');
    options.complete(resolved);
  } finally {
    watchdog.stop(); clearInterval(fileActivity);
    if (options.processes.get(job.jobId) === child) options.processes.delete(job.jobId);
  }
}
