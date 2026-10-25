'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizeModules, createModules, createUPSService } = require('../modules');

test('legacy defaults, unsupported modules and persistence failure stay honest', async () => {
    assert.deepEqual(normalizeModules(), { ups: true, muse: false });
    assert.deepEqual(normalizeModules({ ups: false, muse: true }), { ups: false, muse: true });
    const calls = [];
    const m = createModules({ persist: () => false, apply: async (...args) => calls.push(args) });
    assert.equal(m.set('muse', true), false); assert.equal(m.set('ups', 'false'), false);
    assert.equal(m.set('ups', false), false);
    assert.equal(m.snapshot().ups.enabled, true); assert.equal(m.snapshot().ups.status, 'error');
    assert.deepEqual(calls, []);
});

test('desired state persists before asynchronous service changes; rapid toggles serialize', async () => {
    const calls = [], saved = [], releases = [];
    const m = createModules({ saved: { ups: true }, persist: () => { saved.push(m.desired()); return true; },
        apply: async (id, enabled) => { calls.push(enabled); await new Promise(r => releases.push(r)); return { status: enabled ? 'ready' : 'disabled' }; } });
    m.set('ups', false); await new Promise(r => setImmediate(r)); m.set('ups', true);
    assert.deepEqual(saved, [{ ups: false, muse: false }, { ups: true, muse: false }]);
    await new Promise(r => setImmediate(r)); assert.deepEqual(calls, [false]);
    releases.shift()(); await new Promise(r => setImmediate(r)); assert.deepEqual(calls, [false, true]);
    releases.shift()(); await new Promise(r => setImmediate(r)); assert.equal(m.snapshot().ups.status, 'ready');
});

test('startup off applies lifecycle, errors remain visible, absent muse is explicit', async () => {
    const m = createModules({ saved: { ups: false }, apply: async () => { throw new Error('stop failed'); } });
    await m.initialize(); assert.equal(m.snapshot().ups.enabled, false); assert.equal(m.snapshot().ups.status, 'error');
    assert.equal(m.snapshot().ups.error, 'stop failed'); assert.equal(m.snapshot().muse.status, 'not_installed');
});

function adapter({ definition, loaded = true, stopWorks = true, exists = true, printError } = {}) {
    const calls = [];
    const apply = createUPSService({ root: '/station', home: '/fixture', uid: 501, exists: () => exists, wait: async () => {},
        run: async (file, args) => {
            calls.push([file, ...args]);
            if (file.endsWith('plutil')) return { stdout: JSON.stringify(definition || { Label: 'com.exrector.lost-ups', ProgramArguments: ['/node', '/station/ups/agent.js'] }) };
            if (args[0] === 'bootout' && stopWorks) loaded = false;
            if (args[0] === 'bootstrap') loaded = true;
            if (args[0] === 'print' && (printError || !loaded)) { const e = new Error('launchctl failed'); e.stderr = printError || 'Could not find service'; throw e; }
            return { stdout: '' };
        } });
    return { calls, apply };
}
test('service off verifies plist before durable disable and confirms job removal', async () => {
    const { calls, apply } = adapter(); assert.equal((await apply('ups', false)).status, 'disabled');
    assert.deepEqual(calls.filter(c => c[0].endsWith('launchctl')).map(c => c.slice(1)), [
        ['disable', 'gui/501/com.exrector.lost-ups'], ['bootout', 'gui/501/com.exrector.lost-ups'], ['print', 'gui/501/com.exrector.lost-ups']]);
});
test('service never mutates unverified/missing LaunchAgents and reports failed stop', async () => {
    const invalid = adapter({ definition: { Label: 'different', ProgramArguments: ['/station/ups/agent.js'] } });
    await assert.rejects(invalid.apply('ups', false), /не соответствует/); assert.equal(invalid.calls.length, 1);
    const other = adapter({ definition: { Label: 'com.exrector.lost-ups', ProgramArguments: ['/other/ups/agent.js'] } });
    await assert.rejects(other.apply('ups', true), /не соответствует/); assert.equal(other.calls.length, 1);
    const missing = adapter({ exists: false }); assert.equal((await missing.apply('ups', true)).status, 'not_installed'); assert.equal(missing.calls.length, 0);
    await assert.rejects(adapter({ stopWorks: false }).apply('ups', false), /остаётся загруженным/);
    await assert.rejects(adapter({ printError: 'Permission denied' }).apply('ups', false), /проверить остановку/);
});
test('enable bootstraps unloaded dedicated agent and kickstarts it', async () => {
    const { calls, apply } = adapter({ loaded: false }); assert.equal((await apply('ups', true)).status, 'ready');
    assert.deepEqual(calls.slice(1).map(c => c[1]), ['enable','print','bootstrap','kickstart','print']);
});

test('a queued recovery cannot restart the service after desired off', async () => {
    const calls = [];
    const m = createModules({ persist: () => true, apply: async (_id, enabled) => { calls.push(enabled); return { status: enabled ? 'ready' : 'disabled' }; } });
    const recovering = m.reconcileUPS(); m.set('ups', false);
    await recovering; await new Promise(r => setImmediate(r));
    assert.deepEqual(calls, [false]); assert.equal(m.snapshot().ups.status, 'disabled');
});

test('installed Muse persists independently, reaches ready after async spawn and ignores late reports after off', async()=>{
 const calls=[];
 const m=createModules({saved:{ups:false,muse:false},installed:{muse:true},persist:()=>true,apply:async(id,on)=>{calls.push([id,on]);return {installed:true,status:on?'starting':'disabled'};}});
 await m.initialize();m.set('muse',true);await new Promise(r=>setImmediate(r));
 assert.equal(m.snapshot().muse.status,'starting');
 m.updateMuse({enabled:true,status:'ready',pid:123});assert.equal(m.snapshot().muse.status,'ready');
 assert.deepEqual(m.desired(),{ups:false,muse:true});
 m.set('muse',false);m.updateMuse({enabled:true,status:'ready'});await new Promise(r=>setImmediate(r));
 assert.equal(m.snapshot().muse.enabled,false);assert.equal(m.snapshot().muse.status,'disabled');
 assert.ok(calls.some(([id,on])=>id==='muse'&&on));
});
