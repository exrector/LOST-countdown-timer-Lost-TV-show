'use strict';
// Единственный процесс станции: launchd наблюдает ядро, ядро восстанавливает окна.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const { start, events } = require('./server');
const { createUPSService } = require('./modules');
const { launchNative } = require('./native-host');
const { RecoveryController } = require('./runtime');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '..');
const nativeUI = cfg.renderer === 'native';
const NATIVE = path.join(ROOT, 'LOST.app/Contents/MacOS/LOSTNative');
let nativeHost = null, nativeStartedAt = 0;
const QUIET = ['--kiosk', '--no-first-run', '--no-default-browser-check', '--disable-notifications', '--noerrdialogs',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble', '--disable-features=Translate,TranslateUI,CalculateNativeWinOcclusion'];
const recovery = new RecoveryController();
const windows = { tv: null, console: null };
const peers = { tv: 0, console: 0 };
const heartbeat = { tv: 0, console: 0 };
const modules = { timer: { status: 'starting' }, terminal: { status: 'starting' }, display: { status: 'starting' }, ups: { status: 'starting' } };
let stopping = false, core, caffeinate, castSession, screens = [], lastScreensAt = 0, lastUPSAt = 0, lastUPSStart = 0, busy = false;
const localTimer = ['local', 'both'].includes(cfg.output || 'chromecast');
function profile(role) { return path.join(os.tmpdir(), role === 'tv' ? 'lost-timer-profile' : 'lost-terminal-profile'); }
function getJSON(port, route, timeout = 3000, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: route, headers }, res => {
            let body = ''; res.on('data', c => { body += c; if (body.length > 262144) req.destroy(new Error('response too large')); });
            res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode)); try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('invalid JSON')); } });
        });
        req.setTimeout(timeout, () => req.destroy(new Error('timeout'))); req.on('error', reject);
    });
}
async function readScreens() {
    const script = 'ObjC.import("AppKit"); const s=$.NSScreen.screens,r=[];for(let i=0;i<s.count;i++){const sc=s.objectAtIndex(i),f=sc.frame;r.push({name:ObjC.unwrap(sc.localizedName),x:f.origin.x,y:f.origin.y,w:f.size.width,h:f.size.height});}JSON.stringify(r)';
    try {
        const { stdout } = await run('/usr/bin/osascript', ['-l','JavaScript','-e',script], { timeout: 4000 });
        const list = JSON.parse(stdout), H0 = list[0]?.h || 0;
        return list.map(d => ({ ...d, x: Math.round(d.x), y: Math.round(H0 - d.y - d.h), w: Math.round(d.w), h: Math.round(d.h) }));
    } catch (_) { console.error('[экран] временно не удалось прочитать список экранов'); return null; }
}
function timerDisplay() { return screens.find(d => d.name === cfg.display) || (screens.length > 1 ? screens[screens.length - 1] : null); }
async function closeWindow(role) {
    if (nativeUI) {
        const child = nativeHost;
        if (child) await child.stop();
        if (nativeHost === child) { nativeHost = null; windows.tv = windows.console = null; }
        return;
    }
    const child = windows[role]; windows[role] = null;
    if (child?.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
    // Удаляет также осиротевший Chrome после аварии предыдущего ядра. Только профиль LOST.
    try { await run('/usr/bin/pkill', ['-f', role === 'tv' ? 'lost-timer-profile' : 'lost-terminal-profile'], { timeout: 3000 }); } catch (_) {}
}
async function openWindow(role) {
    if (nativeUI) {
        if (stopping) return false;
        // One app owns both windows. A second role must not restart a freshly launched host.
        if (nativeHost && Date.now() - nativeStartedAt < 20000) return true;
        if (!fs.existsSync(NATIVE)) throw new Error('Native LOST app is missing; run script/build_and_run.sh --build-only');
        if (nativeHost) { await closeWindow(role); await new Promise(resolve => setTimeout(resolve, 500)); }
        if (stopping) return false;
        const logDir = path.join(os.homedir(), 'Library/Logs/LOST'); fs.mkdirSync(logDir, { recursive: true });
        const args = ['--managed', '--owner-pid', String(process.pid), '--url', 'http://localhost:' + core.port,
            '--display', cfg.display || 'Waveshare-625', '--status', path.join(logDir, 'native-status.json')];
        if (!localTimer) args.push('--no-timer');
        if (process.env.LOST_NATIVE_DIAGNOSTICS === '1') args.push('--diagnostics');
        const child = launchNative({bundle:path.join(ROOT,'LOST.app'),args,status:path.join(logDir,'native-status.json')});
        nativeHost = child; nativeStartedAt = Date.now(); windows.console = child; if (localTimer) windows.tv = child;
        child.on('error', error => console.error('[native]', error.code || 'launch failed'));
        child.on('exit', () => { if (nativeHost === child) { nativeHost = null; windows.tv = windows.console = null; } });
        console.log('[native] WKWebView host started');
        return true;
    }
    if (stopping || !fs.existsSync(CHROME)) return false;
    const display = role === 'tv' ? timerDisplay() : screens[0];
    if (!display) return false;
    await closeWindow(role);
    if (stopping) return false;
    fs.rmSync(profile(role), { recursive: true, force: true });
    const url = 'http://localhost:' + core.port + (role === 'tv' ? '/index.html?mode=' + core.getMode() : '/console.html');
    const args = ['--app=' + url, '--window-position=' + display.x + ',' + display.y, '--window-size=' + display.w + ',' + display.h,
        ...QUIET, '--user-data-dir=' + profile(role), '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
    if (role === 'tv') args.push('--force-device-scale-factor=1');
    const child = spawn(CHROME, args, { stdio: 'ignore', detached: true }); windows[role] = child;
    child.on('error', error => { console.error('[окно]', role, error.code || 'launch failed'); if (windows[role] === child) windows[role] = null; });
    child.on('exit', () => { if (windows[role] === child) windows[role] = null; });
    child.unref();
    console.log('[окно]', role, 'запуск на', display.name);
    return true;
}
const museRuntime = require('../muse/supervisor.cjs').createMuse({ root: ROOT });
const vpnRuntime = require('../vpn/runtime.cjs').createVPN();
const flameRuntime = require('../flame/runtime.cjs').createFlame();
const applyUPSService = createUPSService({ root: ROOT });
async function applyModule(id, enabled) {
    if (id === 'muse') return museRuntime.apply(id, enabled);
    if (id === 'imessage') return { installed: true, status: enabled ? 'ready' : 'disabled' };
    if (id === 'flame') { flameRuntime.setEnabled(enabled); return {installed:flameRuntime.snapshot().installed,status:enabled?'starting':'disabled'}; }
    if (id === 'vpn') { vpnRuntime.setEnabled(enabled); return {installed:vpnRuntime.snapshot().installed,status:enabled?'starting':'disabled'}; }
    const result = await applyUPSService(id, enabled);
    modules.ups = { ...result, enabled };
    return result;
}
function upsEnabled() { return core?.getModules().ups.enabled === true; }
async function ensureUPS() {
    if (!upsEnabled()) return;
    if (Date.now() - lastUPSStart < 60000) return;
    lastUPSStart = Date.now();
    await core.reconcileUPS();
}
async function pollUPS() {
    if (!upsEnabled() || ['starting','stopping','error','not_installed'].includes(core.getModules().ups.status)) return;
    try {
        const state = await getJSON(8766, '/state', 3000, { Origin: 'http://localhost:' + core.port });
        const fresh = state.online && Date.now() - state.updatedAt < 20000;
        if (!upsEnabled()) return;
        modules.ups = { enabled: true, status: fresh ? 'ready' : 'degraded', updatedAt: state.updatedAt || null, error: fresh ? null : 'Нет актуальных показаний ИБП' };
        core.updateUPS(modules.ups);
    } catch (_) {
        if (!upsEnabled()) return;
        modules.ups = { enabled: true, status: 'unavailable', error: 'Агент энергоконтура недоступен' };
        core.updateUPS(modules.ups); await ensureUPS();
    }
}
async function tick() {
    if (stopping || busy) return; busy = true;
    try {
        const now = Date.now();
        core.updateMuse(museRuntime.read());
        core.updateVPN(vpnRuntime.snapshot());
        core.updateFlame(flameRuntime.snapshot());
        if (now - lastScreensAt > 10000) {
            lastScreensAt = now; const next = await readScreens(); if (next) screens = next;
        }
        const display = timerDisplay();
        modules.display = { status: display ? 'ready' : 'waiting', name: display?.name || cfg.display || null };
        if (!nativeUI && localTimer && !display && windows.tv) await closeWindow('tv');
        for (const role of ['console', ...(localTimer ? ['tv'] : [])]) {
            const available = role === 'tv' ? !!display : !!screens[0];
            recovery.observe(role, { connected: peers[role] > 0, lastHeartbeat: heartbeat[role] || undefined, processAlive: !!windows[role], available });
            const healthy = peers[role] > 0 && (!heartbeat[role] || now - heartbeat[role] < 45000);
            modules[role === 'tv' ? 'timer' : 'terminal'] = { status: healthy ? 'ready' : available ? 'recovering' : 'waiting', connections: peers[role], heartbeatAge: heartbeat[role] ? Math.floor((now - heartbeat[role]) / 1000) : null };
            if (recovery.beginAttempt(role)) {
                let launched = false;
                try { launched = await openWindow(role); } finally { recovery.completeAttempt(role, { launched }); }
            }
        }
        if (upsEnabled() && now - lastUPSAt > 5000) { lastUPSAt = now; await pollUPS(); }
    } catch (error) { console.error('[надзор]', error.code || error.message); }
    finally { busy = false; }
}
async function shutdown(code = 0) {
    if (stopping) return; stopping = true; recovery.stop();
    console.log('[ядро]', code === 0 ? 'штатный выход' : 'аварийное завершение');
    try { core?.saveState(); } catch (_) {}
    try { vpnRuntime.close(); } catch (_) {}
    try { flameRuntime.close(); } catch (_) {}
    try { await museRuntime.close(); } catch (_) {}
    try { castSession?.close(); } catch (_) {}
    for (const role of ['console','tv']) await closeWindow(role);
    try { caffeinate?.kill(); } catch (_) {}
    // Значок закрывается вместе со станцией; обработчик quit безопасен при уже остановленном ядре.
    if (!nativeUI) try { await run('/usr/bin/osascript', ['-e', 'if application "LOST" is running then tell application "LOST" to quit'], { timeout: 4000 }); } catch (_) {}
    process.exit(code);
}
process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0)); process.on('SIGHUP', () => shutdown(0));
process.on('uncaughtException', error => { console.error('[ядро] uncaught exception:', error.message); shutdown(1); });
process.on('unhandledRejection', error => { console.error('[ядро] unhandled rejection:', error?.message || 'error'); shutdown(1); });
events.on('quit', () => shutdown(0));
events.on('peers', counts => { peers.tv = counts.tv; peers.console = counts.console; });
events.on('client-alive', beat => { if (beat.role in heartbeat) heartbeat[beat.role] = Date.now(); });
(async () => {
    core = await start(cfg.port, { audioDefault: 'speakers', liveInDev: cfg.liveInDev === true, stage: cfg.stage, display: cfg.display, sleepFrom: cfg.sleepFrom, applyModule, vpnRuntime, flameRuntime, moduleInstalled: { muse: museRuntime.installed(), vpn:vpnRuntime.snapshot().installed, flame:flameRuntime.snapshot().installed, imessage:true }, getMuseChat: museRuntime.chat, sendMuseMessage: museRuntime.sendMessage, sendMuseVoice: museRuntime.sendVoice, getRuntimeStatus: () => ({ ...modules, ups: core ? core.getModules().ups : modules.ups, renderer: { status: 'ready', name: nativeUI ? 'WKWebView' : 'Chrome' } }) });
    caffeinate = spawn('/usr/bin/caffeinate', ['-d','-i','-w',String(process.pid)], { stdio: 'ignore' }); caffeinate.on('error', () => {}); caffeinate.unref();
    screens = await readScreens() || []; lastScreensAt = Date.now();
    await openWindow('console'); if (localTimer) await openWindow('tv');
    if (['chromecast','both'].includes(cfg.output || 'chromecast')) {
        try { castSession = await require('./cast').castSite(cfg.chromecast, 'http://' + core.ip + ':' + core.port + '/index.html?mode=' + core.getMode()); }
        catch (_) { console.error('[cast] подключение недоступно'); }
    }
    await tick(); setInterval(tick, 2000);
    if (!nativeUI && process.env.LOST_SUPERVISED === '1') {
        run('/usr/bin/open', [path.join(ROOT, 'LOST.app')], { timeout: 5000 }).catch(() => {});
    }
    console.log('[ядро] станция запущена; режим:', core.getMode(), '; выход — через меню LOST');
})().catch(error => { if (error.code === 'EADDRINUSE') { console.log('[ядро] LOST уже запущен'); process.exit(0); } else { console.error('[ядро] запуск:', error.code || error.message); shutdown(1); } });
