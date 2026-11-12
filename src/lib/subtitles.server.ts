import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface SubtitleTrackInfo {
  lang: string;
  name: string;
  auto: boolean;
}

const LANGUAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export function isValidSubtitleLanguage(value: unknown): value is string {
  return typeof value === 'string' && LANGUAGE_PATTERN.test(value);
}

let languageNames: Intl.DisplayNames | null | undefined;
/** Human-readable language name for a code such as `en`, `pt-BR`, or `en-orig`. */
function languageName(code: string): string | null {
  if (languageNames === undefined) {
    try { languageNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { languageNames = null; }
  }
  try {
    const name = languageNames?.of(code.replace(/-orig$/i, ''));
    return name && name.toLowerCase() !== code.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}

/**
 * Choose the subtitle tracks worth offering. Creator-provided tracks come first; from the
 * (often 100+) machine-translated caption tracks, keep only the original-language ones.
 */
export function selectSubtitleTracks(info: any, limit = 20): SubtitleTrackInfo[] {
  const tracks: SubtitleTrackInfo[] = [];
  const seen = new Set<string>();
  const add = (lang: string, list: unknown, auto: boolean) => {
    if (tracks.length >= limit || !isValidSubtitleLanguage(lang) || lang === 'live_chat' || !Array.isArray(list) || !list.length) return;
    const key = `${auto ? 'auto' : 'manual'}:${lang}`;
    if (seen.has(key)) return;
    seen.add(key);
    const first = list[0] as { name?: unknown };
    const provided = typeof first?.name === 'string' && first.name.trim() && first.name.trim() !== lang ? first.name.trim().slice(0, 80) : '';
    const name = provided || languageName(lang) || lang;
    tracks.push({ lang, name: auto && !/auto|original/i.test(name) ? `${name} (auto-generated)` : name, auto });
  };

  for (const [lang, list] of Object.entries(info?.subtitles || {})) add(lang, list, false);

  const automatic = Object.entries(info?.automatic_captions || {}) as Array<[string, unknown]>;
  const language = typeof info?.language === 'string' ? info.language.toLowerCase() : '';
  const isOriginal = ([lang, list]: [string, unknown]) => {
    const name = Array.isArray(list) && typeof (list[0] as any)?.name === 'string' ? (list[0] as any).name : '';
    return lang.endsWith('-orig') || /\(original\)/i.test(name) || (language && lang.toLowerCase() === language);
  };
  automatic.filter(isOriginal).forEach(([lang, list]) => add(lang, list, true));
  // English auto-captions are the most commonly requested translation.
  automatic.filter(([lang]) => lang === 'en').forEach(([lang, list]) => add(lang, list, true));
  return tracks;
}

export interface SubtitleDownloadOptions {
  executable: string;
  ffmpegDirectory: string;
  runtimeArgs: string[];
  url: string;
  lang: string;
  auto: boolean;
  format: 'srt' | 'vtt';
  workDirectory: string;
  timeoutMs?: number;
}

/** Download one subtitle track through yt-dlp and convert it to SRT or WebVTT. Returns the file path. */
export async function downloadSubtitle(options: SubtitleDownloadOptions): Promise<string> {
  if (!isValidSubtitleLanguage(options.lang)) throw new Error('Choose a valid subtitle language.');
  await fs.mkdir(options.workDirectory, { recursive: true });
  const args = [
    '--skip-download', '--no-playlist', '--no-warnings', '--socket-timeout', '30',
    options.auto ? '--write-auto-subs' : '--write-subs',
    '--sub-langs', options.lang,
    '--sub-format', `${options.format}/vtt/srt/best`,
    ...(options.ffmpegDirectory ? ['--ffmpeg-location', options.ffmpegDirectory, '--convert-subs', options.format] : []),
    ...options.runtimeArgs,
    '-o', path.join(options.workDirectory, 'subtitle.%(ext)s'),
    '--', options.url,
  ];
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(options.executable, args, { windowsHide: true });
    let errorText = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk.toString()).slice(-8000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Subtitle download timed out. Retry in a moment.')); }, options.timeoutMs ?? 120_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(errorText);
      else reject(new Error(errorText.split(/\r?\n/).find((line) => line.startsWith('ERROR:'))?.replace(/^ERROR:\s*/, '') || 'The subtitle track could not be downloaded.'));
    });
  });
  const files = await fs.readdir(options.workDirectory);
  const preferred = files.find((name) => name.endsWith(`.${options.format}`)) || files.find((name) => /\.(vtt|srt|ass|ttml|srv\d|json3)$/i.test(name));
  if (!preferred) throw new Error(/no subtitles|there are no/i.test(stderr) ? 'This video has no subtitles in that language.' : 'The subtitle track could not be downloaded.');
  return path.join(options.workDirectory, preferred);
}
