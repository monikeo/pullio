# Pullio — Universal Media Downloader & Transcoder Engine

A high-performance, self-hosted media extraction and transcoding platform built with TypeScript, Express, React 19, and Vite. Powered by native `yt-dlp` execution and bundled static `FFmpeg` binaries, Pullio allows seamless extraction, stream muxing, and batch conversion across all major video and social platforms without third-party web scraper subscriptions.

---

## Key Highlights

- **Multi-Platform Support**: Built-in extractors and cascade bypass configurations for **YouTube** (Videos, Shorts, Playlists), **TikTok**, **Douyin (抖音)**, **Facebook** (Watch, Reels, Shares), **Instagram** (Reels, Posts, Stories), **Bilibili (哔哩哔哩)**, **Vimeo**, **Pinterest**, **XiaoHongShu (小红书)**, **X (Twitter)**, and **SoundCloud**.
- **Adaptive Multi-Tier Bypass Engine**: Built-in cascade retry mechanism that rotates client personas, headers, and player APIs (Web, Android, iOS Safari, mobile headers, and crawler bypasses) to circumvent 403 Forbidden, bot challenges, and rate limits.
- **True Resolution & Aspect-Ratio Preservation**: Intelligent dimension matching that preserves Full HD vertical portrait videos (1080x1920 Instagram Reels & YouTube Shorts) without unintended downscaling, alongside full 4K (2160p), 2K (1440p), 1080p60, 720p, 480p, and 360p stream muxing.
- **FFmpeg Transcoding & Studio Audio**: Direct extraction and transcoding to MP3 with precision bitrate targeting (320kbps Studio Master, 256kbps High Quality, 128kbps Standard), plus lossless container remuxing to standard MP4 containers.
- **Local Media Transcoder Suite**: Standalone conversion studio to convert local videos and audio files between MP4, MKV, WebM, MOV, AVI, FLV, WMV, GIF, MP3, WAV, FLAC, AAC, M4A, OGG, and OPUS with custom bitrate presets and CRF controls.
- **Real-Time WebSocket Pipeline**: Zero-polling progress updates broadcast via WebSocket with throttled event emitters (150ms) to ensure smooth 60fps UI rendering during multi-gigabyte transfers.
- **Zero-Disk In-Browser Streaming**: Direct HTTP stream pipe endpoint (`GET /api/stream`) that streams live media directly to the client browser without intermediate server disk writes.
- **Hardened Security & Cookie Management**: Automated Latin-1 ASCII sanitization on Netscape `cookies.txt` imports to eliminate encoding crashes, SSRF safeguards on thumbnail proxies, and strict file validation.

---

## Supported Platforms Matrix

| Platform | Features Supported | Resolution & Audio Tiers | Notes / Authentication |
| :--- | :--- | :--- | :--- |
| **YouTube** | Videos, Shorts, Playlists, Livestream VoDs | 4K (2160p60), 2K (1440p), 1080p60, 720p, 480p, 360p, 320k MP3 | Uses native multi-client extraction. Node 22+ runtime passed for signature deciphering. |
| **Instagram** | Reels, Posts, Stories, Carousel items | 1080p Vertical (1080x1920), 720p, Square 1:1, MP3 | Guest access or session cookies (`sessionid`) via Settings for restricted posts. |
| **Facebook** | Watch videos, Reels, Mobile shares (`fb.watch`) | HD (1080p/720p), SD (480p/360p), MP3 Audio | Uses crawler user-agent for progressive direct streams; supports redirect following. |
| **TikTok** | Watermark-free videos, Audio tracks | 1080p, 720p, 540p, MP3 | Automatic shortlink (`vt.tiktok.com`) redirect resolution. |
| **Douyin (抖音)** | Video posts, Notes, User shares | Full HD 1080p, 720p, MP3 | Handles `modal_id` parameter normalization and desktop/mobile share links. |
| **Bilibili (哔哩哔哩)** | BV / av videos, Bangumi clips | 1080p, 720p, 480p, 360p, MP3 | Supports Netscape session cookies (`SESSDATA`) to bypass HTTP 412 verification. |
| **XiaoHongShu (小红书)**| Video notes, shortlink shares | 1080p, 720p MP4, MP3 | Automatically distinguishes video notes from static image notes. |
| **Pinterest** | Video pins, Board items | Original 1080p/720p MP4, MP3 | Direct MP4 stream extraction from pin metadata. |
| **Vimeo** | Public showcase videos | 4K, 1080p, 720p, MP3 | Standard progressive MP4 and HLS stream recovery. |
| **X (Twitter)** | Video tweets, Space recordings | 1080p, 720p, 480p, MP3 | Multi-tier syndication API fallback. |
| **SoundCloud** | Tracks, Sets, Playlists | 320kbps MP3, 256kbps, 128kbps | Audio-first extraction pipeline. |

---

## System Requirements

- **Node.js**: `v22.0.0` or higher (Node 22+ required for yt-dlp internal JavaScript execution and challenge solving).
- **Operating System**: Windows 10/11, Linux (Ubuntu 20.04+, Debian 11+, Arch, Alpine), or macOS (Apple Silicon / Intel).
- **Disk Space**: 500 MB for repository dependencies and bundled binaries. Temporary scratch space recommended for active downloads.
- **Memory**: Minimum 1 GB RAM (2 GB+ recommended for concurrent FFmpeg transcoding jobs).

> **Note on Binaries:** Both `yt-dlp` (via `youtube-dl-exec`) and `ffmpeg` (via `ffmpeg-static`) are installed automatically during `npm install`. You do not need to manually configure system path variables for FFmpeg.

---

## Quick Start

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/your-username/video-downloader.git
cd video-downloader
npm install
```

### 2. Run the Development Server

```bash
npm run dev
```

The application will start on `http://localhost:3000`.

### 3. Build & Run for Production

```bash
# Build the client bundle and bundle the server using esbuild
npm run build

# Start the optimized Node.js production server
npm start
```

---

## Architecture & Workflow

```
[ User Browser / PWA ]
         │
         ├── REST API (JSON) ──> Express Server (port 3000)
         └── WebSockets ───────> WS Server (Job Progress: 150ms throttle)
                                       │
                         ┌─────────────┴─────────────┐
                         ▼                           ▼
                 [ Media Downloader ]       [ File Converter ]
                         │                           │
                   yt-dlp Worker               FFmpeg Worker
                         │                           │
          ┌──────────────┴──────────────┐            │
          ▼                             ▼            ▼
   [ Stream Dump ]              [ Stream Muxing / Remuxing ]
   - Cascade Bypass (Tier 1/2)   - video-only + audio streams
   - Cookies File Injection      - Transcode to MP3 / MP4
   - Header & UA Rotation        - Codec conversion (x264/AAC)
          │                             │
          └──────────────┬──────────────┘
                         ▼
             downloads/ & converted/
                         │
                         ▼
              Client Download Stream
```

1. **URL Resolution**: Input links pass through regex extraction, parameter de-tracking (stripping `utm_*`, `igsh`, `si`, `spm_id_from`), and HTTP redirect resolution for shortlinks (`fb.watch`, `vt.tiktok.com`, `b23.tv`, `pin.it`).
2. **Metadata & Stream Probing**: `yt-dlp` dumps available formats. The format builder filters non-media storyboard tracks (`mhtml`), assesses aspect ratios for vertical versus horizontal orientation, and presents deduplicated resolution options.
3. **Queue & Concurrency Limiting**: Download requests are queued in memory (`MAX_CONCURRENT_DOWNLOADS = 2`) to prevent IP bans or bot blocks.
4. **Muxing & Container Normalization**: When separate video and audio streams are selected, FFmpeg muxes the output directly into standard MP4 (`--merge-output-format mp4`). Audio extraction triggers FFmpeg with exact bitrate targeting (`-b:a 320k`).
5. **Real-Time Client Telemetry**: Background worker standard output is parsed for download percentage, transfer speed, and ETA, broadcast to subscribed clients via WebSocket.

---

## API Reference

### Media Downloader Endpoints

#### `POST /api/analyze`
Extracts metadata, thumbnails, author details, subtitles, and available streams for a given URL.

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
}
```

**Response:**
```json
{
  "provider": "youtube",
  "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "title": "Big Buck Bunny 60fps 4K - Official Blender Foundation",
  "thumbnail": "https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg",
  "author": "Blender",
  "duration": 634,
  "formats": [
    { "itag": "2160p", "quality": "2160p 4K Ultra HD 60fps MP4", "type": "video", "fps": 60, "ext": "mp4" },
    { "itag": "1080p", "quality": "1080p Full HD 60fps MP4", "type": "video", "fps": 60, "ext": "mp4" },
    { "itag": "720p", "quality": "720p HD 60fps MP4", "type": "video", "fps": 60, "ext": "mp4" },
    { "itag": "audio-320", "quality": "320kbps MP3 (Studio Master)", "type": "audio", "ext": "mp3" }
  ],
  "isPlaylist": false
}
```

#### `POST /api/queue`
Enqueues a specific format for download.

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "itag": "1080p",
  "title": "Big Buck Bunny",
  "thumbnail": "https://...",
  "provider": "youtube"
}
```

**Response:**
```json
{
  "jobId": "b18a385f-8d9e-4b2a-89aa-50bfa6f3912a",
  "status": "queued"
}
```

#### `POST /api/queue/direct`
1-Click direct download endpoint. Automatically analyzes the URL, maps the highest resolution stream equal to or under the target, and immediately enqueues the transfer.

**Request Body:**
```json
{
  "url": "https://www.instagram.com/reel/DCe0XUeI2xY/",
  "quality": "1080p",
  "type": "video"
}
```

#### `GET /api/stream`
Direct in-browser streaming pipe. Streams media straight to client stdout without storing temporary files on disk.

```
GET /api/stream?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D...&itag=best&type=video
```

#### `GET /api/jobs/:jobId`
Fetches current status, downloaded byte count, download speed, and completion download URL.

#### `POST /api/jobs/:jobId/retry`
Re-queues a failed job with automatic adaptive fallback stream selection.

#### `DELETE /api/jobs/:jobId`
Cancels an active download, terminates child processes, and purges partial files from disk.

---

### Converter & Transcoder Endpoints

#### `POST /api/convert/upload`
Uploads source video or audio files via `multipart/form-data` (up to 1 GB per file). Only valid video and audio MIME extensions are accepted.

#### `POST /api/convert/process`
Starts an asynchronous batch conversion pipeline.

**Request Body:**
```json
{
  "items": [
    {
      "uploadId": "a1b2c3d4",
      "targetFormat": "mp3",
      "audioBitrate": "320k"
    },
    {
      "uploadId": "e5f6g7h8",
      "targetFormat": "mp4",
      "videoResolution": "1080p"
    }
  ]
}
```

#### `GET /api/convert/status/:jobId`
Returns transcoding progress, frame speed, percentage, and ETA.

#### `GET /api/convert/download/:jobId`
Downloads the converted media file with appropriate `Content-Disposition` and MIME headers.

---

### Authentication & Cookies Endpoints

#### `GET /api/cookies/status`
Returns active cookie configuration status, detected domains, file size, and timestamp.

#### `POST /api/cookies/upload`
Uploads or pastes raw Netscape cookie text or browser DevTools cookie headers. The backend automatically parses and writes to `cookies.txt` with Latin-1 normalization.

#### `DELETE /api/cookies`
Clears stored session cookies from the server filesystem.

---

## WebSocket Telemetry Protocol

Connect to the server WebSocket endpoint:
```
ws://localhost:3000
```

### Subscribe to Download Progress:
Send payload:
```json
{
  "type": "subscribe",
  "jobId": "your-download-job-id"
}
```

Server stream response:
```json
{
  "type": "progress",
  "job": {
    "jobId": "b18a385f-8d9e-4b2a-89aa-50bfa6f3912a",
    "status": "downloading",
    "progress": 72.4,
    "speed": "14.2 MB/s",
    "eta": "00:08",
    "fileSize": "145.2 MB",
    "bytesDownloaded": "105.1 MB"
  }
}
```

---

## Production Deployment & Hardening

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP and WebSocket server port |
| `HOST` | `0.0.0.0` (production) / `127.0.0.1` (local) | Network interface binding |
| `NODE_ENV` | `production` | Environment mode (`development` or `production`) |

### Running with PM2 Process Manager

```bash
npm install -g pm2
npm run build
pm2 start dist/server.cjs --name "pullio-downloader" -i 1
pm2 logs pullio-downloader
```

### Running with Docker

Create a `Dockerfile`:

```dockerfile
FROM node:22-bullseye-slim

WORKDIR /app

# Install basic OS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000

ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

CMD ["node", "dist/server.cjs"]
```

Build and launch:

```bash
docker build -t pullio:latest .
docker run -d -p 3000:3000 -v pullio_downloads:/app/downloads --name pullio pullio:latest
```

### Reverse Proxy Configuration (Nginx)

When deploying behind Nginx, configure WebSocket proxy headers and increase maximum client body size for file uploads:

```nginx
server {
    listen 80;
    server_name media.yourdomain.com;

    client_max_body_size 1024M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable proxy buffering for streaming downloads
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

---

## Troubleshooting & FAQ

#### 1. Why do Instagram or Bilibili return HTTP 412 or access errors?
Certain platforms strictly limit guest access and enforce anti-crawler checks on server/datacenter IP ranges. 
- **Solution**: Open **Settings** in the web interface and paste your session cookies in Netscape format. For Instagram, include `sessionid` and `ds_user_id`. For Bilibili, include `SESSDATA` and `bili_jct`. The server auto-sanitizes Chinese punctuation (`；`) and non-ASCII characters to keep cookies compatible with Python's Latin-1 HTTP client.

#### 2. YouTube returns "Sign in to confirm you're not a bot" or 403 Forbidden
Google periodically tests bot challenge algorithms against datacenter IP addresses.
- Pullio automatically retries using Tier 2 embedded player configurations (`ios` / `tv_embedded`).
- For continuous high-volume operations, provide fresh YouTube session cookies via Settings.

#### 3. Why are 4K (2160p) and 1440p YouTube downloads outputting as MP4?
YouTube serves high-resolution streams strictly as separate video-only WebM (VP9/AV1) tracks and audio-only Opus streams. Pullio invokes FFmpeg post-download with `--merge-output-format mp4`, automatically merging and remuxing them into a single, universally playable `.mp4` file.

#### 4. File uploads in Converter are rejected
Only valid media files (audio: `.mp3`, `.wav`, `.flac`, `.aac`, `.m4a`, `.ogg`, `.opus`; video: `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.flv`, `.wmv`) are permitted. Executables, scripts, HTML files, and double-extension attempts (e.g. `file.php.mp4`) are strictly blocked by the security filter.

---

## Project Structure

```
.
├── downloads/             # Temporary folder for active/completed downloads
├── uploads/               # Temporary staging for Converter uploads
├── converted/             # Transcoded output storage
├── src/
│   ├── components/        # UI components (Analyze, Converter, Progress, Modals)
│   │   ├── AnalyzePanel.tsx       # Stream selector, preview, format tables
│   │   ├── ConverterPanel.tsx     # Drag-and-drop batch format transcoder
│   │   ├── DownloadProgress.tsx   # Active transfer cards and progress bars
│   │   ├── BatchDownloadModal.tsx # Multi-link analyzer modal
│   │   ├── SettingsPanel.tsx      # Cookie manager, theme accents, diagnostics
│   │   └── HistoryPanel.tsx       # Completed transfers history log
│   ├── lib/               # Utility libraries (security, error mapping, formatting)
│   ├── store/             # Zustand application state management
│   ├── App.tsx            # Root application layout and responsive viewports
│   └── main.tsx           # React entry point
├── server.ts              # Express server, WebSocket engine, yt-dlp & FFmpeg workers
├── cookies.txt            # Local Netscape cookies store (gitignored)
├── package.json           # Scripts and dependency specifications
├── tsconfig.json          # TypeScript compiler configuration
└── vite.config.ts         # Vite build configuration & server proxy rules
```

---

## License

This project is licensed under the MIT License. You are free to use, modify, and distribute it in accordance with the terms of the license.

---

*Notice: This software is intended for personal media archival, offline caching, and format conversion of publicly available content or content you have authorization to access. Please respect the copyright policies and terms of service of each respective platform.*
