'use strict';

const { performance } = require('node:perf_hooks');

const timeline = require('../js/lost-timeline');
const DEFAULT_SECONDS = timeline.duration;
const FAILURE_SECONDS = timeline.failureDuration;
const PERIOD = DEFAULT_SECONDS + FAILURE_SECONDS;

class StationClock {
    constructor(saved = {}, { now = () => performance.now(), liveInDev = false } = {}) {
        this._now = now;
        this._liveInDev = liveInDev;
        this._mode = saved.mode === 'dev' ? 'dev' : 'live';
        this._slots = {};
        for (const mode of ['live', 'dev']) {
            const slot = saved[mode] || {};
            this._slots[mode] = {
                left: typeof slot.left === 'number' && Number.isFinite(slot.left) ? slot.left : DEFAULT_SECONDS,
                paused: slot.paused === true,
                cycle: 0
            };
            this._normalize(this._slots[mode]);
        }
        // Persisted values resume from this instant; application downtime is excluded.
        this._last = this._now();
    }

    get mode() { return this._mode; }

    _normalize(slot) {
        if (slot.left <= -FAILURE_SECONDS) {
            const cycles = Math.floor((-FAILURE_SECONDS - slot.left) / PERIOD) + 1;
            slot.left += cycles * PERIOD;
            slot.cycle += cycles;
        }
    }

    _settle() {
        const current = this._now();
        const elapsed = Math.max(0, current - this._last) / 1000;
        this._last = current;
        for (const mode of ['live', 'dev']) {
            const slot = this._slots[mode];
            if (!slot.paused && (mode === this._mode || (mode === 'live' && this._liveInDev))) {
                slot.left -= elapsed;
                this._normalize(slot);
            }
        }
    }

    // mode — какой таймер: по умолчанию текущий; пульт всегда просит 'live' (Dev — только для разработки).
    _slot(mode) {
        if (mode !== 'live' && mode !== 'dev') throw new RangeError('Unknown clock mode');
        return this._slots[mode];
    }

    sample(mode = this._mode) {
        this._settle();
        const slot = this._slot(mode);
        return {
            mode,
            left: Math.max(0, Math.ceil(slot.left)),
            rawLeft: slot.left,
            paused: slot.paused,
            phase: slot.left > -timeline.failure.zeroHold ? 'countdown' : 'failure',
            failureAge: Math.max(0, Math.floor(-slot.left - timeline.failure.zeroHold)),
            rawFailureAge: Math.max(0, -slot.left - timeline.failure.zeroHold),
            cycle: slot.cycle
        };
    }

    snapshot() {
        this._settle();
        const result = { mode: this._mode };
        for (const mode of ['live', 'dev']) {
            const slot = this._slots[mode];
            result[mode] = { left: slot.left, paused: slot.paused };
        }
        return result;
    }

    setMode(mode) {
        if (mode !== 'live' && mode !== 'dev') throw new RangeError('Unknown clock mode');
        this._settle();
        this._mode = mode;
    }

    setPaused(paused, mode = this._mode) {
        this._settle();
        this._slot(mode).paused = Boolean(paused);
    }

    reset(seconds = DEFAULT_SECONDS, mode = this._mode) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || !Number.isInteger(seconds)) {
            throw new RangeError('Reset seconds must be a finite nonnegative integer');
        }
        this._settle();
        const slot = this._slot(mode);
        slot.left = seconds;
        slot.cycle += 1;
    }
}

module.exports = { StationClock };
