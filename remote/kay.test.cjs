'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseKay, createKay } = require('./kay.cjs');
const { createRemote } = require('./runtime.cjs');

test('«kay: …» / «кай, …» is a question for Kay; other text is not', () => {
    assert.equal(parseKay('kay: как дела?'), 'как дела?');
    assert.equal(parseKay('  Кай,  поставь паузу\nи ещё'), 'поставь паузу\nи ещё');
    assert.equal(parseKay('KAY:привет'), 'привет');
    for (const t of ['kay', 'kay:', 'kay:   ', 'кайф: нет', 'okay: x', 'привет kay: x', 'Пауза']) assert.equal(parseKay(t), null, t);
});

// Муляж чата Muse: отправка подтверждает приём, ответ дописывается в ленту за несколько опросов.
function muse(script) {
    const state = { phase: 'idle', messages: [{ id: 'old-u', role: 'user', text: 'старое' }, { id: 'old-a', role: 'assistant', text: 'старый ответ' }], error: null };
    const sent = [];
    let tick = 0;
    return { state, sent,
        send: async text => { sent.push(text); if (script.send) return script.send; state.messages.push({ id: 'u' + sent.length, role: 'user', text }); state.phase = 'waiting'; return { ok: true }; },
        chat: () => { tick++; if (script.step) script.step(state, tick); return JSON.parse(JSON.stringify(state)); } };
}
const fast = { pollMs: 0, wait: () => Promise.resolve() };

test('Kay: the question goes to the shared chat marked [iMessage]; the reply after it comes back once Muse is idle', async () => {
    const m = muse({ step: (s, t) => {
        if (t === 3) { s.phase = 'replying'; s.messages.push({ id: 'a1', role: 'assistant', text: 'Первая часть', pending: true }); }
        if (t === 5) { s.messages.push({ id: 'a2', role: 'assistant', text: 'Вторая часть' }); }
        if (t === 6) s.phase = 'idle';
    } });
    const kay = createKay({ send: m.send, chat: m.chat, ...fast });
    assert.equal(await kay.ask('как дела?'), 'Kay: Первая часть\n\nВторая часть');
    assert.deepEqual(m.sent, ['[iMessage] как дела?']);
    const home = muse({ step: (s, t) => { if (t === 2) { s.messages.push({ id: 'a', role: 'assistant', text: 'Да' }); s.phase = 'idle'; } } });
    assert.equal(await createKay({ send: home.send, chat: home.chat, ...fast }).ask('ты тут?', 'сеть'), 'Kay: Да');
    assert.deepEqual(home.sent, ['[Команды iPhone] ты тут?']);
});

test('Kay: busy, offline, Muse error, silence and timeout give one clear answer', async () => {
    assert.match(await createKay({ ...muse({ send: { ok: false, error: 'busy' } }), ...fast }).ask('x'), /^Kay занят/);
    assert.equal(await createKay({ ...muse({ send: { ok: false, error: 'not_connected' } }), ...fast }).ask('x'), 'Kay не на связи.');
    assert.match(await createKay({ ...muse({}), ready: () => false, ...fast }).ask('x'), /^Kay не на связи: модуль AI выключен/);
    const failing = muse({ step: (s, t) => { if (t === 2) { s.phase = 'error'; s.error = 'Muse не завершил ответ за 90 секунд'; } } });
    assert.equal(await createKay({ send: failing.send, chat: failing.chat, ...fast }).ask('x'), 'Kay: ошибка — Muse не завершил ответ за 90 секунд.');
    const silent = muse({ step: (s, t) => { if (t === 2) s.phase = 'idle'; } });
    assert.equal(await createKay({ send: silent.send, chat: silent.chat, ...fast }).ask('x'), 'Kay ничего не ответил.');
    let clock = 0; const stuck = muse({});
    assert.match(await createKay({ send: stuck.send, chat: stuck.chat, pollMs: 0, wait: async () => { clock += 30000; }, now: () => clock, timeoutMs: 120000 }).ask('x'), /^Kay не ответил за 2 мин/);
});

test('a long Kay reply is cut with a pointer to the station', async () => {
    const m = muse({ step: (s, t) => { if (t === 2) { s.messages.push({ id: 'a', role: 'assistant', text: 'я'.repeat(5000) }); s.phase = 'idle'; } } });
    const answer = await createKay({ send: m.send, chat: m.chat, ...fast }).ask('x');
    assert.ok(answer.length < 3600);
    assert.match(answer, /… \(полностью — в AI на станции\)$/);
});

test('the remote sends «kay: …» to Kay before any command words; Kay\'s answer goes without the status block', async () => {
    const calls = [];
    const actions = new Proxy({}, { get: (_, id) => () => { calls.push(id); return ''; } });
    const r = createRemote({ actions, kay: { ask: async q => 'Kay: принял «' + q + '»' } });
    assert.deepEqual(await r.run('кай: поставь стоп и статус', 'imessage', '+7'), { text: 'Kay: принял «поставь стоп и статус»', bare: true });
    assert.deepEqual(await createRemote({ actions }).run('kay: x', 'imessage'), { text: 'Kay не подключён.', bare: true });
    assert.deepEqual(calls, []);
    assert.match(r.run('help', 'imessage').text, /• KAY: «kay: вопрос» или «кай: вопрос»/);
});
