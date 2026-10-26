'use strict';
// «Пламя» — станция связи DHARMA. Узлы tailnet читаются локальным `tailscale status --json`:
// только чтение, без ключей API. В LOST попадают имя устройства, ОС, связь и время последнего контакта — не адреса.
// Какая машина какой станцией называется, лежит вне репозитория: ~/.config/lost/flame.json.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const runDefault = promisify(require('node:child_process').execFile);

const CANDIDATES = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
const clip = (value, size) => String(value == null ? '' : value).replace(/[\x00-\x1f\x7f]/g, '').slice(0, size);
const deviceKey = node => clip(String(node.DNSName || '').split('.')[0] || node.HostName, 63).toLowerCase();
function lastSeen(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) && time > Date.UTC(2000, 0, 1) ? time : null;
}
function loadStations(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && typeof data.stations === 'object' && !Array.isArray(data.stations) ? data.stations : {};
    } catch (_) { return {}; }
}
function parseStatus(json, stations = {}) {
    const data = JSON.parse(json);
    const backend = clip(data.BackendState, 32);
    const nodes = [data.Self && { ...data.Self, self: true }, ...Object.values(data.Peer || {})].filter(Boolean);
    const list = nodes.map(node => {
        const key = deviceKey(node), known = stations[key] && typeof stations[key] === 'object' ? stations[key] : null;
        return {
            key, device: key.toUpperCase(), os: clip(node.OS, 16),
            station: known ? clip(known.station, 40) : '', number: known && known.number != null ? clip(known.number, 3) : '',
            online: node.self ? backend === 'Running' : node.Online === true,
            lastSeen: node.self ? null : lastSeen(node.LastSeen), self: !!node.self,
        };
    });
    // Своя станция первой, затем станции с номером, затем остальные на связи, затем молчащие, неопознанные в конце.
    const rank = s => s.self ? 0 : !s.station ? 4 : s.number ? 1 : s.online ? 2 : 3;
    list.sort((a, b) => rank(a) - rank(b) || (Number(a.number) || 99) - (Number(b.number) || 99) || a.station.localeCompare(b.station, 'ru') || a.device.localeCompare(b.device));
    return { backend, stations: list };
}
function createFlame({ tailscale, stationsFile = path.join(os.homedir(), '.config/lost/flame.json'), run = runDefault, exists = fs.existsSync, now = Date.now, intervalMs = 60000, minGapMs = 5000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
    const binary = tailscale || CANDIDATES.find(file => exists(file)) || null;
    let enabled = true, busy = null, timer = null, generation = 0, lastAttempt = -Infinity;
    let state = { status: binary ? 'starting' : 'not_installed', backend: '', stations: [], updatedAt: 0, error: binary ? null : 'Tailscale на станции не найден' };
    function snapshot() {
        if (!enabled) return { installed: !!binary, enabled, status: 'disabled', backend: '', stations: [], updatedAt: 0, error: null };
        return { installed: !!binary, enabled, ...state };
    }
    async function read(own) {
        lastAttempt = now();
        try {
            const result = await run(binary, ['status', '--json'], { timeout: 8000, maxBuffer: 1048576, encoding: 'utf8' });
            const parsed = parseStatus(result.stdout, loadStations(stationsFile));
            if (own === generation) state = { ...parsed, status: parsed.backend === 'Running' ? 'ready' : 'unavailable', updatedAt: now(), error: parsed.backend === 'Running' ? null : 'Tailscale на станции: ' + (parsed.backend || 'нет состояния') };
        } catch (_) {
            if (own === generation) state = { status: 'unavailable', backend: '', stations: [], updatedAt: now(), error: 'Нет ответа Tailscale на станции' };
        }
    }
    function refresh({ force = false } = {}) {
        if (!enabled || !binary) return Promise.resolve(snapshot());
        if (busy) return busy.then(snapshot);
        if (!force && now() - lastAttempt < minGapMs) return Promise.resolve(snapshot());
        busy = read(generation).finally(() => { busy = null; });
        return busy.then(snapshot);
    }
    function setEnabled(on) {
        if (typeof on !== 'boolean') return false;
        enabled = on; generation++;
        if (timer !== null) clearTimer(timer); timer = null;
        if (on && binary) { refresh({ force: true }); timer = setTimer(() => refresh({ force: true }), intervalMs); timer?.unref?.(); }
        return snapshot();
    }
    return { snapshot, refresh, setEnabled, close() { setEnabled(false); } };
}
module.exports = { createFlame, parseStatus, loadStations };
