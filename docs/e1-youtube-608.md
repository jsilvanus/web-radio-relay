# E1: does YouTube Live show our CEA-608 captions?

Experiment E1 from [`media-relay-plan.md`](media-relay-plan.md) section 15, the gate for the captioner (P9). It answers one question: does YouTube Live display CEA-608 captions that we put into an **existing** H.264 stream as SEI NAL units, **without re-encoding**, at 25 fps and at 30 fps?

## What the test file is

`server/scripts/e1-make-test.mjs` makes an FLV file:

1. ffmpeg makes a source: `testsrc2` 1280x720 with a burned line `t HH:MM:SS.mmm   frame N   expected nro K`, a 440 Hz tone, libx264 (`-tune zerolatency -bf 0 -g 2*fps`, yuv420p), AAC 128k.
2. The file is parsed with `server/lib/flv.js`. Into **every** video frame one SEI NAL unit is inserted (A/53 `GA94` `cc_data`, `server/lib/cc-data.js`), after the frame's AUD/SPS/PPS/SEI and before its first slice. Nothing else in the frame changes (a test strips the SEI again and gets the source back byte for byte).
3. The captions are CEA-608 pop-on, channel CC1, field 1 (`server/lib/cea608.js`): caption N is `E1 testi <fps> fps nro N: äöå ÄÖÅ`. It is loaded into the non-displayed memory in the seconds before, appears with End Of Caption on the exact frame at **N x 6 s** (frame N x 6 x fps), and is erased 4 s later. So caption N should appear when the burned line shows `expected nro N` for the first time, and disappear 2 s before the next one.
4. Data rate: two bytes per frame at 30 fps (`cc_count` 1). At 25 fps the script keeps the same 608 byte rate by sending two pairs in every fifth frame (`cc_count` 2; frames with one pair carry an unused slot with `cc_valid` 0). This is the part the plan marks as the biggest unknown.

The SEI is byte-identical to what ffmpeg 6.1 + libx264 `-a53cc 1` writes for the same caption bytes (fixture test in `server/test/cc-data.test.js`), so the only difference from a re-encoded stream is that the video was not re-encoded.

## What is already proven (here, without YouTube)

`server/test/e1-608.ffmpeg.test.js` makes 20 s files at 25 and 30 fps and decodes them with ffmpeg's own 608 decoder (`movie=...[out0+subcc]`). Result on 2026-11-23 (ffmpeg 6.1.1): both captions decode with the exact text including `ä ö å Ä Ö Å`, start at 6.000 s and 12.000 s and end at 10.000 s and 16.000 s, timing error 0 ms (the test allows one frame).

What this does **not** prove: that YouTube's ingest keeps the SEI in copy mode, that its decoder reads 608 at 25 fps or with two pairs in one frame, or how it shows the extended characters. That is E1.

## How to run it on the Pi

Needs Node 24 (the repository version; 22 also works) and ffmpeg with libx264 (drawtext is used for the burned line; without it the file is still made, with a warning).

```sh
node server/scripts/e1-make-test.mjs --fps 25 --seconds 300 --out /tmp/e1-25.flv
node server/scripts/e1-make-test.mjs --fps 30 --seconds 300 --out /tmp/e1-30.flv
```

Optional check before streaming (prints the captions as SRT):

```sh
ffmpeg -f lavfi -i "movie=/tmp/e1-25.flv[out0+subcc]" -map 0:s -f srt -
```

On YouTube Studio, create a **private** test broadcast (or use a test stream key) and make sure closed captions are **enabled with the source "Embedded 608/708"** (Live settings, Closed captions; the wording may differ). Then stream the file in copy mode, at real-time speed:

```sh
export KEY=...   # the test stream key; type it in the shell, never into a file
ffmpeg -re -i /tmp/e1-25.flv -c copy -f flv "rtmp://a.rtmp.youtube.com/live2/$KEY"
```

Watch the broadcast with the CC button on, and repeat with `/tmp/e1-30.flv` (a new broadcast, or wait until the first one ended). If 25 fps fails, also try one pair per frame (lower 608 rate, no two-pair frames):

```sh
node server/scripts/e1-make-test.mjs --fps 25 --seconds 300 --pairs-per-frame 1 --out /tmp/e1-25-p1.flv
```

Other options: `--interval` and `--show` (seconds between captions and on screen), `--align center`, `--schedule file.json` (writes the planned times).

## What to look for

- Captions appear at all (CC button available, text on screen).
- `ä ö å Ä Ö Å` are shown correctly (not as `a o a A O A`, not as boxes or doubled letters).
- Caption N appears when the burned line first shows `expected nro N` (that is N x 6 s on the burned clock), and is gone at N x 6 + 4 s.
- No drift: after 5 minutes (caption 49 at 4:54), the caption still appears with `expected nro 49`. A difference of a frame or two is fine; a growing delay is not.
- Note YouTube's own delay: the whole player lags the stream by seconds; compare the caption with the burned line **in the same picture**, not with the wall clock.

## Results (fill in)

| Date | fps | Pairs per frame | Captions shown | ä ö å Ä Ö Å correct | Timing vs burned clock | Drift after 5 min | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-23 | 25 | auto (1,1,1,1,2) | yes, from nro 4 (1-3 not shown) | yes | matches burned clock | not checked | Private broadcast, copy mode from the Pi. Recording starts about 10 s in with nro 4; captions 1-3 likely fell before YouTube's recording/caption start. YouTube marks the video as having captions (contentDetails.caption true); track list needs the youtube.force-ssl scope. Ingest reported noData once around 2 min. |
| | 25 | 1 | | | | | |
| | 30 | auto (1) | | | | | |

E1 passes when 25 fps and 30 fps both show the captions with correct Finnish letters and stable timing. If only 30 fps works, the plan's fallback applies (fleet `libx264 -a53cc` re-encode, or the LCYT HTTP caption POST with the delayed stream); write the result here and in the phase plan.

## Follow-up (2026-11-24): VTT, two tracks, language

**Result of the 25 fps run:** YouTube shows the 608 captions in the picture with the right Finnish letters and the timing matches the burned clock. The captions are in the video, not in a caption track YouTube lets us download (`captions.list` needs `youtube.force-ssl`, which the Pi's sign-in lacks), so the VTT must come from us.

**VTT next to the 608.** `server/lib/vtt.js` writes WebVTT in the same format as LCYT's caption files (`packages/lcyt-backend/src/caption-files.js`). `e1-make-test.mjs` writes `<out>.cc1.vtt` (and `<out>.cc3.vtt` with `--tracks 2`) on the file's timeline. The real captioner should write the VTT from the same cues it embeds.

**Language.** CEA-608 has no language field: a caption track carries only its channel (CC1 to CC4). The name "English - CC1" comes from YouTube's side, not from the stream. Unverified: whether a YouTube live setting or the API sets the language of an embedded track. Check in YouTube Studio (broadcast, closed captions) before relying on it.

**Two tracks.** `--tracks 2` adds CC3: field 2, data channel 1, text `E1 CC3 nro N: test` (ASCII only), in the same frames as CC1. Each pair of CC3 is tagged `cc_type 1` in cc_data. ffmpeg decodes CC3 captions sent as field 2 alone (test `CC3 (field 2)`); with both fields in one file, ffmpeg's decoder reads only the first field that appears, so that check needs a YouTube run. At 30 fps two tracks means two pairs per frame (cc_count 2), which is twice the 608 data rate of one channel. YouTube documents one track, so this is the test.

**Pi steps for the next run** (the test stream `YP68iNhke-dDXCNPHhCZ3Q1795413356473763` can be reused; create a new private broadcast with embedded 608 captions):

```sh
node server/scripts/e1-make-test.mjs --fps 30 --seconds 600 --tracks 2 --out /home/pi/apps/e1-608/e1-30-2tracks.flv
ffmpeg -re -stream_loop -1 -i /home/pi/apps/e1-608/e1-30-2tracks.flv -c copy -f flv "rtmp://a.rtmp.youtube.com/live2/$KEY"
```

Watch with CC on and check CC1 (Finnish text) and CC3 (`E1 CC3 nro N`). Record what YouTube shows for each track name.

| Date | fps | Tracks | Result |
|---|---|---|---|
| 2026-11-23 | 25 | 1 (CC1) | Captions shown from nro 4 with correct letters; nro 1-3 not shown; track labelled English - CC1 |
| 2026-11-24 | 30 | 2 (CC1 + CC3) | yes, CC1 shown; first seen was nro 3 at 8 s on the player clock (player began about 11 s into the file, so nro 1 and 2 came before it); CC3 not shown: the player offered only CC1. Possibly received but not displayed; unconfirmed, since the caption track list needs youtube.force-ssl | yes, Finnish letters correct | player clock consistent with the file: nro 3 due at 18 s, seen about 7 s after the player began | not checked | Private broadcast with embedded captions, copy mode from the Pi, 16:50 to 17:01 Pi time. Ingest good, one info note: bitrate high (about 4.8 Mbps). |
| | 30 | 1 (CC1), lead-in 30 s | planned: `--lead-in 30`, to check whether nro 1 appears once the player starts |  |  |  |  |

