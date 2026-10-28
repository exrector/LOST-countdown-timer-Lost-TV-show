'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { COMMANDS, parseWords, match } = require('./commands.cjs');
const { createRemote, normalizeSettings, isHomeNetwork } = require('./runtime.cjs');
const { createIMessage, compose } = require('./imessage.cjs');
const { formatStatus } = require('./status.cjs');

const defaults = normalizeSettings().words;
test('default words keep the old behaviour; there are no sound commands', () => {
    const cases = { 'Пауза': 'pause', 'сон': 'pause', 'Стоп': 'pause', 'Старт': 'resume', 'утро': 'resume', 'Подъём': 'resume', 'проснулся': 'resume', 'Статус': 'status', '?': 'status', 'журнал': 'journal' };
    for (const [text, id] of Object.entries(cases)) assert.equal(match(text, defaults).id, id, text);
    assert.deepEqual(match(' 4 8  15 16 23 42 ', defaults), { id: 'code', code: '4 8 15 16 23 42' });
    assert.equal(match('привет', defaults), null);
    assert.equal(match('help', defaults).id, 'help');
    assert.equal(match('Помощь', defaults).id, 'help');
    assert.deepEqual(COMMANDS.map(c => c.id), ['help', 'journal', 'status', 'resume', 'pause']);
});

test('a words line from the menu: commas, case, ё, spaces, duplicates', () => {
    assert.deepEqual(parseWords(' Пауза, СОН ,, сон, стоп  машина, Ёлка '), ['пауза', 'сон', 'стоп машина', 'елка']);
    assert.deepEqual(parseWords(''), []);
});

function remote(over = {}) {
    const calls = [];
    const actions = new Proxy({}, { get: (_, id) => (channel, said) => { calls.push([id, said]); return id === 'code' ? 'Код отправлен.' : ''; } });
    const names = ['Громкость 50', 'VPN SWITCH'];
    const r = createRemote({ saved: over.saved, persist: () => over.persist !== false, actions,
        shortcuts: { list: () => names, find: t => names.find(n => n.toLowerCase() === String(t).trim().toLowerCase()) || null,
            run: name => { calls.push(['shortcut', name]); return Promise.resolve('готово'); } } });
    return { r, calls };
}

test('a message runs a LOST command by its words or a Mac mini command by its exact name', async () => {
    const { r, calls } = remote();
    assert.equal(r.run('Пауза', 'imessage', '+7'), '');
    const shortcut = r.run('vpn switch', 'imessage', '+7');
    assert.deepEqual(await shortcut, { text: 'VPN SWITCH: ВЫПОЛНЕНО', bare: true });
    assert.equal(await compose(shortcut, () => 'СОСТОЯНИЕ'), 'VPN SWITCH: ВЫПОЛНЕНО', 'one message: the result only, no «Запускаю», no status');
    assert.equal(r.run('4 8 15 16 23 42', 'imessage'), 'Код отправлен.');
    assert.deepEqual(r.run('привет', 'imessage'), { text: 'КОМАНДА НЕ РАСПОЗНАНА. СПИСОК: HELP', bare: true });
    assert.deepEqual(calls, [['pause', 'Пауза'], ['shortcut', 'VPN SWITCH'], ['code', 'imessage']]);
    assert.deepEqual(r.snapshot().shortcuts, ['Громкость 50', 'VPN SWITCH']);
});

test('help lists LOST commands with their words, the code and the Mac mini commands, without the station state', async () => {
    const { r, calls } = remote();
    const answer = r.run('help', 'imessage', '+7');
    assert.equal(answer.bare, true);
    assert.match(answer.text, /^КОМАНДЫ:\nСПРАВКА: HELP, ПОМОЩЬ, СПРАВКА, КОМАНДЫ\n/);
    assert.match(answer.text, /ПАУЗА: ПАУЗА, СОН, СПАТЬ, СПЛЮ, СТОП, PAUSE\nКОД: 4 8 15 16 23 42 \(ПОСЛЕДНИЕ 4 МИН\)/);
    assert.match(answer.text, /MAC MINI:\nГРОМКОСТЬ 50\nVPN SWITCH$/);
    assert.equal(await compose(answer, () => 'СОСТОЯНИЕ'), answer.text);
    assert.equal(await compose('Код отправлен.', async () => 'СОСТОЯНИЕ'), 'Код отправлен.\n\nСОСТОЯНИЕ');
    assert.equal(await compose('Код отправлен.', () => { throw new Error('x'); }), 'Код отправлен.');
    assert.deepEqual(calls, []);
});

test('status is the one full reply: Live timer, every switched-on module, terminal health; dry upper-case lines', () => {
    const ups = { online: true, vars: { 'ups.status': 'OL', 'battery.charge': '100', 'battery.runtime': '4650', 'ups.load': '6' } };
    const modules = { ups: { enabled: true, status: 'ready' }, vpn: { enabled: true, status: 'ready', location: 'New York' }, muse: { enabled: true, status: 'reconnecting' },
        flame: { enabled: false, status: 'disabled' }, imessage: { enabled: true, status: 'ready' }, shortcuts: { enabled: true, status: 'error', error: 'нет доступа' } };
    const components = { terminal: { status: 'ready' }, timer: { status: 'waiting' }, display: { status: 'ready', name: 'Waveshare-625' } };
    assert.equal(formatStatus({ timer: { left: 1416, paused: false, phase: 'countdown' }, modules, components, ups }),
        'ТАЙМЕР: ОСТАЛОСЬ 023.00\nПИТАНИЕ: СЕТЬ · ЗАРЯД 100% · РЕЗЕРВ 78 МИН · НАГРУЗКА 6%\nVPN: NEW YORK\nAI: ПЕРЕПОДКЛЮЧЕНИЕ\niMESSAGE: ГОТОВ\nMAC MINI: ОШИБКА — НЕТ ДОСТУПА\n' +
        'ЭКРАН ТАЙМЕРА: НЕ РАБОТАЕТ\nЭКРАН ТЕРМИНАЛА: РАБОТАЕТ');
    assert.equal(formatStatus({ timer: { left: 200, paused: true, phase: 'countdown' }, modules: { ups: { enabled: true }, vpn: { enabled: true, status: 'ready', location: '' } }, ups: { online: true, vars: { 'ups.status': 'OB', 'battery.charge': '40' } } }),
        'ТАЙМЕР: ПАУЗА 003.00 · ВВОД КОДА\nПИТАНИЕ: БАТАРЕЯ · ЗАРЯД 40%\nVPN: ОТКЛЮЧЁН');
    assert.equal(formatStatus({ timer: { left: 0, phase: 'failure' }, modules: { ups: { enabled: true }, vpn: { enabled: true, status: 'unavailable' } }, ups: null }),
        'ТАЙМЕР: СБОЙ\nПИТАНИЕ: НЕТ ДАННЫХ\nVPN: НЕТ ДАННЫХ');
});

test('words are edited as one line, persist and survive reload; bad edits keep the old words', () => {
    const first = remote();
    assert.equal(first.r.setWords('pause', 'отбой, тишина'), true);
    assert.equal(first.r.run('Отбой', 'imessage'), '');
    assert.match(first.r.run('пауза', 'imessage').text, /НЕ РАСПОЗНАНА/);
    const again = remote({ saved: first.r.settings() });
    assert.deepEqual(again.r.snapshot().commands.find(c => c.id === 'pause').words, ['отбой', 'тишина']);
    assert.equal(again.r.setWords('pause', ' , '), false);
    assert.equal(again.r.setWords('quit', 'выход'), false);
    assert.equal(remote({ persist: false }).r.setWords('pause', 'x'), false);
    assert.deepEqual(normalizeSettings({ words: { pause: [] }, evil: 1 }).words.pause, defaults.pause);
});

test('station address commands are accepted only from the home network, never the tailnet or the internet', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.40', '10.0.0.5', '172.20.1.1']) assert.equal(isHomeNetwork(a), true, a);
    for (const a of ['100.99.36.23', '::ffff:100.64.0.1', '8.8.8.8', '172.32.0.1', '', 'fe80::1', '192.169.1.1']) assert.equal(isHomeNetwork(a), false, a);
});

test('iMessage: only listed senders are queried; while the module is off messages are skipped, not queued', async () => {
    const queries = [], replies = [], ran = [];
    let active = true, rows = '7\t+70000000000\tПауза\n';
    const exec = (bin, args, cb) => { if (bin === 'osascript') { replies.push(args.slice(-2)); return; } queries.push(args.at(-1)); cb(null, queries.length === 1 ? '6' : rows); };
    const im = createIMessage({ senders: ["+70000000000'; drop"], run: (text, channel, sender) => { ran.push([text, channel, sender]); return ''; }, status: () => 'LOST: идёт.', active: () => active, exec, setTimer: () => 1, later: fn => fn(), log() {} });
    assert.equal(im.start(), true);
    im.check();
    await new Promise(r => setImmediate(r));
    assert.match(queries[1], /h\.id in \('\+70000000000; drop'\)/);
    assert.deepEqual(ran, [['Пауза', 'imessage', '+70000000000']]);
    assert.deepEqual(replies, [['+70000000000', 'LOST: идёт.']]);
    active = false; rows = '8\t+70000000000\tСтарт\n'; im.check();
    active = true; rows = ''; im.check();
    assert.equal(ran.length, 1);
    assert.equal(createIMessage({ senders: [] }).start(), false);
});

test('timer time is МММ.СС: minutes only from a minute up, seconds only below a minute', () => {
    const { mmss } = require('./status.cjs');
    assert.deepEqual([6222, 6480, 360, 359, 60, 59, 6, 0].map(mmss), ['103.00', '108.00', '006.00', '005.00', '001.00', '000.59', '000.06', '000.00']);
});
