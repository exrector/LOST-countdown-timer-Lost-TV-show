'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');
const runDefault = promisify(require('child_process').execFile);

function normalizeModules(value) { return { ups: value?.ups !== false, muse: value?.muse === true, ...(typeof value?.vpn === 'boolean' ? {vpn:value.vpn} : {}) }; }
function createModules({ saved, persist, apply, publish = () => {}, installed = { muse: false } }) {
    const desired = normalizeModules(saved);
    if (!installed.muse) desired.muse = false;
    if (installed.vpn) desired.vpn = saved?.vpn !== false; else delete desired.vpn;
    const states = { ups: { status: apply ? 'starting' : desired.ups ? 'ready' : 'disabled', error: null },
        muse: { status: installed.muse ? 'disabled' : 'not_installed', installed: !!installed.muse, error: null } };
    const queues = { ups: Promise.resolve(), muse: Promise.resolve() }, revisions = { ups: 0, muse: 0 };
    if (installed.vpn) { states.vpn = {status:'starting',installed:true,error:null}; queues.vpn=Promise.resolve(); revisions.vpn=0; }
    const snapshot = () => Object.fromEntries(Object.keys(desired).map(id => [id, { ...states[id], enabled: desired[id] }]));
    function lifecycle(id = 'ups') {
        const current = ++revisions[id], enabled = desired[id];
        states[id] = { ...states[id], status: apply ? (enabled ? 'starting' : 'stopping') : enabled ? 'ready' : 'disabled', error: null };
        publish(snapshot());
        queues[id] = queues[id].then(async () => {
            if (current !== revisions[id]) return;
            let result;
            try { result = apply ? await apply(id, enabled) : { status: enabled ? 'ready' : 'disabled' }; }
            catch (error) { result = { status: 'error', error: error.message || 'Не удалось переключить модуль' }; }
            if (current !== revisions[id]) return;
            states[id] = { ...states[id], ...result, status: result?.status || (enabled ? 'ready' : 'disabled'), error: result?.error || null };
            publish(snapshot());
        });
        return queues[id];
    }
    return {
        desired: () => ({ ...desired }), snapshot,
        initialize() { return Promise.all([lifecycle('ups'), ...(installed.muse ? [lifecycle('muse')] : []), ...(installed.vpn ? [lifecycle('vpn')] : [])]); },
        reconcileUPS() { return desired.ups ? lifecycle('ups') : Promise.resolve(); },
        set(id, enabled) {
            if (!Object.hasOwn(desired, id) || (id === 'muse' && !installed.muse) || typeof enabled !== 'boolean') return false;
            if (enabled === desired[id]) { publish(snapshot()); return true; }
            const previous = desired[id]; desired[id] = enabled;
            if (!persist()) { desired[id] = previous; states[id] = { ...states[id], status: 'error', error: 'Не удалось сохранить состояние модулей' }; publish(snapshot()); return false; }
            lifecycle(id); return true;
        },
        updateVPN(status) { if (installed.vpn && desired.vpn && status.enabled !== false) { states.vpn = {...states.vpn,...status,status:['connected','disconnected'].includes(status.status)?'ready':status.status}; publish(snapshot()); } },
        updateMuse(status) { if (desired.muse && status.enabled !== false) { states.muse = { ...states.muse, ...status }; publish(snapshot()); } },
        updateUPS(status) { if (desired.ups && !['starting', 'stopping', 'error', 'not_installed'].includes(states.ups.status)) { states.ups = { ...states.ups, ...status }; publish(snapshot()); } },
    };
}

// Only the dedicated LOST telemetry agent is eligible for lifecycle operations.
function createUPSService({ root, home = os.homedir(), uid = process.getuid?.(), run = runDefault, exists = fs.existsSync, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
    const label = 'com.exrector.lost-ups';
    const plist = path.join(home, 'Library/LaunchAgents', label + '.plist');
    const domain = 'gui/' + uid, job = domain + '/' + label;
    const command = (file, args) => run(file, args, { timeout: 4000 });
    async function missingJob(error) {
        return /could not find service|service not found|no such process/i.test(String(error.stderr || '') + String(error.message || ''));
    }
    return async function applyModule(id, enabled) {
        if (id !== 'ups') throw new Error('Модуль не установлен');
        if (!exists(plist)) return { status: enabled ? 'not_installed' : 'disabled', installed: false, error: enabled ? 'Агент UPS не установлен' : null };
        const { stdout } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
        const definition = JSON.parse(stdout);
        if (definition.Label !== label || !Array.isArray(definition.ProgramArguments) || !definition.ProgramArguments.includes(path.join(root, 'ups/agent.js'))) throw new Error('LaunchAgent UPS не соответствует этому LOST');
        if (!enabled) {
            await command('/bin/launchctl', ['disable', job]);
            try { await command('/bin/launchctl', ['bootout', job]); }
            catch (error) { if (!(await missingJob(error))) throw new Error('Не удалось выгрузить агент UPS'); }
            for (let i = 0; i < 10; i++) {
                try { await command('/bin/launchctl', ['print', job]); }
                catch (error) {
                    if (await missingJob(error)) return { status: 'disabled', installed: true, error: null };
                    throw new Error('Не удалось проверить остановку агента UPS');
                }
                await wait(100);
            }
            throw new Error('Агент UPS остаётся загруженным после отключения');
        }
        await command('/bin/launchctl', ['enable', job]);
        let loaded = false;
        try { await command('/bin/launchctl', ['print', job]); loaded = true; }
        catch (error) { if (!(await missingJob(error))) throw new Error('Не удалось проверить агент UPS'); }
        if (!loaded) await command('/bin/launchctl', ['bootstrap', domain, plist]);
        await command('/bin/launchctl', ['kickstart', job]);
        await command('/bin/launchctl', ['print', job]);
        return { status: 'ready', installed: true, error: null };
    };
}
module.exports = { normalizeModules, createModules, createUPSService };
