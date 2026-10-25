# web-radio-relay

Web radio relay: audio, captions and translations for browsers, with a listener delay set on the server. Tuberadio, the prototype it grew from, lives in `jsilvanus/tuberadio`.
> **Audio-only web radio from an RTMP stream.**  
> Takes a live RTMP push (e.g. from a YouTube fan-out project), strips video with FFmpeg, exposes audio as an HLS stream, archives every transmission as a timestamped MP3, and provides an embeddable vanilla-JS player widget.

![web-radio-relay dev site](https://github.com/user-attachments/assets/46fc9fea-8dbf-40ba-bd4e-bbd64ec310ac)

---

## Table of contents

1. [Architecture](#architecture)
2. [Repository layout](#repository-layout)
3. [Setup — Docker (recommended)](#setup--docker-recommended)
4. [Setup — Bare metal / development server](#setup--bare-metal--development-server)
5. [Running the Vite dev site](#running-the-vite-dev-site)
6. [Environment variables](#environment-variables)
7. [API reference](#api-reference)
8. [Embeddable widget](#embeddable-widget)
9. [Integration with a YouTube fan-out project](#integration-with-a-youtube-fan-out-project)
10. [Troubleshooting](#troubleshooting)

---

## Architecture

```
YouTube stream
      │
      ▼  RTMP push  (port 1935)
┌─────────────────────────────────────────────────────────────────┐
│  Nginx RTMP                                                     │
│  application: live                                              │
│  exec_push → on-publish.sh $name                               │
└───────────────────────┬─────────────────────────────────────────┘
                        │  rtmp://127.0.0.1/live/<stream>
                        ▼
                   ┌─────────┐
                   │  FFmpeg │  (-vn  audio only)
                   └────┬────┘
          ┌─────────────┴──────────────┐
          ▼                            ▼
  HLS_DIR/stream.m3u8          ARCHIVE_DIR/
  HLS_DIR/seg00001.ts …        YYYY-MM-DD_HH-MM-SS_<name>.mp3

          │                            │
          └──────────┬─────────────────┘
                     ▼
       Nginx HTTP  (port 8080)
       /hls/     → live HLS segments + manifest
       /archive/ → archived MP3 files (directory listing)
       /api/     → proxied to Node.js API (port 3000)

                     │
                     ▼
       Browser / Embedded widget  (web-radio-relay.js)
```

---

## Repository layout

```
.
├── .env.example            # All configurable environment variables (copy to .env)
├── docker-compose.yml      # Docker setup (nginx + API)
├── nginx/
│   └── nginx.conf          # Nginx RTMP ingest + HTTP serving configuration
├── scripts/
│   └── on-publish.sh       # Invoked by nginx on stream start — runs FFmpeg
├── server/
│   ├── index.js            # Node.js /api/status and /api/archive endpoints
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   └── web-radio-relay.js        # Embeddable vanilla JS player widget
└── dev/                    # Vite demo / dev site
    ├── index.html
    ├── src/main.js
    ├── vite.config.js
    └── package.json
```

---

## Setup — Docker (recommended)

### Prerequisites

- [Docker Engine](https://docs.docker.com/engine/install/) ≥ 24
- [Docker Compose](https://docs.docker.com/compose/install/) ≥ 2.20 (usually bundled with Docker Desktop)
- An RTMP source — e.g. the YouTube fan-out project, OBS, or `ffmpeg -re -i input.mp4 -f flv rtmp://…`

### 1 · Clone the repository

```bash
git clone https://github.com/jsilvanus/web-radio-relay.git
cd web-radio-relay
```

### 2 · Configure environment variables

```bash
cp .env.example .env
```

Open `.env` in your editor. The most important values for a public deployment:

```dotenv
# The public URL of your server (used in widget embed code and API responses)
HLS_STREAM_URL=https://radio.example.com/hls/stream.m3u8
ARCHIVE_URL_PREFIX=https://radio.example.com/archive

# Change host ports if 1935 or 8080 are already in use on your host
RTMP_PORT=1935
HTTP_PORT=8080
```

For a **local-only** test run the defaults work without any changes to `.env`.

### 3 · Build and start

```bash
docker compose up -d
```

Docker will:
1. Build the `api` Node.js image from `server/Dockerfile`.
2. Pull the `alfg/nginx-rtmp` image (nginx with `nginx-rtmp-module` compiled in).
3. Start both containers, connecting them on an internal Docker network.
4. Create three named volumes: `radio-hls`, `radio-archive`, `radio-logs`.

Check that both containers are running:

```bash
docker compose ps
```

Expected output:

```
NAME             IMAGE                   STATUS
web-radio-relay-api    web-radio-relay-api           Up
web-radio-relay-nginx  alfg/nginx-rtmp:latest  Up
```

### 4 · Start streaming

Push an RTMP stream from your fan-out project (or any RTMP source):

```
rtmp://<your-host>:1935/live/<stream-key>
```

Replace `<stream-key>` with any alphanumeric key, e.g. `stream`.

The moment nginx receives the stream it calls `on-publish.sh`, which starts
FFmpeg. Within a few seconds:

- **Live HLS (delayed)**: `http://<your-host>:8080/api/hls/delayed.m3u8`
- **Archive browser**: `http://<your-host>:8080/archive/`
- **Status API**: `http://<your-host>:8080/api/status`

### 5 · Embed the player

Copy `frontend/web-radio-relay.js` to your web server (or CDN) and add to any HTML page:

```html
<div
  data-web-radio-relay
  data-title="My Radio"
  data-stream-url="http://<your-host>:8080/api/hls/delayed.m3u8"
  data-status-url="http://<your-host>:8080/api/status"
  data-archive-url="http://<your-host>:8080/api/archive"
></div>
<script src="https://<your-cdn>/web-radio-relay.js"></script>
```

### Useful Docker commands

```bash
# View logs from nginx
docker compose logs -f nginx

# View logs from the API server
docker compose logs -f api

# Stop everything
docker compose down

# Stop and wipe all data (HLS segments, archives)
docker compose down -v
```

---

## Setup — Bare metal / development server

Use this path if you want to run web-radio-relay without Docker, or to hack on the
source directly.

### Prerequisites

Install the following on your server / dev machine:

| Software | Minimum version | Install guide |
|---|---|---|
| **Nginx** (with `nginx-rtmp-module`) | 1.24 | See below |
| **FFmpeg** (with `libmp3lame`, `aac`) | 4.4 | See below |
| **Node.js** | 18 | [nodejs.org](https://nodejs.org/) |
| **npm** | 9 | Bundled with Node.js |

#### Install Nginx with RTMP module

**Ubuntu / Debian**

```bash
sudo apt update
sudo apt install libnginx-mod-rtmp
# This installs nginx + the rtmp module as a dynamic module on modern Ubuntu.
# If your distro's package doesn't include the rtmp module, build from source:
# https://github.com/arut/nginx-rtmp-module#installation
```

**macOS (Homebrew)**

```bash
brew tap denji/nginx
brew install nginx-full --with-rtmp-module
```

**Build from source (any Linux)**

```bash
# Install build deps
sudo apt install build-essential libpcre3-dev libssl-dev zlib1g-dev

# Clone nginx-rtmp-module
git clone https://github.com/arut/nginx-rtmp-module.git

# Download and build nginx
wget http://nginx.org/download/nginx-1.24.0.tar.gz
tar xf nginx-1.24.0.tar.gz
cd nginx-1.24.0
./configure --add-module=../nginx-rtmp-module --with-http_ssl_module
make -j$(nproc)
sudo make install
```

#### Install FFmpeg

**Ubuntu / Debian**

```bash
sudo apt install ffmpeg
```

**macOS (Homebrew)**

```bash
brew install ffmpeg
```

Verify FFmpeg has the required codecs:

```bash
ffmpeg -codecs 2>/dev/null | grep -E 'mp3|aac'
# Should show: DEA.LS mp3   and  DEA.L. aac
```

### 1 · Clone the repository

```bash
git clone https://github.com/jsilvanus/web-radio-relay.git
cd web-radio-relay
```

### 2 · Configure environment variables

```bash
cp .env.example .env
# Edit .env with your preferred editor
```

For bare-metal you'll need to create the data directories and point the env vars at them:

```bash
sudo mkdir -p /var/www/radio/hls /var/www/radio/archive /var/log/web-radio-relay
sudo chown -R $USER /var/www/radio /var/log/web-radio-relay
```

Or choose different directories and set them in `.env`:

```dotenv
HLS_DIR=/home/me/radio/hls
ARCHIVE_DIR=/home/me/radio/archive
LOG_DIR=/home/me/radio/logs
```

### 3 · Install and start the API server

```bash
cd server
npm install

# Load env vars from .env, then start
export $(grep -v '^#' ../.env | xargs)
npm start
# API is now listening on port 3000 (or the PORT you set in .env)
```

For production, run the API server as a systemd service (see [Systemd unit](#optional-systemd-units) below).

### 4 · Configure and start nginx

The provided `nginx/nginx.conf` targets Docker (the API upstream is `http://api:3000`).
For bare-metal, change the proxy target to `localhost`:

```bash
sed -i 's|http://api:3000|http://127.0.0.1:3000|g' nginx/nginx.conf
```

Then tell nginx to use this config:

```bash
# Copy config (or symlink it)
sudo cp nginx/nginx.conf /etc/nginx/nginx.conf

# Make the scripts directory accessible
sudo mkdir -p /opt/web-radio-relay/scripts
sudo cp scripts/on-publish.sh /opt/web-radio-relay/scripts/
sudo chmod +x /opt/web-radio-relay/scripts/on-publish.sh

# Test the config
sudo nginx -t

# Start / reload nginx
sudo systemctl start nginx   # or: sudo nginx
```

> **Note:** `nginx.conf` replaces the entire nginx configuration.  
> If you have other sites on the same nginx instance, merge the `rtmp {}` block
> and the `server {}` block from `nginx/nginx.conf` into your existing config.

### 5 · Verify everything is running

```bash
# nginx RTMP (port 1935) and HTTP (port 8080) should be listening
ss -tlnp | grep -E '1935|8080'

# API server (port 3000)
ss -tlnp | grep 3000

# Check API responds
curl http://localhost:8080/api/status
# → {"live":false,"streamUrl":"/hls/stream.m3u8","lastUpdated":null}
```

### 6 · Push a test stream

```bash
# Requires ffmpeg on the source machine
ffmpeg -re -f lavfi -i "sine=frequency=440:duration=300" \
       -c:a aac -b:a 128k -f flv \
       rtmp://127.0.0.1:1935/live/stream
```

After a few seconds:
- `http://localhost:8080/hls/stream.m3u8` should return an M3U8 playlist
- `http://localhost:8080/api/status` should return `"live": true`

### Optional: Systemd units

**API server** — `/etc/systemd/system/web-radio-relay-api.service`

```ini
[Unit]
Description=web-radio-relay API server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/web-radio-relay/server
EnvironmentFile=/opt/web-radio-relay/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now web-radio-relay-api
```

---

## Running the Vite dev site

The `dev/` directory contains an interactive demo page where you can:

- Preview the `web-radio-relay.js` widget live
- Edit the station title and API URLs — the widget re-initialises instantly
- Copy the generated embed code snippet to your clipboard

### Prerequisites

The Vite dev server proxies `/api/`, `/hls/`, and `/archive/` to the backend,
so the API server and nginx must be running first (either via Docker or bare metal).

### Start

```bash
cd dev
npm install
npm run dev
# → http://localhost:5173
```

Open `http://localhost:5173` in your browser.

### Build for production

```bash
cd dev
npm run build
# Output is in dev/dist/ — web-radio-relay.js is copied there automatically
```

---

## Environment variables

All variables have sensible defaults so the system works out of the box.
Copy `.env.example` to `.env` and override only what you need.

### Docker host ports

| Variable | Default | Description |
|---|---|---|
| `RTMP_PORT` | `1935` | Host port mapped to the RTMP ingest (container port 1935) |
| `HTTP_PORT` | `8080` | Host port mapped to the HTTP server (container port 8080) |

### API server (`server/index.js`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the Node.js process listens on |
| `HLS_DIR` | `/var/www/radio/hls` | Directory containing the HLS manifest and segments |
| `ARCHIVE_DIR` | `/var/www/radio/archive` | Directory containing archived MP3 files |
| `STALE_MS` | `30000` | Milliseconds after the last manifest update before the stream is considered off-air |
| `HLS_STREAM_URL` | `/hls/stream.m3u8` | Public URL returned in `GET /api/status` — set to your full public URL when behind a reverse proxy |
| `ARCHIVE_URL_PREFIX` | `/archive` | URL prefix for archive download links in `GET /api/archive` — set to your full public URL when behind a reverse proxy |
| `RELAY_API_TOKEN` | *(unset)* | Bearer token for the control API (`/api/v1/*`). Unset means those routes answer 503 (fail closed). Generate with `openssl rand -hex 32` |
| `DELAY_SECONDS` | `0` | Listener delay for audio and captions. Changeable at runtime with `PUT /api/v1/delay` |
| `DELAY_MAX_SECONDS` | `60` | Upper bound for the delay (see `HLS_LIST_SIZE` above) |
| `DELAYED_STREAM_URL` | `/api/hls/delayed.m3u8` | Playlist URL reported as `streamUrl` in `GET /api/status` |
| `HLS_SEGMENT_PREFIX` | `/hls/` | URL prefix of segment files named in the delayed playlist (nginx serves `/hls/`) |
| `CAPTION_RETENTION_SECONDS` | `3600` | How long captions stay in memory |

### FFmpeg / on-publish.sh

| Variable | Default | Description |
|---|---|---|
| `HLS_DIR` | `/var/www/radio/hls` | HLS output directory (same as API) |
| `ARCHIVE_DIR` | `/var/www/radio/archive` | Archive output directory (same as API) |
| `LOG_DIR` | `/var/log/web-radio-relay` | FFmpeg per-session log directory |
| `AUDIO_BITRATE` | `128k` | Bitrate for both the HLS AAC and archive MP3 outputs |
| `HLS_TIME` | `4` | HLS segment duration in seconds |
| `HLS_LIST_SIZE` | `10` | Minimum number of segments kept in the rolling playlist. Raised automatically to cover `DELAY_MAX_SECONDS` |
| `DELAY_MAX_SECONDS` | `60` | Largest listener delay the relay accepts; sizes the live playlist. Must match the API's value |

---

## API reference

The API is served at `/api/` (port 8080, proxied by nginx) and is also directly available on port 3000.
A machine-readable description is at `GET /api/openapi.json` (OpenAPI 3.1, source: `server/openapi.json`).
Public routes serve listeners and the widget. Routes under `/api/v1/` are control routes and need
`Authorization: Bearer <RELAY_API_TOKEN>`.

### Listener delay and sync

The relay delays the audio for listeners by `DELAY_SECONDS`. Captions use the same clock, so a caption
is released to listeners at `startedAt + delay`, when the delayed audio plays that moment. The widget
plays `/api/hls/delayed.m3u8` by default. ffmpeg writes `#EXT-X-PROGRAM-DATE-TIME` for every segment,
and the delayed playlist lists only segments that ended at least `delay` seconds ago. Accuracy is one
segment (`HLS_TIME`, 4 s) at the segment boundary, plus the ingest latency of the RTMP push. Sync with
captions is therefore good to about a second, not sample-accurate.

### `GET /api/status`

```json
{
  "live": true,
  "streamUrl": "/api/hls/delayed.m3u8",
  "liveStreamUrl": "/hls/stream.m3u8",
  "delaySeconds": 0,
  "lastUpdated": "2024-06-01T14:32:00.000Z"
}
```

`live` is `true` when the HLS manifest (`stream.m3u8`) was modified less than `STALE_MS` milliseconds ago.
`streamUrl` is the playlist listeners should load (delayed). `liveStreamUrl` is the undelayed playlist.

### `GET /api/hls/delayed.m3u8`

The live audio playlist, delayed by `delaySeconds`. `404` when the stream is not live, `503` when the
live playlist has no timing information.

### `GET /api/captions?lang=fi&from=<ms>&limit=200`

Captions that are due for listeners now, oldest first. Poll with the previous response's `next` as `from`.
Without `from` the last 30 seconds of due captions are returned. Translations are ordinary captions with
another `lang`.

```json
{
  "serverTime": 1717252320000,
  "delaySeconds": 0,
  "next": 1717252318501,
  "captions": [
    { "id": 17, "lang": "fi", "text": "Hyvää huomenta", "startedAt": 1717252318000, "endedAt": 1717252319500 }
  ]
}
```

### `GET /api/archive`

Returns a list of archived recordings, newest first.

```json
{
  "recordings": [
    {
      "filename": "2024-06-01_14-30-00_stream.mp3",
      "url": "/archive/2024-06-01_14-30-00_stream.mp3",
      "startedAt": "2024-06-01T14:30:00",
      "streamName": "stream",
      "sizeBytes": 12345678
    }
  ]
}
```

`url` uses `ARCHIVE_URL_PREFIX` as its base.

### `GET /api/stats` and `POST /api/stats/event`

Anonymous aggregate statistics, and the play events the widget sends. Both are public.

### Control API (`/api/v1`, Bearer token)

| Method and path | Purpose |
|---|---|
| `POST /api/v1/captions` | Push up to 100 caption segments: `{ "segments": [{ "lang", "text", "startedAt", "endedAt"? }] }`. `startedAt` is epoch milliseconds on the sender's clock (NTP-synced with the relay). Answers `202 { "accepted": n }`. One bad segment rejects the whole request with a `400` that names the field. |
| `GET /api/v1/delay` | `{ "delaySeconds", "maxSeconds" }` |
| `PUT /api/v1/delay` | `{ "delaySeconds": 20 }`, an integer from 0 to `DELAY_MAX_SECONDS`. Applies at once to audio and captions. Not persisted: a restart returns to `DELAY_SECONDS`. |
| `POST /api/v1/stats/session` | `{ "event": "start" \| "end", "streamName" }`. Sent by `on-publish.sh` and `on-publish-done.sh`. |

Responses: `401` for a missing or wrong token, `503` when `RELAY_API_TOKEN` is not set. The token is compared in
constant time and is never accepted in the URL.

**Rate limits:** public routes 60 requests per minute per IP; `/api/v1` 600 per minute per IP.

### Remote CLI

`cli/` is a zero-dependency command-line client generated from `server/openapi.json`:

```bash
cd cli && npm run generate            # regenerate after changing openapi.json
export TUBERADIO_URL=https://radio.example.com TUBERADIO_TOKEN=...
node src/cli.js ops                   # list operations
node src/cli.js getStatus
node src/cli.js setDelay --body '{"delaySeconds":20}'
node src/cli.js publishCaptions --body-file captions.json
```

---

## Embeddable widget

`frontend/web-radio-relay.js` is a **self-contained vanilla JS file** — no build step, no runtime dependencies. HLS.js is loaded from the CDN on demand for non-Safari browsers; Safari uses native HLS.

### Declarative (recommended)

```html
<!-- Place anywhere in your HTML -->
<div
  data-web-radio-relay
  data-title="My Radio"
  data-stream-url="https://radio.example.com/hls/stream.m3u8"
  data-status-url="https://radio.example.com/api/status"
  data-archive-url="https://radio.example.com/api/archive"
></div>

<!-- Include once, anywhere on the page -->
<script src="https://radio.example.com/web-radio-relay.js"></script>
```

### Programmatic

```html
<div id="player"></div>
<script src="web-radio-relay.js"></script>
<script>
  const player = new TubeRadio({
    container:    document.getElementById('player'),
    title:        'My Radio',
    streamUrl:    'https://radio.example.com/hls/stream.m3u8',
    statusUrl:    'https://radio.example.com/api/status',
    archiveUrl:   'https://radio.example.com/api/archive',
    pollInterval: 10000,  // ms between status checks
  });

  // Later:
  player.destroy();
</script>
```

### `data-*` attribute reference

| Attribute | Default | Description |
|---|---|---|
| `data-title` | `web-radio-relay` | Station name shown in the widget header |
| `data-stream-url` | `/hls/stream.m3u8` | HLS manifest URL |
| `data-status-url` | `/api/status` | Status API endpoint |
| `data-archive-url` | `/api/archive` | Archive API endpoint |
| `data-poll-interval` | `10000` | Polling interval in milliseconds |

Use the **Vite dev site** (`dev/`) to generate and copy the correct embed snippet for your server.

---

## Integration with a YouTube fan-out project

This project is designed to sit downstream of a tool that re-streams YouTube live broadcasts to multiple RTMP destinations.

Point one of the fan-out outputs at:

```
rtmp://<web-radio-relay-host>:1935/live/<stream-key>
```

web-radio-relay handles the rest: audio extraction, HLS packaging, timestamped archiving, and the embeddable player widget.

---

## Troubleshooting

### Stream is not detected as live (`"live": false`)

1. Check that nginx is running and port 1935 is reachable:
   ```bash
   curl -v telnet://<host>:1935
   # or in Docker:
   docker compose logs nginx
   ```
2. Verify FFmpeg was started by nginx (check the exec log):
   ```bash
   # Docker
   docker compose exec nginx ls /var/log/web-radio-relay/
   # Bare metal
   ls /var/log/web-radio-relay/
   ```
3. Check that the HLS manifest is being written:
   ```bash
   ls -lh /var/www/radio/hls/
   ```
4. Increase `STALE_MS` if your network has a high latency between the source and the server.

### No sound in the browser

- Safari uses native HLS — confirm the URL is HTTPS if served from a secure origin.
- For non-Safari browsers, open the browser DevTools console and look for HLS.js errors.
- Confirm the CORS headers are present on the HLS response:
  ```bash
  curl -I http://<host>:8080/hls/stream.m3u8 | grep -i access-control
  # Should print: Access-Control-Allow-Origin: *
  ```

### `on-publish.sh` is not executed

- Confirm the script is executable: `ls -l /opt/web-radio-relay/scripts/on-publish.sh`
- Confirm nginx was compiled with `exec_push` support (requires `nginx-rtmp-module` ≥ 1.1.4).
- In Docker, check that the `scripts/` volume is mounted correctly:
  ```bash
  docker compose exec nginx ls /opt/web-radio-relay/scripts/
  ```

### API returns 502 Bad Gateway

Nginx cannot reach the Node.js API server.

- **Docker:** Make sure the `api` service is up: `docker compose ps`
- **Bare metal:** The nginx config uses `http://api:3000`. For bare metal, replace with `http://127.0.0.1:3000` and confirm the API server is running: `curl http://localhost:3000/api/status`

### Archive directory is empty

FFmpeg writes archives only when a stream is actively publishing. If a stream is very short or disconnects immediately, the MP3 file may be empty and is left in `ARCHIVE_DIR`. You can safely delete zero-byte files:

```bash
find /var/www/radio/archive -name '*.mp3' -empty -delete
```

### Port already in use

Change `RTMP_PORT` or `HTTP_PORT` in `.env`:

```dotenv
RTMP_PORT=11935
HTTP_PORT=18080
```

Then restart: `docker compose up -d`.
