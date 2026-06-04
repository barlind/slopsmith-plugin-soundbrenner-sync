#!/usr/bin/env python3
"""Decode ATT writes from an Android Bluetooth HCI snoop log.

This is intentionally dependency-free and focused on the BLE write payloads we
need for reverse engineering Soundbrenner metronome pattern commands.
"""

from __future__ import annotations

import argparse
import json
import struct
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

BTSNOOP_MAGIC = b"btsnoop\x00"
HCI_ACL_PACKET = 0x02
ATT_CID = 0x0004
ATT_WRITE_REQUEST = 0x12
ATT_WRITE_COMMAND = 0x52
ATT_PREPARE_WRITE_REQUEST = 0x16
SOUNDBRENNER_PREFIX = bytes([0x01, 0x00])

BTSNOOP_EPOCH_DELTA_US = 0x00DCDDB30F2F8000

KNOWN_SOUNDBRENNER_COMMANDS = {
    0x01: "metronome running",
    0x02: "metronome bpm",
    0x1F: "haptic preview",
}


@dataclass
class AttWrite:
    index: int
    timestamp_s: float | None
    direction: str
    handle: int
    att_opcode: int
    value_hex: str
    soundbrenner_opcode: str | None
    soundbrenner_payload_hex: str | None
    soundbrenner_command: str | None


def fmt_hex(payload: bytes) -> str:
    return payload.hex(" ")


def parse_btsnoop_records(path: Path) -> Iterable[tuple[int, float | None, int, bytes]]:
    with path.open("rb") as stream:
        header = stream.read(16)
        if len(header) != 16 or not header.startswith(BTSNOOP_MAGIC):
            raise SystemExit(f"{path} is not a btsnoop file")
        version, datalink = struct.unpack(">II", header[8:16])
        if version != 1:
            raise SystemExit(f"Unsupported btsnoop version: {version}")
        if datalink not in (1001, 1002, 2001):
            print(f"warning: unexpected btsnoop datalink type {datalink}; trying HCI H4 parsing")

        index = 0
        while True:
            record_header = stream.read(24)
            if not record_header:
                return
            if len(record_header) != 24:
                raise SystemExit("Truncated btsnoop record header")
            original_len, included_len, flags, _drops, timestamp_us = struct.unpack(">IIIIq", record_header)
            payload = stream.read(included_len)
            if len(payload) != included_len:
                raise SystemExit("Truncated btsnoop record payload")
            index += 1
            timestamp_s = None
            if timestamp_us:
                timestamp_s = (timestamp_us - BTSNOOP_EPOCH_DELTA_US) / 1_000_000
            if included_len != original_len:
                payload = payload[:included_len]
            yield index, timestamp_s, flags, payload


def direction_from_flags(flags: int) -> str:
    # Android btsnoop uses bit 0 for received packets; sent ACL packets are the
    # writes from the phone/app to the device that we care about.
    return "rx" if flags & 0x01 else "tx"


def iter_l2cap_frames(acl_payload: bytes) -> Iterable[tuple[int, bytes]]:
    if len(acl_payload) < 4:
        return
    offset = 4
    while offset + 4 <= len(acl_payload):
        l2cap_len, cid = struct.unpack_from("<HH", acl_payload, offset)
        offset += 4
        end = offset + l2cap_len
        if end > len(acl_payload):
            return
        yield cid, acl_payload[offset:end]
        offset = end


def parse_acl_packet(packet: bytes) -> bytes | None:
    if not packet:
        return None
    if packet[0] == HCI_ACL_PACKET:
        return packet[1:]
    # Some exported logs strip the H4 packet type. Accept those if they look
    # long enough to contain an ACL header.
    if len(packet) >= 8:
        return packet
    return None


def decode_att_writes(path: Path) -> list[AttWrite]:
    writes: list[AttWrite] = []
    for index, timestamp_s, flags, packet in parse_btsnoop_records(path):
        acl_payload = parse_acl_packet(packet)
        if not acl_payload:
            continue
        direction = direction_from_flags(flags)
        for cid, l2cap_payload in iter_l2cap_frames(acl_payload):
            if cid != ATT_CID or not l2cap_payload:
                continue
            opcode = l2cap_payload[0]
            if opcode in (ATT_WRITE_REQUEST, ATT_WRITE_COMMAND):
                if len(l2cap_payload) < 4:
                    continue
                handle = struct.unpack_from("<H", l2cap_payload, 1)[0]
                value = l2cap_payload[3:]
            elif opcode == ATT_PREPARE_WRITE_REQUEST:
                if len(l2cap_payload) < 6:
                    continue
                handle = struct.unpack_from("<H", l2cap_payload, 1)[0]
                value = l2cap_payload[5:]
            else:
                continue
            command = None
            soundbrenner_opcode = None
            soundbrenner_payload_hex = None
            if value.startswith(SOUNDBRENNER_PREFIX) and len(value) >= 3:
                command_id = value[2]
                soundbrenner_opcode = f"0x{command_id:02x}"
                soundbrenner_payload_hex = fmt_hex(value[3:])
                command = KNOWN_SOUNDBRENNER_COMMANDS.get(command_id, f"unknown 0x{command_id:02x}")
            writes.append(AttWrite(
                index=index,
                timestamp_s=timestamp_s,
                direction=direction,
                handle=handle,
                att_opcode=opcode,
                value_hex=fmt_hex(value),
                soundbrenner_opcode=soundbrenner_opcode,
                soundbrenner_payload_hex=soundbrenner_payload_hex,
                soundbrenner_command=command,
            ))
    return writes


def render_table(writes: list[AttWrite], only_soundbrenner: bool) -> None:
    rows = [write for write in writes if not only_soundbrenner or write.soundbrenner_command]
    if not rows:
        print("No matching ATT writes found.")
        return
    print("idx\ttime_s\tdir\thandle\tatt\topcode\tsoundbrenner\tpayload\tvalue")
    for write in rows:
        timestamp = "" if write.timestamp_s is None else f"{write.timestamp_s:.6f}"
        command = write.soundbrenner_command or ""
        opcode = write.soundbrenner_opcode or ""
        payload = write.soundbrenner_payload_hex or ""
        print(
            f"{write.index}\t{timestamp}\t{write.direction}\t"
            f"0x{write.handle:04x}\t0x{write.att_opcode:02x}\t{opcode}\t{command}\t{payload}\t{write.value_hex}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Decode ATT writes from an Android btsnoop_hci.log")
    parser.add_argument("log", type=Path, help="Path to btsnoop_hci.log")
    parser.add_argument("--soundbrenner-only", action="store_true", help="Show only values beginning with 01 00")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a table")
    args = parser.parse_args()

    writes = decode_att_writes(args.log)
    rows = [write for write in writes if not args.soundbrenner_only or write.soundbrenner_command]
    if args.json:
        print(json.dumps([asdict(write) for write in rows], indent=2))
    else:
        render_table(writes, args.soundbrenner_only)


if __name__ == "__main__":
    main()
