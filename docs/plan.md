# web-radio-relay plan

Last reviewed: 2026-10-28

## Goal

Provide public audio-only HLS radio, server-side listener delay, timed captions, and MP3 archives. The relay owns the lifecycle of each source-pull session; PiGateway is an authenticated control client and must not proxy audio or supervise FFmpeg itself.

## Current input architecture

The FFmpeg input is configurable with `AUDIO_INPUT_URL`; unset, the legacy shell publisher uses `rtmp://127.0.0.1/live/${STREAM_NAME}`. PiVoice is expected to publish to MediaMTX and the relay to pull that source (for example, RTSP). The actual MediaMTX path, transport, authentication and reachability remain deployment-specific.

## Lifecycle API target

All control routes are under `/api/v1/streams/{name}` and require `Authorization: Bearer <RELAY_API_TOKEN>`.

- `POST /api/v1/streams/{name}/start`: start the configured source for a safe stream name. Idempotent when already starting/running; return accepted state and a stable operation/session identifier.
- `POST /api/v1/streams/{name}/stop`: request graceful termination and archive finalization. Idempotent when already stopped/stopping.
- `GET /api/v1/streams/{name}/lifecycle`: return desired state, observed process state, source health, start time, last transition, restart count and sanitized last error.
- `GET /api/v1/streams/lifecycle`: list lifecycle state for streams known to the supervisor.
- `POST /api/v1/streams/{name}/restart` is deliberately not required for v1; clients should stop then start and observe each result.

Names must use the existing restricted stream-name grammar. The request must not accept an arbitrary source URL: source URLs are deployment configuration, not user-controlled API input. Never expose credentials embedded in URLs in status, errors or logs.

## Lifecycle invariants

- The relay is the sole owner of FFmpeg child processes for API-managed streams.
- Exactly one process per stream; serialize concurrent start/stop requests.
- Distinguish desired state from observed state: `stopped`, `starting`, `running`, `stopping`, `failed`.
- Start is successful only after the child has spawned; `running` additionally requires fresh HLS manifest/segments.
- Stop sends SIGTERM, waits a bounded grace period, then SIGKILLs if necessary; close the MP3 archive and record the session end exactly once.
- Source failure must be observable and use bounded retry with exponential backoff; stop cancels retries.
- Relay shutdown stops managed children and finalizes archives. Startup must reconcile stale HLS files and must not claim an orphaned stream is running.
- Keep the existing RTMP/Nginx callback path working during migration. Prevent the same stream being started both by RTMP callbacks and the API supervisor.
- The API control token is mandatory; control routes fail closed if it is unset. Do not expose control routes publicly without authentication.

## PiGateway integration contract

PiGateway uses `PIGATEWAY_RADIO_RELAY_API_URL` and `PIGATEWAY_RADIO_RELAY_API_TOKEN`. Both must be set together. It calls the relay lifecycle endpoints over HTTP with a timeout and bearer token, exposes gateway routes to start/stop/query a configured stream, and includes radio relay connectivity/state in `GET /api/v1/status`. It forwards only commands and state; audio stays on the MediaMTX-to-relay path. Do not deploy or contact live devices as part of implementation.

## Implemented

- Authenticated managed lifecycle API for start, stop and lifecycle state, backed by an FFmpeg supervisor with bounded retries and shutdown cleanup.
- Docker API image includes FFmpeg; managed lifecycle HLS, archive and log directories are writable/shared.
- OpenAPI lifecycle paths and initial supervisor unit tests added.

- Configurable FFmpeg input URL through `AUDIO_INPUT_URL`, retaining the legacy per-stream RTMP default.
- Single FFmpeg invocation writes HLS and a timestamped MP3 archive.
- Multi-stream state, per-stream caption buffers and listener delay.
- OpenAPI document at `server/openapi.json` and API tests for existing routes.

## Remaining work / acceptance

1. Run lifecycle and full API tests; verify process exit races and archive closure with real FFmpeg.
2. Integrate the supervisor with Docker Compose and bare-metal deployment. Install FFmpeg in the process-owning runtime and ensure it has only the required HLS/archive/log volume access.
3. Preserve legacy RTMP ingest without allowing duplicate FFmpeg processes; document migration and rollback.
4. Add tests for auth, invalid names, idempotency, concurrent start/stop, failed spawn, stale HLS, source loss/retry, graceful stop/archive closure, shutdown and token-not-configured behavior.
5. Add PiGateway configuration, authenticated client/routes, status reporting, OpenAPI and tests for timeout, unreachable relay, 401/5xx and state mapping.
6. Run relay and gateway test/build/OpenAPI consistency checks. Then perform a staged RTSP/MediaMTX end-to-end test; deployment-specific source URL must be verified before configuring it.

No deployment or live church-device changes are part of this plan.
