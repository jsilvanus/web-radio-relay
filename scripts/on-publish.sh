#!/usr/bin/env bash
# =============================================================================
# on-publish.sh — launched by nginx RTMP exec_push when a publisher connects
#
# Arguments:
#   $1  stream name (the RTMP application key, e.g. "stream")
#
# What it does:
#   1. Creates the HLS output dir and the archive dir if they don't exist.
#   2. Runs FFmpeg with two outputs:
#        a) HLS audio-only stream  →  $HLS_DIR/stream.m3u8  (live, rolling)
#        b) Full MP3 archive file  →  $ARCHIVE_DIR/<timestamp>_<name>.mp3
#
# Environment variables (with defaults):
#   HLS_DIR      Directory where HLS segments are written  (/var/www/radio/hls)
#   ARCHIVE_DIR  Directory where MP3 archives are stored   (/var/www/radio/archive)
#   LOG_DIR      Directory for FFmpeg logs                 (/var/log/tuberadio)
#   AUDIO_BITRATE  Audio bitrate for both outputs           (128k)
#   HLS_TIME     HLS segment duration in seconds           (4)
#   HLS_LIST_SIZE  Number of segments kept in playlist     (10)
# =============================================================================

set -euo pipefail

STREAM_NAME="${1:-stream}"

HLS_DIR="${HLS_DIR:-/var/www/radio/hls}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/var/www/radio/archive}"
LOG_DIR="${LOG_DIR:-/var/log/tuberadio}"
AUDIO_BITRATE="${AUDIO_BITRATE:-128k}"
HLS_TIME="${HLS_TIME:-4}"
HLS_LIST_SIZE="${HLS_LIST_SIZE:-10}"
DELAY_MAX_SECONDS="${DELAY_MAX_SECONDS:-60}"

# The relay serves listeners a playlist delayed by up to DELAY_MAX_SECONDS, so
# the live playlist must still hold those segments: size it to cover the delay
# plus a few segments for the delayed window.
MIN_LIST_SIZE=$(( (DELAY_MAX_SECONDS + HLS_TIME - 1) / HLS_TIME + 6 ))
if [ "$HLS_LIST_SIZE" -lt "$MIN_LIST_SIZE" ]; then
  HLS_LIST_SIZE="$MIN_LIST_SIZE"
fi

RTMP_INPUT="rtmp://127.0.0.1/live/${STREAM_NAME}"

# Timestamp used for the archive filename — formatted for lexicographic sorting
ARCHIVE_TIMESTAMP="$(date +"%Y-%m-%d_%H-%M-%S")"
ARCHIVE_FILE="${ARCHIVE_DIR}/${ARCHIVE_TIMESTAMP}_${STREAM_NAME}.mp3"

# HLS output files
HLS_MANIFEST="${HLS_DIR}/stream.m3u8"
HLS_SEGMENTS="${HLS_DIR}/seg%05d.ts"

LOG_FILE="${LOG_DIR}/ffmpeg_${ARCHIVE_TIMESTAMP}.log"

STATS_API_URL="${STATS_API_URL:-http://127.0.0.1:3000}"
RELAY_API_TOKEN="${RELAY_API_TOKEN:-}"

# Create directories
mkdir -p "$HLS_DIR" "$ARCHIVE_DIR" "$LOG_DIR"

echo "[$(date -Iseconds)] Starting stream '${STREAM_NAME}'" >> "$LOG_FILE"
echo "  RTMP input : $RTMP_INPUT"   >> "$LOG_FILE"
echo "  HLS output : $HLS_MANIFEST" >> "$LOG_FILE"
echo "  Archive    : $ARCHIVE_FILE" >> "$LOG_FILE"

# ---------------------------------------------------------------------------
# FFmpeg command — single process, two outputs
#
#  Input:
#    -i rtmp://...          RTMP stream from nginx
#
#  Shared flags:
#    -vn                    strip video track
#
#  Output 1 — rolling HLS playlist (live stream)
#    -c:a aac               re-encode to AAC (most browser-compatible)
#    -b:a $AUDIO_BITRATE    bitrate
#    -f hls                 HLS muxer
#    -hls_time N            segment duration
#    -hls_list_size N       number of segments in the playlist
#    -hls_flags delete_segments+append_list
#                           delete old segments; keep appending so late
#                           joiners can start from the beginning of the list
#    -hls_segment_filename  explicit pattern so segments don't clash on restart
#
#  Output 2 — full-session MP3 archive
#    -c:a libmp3lame        MP3 encoder
#    -b:a $AUDIO_BITRATE    bitrate
#    -id3v2_version 3       write ID3v2 tags
#    -metadata title=...    embed stream name in the tag
#    -metadata date=...     embed start timestamp in the tag
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Notify the API server of the stream session start (fire-and-forget)
# ---------------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  _AUTH_HEADER=""
  if [ -n "$RELAY_API_TOKEN" ]; then
    _AUTH_HEADER="Authorization: Bearer ${RELAY_API_TOKEN}"
  fi
  curl -sf \
    -X POST \
    -H "Content-Type: application/json" \
    ${_AUTH_HEADER:+-H "$_AUTH_HEADER"} \
    -d "{\"event\":\"start\",\"streamName\":\"${STREAM_NAME}\",\"timestamp\":\"$(date -Iseconds)\"}" \
    "${STATS_API_URL}/api/v1/stats/session" \
    >> "$LOG_FILE" 2>&1 || true
fi

exec ffmpeg \
    -loglevel warning \
    -i "$RTMP_INPUT" \
    \
    -vn \
    -c:a aac \
    -b:a "$AUDIO_BITRATE" \
    -f hls \
    -hls_time "$HLS_TIME" \
    -hls_list_size "$HLS_LIST_SIZE" \
    -hls_flags delete_segments+append_list+program_date_time \
    -hls_segment_filename "$HLS_SEGMENTS" \
    "$HLS_MANIFEST" \
    \
    -vn \
    -c:a libmp3lame \
    -b:a "$AUDIO_BITRATE" \
    -id3v2_version 3 \
    -metadata title="$STREAM_NAME" \
    -metadata date="$ARCHIVE_TIMESTAMP" \
    "$ARCHIVE_FILE" \
    >> "$LOG_FILE" 2>&1
