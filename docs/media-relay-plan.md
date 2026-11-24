# Web media relay plan

Status: DRAFT for review, 2026-11-18. Planning only; nothing here is built. Extends [`plan.md`](plan.md) (the audio-only radio plan), which stays valid: everything it lists is kept.

Working name: **web-media-relay**. The repository may be renamed later; until then all routes, images and env names of web-radio-relay keep working (section 12).

Legend: **[V]** verified in this repo's code or a read-only check; **[U]** unverified, needs a test or an experiment; **[D]** a decision proposed by this plan (change it if you disagree).

---

## 1. Goal

One small service on a VPS that takes one live stream in and does everything a church broadcast needs on the way out, without decoding video:

1. **Radio** (today's features): audio-only HLS, listener delay, timed captions, MP3 archive, lifecycle API, listener page, widget.
2. **Fan-out**: one RTMP stream in, many out (for example two Facebook destinations and one YouTube), copy only.
3. **Recording**: the incoming stream recorded on request, stored in S3.
4. **Own serving**: video HLS from the relay, with the same listener delay as the radio.
5. **Data channels**: captions from the Pi, rundown section names, optional graphics (hymn words, slides, extra pictures), translations of the captions. All timed on the same clock as the media.
6. **Caption embedding**: CEA-608 captions inserted into the outgoing H.264 so YouTube (and others) show them, with the video held back about 15 to 20 s because the captions arrive late.

### Hard rules

- **No video decoding on the fan-out, recording and HLS paths.** Every video path is `-c:v copy` or a bitstream edit (section 8). Audio may be encoded where the radio already does it (AAC for radio HLS, MP3 archive).
- **Source URLs and destination keys are configuration, never request input from an unauthenticated client.** Stream keys are secrets: never in logs, status, errors, events or the OpenAPI examples.
- **No church-specific data in this public repository** (hosts, addresses, stream keys, tokens, names). Those live in the private deployment repository.
- Node 24, ESM, OpenAPI first (`server/openapi.json`, CLI generated from it), pnpm (section 13).

---

## 2. Where things are today [V]

- Ingest: nginx-rtmp (alfg image, 1.23.1) in its own container, `rtmp://.../live/<name>`, `on-publish.sh` starts ffmpeg (audio to AAC HLS + MP3 archive). The only publish check is the name grammar `[a-z0-9_-]{1,32}`.
- In production RTMP is bound to loopback on the VPS; the only publisher is the church Pi through a reverse SSH tunnel. Any process that can reach loopback port 1935 can publish any name, including the production stream.
- API (Express): status, delayed audio playlist (`hls-delay.js`, uses `#EXT-X-PROGRAM-DATE-TIME`), captions buffer per stream (`captions.js`), pigateway SSE caption pull (`gateway-captions.js`), stats, archive listing, `/listen` page, lifecycle supervisor (`stream-supervisor.js`, pulls `RADIO_SOURCE_URL_TEMPLATE`; unset in production, so `start` answers 503).
- Auth: one admin Bearer token (`RELAY_API_TOKEN`) for all of `/api/v1`.
- No database, no S3, state is files in Docker volumes. VPS: 4 GB RAM shared with other apps, Traefik on 80/443 only (no TCP/UDP routers), S3-compatible storage available on the infra network.
- No MediaMTX on the VPS. No RTMPS, SRT or WHIP.

---

## 3. Target architecture

```
                 publishers                                         destinations
  Pi (tunnel) ─┐                                               ┌─ YouTube  (rtmp/rtmps)
  phone/OBS  ──┼─► MediaMTX ──► path live/<s> ─┬─► egress copy ─┼─ Facebook (rtmps) × N
  (auth hook) ─┘   (VPS)         (raw)         │               └─ custom rtmp
                     ▲                         ├─► recorder (copy, segments) ─► S3
                     │ publish auth (HTTP)     ├─► HLS packager (copy) ─► /hls video
                     │                         ├─► radio audio (AAC/MP3, today)
                 relay API (Node) ◄────────────┘
                   ├─ stream + destination config (SQLite, secrets encrypted)
                   ├─ process supervisor (ffmpeg children, optional fffleet)
                   ├─ timeline: captions, sections, graphics, translations
                   ├─ captioner: live/<s> ─► delay D ─► SEI CEA-608 ─► live/<s>-cc
                   └─ listener page, widget, public read API
```

### 3.1 Media core: MediaMTX on the VPS (decided by Juha, 2026-11-18)

Put MediaMTX in front and retire nginx-rtmp after a migration window.

- Why: one process gives RTMP, RTMPS, SRT and WHIP ingest, per-path publish/read auth through an HTTP hook, `runOnReady`/`runOnNotReady` hooks, fMP4 recording segments, and read-side RTSP/RTMP for local consumers. All copy, no decode. nginx-rtmp offers RTMP only, is unmaintained, and has no real auth.
- The existing lifecycle design already expects this: `RADIO_SOURCE_URL_TEMPLATE=rtsp://mediamtx:8554/{name}` makes the radio a pull from MediaMTX (plan.md "Current input architecture").
- Ports: RTMP on loopback (tunnel publishers), optional public RTMPS and SRT (section 9). RTSP and the MediaMTX API only on the internal Docker network. MediaMTX's own HLS and WebRTC servers off at first (the relay serves HLS itself, section 6; MediaMTX HLS stays an option).

### 3.2 Control plane: the relay API

The Node service stays the single owner of: configuration, secrets, every ffmpeg child (plan.md invariant), the data timeline, the public read API and the listener pages. MediaMTX is the media switchboard and never holds destination keys.

State moves from "files only" to **SQLite** (`node:sqlite`, built into Node 24, no dependency) in a volume: streams, destinations, recording sessions, tokens, timeline events. Destination stream keys are encrypted at rest with AES-256-GCM (`RELAY_SECRET_KEY` from the deploy secrets). One relay instance per VPS; no multi-instance design in this plan.

---

## 4. Streams, variants and destinations

### 4.1 Stream

A **stream** is a named input (`[a-z0-9_-]{1,32}`, as today). Config: title, publish credentials (section 9), default delay, which features are on (radio, video HLS, recording, captioner), caption language for embedding.

Every stream has **variants**, all MediaMTX paths:

| Variant | Path | Made by | Delay |
|---|---|---|---|
| `raw` | `live/<s>` | the publisher | none |
| `cc` | `live/<s>-cc` | the captioner (section 8) | `CAPTION_HOLD_SECONDS`, about 16 to 20 s |

### 4.2 Destination (fan-out)

A **destination** belongs to a stream: name, kind (`youtube`, `facebook`, `rtmp`), URL, stream key (secret), variant (`raw` or `cc`), enabled, `startWith` (`stream` = start when the input goes live, `manual`).

- **One ffmpeg per destination**: `ffmpeg -rw_timeout ... -i rtsp://mediamtx:8554/live/<s>[-cc] -c copy -f flv <url>` [D]. Not one tee per stream: a failing Facebook key must not drop YouTube, and each destination gets its own restart backoff and state. Copy-mode ffmpeg is cheap (a few MB RAM, almost no CPU) [U: measure on the VPS].
- Facebook needs RTMPS (`rtmps://...:443/rtmp/`); ffmpeg's FLV-over-TLS works in copy mode [U: verify against a real Facebook Live key].
- States per destination: `off`, `starting`, `live`, `retrying`, `failed` with a sanitised error (key removed). Bounded exponential backoff, the same rules as the radio supervisor.
- Variant choice: a destination that wants embedded captions takes `cc`. YouTube with `cc` replaces LCYT's HTTP caption POST for that broadcast; do not run both at once on one YouTube stream.
- Platform requirements are the publisher's job, not the relay's (no transcode): H.264 + AAC, keyframe every 2 s, YouTube/Facebook bitrate limits. The relay probes the input once on ready (codec, resolution, fps, GOP from the first keyframes, ffprobe on the RTSP path) and shows a warning when a destination's known limits are not met [D].
- Optional: a destination can run as an fffleet `stream` job instead of a local child (`EGRESS_EXECUTOR=local|fffleet`), reading the MediaMTX path over a private network. Off by default; only useful when VPS bandwidth runs out.

### 4.3 Lifecycle

`POST /api/v1/streams/{s}/start|stop` keep their meaning for the radio pull; new: `POST /api/v1/streams/{s}/destinations/{d}/start|stop` and `GET /api/v1/streams/{s}` (full state of all children). A MediaMTX `runOnReady` hook (HTTP call to the relay's internal port, shared hook secret) starts everything marked `startWith: stream`; `runOnNotReady` stops them and closes the recording. The hook and the RTMP callback path must never both start the same child (plan.md invariant; the supervisor keys children by `(stream, role, destination)`).

---

## 5. Recording to S3

- Off by default per stream; turned on in config (`recordOnLive`) or by `POST /api/v1/streams/{s}/recordings` (start) / `DELETE .../recordings/current` (stop).
- **Copy only**: one ffmpeg reads `live/<s>` and writes fMP4 segments of 60 s (`-c copy -f segment -segment_format mp4 -movflags +frag_keyframe+empty_moov`) to a local spool [D]. Alternative: MediaMTX's own recorder (`record: yes`, fMP4 parts); same result, less control over names and start/stop by API. The ffmpeg way keeps one supervisor for everything.
- An uploader moves each closed segment to S3 under `recordings/<stream>/<sessionId>/<n>.mp4`, retries with backoff, deletes the spool copy only after a verified upload (size + ETag). A crash loses at most the open segment. Spool size is capped (`RECORDING_SPOOL_MAX_BYTES`); when S3 is down for long the recording is marked degraded, not silently dropped.
- At stop: a manifest `recordings/<stream>/<sessionId>/session.json` with start/end wall time, segment list, probe info, and the timeline of that session (captions as VTT, sections as chapters, graphics events; full list in 7.2). Optional `concat` to one MP4 (copy, `-f concat -c copy`) as a later job, on the fleet if the VPS is short of disk.
- **Saarnavideo handoff** [D]: the session manifest is written in the shape of the LCYT handoff manifest v1 that Saarnavideo already imports (`POST /api/imports/lcyt`: feeds with parts, captions per language, variables, cue markers). Sections become cue markers, captions become the transcript run. This gives Saarnavideo the service without downloading it from YouTube (a goal that was parked on 2026-11-03).
- Raw only: recording the `cc` variant is not offered (it is the same picture, later).
- The MP3 radio archive stays as it is (local volume, ageing rules); optional copy to S3 later.

---

## 6. Own HLS serving (video)

- One ffmpeg per stream with video HLS on: `-i rtsp://.../live/<s> -c copy -f hls -hls_time 4 -hls_flags program_date_time+delete_segments+independent_segments -hls_segment_type mpegts` (fMP4 as a later option) [D]. One rendition only: an ABR ladder needs a transcode and is out of scope (section 14).
- Audio-only radio stays a separate output (today's ffmpeg with AAC + MP3), now pulling from MediaMTX.
- The existing delayed playlist (`hls-delay.js`, PDT-based) works for any media playlist, so video gets the same per-stream listener delay and the same caption clock: `GET /api/streams/{s}/hls/video/delayed.m3u8`. Playlist length is sized from `DELAY_MAX_SECONDS` as today.
- Segment duration follows the source GOP when copying; the publisher must send a keyframe at least every `HLS_TIME` seconds, or segments grow [U: check the Pi/ATEM encoder settings].
- Served by the relay's nginx (static) behind Traefik. Bandwidth is the real limit: each viewer pulls the full bitrate (for example 4 Mb/s). The VPS link and traffic allowance cap the audience [U: measure; a CDN in front is a later option].
- Player: `/watch?stream=<s>` (video + captions + data panel), built like `/listen` (one HTML file, hls.js from cdnjs), with its caption and data display modelled on the LCYT viewer (section 7.1). The widget gets a `data-mode="video"` option.

---

## 7. Data channels: captions, sections, graphics, translations

All non-media data goes into one **timeline** per stream: events `{ id, type, lang?, startedAt, endedAt?, payload }`, `startedAt` in epoch ms on an NTP-synced clock. Listeners get an event at `startedAt + delay`, exactly as captions work today. Types:

| Type | Source | Payload |
|---|---|---|
| `caption` | pigateway SSE `transcript` (today), `POST .../captions` | `text`, `lang`, `final` |
| `translation` | pigateway SSE `translation` (produced by PiVoice), or PiVoice's direct push | `text`, `lang`, `sourceId` (caption it translates, PiVoice `sourceKey`), `model?` |
| `section` | pigateway SSE `section`/`rundown` (pirundown walker) | `title`, `kind` (reading, hymn, sermon...), `index` |
| `graphic` | pigateway/piprogram events, or pushed | `kind` (`hymn-verse`, `slide`, `image`, `text`), `title`, `text?`, `assetId?`, `clear` |
| `marker` | operator, API | free label (for recordings) |

- **Ingest**: extend the existing SSE pull (`gateway-captions.js`) to subscribe to `transcript,section,rundown,graphic` (`types=` list) and map each type; unknown types are ignored and counted. Push API: `POST /api/v1/streams/{s}/events` (batch, same validation style as captions). The pigateway event names for sections and piprogram graphics must be read from their contracts before building [U].
- **Assets** (slide or picture PNG/JPEG/WebP): `POST /api/v1/streams/{s}/assets` stores in S3 (content-addressed), served at `/api/assets/{hash}` with long cache headers. A `graphic` event refers to it by id. Size and type limits as in Saarnavideo's library.
- **Public read**: `GET /api/streams/{s}/timeline?from=&types=&lang=` (due events only, same `next` cursor as captions today); SSE variant `GET /api/streams/{s}/timeline/events` for the pages so they do not poll. Old `/captions` routes stay.
- **Translations** [D, aligned with the PiVoice translation plan, pivoice `docs/translations/plan.md` section 10.2]: the relay does **not** call a translation service. PiVoice owns translation (fffleet `translate` jobs on the operator PC) and publishes finished translations; the relay consumes them from the pigateway SSE pull (`types=transcript,translation,...`) and from PiVoice's direct push (`POST .../captions` segments with another `lang`, which `captions.js` already accepts for overlapping times), and stores them as `translation` timeline events. Times are the source segment's audio times, so they release on the same clock as the caption. The listener delay must cover STT latency + translation latency (PiVoice reports p95); a translation that arrives after its moment is still shown, flagged late and counted. Which languages a page offers is per-stream config (`visibleLanguages: ["fi","sv","en"]`); no `TRANSLATE_URL`.
- **Pages**: `/listen` and `/watch` show the current section as a heading, captions with a language choice, and a graphics panel (hymn verse text, slide image). Graphics are **never burned into the video** (that needs decoding); they are web overlays for our own viewers only. Display follows the LCYT viewer (7.1).

### 7.1 Display modelled on the LCYT viewer (Juha, 2026-11-18)

LCYT already has the viewer side: `ViewerPage` (`/view/:key`, full screen, URL params `theme`, `fontsize`, `lang` = a language, `original` or `all` for one column per language, section badge from `codes.section`, DSK graphics overlay), `EmbedViewerPage` (`/embed/viewer`, iframe with history) and the Android TV app `lcyt-tv`. All read one public SSE stream, `GET /api/v1/viewer/:key`, events `connected` and `caption` with `{ text, composedText?, translations: { <lang>: text }, codes?: { section }, sequence, timestamp }`.

The relay serves the same contract [D]:

- **Who it is for** (Juha, 2026-11-18): church visitors in the building, on their own phones, following captions, hymn words, the section and a translation into their own language **live, with no delay**. So the viewer is a live page first: events go out the moment the relay receives them, not on the listener-delay clock. Remote listeners on `/listen` and `/watch` keep the delayed clock so text matches what they hear.
- `GET /api/v1/viewer/{key}?mode=live|delayed` (public, CORS `*`, outside the Bearer-protected `/api/v1` rules; the key is a per-stream viewer key in config, default the stream name). `live` (default, used by `/view`) sends each event on receipt; `delayed` (used by `/watch` and `/listen`) releases at `startedAt + delay` like captions today.
- One `caption` event per final caption. Translations that arrive later re-send the same `sequence` with the `translations` map filled in (the LCYT viewer replaces the text, so this shows the translation when it arrives). `codes.section` carries the current `section` title. `timestamp` uses LCYT's format (ISO without `Z`).
- `graphic` timeline events go out as an extra SSE event (`graphic`); the LCYT viewer ignores unknown events, the relay's pages use them. Mapping them onto LCYT's DSK `graphics` event is later work [U].
- **The viewer lives in the relay** (Juha, 2026-11-18): the relay serves its own viewer pages, ported from LCYT's `ViewerPage` and `EmbedViewerPage`: `/view/{key}` (full screen, same URL params: `theme`, `fontsize`, `lang` = a language, `original` or `all`), `/embed/viewer?key=` (iframe with history) and, new, the video and audio player around them (`/watch`, `/listen`). They need no LCYT backend. `/view` is phone-first (large text, dark theme default, language picker remembered in `localStorage`, screen kept awake with the Wake Lock API where supported) and reachable from a QR code in the church (`/view/{key}` short link, the existing `/<stream>` shortcut can redirect there). Added to what LCYT shows: a hymn panel (verse text, hymn number and title), a slide/picture panel, the section heading, and a language choice that lists the stream's visible languages.
- Port, not import: the pages are plain JS + one CSS file built with Vite in `viewer/` (no React dependency needed for this size) [D]. The payload shape is copied from LCYT; a contract test in each repository keeps the two in step, so LCYT's own viewer pages and the TV app also work against the relay with `?server=<relay>`.
- **Hymn words** (Juha, 2026-11-18: displayable): `graphic` events of kind `hymn-verse` carry `{ hymnNumber, title, verse, lines[] }` and are shown publicly in the viewer the moment the Pi sends them (live mode). The Pi side (piprogram/pirundown through pigateway) decides what is sent; the relay shows what it gets. A per-stream switch `publicGraphics` (default **on**) remains for a stream where graphics must stay private. Licences for newer hymn texts are the parish's matter, not a relay feature.

### 7.2 Sidecars

Every data channel is also written as a **sidecar** next to the media, so a recording or a later viewer has everything the live viewer had [D]:

| Sidecar | Live (HLS) | Saved (S3, per recording session) |
|---|---|---|
| Captions, per language | WebVTT subtitle rendition in the HLS master playlist (`#EXT-X-MEDIA:TYPE=SUBTITLES`), segments cut on the same PDT boundaries as the media | `captions.<lang>.vtt` |
| Translations, per language | same, one rendition per visible language | `captions.<lang>.vtt` (marked as translation in the manifest) |
| Sections | in the viewer SSE (`codes.section`) and the timeline | `sections.json` + `chapters.vtt` (WebVTT chapters) |
| Hymns | viewer SSE `graphic`, timeline | `hymns.json` (number, title, verses with times) |
| Graphics and pictures | viewer SSE `graphic`, assets at `/api/assets/{hash}` | `graphics.json` + the referenced assets copied under `assets/` |
| Other data (markers, variables, unknown pigateway types kept as raw) | timeline | `events.jsonl` (everything, one event per line) |

- The live WebVTT renditions are generated by the relay from the timeline (it already knows segment PDTs), so they are delayed with the media and need no ffmpeg. A native HLS player (Safari, TV apps) then shows captions even without the relay's own page.
- Sidecars are written at session stop and refreshed every 60 s during the session (so a crash loses at most a minute), all listed in `session.json` and in the handoff manifest for Saarnavideo.
- A sidecar can also be pushed without a recording (`GET /api/v1/streams/{s}/sidecars?from=&to=` builds them on request from the timeline store).
- Retention: timeline kept in SQLite for `TIMELINE_RETENTION_DAYS` (and in the recording manifest when recorded). Real transcripts with names are never committed to this repository (test data is invented).

---

## 8. CEA-608 caption embedding (the captioner)

### 8.1 Goal and constraint

Take one input stream and one caption language, and produce `live/<s>-cc`: the same H.264 and AAC, unchanged except for caption SEI messages, delayed by `CAPTION_HOLD_SECONDS`. Captions from the Pi are about 15 to 16 s late (speech-to-text), so the video is held long enough that every caption is known before its frames leave.

### 8.2 Approach: bitstream SEI insertion, no re-encode [D]

ffmpeg can only embed 608 while encoding (`libx264` reads A53 side data); with `-c:v copy` it cannot add captions. LCYT's `cea708` mode re-encodes for this reason. Re-encoding 1080p on a 4 GB shared VPS is not workable, so the captioner edits the bitstream instead:

1. ffmpeg reads `live/<s>` and writes FLV to stdout, copy only (`-c copy -f flv pipe:1`).
2. The Node captioner parses FLV tags (video: AVC NAL units in AVCC form, with DTS and composition offset; audio and script tags pass through untouched).
3. Every tag goes into a **hold buffer** stamped with its wall-clock time (section 8.3). Tags leave the buffer `CAPTION_HOLD_SECONDS` later, in order. Memory: about 20 s at 6 Mb/s is 15 MB.
4. Before a video tag leaves, the captioner adds one SEI NAL unit (`user_data_registered_itu_t_t35`, ATSC A/53 `GA94`, `cc_data` with the 608 byte pairs for this frame) in front of the frame's slice NALs and fixes the tag length. Nothing else in the frame changes.
5. FLV goes to a second ffmpeg (`-f flv -i pipe:0 -c copy -f flv rtmp://mediamtx/live/<s>-cc`) or straight to MediaMTX with a small RTMP publisher [D: ffmpeg first, it is already there].

This is the technique libcaption uses for FLV; the plan is a small own implementation in JS (608 encoder, `cc_data` packer, SEI writer, FLV reader/writer), unit-tested byte for byte. Fallback if this fails on real decoders: run the same input through an fffleet worker with `libx264` and `-a53cc` (the LCYT way), output pushed back as `live/<s>-cc`. The VPS never re-encodes.

### 8.3 Timing

- Caption `startedAt` is wall time at the Pi (NTP). A frame's wall time is its **arrival time at the relay minus the ingest latency** (`CAPTION_SYNC_OFFSET_MS`, default 1500 ms, measured once with a clapper test). Arrival is taken from the first ffmpeg's FLV output with a monotonic clock, smoothed against the stream's DTS so jitter does not shift captions [D].
- Better later: the Pi stamps its wall clock into the stream (an AMF `onFI`/`@setDataFrame` timecode every second, which nginx-rtmp, MediaMTX and the FLV copy keep [U]). The captioner then uses source time and the offset disappears.
- Because the captioner sees each caption up to the hold time before its frames, it uses **pop-on** captions: load the text into the non-displayed memory during the frames before `startedAt`, then send End Of Caption on the frame at `startedAt`, and Erase Displayed Memory at `endedAt` (or when the next caption pops on). This gives frame-exact timing despite 608's low data rate. Roll-up is the fallback when a caption arrives too late for pop-on.
- A caption that arrives after its frames have left (later than the hold time) is shown immediately on the next frame and counted as late; the hold time is tuned from that counter.
- B-frames: SEI must sit in decode order but caption bytes belong to presentation order. The captioner assigns caption bytes by PTS (DTS + composition offset) [D]; tests cover streams with and without B-frames.

### 8.4 608 details and limits

- Field 1, channel CC1, one language (Juha: one caption track). Two lines of at most 32 characters, wrapped by words; long captions are split into consecutive pop-ons.
- Data rate: two bytes per field per frame at 29.97 fps. At 25 or 50 fps the `cc_count` per frame is raised so the byte rate stays the same [U: check YouTube's decoder accepts 25/50 fps 608; this is the biggest technical unknown].
- Finnish characters: ä, ö, å, Ä, Ö, Å are in the 608 extended character sets (sent as a base character, then the extended code that replaces it). Anything outside the 608 set is replaced (for example by the nearest base letter) and counted.
- CEA-708 (DTVCC, `cc_type` 2/3) carrying the same text is a later step; YouTube reads 608.
- `caption` events of the chosen language only; `final` captions only (partials would flicker).

### 8.5 Captioner state and API

`PUT /api/v1/streams/{s}/captioner` (`{ enabled, lang, holdSeconds, syncOffsetMs }`), `GET .../captioner` (running, hold buffer seconds, captions embedded, late count, replaced characters). Captioner restart restarts its buffer; the `cc` path drops for those seconds and destinations on `cc` reconnect through their own backoff.

P9.6 implementation: `captioner-service.js` owns the two copy-only FFmpeg processes and the Node FLV pipeline. It reads `rtsp://<MEDIAMTX_RTSP_BASE>/live/<s>`, holds FLV tags, calls the live `captioner.js` scheduler by PTS, inserts the A/53 SEI before the first VCL NAL (after AUD/SPS/PPS), and publishes `rtmp://<MEDIAMTX_RTMP_BASE>/live/<s>-cc?secret=<HOOK_SECRET>`. The raw path is never modified. The service subscribes to final caption timeline events in the configured language; the legacy `POST .../captions` route also publishes into that timeline. MediaMTX ready/not-ready hooks start and stop the service, and the control API can enable/disable it while a source is already live.

The live path uses `captioner.js`; `caption-schedule.js` remains a pure precomputed/offline scheduler and is not a second live implementation. Supported input is H.264 at 25/30/50 fps. `HOOK_SECRET` is required; the RTSP/RTMP base defaults are the internal MediaMTX endpoints. The real-FFmpeg test checks that FFmpeg decodes the inserted A/53 side data and extracts the caption text and frame timing.

---

## 9. Ingest, authentication and security

Folds in the read-only VPS check of 2026-11-10 (details live in the private deployment repository).

### 9.1 Tokens and scopes [D]

Replace the single admin token with scoped tokens, stored hashed in SQLite:

| Scope | Can |
|---|---|
| `admin` | everything; the env `RELAY_API_TOKEN` stays the bootstrap admin token |
| `stream:<s>:publish` | publish media to path `live/<s>` (checked by the MediaMTX auth hook) |
| `stream:<s>:data` | push captions, events, assets for stream `<s>` |
| `stream:<s>:control` | start/stop destinations and recording of `<s>` |
| `stream:<s>:view` | read non-public data (for example graphics when `publicGraphics` is off) |

`POST /api/v1/tokens` (admin) issues a token with scopes and an expiry (short-lived for phones, for example 12 h); `DELETE` revokes. A phone app gets a publish + data token for one stream only; the admin token never leaves the server side.

### 9.2 Publish authentication

- MediaMTX `authMethod: http` calls the relay's internal `POST /internal/mediamtx/auth` for every publish and read. Publish needs a token with `stream:<s>:publish` (RTMP: `?token=` in the stream key; SRT: `streamid` with `publish:live/<s>:<user>:<token>`; WHIP: Bearer). Reads from inside the Docker network (relay's own ffmpeg) are allowed by source network only.
- Tunnel publishers on loopback also authenticate; a stream name alone is no longer enough. This closes "any loopback publisher can take the production stream".
- During migration nginx-rtmp gets an `on_publish` HTTP check against the same endpoint, so the hole closes before MediaMTX lands.

### 9.3 Public ingest (for phones and guest encoders)

- Decided (Juha, 2026-11-18): public ingest is allowed **with a key/token**. Every publish needs a per-stream publish token (9.1, 9.2); a bare stream name is never enough on any port.
- Today only the SSH tunnel reaches the RTMP port. Phones (the field-radio app) and guest encoders get RTMPS (TLS on MediaMTX with a certificate for the relay host, host port published beside Traefik, since Traefik has no TCP router), and SRT (UDP port) as an experiment. Each new public port still needs its firewall rule set on the VPS by Juha or the VPS session.
- The SSH tunnel stays for the Pi. A restricted tunnel user per phone (forward to the RTMP port only, no shell) remains an option for the field app, but tokens make it unnecessary.

### 9.4 Host hardening (operations, done in the deployment repository, listed so it is not lost)

SSH: no password login, no X11 forwarding; a separate restricted user for tunnel publishers; check the cloud firewall allows only 22, 80, 443 and the chosen media ports. None of this is changed by the relay code.

### 9.5 Secrets handling

Destination keys encrypted at rest, write-only through the API (`hasKey: true` comes back, never the key). ffmpeg command lines and stderr tails are scrubbed of keys and `token=` before they reach logs, state or events (one tested `redact()` used everywhere). Rate limits as today; public read routes stay unauthenticated except non-public graphics.

---

## 10. How the Pi side connects

- **Media**: the Pi's MediaMTX (program feed, or the audio-only pivoice path) is published to the relay over the existing tunnel as today, now with a publish token. Video through an SSH tunnel is TCP in TCP: fine on a stable church uplink, worse on loss [U: measure upstream bandwidth for 4 to 6 Mb/s plus radio].
- **Data**: the relay pulls pigateway's SSE bus (as today, `GATEWAY_EVENTS_URL`) through the existing relay tunnel pattern; nothing on the Pi needs to reach the public internet. pigateway stays the hub for transcript, section and graphics events (pirundown, piprogram publish into it).
- **Control**: pigateway (and picontrol through it) calls the relay's lifecycle, destination and recording routes with a scoped control token, extending the existing `PIGATEWAY_RADIO_RELAY_API_*` client. The relay never calls into the church LAN except the SSE pull.
- LCYT is the reference implementation for egress, DSK and caption modes; this relay is the small, copy-only VPS counterpart. Where LCYT already defines a shape (handoff manifest v1, caption segment fields), the relay reuses it.

---

## 11. Resources and limits (VPS)

- RAM budget: MediaMTX about 50 MB, each copy ffmpeg 10 to 30 MB, radio ffmpeg (audio encode) about 30 MB, captioner hold buffer about 15 MB per stream plus Node. Expected total under 400 MB for one stream with three destinations, recording and HLS [U: measure]. Compose memory limits as today.
- CPU: copy paths are near zero; audio encode and the captioner are small.
- Network: upload = input bitrate × (destinations + HLS viewers). Three destinations at 5 Mb/s = 15 Mb/s; 50 HLS viewers at 4 Mb/s = 200 Mb/s. Viewer count is the real cap.
- Limits in config: `MAX_STREAMS`, `MAX_DESTINATIONS_PER_STREAM` (default 6), `MAX_HLS_VIEWERS` (soft, metrics only at first).

---

## 12. Compatibility and rename

- All current routes stay: `/api/status`, `/api/streams/...`, `/api/hls/delayed.m3u8`, `/api/v1/streams/{name}/start|stop|lifecycle`, captions routes, `/listen`, the widget. New routes are additive.
- Rename: later (Juha, 2026-11-18). Nothing in phases 1 to 10 waits for it.
- Env names stay; new ones get a neutral `RELAY_` / feature prefix. Image names stay until a rename; a renamed repo publishes both names for one release.
- nginx-rtmp ingest keeps working until MediaMTX has run one real service (rollback = switch the tunnel target back).

---

## 13. Phases (each a PR, tested, deployable alone)

| # | PR | Content | Depends |
|---|---|---|---|
| 0 | Plan | This document | |
| 1 | Repo groundwork | pnpm workspace (server, cli, dev), SQLite store (`node:sqlite`) with migrations, `redact()` + tests, config model for streams; no behaviour change | |
| 2 | Scoped tokens + publish check | Token table and API, `on_publish` HTTP check for nginx-rtmp (closes the name hole now), OpenAPI + CLI | 1 |
| 3 | MediaMTX on the VPS | Compose service, auth hook, runOnReady/NotReady hooks, radio pulls from MediaMTX (`RADIO_SOURCE_URL_TEMPLATE`), probe on ready; nginx-rtmp kept for HTTP static + rollback | 2 |
| 4 | Fan-out | Destinations (encrypted keys), one copy ffmpeg each, state, backoff, API, pigateway control routes | 3 |
| 5 | Recording | Segment recorder, S3 uploader with spool, session manifest, handoff manifest v1 for Saarnavideo | 3 |
| 6 | Video HLS | Copy HLS packager, delayed video playlist, master playlist with WebVTT caption/translation renditions | 3, 7 |
| 7 | Timeline and sidecars | Event store, SSE ingest of sections/hymns/graphics, push API, assets in S3, public timeline, LCYT-compatible viewer SSE, sidecar writers (7.2) | 1 |
| 7b | Viewer | `viewer/` pages ported from LCYT (`/view`, `/embed/viewer`, `/watch`, `/listen`): captions, translations, section, hymn and picture panels | 6, 7 |
| 8 | Translations | Translation ingest from the pigateway bus and PiVoice push, per-stream visible languages, late flagging | 7 |
| 9 | Captioner | FLV parser/writer, 608 pop-on encoder, SEI writer, hold buffer, `cc` variant, destinations may pick `cc`; fleet `libx264` fallback documented | 3, 7 |
| 10 | Public ingest | RTMPS (and SRT experiment) on MediaMTX with tokens, for the field-radio app | 3; firewall rules set on the VPS |

Phases 4 to 7 can run in parallel after 3; 9 is the riskiest and should start with an experiment (section 15) before the full PR.

### Tests (every PR)

`node --test` unit tests with fakes for ffmpeg spawn, MediaMTX hook calls, S3 (a fake S3 server, the pattern used in Saarnavideo) and the pigateway SSE bus. Real-ffmpeg tests where cheap: copy fan-out to a local RTMP sink, segment recorder, HLS packager, and the captioner round trip (embed with our SEI writer, extract with `ffprobe -show_frames` / ffmpeg's `lavfi movie=...[out0+subcc]` and compare text and frame times). Never against real YouTube, Facebook or the church stream in CI.

---

## 14. Not in scope

Transcoding of any kind on the VPS (ABR ladders, resolution changes, burned-in graphics, DSK compositing): that is LCYT/fleet territory. Server-side mixing. Several caption languages embedded at once. Multi-instance relay. A CDN. Platform broadcast creation through the YouTube/Facebook APIs (the destination takes a ready key; LCYT's platform plugin does broadcast lifecycle).

---

## 15. Risks and experiments

| Risk | Experiment before building | Fallback |
|---|---|---|
| YouTube ignores or garbles our SEI 608 (esp. 25/50 fps) | E1: embed a test caption into a short 25 fps and 30 fps file, push to a private YouTube stream, check display and timing | Fleet `libx264 -a53cc` re-encode; or LCYT HTTP caption POST with the delayed stream |
| Facebook RTMPS in copy mode | E2: one copy push of a test file to a test Page | per-destination options |
| Caption sync drifts | E3: clapper test, measure `CAPTION_SYNC_OFFSET_MS`; check drift over 90 min | Pi wall-clock stamps in the stream |
| Upstream bandwidth from the church | E4: measure tunnel throughput with video + radio | lower Pi encoder bitrate; direct RTMPS publish |
| VPS bandwidth for HLS viewers | E5: metrics during a real service | viewer cap, CDN later |
| Hymn text and slide rights | parish's matter | `publicGraphics` off per stream |
| MediaMTX migration breaks the radio | staged: MediaMTX beside nginx-rtmp for one service | switch tunnel back |

---

## 16. Decisions

Settled (Juha, 2026-11-18):
1. **Media core**: MediaMTX on the VPS, replacing nginx-rtmp after a migration window.
2. **Public ingest**: allowed, always with a per-stream key/token.
3. **Translation provider**: answered by the PiVoice translation plan; the relay only consumes translations.
4. **Rename**: later.
5. **Media display**: the LCYT viewer lives in the relay (ported pages plus a compatible viewer SSE, 7.1).
6. **Hymn words**: displayable publicly; `publicGraphics` default on.
7. **Sidecars**: captions, translations, hymns, sections, graphics and other data saved beside the media in S3 and served as HLS sidecars (7.2).

Nothing is open for Juha now; the remaining [U] items are experiments (section 15).

Everything else above is a [D] default the implementing threads may follow.
