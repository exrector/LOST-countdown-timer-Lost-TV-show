'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryController } = require('../runtime.js');

function fixture(options = {}) {
  let time = 0;
  const policy = new RecoveryController({ now: () => time, ...options });
  return { policy, at(value) { time = value; } };
}

test('initial grace, unknown roles, and late display availability', () => {
  const { policy, at } = fixture();
  assert.equal(policy.shouldRecover('unknown'), false);
  policy.observe('timer', { connected: false, processAlive: false, available: false });
  at(29999);
  assert.equal(policy.shouldRecover('timer'), false);
  at(30000);
  assert.equal(policy.shouldRecover('timer'), false);
  policy.observe('timer', { connected: false, available: true });
  assert.equal(policy.shouldRecover('timer'), true);
});

test('fresh connected windows do not launch; heartbeat expiry triggers recovery', () => {
  const { policy, at } = fixture();
  policy.observe('terminal', { connected: true, lastHeartbeat: 0, processAlive: true });
  at(44999);
  assert.equal(policy.beginAttempt('terminal'), false);
  at(45000);
  assert.equal(policy.beginAttempt('terminal'), true);
  assert.equal(policy.beginAttempt('terminal'), false);
  at(46000);
  policy.observe('terminal', { connected: true, lastHeartbeat: 46000 });
  assert.equal(policy.completeAttempt('terminal', { launched: true }), true);
  assert.equal(policy.shouldRecover('terminal'), false);
});

test('observing a connection repeatedly without a heartbeat cannot postpone expiry', () => {
  const { policy, at } = fixture();
  policy.observe('timer', { connected: true });
  at(40000);
  policy.observe('timer', { connected: true });
  at(45000);
  assert.equal(policy.shouldRecover('timer'), true);
});

test('dead, untracked, and disconnected live windows all recover independently', () => {
  const { policy, at } = fixture();
  for (const [role, processAlive] of [['dead', false], ['untracked', undefined], ['orphan', true]]) {
    policy.observe(role, { connected: false, processAlive });
  }
  at(30000);
  assert.equal(policy.beginAttempt('dead'), true);
  assert.equal(policy.shouldRecover('untracked'), true);
  assert.equal(policy.shouldRecover('orphan'), true);
  policy.observe('orphan', { connected: false, available: false });
  assert.equal(policy.beginAttempt('orphan'), false);
});

test('failed retries back off to the configured cap and healthy observation resets them', () => {
  const { policy, at } = fixture({ startupGraceMs: 0 });
  policy.observe('timer', { connected: false });
  let time = 0;
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    assert.equal(policy.beginAttempt('timer'), true);
    assert.equal(policy.completeAttempt('timer'), true);
    assert.equal(policy.completeAttempt('timer'), false);
    at(time + delay - 1);
    assert.equal(policy.shouldRecover('timer'), false);
    time += delay;
    at(time);
    assert.equal(policy.shouldRecover('timer'), true);
  }
  policy.observe('timer', { connected: true, lastHeartbeat: time });
  policy.observe('timer', { connected: false });
  assert.equal(policy.beginAttempt('timer'), true);
  policy.completeAttempt('timer');
  at(time + 5000);
  assert.equal(policy.shouldRecover('timer'), true);
});

test('successful spawn gets grace, but unsuccessful startup still accumulates backoff', () => {
  const { policy, at } = fixture();
  policy.observe('timer', { connected: false });
  at(30000);
  assert.equal(policy.beginAttempt('timer'), true);
  policy.completeAttempt('timer', { launched: true });
  at(59999);
  assert.equal(policy.shouldRecover('timer'), false);
  at(60000);
  assert.equal(policy.beginAttempt('timer'), true);
  policy.completeAttempt('timer');
  at(69999);
  assert.equal(policy.shouldRecover('timer'), false);
  at(70000);
  assert.equal(policy.shouldRecover('timer'), true);
});

test('stop blocks recovery even after pending attempt finishes and snapshots change', () => {
  const { policy, at } = fixture({ startupGraceMs: 0 });
  policy.observe('terminal', { connected: false });
  assert.equal(policy.beginAttempt('terminal'), true);
  policy.stop();
  policy.completeAttempt('terminal');
  at(1000000);
  policy.observe('terminal', { connected: false });
  assert.equal(policy.shouldRecover('terminal'), false);
  assert.equal(policy.beginAttempt('terminal'), false);
});

test('invalid configuration and invalid heartbeat timestamps fail early', () => {
  assert.throws(() => fixture({ retryDelayMs: -1 }), RangeError);
  assert.throws(() => fixture({ maxRetryDelayMs: 1 }), RangeError);
  const { policy } = fixture();
  assert.throws(() => policy.observe('', {}), TypeError);
  assert.throws(() => policy.observe('timer', { lastHeartbeat: NaN }), TypeError);
});
