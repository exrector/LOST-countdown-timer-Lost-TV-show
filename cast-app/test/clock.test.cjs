'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StationClock } = require('../clock');

function fixture(saved = {}, options = {}) {
    let ms = 1000;
    const clock = new StationClock(saved, { ...options, now: () => ms });
    return { clock, advance: seconds => { ms += seconds * 1000; } };
}

test('missed callbacks consume monotonic elapsed time', () => {
    const { clock, advance } = fixture();
    advance(20);
    assert.equal(clock.sample().left, 6460);
    advance(.25);
    assert.equal(clock.sample().left, 6460);
    assert.equal(clock.sample().rawLeft, 6459.75);
});

test('pause and resume retain fractions without counting paused time', () => {
    const { clock, advance } = fixture();
    advance(.375); clock.setPaused(true);
    advance(100); assert.equal(clock.sample().rawLeft, 6479.625);
    clock.setPaused(false); advance(.625);
    assert.equal(clock.sample().rawLeft, 6479);
});

test('inactive slots freeze by default, including switching with no sample', () => {
    const { clock, advance } = fixture();
    advance(5); clock.setMode('dev');
    advance(20); clock.setMode('live');
    assert.equal(clock.sample().left, 6475);
    assert.equal(clock.snapshot().dev.left, 6460);
});

test('liveInDev runs live while dev runs, but freezes inactive dev', () => {
    const { clock, advance } = fixture({}, { liveInDev: true });
    advance(5); clock.setMode('dev'); advance(20); clock.setMode('live');
    assert.equal(clock.sample().left, 6455);
    advance(10);
    assert.equal(clock.snapshot().dev.left, 6460);
    assert.equal(clock.snapshot().live.left, 6445);
});

test('paused background live remains paused', () => {
    const { clock, advance } = fixture({ live: { left: 12, paused: true } }, { liveInDev: true });
    clock.setMode('dev'); advance(20);
    assert.equal(clock.snapshot().live.left, 12);
});

test('snapshot restores fractions and modes, excludes downtime, resets cycle counters', () => {
    const { clock, advance } = fixture();
    advance(.125); clock.setPaused(true); clock.setMode('dev'); clock.reset(120);
    advance(.25);
    const saved = clock.snapshot();
    const restored = new StationClock(saved, { now: () => 100000000 });
    assert.deepEqual(restored.snapshot(), saved);
    assert.equal(restored.sample().cycle, 0);
    assert.equal(saved.live.left, 6479.875);
    assert.equal(saved.dev.left, 119.75);
});

test('original zero hold precedes glyphs; full 70s sequence preserves overshoot', () => {
    const { clock, advance } = fixture({ live: { left: 10 } });
    advance(10);
    assert.equal(clock.sample().phase, 'countdown');
    assert.equal(clock.sample().left, 0);
    advance(2);
    assert.equal(clock.sample().phase, 'failure');
    assert.equal(clock.sample().failureAge, 0);
    advance(67.75);
    assert.equal(clock.sample().failureAge, 67);
    advance(.25);
    assert.equal(clock.sample().phase, 'countdown');
    assert.equal(clock.sample().left, 6480);
    assert.equal(clock.sample().cycle, 1);
    advance(6550.5);
    assert.equal(clock.sample().rawLeft, 6479.5);
    assert.equal(clock.sample().cycle, 2);
});

test('many elapsed cycles are reduced arithmetically with no drift', () => {
    const { clock, advance } = fixture();
    advance(6550 * 100000000 + 20.25);
    assert.equal(clock.sample().cycle, 100000000);
    assert.equal(clock.sample().rawLeft, 6459.75);
});

test('reset settles both slots, increments only its mode, and preserves pause', () => {
    const { clock, advance } = fixture({}, { liveInDev: true });
    clock.setMode('dev'); advance(2.5); clock.setPaused(true); clock.reset(30);
    assert.equal(clock.sample().cycle, 1);
    assert.equal(clock.sample().paused, true);
    assert.equal(clock.snapshot().live.left, 6477.5);
    clock.setMode('live'); assert.equal(clock.sample().cycle, 0);
    assert.throws(() => clock.reset(-1), RangeError);
    assert.throws(() => clock.setMode('other'), RangeError);
});

test('null and invalid saved time default to 108 minutes; failure restores', () => {
    const { clock } = fixture({ live: { left: null }, dev: { left: NaN } });
    assert.equal(clock.snapshot().live.left, 6480);
    assert.equal(clock.snapshot().dev.left, 6480);
    const failure = fixture({ live: { left: -12.5, paused: true } }).clock.sample();
    assert.equal(failure.phase, 'failure');
    assert.equal(failure.failureAge, 10);
});
