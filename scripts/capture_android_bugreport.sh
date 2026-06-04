#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out_dir="${1:-$script_dir/../captures}"
mkdir -p "$out_dir"

stamp="$(date +%Y%m%d-%H%M%S)"
bugreport="$out_dir/bugreport-soundbrenner-$stamp.zip"
writes="$out_dir/soundbrenner-writes-$stamp.tsv"

adb start-server >/dev/null
echo "Waiting for an authorized Android device..."
adb wait-for-device

serial="$(adb get-serialno)"
model="$(adb shell getprop ro.product.model 2>/dev/null | tr -d '\r' || true)"
echo "Using device: ${model:-unknown} ($serial)"
echo "Make the Soundbrenner app pattern change before or during this bugreport capture."

adb bugreport "$bugreport"
python3 "$script_dir/decode_ble_hci_snoop.py" "$bugreport" --soundbrenner-only | tee "$writes"

echo "Bugreport: $bugreport"
echo "Decoded writes: $writes"