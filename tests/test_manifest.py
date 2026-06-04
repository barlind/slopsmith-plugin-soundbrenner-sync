import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_manifest_declares_capability_008_playback_contract():
    manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))

    assert "capability-pipelines.v1" in manifest["standards"]
    assert "plugin-runtime-idempotent.v1" in manifest["standards"]

    playback = manifest["capabilities"]["playback"]
    assert playback["roles"] == ["observer"]
    assert playback["kind"] == "event"
    assert playback["ownership"] == "observer-only"
    assert playback["compatibility"] == "shim-allowed"
    assert playback["safety"] == "safe"
    assert playback["version"] == 1
    assert set(playback["observes"]) >= {
        "loading",
        "ready",
        "started",
        "resumed",
        "paused",
        "stopped",
        "ended",
        "seeked",
    }

    assert "playback" not in manifest.get("runtime_domains", {})


def test_manifest_keeps_tempo_clock_as_reserved_future_domain():
    manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))

    tempo_clock = manifest["runtime_domains"]["tempo-clock"]
    assert tempo_clock["roles"] == ["provider"]
    assert tempo_clock["mode"] == "optional"
    assert tempo_clock["compatibility"] == "degrade-noop"
    assert tempo_clock["ownership"] == "multi-provider"
    assert tempo_clock["safety"] == "safe"
    assert set(tempo_clock["events"]) == {"midi-clock", "transport.start", "transport.stop"}