'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parse, COMMANDS } = require('./commands.cjs');
const { createRemote, normalizeSettings, isHomeNetwork } = require('./runtime.cjs');
const { createIMessage } = require('./imessage.cjs');

test('phrases keep the old remote behaviour and order', () => {
    const cases = { 'Пауза': 'pause', 'сон': 'pause', 'Стоп': 'pause', 'Старт': 'resume', 'утро': 'resume', 'Подъём': 'resume',
        'Звук выкл': 'sound-off', 'тихо': 'sound-off', 'Звук': 'sound', 'Динамики': 'speakers', 'монитор': 'monitor',
        'Статус': 'status', '?': 'status', 'журнал': 'journal' };
    for (const [text, id] of Object.entries(cases)) assert.equal(parse(text).id, id, text);
    assert.deepEqual(parse(' 4 8  15 16 23 42 '), { id: 'code', code: '4 8 15 16 23 42' });
    assert.equal(parse('привет'), null);
    assert.ok(COMMANDS.every(c => c.label && c.phrases.length));
});

function remote(over = {}) {
    const calls = [], saves = [];
    const actions = new Proxy({}, { get: (_, id) => (channel, said) => { calls.push([id, channel, said]); return id === 'code' ? 'Код отправлен.' : ''; } });
    const r = createRemote({ saved: over.saved, persist: () => { saves.push(1); return over.persist !== false; }, actions,
        shortcuts: { find: t => t === 'Громкость 50' ? 'Громкость 50' : null, run: (name, channel) => { calls.push(['shortcut', name, channel]); return 'Запускаю команду «' + name + '».'; } },
        active: channel => over.active ? over.active(channel) : true });
    return { r, calls, saves };
}

test('each channel has its own command switches; a disabled command is refused, not run', () => {
    const { r, calls } = remote();
    assert.equal(r.set('siri', 'pause', false), true);
    assert.match(r.run('Пауза', 'siri'), /«ПАУЗА» по Siri выключена/);
    assert.equal(r.run('Пауза', 'imessage', '+70000000000'), '');
    assert.deepEqual(calls, [['pause', 'imessage', 'Пауза']]);
    assert.equal(r.snapshot().siri.commands.find(c => c.id === 'pause').enabled, false);
    assert.equal(r.settings().imessage.commands.pause, true);
});

test('Mac shortcuts by exact name are a separate switch per channel', () => {
    const { r, calls } = remote();
    assert.match(r.run('Громкость 50', 'siri'), /Запускаю/);
    r.set('siri', 'shortcuts', false);
    assert.match(r.run('Громкость 50', 'siri'), /Не понял/);
    assert.deepEqual(calls, [['shortcut', 'Громкость 50', 'siri']]);
    assert.doesNotMatch(r.help('siri'), /«Команд»/);
});

test('code can be disabled per channel; unknown text answers with the channel help; off channel is silent', () => {
    const { r } = remote({ active: channel => channel === 'imessage' });
    assert.equal(r.run('4 8 15 16 23 42', 'imessage'), 'Код отправлен.');
    r.set('imessage', 'code', false);
    assert.match(r.run('4 8 15 16 23 42', 'imessage'), /не принимается/);
    assert.match(r.run('привет', 'imessage'), /^Не понял «привет»\. Команды: /);
    assert.equal(r.run('Пауза', 'siri'), null);
    assert.equal(r.run('Пауза', 'other'), null);
});

test('settings persist and survive reload; failed save keeps the old value; garbage is rejected', () => {
    const first = remote(); first.r.set('imessage', 'sound', false);
    const again = remote({ saved: first.r.settings() });
    assert.equal(again.r.settings().imessage.commands.sound, false);
    const failing = remote({ persist: false });
    assert.equal(failing.r.set('siri', 'pause', false), false);
    assert.equal(failing.r.settings().siri.commands.pause, true);
    assert.equal(again.r.set('siri', 'quit', false), false);
    assert.equal(again.r.set('siri', 'pause', 'no'), false);
    assert.deepEqual(Object.keys(normalizeSettings({ evil: {} })), ['imessage', 'siri']);
});

test('Siri accepts only the home network, never the tailnet or the internet', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.40', '10.0.0.5', '172.20.1.1']) assert.equal(isHomeNetwork(a), true, a);
    for (const a of ['100.99.36.23', '::ffff:100.64.0.1', '8.8.8.8', '172.32.0.1', '', 'fe80::1', '192.169.1.1']) assert.equal(isHomeNetwork(a), false, a);
});

test('iMessage: only listed senders are queried; while the module is off messages are skipped, not queued', () => {
    const queries = [], replies = [], ran = [];
    let active = true, rows = '7\t+70000000000\tПауза\n';
    const exec = (bin, args, cb) => { if (bin === 'osascript') { replies.push(args.slice(-2)); return; } queries.push(args.at(-1)); cb(null, queries.length === 1 ? '6' : rows); };
    const im = createIMessage({ senders: ["+70000000000'; drop"], run: (text, channel, sender) => { ran.push([text, channel, sender]); return ''; }, status: () => 'LOST: идёт.', active: () => active, exec, setTimer: () => 1, later: fn => fn(), log() {} });
    assert.equal(im.start(), true);
    im.check();
    assert.match(queries[1], /h\.id in \('\+70000000000; drop'\)/);
    assert.deepEqual(ran, [['Пауза', 'imessage', '+70000000000']]);
    assert.deepEqual(replies, [['+70000000000', 'LOST: идёт.']]);
    active = false; rows = '8\t+70000000000\tСтарт\n'; im.check();
    active = true; rows = ''; im.check();
    assert.equal(ran.length, 1);
    assert.equal(createIMessage({ senders: [] }).start(), false);
});
