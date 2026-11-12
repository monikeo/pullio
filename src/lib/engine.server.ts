import { execFile } from 'node:child_process';
import fs from 'node:fs';

export interface EngineStatus {
  ytDlp: { available: boolean; version: string | null; path: string };
  ffmpeg: { available: boolean; version: string | null };
  node: string;
  updating: boolean;
  lastUpdate: { at: number; ok: boolean; message: string; from: string | null; to: string | null } | null;
}

function run(file: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((error as any).code) : 1) : 0;
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || error?.message || ''), code });
    });
  });
}

/** Tracks the bundled yt-dlp and FFmpeg binaries and performs in-place yt-dlp updates. */
export class MediaEngine {
  private ytDlpVersion: Promise<string | null> | null = null;
  private ffmpegVersion: Promise<string | null> | null = null;
  private updating: Promise<EngineStatus['lastUpdate']> | null = null;
  private lastUpdate: EngineStatus['lastUpdate'] = null;

  constructor(readonly ytDlpPath: string, readonly ffmpegPath: string | null) {}

  getYtDlpVersion(): Promise<string | null> {
    if (!this.ytDlpVersion) {
      this.ytDlpVersion = fs.existsSync(this.ytDlpPath)
        ? run(this.ytDlpPath, ['--version'], 20_000).then(({ stdout, code }) => (code === 0 && /^\d{4}\.\d{2}\.\d{2}/.test(stdout.trim()) ? stdout.trim().split(/\s+/)[0] : null))
        : Promise.resolve(null);
      // Retry discovery later if the first probe failed.
      void this.ytDlpVersion.then((version) => { if (!version) this.ytDlpVersion = null; });
    }
    return this.ytDlpVersion;
  }

  getFfmpegVersion(): Promise<string | null> {
    if (!this.ffmpegVersion) {
      this.ffmpegVersion = this.ffmpegPath && fs.existsSync(this.ffmpegPath)
        ? run(this.ffmpegPath, ['-hide_banner', '-version'], 20_000).then(({ stdout }) => stdout.match(/ffmpeg version (\S+)/)?.[1] || null)
        : Promise.resolve(null);
    }
    return this.ffmpegVersion;
  }

  /** Age of the installed yt-dlp release in days (yt-dlp versions are release dates). */
  static versionAgeDays(version: string | null, now = Date.now()): number | null {
    const match = version?.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (!match) return null;
    const released = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isFinite(released) ? Math.max(0, Math.floor((now - released) / 86_400_000)) : null;
  }

  async status(): Promise<EngineStatus> {
    const [ytDlpVersion, ffmpegVersion] = await Promise.all([this.getYtDlpVersion(), this.getFfmpegVersion()]);
    return {
      ytDlp: { available: Boolean(ytDlpVersion), version: ytDlpVersion, path: this.ytDlpPath },
      ffmpeg: { available: Boolean(ffmpegVersion), version: ffmpegVersion },
      node: process.versions.node,
      updating: Boolean(this.updating),
      lastUpdate: this.lastUpdate,
    };
  }

  get isUpdating() { return Boolean(this.updating); }

  /** Resolves once no update is replacing the yt-dlp binary. */
  waitForIdle(): Promise<void> {
    return this.updating ? this.updating.then(() => undefined, () => undefined) : Promise.resolve();
  }

  /**
   * Run yt-dlp's self-updater against the official stable release channel. Platform sites change
   * often, so an outdated extractor is the most common cause of failed downloads.
   */
  update(): Promise<EngineStatus['lastUpdate']> {
    if (this.updating) return this.updating;
    this.updating = (async () => {
      const from = await this.getYtDlpVersion();
      const { stdout, stderr, code } = await run(this.ytDlpPath, ['--update-to', 'stable', '--no-warnings'], 180_000);
      this.ytDlpVersion = null;
      const to = await this.getYtDlpVersion();
      const output = `${stdout}\n${stderr}`;
      const upToDate = /up to date|is up-to-date/i.test(output);
      const ok = code === 0 && Boolean(to);
      const message = !ok
        ? (/permission|access is denied|read-only|EACCES|EPERM/i.test(output)
          ? 'The engine could not be replaced. Make sure the server can write to node_modules/youtube-dl-exec/bin, then retry.'
          : /pip|package manager|not supported/i.test(output)
            ? 'This yt-dlp install cannot update itself. Reinstall dependencies with npm to get a newer release.'
            : 'The update did not finish. Check the server connection and retry.')
        : upToDate || from === to ? `yt-dlp ${to} is already the latest stable release.` : `Updated yt-dlp from ${from || 'unknown'} to ${to}.`;
      this.lastUpdate = { at: Date.now(), ok, message, from, to };
      return this.lastUpdate;
    })().finally(() => { this.updating = null; });
    return this.updating;
  }
}
