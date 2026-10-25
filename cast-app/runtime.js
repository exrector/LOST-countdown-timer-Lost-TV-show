'use strict';

/**
 * Pure recovery policy; this module never launches or terminates processes.
 *
 * new RecoveryController({ now: () => Date.now(), retryDelayMs: 5000,
 *   startupGraceMs: 30000, heartbeatTimeoutMs: 45000,
 *   maxRetryDelayMs: 60000 })
 *
 * observe(role, { connected, lastHeartbeat?, processAlive?, available? })
 *   supplies a complete current snapshot (available defaults to true).
 *   Heartbeats are millisecond timestamps in the injected clock's time domain.
 *   Without a heartbeat, a connected window gets heartbeatTimeoutMs from its
 *   first connected observation. Repeated observations do not extend that time.
 *   processAlive is diagnostic: a disconnected live process may also need repair.
 * shouldRecover(role) is read-only. Unknown roles never recover.
 * beginAttempt(role) atomically claims a due recovery; returns false if not due.
 * completeAttempt(role, { launched = false } = {}) releases that claim.
 *   A successful launch gets startup grace to connect; failure gets retry delay.
 *   Consecutive attempts back off exponentially, capped at maxRetryDelayMs.
 *   Only a healthy observation resets backoff; spawning alone is not health.
 * stop() permanently blocks new attempts; it does not kill existing processes.
 *
 * Initial startup grace allows late windows/displays to appear. An unavailable
 * display blocks launches even after grace. The integration must always complete
 * a claimed attempt in finally, including when its own async launch times out.
 * Use a monotonic clock, or Date.now() if system-clock changes are acceptable.
 */
class RecoveryController {
  constructor({
    now = Date.now,
    retryDelayMs = 5000,
    startupGraceMs = 30000,
    heartbeatTimeoutMs = 45000,
    maxRetryDelayMs = 60000,
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    for (const [name, value] of Object.entries({ retryDelayMs, startupGraceMs, heartbeatTimeoutMs, maxRetryDelayMs })) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
    }
    if (maxRetryDelayMs < retryDelayMs) throw new RangeError('maxRetryDelayMs must be >= retryDelayMs');
    this.now = now;
    this.retryDelayMs = retryDelayMs;
    this.startupGraceMs = startupGraceMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.startedAt = now();
    this.roles = new Map();
    this.stopped = false;
  }

  observe(role, { connected = false, lastHeartbeat, processAlive, available = true } = {}) {
    if (typeof role !== 'string' || !role) throw new TypeError('role must be a nonempty string');
    if (lastHeartbeat != null && !Number.isFinite(lastHeartbeat)) throw new TypeError('lastHeartbeat must be a finite timestamp');
    const time = this.now();
    const state = this.roles.get(role) || {
      connected: false, connectedAt: null, attempts: 0, inFlight: false, nextAttemptAt: 0,
    };
    if (connected && !state.connected) state.connectedAt = time;
    if (!connected) state.connectedAt = null;
    state.connected = Boolean(connected);
    state.available = Boolean(available);
    state.processAlive = processAlive;
    state.lastHeartbeat = lastHeartbeat == null ? null : Math.min(lastHeartbeat, time);
    if (this.isHealthy(state, time)) {
      state.attempts = 0;
      state.nextAttemptAt = 0;
    }
    this.roles.set(role, state);
  }

  isHealthy(state, time) {
    return state.connected && time - (state.lastHeartbeat ?? state.connectedAt) < this.heartbeatTimeoutMs;
  }

  shouldRecover(role) {
    const state = this.roles.get(role);
    const time = this.now();
    return Boolean(!this.stopped && state && state.available && !state.inFlight
      && time >= this.startedAt + this.startupGraceMs
      && time >= state.nextAttemptAt && !this.isHealthy(state, time));
  }

  beginAttempt(role) {
    if (!this.shouldRecover(role)) return false;
    const state = this.roles.get(role);
    state.inFlight = true;
    state.attempts += 1;
    return true;
  }

  completeAttempt(role, { launched = false } = {}) {
    const state = this.roles.get(role);
    if (!state || !state.inFlight) return false;
    state.inFlight = false;
    const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** Math.min(1023, Math.max(0, state.attempts - 1)));
    state.nextAttemptAt = this.now() + Math.max(delay, launched ? this.startupGraceMs : 0);
    return true;
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = { RecoveryController };
