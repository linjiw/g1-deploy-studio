# Introduction video tooling

The introduction video is rebuilt from source: a storyboard, a data-driven animated deck and scripted shots of the real Studio UI. It is captured frame by frame, so software WebGL speed does not matter.

| File | Role |
|---|---|
| `storyboard.json` | Segment order. Each segment is `deck` (a slide) or `app` (a shot), with its spoken narration (`say`) and a minimum length |
| `deck.html`, `deck-data.js` | Design and results slides as pure functions of a virtual time `t` (`show(id)`, `setT(t)`). Every number in `deck-data.js` is copied from committed evidence (ROBUSTNESS, REVALIDATION, ROBOT_CONTRACT) |
| `shots.mjs` | App shots that drive the UI through `window.__studio` and real clicks, with an injected caption, highlight and cursor overlay |
| `narrate.py` | Kokoro-82M TTS (Apache-2.0, CPU), cached per segment. Refuses words outside the lexicon; uses phoneme overrides such as `[Unitree](/juːnitɹiː/)`. Spoken forms ("Zero M Q") are mapped back to written forms for the subtitles |
| `capture.mjs` | Headless Chrome capture: deck at 30 fps, app at 15 fps, streamed into ffmpeg (one H.264 segment each) |
| `assemble.py` | Concatenates the segments, lays each narration at its segment start, normalises loudness, and writes the MP4 with a soft English subtitle track, a sidecar `.srt` and `chapters.txt` |

## Rebuild

```bash
OUT=~/research-data/g1-deploy-studio/evidence/video-<date>
# 1. Narration (a scratch venv: python3.10 -m venv tts; tts/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu; tts/bin/pip install kokoro soundfile)
tts/bin/python -B tools/video/narrate.py --storyboard tools/video/storyboard.json --out $OUT
# 2. A demo gateway with its own data root for the shots that save an arena and run a rehearsal
PORT=8797 DATA_ROOT=~/research-data/g1-deploy-studio/video-demo-workbench EVIDENCE=$OUT/demo tools/browser/validation/gateway.sh start
#    (create the "Studio demo · offset doorway" arena there through POST /api/arenas)
#    For the navigate-robot shot, start that gateway with STUDIO_ROBOT_LINK=<a config like config/robot_link.example.json
#    whose endpoints are tcp://127.0.0.1:18561 (odom, cloud), 18556 (pose), 18557 (debug), 18562 (control)>; the shot runs
#    tools/fake_node.py, a protocol fixture, on those ports. Check /api/workbench lists the demo arenas: a stale gateway on
#    the same port makes `gateway.sh start` report "up" without starting.
# 3. Frames → segments (read-only shots use the release service on 8790)
node tools/video/capture.mjs --out $OUT --app http://127.0.0.1:8790 --demo http://127.0.0.1:8797
# 4. Final video
python3 tools/video/assemble.py --out $OUT --ffmpeg <path-to-ffmpeg>
```

`--only id,id` re-captures selected segments. The capture never touches hardware. Only the `arena`, `rehearse` and `navigate*` shots change anything, and only on the demo gateway's data root. The rehearse shot is a labelled time-lapse of a real owned CPU run.
