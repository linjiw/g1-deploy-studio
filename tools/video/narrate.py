#!/usr/bin/env python3
"""Synthesize the storyboard narration with Kokoro-82M (Apache-2.0) on CPU.

Run with a Python that has `kokoro` and `soundfile` installed (a scratch venv; nothing is installed in
Studio's environment):

    <tts-venv>/bin/python tools/video/narrate.py --storyboard tools/video/storyboard.json --out <dir>

Writes <dir>/audio/<segment>.wav (24 kHz mono), reusing a file when its text, voice and speed are
unchanged, and <dir>/narration.json with each segment's duration and per-phrase timings (used for
subtitles). Inline phoneme overrides use Kokoro's syntax: [Unitree](/juːnitɹiː/).
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path

SPOKEN_TO_WRITTEN = [
    (r'\[([^\]]+)\]\(/[^)]*/\)', r'\1'), (r'\bZero M Q\b', 'ZMQ'), (r'\bD D S\b', 'DDS'), (r'\bS D K\b', 'SDK'),
    (r'\bS S H\b', 'SSH'), (r'\bW X\b', 'WX'), (r'\bL zero\b', 'L0'), (r'\bL one\b', 'L1'), (r'\bL two\b', 'L2'),
    (r'\bL three\b', 'L3'), (r'\bM five\b', 'M5'), (r'\bnewton-meter\b', 'N·m'), (r'\bL I O\b', 'LIO'), (r'\bP C\b', 'PC'),
]


def written(text):
    for pattern, repl in SPOKEN_TO_WRITTEN:
        text = re.sub(pattern, repl, text)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--storyboard', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--speed', type=float, default=1.0)
    args = ap.parse_args()
    board = json.loads(Path(args.storyboard).read_text())
    out = Path(args.out)
    (out / 'audio').mkdir(parents=True, exist_ok=True)
    voice = board.get('voice', 'af_heart')

    # The espeak-ng fallback bundled with misaki fails to find its data on this host; disable it and
    # refuse any word outside Kokoro's lexicon instead of letting it be silently skipped.
    import misaki.espeak

    class NoFallback:
        def __init__(self, *a, **k):
            raise RuntimeError('espeak fallback disabled')
    misaki.espeak.EspeakFallback = NoFallback
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline
    os.environ.setdefault('OMP_NUM_THREADS', '8')
    pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')

    missing = {}
    for seg in board['segments']:
        text = (seg.get('say') or '').strip()
        if text and text != 'PENDING':
            _, tokens = pipe.g2p(text)
            words = [t.text for t in tokens if t.phonemes is None and re.search(r'[A-Za-z]', t.text)]
            if words:
                missing[seg['id']] = words
    if missing:
        raise SystemExit(f'Words outside the lexicon (reword or add a phoneme override): {missing}')

    previous = {}
    index_path = out / 'narration.json'
    if index_path.exists():
        previous = {s['id']: s for s in json.loads(index_path.read_text())['segments']}
    rows = []
    for seg in board['segments']:
        text = (seg.get('say') or '').strip()
        if not text or text == 'PENDING':
            rows.append({'id': seg['id'], 'duration_s': 0.0, 'phrases': [], 'text': ''})
            continue
        key = hashlib.sha256(f'{voice}|{args.speed}|{text}'.encode()).hexdigest()[:16]
        wav = out / 'audio' / f"{seg['id']}.wav"
        if previous.get(seg['id'], {}).get('key') == key and wav.exists():
            rows.append(previous[seg['id']])
            continue
        chunks, phrases, t = [], [], 0.0
        for result in pipe(text, voice=voice, speed=args.speed):
            audio = result.audio.numpy() if hasattr(result.audio, 'numpy') else np.asarray(result.audio)
            dur = len(audio) / 24000
            phrases.append({'start_s': round(t, 3), 'end_s': round(t + dur, 3), 'text': written(result.graphemes)})
            chunks.append(audio)
            t += dur
        audio = np.concatenate(chunks)
        sf.write(wav, audio, 24000)
        rows.append({'id': seg['id'], 'key': key, 'duration_s': round(len(audio) / 24000, 3), 'phrases': phrases, 'text': written(text)})
        print(f"{seg['id']}: {rows[-1]['duration_s']:.1f} s", flush=True)
    index_path.write_text(json.dumps({'schema_version': 1, 'voice': voice, 'segments': rows}, indent=1))
    print(f"total narration {sum(r['duration_s'] for r in rows):.1f} s")


if __name__ == '__main__':
    main()
