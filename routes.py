"""Direct BLE routes for Soundbrenner Pulse/Core control.

The first control path intentionally avoids the Soundbrenner app: scan,
connect, inspect GATT, and write pulse commands from Slopsmith itself.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel

try:
    from bleak import BleakClient, BleakScanner
except Exception:  # pragma: no cover - surfaced by /status at runtime
    BleakClient = None
    BleakScanner = None


PLUGIN_ID = "soundbrenner_sync"
IMMEDIATE_ALERT_SERVICE = "00001802-0000-1000-8000-00805f9b34fb"
ALERT_LEVEL_CHAR = "00002a06-0000-1000-8000-00805f9b34fb"
NORDIC_UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NORDIC_UART_RX_CHAR = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
SOUNDBRENNER_SERVICE = "ccb2986e-1b2d-4c29-9cf8-25cdf8fe44fc"
SOUNDBRENNER_NOTIFY_CHAR = "15a08173-ac6b-4804-853a-7af4d795a8ad"
SOUNDBRENNER_WRITE_CHAR = "fbaf40a5-ccd9-4e41-88f6-ef56c0ba299d"
DEFAULT_HAPTIC_EFFECT = 19
HAPTIC_EFFECTS = [
    {"id": 19, "label": "Strong click 60 default"},
    {"id": 1, "label": "Strong click 100"},
    {"id": 2, "label": "Strong click 60"},
    {"id": 3, "label": "Strong click 30"},
    {"id": 21, "label": "Medium click 100"},
    {"id": 22, "label": "Medium click 80"},
    {"id": 23, "label": "Medium click 60"},
    {"id": 7, "label": "Soft bump 100"},
    {"id": 8, "label": "Soft bump 60"},
    {"id": 9, "label": "Soft bump 30"},
    {"id": 24, "label": "Sharp tick 100"},
    {"id": 52, "label": "Pulsing strong 100"},
    {"id": 14, "label": "Strong buzz 100"},
]


class ConnectRequest(BaseModel):
    address: str


class PulseRequest(BaseModel):
    duration_ms: int = 80
    intensity: int = 2
    mode: str = "auto"
    char_uuid: str | None = None
    on_hex: str | None = None
    off_hex: str | None = None
    response: bool = False
    effect: int = DEFAULT_HAPTIC_EFFECT


class MetronomeRequest(BaseModel):
    bpm: float | None = None
    running: bool | None = None
    beat: int | None = None
    response: bool = False


class PatternRequest(BaseModel):
    numerator: int = 4
    denominator: int = 4
    accents: list[int] | None = None
    subdivisions: list[int] | None = None
    waveforms: list[int] | None = None
    sync_beat: int | None = None
    response: bool = False


class WriteRequest(BaseModel):
    char_uuid: str
    hex: str
    response: bool = False


@dataclass
class BleState:
    client: Any | None = None
    address: str | None = None
    name: str | None = None
    services: list[dict[str, Any]] = field(default_factory=list)
    recommended: dict[str, Any] | None = None
    last_scan: list[dict[str, Any]] = field(default_factory=list)
    last_error: str | None = None
    last_pulse_at: float | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


STATE = BleState()


def _ble_available() -> bool:
    return BleakClient is not None and BleakScanner is not None


def _norm_uuid(uuid: str | None) -> str:
    return str(uuid or "").lower()


def _hex_to_bytes(value: str | None) -> bytes:
    raw = "".join(ch for ch in str(value or "") if ch not in " \n\r\t:-")
    if not raw:
        return b""
    if len(raw) % 2:
        raise HTTPException(status_code=400, detail="Hex payload must contain an even number of digits")
    try:
        return bytes.fromhex(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid hex payload") from exc


def _soundbrenner_write_char() -> str:
    recommended = STATE.recommended or {}
    if recommended.get("mode") == "soundbrenner_pulse" and recommended.get("char_uuid"):
        return str(recommended["char_uuid"])
    return SOUNDBRENNER_WRITE_CHAR


def _soundbrenner_bpm_payload(bpm: float) -> bytes:
    value = max(1, min(int(round(float(bpm))), 999))
    return bytes([0x01, 0x00, 0x02, (value & 0xFF00) >> 8, value & 0xFF, 0x00])


def _soundbrenner_play_payload(running: bool, beat: int | None = None) -> bytes:
    if running and beat is not None:
        value = _clamp_int(beat, 0, 0, 0xFFFFFF)
        return bytes([
            0x01,
            0x00,
            0x01,
            0x01,
            value & 0xFF,
            (value >> 8) & 0xFF,
            (value >> 16) & 0xFF,
        ])
    return bytes([0x01, 0x00, 0x01, 0x01 if running else 0x00])


def _clamp_haptic_effect(effect: int | None) -> int:
    return max(1, min(int(effect or DEFAULT_HAPTIC_EFFECT), 124))


def _soundbrenner_haptic_preview_payload(duration_ms: int, effect: int = DEFAULT_HAPTIC_EFFECT) -> bytes:
    duration = max(20, min(int(duration_ms or 80), 2000))
    effect_id = _clamp_haptic_effect(effect)
    return bytes([0x01, 0x00, 0x1F, effect_id & 0xFF, 0x00, (duration & 0xFF00) >> 8, duration & 0xFF])


def _clamp_int(value: int | None, fallback: int, min_value: int, max_value: int) -> int:
    try:
        parsed = int(value if value is not None else fallback)
    except (TypeError, ValueError):
        parsed = fallback
    return max(min_value, min(parsed, max_value))


def _soundbrenner_signature_header(numerator: int, denominator: int) -> int:
    return (((numerator - 1) & 0x0F) << 4) | (denominator & 0x0F)


def _soundbrenner_time_signature_payload(numerator: int, denominator: int) -> bytes:
    return bytes([0x01, 0x00, 0xCF, _soundbrenner_signature_header(numerator, denominator)])


def _normalized_pattern_values(values: list[int] | None, length: int, fallback: int, max_value: int) -> list[int]:
    source = values or []
    out = []
    for index in range(length):
        value = source[index] if index < len(source) else fallback
        out.append(_clamp_int(value, fallback, 0, max_value))
    return out


def _soundbrenner_accent_array_payload(numerator: int, denominator: int, accents: list[int] | None) -> bytes:
    values = _normalized_pattern_values(accents, numerator, 0, 3)
    payload = bytearray([0x01, 0x00, 0xAF, 0x00, _soundbrenner_signature_header(numerator, denominator)])
    payload.extend([0x00] * ((numerator + 1) // 2))
    for index, value in enumerate(values):
        payload[5 + (index // 4)] |= (value & 0x03) << (6 - ((index % 4) * 2))
    return bytes(payload)


def _soundbrenner_subdivision_payload(numerator: int, denominator: int, subdivisions: list[int] | None) -> bytes:
    values = _normalized_pattern_values(subdivisions, numerator, 1, 15)
    payload = bytearray([0x01, 0x00, 0xBF, _soundbrenner_signature_header(numerator, denominator)])
    payload.extend([0x00] * ((numerator + 1) // 2))
    for index, value in enumerate(values):
        payload[4 + (index // 2)] |= (value & 0x0F) << (4 - ((index % 2) * 4))
    return bytes(payload)


def _soundbrenner_waveforms_payload(waveforms: list[int] | None) -> bytes:
    values = _normalized_pattern_values(waveforms, 3, DEFAULT_HAPTIC_EFFECT, 124)
    return bytes([0x01, 0x00, 0x07, values[0] & 0xFF, values[1] & 0xFF, values[2] & 0xFF, values[0] & 0xFF])


def _soundbrenner_sync_beat_payload(beat: int) -> bytes:
    return bytes([0x01, 0x00, 0x2F, _clamp_int(beat, 0, 0, 255)])


def _props(char: Any) -> list[str]:
    return list(getattr(char, "properties", None) or [])


def _is_writable(char: Any) -> bool:
    props = set(_props(char))
    return "write" in props or "write-without-response" in props


def _device_dict(device: Any, adv: Any | None = None) -> dict[str, Any]:
    name = getattr(device, "name", None) or getattr(adv, "local_name", None) or ""
    uuids = list(getattr(adv, "service_uuids", None) or [])
    score = 0
    haystack = f"{name} {' '.join(uuids)}".lower()
    for token in ("soundbrenner", "pulse", "core", "spark"):
        if token in haystack:
            score += 10
    return {
        "address": getattr(device, "address", ""),
        "name": name or "Unknown",
        "rssi": getattr(device, "rssi", None) or getattr(adv, "rssi", None),
        "service_uuids": uuids,
        "likely_soundbrenner": score > 0,
        "score": score,
    }


def _services_snapshot(client: Any) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    services = []
    recommended = None
    for service in client.services:
        service_uuid = _norm_uuid(service.uuid)
        chars = []
        for char in service.characteristics:
            char_uuid = _norm_uuid(char.uuid)
            props = _props(char)
            item = {
                "uuid": char_uuid,
                "description": getattr(char, "description", "") or "",
                "properties": props,
            }
            chars.append(item)
            if char_uuid == ALERT_LEVEL_CHAR and _is_writable(char):
                recommended = {
                    "mode": "immediate_alert",
                    "char_uuid": char_uuid,
                    "label": "Immediate Alert",
                    "service_uuid": service_uuid,
                }
            elif (
                recommended is None
                and service_uuid == NORDIC_UART_SERVICE
                and char_uuid == NORDIC_UART_RX_CHAR
                and _is_writable(char)
            ):
                recommended = {
                    "mode": "nordic_uart",
                    "char_uuid": char_uuid,
                    "label": "Nordic UART write characteristic",
                    "service_uuid": service_uuid,
                }
            elif (
                recommended is None
                and service_uuid == SOUNDBRENNER_SERVICE
                and char_uuid == SOUNDBRENNER_WRITE_CHAR
                and _is_writable(char)
            ):
                recommended = {
                    "mode": "soundbrenner_pulse",
                    "char_uuid": char_uuid,
                    "label": "Soundbrenner Pulse protocol",
                    "service_uuid": service_uuid,
                }
        services.append({
            "uuid": service_uuid,
            "description": getattr(service, "description", "") or "",
            "characteristics": chars,
        })
    return services, recommended


async def _ensure_connected() -> Any:
    client = STATE.client
    if client is None:
        raise HTTPException(status_code=409, detail="No BLE device connected")
    if not client.is_connected:
        raise HTTPException(status_code=409, detail="BLE device disconnected")
    return client


async def _write_then_optional_off(
    client: Any,
    char_uuid: str,
    on_payload: bytes,
    off_payload: bytes | None,
    duration_ms: int,
    response: bool,
) -> None:
    await client.write_gatt_char(char_uuid, on_payload, response=response)
    if off_payload is None:
        return

    async def _off_later() -> None:
        try:
            await asyncio.sleep(max(20, min(duration_ms, 2000)) / 1000)
            if client.is_connected:
                await client.write_gatt_char(char_uuid, off_payload, response=response)
        except Exception as exc:
            STATE.last_error = str(exc)

    asyncio.create_task(_off_later())


async def _pulse(req: PulseRequest) -> dict[str, Any]:
    async with STATE.lock:
        client = await _ensure_connected()
        duration_ms = max(20, min(int(req.duration_ms or 80), 2000))
        intensity = max(0, min(int(req.intensity or 2), 2))
        mode = (req.mode or "auto").lower()

        if mode == "auto":
            mode = (STATE.recommended or {}).get("mode") or "immediate_alert"

        if mode == "immediate_alert":
            char_uuid = ALERT_LEVEL_CHAR
            on_payload = bytes([intensity or 2])
            off_payload = b"\x00"
            response = bool(req.response)
        elif mode in ("custom", "nordic_uart"):
            if not req.char_uuid:
                raise HTTPException(status_code=400, detail="Custom BLE pulse needs char_uuid")
            char_uuid = req.char_uuid
            on_payload = _hex_to_bytes(req.on_hex)
            if not on_payload:
                raise HTTPException(status_code=400, detail="Custom BLE pulse needs on_hex")
            off_payload = _hex_to_bytes(req.off_hex) if req.off_hex else None
            response = bool(req.response)
        elif mode == "soundbrenner_pulse":
            char_uuid = req.char_uuid or _soundbrenner_write_char()
            on_payload = _soundbrenner_haptic_preview_payload(duration_ms, req.effect)
            off_payload = None
            response = bool(req.response)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown pulse mode: {req.mode}")

        try:
            await _write_then_optional_off(client, char_uuid, on_payload, off_payload, duration_ms, response)
        except Exception as exc:
            STATE.last_error = str(exc)
            raise HTTPException(status_code=500, detail=f"BLE pulse failed: {exc}") from exc

        STATE.last_pulse_at = time.time()
        STATE.last_error = None
        return {"ok": True, "mode": mode, "char_uuid": char_uuid, "duration_ms": duration_ms}


async def _metronome(req: MetronomeRequest) -> dict[str, Any]:
    async with STATE.lock:
        client = await _ensure_connected()
        char_uuid = _soundbrenner_write_char()
        writes = []
        try:
            if req.bpm is not None:
                payload = _soundbrenner_bpm_payload(req.bpm)
                await client.write_gatt_char(char_uuid, payload, response=bool(req.response))
                writes.append({"kind": "bpm", "bpm": max(1, min(int(round(float(req.bpm))), 999))})
            if req.running is not None:
                beat = _clamp_int(req.beat, 0, 0, 0xFFFFFF) if bool(req.running) and req.beat is not None else None
                payload = _soundbrenner_play_payload(bool(req.running), beat)
                await client.write_gatt_char(char_uuid, payload, response=bool(req.response))
                writes.append({"kind": "running", "running": bool(req.running), "beat": beat})
        except Exception as exc:
            STATE.last_error = str(exc)
            raise HTTPException(status_code=500, detail=f"Soundbrenner metronome command failed: {exc}") from exc

        STATE.last_pulse_at = time.time()
        STATE.last_error = None
        return {"ok": True, "mode": "soundbrenner_pulse", "char_uuid": char_uuid, "writes": writes}


async def _pattern(req: PatternRequest) -> dict[str, Any]:
    async with STATE.lock:
        client = await _ensure_connected()
        char_uuid = _soundbrenner_write_char()
        numerator = _clamp_int(req.numerator, 4, 1, 16)
        denominator = _clamp_int(req.denominator, 4, 1, 15)
        writes = []

        async def write(kind: str, payload: bytes, **meta: Any) -> None:
            await client.write_gatt_char(char_uuid, payload, response=bool(req.response))
            writes.append({"kind": kind, "hex": payload.hex(" "), **meta})

        try:
            if req.waveforms is not None:
                waveforms = _normalized_pattern_values(req.waveforms, 3, DEFAULT_HAPTIC_EFFECT, 124)
                await write("waveforms", _soundbrenner_waveforms_payload(waveforms), waveforms=waveforms)
            await write("time_signature", _soundbrenner_time_signature_payload(numerator, denominator), numerator=numerator, denominator=denominator)
            if req.subdivisions is not None:
                subdivisions = _normalized_pattern_values(req.subdivisions, numerator, 1, 15)
                await write("subdivisions", _soundbrenner_subdivision_payload(numerator, denominator, subdivisions), subdivisions=subdivisions)
            if req.accents is not None:
                accents = _normalized_pattern_values(req.accents, numerator, 0, 3)
                await write("accents", _soundbrenner_accent_array_payload(numerator, denominator, accents), accents=accents)
            if req.sync_beat is not None:
                sync_beat = _clamp_int(req.sync_beat, 0, 0, 255)
                await write("sync_beat", _soundbrenner_sync_beat_payload(sync_beat), sync_beat=sync_beat)
        except Exception as exc:
            STATE.last_error = str(exc)
            raise HTTPException(status_code=500, detail=f"Soundbrenner pattern command failed: {exc}") from exc

        STATE.last_pulse_at = time.time()
        STATE.last_error = None
        return {"ok": True, "mode": "soundbrenner_pulse", "char_uuid": char_uuid, "writes": writes}


def setup(app, context):
    @app.get(f"/api/plugins/{PLUGIN_ID}/status")
    async def status():
        connected = bool(STATE.client and STATE.client.is_connected)
        return {
            "available": _ble_available(),
            "connected": connected,
            "address": STATE.address if connected else None,
            "name": STATE.name if connected else None,
            "recommended": STATE.recommended if connected else None,
            "last_error": STATE.last_error,
            "last_pulse_at": STATE.last_pulse_at,
        }

    @app.post(f"/api/plugins/{PLUGIN_ID}/scan")
    async def scan():
        if not _ble_available():
            raise HTTPException(status_code=500, detail="bleak is not installed")
        try:
            try:
                found = await BleakScanner.discover(timeout=5.0, return_adv=True)
                devices = [_device_dict(device, adv) for device, adv in found.values()]
            except TypeError:
                found = await BleakScanner.discover(timeout=5.0)
                devices = [_device_dict(device) for device in found]
        except Exception as exc:
            STATE.last_error = str(exc)
            raise HTTPException(status_code=500, detail=f"BLE scan failed: {exc}") from exc
        devices.sort(key=lambda item: (-item["score"], item["name"], item["address"]))
        STATE.last_scan = devices
        STATE.last_error = None
        return {"devices": devices}

    @app.post(f"/api/plugins/{PLUGIN_ID}/connect")
    async def connect(req: ConnectRequest):
        if not _ble_available():
            raise HTTPException(status_code=500, detail="bleak is not installed")
        async with STATE.lock:
            if STATE.client and STATE.client.is_connected:
                await STATE.client.disconnect()
            match = next((d for d in STATE.last_scan if d["address"] == req.address), None)
            client = BleakClient(req.address)
            try:
                await client.connect(timeout=12.0)
                if hasattr(client, "get_services"):
                    await client.get_services()
                services, recommended = _services_snapshot(client)
            except Exception as exc:
                STATE.last_error = str(exc)
                try:
                    await client.disconnect()
                except Exception:
                    pass
                raise HTTPException(status_code=500, detail=f"BLE connect failed: {exc}") from exc
            STATE.client = client
            STATE.address = req.address
            STATE.name = (match or {}).get("name") or req.address
            STATE.services = services
            STATE.recommended = recommended
            STATE.last_error = None
            return {
                "ok": True,
                "address": STATE.address,
                "name": STATE.name,
                "services": services,
                "recommended": recommended,
            }

    @app.post(f"/api/plugins/{PLUGIN_ID}/disconnect")
    async def disconnect():
        async with STATE.lock:
            if STATE.client:
                try:
                    await STATE.client.disconnect()
                finally:
                    STATE.client = None
            STATE.address = None
            STATE.name = None
            STATE.services = []
            STATE.recommended = None
            return {"ok": True}

    @app.get(f"/api/plugins/{PLUGIN_ID}/services")
    async def services():
        await _ensure_connected()
        return {"services": STATE.services, "recommended": STATE.recommended}

    @app.get(f"/api/plugins/{PLUGIN_ID}/effects")
    async def effects():
        return {"effects": HAPTIC_EFFECTS, "default": DEFAULT_HAPTIC_EFFECT}

    @app.post(f"/api/plugins/{PLUGIN_ID}/pulse")
    async def pulse(req: PulseRequest):
        return await _pulse(req)

    @app.post(f"/api/plugins/{PLUGIN_ID}/metronome")
    async def metronome(req: MetronomeRequest):
        return await _metronome(req)

    @app.post(f"/api/plugins/{PLUGIN_ID}/pattern")
    async def pattern(req: PatternRequest):
        return await _pattern(req)

    @app.post(f"/api/plugins/{PLUGIN_ID}/write")
    async def write(req: WriteRequest):
        async with STATE.lock:
            client = await _ensure_connected()
            payload = _hex_to_bytes(req.hex)
            if not payload:
                raise HTTPException(status_code=400, detail="Hex payload is empty")
            try:
                await client.write_gatt_char(req.char_uuid, payload, response=bool(req.response))
            except Exception as exc:
                STATE.last_error = str(exc)
                raise HTTPException(status_code=500, detail=f"BLE write failed: {exc}") from exc
            STATE.last_error = None
            return {"ok": True, "bytes": len(payload)}
