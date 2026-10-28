const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const events = new EventEmitter();
const { loadState, writeState } = require('./state-store');
const { StationClock } = require('./clock');
const timeline = require('../js/lost-timeline');
const { createModules } = require('./modules');
const { createRemote, isHomeNetwork } = require('../remote/runtime.cjs');
const { createIMessage, compose } = require('../remote/imessage.cjs');
const { createKay } = require('../remote/kay.cjs');
const { formatStatus, mmss } = require('../remote/status.cjs');
const { createUPSGateway } = require('./ups-gateway');
const { createMuseGateway } = require('../muse/gateway.cjs');

const _log = console.log;
console.log = (...a) => _log(new Date().toTimeString().slice(0, 8), ...a);

const ROOT = path.resolve(__dirname, '..');          // исходные index.html / console.html / css / js / assets
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function lanIp() {
    const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
    for (const [name, list] of Object.entries(os.networkInterfaces()))
        if (!/^(utun|awdl|llw|bridge|lo)/.test(name))
            for (const i of list) if (i.family === 'IPv4' && !i.internal && priv.test(i.address)) return i.address;
    return '127.0.0.1';
}

function start(port = 8765, opts = {}) {
    let clockTimer;
    const stage = opts.stage || { width: 1560, height: 720 };
    const upsGateway = createUPSGateway({ port: opts.upsPort || 8766, origin: 'http://localhost:' + port });
    const museGateway=createMuseGateway({port:()=>server.address()?.port || port, getModule:()=>moduleManager.snapshot().muse, getChat:opts.getMuseChat, sendMessage:opts.sendMuseMessage,sendVoice:opts.sendMuseVoice, preview:opts.musePreview===true});
    const flameGateway = opts.flameRuntime ? require('../flame/gateway.cjs').createFlameGateway({flame:opts.flameRuntime,port:()=>server.address()?.port || port}) : ()=>false;
    const vpnGateway = opts.vpnRuntime ? require('../vpn/gateway.cjs').createVPNGateway({vpn:opts.vpnRuntime,port:()=>server.address()?.port || port}) : ()=>false;
    const server = http.createServer((req, res) => {
        syncClock();
        const url = new URL(req.url, 'http://x');
        let p = decodeURIComponent(url.pathname);
        if (museGateway(req,res,p)) return;
        if (vpnGateway(req,res,p)) return;
        if (flameGateway(req,res,p)) return;
        if (p === '/') p = '/index.html';
        if ((p === '/__ups' || p.startsWith('/__ups/')) && !moduleManager.desired().ups) {
            req.resume(); res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ error: 'module_disabled' }));
        }
        if (upsGateway(req, res, p)) return;
        if (p === '/__health') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ core: { status: 'ready', uptime: Math.floor(process.uptime()), pid: process.pid }, timer: { mode: curMode, left: curLeft, paused: curPaused }, clocks: clock.snapshot(), modules: moduleManager.snapshot(), components: opts.getRuntimeStatus ? opts.getRuntimeStatus() : {} }));
        }
        if (p === '/__ping') { res.writeHead(200); return res.end('ok'); }
        if (p === '/__quit') { res.writeHead(200); res.end('bye'); setTimeout(() => events.emit('quit'), 100); return; }
        // Тот же пульт по адресу станции для «Команд» iPhone дома: /__sleep?on=1|0 — пауза/старт («Фокус: Сон»),
        // /__cmd?text=Пауза — тот же разбор, что у iMessage. Только домашняя сеть: не tailnet и не интернет.
        if (p === '/__sleep' || p === '/__cmd') {
            if (!isHomeNetwork(req.socket.remoteAddress)) { req.resume(); res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('ДОСТУП ЗАПРЕЩЁН: ТОЛЬКО ДОМАШНЯЯ СЕТЬ'); }
            const text = p === '/__sleep' ? (url.searchParams.get('on') === '1' ? 'пауза' : 'старт') : url.searchParams.get('text') || '';
            const answer = remote.run(text, 'сеть');
            setTimeout(() => compose(answer, statusText).then(text => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); }), p === '/__sleep' ? 0 : 1500);
            return;
        }
        if (p === '/__journal') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(journalTail(Math.min(200, parseInt(url.searchParams.get('lines')) || 16))); }
        if (p === '/__jquery.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(fs.readFileSync(path.join(__dirname, 'vendor', 'jquery-3.5.1.min.js'))); }
        if (p === '/__bridge.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(fs.readFileSync(path.join(__dirname, 'bridge.js'))); }
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT) || p.startsWith('/cast-app') || p.startsWith('/.git') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); return res.end('not found');
        }
        let body = fs.readFileSync(file);
        if (p === '/index.html') {
            if (!url.searchParams.has('mode')) { url.searchParams.set('mode', curMode); res.writeHead(302, { Location: '/index.html?' + url.searchParams.toString(), 'Cache-Control': 'no-store' }); return res.end(); }
            switchMode(url.searchParams.get('mode') === 'dev' ? 'dev' : 'live');
            const requested = Number(url.searchParams.get('seconds'));
            if (curMode === 'dev' && url.searchParams.has('seconds') && [10,60,240,6480].includes(requested)) { clock.reset(requested); saveState(); publishClock(); }
        }
        if (p === '/index.html' || p === '/console.html')
            body = Buffer.from(body.toString()
                .replace(/https:\/\/ajax\.googleapis\.com\/ajax\/libs\/jquery\/[\d.]+\/jquery\.min\.js/, '/__jquery.js')
                .replace('</head>', `<script>window.__LOST_MODULES=${JSON.stringify(moduleManager.snapshot())};window.__LOST_CLOCK=${JSON.stringify(clock.sample())};window.__LOST_STAGE=${JSON.stringify({ w: stage.width, h: stage.height, scale: stage.scale || 1 })};window.__LOST_RESUME=${JSON.stringify({ left: curLeft > 0 ? curLeft : null, paused: curPaused })}</script><script src="/__bridge.js"></script></head>`));
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    });

    const wss = new WebSocketServer({ noServer: true });
    const peers = { tv: new Set(), console: new Set() };
    const stateFile = opts.stateFile || path.join(__dirname, '.state.json');
    let audioMode = opts.audioDefault || 'mac';
    const saved = loadState(stateFile);
    let remote = null; // пульт создаётся ниже, когда готовы таймер и звук
    const moduleManager = createModules({ saved: saved.modules, persist: saveState, apply: opts.applyModule, installed: opts.moduleInstalled,
        publish: modules => { const msg = JSON.stringify({ type: '__modules', modules }); for (const set of Object.values(peers)) for (const ws of set) if (ws.readyState === 1) ws.send(msg); } });
    audioMode = saved.audio || audioMode;
    // Где остановился таймер: продолжаем с того же места после перезапуска LOST и при переключении Dev/Live.
    // Downtime is excluded; failure phase and both independent slots resume atomically.
    // У Live и Dev — свои таймеры: уходя в Dev, Live замораживается на своём месте и при возврате продолжает с него.
    const clock = new StationClock(saved, { ...(opts.clockNow ? { now: opts.clockNow } : {}), liveInDev: opts.liveInDev === true });
    let curMode, curLeft, curPaused, savedAt = 0;
    function syncClock() { const s = clock.sample(); curMode = s.mode; curLeft = s.left; curPaused = s.paused; return s; }
    syncClock();
    function saveState() {
        savedAt = Date.now(); syncClock();
        return writeState(stateFile, { audio: audioMode, ...clock.snapshot(), modules: moduleManager.desired(), remote: remote ? remote.settings() : saved.remote });
    }
    function switchMode(mode) {
        if (mode === clock.mode) return;
        clock.setMode(mode); syncClock();
        if (typeof journalFailure === 'function') journalFailure(false);
        sleepOn = curPaused;
        delete last.enable; delete last.state;
        saveState();
        console.log('[режим]', mode, ':', curLeft, 'с; пауза:', curPaused);
        publishClock();
    }
    // The exit hook is registered only after this process owns the listening socket.
    // process.on('exit', saveState); // при выходе — точное место, а не 10-секундной давности
    // Физический выход звука (динамики Мака / монитор по HDMI) переключает macOS-помощник bin/lost-audio
    const AUDIO_BIN = path.join(__dirname, 'bin', 'lost-audio');
    function applyAudioDevice(mode) {
        const args = mode === 'monitor' ? ['set', 'display', opts.display || ''] : mode === 'speakers' ? ['set', 'builtin'] : null;
        if (opts.audioDevice === false || !args || !fs.existsSync(AUDIO_BIN)) return;
        execFile(AUDIO_BIN, args.filter(Boolean), (e, out, err) => {
            if (e) console.log('[audio] не удалось переключить (' + mode + '):', (err || e.message).trim());
            else { try { console.log('[audio] выход звука:', JSON.parse(out).name); } catch (_) {} }
        });
    }
    if (audioMode !== 'monitor' && audioMode !== 'off') audioMode = 'speakers'; // прежние значения (on/tv/mac) = динамики Мака
    applyAudioDevice(audioMode);
    const audioMsg = () => JSON.stringify({ type: '__audio', mode: audioMode });
    const last = {}; // последние enableConsole/__state от ТВ — чтобы новая консоль сразу их получила
    let sleepOn = curPaused; // последняя удалённая команда паузы — заново отправляется таймеру после перезагрузки его страницы
    const sleepMsg = () => JSON.stringify({ type: '__cmd', cmd: 'sleep', on: sleepOn });
    function setAudio(mode) {
        audioMode = mode;
        applyAudioDevice(audioMode);
        saveState();
        for (const set of Object.values(peers)) for (const o of set) if (o.readyState === 1) o.send(audioMsg());
    }
    // Что сейчас с таймером: оставшееся время приходит от таймера каждую секунду (enableConsole), пауза — по подписи кнопки
    function timerInfo() {
        const sample = syncClock();
        return { left: sample.left, open: sample.phase === 'countdown' && sample.left > 0 && sample.left <= 240, paused: sample.paused };
    }
    let lastClockKey = '', lastClockSentAt = 0;
    function publishClock() {
        const sample = syncClock();
        clearTimeout(clockTimer);
        // Reschedule after every control change as well as every broadcast.
        // Keep a 1s checkpoint while paused; active clocks wake at the next boundary.
        const fraction = sample.rawLeft - Math.floor(sample.rawLeft);
        const delay = sample.paused ? 1000 : Math.max(1, Math.ceil((fraction || 1) * 1000));
        clockTimer = setTimeout(() => { publishClock(); if (Date.now() - savedAt >= 1000) saveState(); }, delay);
        const slots = clock.snapshot(), failing = t => t.left <= -timeline.failure.zeroHold && !t.paused;
        journalFailure(failing(slots.live)); // журнал — только Live: Dev для разработки в него не пишет
        const key = [sample.mode,sample.left,sample.paused,sample.phase,sample.failureAge,sample.cycle].join(':');
        if (key === lastClockKey && Date.now() - lastClockSentAt < 10000) return; lastClockKey = key; lastClockSentAt = Date.now();
        const control = JSON.stringify({ type: '__clock', ...sample });
        const enable = JSON.stringify({ type: 'enableConsole', mode: sample.mode, enabled: sample.phase === 'countdown' && sample.left > 0 && sample.left <= 240, remainingTime: sample.left });
        const state = JSON.stringify({ type: '__state', mode: sample.mode, label: sample.paused ? '▶ Старт' : '⏸ Пауза' });
        last.enable = enable; last.state = state;
        for (const set of Object.values(peers)) for (const ws of set) if (ws.readyState === 1) ws.send(control);
        for (const ws of peers.console) if (ws.readyState === 1) { ws.send(enable); ws.send(state); }

    }
    // Пульт (iMessage, «Команды» iPhone, /__cmd) знает только Live: Dev — для разработки и в пульте не участвует,
    // в каком бы режиме ни стоял терминал. Ответы — одной строкой, как «КОД ПРИНЯТ 108» (решение владельца 28.10):
    // остаток Live в формате таймера МММ.СС или СБОЙ; питание, VPN, AI и окна в ответы не входят.
    function minutesLeft() { const s = clock.sample('live'); return s.phase !== 'countdown' ? 'СБОЙ' : mmss(s.left); } // МММ.СС: 006.00, 000.06
    // Показания ИБП для ответа «статус» — у агента напрямую, не дольше 2 с; нет ответа — null.
    function readUPS() {
        return new Promise(resolve => {
            const req = http.get({ host: '127.0.0.1', port: opts.upsPort || 8766, path: '/state', timeout: 2000, headers: { 'Accept': 'application/json', 'X-LOST-UPS': '1', 'Origin': 'http://localhost:' + port } }, r => {
                let body = ''; r.setEncoding('utf8'); r.on('data', c => { body += c; if (body.length > 1048576) r.destroy(); });
                r.on('end', () => { try { resolve(r.statusCode === 200 ? JSON.parse(body) : null); } catch (_) { resolve(null); } });
                r.on('error', () => resolve(null));
            });
            req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
        });
    }
    // «статус» — единственный полный ответ: таймер Live, включённые модули, терминал, экран таймера, дисплей, ядро.
    async function statusText() {
        const modules = moduleManager.snapshot();
        const ups = modules.ups && modules.ups.enabled !== false ? await readUPS() : null;
        return formatStatus({ timer: clock.sample('live'), modules, components: opts.getRuntimeStatus ? opts.getRuntimeStatus() : null, ups, core: { uptime: process.uptime() } });
    }
    function setLiveSleep(on, source) {
        clock.setPaused(on, 'live'); syncClock(); if (curMode === 'live') sleepOn = curPaused; saveState(); publishClock();
        console.log(`[пульт] Live: ${on ? 'пауза' : 'старт'} (${source})`);
        if (curMode === 'live') for (const o of peers.tv) if (o.readyState === 1) o.send(sleepMsg());
    }

    // ===== Журнал станции «Лебедь» — как распечатка в сериале =====
    // ОДНА бесконечная строка: слова через пробел, без переносов — переносит по ширине тот, кто показывает
    // (матричный принтер — по краю листа, терминал — по ширине окна).
    //   верный код → «<время> accepted», где время = месяц (без нуля) день(2) час(2) минута (без нуля) :секунды(2) — 922041:52;
    //   сбой → «SYSTEM FAILURE» каждую секунду, пока таймер не сбросят (не больше 108 раз). Только Live (Dev — для разработки), паузы не пишутся.
    const journalFile = path.join(__dirname, 'journal.txt');
    // журнал прежнего формата (с переносами по 80) — склеить в одну строку
    // Existing history is never rewritten; new words are appended below.
    function jWrite(word) {
        let empty = true; try { empty = fs.statSync(journalFile).size === 0; } catch (_) {}
        try { fs.appendFileSync(journalFile, (empty ? '' : ' ') + word); } catch (_) {}
    }
    function stamp(d = new Date()) {
        const p2 = n => String(n).padStart(2, '0');
        return `${d.getMonth() + 1}${p2(d.getDate())}${p2(d.getHours())}${d.getMinutes()}:${p2(d.getSeconds())}`;
    }
    function journalAccepted() { jWrite(stamp()); jWrite('accepted'); console.log('[журнал]', stamp(), 'accepted'); }
    let failTimer = null, failCount = 0;
    function journalFailure(on) {
        if (on && !failTimer) {
            failCount = 0;
            const tick = () => { if (++failCount > 108) { clearInterval(failTimer); return; } jWrite('SYSTEM'); jWrite('FAILURE'); };
            console.log('[журнал] SYSTEM FAILURE');
            tick(); failTimer = setInterval(tick, 1000);
        } else if (!on && failTimer) { clearInterval(failTimer); failTimer = null; }
    }
    // хвост журнала примерно на n строк по 80 знаков, начиная с целого слова
    function journalTail(n) {
        try {
            const t = fs.readFileSync(journalFile, 'utf8'), max = n * 80;
            if (t.length <= max) return t;
            const cut = t.slice(-max); return cut.slice(cut.indexOf(' ') + 1);
        } catch (_) { return ''; }
    }

    // ===== Пульт: модули iMessage (глобально) и Siri (домашняя сеть), см. remote/ =====
    // Выход и Dev Mode удалённо намеренно недоступны (удалённо их не отменить, Dev Mode перезапускает таймер).
    const remoteActions = {
        code(code, channel) {
            const live = clock.sample('live');
            if (!(live.phase === 'countdown' && live.left > 0 && live.left <= 240)) return { text: 'КОД НЕ ПРИНЯТ ' + minutesLeft(), bare: true };
            const msg = JSON.stringify({ type: 'numberSubmitted', value: code });
            // неверные цифры видит экран таймера, только когда на нём сам Live
            if (code !== '4 8 15 16 23 42' && curMode === 'live') for (const o of peers.tv) if (o.readyState === 1) o.send(msg);
            console.log('[пульт] код Live:', code, '(' + channel + ')');
            if (code === '4 8 15 16 23 42') { journalAccepted(); clock.reset(undefined, 'live'); saveState(); publishClock(); return { text: 'КОД ПРИНЯТ ' + minutesLeft(), bare: true }; }
            return { text: 'КОД ОТПРАВЛЕН ' + minutesLeft(), bare: true };
        },
        journal: () => ({ text: journalTail(6) || 'ЖУРНАЛ ПУСТ', bare: true }),
        status: () => '',
        resume: (channel, said) => { setLiveSleep(false, channel + ' «' + said + '»'); return { text: 'СТАРТ ' + minutesLeft(), bare: true }; },
        pause: (channel, said) => { setLiveSleep(true, channel + ' «' + said + '»'); return { text: 'ПАУЗА ' + minutesLeft(), bare: true }; },
    };
    // Названия команд из «Команд» этого Мака (обновляются раз в минуту)
    // Модуль «Команды Mac mini»: выключенный — ни терминал, ни iMessage, ни «Команды» iPhone их не видят и не запускают.
    const shortcutsOn = () => moduleManager.desired().shortcuts !== false;
    let shortcutNames = [], shortcutsAt = 0, shortcutsRefreshing = false;
    function refreshShortcuts(now) {
        if (!shortcutsOn() || shortcutsRefreshing || !now && Date.now() - shortcutsAt < 60000) return;
        shortcutsRefreshing = true; shortcutsAt = Date.now();
        execFile('shortcuts', ['list'], { encoding: 'utf8', timeout: 10000 }, (error, output) => {
            shortcutsRefreshing = false;
            if (!error) { const next = output.split('\n').map(x => x.trim()).filter(Boolean); const changed = next.join('\n') !== shortcutNames.join('\n'); shortcutNames = next; if (changed && remote) publishRemote(); }
        });
    }
    const shortcutRunner = {
        list() { if (!shortcutsOn()) return []; refreshShortcuts(); return shortcutNames.slice(); },
        find(text) { if (!shortcutsOn()) return null; refreshShortcuts(); const want = String(text || '').trim().toLowerCase(); return shortcutNames.find(n => n.toLowerCase() === want) || null; },
        // Итог команды одной строкой, когда она завершится: вывод, «готово» или «ошибка: …».
        run(name, channel) {
            console.log('[пульт] запускаю команду «' + name + '» (' + channel + ')');
            return new Promise(resolve => {
                // ввод закрываем сразу: при открытом stdin `shortcuts run` ждёт входные данные для команды и висит
                const child = execFile('shortcuts', ['run', name], { timeout: 120000 }, (e, out) => {
                    const res = e ? 'ошибка: ' + (e.message || '').split('\n')[0] : (String(out || '').trim() || 'готово');
                    console.log('[пульт] команда «' + name + '»: ' + res);
                    resolve(res);
                });
                child.stdin.end();
            });
        },
    };
    // Kay — тот же чат Muse, что и AI в терминале.
    const kay = createKay({ send: opts.sendMuseMessage, chat: opts.getMuseChat, ready: () => { const m = moduleManager.snapshot().muse; return !!m && m.enabled !== false && m.status === 'ready'; } });
    remote = createRemote({ saved: saved.remote, persist: saveState, actions: remoteActions, shortcuts: shortcutRunner, kay });
    const remoteMsg = () => JSON.stringify({ type: '__remote', remote: remote.snapshot(), senders: imessage ? imessage.senders().length : 0, address: lanIp() });
    function publishRemote() { const m = remoteMsg(); for (const ws of peers.console) if (ws.readyState === 1) ws.send(m); }
    const imessage = createIMessage({ senders: opts.sleepFrom || [], run: remote.run, status: statusText, active: () => moduleManager.desired().imessage === true });
    imessage.start();

    server.on('upgrade', (req, sock, head) => {
        const role = new URL(req.url, 'http://x').searchParams.get('role');
        if (!peers[role]) return sock.destroy();
        wss.handleUpgrade(req, sock, head, ws => {
            peers[role].add(ws);
            console.log(`[bridge] ${role} connected (tv=${peers.tv.size}, console=${peers.console.size})`);
            ws.send(audioMsg());
            ws.send(JSON.stringify({ type: '__modules', modules: moduleManager.snapshot() }));
            if (role === 'console') ws.send(remoteMsg());
            ws.send(JSON.stringify({type:'__clock', ...syncClock()}));
            if (role === 'console') Object.values(last).forEach(m => ws.send(m));
            ws.on('message', m => {
                const s = m.toString();
                let data; try { data = JSON.parse(s); } catch (_) { return; }
                if (!data || typeof data !== 'object') return;
                if (data.type === '__cmd' && data.cmd === 'quit') { events.emit('quit'); return; }
                if (data.type === '__audio') { if (['speakers','monitor','off'].includes(data.mode)) setAudio(data.mode); return; }
                if (data.type === '__alive') { events.emit('client-alive', { ...data, role }); if (role === 'tv') events.emit('tv-alive', data); return; }
                if (data.type === '__log') { console.log('[' + role + ' log]', data.msg); return; }
                if (data?.type === '__remote_set') {
                    if (role !== 'console' || typeof data.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.requestId)) return;
                    const valid = typeof data.id === 'string' && typeof data.words === 'string' && data.words.length <= 2000 && data.words.split(',').some(w => w.trim() && w.trim().replace(/\s+/g, ' ').length <= 60);
                    const ok = valid && remote.setWords(data.id, data.words);
                    const command = ok ? remote.snapshot().commands.find(c => c.id === data.id) : null;
                    const words = command ? command.words : undefined;
                    ws.send(JSON.stringify({ type: '__remote_set_result', requestId: data.requestId, id: data.id, ok: !!words, ...(words ? { words } : { error: 'save_failed' }) }));
                    publishRemote(); return;
                }
                // Клавиша K в терминале: список команд Mac mini обновляется при открытии, Enter запускает выбранную.
                if (data?.type === '__shortcuts_refresh') { if (role === 'console') refreshShortcuts(true); return; }
                if (data?.type === '__shortcut_run') {
                    if (role !== 'console') return;
                    const answer = text => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: '__shortcut_result', id: data.id, text })); };
                    const name = shortcutRunner.find(data.name);
                    if (!shortcutsOn()) answer('ошибка: модуль «Команды Mac mini» выключен');
                    else if (!name) answer('ошибка: команды «' + String(data.name || '').slice(0, 100) + '» нет в «Командах» Mac mini');
                    else shortcutRunner.run(name, 'терминал').then(answer);
                    return;
                }
                if (data?.type === '__module') { if (role === 'console') { if (!moduleManager.set(data.id, data.enabled)) ws.send(JSON.stringify({ type: '__module_error', id: data.id, error: data.id === 'muse' ? 'not_installed' : 'invalid_module_request' })); else if (data.id === 'shortcuts') { if (data.enabled) refreshShortcuts(true); publishRemote(); } } return; }
                if (!data || typeof data !== 'object') return;
                if (data.type === '__cmd' && data.cmd === 'mode' && role === 'console' && ['live','dev'].includes(data.value)) {
                    switchMode(data.value);
                    for (const tv of peers.tv) if (tv.readyState === 1) tv.send(s);
                    return;
                }
                if (data.type === '__timer') {
                    if (role !== 'tv' || data.mode !== clock.mode) return;
                    if (data.op === 'pause' && typeof data.paused === 'boolean') clock.setPaused(data.paused);
                    else if (data.op === 'reset') clock.reset();
                    else if (data.op === 'failure' && clock.mode === 'dev') clock.reset(0);
                    else if (data.op === 'set' && clock.mode === 'dev' && [10,60,240,6480].includes(data.seconds)) clock.reset(data.seconds);
                    else return;
                    syncClock(); sleepOn = curPaused; saveState(); publishClock(); return;
                }
                if (role === 'console' && data.type === 'numberSubmitted' && data.value === '4 8 15 16 23 42') {
                    if (timerInfo().open) { if (curMode === 'live') journalAccepted(); clock.reset(); saveState(); publishClock(); }
                    return;
                }
                // Browser rendering reports are never a time source.
                if (role === 'tv' && (data.type === 'enableConsole' || data.type === '__state')) return;
                const to = role === 'tv' ? 'console' : 'tv';
                for (const o of peers[to]) if (o.readyState === 1) o.send(s);
            });
            events.emit('peers', { tv: peers.tv.size, console: peers.console.size });
            ws.on('close', () => { peers[role].delete(ws); events.emit('peers', { tv: peers.tv.size, console: peers.console.size }); console.log(`[bridge] ${role} left`); });
        });
    });

    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, opts.host || '0.0.0.0', async () => {
        await moduleManager.initialize();
        process.on('exit', saveState);
        publishClock();
        server.once('close', () => clearTimeout(clockTimer));
        const ip = lanIp();
        console.log(`LOST server: http://${ip}:${port}/index.html  |  console: http://localhost:${port}/console.html`);
        resolve({ server, port, ip, getModules: moduleManager.snapshot, updateVPN: moduleManager.updateVPN, updateFlame: moduleManager.updateFlame, updateUPS: moduleManager.updateUPS, updateMuse: moduleManager.updateMuse, reconcileUPS: moduleManager.reconcileUPS, getMode: () => clock.mode, saveState, getTimer: () => { const c = syncClock(); return { mode: c.mode, left: c.left, paused: c.paused }; } });
    }); });
}

module.exports = { start, lanIp, events };
if (require.main === module) start(parseInt(process.env.PORT) || 8765, { host: process.env.LOST_BIND_HOST || '0.0.0.0' });
