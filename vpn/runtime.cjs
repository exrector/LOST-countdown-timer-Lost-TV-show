'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { domainToASCII } = require('node:url');
const { promisify } = require('node:util');
const runDefault = promisify(require('node:child_process').execFile);
const stripANSI = text => String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
function safeOutput(text) {
    return stripANSI(text).split('\n').map(line => /(?:password|username|token|secret|credential)/i.test(line) ? '[СКРЫТО]' : line).join('\n').slice(0, 65536);
}
function parseStatus(text) {
    text = stripANSI(text).trim();
    const connected = text.match(/(?:^|\n)Connected to\s+(.+?)(?:\s+in\s+(?:TUN|SOCKS?)\b|\s*\n|$)/i);
    if (connected && connected[1].trim()) return { status: 'connected', location: connected[1].trim().toUpperCase().slice(0, 100) };
    if (/^(?:Disconnected|Not connected|VPN is (?:not connected|disconnected)|AdGuard VPN is (?:not connected|disconnected))(?:[.!\s]|$)/i.test(text)) return { status: 'disconnected', location: '' };
    if (/^(?:Connecting|Reconnecting)(?:\s|\.|$)/i.test(text)) return { status: 'connecting', location: '' };
    return null;
}
// 2026-11-13: здоровье туннеля от монитора роутера (команда health). CLI пишет «Connected», даже когда
// заграница через туннель не отвечает; монитор (adguard-vpn-monitor, проверка раз в 30 с, подтверждение двумя
// проверками) это видит. Здесь — только состояния, которые означают проблему именно VPN: туннель, kill switch, DNS.
// provider_path_unavailable (нет провайдера) и split_bypass_failure (не открываются исключения .ru) — не сюда.
const FAULTS = {
    adguard_tunnel_failure_split_alive: 'tunnel', adguard_total_failure: 'tunnel', adguard_route_missing: 'tunnel',
    adguard_killswitch_missing: 'killswitch', adguard_dns_failure: 'dns',
};
const FAULT_LINE = { tunnel: 'TUNNEL FAILURE', killswitch: 'KILL SWITCH OFF', dns: 'DNS FAILURE' };
const LAST_FAULT_MS = 3600000; // строка час помнит последний сбой — минутные сбои проходят между опросами
function parseHealth(text) {
    const kv = {}, events = [];
    for (const line of stripANSI(text).split('\n')) {
        const m = line.trim().match(/^([a-z_]+)=(.*)$/); if (!m) continue;
        if (m[1] === 'event') {
            const [at, from, to, dur] = m[2].trim().split(/\s+/);
            if (/^\d+$/.test(at) && /^\d+$/.test(dur) && /^[a-z_]+$/.test(from) && /^[a-z_]+$/.test(to)) events.push({ at: Number(at) * 1000, from, to, duration: Number(dur) * 1000 });
        } else kv[m[1]] = m[2].trim();
    }
    if (!/^[a-z_]+$/.test(kv.state || '')) return null;
    return { state: kv.state, since: /^\d+$/.test(kv.since || '') ? Number(kv.since) * 1000 : 0, alive: kv.monitor === 'alive', events };
}
function domain(value) {
    if (typeof value !== 'string' || value.length > 253 || /[\s/@:*?\\]/.test(value)) throw Error('invalid_value');
    const ascii = domainToASCII(value.toLowerCase());
    if (!ascii || ascii.length > 253 || !ascii.includes('.') || !ascii.split('.').every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))) throw Error('invalid_value');
    return ascii;
}
function mode(value) { if (!['general', 'selective'].includes(value)) throw Error('invalid_value'); return value; }
const settings = {
    'set-mode': /^(TUN|SOCKS)$/,
    'set-dns': /^[a-zA-Z0-9][a-zA-Z0-9.:/_%\[\]-]{0,252}$/,
    'set-socks-host': /^(localhost|[0-9a-fA-F:.\[\]]{2,64})$/,
    'set-change-system-dns': /^(on|off)$/,
    'set-tun-routing-mode': /^(AUTO|SCRIPT|NONE)$/,
    'set-post-quantum': /^(on|off)$/,
    'set-debug-logging': /^(on|off)$/,
    'set-show-hints': /^(on|off)$/,
    'set-show-notifications': /^(on|off)$/,
    'set-update-channel': /^(release|beta|nightly)$/,
    'set-crash-reporting': /^(on|off)$/,
    'set-telemetry': /^(on|off)$/,
    'set-bound-if-override': /^[a-zA-Z0-9_.:-]{0,32}$/,
};
function commandFor(action, value) {
    if (['status', 'health', 'locations', 'license', 'config', 'guard', 'version', 'check-update', 'fastest', 'last', 'disconnect', 'update', 'logout', 'export-logs'].includes(action)) {
        if (value !== undefined && value !== null && value !== '') throw Error('invalid_value');
        return action;
    }
    if (action === 'connect') {
        if (typeof value !== 'string' || value.length < 1 || value.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9 ()'.-]*$/.test(value)) throw Error('invalid_value');
        return 'connect ' + value;
    }
    if (['exclusions-show', 'exclusions-mode', 'exclusions-clear'].includes(action)) return action + ' ' + mode(value);
    if (['exclusions-add', 'exclusions-remove'].includes(action) && value && typeof value === 'object') return action + ' ' + mode(value.mode) + ' ' + domain(value.domain);
    if (action === 'protocol' && ['auto', 'http2', 'quic'].includes(value)) return 'protocol ' + value;
    if (action === 'setting' && value && typeof value === 'object') {
        const name = value.name, v = value.value;
        if (typeof v !== 'string') throw Error('invalid_value');
        if (name === 'set-socks-port') { if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) throw Error('invalid_value'); }
        else if (!Object.hasOwn(settings, name) || !settings[name].test(v)) throw Error('invalid_value');
        return 'setting ' + name + ' ' + (v === '' ? '-' : v);
    }
    throw Error('invalid_action');
}
function validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(cfg.host || '') || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(cfg.user || '') || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw Error('invalid_configuration');
    const result = { ...cfg };
    for (const key of ['identityFile', 'knownHostsFile']) {
        const file = cfg[key];
        if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw Error('invalid_configuration');
    }
    return result;
}
// autoPoll: false — свой таймер не заводится, опрашивает общий цикл станции (cast-app/start.js, раз в 2 мин).
// 2026-11-13: красная плашка «VPN» на экранах станции. Решение о тревоге принимает ядро (snapshot().alert),
//   окна только рисуют. Пороги: DISCONNECTED — сразу (роутер прямо говорит, что VPN выключен, а kill switch
//   держит дом без интернета); CONNECTING — дольше connectingAlertMs (короткое переподключение — норма);
//   NO DATA — дольше noDataAlertMs: это может быть сбой связи mini → роутер, а не самого VPN, поэтому позже.
//   Неудачное чтение статуса повторяется один раз через retryDelayMs — разовый сбой SSH больше не даёт
//   «NO DATA» на весь двухминутный цикл. Каждая смена состояния и причина отказа пишутся в журнал (log),
//   раньше причины NO DATA нигде не оставалось.
const ALERT_TEXT = { down: 'VPN LINK DOWN', connecting: 'VPN RECONNECTING', nodata: 'VPN NO DATA', tunnel: 'VPN TUNNEL FAILURE', killswitch: 'VPN KILL SWITCH OFF', dns: 'VPN DNS FAILURE' };
function failureReason(error) {
    if (!error) return 'неизвестно';
    if (error.name === 'AbortError') return 'прервано';
    if (error.killed || error.signal === 'SIGTERM') return 'таймаут';
    const err = stripANSI(error.stderr || '').trim().split('\n').filter(x => x && !/post-quantum|store now|openssh\.com\/pq|may need to be upgraded/i.test(x)).pop() || '';
    return ('ssh код ' + (error.code ?? '?') + (err ? ': ' + err : '')).slice(0, 200);
}
function createVPN({ configFile = path.join(os.homedir(), '.config/lost/vpn.json'), config, run = runDefault, now = Date.now, intervalMs = 60000, staleMs = 90000, autoPoll = true, setTimer = setInterval, clearTimer = clearInterval, log = () => {}, retryDelayMs = 4000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), connectingAlertMs = 180000, noDataAlertMs = 300000 } = {}) {
    let cfg, installed = false;
    try { cfg = validateConfig(config || JSON.parse(fs.readFileSync(configFile, 'utf8'))); installed = true; } catch (_) {}
    let enabled = true, busy = false, timer = null, generation = 0, lastAttempt = -Infinity, activeAbort = null;
    // since — когда началось текущее состояние (для порогов тревоги); при старте ядра — момент старта.
    let state = { status: 'unavailable', location: '', updatedAt: 0, since: now(), error: installed ? null : 'VPN-доступ не настроен' };
    let lastLogged = '', testUntil = 0, testText = ALERT_TEXT.down;
    // health — последнее прочитанное здоровье туннеля: { state, since, alive, events, checkedAt }
    let health = null, lastHealthNote = '';
    function healthNote(text) { if (text !== lastHealthNote) { lastHealthNote = text; try { log('[vpn] ' + text); } catch (_) {} } }
    function faultNow(value) {
        if (value.status !== 'connected' || !health || !health.alive || now() - health.checkedAt > staleMs) return null;
        const code = FAULTS[health.state]; return code ? { code, text: FAULT_LINE[code], state: health.state, since: health.since } : null;
    }
    function lastFault() {
        if (!health) return null;
        for (let i = health.events.length - 1; i >= 0; i--) {
            const e = health.events[i];
            if (FAULTS[e.from] && e.to === 'healthy') {
                if (now() - e.at > LAST_FAULT_MS) return null;
                return { code: FAULTS[e.from], text: FAULT_LINE[FAULTS[e.from]], startedAt: e.at - e.duration, endedAt: e.at, duration: e.duration };
            }
        }
        return null;
    }
    // Проверка плашки без выключения VPN роутера (через него идёт интернет дома): на seconds секунд
    // snapshot().alert показывает тревогу с пометкой test. Сам VPN и показания не трогаются.
    function testAlert(seconds, code = 'down') {
        const s = Number(seconds); if (!Number.isFinite(s) || s < 0 || s > 300 || !Object.hasOwn(ALERT_TEXT, code)) return false;
        testUntil = s ? now() + s * 1000 : 0; testText = ALERT_TEXT[code]; try { log('[vpn] проверка плашки: ' + (s ? testText + ' на ' + s + ' с' : 'снята')); } catch (_) {}
        return true;
    }
    function note(text) { if (text !== lastLogged) { lastLogged = text; try { log('[vpn] ' + text); } catch (_) {} } }
    function alertFor(value) {
        if (!installed || !enabled) return null;
        if (now() < testUntil) return { code: 'test', text: testText };
        const age = now() - (value.since || 0);
        if (value.status === 'disconnected') return { code: 'down', text: ALERT_TEXT.down };
        if (value.fault) return { code: value.fault.code, text: ALERT_TEXT[value.fault.code] };
        if (value.status === 'connecting' && age >= connectingAlertMs) return { code: 'connecting', text: ALERT_TEXT.connecting };
        if (value.status === 'unavailable' && age >= noDataAlertMs) return { code: 'nodata', text: ALERT_TEXT.nodata };
        return null;
    }
    function snapshot() {
        let value = { installed, enabled, ...state, busy };
        if (!enabled) return { ...value, status: 'disabled', location: '', error: null, alert: null, fault: null, lastFault: null };
        // устаревшие показания = NO DATA с момента последнего удачного чтения
        if (['connected', 'disconnected', 'connecting'].includes(value.status) && now() - value.updatedAt > staleMs) value = { ...value, status: 'unavailable', location: '', since: value.updatedAt, error: 'Показания VPN устарели' };
        value = { ...value, fault: faultNow(value), lastFault: lastFault() };
        return { ...value, alert: alertFor(value) };
    }
    function setState(next) {
        const since = next.status === state.status ? state.since : now();
        state = { ...next, since };
    }
    async function remote(command) {
        if (!installed) throw Error('not_installed');
        const args = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'UserKnownHostsFile=' + cfg.knownHostsFile, '-i', cfg.identityFile, '-p', String(cfg.port), cfg.user + '@' + cfg.host, command];
        const controller = new AbortController(); activeAbort = controller;
        try {
            const result = await run('/usr/bin/ssh', args, { timeout: ['update', 'fastest', 'last'].includes(command) || command.startsWith('connect ') ? 60000 : command === 'locations' ? 30000 : 12000, maxBuffer: 262144, encoding: 'utf8', signal: controller.signal });
            return stripANSI(result.stdout);
        } catch (error) {
            if (command === 'status' && parseStatus(error.stdout)?.status === 'disconnected') return stripANSI(error.stdout);
            const failure = Error('router_unavailable'); failure.reason = failureReason(error); throw failure;
        } finally { if (activeAbort === controller) activeAbort = null; }
    }
    // record=false — попытка, после которой будет повтор: показания не портятся раньше времени.
    async function readStatus(ownGeneration, record = true) {
        lastAttempt = now();
        try {
            const output = await remote('status'), parsed = parseStatus(output);
            if (!parsed) { const e = Error('unknown_status'); e.reason = 'непонятный ответ роутера: ' + JSON.stringify(output.trim().split('\n')[0] || '').slice(0, 160); throw e; }
            if (enabled && generation === ownGeneration) { setState({ ...parsed, updatedAt: now(), error: null }); note(parsed.status + (parsed.location ? ' ' + parsed.location : '')); }
            return output;
        } catch (error) {
            if (record && enabled && generation === ownGeneration) { setState({ status: 'unavailable', location: '', updatedAt: now(), error: 'Не удалось прочитать состояние VPN роутера' }); note('нет данных — ' + (error.reason || error.message)); }
            const failure = Error('router_unavailable'); failure.reason = error.reason || error.message; throw failure;
        }
    }
    // Повтор не раньше, чем через полинтервала: таймер срабатывает чуть раньше intervalMs после прошлой попытки,
    // и при строгом «< intervalMs» каждый второй опрос пропускался — опрос шёл раз в 120 с, а показания
    // старше staleMs (90 с) «устаревали» (28.10, ответ «статус»: VPN: НЕТ ДАННЫХ — ПОКАЗАНИЯ VPN УСТАРЕЛИ).
    // Здоровье туннеля — вторым коротким запросом в том же цикле, только после удачного статуса. Ошибка здесь
    // не портит статус: без монитора LOST просто видит то же, что раньше (только CLI).
    async function readHealth(ownGeneration) {
        try {
            const parsed = parseHealth(await remote('health'));
            if (!parsed) throw Object.assign(Error('unknown_health'), { reason: 'непонятный ответ монитора' });
            if (enabled && generation === ownGeneration) {
                health = { ...parsed, checkedAt: now() };
                healthNote(parsed.alive ? 'туннель: ' + parsed.state : 'монитор VPN на роутере не работает (последнее: ' + parsed.state + ')');
            }
        } catch (error) { healthNote('здоровье туннеля недоступно — ' + (error.reason || error.message)); }
    }
    async function refresh({ force = false } = {}) {
        if (!enabled || !installed || busy || !force && now() - lastAttempt < intervalMs / 2) return snapshot();
        busy = true; const ownGeneration = generation;
        try {
            try { await readStatus(ownGeneration, retryDelayMs <= 0); }
            catch (error) {
                if (retryDelayMs <= 0) throw error;
                try { log('[vpn] чтение статуса не удалось (' + (error.reason || error.message) + '), повтор через ' + Math.round(retryDelayMs / 1000) + ' с'); } catch (_) {}
                await sleep(retryDelayMs);
                if (enabled && generation === ownGeneration) await readStatus(ownGeneration);
            }
            if (enabled && generation === ownGeneration) await readHealth(ownGeneration);
        } catch (_) {} finally { busy = false; }
        return snapshot();
    }
    async function execute(action, value) {
        let command;
        try { command = commandFor(action, value); } catch (error) { return { ok: false, error: error.message, state: snapshot() }; }
        if (!enabled || !installed) return { ok: false, error: !enabled ? 'disabled' : 'not_installed', state: snapshot() };
        if (busy) return { ok: false, error: 'busy', state: snapshot() };
        busy = true; const ownGeneration = generation;
        try {
            const output = action === 'status' ? await readStatus(ownGeneration) : await remote(command);
            if (!['status', 'locations', 'license', 'config', 'guard', 'version', 'check-update', 'exclusions-show', 'export-logs'].includes(action)) {
                try { await readStatus(ownGeneration); } catch (_) {}
            }
            busy = false; return { ok: true, output: safeOutput(output), state: snapshot() };
        } catch (_) { busy = false; return { ok: false, error: 'router_unavailable', state: snapshot() }; }
        finally { busy = false; }
    }
    function setEnabled(on) {
        if (typeof on !== 'boolean') return false;
        enabled = on; generation++; if (!on && activeAbort) activeAbort.abort(); if (timer !== null) clearTimer(timer); timer = null;
        if (on && installed) { refresh({ force: true }); if (autoPoll) { timer = setTimer(() => refresh(), intervalMs); timer?.unref?.(); } }
        return snapshot();
    }
    function close() { setEnabled(false); }
    return { snapshot, refresh, execute, setEnabled, close, testAlert };
}
module.exports = { createVPN, parseHealth, parseStatus, stripANSI, safeOutput, commandFor, validateConfig };
