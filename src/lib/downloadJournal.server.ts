import fs from 'node:fs/promises';
import path from 'node:path';
import type { DownloadRecord } from './downloads';

export interface DownloadSnapshot { version: 1; maxConcurrentDownloads: number; jobs: DownloadRecord[] }

export class DownloadJournal {
  private pending: string | null = null;
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  error: string | null = null;
  recoveryWarning: string | null = null;
  constructor(readonly file: string) {}
  async load(): Promise<unknown> {
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 10 * 1024 * 1024) throw new Error('The saved queue is too large.');
      const snapshot = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.jobs)) throw new Error('Unsupported saved queue.');
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.recoveryWarning = 'The previous queue could not be read. Existing media files have been kept on disk.';
        try { await fs.rename(this.file, `${this.file}.unreadable-${Date.now()}`); } catch {}
      }
      return null;
    }
  }
  save(snapshot: DownloadSnapshot) {
    this.pending = JSON.stringify(snapshot);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 200);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.writing) { await this.writing; if (this.pending && !this.error) return this.flush(); return; }
    if (!this.pending) return;
    const content = this.pending; this.pending = null;
    this.writing = (async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.tmp`;
        await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, this.file);
        this.error = null;
      } catch {
        if (!this.pending) this.pending = content;
        this.error = 'Queue recovery could not be saved. Check the server storage and permissions.';
      }
    })();
    await this.writing; this.writing = null;
    if (this.pending && !this.error) await this.flush();
    else if (this.pending && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 5000);
      this.timer.unref();
    }
  }
}

export class StallWatchdog {
  private lastActivity: number;
  private timer: ReturnType<typeof setInterval>;
  constructor(private timeout: () => number, private stalled: () => void, intervalMs = 1000, private clock = () => performance.now()) {
    this.lastActivity = this.clock();
    this.timer = setInterval(() => {
      if (this.clock() - this.lastActivity >= this.timeout()) { this.stop(); this.stalled(); }
    }, intervalMs);
    this.timer.unref();
  }
  activity() { this.lastActivity = this.clock(); }
  stop() { clearInterval(this.timer); }
}
