/**
 * Turn yt-dlp's format list into the choices shown in the UI.
 *
 * yt-dlp's fields are inconsistent across sites, so stream contents are inferred carefully:
 * - `audio_ext` is "none" for every format that contains video, even when it also has audio,
 *   so it must not be used to decide whether a video format includes sound.
 * - Some extractors (Facebook progressive MP4s) report no codecs at all; `video_ext` still
 *   tells us the format is a video.
 */

type RawFormat = Record<string, any>;
const FORMAT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

const known = (value: unknown) => typeof value === 'string' && value !== '' && value !== 'none';

export function formatHasVideo(f: RawFormat): boolean {
  if (typeof f.vcodec === 'string' && f.vcodec) return f.vcodec !== 'none';
  if (typeof f.video_ext === 'string' && f.video_ext) return f.video_ext !== 'none';
  return Boolean(f.height || f.width);
}

/** true = has audio, false = no audio, null = unknown (the site did not report codecs). */
export function formatHasAudio(f: RawFormat): boolean | null {
  if (typeof f.acodec === 'string' && f.acodec) return f.acodec !== 'none';
  if (!formatHasVideo(f) && known(f.audio_ext)) return true;
  return null;
}

function isSelectable(f: RawFormat): boolean {
  if (f.ext === 'mhtml' || f.protocol === 'mhtml' || f.format_note === 'storyboard') return false;
  if (!FORMAT_ID_PATTERN.test(String(f.format_id || ''))) return false;
  return formatHasVideo(f) || formatHasAudio(f) === true;
}

/** Sites such as Facebook label progressive streams "hd"/"sd" without dimensions. */
function namedQualityRank(f: RawFormat): number {
  const id = String(f.format_id || '').toLowerCase();
  if (/^hd\b|[-_]hd$/.test(id)) return 720;
  if (/^sd\b|[-_]sd$/.test(id)) return 360;
  return 0;
}

/**
 * Collapse renditions that differ only by CDN or mirror (Vimeo lists every stream on two CDNs,
 * TikTok on two mirrors, YouTube adds "-drc" audio twins). yt-dlp orders formats from worst to
 * best, so the later entry is the one yt-dlp itself prefers; some lower-ranked mirrors only
 * reveal DRM when the download starts.
 */
function renditionKey(f: RawFormat): string {
  const id = String(f.format_id);
  const bitrate = Math.round((f.tbr || f.vbr || f.abr || 0) / 10);
  const isVideo = formatHasVideo(f);
  // Mirrors share a rendition label: "<cdn>-audio-high-English", "<id>-0"/"<id>-1", "<itag>-drc".
  const audioLabel = id.match(/(audio-[a-z]+(?:-[a-z]+)?)$/i)?.[1]?.toLowerCase() || '';
  const isMirrorId = Boolean(audioLabel) || /-(?:drc|\d)$/i.test(id) || /^(?:hls|dash|http)-/i.test(id);
  // Without dimensions, a bitrate, or a mirror-style id there is nothing to compare: keep it.
  if (!f.height && !bitrate && !isMirrorId) return `id:${id}`;
  return [
    isVideo ? 'v' : 'a', f.width || 0, f.height || 0, Math.round(f.fps || 0),
    String(f.vcodec || '').split('.')[0], String(f.acodec || '').split('.')[0], bitrate,
    f.protocol || '', f.ext || '', f.language || '', isVideo ? '' : audioLabel,
  ].join('|');
}

function dedupeRenditions(formats: RawFormat[]): RawFormat[] {
  const byKey = new Map<string, RawFormat>();
  for (const f of formats) {
    if (f.has_drm === true) continue;
    byKey.set(renditionKey(f), f); // later = yt-dlp's preferred copy
  }
  return [...byKey.values()];
}

export function buildMediaFormatList(info: any) {
  const videoFormats: any[] = [];
  const videoOnlyFormats: any[] = [];
  const audioFormats: any[] = [];
  const rawFormats = dedupeRenditions((Array.isArray(info?.formats) ? info.formats : []).filter(isSelectable))
    .sort((a: RawFormat, b: RawFormat) => {
      const aResolution = Math.max(a.height || 0, a.width || 0) || namedQualityRank(a);
      const bResolution = Math.max(b.height || 0, b.width || 0) || namedQualityRank(b);
      if (bResolution !== aResolution) return bResolution - aResolution;
      if ((b.fps || 0) !== (a.fps || 0)) return (b.fps || 0) - (a.fps || 0);
      const bitrate = (b.tbr || b.vbr || b.abr || 0) - (a.tbr || a.vbr || a.abr || 0);
      return bitrate || (Number(b.quality) || 0) - (Number(a.quality) || 0);
    });

  for (const f of rawFormats) {
    const formatId = String(f.format_id);
    const hasVideo = formatHasVideo(f);
    const hasAudio = formatHasAudio(f);
    const width = Number(f.width || 0) || undefined;
    const height = Number(f.height || 0) || undefined;
    const resRank = width && height ? Math.min(width, height) : Math.max(width || 0, height || 0) || namedQualityRank(f);
    const dimensions = width && height ? `${width}×${height}` : (f.resolution && f.resolution !== 'audio only' ? f.resolution : '');
    const namedQuality = namedQualityRank(f) ? formatId.toUpperCase() : '';
    const effectiveResolution = width || height ? `${resRank}p` : (namedQuality || f.format_note || 'Video');
    const fps = Number(f.fps || 0) || undefined;
    const codec = String(f.vcodec || '').split('.')[0];
    const ext = String(f.ext || '').toUpperCase();
    const fpsLabel = fps ? ` · ${fps} fps` : '';
    const dimensionsLabel = dimensions ? ` · ${dimensions}` : '';
    const codecLabel = codec && codec !== 'none' ? ` · ${codec}` : '';
    const extLabel = ext ? ` · ${ext}` : '';
    const filesize = f.filesize || f.filesize_approx;

    if (hasVideo) {
      const quality = `${effectiveResolution}${dimensionsLabel}${fpsLabel}${codecLabel}${extLabel}`;
      // Known audio: download as-is. No audio: merge the best audio track. Unknown: merge with a
      // fallback to the stream itself (`ID+bestaudio/ID`), which is safe either way.
      videoFormats.push({
        itag: hasAudio === true ? `yt:video:${formatId}` : `yt:merge:${formatId}`,
        quality: hasAudio === true ? `${quality} · audio included` : hasAudio === false ? `${quality} · merge best audio` : `${quality} · best available audio`,
        type: 'video',
        fps,
        width,
        height,
        vcodec: f.vcodec,
        acodec: f.acodec,
        bitrate: Number(f.tbr || f.vbr || 0) || undefined,
        filesize,
        ext: f.ext,
        resRank,
      });

      if (hasAudio === false) {
        videoOnlyFormats.push({
          itag: `yt:raw:${formatId}`,
          quality: `${quality} · video only`,
          type: 'video-only',
          fps,
          width,
          height,
          vcodec: f.vcodec,
          bitrate: Number(f.tbr || f.vbr || 0) || undefined,
          filesize,
          ext: f.ext,
          resRank,
        });
      }
    } else if (hasAudio) {
      const abr = Number(f.abr || 0);
      const audioCodec = String(f.acodec || f.audio_ext || 'Audio').split('.')[0];
      audioFormats.push({
        itag: `yt:audio-source:${formatId}`,
        quality: `${abr ? `${Math.round(abr)} kbps · ` : ''}${audioCodec}${extLabel} · original audio`,
        type: 'audio',
        acodec: f.acodec,
        bitrate: Number(f.abr || f.tbr || 0) || undefined,
        filesize,
        ext: f.ext,
        sourceExt: f.ext,
        resRank: abr,
      });
    }
  }

  // Keep explicit MP3 encoder targets for playlist and legacy UI controls.
  const mp3Targets = [
    { itag: 'audio-320', quality: 'MP3 · 320 kbps target', type: 'audio', ext: 'mp3' },
    { itag: 'audio-256', quality: 'MP3 · 256 kbps target', type: 'audio', ext: 'mp3' },
    { itag: 'audio-128', quality: 'MP3 · 128 kbps target', type: 'audio', ext: 'mp3' },
  ];

  if (videoFormats.length === 0 && (formatHasVideo(info || {}) || !(info?.formats?.length))) {
    videoFormats.push({ itag: 'best', quality: 'Best available video and audio', type: 'video', resRank: 0 });
  }
  if (audioFormats.length === 0) {
    audioFormats.push({ itag: 'audio', quality: 'Best available audio · MP3 output', type: 'audio', ext: 'mp3' });
  }

  const byQuality = (a: any, b: any) => (b.resRank || 0) - (a.resRank || 0) || (b.fps || 0) - (a.fps || 0) || (b.bitrate || 0) - (a.bitrate || 0);
  videoFormats.sort(byQuality);
  videoOnlyFormats.sort(byQuality);
  audioFormats.sort((a, b) => (b.resRank || 0) - (a.resRank || 0));

  return [...videoFormats, ...videoOnlyFormats, ...audioFormats, ...mp3Targets];
}
