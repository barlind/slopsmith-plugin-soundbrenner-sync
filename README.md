# Slopsmith Plugin: Soundbrenner Sync

Direct Bluetooth LE control for Soundbrenner Pulse/Core-style wearables from Slopsmith.

This avoids the Soundbrenner mobile app. The plugin runs a small Python/Bleak backend so Slopsmith can scan BLE, connect to the wearable, inspect GATT services, and send pulse writes directly.

## Setup

1. Install the plugin in your Slopsmith plugins folder and restart Slopsmith.
2. Make sure the Soundbrenner app is not connected to the wearable. The Pulse can only keep one active BLE connection.
3. Open the Soundbrenner plugin screen or Settings section.
4. Click Scan, choose the Pulse/Core device, then Connect.
5. Click Pulse Now. For Pulse devices, the plugin uses the proprietary Soundbrenner write characteristic directly.
6. Enable sync. Slopsmith follows playback start/pause/resume/seek/stop and either starts the Pulse hardware metronome or schedules per-beat haptics from the song beat map.
7. For haptic type testing, switch Beat drive to Per-beat haptic and choose the low, medium, and high haptic effects. Hardware metronome mode sends the same four-beat pattern to the Pulse before playback starts.

## Software Beat Pattern

Slopsmith can apply a pattern while driving haptic preview pulses from the song beat map, or send the same pattern to the Pulse hardware metronome. The Beat pulses panel and quick player popover show four beat slots as three stacked boxes: empty borders are `Silent`, the bottom fill is `Low`, bottom plus middle is `Medium`, and all three filled is `High`. The quick player popover also has a compact note-rate selector for `Half`, `Whole`, `Eighth`, and `Sixteenth`; `Whole` is the default. The tiny play button next to the Beat pattern label sends the current pattern to the Pulse and starts a hardware preview; while it is running, pattern changes stop and restart the preview with the new pattern. In 4/4 with note rate set to `Whole`, the default pattern makes beats 1 and 3 `High` and beats 2 and 4 `Medium`. Faster note rates advance the same four-slot pattern on every subdivision pulse, so `High/Low/Low/Low` with `Eighth` becomes `High Low Low Low High Low Low Low` across a 4/4 bar.

The levels map to haptic preview effect IDs in software mode: `Low haptic`, `Medium haptic`, and `High haptic` can be selected independently. In hardware mode those same three IDs are sent as the Pulse waveform slots, then the four beat levels are sent as the official two-bit accent array. Static analysis of the Soundbrenner Android app shows the Pulse accent marker values as `Low = 0`, `Medium = 1`, `High = 2`, and `Silent = 3`.

The hardware path is intentionally conservative: `Beat drive = Hardware metronome` uses the Pulse free-running metronome only when tempo changes are barline-aligned and the multiplied hardware tempo is within the Pulse BPM range. Slopsmith drives hardware note rates by multiplying BPM instead of relying on the Pulse subdivision array: `Half` sends 0.5x BPM, `Whole` sends game BPM, `Eighth` sends 2x BPM, and `Sixteenth` sends 4x BPM, while the four-slot pattern remains un-subdivided so it repeats at the selected tick rate. Song playback starts the hardware pattern only on a barline, so pattern slot 1 is always the game's measure start; if playback begins mid-bar, the Pulse arms and waits for the next bar. When a chart changes BPM on a barline, Slopsmith lets the downbeat land from the existing hardware phase, then sends the new BPM just after that barline so the following beats use the new tempo. Player and status BPM text stays on the game BPM; the multiplied BPM is only used for the hardware command. Non-barline tempo changes and tempos that would exceed the Pulse BPM limit stay on the beatmap-locked haptic scheduler.

## Standalone Test

Use this before involving Slopsmith:

```bash
python3 -m pip install "bleak>=0.22.3,<4"
python3 standalone_ble_test.py scan --timeout 8 --verbose
python3 standalone_ble_test.py services --address <address-from-scan>
python3 standalone_ble_test.py effects
python3 standalone_ble_test.py pulse --address <address-from-scan>
python3 standalone_ble_test.py pulse --address <address-from-scan> --mode soundbrenner_pulse --effect 23
python3 standalone_ble_test.py metronome --address <address-from-scan> --mode soundbrenner_pulse --bpm 120 --beats 12
python3 standalone_ble_test.py metronome --address <address-from-scan> --mode soundbrenner_pulse --drive preview --effect 23 --bpm 120 --beats 12
```

## Capturing App Pattern Commands

The official app can program beat profile/accent strength, silent beats, time signature, and subdivision multiplication. The current implementation was decoded from Soundbrenner Android app static analysis, but real BLE captures are still useful to validate edge cases and Core/Spark devices. The Pulse only keeps one active BLE connection, so disconnect Slopsmith before capturing the app.

Android Emulator is not a useful capture route for this work: the standard emulator does not expose the Mac's Bluetooth LE controller to guest apps, so the Soundbrenner app in a virtual Android device cannot connect to the physical Pulse. Use a physical Android device for HCI snoop, an over-the-air BLE sniffer, or static app package analysis instead.

Recommended Android capture flow:

1. Enable Android Developer options.
2. Enable **Bluetooth HCI snoop log**.
3. Reboot or toggle Bluetooth if Android asks for it.
4. Open the Soundbrenner app and connect to the Pulse.
5. Make one small change at a time, for example:
  - 4/4 with whole-note subdivision.
  - High beat 1, high beat 3, medium beats 2/4.
  - One silent beat.
  - Quarter/eighth/sixteenth subdivisions.
6. Export a bug report or pull the snoop log with `adb`. On many devices the bugreport contains `FS/data/misc/bluetooth/logs/btsnoop_hci.log`.
7. Decode ATT writes:

```bash
python3 scripts/decode_ble_hci_snoop.py /path/to/btsnoop_hci.log --soundbrenner-only
# Or point it directly at an Android bugreport zip:
python3 scripts/decode_ble_hci_snoop.py /path/to/bugreport.zip --soundbrenner-only
```

With `adb` installed and USB debugging authorized, the helper script can pull and decode a bugreport in one step:

```bash
scripts/capture_android_bugreport.sh
```

If no Android device is available but an app package or decompiled app folder is available, scan it for protocol constants:

```bash
python3 scripts/analyze_app_package.py /path/to/soundbrenner.apk
# or
python3 scripts/analyze_app_package.py /path/to/decompiled-app-dir --term pattern --term beat
```

Static analysis is less conclusive than a BLE capture, but it revealed the Pulse pattern opcodes and the accent marker enum values used for `Silent`, `Low`, `Medium`, and `High`.

Known Soundbrenner writes start with `01 00`. Decoded commands include `01 00 01` for start/stop, `01 00 02` for BPM, `01 00 1f` for haptic preview, `01 00 07` for waveform slots, `01 00 cf` for time signature, `01 00 bf` for subdivisions, `01 00 af` for accent arrays, and `01 00 2f` for beat sync. Capture only one app change per log when possible; it makes payload validation much easier. Good capture pairs are: `Medium` to `High` on beat 1, `Medium` to `Low` on beat 1, `Medium` to `Silent` on beat 1, `Whole` to `Eighths`, and `Eighths` to `Triplets`.

On macOS, Python may need Bluetooth permission. If Python is killed by a TCC privacy violation, run the tester from an app wrapper whose `Info.plist` includes `NSBluetoothAlwaysUsageDescription`, or grant Bluetooth permission to the terminal/app that launches Python.

## Dataset Calibration Sloppak POC

`scripts/build_dataset_sloppak.py` builds a small `.sloppak` calibration song by stitching annotated guitar dataset clips into named song sections. Each source clip becomes a Sloppak section, with a playable Lead arrangement, note timings, beat map, and `source_sections.json` sidecar that records the original audio/annotation paths and dataset metadata.

IDMT-SMT-GUITAR_V2 dataset2 works immediately because it ships matching XML and WAV files:

```bash
python3 scripts/build_dataset_sloppak.py idmt \
  --dataset2-dir "/Users/barlind/Library/Mobile Documents/com~apple~CloudDocs/Unsorted/Guitar stuff/IDMT-SMT-GUITAR_V2/dataset2" \
  --clips FS_Lick4_MBSH AR_Lick10_KN LP_Lick3_MN FS_G_V_slide \
  --out /tmp/idmt-soundbrenner-calibration.sloppak
```

GuitarSet is supported once the audio zip is unpacked. Point `--annotation-dir` at the `.jams` files and `--audio-root` at the unpacked audio tree; the importer matches WAV files by annotation stem:

```bash
python3 scripts/build_dataset_sloppak.py guitarset \
  --annotation-dir "/Users/barlind/Library/Mobile Documents/com~apple~CloudDocs/Unsorted/Guitar stuff/GuitarSet/annotation" \
  --audio-root "/path/to/unpacked/GuitarSet/audio" \
  --clips 00_Rock1-130-A_comp 00_Funk1-114-Ab_comp 00_SS1-100-C#_comp \
  --out /tmp/guitarset-soundbrenner-calibration.sloppak
```

By default the builder inserts a 1-bar count-in (silence + beat lines) before section 1, using the first clip's tempo. Use `--lead-in-bars 0` to disable, or set another bar count.

For bundled or redistributed fixtures, verify the dataset license and attribution requirements for the exact source material. For local POC work, keep generated Sloppaks under your DLC folder or `/tmp` rather than committing dataset-derived audio.

## Protocol Notes

Soundbrenner does not publish the proprietary BLE protocol for its wearables. This plugin supports:

- Soundbrenner Pulse BLE profile:
  - Service: `ccb2986e-1b2d-4c29-9cf8-25cdf8fe44fc`
  - Notify/Tx: `15a08173-ac6b-4804-853a-7af4d795a8ad`
  - Write/Rx: `fbaf40a5-ccd9-4e41-88f6-ef56c0ba299d`
  - Start: `01 00 01 01`
  - Start with position: `01 00 01 01 <beat_low> <beat_mid> <beat_high>`; Slopsmith uses this on hardware sync start so the repeated accent pattern lands on later measures.
  - Stop: `01 00 01 00`
  - Integer BPM: `01 00 02 <bpm_hi> <bpm_lo> 00`
  - Haptic preview: `01 00 1f <effect> 00 <duration_hi> <duration_lo>`
  - Waveform slots: `01 00 07 <low_effect> <medium_effect> <high_effect> <low_effect>`
  - Time signature: `01 00 cf <((numerator - 1) << 4) | denominator>`; 4/4 is `01 00 cf 34`.
  - Subdivision array: `01 00 bf <signature> <packed 4-bit subdivision ids>`; common IDs are `1` quarter, `2` eighths, `4` triplets, and `8` sixteenths.
  - Accent array: `01 00 af 00 <signature> <packed 2-bit accent levels>`; levels are `0` low, `1` medium, `2` high, and `3` silent.
  - Beat sync: `01 00 2f <beat>`.
  - Known haptic preview effect IDs include `19` strong click default/tested, `1..3` strong clicks, `21..23` medium clicks, `7..9` soft bumps, `24` sharp tick, `52` pulsing strong, and `14` strong buzz.
- Soundbrenner Core/Spark devices use a different GATT profile. Static analysis found Core metronome service `f3f6ce01-b257-4336-acd8-3010817837e4`, configuration characteristic `5ae0ba81-1053-4183-826e-7a6be885c142`, play/pause characteristic `920475b8-17ee-4474-a500-35037152b860`, sync characteristic `05094f38-7d29-450d-8f23-c9d784923668`, and settings characteristic `203b9729-4d3f-4898-8fb1-1ed1e6759229`. The current implementation targets the original Pulse profile.
- Standard BLE Immediate Alert (`0x1802` / `0x2A06`) when exposed by the wearable.
- Nordic UART discovery if the device exposes the common Nordic UART service.
- Manual custom writes for reverse-engineering a private write characteristic.
