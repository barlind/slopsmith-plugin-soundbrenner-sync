#!/usr/bin/env python3
"""Build a Sloppak calibration song from annotated guitar datasets."""

from __future__ import annotations

import argparse
import bisect
import json
import math
import shutil
import subprocess
import tempfile
import wave
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET


STANDARD_MIDI_TUNING = [40, 45, 50, 55, 59, 64]
DEFAULT_IDMT_CLIPS = [
    "FS_Lick4_MBSH",
    "AR_Lick10_KN",
    "LP_Lick3_MN",
    "FS_G_V_slide",
]


@dataclass
class Clip:
    dataset: str
    clip_id: str
    audio_path: Path
    annotation_path: Path
    duration: float
    notes: list[dict]
    beats: list[dict] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\n{result.stderr.strip()}")


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / float(handle.getframerate())


def _text(parent: ET.Element, name: str, default: str = "") -> str:
    elem = parent.find(name)
    if elem is None or elem.text is None:
        return default
    return elem.text.strip()


def _float_text(parent: ET.Element, name: str, default: float = 0.0) -> float:
    try:
        return float(_text(parent, name, str(default)))
    except ValueError:
        return default


def _int_text(parent: ET.Element, name: str, default: int = 0) -> int:
    try:
        return int(float(_text(parent, name, str(default))))
    except ValueError:
        return default


def _idmt_audio_path(dataset2_dir: Path, global_params: ET.Element, xml_path: Path) -> Path:
    raw = _text(global_params, "audioFileName", f"{xml_path.stem}.wav")
    audio_name = raw.replace("\\", "/").split("/")[-1]
    audio_path = dataset2_dir / "audio" / audio_name
    if not audio_path.exists():
        raise FileNotFoundError(f"missing IDMT audio for {xml_path.name}: {audio_path}")
    return audio_path


def _idmt_note(event: ET.Element) -> dict | None:
    onset = _float_text(event, "onsetSec")
    offset = _float_text(event, "offsetSec", onset)
    string_number = _int_text(event, "stringNumber", 1)
    fret = _int_text(event, "fretNumber", 0)
    if string_number < 1 or string_number > 6 or fret < 0:
        return None

    expression = _text(event, "expressionStyle", "NO").upper()
    slide_to = -1
    if expression == "SL":
        semitone_range = int(round(_float_text(event, "modulationFrequencyRange") / 100.0))
        target_fret = fret + semitone_range
        if 0 <= target_fret <= 24 and target_fret != fret:
            slide_to = target_fret
    note = {
        "t": round(onset, 3),
        "s": string_number - 1,
        "f": fret,
        "sus": round(max(0.0, offset - onset), 3),
        "sl": slide_to,
        "slu": -1,
        "bn": 0,
        "ho": expression == "HO",
        "po": expression == "PO",
        "hm": expression in {"NH", "HA"},
        "hp": False,
        "pm": False,
        "mt": False,
        "tr": expression in {"TR", "VI"},
        "ac": False,
        "tp": False,
    }
    if expression == "BE":
        note["bn"] = 1.0
    return note


def load_idmt_clip(dataset2_dir: Path, clip_id: str) -> Clip:
    annotation_path = dataset2_dir / "annotation" / f"{clip_id}.xml"
    if not annotation_path.exists():
        raise FileNotFoundError(f"IDMT annotation not found: {annotation_path}")

    root = ET.parse(annotation_path).getroot()
    global_params = root.find("globalParameter")
    transcription = root.find("transcription")
    if global_params is None or transcription is None:
        raise ValueError(f"not an IDMT annotation file: {annotation_path}")

    audio_path = _idmt_audio_path(dataset2_dir, global_params, annotation_path)
    notes = []
    technique_counts: dict[str, int] = {}
    for event in transcription.findall("event"):
        note = _idmt_note(event)
        if note is not None:
            notes.append(note)
        expression = _text(event, "expressionStyle", "NO").upper()
        technique_counts[expression] = technique_counts.get(expression, 0) + 1

    metadata = {
        "instrument": _text(global_params, "instrument"),
        "instrument_model": _text(global_params, "instrumentModel"),
        "recording_artist": _text(global_params, "recordingArtist"),
        "composer": _text(global_params, "composer"),
        "techniques": technique_counts,
    }
    return Clip(
        dataset="IDMT-SMT-GUITAR_V2 dataset2",
        clip_id=clip_id,
        audio_path=audio_path,
        annotation_path=annotation_path,
        duration=_wav_duration(audio_path),
        notes=sorted(notes, key=lambda item: item["t"]),
        metadata=metadata,
    )


def _find_guitarset_audio(audio_root: Path, stem: str) -> Path:
    exact_names = [
        f"{stem}.wav",
        f"{stem}_mic.wav",
        f"{stem}_hex.wav",
        f"{stem}_hex_cln.wav",
        f"{stem}_mix.wav",
    ]
    for name in exact_names:
        matches = list(audio_root.rglob(name))
        if matches:
            return matches[0]
    matches = sorted(audio_root.rglob(f"{stem}*.wav"))
    if matches:
        return matches[0]
    raise FileNotFoundError(f"no GuitarSet audio matching {stem!r} under {audio_root}")


def _guitarset_string_notes(annotation: dict) -> tuple[int | None, list[dict]]:
    data = annotation.get("data")
    if not isinstance(data, list) or not data:
        return None, []
    values = [float(item.get("value", 0)) for item in data if isinstance(item, dict)]
    if not values:
        return None, []
    median_pitch = sorted(values)[len(values) // 2]
    string_index = min(
        range(6),
        key=lambda idx: abs(median_pitch - STANDARD_MIDI_TUNING[idx]),
    )
    notes = []
    for item in data:
        if not isinstance(item, dict):
            continue
        pitch = float(item.get("value", 0))
        fret = int(round(pitch - STANDARD_MIDI_TUNING[string_index]))
        if fret < 0 or fret > 24:
            continue
        notes.append({
            "t": round(float(item.get("time", 0)), 3),
            "s": string_index,
            "f": fret,
            "sus": round(max(0.0, float(item.get("duration", 0))), 3),
            "sl": -1,
            "slu": -1,
            "bn": 0,
            "ho": False,
            "po": False,
            "hm": False,
            "hp": False,
            "pm": False,
            "mt": False,
            "tr": False,
            "ac": False,
            "tp": False,
        })
    return string_index, notes


def _guitarset_beats(annotation: dict) -> list[dict]:
    beats = []
    data = annotation.get("data")
    if not isinstance(data, list):
        return beats
    for item in data:
        if not isinstance(item, dict):
            continue
        value = item.get("value") or {}
        if not isinstance(value, dict):
            value = {}
        position = int(value.get("position", 0) or 0)
        measure = int(value.get("measure", 0) or 0) if position == 1 else -1
        beats.append({"time": round(float(item.get("time", 0)), 3), "measure": measure})
    return beats


def _build_subdivision_grid(beats: list[dict], subdivisions: int = 4) -> list[float]:
    if len(beats) < 2:
        return [float(b.get("time", 0)) for b in beats]
    times = [float(b["time"]) for b in beats]
    grid: list[float] = []
    for index in range(len(times) - 1):
        start, end = times[index], times[index + 1]
        step = (end - start) / max(1, subdivisions)
        for k in range(subdivisions):
            grid.append(start + k * step)
    grid.append(times[-1])
    return sorted(grid)


def _nearest_grid_time(time_value: float, grid: list[float]) -> float:
    pos = bisect.bisect_left(grid, time_value)
    candidates: list[float] = []
    if pos < len(grid):
        candidates.append(grid[pos])
    if pos > 0:
        candidates.append(grid[pos - 1])
    if not candidates:
        return time_value
    return min(candidates, key=lambda value: abs(value - time_value))


def _quantize_notes_to_beats(notes: list[dict], beats: list[dict], subdivisions: int = 4, max_shift_sec: float = 0.09) -> tuple[list[dict], dict]:
    if not notes or len(beats) < 2:
        return notes, {"applied": False, "shifted_notes": 0, "median_shift_ms": 0.0}

    grid = _build_subdivision_grid(beats, subdivisions=subdivisions)
    shifts_ms: list[float] = []
    shifted_count = 0
    quantized: list[dict] = []
    for note in notes:
        time_value = float(note.get("t", 0.0))
        target = _nearest_grid_time(time_value, grid)
        shift = target - time_value
        updated = dict(note)
        if abs(shift) <= max_shift_sec:
            updated["t"] = round(target, 3)
            shifted_count += 1
            shifts_ms.append(shift * 1000.0)
        else:
            updated["t"] = round(time_value, 3)
        quantized.append(updated)

    median_shift = 0.0
    if shifts_ms:
        shifts_ms_sorted = sorted(shifts_ms)
        median_shift = shifts_ms_sorted[len(shifts_ms_sorted) // 2]
    return sorted(quantized, key=lambda item: item["t"]), {
        "applied": True,
        "shifted_notes": shifted_count,
        "median_shift_ms": round(median_shift, 3),
        "subdivisions": subdivisions,
        "max_shift_ms": round(max_shift_sec * 1000.0, 3),
    }


def load_guitarset_clip(annotation_dir: Path, audio_root: Path, clip_id: str) -> Clip:
    stem = clip_id[:-5] if clip_id.endswith(".jams") else clip_id
    annotation_path = annotation_dir / f"{stem}.jams"
    if not annotation_path.exists():
        raise FileNotFoundError(f"GuitarSet annotation not found: {annotation_path}")

    data = json.loads(annotation_path.read_text(encoding="utf-8"))
    notes: list[dict] = []
    beats: list[dict] = []
    tempos: list[float] = []
    chords: list[dict] = []
    key_modes: list[str] = []
    for annotation in data.get("annotations", []) or []:
        namespace = annotation.get("namespace")
        if namespace == "note_midi":
            _, string_notes = _guitarset_string_notes(annotation)
            notes.extend(string_notes)
        elif namespace == "beat_position" and not beats:
            beats = _guitarset_beats(annotation)
        elif namespace == "tempo":
            for item in annotation.get("data", []) or []:
                if isinstance(item, dict):
                    tempos.append(float(item.get("value", 0)))
        elif namespace == "chord":
            chords.extend(annotation.get("data", []) or [])
        elif namespace == "key_mode":
            for item in annotation.get("data", []) or []:
                if isinstance(item, dict):
                    key_modes.append(str(item.get("value", "")))

    audio_path = _find_guitarset_audio(audio_root, stem)
    duration = float(data.get("file_metadata", {}).get("duration") or _wav_duration(audio_path))
    quantized_notes, quantize_meta = _quantize_notes_to_beats(notes, beats, subdivisions=4, max_shift_sec=0.09)
    metadata = {
        "tempo": tempos[0] if tempos else None,
        "key_mode": key_modes[0] if key_modes else None,
        "chords": chords[:32],
        "quantization": quantize_meta,
    }
    return Clip(
        dataset="GuitarSet",
        clip_id=stem,
        audio_path=audio_path,
        annotation_path=annotation_path,
        duration=duration,
        notes=quantized_notes,
        beats=sorted(beats, key=lambda item: item["time"]),
        metadata=metadata,
    )


def _offset_note(note: dict, offset: float) -> dict:
    shifted = dict(note)
    shifted["t"] = round(float(shifted.get("t", 0)) + offset, 3)
    return shifted


def _generated_beats(start: float, duration: float, bpm: float, measure_start: int) -> tuple[list[dict], int]:
    interval = 60.0 / max(1.0, bpm)
    count = int(math.floor(duration / interval)) + 1
    beats = []
    measure = measure_start
    for index in range(count):
        is_downbeat = index % 4 == 0
        beats.append({
            "time": round(start + index * interval, 3),
            "measure": measure if is_downbeat else -1,
        })
        if is_downbeat:
            measure += 1
    return beats, measure


def _compute_anchors(notes: list[dict]) -> list[dict]:
    fretted = sorted(
        (float(note["t"]), int(note["f"]))
        for note in notes
        if int(note.get("f", 0)) > 0
    )
    if not fretted:
        return [{"time": 0.0, "fret": 1, "width": 4}]

    anchors = [{"time": 0.0, "fret": max(1, fretted[0][1] - 1), "width": 4}]
    for time_value, fret in fretted:
        current = anchors[-1]
        if fret < current["fret"] or fret > current["fret"] + current["width"]:
            next_fret = max(1, fret - 1)
            if next_fret != current["fret"]:
                anchors.append({"time": round(time_value, 3), "fret": next_fret, "width": 4})
    return anchors


def _concat_escape(path: Path) -> str:
    return str(path).replace("'", "'\\''")


def _encode_ogg(wav_path: Path, output_path: Path) -> None:
    last_error: RuntimeError | None = None
    for encoder, extra_args in (("libvorbis", []), ("vorbis", ["-strict", "-2"])):
        try:
            _run([
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(wav_path), "-c:a", encoder, "-q:a", "6",
                *extra_args, str(output_path),
            ])
            return
        except RuntimeError as exc:
            last_error = exc
    if last_error is not None:
        raise last_error


def _encode_audio(
    clips: list[Clip],
    work_dir: Path,
    output_path: Path,
    gap_sec: float,
    lead_in_sec: float,
) -> float:
    segments_dir = work_dir / "segments"
    segments_dir.mkdir(parents=True, exist_ok=True)
    concat_entries: list[Path] = []
    total = 0.0
    if lead_in_sec > 0:
        lead_in_path = segments_dir / "lead-in.wav"
        _run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-t", f"{lead_in_sec:.3f}", str(lead_in_path),
        ])
        concat_entries.append(lead_in_path)
        total += lead_in_sec
    for index, clip in enumerate(clips):
        segment_path = segments_dir / f"clip-{index:03d}.wav"
        _run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(clip.audio_path),
            "-ar", "44100", "-ac", "2", str(segment_path),
        ])
        concat_entries.append(segment_path)
        total += clip.duration
        if gap_sec > 0 and index != len(clips) - 1:
            silence_path = segments_dir / f"gap-{index:03d}.wav"
            _run([
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-t", f"{gap_sec:.3f}", str(silence_path),
            ])
            concat_entries.append(silence_path)
            total += gap_sec

    concat_file = work_dir / "concat.txt"
    concat_file.write_text(
        "".join(f"file '{_concat_escape(path)}'\n" for path in concat_entries),
        encoding="utf-8",
    )
    wav_path = work_dir / "full.wav"
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-c", "copy", str(wav_path),
    ])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _encode_ogg(wav_path, output_path)
    return total


def _yaml_scalar(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def _write_manifest(path: Path, manifest: dict) -> None:
    lines: list[str] = []
    for key in ["title", "artist", "album", "year", "duration", "source_sections"]:
        if key in manifest:
            lines.append(f"{key}: {_yaml_scalar(manifest[key])}")
    lines.append("stems:")
    for stem in manifest["stems"]:
        lines.append(f"  - id: {_yaml_scalar(stem['id'])}")
        lines.append(f"    file: {_yaml_scalar(stem['file'])}")
        lines.append(f"    default: {_yaml_scalar(stem.get('default', True))}")
    lines.append("arrangements:")
    for arrangement in manifest["arrangements"]:
        lines.append(f"  - id: {_yaml_scalar(arrangement['id'])}")
        lines.append(f"    name: {_yaml_scalar(arrangement['name'])}")
        lines.append(f"    file: {_yaml_scalar(arrangement['file'])}")
        lines.append(f"    tuning: {json.dumps(arrangement['tuning'])}")
        lines.append(f"    capo: {int(arrangement.get('capo', 0))}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _pack_sloppak(work_dir: Path, out_path: Path, as_dir: bool) -> None:
    if as_dir:
        if out_path.exists():
            shutil.rmtree(out_path)
        shutil.copytree(work_dir, out_path)
        return
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file_path in work_dir.rglob("*"):
            if file_path.is_file():
                archive.write(file_path, file_path.relative_to(work_dir).as_posix())


def _lead_in_timing(clips: list[Clip], fallback_bpm: float, lead_in_bars: float) -> tuple[float, float]:
    if lead_in_bars <= 0:
        return 0.0, 0.0

    beat_interval = 60.0 / max(1.0, fallback_bpm)
    first_clip = clips[0] if clips else None
    if first_clip and len(first_clip.beats) >= 2:
        first = float(first_clip.beats[0].get("time", 0.0))
        second = float(first_clip.beats[1].get("time", first))
        delta = second - first
        if delta > 0:
            beat_interval = delta

    lead_in_sec = beat_interval * 4.0 * lead_in_bars
    return lead_in_sec, beat_interval


def build_sloppak(
    clips: list[Clip],
    out_path: Path,
    title: str,
    gap_sec: float,
    bpm: float,
    as_dir: bool,
    lead_in_bars: float,
) -> None:
    if not clips:
        raise ValueError("no clips selected")

    tmp_dir = Path(tempfile.mkdtemp(prefix="soundbrenner_dataset_sloppak_"))
    try:
        work_dir = tmp_dir / "work"
        (work_dir / "arrangements").mkdir(parents=True)
        (work_dir / "stems").mkdir(parents=True)

        notes: list[dict] = []
        beats: list[dict] = []
        sections: list[dict] = []
        source_sections: list[dict] = []
        lead_in_sec, lead_in_beat_interval = _lead_in_timing(clips, bpm, lead_in_bars)
        offset = lead_in_sec
        next_measure = 1

        if lead_in_sec > 0 and lead_in_beat_interval > 0:
            count_in_beats = max(1, int(round(4 * lead_in_bars)))
            beats.extend(
                {
                    "time": round(index * lead_in_beat_interval, 3),
                    "measure": -1,
                }
                for index in range(count_in_beats)
            )
        for index, clip in enumerate(clips, 1):
            section_name = clip.clip_id.lower().replace("-", "_")
            sections.append({"name": section_name[:32], "number": index, "time": round(offset, 3)})
            notes.extend(_offset_note(note, offset) for note in clip.notes)
            if clip.beats:
                beats.extend({
                    "time": round(float(beat["time"]) + offset, 3),
                    "measure": int(beat.get("measure", -1)),
                } for beat in clip.beats)
            else:
                generated, next_measure = _generated_beats(offset, clip.duration, bpm, next_measure)
                beats.extend(generated)
            source_sections.append({
                "index": index,
                "dataset": clip.dataset,
                "clip_id": clip.clip_id,
                "start_time": round(offset, 3),
                "duration": round(clip.duration, 3),
                "audio_file": str(clip.audio_path),
                "annotation_file": str(clip.annotation_path),
                "note_count": len(clip.notes),
                "metadata": clip.metadata,
            })
            offset += clip.duration + (gap_sec if index != len(clips) else 0.0)

        audio_duration = _encode_audio(
            clips,
            tmp_dir,
            work_dir / "stems" / "full.ogg",
            gap_sec,
            lead_in_sec,
        )
        arrangement = {
            "name": "Lead",
            "tuning": [0, 0, 0, 0, 0, 0],
            "capo": 0,
            "notes": sorted(notes, key=lambda item: item["t"]),
            "chords": [],
            "anchors": _compute_anchors(notes),
            "handshapes": [],
            "templates": [],
            "beats": sorted(beats, key=lambda item: item["time"]),
            "sections": sections,
        }
        (work_dir / "arrangements" / "lead.json").write_text(
            json.dumps(arrangement, separators=(",", ":")),
            encoding="utf-8",
        )
        (work_dir / "source_sections.json").write_text(
            json.dumps(source_sections, indent=2),
            encoding="utf-8",
        )
        manifest = {
            "title": title,
            "artist": "Slopsmith Calibration",
            "album": "Soundbrenner Dataset POC",
            "year": 2026,
            "duration": round(audio_duration, 3),
            "source_sections": "source_sections.json",
            "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
            "arrangements": [{
                "id": "lead",
                "name": "Lead",
                "file": "arrangements/lead.json",
                "tuning": [0, 0, 0, 0, 0, 0],
                "capo": 0,
            }],
        }
        _write_manifest(work_dir / "manifest.yaml", manifest)
        _pack_sloppak(work_dir, out_path, as_dir)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _load_clips(args: argparse.Namespace) -> list[Clip]:
    if args.source == "idmt":
        dataset2_dir = args.dataset2_dir.resolve()
        clip_ids = args.clips or DEFAULT_IDMT_CLIPS
        return [load_idmt_clip(dataset2_dir, clip_id) for clip_id in clip_ids[:args.limit or None]]
    annotation_dir = args.annotation_dir.resolve()
    audio_root = args.audio_root.resolve()
    clip_ids = args.clips or [
        "00_Rock1-130-A_comp",
        "00_Funk1-114-Ab_comp",
        "00_SS1-100-C#_comp",
    ]
    return [load_guitarset_clip(annotation_dir, audio_root, clip_id) for clip_id in clip_ids[:args.limit or None]]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="source", required=True)

    idmt = subparsers.add_parser("idmt", help="Build from IDMT-SMT-GUITAR_V2 dataset2 XML/WAV clips")
    idmt.add_argument("--dataset2-dir", type=Path, required=True)
    idmt.add_argument("--clips", nargs="*", help="Clip stems such as FS_Lick4_MBSH")
    idmt.add_argument("--limit", type=int, default=0)
    idmt.add_argument("--bpm", type=float, default=120.0, help="Beat-map BPM for IDMT clips")
    idmt.add_argument("--gap-sec", type=float, default=1.0)
    idmt.add_argument("--lead-in-bars", type=float, default=1.0, help="Count-in bars of silence+beats before first section")
    idmt.add_argument("--title", default="IDMT Guitar Calibration")
    idmt.add_argument("--out", type=Path, required=True)
    idmt.add_argument("--as-dir", action="store_true", help="Write directory form instead of zipped .sloppak")

    guitarset = subparsers.add_parser("guitarset", help="Build from GuitarSet JAMS annotations and matching WAV audio")
    guitarset.add_argument("--annotation-dir", type=Path, required=True)
    guitarset.add_argument("--audio-root", type=Path, required=True)
    guitarset.add_argument("--clips", nargs="*", help="JAMS stems such as 00_Rock1-130-A_comp")
    guitarset.add_argument("--limit", type=int, default=0)
    guitarset.add_argument("--bpm", type=float, default=120.0, help="Fallback BPM if a GuitarSet clip has no beat_position")
    guitarset.add_argument("--gap-sec", type=float, default=1.0)
    guitarset.add_argument("--lead-in-bars", type=float, default=1.0, help="Count-in bars of silence+beats before first section")
    guitarset.add_argument("--title", default="GuitarSet Calibration")
    guitarset.add_argument("--out", type=Path, required=True)
    guitarset.add_argument("--as-dir", action="store_true", help="Write directory form instead of zipped .sloppak")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is required to encode stems/full.ogg")
    clips = _load_clips(args)
    build_sloppak(
        clips=clips,
        out_path=args.out.resolve(),
        title=args.title,
        gap_sec=max(0.0, args.gap_sec),
        bpm=max(1.0, args.bpm),
        as_dir=args.as_dir,
        lead_in_bars=max(0.0, args.lead_in_bars),
    )
    print(f"Wrote {args.out.resolve()} from {len(clips)} clip(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())