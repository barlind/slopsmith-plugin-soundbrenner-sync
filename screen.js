// Soundbrenner Sync plugin
// Direct BLE controller for Soundbrenner Pulse/Core-style wearables.

(function () {
    const runtime = window.__soundbrennerSyncRuntime || (window.__soundbrennerSyncRuntime = {});
    ['syncTimer', 'buttonRefreshTimer', 'pendingStartTimer', 'tempoChangeTimer', 'quickSettingsTimer', 'quickSettingsHideTimer'].forEach((timerKey) => {
        if (runtime[timerKey]) {
            window.clearTimeout(runtime[timerKey]);
            runtime[timerKey] = null;
        }
    });
    document.getElementById('soundbrenner-sync-popover')?.remove();
    if (runtime.eventHandlers && window.slopsmith && typeof window.slopsmith.off === 'function') {
        Object.entries(runtime.eventHandlers).forEach(([eventName, handler]) => {
            window.slopsmith.off(eventName, handler);
        });
        runtime.eventHandlers = null;
    }
    if (runtime.audioEventHandlers) {
        const audio = document.getElementById('audio');
        Object.entries(runtime.audioEventHandlers).forEach(([eventName, handler]) => {
            audio?.removeEventListener(eventName, handler);
        });
        runtime.audioEventHandlers = null;
    }
    if (runtime.quickSettingsDocumentHandlers) {
        document.removeEventListener('pointerdown', runtime.quickSettingsDocumentHandlers.pointerdown, true);
        document.removeEventListener('keydown', runtime.quickSettingsDocumentHandlers.keydown, true);
        window.removeEventListener('resize', runtime.quickSettingsDocumentHandlers.resize);
        runtime.quickSettingsDocumentHandlers = null;
    }

    const API = '/api/plugins/soundbrenner_sync';
    const BEAT_BOUNDARY_WINDOW_SEC = 0.035;
    const HARDWARE_TEMPO_CHANGE_AFTER_BAR_MS = 20;
    const BUTTON_BPM_REFRESH_MS = 250;
    const TEMPO_CHANGE_EPSILON_BPM = 0.25;
    const SOUNDBRENNER_MIN_BPM = 30;
    const SOUNDBRENNER_MAX_BPM = 400;
    const STORE = {
        enabled: 'soundbrenner_ble_enabled',
        address: 'soundbrenner_ble_address',
        mode: 'soundbrenner_ble_mode',
        charUuid: 'soundbrenner_ble_char_uuid',
        onHex: 'soundbrenner_ble_on_hex',
        offHex: 'soundbrenner_ble_off_hex',
        response: 'soundbrenner_ble_response',
        durationMs: 'soundbrenner_ble_duration_ms',
        leadMs: 'soundbrenner_ble_lead_ms',
        effect: 'soundbrenner_ble_effect',
        driveMode: 'soundbrenner_ble_drive_mode',
        pulseHalf: 'soundbrenner_ble_pulse_half',
        pulseQuarter: 'soundbrenner_ble_pulse_quarter',
        accentEffect: 'soundbrenner_ble_accent_effect',
        lowEffect: 'soundbrenner_ble_low_effect',
        patternSubdivision: 'soundbrenner_ble_pattern_subdivision',
        patternBeat1: 'soundbrenner_ble_pattern_beat_1',
        patternBeat2: 'soundbrenner_ble_pattern_beat_2',
        patternBeat3: 'soundbrenner_ble_pattern_beat_3',
        patternBeat4: 'soundbrenner_ble_pattern_beat_4',
    };
    const DEFAULT_HAPTIC_EFFECT = 19;
    const HAPTIC_EFFECTS = [
        { id: 19, label: 'Strong click 60 default' },
        { id: 1, label: 'Strong click 100' },
        { id: 2, label: 'Strong click 60' },
        { id: 3, label: 'Strong click 30' },
        { id: 21, label: 'Medium click 100' },
        { id: 22, label: 'Medium click 80' },
        { id: 23, label: 'Medium click 60' },
        { id: 7, label: 'Soft bump 100' },
        { id: 8, label: 'Soft bump 60' },
        { id: 9, label: 'Soft bump 30' },
        { id: 24, label: 'Sharp tick 100' },
        { id: 52, label: 'Pulsing strong 100' },
        { id: 14, label: 'Strong buzz 100' },
    ];

    let status = { available: false, connected: false, recommended: null, last_error: null };
    let devices = [];
    let services = [];
    let syncTimer = null;
    let buttonRefreshTimer = null;
    let pendingStartTimer = null;
    let tempoChangeTimer = null;
    let isRunning = false;
    let syncProtocol = null;
    let lastBeatIndex = null;
    let lastSentBpm = null;
    let inFlightPulse = false;
    let inFlightMetronome = false;
    let metronomeQueue = Promise.resolve();
    let metronomeGeneration = 0;
    let connectPromise = null;
    let syncGeneration = 0;
    let patternAuditionGeneration = 0;
    let hardwareStarted = false;
    let patternAuditionRunning = false;
    let lastSentPatternKey = null;
    let lastUiMessage = 'Idle';
    let lastSubdivisionPulseTime = null;
    let patternAuditionStartedAtMs = null;
    let patternAuditionHardwareBpm = null;
    let quickSettingsTimer = null;
    let quickSettingsHideTimer = null;

    function readBool(key, fallback) {
        const value = localStorage.getItem(key);
        if (value === null) return fallback;
        return value === 'true';
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function nowMs() {
        return window.performance && typeof window.performance.now === 'function'
            ? window.performance.now()
            : Date.now();
    }

    function normalizePulseNotes(value) {
        const normalized = String(value || '').toLowerCase();
        if (['quarter', 'half', 'downbeat'].includes(normalized)) return normalized;
        if (normalized === '2') return 'half';
        return 'quarter';
    }

    function legacyPulseNotes() {
        return normalizePulseNotes(localStorage.getItem('soundbrenner_ble_pulse_notes') || localStorage.getItem('soundbrenner_ble_subdivision'));
    }

    function readPulseHalf() {
        const value = localStorage.getItem(STORE.pulseHalf);
        if (value !== null) return value === 'true';
        const legacy = legacyPulseNotes();
        return legacy === 'half' || legacy === 'quarter';
    }

    function readPulseQuarter() {
        const value = localStorage.getItem(STORE.pulseQuarter);
        if (value !== null) return value === 'true';
        return legacyPulseNotes() === 'quarter';
    }

    function normalizePatternProfile(value) {
        const normalized = String(value || '').toLowerCase();
        if (normalized === 'accent' || normalized === 'hard') return 'high';
        if (normalized === 'normal') return 'medium';
        if (['silent', 'low', 'medium', 'high'].includes(normalized)) return normalized;
        return 'medium';
    }

    function patternProfileValue(key, fallback) {
        const value = localStorage.getItem(key);
        return value === null ? fallback : normalizePatternProfile(value);
    }

    function parsePatternSubdivision(value) {
        const parsed = parseFloat(value || '1');
        if (!Number.isFinite(parsed)) return 1;
        if (parsed <= 0.75) return 0.5;
        if (parsed < 1.5) return 1;
        if (parsed < 3) return 2;
        return 4;
    }

    function settings() {
        return {
            enabled: readBool(STORE.enabled, false),
            address: localStorage.getItem(STORE.address) || '',
            mode: localStorage.getItem(STORE.mode) || 'auto',
            charUuid: localStorage.getItem(STORE.charUuid) || '',
            onHex: localStorage.getItem(STORE.onHex) || '',
            offHex: localStorage.getItem(STORE.offHex) || '',
            response: readBool(STORE.response, false),
            durationMs: clamp(parseInt(localStorage.getItem(STORE.durationMs) || '80', 10) || 80, 20, 2000),
            leadMs: clamp(parseInt(localStorage.getItem(STORE.leadMs) || '0', 10) || 0, -500, 500),
            effect: clamp(parseInt(localStorage.getItem(STORE.effect) || String(DEFAULT_HAPTIC_EFFECT), 10) || DEFAULT_HAPTIC_EFFECT, 1, 124),
            accentEffect: clamp(parseInt(localStorage.getItem(STORE.accentEffect) || '1', 10) || 1, 1, 124),
            lowEffect: clamp(parseInt(localStorage.getItem(STORE.lowEffect) || '23', 10) || 23, 1, 124),
            driveMode: localStorage.getItem(STORE.driveMode) === 'preview' ? 'preview' : 'hardware',
            pulseHalf: readPulseHalf(),
            pulseQuarter: readPulseQuarter(),
            patternSubdivision: parsePatternSubdivision(localStorage.getItem(STORE.patternSubdivision)),
            patternBeats: [
                patternProfileValue(STORE.patternBeat1, 'high'),
                patternProfileValue(STORE.patternBeat2, 'medium'),
                patternProfileValue(STORE.patternBeat3, 'high'),
                patternProfileValue(STORE.patternBeat4, 'medium'),
            ],
        };
    }

    function save(key, value) {
        localStorage.setItem(key, String(value));
        render();
        updatePlayerButton();
    }

    function isSongPlaying() {
        return window.slopsmith?.isPlaying === true;
    }

    function audioPlaybackReady() {
        const audio = document.getElementById('audio');
        if (!audio) return true;
        return !audio.paused && !audio.ended && audio.readyState >= 2;
    }

    function esc(value) {
        if (typeof window.esc === 'function') return window.esc(value);
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;',
        }[ch]));
    }

    async function api(path, options) {
        const resp = await fetch(API + path, Object.assign({
            headers: { 'Content-Type': 'application/json' },
        }, options || {}));
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(data.detail || data.error || resp.statusText);
        }
        return data;
    }

    async function refreshStatus() {
        try {
            status = await api('/status');
            if (status.connected && status.address) {
                localStorage.setItem(STORE.address, status.address);
            }
            if (status.connected && status.recommended && settings().mode === 'auto') {
                localStorage.setItem(STORE.charUuid, status.recommended.char_uuid || '');
            }
            lastUiMessage = status.connected
                ? `Connected: ${status.name || status.address || 'BLE device'}`
                : (status.available ? 'Ready to scan' : 'BLE backend unavailable');
        } catch (err) {
            lastUiMessage = err.message || String(err);
        }
        render();
        updatePlayerButton();
    }

    async function scan() {
        lastUiMessage = 'Scanning...';
        render();
        try {
            const data = await api('/scan', { method: 'POST', body: '{}' });
            devices = data.devices || [];
            lastUiMessage = devices.length ? `Found ${devices.length} BLE device(s)` : 'No BLE devices found';
        } catch (err) {
            lastUiMessage = err.message || String(err);
        }
        render();
    }

    async function connect(address) {
        const target = address || settings().address;
        if (!target) {
            lastUiMessage = 'Select a BLE device first';
            render();
            return false;
        }
        if (connectPromise) return connectPromise;
        connectPromise = (async () => {
            stopSync(false);
            lastUiMessage = 'Connecting...';
            render();
            try {
                const data = await api('/connect', {
                    method: 'POST',
                    body: JSON.stringify({ address: target }),
                });
                status.connected = true;
                status.address = data.address;
                status.name = data.name;
                status.recommended = data.recommended || null;
                services = data.services || [];
                lastSentPatternKey = null;
                localStorage.setItem(STORE.address, data.address || target);
                if (data.recommended?.char_uuid) {
                    localStorage.setItem(STORE.charUuid, data.recommended.char_uuid);
                }
                lastUiMessage = data.recommended
                    ? `Connected. Recommended path: ${data.recommended.label}`
                    : 'Connected. Inspect services to choose a write characteristic.';
                return true;
            } catch (err) {
                lastUiMessage = err.message || String(err);
                return false;
            } finally {
                render();
                updatePlayerButton();
                connectPromise = null;
            }
        })();
        return connectPromise;
    }

    async function disconnect() {
        await stopPatternAudition(false);
        await stopSync(true);
        try {
            await api('/disconnect', { method: 'POST', body: '{}' });
        } catch (err) {
            lastUiMessage = err.message || String(err);
        }
        status.connected = false;
        services = [];
        await refreshStatus();
    }

    function pulsePayload(overrides) {
        const s = Object.assign({}, settings(), overrides || {});
        return {
            duration_ms: s.durationMs,
            intensity: 2,
            mode: s.mode,
            char_uuid: s.charUuid || null,
            on_hex: s.onHex || null,
            off_hex: s.offHex || null,
            response: s.response,
            effect: s.effect,
        };
    }

    async function pulse(overrides) {
        if (isRunning && !isSongPlaying()) {
            stopSync(true);
            return;
        }
        if (inFlightPulse) return;
        const scheduledPulse = isRunning;
        inFlightPulse = true;
        try {
            await api('/pulse', {
                method: 'POST',
                body: JSON.stringify(pulsePayload(overrides)),
            });
            if (!scheduledPulse) lastUiMessage = 'Pulse sent';
        } catch (err) {
            lastUiMessage = err.message || String(err);
            stopSync(false);
        } finally {
            inFlightPulse = false;
            if (!scheduledPulse || !isRunning) render();
        }
    }

    async function rawWrite() {
        const s = settings();
        if (!s.charUuid || !s.onHex) {
            lastUiMessage = 'Raw write needs a characteristic and hex payload';
            render();
            return;
        }
        try {
            await api('/write', {
                method: 'POST',
                body: JSON.stringify({ char_uuid: s.charUuid, hex: s.onHex, response: s.response }),
            });
            lastUiMessage = 'Raw write sent';
        } catch (err) {
            lastUiMessage = err.message || String(err);
        }
        render();
    }

    function getBeats() {
        if (!window.highway || typeof highway.getBeats !== 'function') return [];
        const beats = highway.getBeats();
        return Array.isArray(beats) ? beats : [];
    }

    function getChartTime() {
        const lead = settings().leadMs / 1000;
        if (window.highway && typeof highway.getTime === 'function') {
            const t = Number(highway.getTime());
            if (Number.isFinite(t)) return Math.max(0, t + lead);
        }
        const audio = document.getElementById('audio');
        return Math.max(0, Number(audio?.currentTime || 0) + lead);
    }

    function fallbackBeatPhase(t) {
        let bpm = 120;
        if (window.highway && typeof highway.getBPM === 'function') {
            const next = Number(highway.getBPM(t));
            if (Number.isFinite(next) && next > 0) bpm = next;
        }
        return t * bpm / 60;
    }

    function beatIndexAt(t) {
        const beats = getBeats();
        if (!beats.length) return -1;
        let lo = 0;
        let hi = beats.length - 1;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (Number(beats[mid].time) <= t) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    function intervalBpmAt(index) {
        const beats = getBeats();
        const here = Number(beats[index]?.time);
        const next = Number(beats[index + 1]?.time);
        const interval = next - here;
        if (Number.isFinite(interval) && interval > 0.001) return 60 / interval;
        return null;
    }

    function beatmapHasTempoChanges() {
        const beats = getBeats();
        if (beats.length < 3) return false;
        let previousBpm = null;
        for (let index = 0; index < beats.length - 1; index += 1) {
            const bpm = intervalBpmAt(index);
            if (!Number.isFinite(bpm) || bpm <= 0) continue;
            if (previousBpm !== null && Math.abs(bpm - previousBpm) >= TEMPO_CHANGE_EPSILON_BPM) return true;
            previousBpm = bpm;
        }
        return false;
    }

    function isTempoChangeBeat(index) {
        const previousBpm = intervalBpmAt(index - 1);
        const nextBpm = intervalBpmAt(index);
        return Number.isFinite(previousBpm)
            && Number.isFinite(nextBpm)
            && Math.abs(nextBpm - previousBpm) >= TEMPO_CHANGE_EPSILON_BPM;
    }

    function isMeasureStartBeatIndex(beatIndex) {
        const beats = getBeats();
        const measure = Number(beats[beatIndex]?.measure);
        if (Number.isFinite(measure)) return measure !== -1;
        return beatIndex % 4 === 0;
    }

    function beatmapTempoChangesAreBarlineAligned() {
        const beats = getBeats();
        if (beats.length < 3) return true;
        for (let index = 1; index < beats.length - 1; index += 1) {
            if (isTempoChangeBeat(index) && !isMeasureStartBeatIndex(index)) return false;
        }
        return true;
    }

    function hardwareTempoRangeSupported() {
        const beats = getBeats();
        const multiplier = hardwareTempoMultiplier();
        if (beats.length < 2) {
            const hardwareBpm = hardwareTempoTarget().bpm;
            return hardwareBpm >= SOUNDBRENNER_MIN_BPM && hardwareBpm <= SOUNDBRENNER_MAX_BPM;
        }
        for (let index = 0; index < beats.length - 1; index += 1) {
            const bpm = intervalBpmAt(index);
            if (!Number.isFinite(bpm) || bpm <= 0) continue;
            const hardwareBpm = bpm * multiplier;
            if (hardwareBpm < SOUNDBRENNER_MIN_BPM || hardwareBpm > SOUNDBRENNER_MAX_BPM) return false;
        }
        return true;
    }

    function preciseBeatBpmAt(t) {
        const index = beatIndexAt(t);
        return intervalBpmAt(index) || intervalBpmAt(index - 1);
    }

    function currentBpm(t) {
        const chartTime = Number.isFinite(Number(t)) ? Number(t) : getChartTime();
        const beatBpm = preciseBeatBpmAt(chartTime);
        if (Number.isFinite(beatBpm) && beatBpm > 0) return beatBpm;

        if (window.highway && typeof highway.getBPM === 'function') {
            const bpm = Number(highway.getBPM(chartTime));
            if (Number.isFinite(bpm) && bpm > 0) return bpm;
        }

        return 120;
    }

    function formatBpm(value) {
        const bpm = Number.isFinite(Number(value)) ? Number(value) : currentBpm();
        return `${Math.max(1, Math.round(bpm))} BPM`;
    }

    function formatPulsePolicy(s) {
        const opts = s || settings();
        const note = noteRateLabel(opts.patternSubdivision).toLowerCase();
        return `pattern (${note})`;
    }

    function canUseHardwareMetronome() {
        return beatmapTempoChangesAreBarlineAligned()
            && hardwareTempoRangeSupported();
    }

    function hardwareAccentValue(profile) {
        const level = normalizePatternProfile(profile);
        if (level === 'low') return 0;
        if (level === 'medium') return 1;
        if (level === 'high') return 2;
        return 3;
    }

    function hardwareTempoMultiplier(s) {
        const opts = s || settings();
        return parsePatternSubdivision(opts.patternSubdivision);
    }

    function hardwarePatternProfileForOffset(offset, s) {
        const opts = s || settings();
        const normalizedOffset = ((Number(offset) % 4) + 4) % 4;
        return normalizePatternProfile(opts.patternBeats?.[normalizedOffset] || 'medium');
    }

    function hardwareAccentPattern(s) {
        const opts = s || settings();
        return [0, 1, 2, 3].map((offset) => hardwareAccentValue(hardwarePatternProfileForOffset(offset, opts)));
    }

    function hardwarePatternPayload(s, options) {
        const opts = s || settings();
        const patternOptions = options || {};
        const body = {
            numerator: 4,
            denominator: 4,
            accents: hardwareAccentPattern(opts),
            subdivisions: [1, 1, 1, 1],
            waveforms: [opts.lowEffect, opts.effect, opts.accentEffect],
            response: opts.response,
        };
        if (Number.isFinite(Number(patternOptions.syncBeat))) {
            body.sync_beat = clamp(Math.round(Number(patternOptions.syncBeat)), 0, 255);
        }
        return body;
    }

    function hardwarePatternKey(body) {
        return JSON.stringify({
            numerator: body.numerator,
            denominator: body.denominator,
            accents: body.accents,
            subdivisions: body.subdivisions,
            waveforms: body.waveforms,
        });
    }

    function hardwareBeatPositionForIndex(beatIndex) {
        if (!Number.isFinite(Number(beatIndex))) return 0;
        const measureOffset = measureBeatOffset(Math.floor(Number(beatIndex)));
        const fastBeatIndex = Math.floor(measureOffset * hardwareTempoMultiplier());
        return clamp(fastBeatIndex, 0, 0xFFFFFF);
    }

    function beatSnapshot(t) {
        const chartTime = Number.isFinite(Number(t)) ? Number(t) : getChartTime();
        const beats = getBeats();
        if (beats.length >= 2) {
            const index = beatIndexAt(chartTime);
            const beatTime = Number(beats[index]?.time);
            const nextBeatTime = Number(beats[index + 1]?.time);
            const prevBeatTime = Number(beats[index - 1]?.time);
            const interval = Number.isFinite(nextBeatTime)
                ? nextBeatTime - beatTime
                : beatTime - prevBeatTime;
            if (Number.isFinite(beatTime) && Number.isFinite(interval) && interval > 0.001) {
                const secondsSinceBeat = Math.max(0, chartTime - beatTime);
                const secondsToNext = Number.isFinite(nextBeatTime)
                    ? Math.max(0, nextBeatTime - chartTime)
                    : Math.max(0, interval - secondsSinceBeat);
                const fraction = clamp(secondsSinceBeat / interval, 0, 0.999999);
                return {
                    index,
                    phase: index + fraction,
                    fraction,
                    secondsSinceBeat,
                    secondsToNext,
                    bpm: 60 / interval,
                    interval,
                };
            }
        }

        const bpm = currentBpm(chartTime);
        const phase = fallbackBeatPhase(chartTime);
        const index = Math.floor(phase);
        const fraction = clamp(phase - index, 0, 0.999999);
        const interval = 60 / Math.max(1, bpm);
        return {
            index,
            phase,
            fraction,
            secondsSinceBeat: fraction * interval,
            secondsToNext: (1 - fraction) * interval,
            bpm,
            interval,
        };
    }

    function primeBeatTracking() {
        const snapshot = beatSnapshot();
        if (!snapshot || !Number.isFinite(snapshot.index)) {
            lastBeatIndex = null;
            return null;
        }
        lastBeatIndex = snapshot.secondsSinceBeat <= BEAT_BOUNDARY_WINDOW_SEC
            ? snapshot.index - 1
            : snapshot.index;
        return snapshot;
    }

    function measureStartIndexForBeat(beatIndex) {
        const beats = getBeats();
        if (beats.length < 2) return 0;
        for (let index = Math.min(beatIndex, beats.length - 1); index >= 0; index -= 1) {
            if (isMeasureStartBeatIndex(index)) return index;
        }
        return 0;
    }

    function beatRole(beatIndex) {
        const beats = getBeats();
        const isMeasureStart = beats.length >= 2
            ? isMeasureStartBeatIndex(beatIndex)
            : beatIndex % 4 === 0;
        if (isMeasureStart) return 'measure';
        const measureStartIndex = measureStartIndexForBeat(beatIndex);
        const offset = Math.max(0, beatIndex - measureStartIndex);
        return offset > 0 && offset % 2 === 0 ? 'half' : 'quarter';
    }

    function measureBeatOffset(beatIndex) {
        return Math.max(0, beatIndex - measureStartIndexForBeat(beatIndex));
    }

    function nextHardwareBarStartTarget() {
        const chartTime = getChartTime();
        const beats = getBeats();
        if (beats.length >= 2) {
            const currentIndex = beatIndexAt(chartTime);
            const currentBeatTime = Number(beats[currentIndex]?.time);
            if (
                isMeasureStartBeatIndex(currentIndex)
                && Number.isFinite(currentBeatTime)
                && Math.max(0, chartTime - currentBeatTime) <= BEAT_BOUNDARY_WINDOW_SEC
            ) {
                return { index: currentIndex, delayMs: 0 };
            }
            for (let index = Math.max(0, currentIndex + 1); index < beats.length; index += 1) {
                const beatTime = Number(beats[index]?.time);
                if (!isMeasureStartBeatIndex(index) || !Number.isFinite(beatTime)) continue;
                const delayMs = Math.max(0, Math.round((beatTime - chartTime) * 1000));
                return { index, delayMs };
            }
        }

        const snapshot = beatSnapshot(chartTime);
        if (!snapshot || !Number.isFinite(snapshot.phase) || !Number.isFinite(snapshot.interval)) return { index: 0, delayMs: 0 };
        if (snapshot.index % 4 === 0 && snapshot.secondsSinceBeat <= BEAT_BOUNDARY_WINDOW_SEC) {
            return { index: snapshot.index, delayMs: 0 };
        }
        const targetPhase = Math.ceil((snapshot.phase + 0.000001) / 4) * 4;
        const delayMs = Math.max(0, Math.round((targetPhase - snapshot.phase) * snapshot.interval * 1000));
        return { index: targetPhase, delayMs };
    }

    function patternSlotIndexForBeat(beatIndex, s, options) {
        const opts = s || settings();
        const pulseOptions = options || {};
        const profiles = Array.isArray(opts.patternBeats) && opts.patternBeats.length
            ? opts.patternBeats
            : ['medium'];
        const subdivision = parsePatternSubdivision(opts.patternSubdivision);
        if (subdivision < 1) {
            const slowTick = Math.floor(Math.max(0, Number(beatIndex)) * subdivision);
            return ((slowTick % profiles.length) + profiles.length) % profiles.length;
        }
        const subdivisionStep = Number.isFinite(Number(pulseOptions.subdivisionStep))
            ? clamp(Math.floor(Number(pulseOptions.subdivisionStep)), 0, subdivision - 1)
            : 0;
        const patternIndex = (measureBeatOffset(beatIndex) * subdivision) + subdivisionStep;
        return ((patternIndex % profiles.length) + profiles.length) % profiles.length;
    }

    function beatPatternProfile(beatIndex, s, options) {
        const opts = s || settings();
        const profiles = Array.isArray(opts.patternBeats) && opts.patternBeats.length
            ? opts.patternBeats
            : ['medium'];
        const patternIndex = patternSlotIndexForBeat(beatIndex, opts, options);
        return normalizePatternProfile(profiles[patternIndex % profiles.length]);
    }

    function activePatternSlotForChartTime(s) {
        if (!isSongPlaying()) return null;
        const opts = s || settings();
        const snapshot = beatSnapshot();
        if (!snapshot || !Number.isFinite(snapshot.index)) return null;
        const subdivision = parsePatternSubdivision(opts.patternSubdivision);
        const subdivisionStep = subdivision >= 1
            ? clamp(Math.floor(snapshot.fraction * subdivision), 0, subdivision - 1)
            : 0;
        return patternSlotIndexForBeat(snapshot.index, opts, { subdivisionStep });
    }

    function activePatternSlotForAudition(s) {
        if (!patternAuditionRunning || !hardwareStarted || !patternAuditionStartedAtMs || !patternAuditionHardwareBpm) return null;
        const opts = s || settings();
        const profiles = Array.isArray(opts.patternBeats) && opts.patternBeats.length
            ? opts.patternBeats
            : ['medium'];
        const tickMs = 60000 / Math.max(1, patternAuditionHardwareBpm);
        const tickIndex = Math.floor(Math.max(0, nowMs() - patternAuditionStartedAtMs) / tickMs);
        return tickIndex % profiles.length;
    }

    function activePatternSlotIndex(s) {
        if (patternAuditionRunning) return activePatternSlotForAudition(s);
        if (!isRunning) return null;
        if (syncProtocol === 'soundbrenner_hardware' && !hardwareStarted) return null;
        return activePatternSlotForChartTime(s);
    }

    function hapticEffectForProfile(profile, s, options) {
        const opts = s || settings();
        const level = normalizePatternProfile(profile);
        if (level === 'silent') return null;
        if (level === 'low') return opts.lowEffect;
        if (level === 'high') return opts.accentEffect;
        return opts.effect;
    }

    function pulseOptionsForBeat(beatIndex, s, options) {
        const opts = s || settings();
        const pulseOptions = options || {};
        const subdivision = parsePatternSubdivision(opts.patternSubdivision);
        if (subdivision < 1 && !pulseOptions.subdivision) {
            const slowPhase = Math.max(0, Number(beatIndex)) * subdivision;
            if (Math.abs(slowPhase - Math.round(slowPhase)) > 0.000001) return null;
        }

        const profile = beatPatternProfile(beatIndex, opts, pulseOptions);
        const effect = hapticEffectForProfile(profile, opts, pulseOptions);
        return effect === null ? null : { effect };
    }

    function shouldPulseBeatMap(beatIndex, s) {
        return pulseOptionsForBeat(beatIndex, s) !== null;
    }

    function pulseSubdivisionTimesBetween(startTime, endTime, s) {
        if (s.patternSubdivision <= 1) return false;
        const beats = getBeats();
        if (beats.length < 2) return false;

        const startIndex = Math.max(0, beatIndexAt(startTime) - 1);
        const endIndex = Math.min(beats.length - 2, beatIndexAt(endTime) + 1);
        for (let beatIndex = startIndex; beatIndex <= endIndex; beatIndex += 1) {
            const beatTime = Number(beats[beatIndex]?.time);
            const nextBeatTime = Number(beats[beatIndex + 1]?.time);
            const interval = nextBeatTime - beatTime;
            if (!Number.isFinite(beatTime) || !Number.isFinite(interval) || interval <= 0.001) continue;
            for (let step = 1; step < s.patternSubdivision; step += 1) {
                const t = beatTime + (interval * step / s.patternSubdivision);
                if (t <= startTime + 0.000001) continue;
                if (t > endTime + 0.000001) break;
                const options = pulseOptionsForBeat(beatIndex, s, { subdivision: true, subdivisionStep: step });
                if (!options) continue;
                pulse(options);
                return true;
            }
        }
        return false;
    }

    function hardwareTempoTarget(t) {
        const chartTime = Number.isFinite(Number(t)) ? Number(t) : getChartTime();
        const snapshot = beatSnapshot(chartTime);
        const currentBeatIndex = snapshot && Number.isFinite(snapshot.index)
            ? snapshot.index
            : beatIndexAt(chartTime);
        const current = intervalBpmAt(currentBeatIndex) || currentBpm(chartTime);
        return { bpm: current * hardwareTempoMultiplier() };
    }

    function hardwareTempoTargetForBeatIndex(beatIndex) {
        const beats = getBeats();
        const beatTime = Number(beats[beatIndex]?.time);
        const bpm = intervalBpmAt(beatIndex)
            || intervalBpmAt(beatIndex - 1)
            || currentBpm(Number.isFinite(beatTime) ? beatTime : undefined);
        return { bpm: bpm * hardwareTempoMultiplier() };
    }

    function usesSoundbrennerProtocol() {
        const s = settings();
        return s.mode === 'soundbrenner_pulse'
            || (s.mode === 'auto' && status.recommended?.mode === 'soundbrenner_pulse');
    }

    function hapticEffectLabel(effectId) {
        const match = HAPTIC_EFFECTS.find((effect) => effect.id === Number(effectId));
        return match ? match.label : `Effect ${effectId}`;
    }

    function hapticEffectOptions(selected) {
        return HAPTIC_EFFECTS.map((effect) => (
            `<option value="${effect.id}" ${effect.id === selected ? 'selected' : ''}>${esc(effect.id)} - ${esc(effect.label)}</option>`
        )).join('');
    }

    function subdivisionOptions(selected) {
        const value = parsePatternSubdivision(selected);
        return noteRateOptions().map((option) => (
            `<option value="${option.value}" ${option.value === value ? 'selected' : ''}>${option.label}</option>`
        )).join('');
    }

    function noteRateOptions() {
        return [
            { value: 0.5, label: 'Half', icon: '1/2' },
            { value: 1, label: 'Whole', icon: '1' },
            { value: 2, label: 'Eighth', icon: '1/8' },
            { value: 4, label: 'Sixteenth', icon: '1/16' },
        ];
    }

    function noteRateLabel(value) {
        const selected = parsePatternSubdivision(value);
        const match = noteRateOptions().find((option) => option.value === selected);
        return match ? match.label : 'Whole';
    }

    function formatGameTempoWithRate(s) {
        const opts = s || settings();
        return `${formatBpm()} (${noteRateLabel(opts.patternSubdivision)})`;
    }

    function noteRateSelectorHtml(s) {
        const selected = parsePatternSubdivision((s || settings()).patternSubdivision);
        return `
            <div class="grid grid-cols-4 gap-1.5">
                ${noteRateOptions().map((option) => {
                    const active = option.value === selected;
                    return `
                        <button type="button" onclick="soundbrennerBleSet('patternSubdivision', '${option.value}')"
                            title="${option.label}" aria-label="${option.label}"
                            class="h-8 rounded border text-[11px] transition ${active ? 'border-cyan-300 bg-cyan-900/50 text-cyan-100' : 'border-gray-700 bg-dark-700 text-gray-400 hover:border-cyan-400/70 hover:text-cyan-100'}">
                            ${option.icon}
                        </button>`;
                }).join('')}
            </div>`;
    }

    function patternProfileLevel(profile) {
        const level = normalizePatternProfile(profile);
        if (level === 'low') return 1;
        if (level === 'medium') return 2;
        if (level === 'high') return 3;
        return 0;
    }

    function patternProfileLabel(profile) {
        const level = normalizePatternProfile(profile);
        if (level === 'low') return 'Low';
        if (level === 'medium') return 'Medium';
        if (level === 'high') return 'High';
        return 'Silent';
    }

    function nextPatternProfile(profile) {
        const cycle = ['silent', 'low', 'medium', 'high'];
        const index = cycle.indexOf(normalizePatternProfile(profile));
        return cycle[(index + 1) % cycle.length];
    }

    function beatStackButtonHtml(profile, index, activeIndex) {
        const level = patternProfileLevel(profile);
        const label = patternProfileLabel(profile);
        const active = activeIndex === index;
        const boxes = [3, 2, 1].map((boxLevel) => {
            const filled = level >= boxLevel;
            return `<span class="block h-2.5 w-7 rounded-sm border ${filled ? 'border-cyan-300 bg-cyan-400' : 'border-gray-600 bg-transparent'}"></span>`;
        }).join('');
        return `
            <button type="button" onclick="soundbrennerBleCycleBeat(${index + 1})"
                title="Beat ${index + 1}: ${label}" aria-label="Beat ${index + 1}: ${label}"
                aria-current="${active ? 'true' : 'false'}" data-sbs-pattern-beat="${index}"
                class="flex flex-col items-center gap-1 rounded border px-2 py-2 hover:border-cyan-400/70 hover:bg-dark-600/80 transition ${active ? 'border-cyan-300 bg-cyan-900/40 ring-1 ring-cyan-300/80' : 'border-gray-700 bg-dark-700/70'}">
                <span class="flex flex-col gap-0.5">${boxes}</span>
                <span class="text-[10px] leading-none text-gray-400">${index + 1}</span>
            </button>`;
    }

    function beatStackGridHtml(s) {
        const opts = s || settings();
        const activeIndex = activePatternSlotIndex(opts);
        return `<div class="grid grid-cols-4 gap-2">${opts.patternBeats.map((profile, index) => beatStackButtonHtml(profile, index, activeIndex)).join('')}</div>`;
    }

    function setBeatButtonActive(button, active) {
        ['border-cyan-300', 'bg-cyan-900/40', 'ring-1', 'ring-cyan-300/80'].forEach((className) => {
            button.classList.toggle(className, active);
        });
        ['border-gray-700', 'bg-dark-700/70'].forEach((className) => {
            button.classList.toggle(className, !active);
        });
        button.setAttribute('aria-current', active ? 'true' : 'false');
    }

    function updateActiveBeatVisualization(root, s) {
        const activeIndex = activePatternSlotIndex(s || settings());
        const scope = root || document;
        scope.querySelectorAll('[data-sbs-pattern-beat]').forEach((button) => {
            setBeatButtonActive(button, Number(button.dataset.sbsPatternBeat) === activeIndex);
        });
    }

    function patternAuditionDisabled() {
        return isSongPlaying() && !patternAuditionRunning;
    }

    function patternAuditionButtonLabel(running, disabled) {
        if (disabled) return 'Pattern preview disabled while song is playing';
        return running ? 'Stop pattern preview' : 'Play pattern preview';
    }

    function patternAuditionButtonClass(running, disabled) {
        const tone = disabled
            ? 'border-gray-700 bg-dark-700 text-gray-600 cursor-not-allowed opacity-50'
            : running
                ? 'border-cyan-400/70 bg-cyan-900/50 text-cyan-100 hover:bg-cyan-900/70'
                : 'border-gray-700 bg-dark-700 text-gray-300 hover:border-cyan-400/70 hover:text-cyan-100';
        return `inline-flex h-5 w-5 items-center justify-center rounded border ${tone} text-[10px] leading-none transition`;
    }

    function patternAuditionButtonIcon(running) {
        return running ? '&#9632;' : '&#9654;';
    }

    function updatePatternAuditionButtonState(root) {
        const scope = root || document;
        const button = scope.querySelector('[data-sbs-pattern-audition]');
        if (!button) return;
        const running = patternAuditionRunning;
        const disabled = patternAuditionDisabled();
        const label = patternAuditionButtonLabel(running, disabled);
        button.disabled = disabled;
        button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        button.className = patternAuditionButtonClass(running, disabled);
        button.innerHTML = patternAuditionButtonIcon(running);
    }

    function patternAuditionButtonHtml() {
        const running = patternAuditionRunning;
        const disabled = patternAuditionDisabled();
        const label = patternAuditionButtonLabel(running, disabled);
        return `
            <button type="button" data-sbs-pattern-audition="1" onclick="soundbrennerBleTogglePatternAudition()"
                title="${label}" aria-label="${label}" aria-disabled="${disabled ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}
                class="${patternAuditionButtonClass(running, disabled)}">
                ${patternAuditionButtonIcon(running)}
            </button>`;
    }

    function patternHeaderHtml() {
        return `
            <div class="flex items-center gap-1.5 text-[11px] text-gray-500">
                <span>Beat pattern</span>
                ${patternAuditionButtonHtml()}
            </div>`;
    }

    function leadAdjusterHtml(s) {
        const opts = s || settings();
        return `
            <div class="flex items-center justify-between gap-2 rounded border border-gray-700 bg-dark-700 px-2 py-1.5">
                <button type="button" onclick="soundbrennerBleAdjustLead(-5)"
                    class="h-7 w-7 rounded bg-dark-600 hover:bg-dark-500 text-sm text-gray-200 transition" title="Lead -5 ms">-</button>
                <div class="min-w-[72px] text-center text-xs text-cyan-200">${opts.leadMs} ms</div>
                <button type="button" onclick="soundbrennerBleAdjustLead(5)"
                    class="h-7 w-7 rounded bg-dark-600 hover:bg-dark-500 text-sm text-gray-200 transition" title="Lead +5 ms">+</button>
            </div>`;
    }

    async function sendHardwarePattern(options) {
        if (!status.connected) return;
        const patternOptions = options || {};
        const body = hardwarePatternPayload(settings(), patternOptions);
        const key = hardwarePatternKey(body);
        if (!patternOptions.force && lastSentPatternKey === key && !Number.isFinite(Number(patternOptions.syncBeat))) return;
        try {
            await api('/pattern', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            lastSentPatternKey = key;
            const opts = settings();
            lastUiMessage = `Hardware pattern sent: ${opts.patternBeats.join('/')} (${body.accents.join('/')}) at ${formatGameTempoWithRate(opts)}`;
            return true;
        } catch (err) {
            lastUiMessage = err.message || String(err);
            stopSync(false);
            return false;
        } finally {
            render();
            updatePlayerButton();
        }
    }

    function patternAuditionSettingChanged(name) {
        return name === 'effect'
            || name === 'lowEffect'
            || name === 'accentEffect'
            || name === 'patternSubdivision'
            || name.startsWith('patternBeat');
    }

    async function stopPatternAudition(updateMessage) {
        const generation = ++patternAuditionGeneration;
        const wasRunning = patternAuditionRunning;
        patternAuditionRunning = false;
        render();
        updatePlayerButton();
        updateQuickSettingsPopover(true);
        if (status.connected && (wasRunning || hardwareStarted)) {
            await sendHardwareMetronome({ running: false });
        }
        if (generation !== patternAuditionGeneration) return;
        if (updateMessage) lastUiMessage = status.connected ? 'Pattern preview stopped' : 'Idle';
        render();
        updatePlayerButton();
        updateQuickSettingsPopover(true);
    }

    async function startPatternAudition(options) {
        if (isSongPlaying()) {
            lastUiMessage = 'Pattern preview disabled while song is playing';
            render();
            updatePlayerButton();
            updateQuickSettingsPopover(true);
            return;
        }
        const auditionOptions = options || {};
        const generation = ++patternAuditionGeneration;
        if (isRunning) await stopSync(false);
        if (auditionOptions.restart && status.connected) {
            await sendHardwareMetronome({ running: false });
        }
        if (generation !== patternAuditionGeneration) return;
        if (!status.connected) {
            const savedAddress = settings().address;
            if (!savedAddress) {
                lastUiMessage = 'Connect Soundbrenner before pattern preview';
                render();
                updatePlayerButton();
                updateQuickSettingsPopover(true);
                return;
            }
            const connected = await connect(savedAddress);
            if (!connected || generation !== patternAuditionGeneration) return;
        }
        if (!usesSoundbrennerProtocol()) {
            lastUiMessage = 'Pattern preview needs Soundbrenner Pulse mode';
            render();
            updatePlayerButton();
            updateQuickSettingsPopover(true);
            return;
        }
        const target = hardwareTempoTarget();
        if (target.bpm < SOUNDBRENNER_MIN_BPM || target.bpm > SOUNDBRENNER_MAX_BPM) {
            lastUiMessage = `Pattern preview out of Pulse BPM range: ${formatGameTempoWithRate()} needs ${formatBpm(target.bpm)} hardware`;
            render();
            updatePlayerButton();
            updateQuickSettingsPopover(true);
            return;
        }
        patternAuditionRunning = true;
        lastSentBpm = null;
        lastSentPatternKey = null;
        lastUiMessage = auditionOptions.restart ? 'Updating pattern preview...' : 'Starting pattern preview...';
        render();
        updatePlayerButton();
        updateQuickSettingsPopover(true);

        const patternSent = await sendHardwarePattern({ force: true });
        if (!patternSent) {
            if (generation === patternAuditionGeneration) patternAuditionRunning = false;
            render();
            updatePlayerButton();
            updateQuickSettingsPopover(true);
            return;
        }
        if (generation !== patternAuditionGeneration || !patternAuditionRunning) return;
        await sendHardwareMetronome({ forceBpm: true, running: true, beat: 0 });
        if (generation !== patternAuditionGeneration || !patternAuditionRunning) return;
        if (!hardwareStarted) {
            patternAuditionRunning = false;
            render();
            updatePlayerButton();
            updateQuickSettingsPopover(true);
            return;
        }
        lastUiMessage = `Pattern preview running at ${formatGameTempoWithRate()}`;
        render();
        updatePlayerButton();
        updateQuickSettingsPopover(true);
    }

    function restartPatternAudition() {
        if (!patternAuditionRunning) return;
        startPatternAudition({ restart: true });
    }

    async function _sendHardwareMetronomeNow(opts) {
        if (!status.connected) return;
        const options = opts || {};
        const body = { response: settings().response };
        const target = hardwareTempoTarget();
        if (typeof options.bpm === 'number') {
            body.bpm = options.bpm;
        } else if (options.forceBpm) {
            body.bpm = target.bpm;
        } else if (options.updateBpm && lastSentBpm !== null) {
            if (Math.abs(target.bpm - lastSentBpm) >= TEMPO_CHANGE_EPSILON_BPM) body.bpm = target.bpm;
        }
        if (typeof options.running === 'boolean') body.running = options.running;
        if (typeof options.beat === 'number') body.beat = hardwareBeatPositionForIndex(options.beat);
        if (typeof body.bpm !== 'number' && typeof body.running !== 'boolean') return;

        inFlightMetronome = true;
        try {
            await api('/metronome', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (typeof body.bpm === 'number') lastSentBpm = body.bpm;
            if (typeof body.running === 'boolean') {
                hardwareStarted = body.running;
                if (body.running && patternAuditionRunning) {
                    patternAuditionStartedAtMs = nowMs();
                    patternAuditionHardwareBpm = Number(body.bpm) || lastSentBpm || hardwareTempoTarget().bpm;
                }
                if (!body.running) {
                    patternAuditionStartedAtMs = null;
                    patternAuditionHardwareBpm = null;
                }
                lastUiMessage = body.running
                    ? `Soundbrenner hardware metronome running at ${formatGameTempoWithRate()}`
                    : 'Soundbrenner hardware metronome stopped';
            }
        } catch (err) {
            lastUiMessage = err.message || String(err);
            hardwareStarted = false;
            if (options.running !== false) stopSync(false);
        } finally {
            inFlightMetronome = false;
            render();
            updatePlayerButton();
        }
    }

    function sendHardwareMetronome(opts) {
        const options = Object.assign({}, opts || {});
        const commandGeneration = options.running === false
            ? ++metronomeGeneration
            : metronomeGeneration;
        metronomeQueue = metronomeQueue
            .catch(() => {})
            .then(() => {
                if (options.running !== false && commandGeneration !== metronomeGeneration) return null;
                return _sendHardwareMetronomeNow(options);
            });
        return metronomeQueue;
    }

    function hardwareMetronomeTick() {
        if (!settings().enabled || !status.connected || !isRunning) return;
        if (!isSongPlaying()) {
            stopForTransport(true);
            return;
        }
        if (!beatmapHasTempoChanges()) sendHardwareMetronome({ updateBpm: true });
        updatePlayerButton();
    }

    function beatPhaseAt(t) {
        const beats = getBeats();
        if (beats.length < 2) return fallbackBeatPhase(t);

        let lo = 0;
        let hi = beats.length - 1;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (Number(beats[mid].time) <= t) lo = mid;
            else hi = mid - 1;
        }

        const idx = lo;
        const beatTime = Number(beats[idx].time);
        const interval = idx < beats.length - 1
            ? Number(beats[idx + 1].time) - beatTime
            : beatTime - Number(beats[idx - 1].time);
        if (!Number.isFinite(interval) || interval <= 0.001) return idx;
        return idx + ((t - beatTime) / interval);
    }

    function schedulerTick() {
        if (!settings().enabled || !status.connected) return;
        if (!isSongPlaying()) {
            stopForTransport(true);
            return;
        }
        const s = settings();
        const chartTime = getChartTime();
        if (lastSubdivisionPulseTime === null) lastSubdivisionPulseTime = chartTime;
        pulseSubdivisionTimesBetween(lastSubdivisionPulseTime, chartTime, s);
        lastSubdivisionPulseTime = chartTime;

        const phase = beatPhaseAt(chartTime);
        if (!Number.isFinite(phase)) return;
        const beatIndex = Math.floor(phase + 0.000001);
        if (lastBeatIndex === null) {
            primeBeatTracking();
            if (lastBeatIndex === null) return;
        }
        if (beatIndex > lastBeatIndex) {
            if (beatIndex - lastBeatIndex > 4) {
                lastBeatIndex = beatIndex - 1;
            }
            lastBeatIndex = beatIndex;
            const options = pulseOptionsForBeat(beatIndex, s);
            if (options) pulse(options);
        }
    }

    function clearPendingStart() {
        if (pendingStartTimer) {
            window.clearTimeout(pendingStartTimer);
            pendingStartTimer = null;
            runtime.pendingStartTimer = null;
        }
    }

    function clearTempoChangeTimer() {
        if (tempoChangeTimer) {
            window.clearTimeout(tempoChangeTimer);
            tempoChangeTimer = null;
            runtime.tempoChangeTimer = null;
        }
    }

    function nextHardwareTempoChangeAfter(t) {
        if (!beatmapHasTempoChanges() || !beatmapTempoChangesAreBarlineAligned()) return null;
        const beats = getBeats();
        if (beats.length < 3) return null;
        const chartTime = Number.isFinite(Number(t)) ? Number(t) : getChartTime();
        for (let index = 1; index < beats.length - 1; index += 1) {
            const beatTime = Number(beats[index]?.time);
            if (!Number.isFinite(beatTime) || beatTime <= chartTime + 0.001) continue;
            if (!isTempoChangeBeat(index)) continue;
            const target = hardwareTempoTargetForBeatIndex(index);
            if (target.bpm < SOUNDBRENNER_MIN_BPM || target.bpm > SOUNDBRENNER_MAX_BPM) return null;
            return { index, beatTime, bpm: target.bpm };
        }
        return null;
    }

    function scheduleNextHardwareTempoChange(generation) {
        clearTempoChangeTimer();
        const change = nextHardwareTempoChangeAfter();
        if (!change) return;
        const delayMs = Math.max(0, Math.round((change.beatTime - getChartTime()) * 1000) + HARDWARE_TEMPO_CHANGE_AFTER_BAR_MS);
        tempoChangeTimer = window.setTimeout(async () => {
            tempoChangeTimer = null;
            runtime.tempoChangeTimer = null;
            if (!isRunning || generation !== syncGeneration || syncProtocol !== 'soundbrenner_hardware' || !isSongPlaying()) return;
            await sendHardwareMetronome({ bpm: change.bpm });
            if (!isRunning || generation !== syncGeneration || syncProtocol !== 'soundbrenner_hardware' || !isSongPlaying()) return;
            scheduleNextHardwareTempoChange(generation);
        }, delayMs);
        runtime.tempoChangeTimer = tempoChangeTimer;
    }

    async function startHardwareSync() {
        if (!isSongPlaying() || !audioPlaybackReady()) return;
        const generation = ++syncGeneration;
        clearPendingStart();
        clearTempoChangeTimer();
        syncProtocol = 'soundbrenner_hardware';
        hardwareStarted = false;
        lastSentBpm = null;
        lastSentPatternKey = null;
        isRunning = true;
        updatePlayerButton();

        const barStart = nextHardwareBarStartTarget();
        const delayMs = barStart.delayMs;
        const startBeat = 0;
        const patternSent = await sendHardwarePattern({ force: true });
        if (!patternSent) return;
        if (!isRunning || generation !== syncGeneration || !isSongPlaying()) return;

        lastUiMessage = delayMs > 0
            ? `Sync armed for next bar at ${formatGameTempoWithRate()}`
            : `Sync starting at ${formatGameTempoWithRate()}`;
        render();
        updatePlayerButton();

        const startOnBar = async () => {
            pendingStartTimer = null;
            runtime.pendingStartTimer = null;
            if (!isRunning || generation !== syncGeneration || syncProtocol !== 'soundbrenner_hardware' || !isSongPlaying()) return;
            await sendHardwareMetronome({ forceBpm: true, running: true, beat: startBeat });
            if (!isRunning || generation !== syncGeneration || syncProtocol !== 'soundbrenner_hardware' || !isSongPlaying()) return;
            if (!syncTimer) {
                syncTimer = window.setInterval(hardwareMetronomeTick, 250);
                runtime.syncTimer = syncTimer;
            }
            scheduleNextHardwareTempoChange(generation);
            render();
            updatePlayerButton();
        };

        if (delayMs <= 0) await startOnBar();
        else {
            pendingStartTimer = window.setTimeout(startOnBar, delayMs);
            runtime.pendingStartTimer = pendingStartTimer;
        }
    }

    async function startSync() {
        const s = settings();
        if (!s.enabled || !status.connected || isRunning || !isSongPlaying() || !audioPlaybackReady()) return;
        if (patternAuditionRunning) await stopPatternAudition(false);
        if (usesSoundbrennerProtocol() && s.driveMode === 'hardware' && canUseHardwareMetronome(s)) {
            await startHardwareSync();
            return;
        }

        syncProtocol = usesSoundbrennerProtocol() ? 'soundbrenner_preview' : 'beat_pulse';
        primeBeatTracking();
        lastSubdivisionPulseTime = getChartTime();
        isRunning = true;
        schedulerTick();
        syncTimer = window.setInterval(schedulerTick, 8);
        runtime.syncTimer = syncTimer;
        lastUiMessage = syncProtocol === 'soundbrenner_preview'
            ? `Per-beat haptic running at ${formatBpm()} on ${formatPulsePolicy(s)}: ${hapticEffectLabel(s.effect)}`
            : `Direct BLE sync running at ${formatBpm()}`;
        render();
        updatePlayerButton();
    }

    function stopSync(updateMessage, options) {
        const stopOptions = options || {};
        syncGeneration += 1;
        clearPendingStart();
        clearTempoChangeTimer();
        const s = settings();
        const shouldForceHardwareStop = stopOptions.forceHardwareStop
            && s.driveMode === 'hardware'
            && usesSoundbrennerProtocol();
        const stopHardware = status.connected && (
            syncProtocol === 'soundbrenner_hardware'
            || hardwareStarted
            || shouldForceHardwareStop
        );
        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
            runtime.syncTimer = null;
        }
        isRunning = false;
        syncProtocol = null;
        lastBeatIndex = null;
        lastSubdivisionPulseTime = null;
        patternAuditionStartedAtMs = null;
        patternAuditionHardwareBpm = null;
        lastSentBpm = null;
        lastSentPatternKey = null;
        hardwareStarted = false;
        const stopPromise = stopHardware ? sendHardwareMetronome({ running: false }) : Promise.resolve();
        if (updateMessage) lastUiMessage = status.connected ? 'Connected' : 'Idle';
        render();
        updatePlayerButton();
        return stopPromise;
    }

    function stopForTransport(updateMessage) {
        return stopSync(updateMessage, { forceHardwareStop: true });
    }

    function restartAfterSeek() {
        if (!isRunning) {
            lastBeatIndex = null;
            lastSubdivisionPulseTime = null;
            return;
        }
        stopSync(false);
        window.setTimeout(() => {
            if (settings().enabled && isSongPlaying()) startWhenPlayable();
        }, 20);
    }

    async function startWhenPlayable() {
        if (!settings().enabled) {
            updatePlayerButton();
            return;
        }
        if (!isSongPlaying()) {
            if (isRunning) stopForTransport(true);
            else updatePlayerButton();
            return;
        }
        if (!audioPlaybackReady()) {
            lastUiMessage = 'Pulse armed; waiting for audio playback';
            render();
            updatePlayerButton();
            return;
        }
        if (!status.connected) {
            const savedAddress = settings().address;
            if (!savedAddress) {
                lastUiMessage = 'Pulse armed; connect Soundbrenner first';
                render();
                updatePlayerButton();
                return;
            }
            const connected = await connect(savedAddress);
            if (!connected || !settings().enabled || !isSongPlaying()) return;
        }
        startSync();
    }

    function writableCharacteristics() {
        const out = [];
        for (const service of services) {
            for (const char of service.characteristics || []) {
                const props = char.properties || [];
                if (props.includes('write') || props.includes('write-without-response')) {
                    out.push({
                        service: service.uuid,
                        uuid: char.uuid,
                        label: `${char.description || 'Writable'} (${char.uuid})`,
                    });
                }
            }
        }
        return out;
    }

    function serviceSummaryHtml() {
        if (!services.length) {
            return '<div class="text-xs text-gray-500">No services loaded.</div>';
        }
        return services.map((service) => {
            const chars = (service.characteristics || []).map((char) => `
                <div class="ml-3 py-1 border-l border-gray-800 pl-3">
                    <div class="text-xs text-gray-300">${esc(char.description || 'Characteristic')}</div>
                    <div class="text-[11px] text-gray-500 font-mono break-all">${esc(char.uuid)}</div>
                    <div class="text-[11px] text-gray-600">${esc((char.properties || []).join(', '))}</div>
                </div>`).join('');
            return `
                <details class="bg-dark-800/50 rounded-lg border border-gray-800">
                    <summary class="cursor-pointer px-3 py-2 text-xs text-gray-300">${esc(service.description || 'Service')} <span class="text-gray-600 font-mono">${esc(service.uuid)}</span></summary>
                    <div class="px-3 pb-3">${chars || '<div class="text-xs text-gray-500">No characteristics</div>'}</div>
                </details>`;
        }).join('');
    }

    function connectedPulseDisplayName() {
        const matchedDevice = devices.find((device) => device.address === status.address);
        const rawName = status.name || matchedDevice?.name || '';
        let name = String(rawName || '').replace(/^\*\s*/, '').trim();
        name = name
            .replace(/\s*[\u2013\u2014-]\s*(?:[0-9a-f]{2}:){2,}[0-9a-f]{2}.*$/i, '')
            .replace(/\s*\(?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)?\s*$/i, '')
            .replace(/\s*\(?[0-9a-f]{12,}\)?\s*$/i, '')
            .trim();
        if (!name || /^unknown$/i.test(name) || /^ble device$/i.test(name)) return 'Pulse';
        if (/^soundbrenner\s+pulse$/i.test(name)) return 'Pulse';
        if (/^soundbrenner\s+core$/i.test(name)) return 'Core';
        return name.length > 24 ? `${name.slice(0, 21)}...` : name;
    }

    function quickSettingsStatusText() {
        if (status.connected) return `Connected: ${connectedPulseDisplayName()}`;
        if (settings().address) return 'Disconnected; will reconnect on play';
        return status.available ? 'Disconnected' : 'BLE backend unavailable';
    }

    function updateQuickSettingsPopover(force) {
        const popover = document.getElementById('soundbrenner-sync-popover');
        if (!popover) return;
        const s = settings();
        if (!force && popover.style.display !== 'none' && popover.contains(document.activeElement)) {
            updatePatternAuditionButtonState(popover);
            updateActiveBeatVisualization(popover, s);
            return;
        }
        popover.innerHTML = `
            <div class="min-w-[250px] rounded-lg border border-gray-700 bg-dark-800/95 shadow-xl p-3 space-y-3">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-xs font-semibold text-gray-200">Soundbrenner</div>
                    <div class="text-[11px] ${status.connected ? 'text-green-400' : 'text-yellow-300'}">${esc(quickSettingsStatusText())}</div>
                </div>
                <div class="space-y-1.5">
                    ${patternHeaderHtml()}
                    ${beatStackGridHtml(s)}
                </div>
                <div class="space-y-1.5">
                    <div class="text-[11px] text-gray-500">Note rate</div>
                    ${noteRateSelectorHtml(s)}
                </div>
                <div class="space-y-1.5">
                    <div class="text-[11px] text-gray-500">Lead</div>
                    ${leadAdjusterHtml(s)}
                </div>
            </div>`;
        updatePatternAuditionButtonState(popover);
            updateActiveBeatVisualization(popover, s);
    }

    function showQuickSettingsPopover() {
        const btn = document.getElementById('btn-soundbrenner-sync');
        const popover = document.getElementById('soundbrenner-sync-popover');
        if (!btn || !popover) return;
        updateQuickSettingsPopover();
        const rect = btn.getBoundingClientRect();
        popover.style.display = 'block';
        popover.style.position = 'fixed';
        popover.style.zIndex = '9999';
        popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
        popover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
    }

    function scheduleQuickSettingsShow() {
        if (quickSettingsHideTimer) {
            window.clearTimeout(quickSettingsHideTimer);
            quickSettingsHideTimer = null;
            runtime.quickSettingsHideTimer = null;
        }
        if (quickSettingsTimer) return;
        quickSettingsTimer = window.setTimeout(() => {
            quickSettingsTimer = null;
            runtime.quickSettingsTimer = null;
            showQuickSettingsPopover();
        }, 450);
        runtime.quickSettingsTimer = quickSettingsTimer;
    }

    function hideQuickSettingsPopover() {
        if (quickSettingsTimer) {
            window.clearTimeout(quickSettingsTimer);
            quickSettingsTimer = null;
            runtime.quickSettingsTimer = null;
        }
        if (quickSettingsHideTimer) {
            window.clearTimeout(quickSettingsHideTimer);
            quickSettingsHideTimer = null;
            runtime.quickSettingsHideTimer = null;
        }
        const popover = document.getElementById('soundbrenner-sync-popover');
        if (popover) popover.style.display = 'none';
    }

    function scheduleQuickSettingsHide() {
        if (quickSettingsTimer) {
            window.clearTimeout(quickSettingsTimer);
            quickSettingsTimer = null;
            runtime.quickSettingsTimer = null;
        }
        quickSettingsHideTimer = window.setTimeout(() => {
            const btn = document.getElementById('btn-soundbrenner-sync');
            const popover = document.getElementById('soundbrenner-sync-popover');
            if (
                btn?.matches(':hover')
                || popover?.matches(':hover')
                || (popover && popover.contains(document.activeElement))
            ) {
                quickSettingsHideTimer = null;
                runtime.quickSettingsHideTimer = null;
                return;
            }
            hideQuickSettingsPopover();
            quickSettingsHideTimer = null;
            runtime.quickSettingsHideTimer = null;
        }, 700);
        runtime.quickSettingsHideTimer = quickSettingsHideTimer;
    }

    function attachQuickSettingsDocumentHandlers() {
        if (runtime.quickSettingsDocumentHandlers) return;
        const handlers = {
            pointerdown: (event) => {
                const btn = document.getElementById('btn-soundbrenner-sync');
                const popover = document.getElementById('soundbrenner-sync-popover');
                if (btn?.contains(event.target) || popover?.contains(event.target)) return;
                hideQuickSettingsPopover();
            },
            keydown: (event) => {
                if (event.key === 'Escape') hideQuickSettingsPopover();
            },
            resize: hideQuickSettingsPopover,
        };
        document.addEventListener('pointerdown', handlers.pointerdown, true);
        document.addEventListener('keydown', handlers.keydown, true);
        window.addEventListener('resize', handlers.resize);
        runtime.quickSettingsDocumentHandlers = handlers;
    }

    function injectPlayerButton() {
        const controls = document.getElementById('player-controls');
        if (!controls) return;
        document.getElementById('btn-soundbrenner-sync')?.remove();
        document.getElementById('soundbrenner-sync-popover')?.remove();
        const closeBtn = controls.querySelector('button:last-child');
        const btn = document.createElement('button');
        btn.id = 'btn-soundbrenner-sync';
        btn.type = 'button';
        btn.title = 'Toggle direct Soundbrenner BLE sync';
        btn.onclick = () => {
            const next = !settings().enabled;
            save(STORE.enabled, next);
            if (next) startWhenPlayable();
            if (!next) stopSync(true);
        };
        btn.addEventListener('mouseenter', scheduleQuickSettingsShow);
        btn.addEventListener('mouseleave', scheduleQuickSettingsHide);
        controls.insertBefore(btn, closeBtn);

        const popover = document.createElement('div');
        popover.id = 'soundbrenner-sync-popover';
        popover.style.display = 'none';
        popover.addEventListener('mouseenter', scheduleQuickSettingsShow);
        popover.addEventListener('mouseleave', scheduleQuickSettingsHide);
        popover.addEventListener('focusin', scheduleQuickSettingsShow);
        popover.addEventListener('focusout', scheduleQuickSettingsHide);
        document.body.appendChild(popover);
        attachQuickSettingsDocumentHandlers();
        updatePlayerButton();
    }

    function updatePlayerButton() {
        const btn = document.getElementById('btn-soundbrenner-sync');
        const s = settings();
        const shouldRefreshBpm = !!btn && status.connected && (s.enabled || isRunning || patternAuditionRunning);
        if (shouldRefreshBpm && !buttonRefreshTimer) {
            buttonRefreshTimer = window.setInterval(updatePlayerButton, BUTTON_BPM_REFRESH_MS);
            runtime.buttonRefreshTimer = buttonRefreshTimer;
        } else if (!shouldRefreshBpm && buttonRefreshTimer) {
            window.clearInterval(buttonRefreshTimer);
            buttonRefreshTimer = null;
            runtime.buttonRefreshTimer = null;
        }
        if (!btn) return;
        if (!s.enabled) {
            btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            btn.textContent = 'Pulse';
            btn.title = 'Toggle direct Soundbrenner BLE sync';
            updateQuickSettingsPopover();
            return;
        }
        const bpmText = formatBpm();
        if (isRunning) {
            btn.className = 'px-3 py-1.5 bg-cyan-900/50 rounded-lg text-xs text-cyan-200 transition';
            btn.textContent = bpmText;
            btn.title = `Soundbrenner sync active: ${bpmText}`;
            updateQuickSettingsPopover();
            return;
        }
        btn.className = status.connected
            ? 'px-3 py-1.5 bg-cyan-900/30 hover:bg-cyan-900/50 rounded-lg text-xs text-cyan-300 transition'
            : 'px-3 py-1.5 bg-yellow-900/30 hover:bg-yellow-900/50 rounded-lg text-xs text-yellow-300 transition';
        btn.textContent = status.connected ? bpmText : 'Pulse';
        btn.title = status.connected
            ? `Soundbrenner sync armed: ${bpmText}`
            : 'Soundbrenner sync enabled, waiting for BLE connection';
        updateQuickSettingsPopover();
    }

    function messageClass() {
        const msg = `${lastUiMessage} ${status.last_error || ''}`.toLowerCase();
        if (msg.includes('failed') || msg.includes('error') || msg.includes('unavailable')) return 'text-red-400';
        if (status.connected) return 'text-green-400';
        return 'text-gray-400';
    }

    function render() {
        const s = settings();
        const deviceOptions = [
            `<option value="">Select device...</option>`,
            ...devices.map((device) => {
                const label = `${device.likely_soundbrenner ? '* ' : ''}${device.name || 'Unknown'} — ${device.address}`;
                return `<option value="${esc(device.address)}" ${device.address === s.address ? 'selected' : ''}>${esc(label)}</option>`;
            }),
        ].join('');
        const writable = writableCharacteristics();
        const charOptions = [
            `<option value="">Select characteristic...</option>`,
            ...writable.map((char) => `<option value="${esc(char.uuid)}" ${char.uuid === s.charUuid ? 'selected' : ''}>${esc(char.label)}</option>`),
        ].join('');
        const recommended = status.recommended
            ? `${status.recommended.label} (${status.recommended.char_uuid})`
            : 'None yet';

        document.querySelectorAll('.sbs-panel').forEach((panel) => {
            panel.innerHTML = `
                <div class="bg-dark-700/50 border border-gray-800 rounded-lg p-4 space-y-4">
                    <div class="flex flex-wrap items-center gap-3">
                        <label class="flex items-center gap-2 text-sm text-gray-300">
                            <input type="checkbox" class="accent-cyan-400" ${s.enabled ? 'checked' : ''}
                                onchange="soundbrennerBleSet('enabled', this.checked)">
                            Enabled
                        </label>
                        <button type="button" onclick="soundbrennerBleScan()"
                            class="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition">Scan</button>
                        <button type="button" onclick="soundbrennerBleConnect()"
                            class="px-3 py-1.5 bg-cyan-900/40 hover:bg-cyan-900/60 rounded-lg text-xs text-cyan-200 transition">Connect</button>
                        <button type="button" onclick="soundbrennerBleDisconnect()"
                            class="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition">Disconnect</button>
                        <span class="${messageClass()} text-xs">${esc(lastUiMessage)}</span>
                    </div>

                    <label class="block">
                        <span class="block text-xs text-gray-500 mb-1">BLE device</span>
                        <select onchange="soundbrennerBleSet('address', this.value)"
                            class="w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                            ${deviceOptions}
                        </select>
                    </label>

                    <div class="grid md:grid-cols-2 gap-3">
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Pulse mode</span>
                            <select onchange="soundbrennerBleSet('mode', this.value)"
                                class="w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                                <option value="auto" ${s.mode === 'auto' ? 'selected' : ''}>Auto</option>
                                <option value="soundbrenner_pulse" ${s.mode === 'soundbrenner_pulse' ? 'selected' : ''}>Soundbrenner Pulse</option>
                                <option value="immediate_alert" ${s.mode === 'immediate_alert' ? 'selected' : ''}>Immediate Alert</option>
                                <option value="custom" ${s.mode === 'custom' ? 'selected' : ''}>Custom Write</option>
                                <option value="nordic_uart" ${s.mode === 'nordic_uart' ? 'selected' : ''}>Nordic UART</option>
                            </select>
                        </label>
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Recommended</span>
                            <div class="bg-dark-800 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-gray-400 min-h-[30px] break-all">${esc(recommended)}</div>
                        </label>
                    </div>

                    <div class="grid md:grid-cols-2 gap-3">
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Write characteristic</span>
                            <select onchange="soundbrennerBleSet('charUuid', this.value)"
                                class="w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                                ${charOptions}
                            </select>
                        </label>
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Beat drive</span>
                            <select onchange="soundbrennerBleSet('driveMode', this.value)"
                                class="w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                                <option value="hardware" ${s.driveMode === 'hardware' ? 'selected' : ''}>Hardware metronome</option>
                                <option value="preview" ${s.driveMode === 'preview' ? 'selected' : ''}>Per-beat haptic</option>
                            </select>
                        </label>
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Beat pulses</span>
                            <div class="bg-dark-600 border border-gray-700 rounded-lg px-2 py-2 space-y-2">
                                ${patternHeaderHtml()}
                                ${beatStackGridHtml(s)}
                                <div class="grid grid-cols-3 gap-2">
                                    <label class="block text-xs text-gray-300">
                                        <span class="block text-[11px] text-gray-500 mb-1">Note rate</span>
                                        <select onchange="soundbrennerBleSet('patternSubdivision', this.value)"
                                            class="w-full bg-dark-700 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 outline-none">
                                            ${subdivisionOptions(s.patternSubdivision)}
                                        </select>
                                    </label>
                                    <label class="block text-xs text-gray-300">
                                        <span class="block text-[11px] text-gray-500 mb-1">Low haptic</span>
                                        <select onchange="soundbrennerBleSet('lowEffect', this.value)"
                                            class="w-full bg-dark-700 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 outline-none">
                                            ${hapticEffectOptions(s.lowEffect)}
                                        </select>
                                    </label>
                                    <label class="block text-xs text-gray-300">
                                        <span class="block text-[11px] text-gray-500 mb-1">High haptic</span>
                                        <select onchange="soundbrennerBleSet('accentEffect', this.value)"
                                            class="w-full bg-dark-700 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 outline-none">
                                            ${hapticEffectOptions(s.accentEffect)}
                                        </select>
                                    </label>
                                </div>
                            </div>
                        </label>
                    </div>

                    <div class="grid md:grid-cols-2 gap-3">
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Medium haptic</span>
                            <select onchange="soundbrennerBleSet('effect', this.value)"
                                class="w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                                ${hapticEffectOptions(s.effect)}
                            </select>
                        </label>
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Duration: ${s.durationMs} ms</span>
                            <input type="range" min="20" max="300" step="5" value="${s.durationMs}"
                                oninput="soundbrennerBleSet('durationMs', this.value)"
                                class="w-full accent-cyan-400">
                        </label>
                    </div>

                    <div class="grid md:grid-cols-2 gap-3">
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Custom on hex</span>
                            <input type="text" value="${esc(s.onHex)}" onchange="soundbrennerBleSet('onHex', this.value)"
                                class="w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none font-mono"
                                placeholder="02">
                        </label>
                        <label class="block">
                            <span class="block text-xs text-gray-500 mb-1">Custom off hex</span>
                            <input type="text" value="${esc(s.offHex)}" onchange="soundbrennerBleSet('offHex', this.value)"
                                class="w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none font-mono"
                                placeholder="00">
                        </label>
                    </div>

                    <div class="grid md:grid-cols-2 gap-3 items-center">
                        <div class="block">
                            <span class="block text-xs text-gray-500 mb-1">Lead: ${s.leadMs} ms</span>
                            ${leadAdjusterHtml(s)}
                            <input type="range" min="-500" max="500" step="5" value="${s.leadMs}"
                                oninput="soundbrennerBleSet('leadMs', this.value)"
                                class="w-full accent-cyan-400 mt-2">
                        </div>
                        <label class="flex items-center gap-2 text-sm text-gray-300">
                            <input type="checkbox" class="accent-cyan-400" ${s.response ? 'checked' : ''}
                                onchange="soundbrennerBleSet('response', this.checked)">
                            Write with response
                        </label>
                    </div>

                    <div class="flex flex-wrap items-center gap-2">
                        <button type="button" onclick="soundbrennerBlePulse()"
                            class="px-3 py-1.5 bg-cyan-900/40 hover:bg-cyan-900/60 rounded-lg text-xs text-cyan-200 transition">Pulse Now</button>
                        <button type="button" onclick="soundbrennerBleRawWrite()"
                            class="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition">Raw Write</button>
                    </div>

                    <div class="space-y-2">
                        <div class="text-xs text-gray-500">GATT services</div>
                        ${serviceSummaryHtml()}
                    </div>
                </div>`;
        });
    }

    window.soundbrennerBleSet = function (name, value) {
        const map = {
            enabled: STORE.enabled,
            address: STORE.address,
            mode: STORE.mode,
            charUuid: STORE.charUuid,
            onHex: STORE.onHex,
            offHex: STORE.offHex,
            response: STORE.response,
            durationMs: STORE.durationMs,
            leadMs: STORE.leadMs,
            effect: STORE.effect,
            driveMode: STORE.driveMode,
            pulseHalf: STORE.pulseHalf,
            pulseQuarter: STORE.pulseQuarter,
            accentEffect: STORE.accentEffect,
            lowEffect: STORE.lowEffect,
            patternSubdivision: STORE.patternSubdivision,
            patternBeat1: STORE.patternBeat1,
            patternBeat2: STORE.patternBeat2,
            patternBeat3: STORE.patternBeat3,
            patternBeat4: STORE.patternBeat4,
        };
        if (!map[name]) return;
        if (name === 'durationMs') value = clamp(parseInt(value, 10) || 80, 20, 2000);
        if (name === 'leadMs') value = clamp(parseInt(value, 10) || 0, -500, 500);
        if (name === 'effect') value = clamp(parseInt(value, 10) || DEFAULT_HAPTIC_EFFECT, 1, 124);
        if (name === 'accentEffect') value = clamp(parseInt(value, 10) || 1, 1, 124);
        if (name === 'lowEffect') value = clamp(parseInt(value, 10) || 23, 1, 124);
        if (name === 'patternSubdivision') value = parsePatternSubdivision(value);
        if (name.startsWith('patternBeat')) value = normalizePatternProfile(value);
        if (name === 'driveMode' && value !== 'preview') value = 'hardware';
        save(map[name], value);
        const forceQuickRefresh = name === 'enabled'
            || name === 'patternSubdivision'
            || name.startsWith('patternBeat')
            || name === 'driveMode';
        if (forceQuickRefresh) updateQuickSettingsPopover(true);
        if (name === 'enabled') {
            if (value) startWhenPlayable();
            if (!value) stopSync(true);
        }
        if (patternAuditionSettingChanged(name) && patternAuditionRunning) restartPatternAudition();
        if ((name === 'driveMode' || name === 'pulseHalf' || name === 'pulseQuarter' || name === 'effect' || name === 'lowEffect' || name === 'accentEffect' || name === 'patternSubdivision' || name.startsWith('patternBeat')) && isRunning) {
            stopSync(false).then(() => {
                if (isSongPlaying()) startWhenPlayable();
            });
        }
    };

    window.soundbrennerBleTogglePatternAudition = function () {
        if (patternAuditionRunning) stopPatternAudition(true);
        else startPatternAudition();
    };

    window.soundbrennerBleCycleBeat = function (beatNumber) {
        const index = clamp(parseInt(beatNumber, 10) || 1, 1, 4) - 1;
        const current = settings().patternBeats[index];
        window.soundbrennerBleSet(`patternBeat${index + 1}`, nextPatternProfile(current));
        updateQuickSettingsPopover(true);
    };

    window.soundbrennerBleAdjustLead = function (deltaMs) {
        const delta = parseInt(deltaMs, 10) || 0;
        const next = clamp(settings().leadMs + delta, -500, 500);
        window.soundbrennerBleSet('leadMs', next);
        updateQuickSettingsPopover(true);
    };

    window.soundbrennerBleScan = scan;
    window.soundbrennerBleConnect = () => connect();
    window.soundbrennerBleDisconnect = disconnect;
    window.soundbrennerBlePulse = pulse;
    window.soundbrennerBleRawWrite = rawWrite;

    function attachEvents() {
        if (!window.slopsmith || typeof window.slopsmith.on !== 'function') return;
        const maybeStartSync = () => {
            if (settings().enabled) startWhenPlayable();
            else updatePlayerButton();
        };
        const maybeRealignSync = () => {
            lastBeatIndex = null;
            if (settings().enabled && isSongPlaying()) {
                if (isRunning) restartAfterSeek();
                else startWhenPlayable();
            } else {
                updatePlayerButton();
            }
        };
        const handlers = {
            'song:loading': () => stopForTransport(false),
            'song:ready': () => {
                injectPlayerButton();
                maybeRealignSync();
            },
            'beats:loaded': maybeRealignSync,
            'song:play': maybeStartSync,
            'song:resume': maybeStartSync,
            'song:pause': () => stopForTransport(true),
            'song:stop': () => stopForTransport(true),
            'song:ended': () => stopForTransport(true),
            'song:seek': restartAfterSeek,
            'arrangement:changed': restartAfterSeek,
        };
        runtime.eventHandlers = handlers;
        Object.entries(handlers).forEach(([eventName, handler]) => {
            window.slopsmith.on(eventName, handler);
        });
    }

    function attachAudioEvents() {
        const audio = document.getElementById('audio');
        if (!audio || runtime.audioEventHandlers) return;
        const stopFromAudio = () => stopForTransport(true);
        const startFromAudio = () => {
            if (settings().enabled) startWhenPlayable();
        };
        const handlers = {
            playing: startFromAudio,
            pause: stopFromAudio,
            ended: stopFromAudio,
        };
        Object.entries(handlers).forEach(([eventName, handler]) => {
            audio.addEventListener(eventName, handler);
        });
        runtime.audioEventHandlers = handlers;
    }

    attachEvents();
    attachAudioEvents();
    injectPlayerButton();
    render();
    refreshStatus().then(() => {
        const savedAddress = settings().address;
        if (settings().enabled && isSongPlaying()) {
            startWhenPlayable();
        } else if (settings().enabled && savedAddress && !status.connected) {
            lastUiMessage = 'Pulse armed; will reconnect on play';
            render();
            updatePlayerButton();
        }
    });
})();
