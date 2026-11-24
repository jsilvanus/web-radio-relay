# Web media relay: phase plan for agents

Status: 2026-11-18. Execution plan for [`media-relay-plan.md`](media-relay-plan.md) (the "plan"). Written so that small agents (Haiku) can take **one task at a time** without reading the whole plan. Each task names its files, its interface, its tests and when it is done. If a task needs a decision that is not written here, the agent stops and asks; it does not guess.

---

## 0. Rules for every task

1. **One task = one branch = one PR.** Branch `claude/<task-id>` (for example `claude/p1-store`), PR title `<task-id>: <title>`. Do not start a task whose "Needs" are not merged on `main`.
2. **Before starting:** `git fetch origin && git checkout -B claude/<task-id> origin/main`. Read only: this file's task section, the plan section it names, and the files it lists.
3. **Code style:** Node 24, ESM (`import`), no TypeScript, no new runtime dependency unless the task names it. Pure logic goes in `server/lib/<name>.js` as exported functions with **no I/O and no clock reads** (pass `nowMs`, pass `spawn`, pass `fetch`). I/O wiring goes in `server/index.js` or a `server/lib/<name>-service.js`.
4. **Tests:** `node:test` + `node:assert/strict`, file `server/test/<name>.test.js`. Every exported function gets at least one test. No real network, no real YouTube/Facebook/S3/Pi in tests. ffmpeg is allowed in tests only where the task says "real ffmpeg"; such tests skip with a message when `ffmpeg` is not on PATH.
5. **Run before pushing:** `cd server && pnpm test` (or `npm test` until P1.1 lands). All tests green. If an unrelated test fails, say so in the PR and do not touch it.
6. **API changes:** every new or changed route is added to `server/openapi.json` in the same PR, then `cd cli && npm run generate`. CI checks they match.
7. **Secrets:** never log, return or put in errors: stream keys, tokens, `token=` query values, URL user/password. Use `redact()` from P1.2 for anything that came from config or ffmpeg stderr.
8. **No church data:** no IPs, host names, stream keys or real names in code, tests, docs or fixtures. Use `example.com`, `stream`, `test`.
9. **Routes:** new page routes (`/view`, `/watch`, `/embed/...`) must be registered **before** the catch-all `app.get('/:stream(...)')` in `server/index.js`, or they are treated as stream names.
10. **Docs:** update `README.md` (env table and API list) when you add env vars or routes. Keep it short.
11. **PR body:** what was built, which tests, what is not done. End with the attribution lines the session gives you.
12. **Stop and ask** when: a test needs a real service, a file you must change has moved, two tasks' instructions conflict, or the change grows beyond the files listed (more than about 400 changed lines is a sign).

Difficulty marks: **[H]** fine for Haiku. **[H+]** Haiku with care: follow the test vectors exactly. **[S]** give to a stronger model (Sonnet/Opus) or a human; listed so the order is visible.

---

## 1. Order and parallel streams

```
P1 groundwork ──► P2 tokens ──► P3 MediaMTX ──┬─► P4 fan-out
                                              ├─► P5 recording ──┐
                                              ├─► P6 video HLS ──┤
P1 ───────────────► P7 timeline + sidecars ───┴──────────────────┴─► P7b viewer
                                    P7 ──► P8 translation ingest
                     P3 + P7 + E1 ──► P9 captioner
                                P3 ──► P10 public ingest
```

- After P3 merges, P4, P5, P6 can run in parallel (separate agents).
- P7 can start right after P1 (it needs only the store), in parallel with P2/P3.
- P9 starts only after experiment **E1** (YouTube accepts our 608) passes. E1 is a human task.

Sync points: **S1** after P3 (one real publish through MediaMTX on a test host works, human-checked). **S2** after P4+P6 (fan-out to a local RTMP sink and HLS playback, human-checked). **S3** after P9 (captions visible on a private YouTube test stream).

---

## P1. Groundwork

### P1.1 pnpm workspace [H]
- Files: root `package.json` (new, `"private": true`, `"packageManager": "pnpm@9"`), `pnpm-workspace.yaml` (`server`, `cli`, `dev`), delete `server/package-lock.json`, `dev/package-lock.json`, add `pnpm-lock.yaml`; `.github/workflows/test.yml` uses `pnpm/action-setup` and `pnpm install --frozen-lockfile`; `server/Dockerfile` uses `corepack enable && pnpm install --prod --frozen-lockfile`.
- Done when: CI green, `docker build server` works, no behaviour change.

### P1.2 `redact()` [H]
- File: `server/lib/redact.js`. `export function redact(text, secrets = [])`: replaces each non-empty secret string with `[REDACTED]`; replaces `token=...`, `key=...`, `cid=...`, `streamid=...` query values with `[REDACTED]`; replaces `user:pass@` in URLs with `[REDACTED]@`; replaces the last path segment of `rtmp://` / `rtmps://` URLs (the stream key) with `[REDACTED]`.
- Replace the local `redactUrl` in `stream-supervisor.js` with it.
- Tests: each rule, a string with several secrets, non-string input returns `''`.

### P1.3 SQLite store [H+]
- File: `server/lib/store.js` using `node:sqlite` (`DatabaseSync`). `export function openStore(path)` returns `{ db, close() }` and runs migrations: table `schema_version`, then migration 1 creates `streams(name PK, title, config_json, created_at)`, `tokens(id PK, hash UNIQUE, scopes_json, expires_at, created_at, revoked_at)`, `destinations(id PK, stream, name, kind, url, key_enc, variant, enabled, start_with, created_at, UNIQUE(stream,name))`, `recordings(id PK, stream, started_at, ended_at, state, manifest_json)`, `events(id INTEGER PK AUTOINCREMENT, stream, type, lang, started_at, ended_at, payload_json, source_key, received_at)` with index `(stream, started_at)` and unique `(stream, type, source_key)`.
- Migrations are an array; each runs once in a transaction.
- Env: `RELAY_DB_PATH` (default `/var/lib/relay/relay.db`; tests use `':memory:'`). Compose: new volume `relay-data`.
- Tests: open twice on the same file = migrations run once; tables exist.

### P1.4 Secret box [H]
- File: `server/lib/secret-box.js`. `encrypt(plain, keyHex)` and `decrypt(blob, keyHex)` with AES-256-GCM, random 12-byte IV, output `v1:<iv b64>:<tag b64>:<data b64>`. Key from env `RELAY_SECRET_KEY` (64 hex chars). `assertKey(keyHex)` throws a clear error when missing or wrong length.
- Tests: round trip, wrong key fails, tampered data fails, bad key length throws.

---

## P2. Scoped tokens and publish check (plan section 9)

### P2.1 Token logic [H]
- File: `server/lib/tokens.js`. Scopes: `admin`, `stream:<s>:publish|data|control|view`. Functions: `hashToken(token)` (sha256 hex), `newToken()` (32 random bytes hex), `scopeAllows(scopes, needed)` (`admin` allows everything; exact match otherwise), `isExpired(row, nowMs)`.
- Tests: every scope rule, admin, expired, revoked.

### P2.2 Token API [H]
- Routes (admin only): `POST /api/v1/tokens` `{ scopes: string[], expiresInSeconds?: number, label? }` → `201 { id, token, scopes, expiresAt }` (the token is shown once); `GET /api/v1/tokens` (no token values); `DELETE /api/v1/tokens/{id}` → 204.
- Middleware `requireScope(needed)` in `server/lib/auth.js`: accepts the env `RELAY_API_TOKEN` as admin (unchanged behaviour) or a stored token with the scope. Existing routes keep `requireToken` (= admin) for now.
- Tests: create, list hides values, delete, expired token 401, wrong scope 403, env token still works.

### P2.3 Publish check for nginx-rtmp [H]
- Route `POST /internal/publish-auth` (form body from nginx-rtmp `on_publish`: `name`, `args` with `token=`). Answers 200 when the token has `stream:<name>:publish`, else 403. Only reachable on the internal network: bind check `req.socket.remoteAddress` is not public is **not** enough; require header `x-hook-secret` = env `HOOK_SECRET`.
- `nginx/nginx.conf`: `on_publish http://api:3000/internal/publish-auth;` (nginx-rtmp sends the hook; set the secret through a query `?secret=` on the hook URL since nginx-rtmp cannot add headers; accept either).
- Env flag `PUBLISH_AUTH=off|on` (default `off` so deploy does not break; turned on by Juha after the Pi uses a token).
- Tests: allowed, wrong stream, no token, bad secret, flag off allows all.

---

## P3. MediaMTX on the VPS (plan 3.1, 4.3, 9.2)

### P3.1 MediaMTX config and compose [H]
- Files: `mediamtx/mediamtx.yml`, `docker-compose.yml`, `deploy/docker-compose.yml`. Image `bluenviron/mediamtx:1.x` (pin a version, not `latest`). RTMP on `${RTMP_BIND:-127.0.0.1}:1935`, RTSP 8554 internal only, API 9997 internal only, HLS/WebRTC/SRT/RTMPS off. `authMethod: http`, `authHTTPAddress: http://api:3000/internal/mediamtx/auth`. Paths: `live/~^[a-z0-9_-]{1,32}(-cc)?$` with `runOnReady` / `runOnNotReady` calling `http://api:3000/internal/mediamtx/ready|notready?path=$MTX_PATH` (busybox `wget`, header secret not possible: pass `secret` query).
- nginx-rtmp stays in compose for HTTP static and rollback; its RTMP listener moves to an unused internal port.
- Done when: `docker compose config` validates; README section "MediaMTX" added.

### P3.2 MediaMTX auth hook [H]
- Route `POST /internal/mediamtx/auth` (JSON body from MediaMTX: `action`, `path`, `query`, `user`, `password`, `ip`, `protocol`). Rules: `action=publish` needs a token with `stream:<s>:publish` taken from `query` `token=` or `password`; the `-cc` path may only be published by the relay's own captioner (internal secret). `action=read|playback` from the Docker network (`ip` in `RELAY_INTERNAL_CIDRS`, default `172.16.0.0/12,10.0.0.0/8`) allowed; others 401. `api|metrics` actions: 401.
- Pure part in `server/lib/mediamtx-auth.js` (`decide({ action, path, query, password, ip }, lookupToken)` → `{ allow, reason }`).
- Tests: table-driven, at least 12 cases.

### P3.3 Ready hooks and radio pull [H+]
- Routes `POST /internal/mediamtx/ready` and `/notready` (query `path`, `secret`). `ready` for `live/<s>` calls the existing supervisor `start(<s>)` when the stream config has radio on (default on), with `RADIO_SOURCE_URL_TEMPLATE=rtsp://mediamtx:8554/live/{name}` default in compose. `notready` calls `stop`.
- Tests: with a fake supervisor: ready starts once, double ready does not start twice, notready stops, unknown path ignored, bad secret 401.

### P3.4 Input probe [H]
- `server/lib/probe.js`: `parseProbe(json)` from `ffprobe -v error -show_streams -of json` → `{ video: { codec, width, height, fps }, audio: { codec, sampleRate, channels } }`. `server/lib/probe-service.js` runs ffprobe on `rtsp://mediamtx:8554/live/<s>` on ready (timeout 10 s) and stores the result in memory; `GET /api/v1/streams/{s}` includes it.
- Tests: parser with three fixture JSONs (H.264+AAC, audio only, HEVC).

**S1 (human):** publish a test file through MediaMTX on a test host with a token; radio plays. Then Juha switches the Pi tunnel target.

---

## P4. Fan-out (plan 4.2)

### P4.1 Destination model and API [H]
- `server/lib/destinations.js`: validate `{ name, kind: 'youtube'|'facebook'|'rtmp', url, key, variant: 'raw'|'cc', enabled, startWith: 'stream'|'manual' }`. Rules: `url` must be `rtmp://` or `rtmps://`; `facebook` must be `rtmps://`; `name` `[a-z0-9_-]{1,32}`; max `MAX_DESTINATIONS_PER_STREAM` (default 6).
- Routes (scope `stream:<s>:control`): `GET/POST /api/v1/streams/{s}/destinations`, `PATCH/DELETE .../destinations/{d}`. Key stored with `secret-box`; responses show `hasKey: true`, never the key.
- Tests: validation table, key never in any response, limit.

### P4.2 Egress args [H]
- `server/lib/egress-args.js`: `egressArgs({ stream, variant, url, key, rtspBase })` → array: `['-hide_banner','-loglevel','warning','-rw_timeout','10000000','-i', '<rtspBase>/live/<s>[-cc]', '-c','copy','-f','flv', '<url>/<key>']`. No `-c:v` other than copy, ever (test asserts it).
- Tests: raw, cc, trailing slash in url, key with special characters.

### P4.3 Egress supervisor [H+]
- `server/lib/egress-supervisor.js`, copy the structure of `stream-supervisor.js`: one child per `(stream, destination)`, states `off|starting|live|retrying|failed`, backoff 2 s doubling to 60 s, `live` after 5 s without exit, stderr tail (20 lines) kept **after `redact()`**. `start(stream, dest)`, `stop(stream, destId)`, `stopStream(stream)`, `state()`. Injected `spawnProcess`.
- Wiring: P3.3 `ready` also starts destinations with `startWith: 'stream'` and `enabled`; `notready` stops them. Routes `POST .../destinations/{d}/start|stop`.
- Tests with a fake spawn: start, crash and restart with backoff, stop cancels retry, key never in state, two destinations independent.

### P4.4 Real-ffmpeg test [H]
- `server/test/egress.ffmpeg.test.js`: start a local MediaMTX? No: use ffmpeg as the sink (`ffmpeg -listen 1 -i rtmp://127.0.0.1:<port>/live/x -c copy -f null -`) and a generated source (`-f lavfi testsrc` + `sine`, `-c:v libx264 -g 50 -c:a aac`, published to an RTSP-free input: use `-re -i` a 5 s file made in setup). Assert the sink received frames. Skip without ffmpeg.

---

## P5. Recording to S3 (plan 5)

### P5.1 S3 client [H+]
- `server/lib/s3.js`: minimal SigV4 client with `putObject`, `headObject`, `deleteObject`, `getObject` using `fetch` (no SDK). Env `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PREFIX` (default `relay/`), path-style URLs.
- Tests: the AWS SigV4 documentation test vector (GET object example) must match exactly; a fake S3 server (`node:http`) for put/head/delete.
- If the agent cannot match the vector in two tries: stop and ask (copy from Saarnavideo's `src/worker/s3-presign.ts` logic is allowed).

### P5.2 Segment recorder args and spool [H]
- `server/lib/recorder-args.js`: `-i rtsp://.../live/<s> -c copy -f segment -segment_time 60 -segment_format mp4 -segment_format_options movflags=+frag_keyframe+empty_moov -reset_timestamps 1 -strftime 0 <spool>/<sessionId>/%06d.mp4`.
- `server/lib/spool.js`: `closedSegments(files)`: all but the newest; `nextUpload(dir)`.
- Tests: args, closed-segment logic.

### P5.3 Uploader and session [H+]
- `server/lib/recording-service.js`: start/stop a recording (DB row in `recordings`), recorder child via the egress supervisor pattern, uploader loop every 5 s: upload closed segments to `recordings/<s>/<sessionId>/<n>.mp4`, `headObject` size check, then delete locally. Spool cap `RECORDING_SPOOL_MAX_BYTES` (default 2 GB): over the cap, state `degraded`, recording continues, nothing deleted unuploaded.
- Routes (scope control): `POST /api/v1/streams/{s}/recordings`, `DELETE /api/v1/streams/{s}/recordings/current`, `GET /api/v1/streams/{s}/recordings`. Config `recordOnLive` starts it from the ready hook.
- At stop: write `session.json` (plan 5) and the sidecars from P7.4.
- Tests: fake S3 + fake spawn + temp dir: upload order, retry after S3 500, cap, stop writes manifest once.

### P5.4 Handoff manifest [S]
- Build the LCYT handoff manifest v1 for Saarnavideo from a session. Needs reading `saarnavideo/src/domain/lcyt-manifest.ts` and LCYT's `plan_saarnavideo_handoff.md`. Give to a stronger model.

---

## P6. Video HLS (plan 6, 7.2)

### P6.1 HLS packager args and supervisor role [H]
- `server/lib/hls-args.js`: `-i rtsp://.../live/<s> -c copy -f hls -hls_time 4 -hls_list_size <n> -hls_flags program_date_time+delete_segments+independent_segments -hls_segment_filename <hlsDir>/<s>/video/%d.ts <hlsDir>/<s>/video/stream.m3u8`, `<n>` from `DELAY_MAX_SECONDS` like the radio.
- Run under the egress supervisor as role `hls`; started on ready when stream config `videoHls` is on.
- Tests: args.

### P6.2 Delayed video playlist [H]
- Route `GET /api/streams/{s}/hls/video/delayed.m3u8` reusing `hls-delay.js` (same as the audio route, other directory). Segment URL prefix `/hls/<s>/video/`.
- Tests: copy the audio route tests with a video playlist fixture.

### P6.3 WebVTT caption renditions [H+]
- `server/lib/vtt-segments.js` (pure): `vttForSegment({ segStartMs, segEndMs, events, lang })` → WebVTT text with `X-TIMESTAMP-MAP=MPEGTS:<pts>,LOCAL:00:00:00.000` header; cue times relative to the segment's PDT. `masterPlaylist({ stream, langs, bandwidth, resolution })` → master with `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="<l>",NAME="<l>",URI=".../subs/<l>.m3u8"` and the video variant.
- Routes: `GET /api/streams/{s}/hls/master.m3u8`, `.../hls/subs/{lang}.m3u8` (one VTT segment per delayed video segment, same media sequence), `.../hls/subs/{lang}/{seq}.vtt`.
- Tests: cue at a segment border, cue spanning two segments (appears in both), no cues = valid empty VTT, Finnish characters, master playlist text exact.

**S2 (human):** fan-out to a local RTMP sink and to a private YouTube test key; HLS plays in Safari and hls.js with captions.

---

## P7. Timeline and sidecars (plan 7, 7.1, 7.2)

### P7.1 Event model [H]
- `server/lib/events.js`: `validateEvent(e)` for types `caption`, `translation`, `section`, `graphic`, `marker`, `data` (plan 7 table; `graphic.kind` in `hymn-verse|slide|image|text|clear`; `hymn-verse` payload `{ hymnNumber, title, verse, lines[] }`). Text fields max 500 chars, `lines` max 20. Returns `{ ok, error, event }` like `validateCaptionBody`.
- `server/lib/event-store.js`: `addEvents(db, stream, events, nowMs)` (dedupe on `source_key`, returns counts), `dueEvents(db, { stream, nowMs, delayMs, from, types, lang, limit })` (same release rule as `captions.js`: `startedAt <= nowMs - delayMs`), `rangeEvents(db, { stream, fromMs, toMs })`, `prune(db, olderThanMs)`.
- Existing captions are also stored as `caption` events (keep `captions.js` working; it may read from the store later, not in this task).
- Tests: validation table, dedupe, release by delay, filters.

### P7.2 Ingest [H]
- Extend `gateway-captions.js`: `EVENTS_PATH` takes `types=transcript,translation,section,rundown,graphic`; a mapper `mapGatewayEvent(sse)` (new file `server/lib/gateway-map.js`) turns each into a relay event or `null` (unknown types counted, raw kept as `data` when `KEEP_UNKNOWN_EVENTS=on`). Field names of pigateway's `section`, `rundown` and `graphic` events: **read `pigateway` README/contract first; if not documented, stop and ask.**
- Push route `POST /api/v1/streams/{s}/events` (scope `stream:<s>:data`), up to 100 events.
- Tests: mapper per type with fixtures, push route.

### P7.3 Assets [H]
- `POST /api/v1/streams/{s}/assets` (scope data, raw body, `Content-Type` image/png|jpeg|webp, max 10 MB) → stored in S3 at `assets/<sha256>.<ext>` (or local `ASSET_DIR` when S3 unset) → `{ assetId }`. `GET /api/assets/{assetId}` serves it with `Cache-Control: public, max-age=31536000, immutable`.
- Tests: type and size checks, dedupe by hash, served bytes equal.

### P7.4 Sidecar writers [H]
- `server/lib/sidecars.js` (pure): from a list of events build `captionsVtt(events, lang)`, `chaptersVtt(sections, endMs)`, `sectionsJson`, `hymnsJson` (verses grouped by hymn number), `graphicsJson` (with referenced asset ids), `eventsJsonl`. Times relative to the session start.
- `GET /api/v1/streams/{s}/sidecars?from=&to=&format=zip|json` (scope view): json lists file name → content.
- Tests: each builder with fixtures; Finnish text; empty input.

### P7.5 LCYT-compatible viewer SSE [H+]
- `GET /api/v1/viewer/{key}` (public, CORS `*`, excluded from the `/api/v1` Bearer rules and the control rate limit; uses the public limit). Viewer key = stream config `viewerKey`, default the stream name.
- Query `mode=live|delayed` (default `live`). `live`: every event is sent as soon as it is stored (church visitors, no delay). `delayed`: released at `startedAt + delay` (remote listeners).
- Events: `connected`; `caption` with `{ text, composedText, translations: { <lang>: text }, codes: { section }, sequence, timestamp }` where `timestamp` is ISO **without** `Z` (LCYT format), `composedText` = `text<br>translation` of the stream's first visible translation language; `graphic` with the graphic payload. A translation arriving later re-sends the same `sequence` with `translations` filled.
- Pure builder in `server/lib/viewer-payload.js`: `toViewerCaption(caption, translations, section, sequence)`.
- On connect, send the current state once (last caption, current section, current hymn verse) so a visitor who opens the page mid-service sees something at once.
- Tests: payload shape matches the LCYT example in `live-captions-yt/android/lcyt-tv/CLAUDE.md` exactly (field names), re-send on translation, CORS header, live mode sends at once, delayed mode waits, state on connect.

## P7b. Viewer pages [H+]
- Folder `viewer/` (Vite, plain JS, no framework), built to `server/public/viewer/` in the API Docker image. Pages: `/view/{key}` (the church visitors' page, **live mode, no delay**; port of LCYT `ViewerPage.jsx`: params `theme`, `fontsize`, `lang` = code | `original` | `all`; phone-first layout, chosen language kept in `localStorage`, Wake Lock where supported), `/embed/viewer?key=` (port of `EmbedViewerPage.jsx`), `/watch?stream=` (hls.js player of `master.m3u8` + the viewer panel in delayed mode), `/listen` updated to include the section heading and hymn panel.
- Panels: caption (big text, `<br>` split without `innerHTML`), section heading, hymn (number, title, verse lines), picture (`/api/assets/{id}`), language picker (stream's visible languages).
- Copy LCYT's logic, not its files' imports; keep `resolveViewerText`/`collectLangTexts` as `viewer/src/viewer-utils.js` with tests ported from LCYT `test/viewer.test.js`.
- Routes registered before the `/:stream` catch-all (rule 9).
- Tests: utils unit tests; one server test that each page route returns HTML 200.

---

## P8. Translation ingest (plan 7, aligned with pivoice translation plan 10.2) [H]
- Map pigateway `translation` events (`sourceKey`, `lang`, `text`, `startMs`, `endMs`, `model`) in `gateway-map.js`; stored as `translation` events with `source_key = sourceKey + ':' + lang`; link to the caption by `sourceKey`.
- Stream config `visibleLanguages` (default `["fi"]`), editable by `PUT /api/v1/streams/{s}/config` (scope control).
- Late flag: a translation whose `startedAt + delay < receivedAt` is stored with `late: true` and counted in `/metrics`.
- Tests: mapping, late flag, viewer re-send (uses P7.5).

---

## P9. Captioner (plan 8) — E1 passed (human-confirmed 2026-11-24)

| Task | Content | Mark |
|---|---|---|
| P9.1 | `server/lib/cea608.js`: pop-on encoder: text → byte pairs (RCL, PAC rows 14/15, chars with odd parity, extended chars for ä ö å Ä Ö Å, EOC, EDM), 32-char wrap. Test vectors written by hand from CEA-608 tables in the test file. | [S] |
| P9.2 | `server/lib/cc-data.js`: `cc_data` packer (`cc_count`, `cc_valid`, `cc_type` 0) and A/53 SEI NAL (`GA94`, T.35 country 0xB5, provider 0x0031, emulation prevention bytes). Test: SEI bytes for a known pair match a fixture extracted with ffmpeg from a libx264 `-a53cc` file. | [S] |
| P9.3 | `server/lib/flv.js`: FLV reader/writer (header, tags, AVC NALU length-prefixed, composition time); round-trip test on a generated file is byte-identical. | [H+] |
| P9.4 | `server/lib/hold-buffer.js`: holds tags `holdMs`, wall-clock stamping with smoothing, release in order. Pure, fake clock. | [H] |
| P9.5 | `server/lib/captioner.js`: schedules pop-on loads before `startedAt`, EOC at the frame whose PTS wall time ≥ `startedAt`, EDM at `endedAt`; B-frame order by PTS; late-caption counter. | [S] |
| P9.6 | Wiring: two ffmpeg children + Node pipe, publishes `live/<s>-cc` with the internal secret; `PUT/GET /api/v1/streams/{s}/captioner`. Real-ffmpeg test: embed, extract with ffmpeg `subcc`, compare text and times (±1 frame). | [S] |

---

## P10. Public ingest (plan 9.3) [H]
- `mediamtx.yml`: RTMPS on a published port with a certificate from a mounted path (`RTMPS_CERT`, `RTMPS_KEY`), SRT behind env flag `SRT_ENABLED`. Auth already through P3.2.
- README: how to give a phone a token (`POST /api/v1/tokens` with `stream:<s>:publish` and `stream:<s>:data`, 12 h).
- Firewall rules are set on the VPS by Juha or the VPS session, not by this task.

---

## Experiments (humans, not agents)

- **E1** 608 on YouTube at 25 and 30 fps (plan 15). Gate for P9. How to run it: [`e1-youtube-608.md`](e1-youtube-608.md).
- **E2** Facebook RTMPS copy push.
- **E3** Clapper test for `CAPTION_SYNC_OFFSET_MS`.
- **E4** Church upstream bandwidth through the tunnel with video.
- **E5** VPS bandwidth with HLS viewers.

---

## Task checklist

All tasks were built on one branch (PR #13) instead of one PR each. Nothing has run against a real MediaMTX, S3, YouTube or Facebook; sync points S1 to S3 are still human checks.

| Task | Mark | Needs | Status (2026-11-22) |
|---|---|---|---|
| P1.1 pnpm | H | | done (PR #13) |
| P1.2 redact | H | | done (PR #13) |
| P1.3 store | H+ | | done (PR #13) |
| P1.4 secret box | H | | done (PR #13) |
| P2.1 token logic | H | P1.3 | done (PR #13) |
| P2.2 token API | H | P2.1 | done (PR #13) |
| P2.3 nginx publish check | H | P2.2 | done (PR #13) |
| P3.1 MediaMTX compose | H | P2.3 | done (PR #13) |
| P3.2 auth hook | H | P3.1 | done (PR #13) |
| P3.3 ready hooks | H+ | P3.2 | done (PR #13) |
| P3.4 probe | H | P3.3 | done (PR #13) |
| P4.1 destinations | H | P3.3, P1.4 | done (PR #13) |
| P4.2 egress args | H | P1.2 | done (PR #13) |
| P4.3 egress supervisor | H+ | P4.1, P4.2 | done (PR #13) |
| P4.4 ffmpeg test | H | P4.3 | done (PR #13) |
| P5.1 S3 client | H+ | P1.1 | done (PR #13) |
| P5.2 recorder args | H | P3.3 | done (PR #13) |
| P5.3 recording service | H+ | P5.1, P5.2, P4.3, P7.4 | done (PR #13) |
| P5.4 handoff manifest | S | P5.3 | done (PR #13) |
| P6.1 HLS packager | H | P4.3 | done (PR #13) |
| P6.2 delayed video | H | P6.1 | done (PR #13) |
| P6.3 VTT renditions | H+ | P6.2, P7.1 | done (PR #13) |
| P7.1 events | H | P1.3 | done (PR #13) |
| P7.2 ingest | H | P7.1 | done (PR #13) |
| P7.3 assets | H | P7.1, P5.1 | done (PR #13) |
| P7.4 sidecars | H | P7.1 | done (PR #13) |
| P7.5 viewer SSE | H+ | P7.1 | done (PR #13) |
| P7b viewer pages | H+ | P7.5, P6.3 | done (PR #13) |
| P8 translations | H | P7.2, P7.5 | done (PR #13) |
| P9.1 to P9.6 captioner | S/H+ | E1, P3.3, P7.1 | E1 passed (human-confirmed 2026-11-24); P9.1-P9.5 components present; P9.6 wiring and API implemented on PR #13; awaiting CI and real-FFmpeg extraction verification |
| P10 public ingest | H | P3.2 | done (PR #13) |
