'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('./command-audit.cjs');
const timeline = require('./timeline.js');

function row(id, createdAt, stage = 'received') {
    return {id, createdAt, method:'device.health', ref:'0123456789abcdef', stage};
}

test('command journal exposes only bounded allowlisted metadata', () => {
    const value = audit.event({...row('a'.repeat(32), 1234, 'completed'), ok:true, durationMs:17,
        exitCode:0, timedOut:false, params:{secret:'never'}, payload:'never'});
    assert.deepEqual(value, {id:'a'.repeat(32), createdAt:1234, method:'device.health',
        ref:'0123456789abcdef', stage:'completed', ok:true, timedOut:false, durationMs:17, exitCode:0});
    assert.equal(audit.event({...row('b'.repeat(32), 1234), method:'unknown'}), null);
});

test('reader ignores malformed, duplicate and incomplete appends', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-audit-'));
    try {
        const file = path.join(dir, 'commands.jsonl'), one = row('a'.repeat(32), 1000);
        fs.writeFileSync(file, JSON.stringify(one)+'\nnot-json\n'+JSON.stringify(one)+'\n'+JSON.stringify(row('b'.repeat(32), 2000)));
        const result = audit.readAudit(file);
        assert.deepEqual(result.events, [one]);
        assert.equal(result.available, true);
        assert.equal(result.events[0].params, undefined);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('timeline merges chat and command events newest first without losing stable ids', () => {
    const view = new timeline.Timeline();
    const first = view.update([{id:'q', role:'user', text:'проверка', createdAt:1000}], [row('a'.repeat(32), 2000)]);
    assert.deepEqual(first.map(x => x.id), ['audit:'+ 'a'.repeat(32), 'message:q']);
    assert.equal(timeline.describe(first[0]).label, 'MUSE→');
    const second = view.update([{id:'q', role:'user', text:'проверка', createdAt:9999}], [row('a'.repeat(32), 9999, 'sent')]);
    assert.equal(second.find(x => x.id === 'message:q').createdAt, 1000);
    assert.equal(second.find(x => x.kind === 'audit').createdAt, 2000);
});
