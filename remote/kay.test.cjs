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
    assert.equal(await kay.ask('как дела?'), 'KAY: Первая часть\n\nВторая часть');
    assert.deepEqual(m.sent, ['[iMessage] как дела?']);
    const home = muse({ step: (s, t) => { if (t === 2) { s.messages.push({ id: 'a', role: 'assistant', text: 'Да' }); s.phase = 'idle'; } } });
    assert.equal(await createKay({ send: home.send, chat: home.chat, ...fast }).ask('ты тут?', 'сеть'), 'KAY: Да');
    assert.deepEqual(home.sent, ['[Команды iPhone] ты тут?']);
});

test('Kay: busy, offline, Muse error, silence and timeout give one clear answer', async () => {
    assert.match(await createKay({ ...muse({ send: { ok: false, error: 'busy' } }), ...fast }).ask('x'), /^KAY: ЗАНЯТ$/);
    assert.equal(await createKay({ ...muse({ send: { ok: false, error: 'not_connected' } }), ...fast }).ask('x'), 'KAY: НЕТ СВЯЗИ');
    let t0 = 0; const offline = muse({});
    assert.equal(await createKay({ send: offline.send, chat: offline.chat, ready: () => false, pollMs: 1000, wait: async ms => { t0 += ms; }, now: () => t0 }).ask('x'), 'KAY: НЕТ СВЯЗИ');
    assert.equal(t0, 30000, 'waits 30 s for Muse to reconnect');assert.equal(offline.sent.length, 0);
    const failing = muse({ step: (s, t) => { if (t === 2) { s.phase = 'error'; s.error = 'Muse не завершил ответ за 90 секунд'; } } });
    assert.equal(await createKay({ send: failing.send, chat: failing.chat, ...fast }).ask('x'), 'KAY: ОШИБКА — MUSE НЕ ЗАВЕРШИЛ ОТВЕТ ЗА 90 СЕКУНД');
    const silent = muse({ step: (s, t) => { if (t === 2) s.phase = 'idle'; } });
    assert.equal(await createKay({ send: silent.send, chat: silent.chat, ...fast }).ask('x'), 'KAY: НЕТ ОТВЕТА');
    let clock = 0; const stuck = muse({});
    assert.match(await createKay({ send: stuck.send, chat: stuck.chat, pollMs: 0, wait: async () => { clock += 30000; }, now: () => clock, timeoutMs: 120000 }).ask('x'), /^KAY: НЕТ ОТВЕТА ЗА 2 МИН$/);
});

test('a long Kay reply is cut with a pointer to the station', async () => {
    const m = muse({ step: (s, t) => { if (t === 2) { s.messages.push({ id: 'a', role: 'assistant', text: 'я'.repeat(5000) }); s.phase = 'idle'; } } });
    const answer = await createKay({ send: m.send, chat: m.chat, ...fast }).ask('x');
    assert.ok(answer.length < 3600);
    assert.match(answer, /… \(ПОЛНОСТЬЮ — В AI\)$/);
});

test('the remote sends «kay: …» to Kay before any command words; Kay\'s answer goes without the status block', async () => {
    const calls = [];
    const actions = new Proxy({}, { get: (_, id) => () => { calls.push(id); return ''; } });
    const r = createRemote({ actions, kay: { ask: async q => 'Kay: принял «' + q + '»' } });
    assert.deepEqual(await r.run('кай: поставь стоп и статус', 'imessage', '+7'), { text: 'Kay: принял «поставь стоп и статус»', bare: true });
    assert.deepEqual(await createRemote({ actions }).run('kay: x', 'imessage'), { text: 'KAY: НЕ ПОДКЛЮЧЁН', bare: true });
    assert.deepEqual(calls, []);
    assert.match(r.run('help', 'imessage').text, /\nKAY: KAY: ВОПРОС\n/);
});

test('a question that arrives while Muse reconnects waits for the link instead of answering НЕТ СВЯЗИ', async () => {
    let t = 0; const m = muse({ step: (s, n) => { if (n === 2) { s.phase = 'idle'; s.messages.push({ id: 'a1', role: 'assistant', text: 'На связи' }); } } });
    const answer = await createKay({ send: m.send, chat: m.chat, ready: () => t >= 12000, pollMs: 1000, wait: async ms => { t += ms; }, now: () => t }).ask('привет');
    assert.equal(answer, 'KAY: На связи');assert.equal(m.sent.length, 1);
});
