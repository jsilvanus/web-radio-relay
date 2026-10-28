# web-radio-relay plan

Last reviewed: 2026-10-28

## Goal

Provide public audio-only HLS radio, server-side listener delay, timed captions, and MP3 archives. Keep a single FFmpeg process per published stream with two outputs: AAC/HLS for listeners and MP3 for the archive.

## Current input architecture

The relay's FFmpeg input is configurable with `AUDIO_INPUT_URL`. If unset, the legacy behavior remains: `rtmp://127.0.0.1/live/${STREAM_NAME}`. This supports both the existing nginx-RTMP ingest and a direct MediaMTX source (for example, an RTSP URL) without hard-coding codec assumptions into the relay. Set the URL appropriate to the deployment; do not configure a PiVoice/MediaMTX URL until its actual path and network reachability are known.

The relay does not capture microphone audio, transcribe speech, or proxy audio through a control API. PiVoice publishes its stream to MediaMTX; the relay pulls that stream as a consumer. The exact MediaMTX path, transport, authentication, and reconnect behavior must be confirmed against the deployment configuration.

## Implemented

- Configurable FFmpeg input URL through `AUDIO_INPUT_URL`, retaining the legacy per-stream RTMP default.
- Single FFmpeg invocation writes delayed-playlist source HLS and a timestamped MP3 archive.
- Multi-stream state, per-stream caption buffers and listener delay.
- OpenAPI document at `server/openapi.json` and tests for API/CLI consistency.

## Remaining work / acceptance

1. Run the current server and CLI test suites and validate the OpenAPI document against actual registered routes on the current default branch.
2. Add or confirm tests for the input URL override and legacy default, including safe logging and no accidental URL exposure of credentials.
3. Confirm FFmpeg reconnect behavior when the configured RTSP/MediaMTX source becomes temporarily unavailable; implement bounded retry/restart supervision if the existing nginx publisher lifecycle does not provide it.
4. Configure the real MediaMTX stream path and network policy only after checking the deployment's MediaMTX configuration. Keep the existing RTMP default working.
5. Perform an end-to-end stream test and verify HLS delay, captions, and archive closure when a stream ends.

No deployment or live church-device changes are part of this code update.
