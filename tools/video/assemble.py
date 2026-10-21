#!/usr/bin/env python3
"""Assemble the introduction video from captured segments and narration.

    python3 tools/video/assemble.py --out <dir> [--ffmpeg ffmpeg] [--name g1-deploy-studio-intro]

Inputs: tools/video/storyboard.json, <dir>/narration.json, <dir>/audio/<id>.wav, <dir>/segments/<id>.mp4.
Outputs in <dir>: <name>.mp4 (H.264 + AAC, soft English subtitles), <name>.srt, chapters.txt.
Each segment's narration starts 0.25 s into the segment; segment lengths come from capture.mjs.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEAD_S = 0.25


def probe_duration(ffprobe, path):
    out = subprocess.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         check=True, capture_output=True, text=True).stdout
    return float(out.strip())


def split_cue(start, end, text, max_chars=84):
    """Split one narration phrase into readable cues; time is shared in proportion to text length."""
    import re
    parts = [x.strip() for x in re.split(r'(?<=[.!?;:])\s+', text.strip()) if x.strip()]
    pieces = []
    for part in parts:
        while len(part) > max_chars:
            cut = max((part.rfind(sep, 0, max_chars) for sep in (', ', ' — ', ' and ', ' but ')), default=-1)
            cut = cut if cut > 20 else part.rfind(' ', 0, max_chars)
            pieces.append(part[:cut + 1].strip()); part = part[cut + 1:].strip()
        pieces.append(part)
    total = sum(len(x) for x in pieces) or 1
    t, cues = start, []
    for x in pieces:
        d = (end - start) * len(x) / total
        cues.append((t, t + d, x)); t += d
    return cues


def srt_time(t):
    ms = int(round(t * 1000))
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--ffmpeg', default='ffmpeg')
    ap.add_argument('--name', default='g1-deploy-studio-intro')
    args = ap.parse_args()
    out = Path(args.out)
    ffprobe = str(Path(args.ffmpeg).with_name('ffprobe')) if '/' in args.ffmpeg else 'ffprobe'
    board = json.loads((ROOT / 'tools/video/storyboard.json').read_text())
    narration = {s['id']: s for s in json.loads((out / 'narration.json').read_text())['segments']}
    chapters_by_id = {'title': 'Introduction', 'chain': 'Why: the deployment chain', 'architecture': 'Design',
                      'ch-tour': 'The cockpit', 'arena': 'Arena and rehearsal', 'ch-results': 'What we learned',
                      'ch-navigate': 'Deploying to a real room: Navigate',
                      'validation': 'Evidence and safety', 'roadmap': 'Next steps'}

    t, cues, filters, inputs, chapters = 0.0, [], [], [], []
    concat = tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False)
    for seg in board['segments']:
        video = out / 'segments' / f"{seg['id']}.mp4"
        if not video.exists():
            raise SystemExit(f'missing segment {video}; run capture.mjs first')
        concat.write(f"file '{video}'\n")
        dur = probe_duration(ffprobe, video)
        if seg['id'] in chapters_by_id:
            chapters.append((t, chapters_by_id[seg['id']]))
        n = narration.get(seg['id'])
        wav = out / 'audio' / f"{seg['id']}.wav"
        if n and n.get('duration_s') and wav.exists():
            idx = len(inputs) // 2 + 1  # input 0 is the concatenated video; each audio adds ('-i', path)
            inputs += ['-i', str(wav)]
            delay = int(round((t + LEAD_S) * 1000))
            filters.append(f'[{idx}:a]adelay={delay}:all=1[a{idx}]')
            for p in n['phrases']:
                cues += split_cue(t + LEAD_S + p['start_s'], t + LEAD_S + p['end_s'], p['text'])
        t += dur
    concat.close()
    total = t

    srt = out / f'{args.name}.srt'
    srt.write_text(''.join(f'{i}\n{srt_time(a)} --> {srt_time(b)}\n{text.strip()}\n\n' for i, (a, b, text) in enumerate(cues, 1)))
    (out / 'chapters.txt').write_text(''.join(f'{int(a) // 60:02d}:{int(a) % 60:02d} {name}\n' for a, name in chapters))

    labels = ''.join(f'[a{i + 1}]' for i in range(len(filters)))  # one [aN] per audio input, N = 1..len
    mix = ';'.join(filters) + f';{labels}amix=inputs={len(filters)}:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]'
    final = out / f'{args.name}.mp4'
    cmd = [args.ffmpeg, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat.name, *inputs, '-i', str(srt),
           '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-map', f'{len(filters) + 1}:s',
           '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-tune', 'animation', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '160k', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
           '-t', f'{total:.3f}', '-movflags', '+faststart', '-metadata', 'title=G1 Deploy Studio · introduction', str(final)]
    subprocess.run(cmd, check=True)
    print(json.dumps({'video': str(final), 'srt': str(srt), 'duration_s': round(total, 2),
                      'bytes': final.stat().st_size, 'chapters': len(chapters), 'cues': len(cues)}))


if __name__ == '__main__':
    main()
