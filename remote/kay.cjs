'use strict';
// Мост iMessage → Kay (AI, чат Muse). «kay: текст» уходит в тот же чат, что и диалог AI в терминале;
// ответ Kay возвращается отправителю. Muse подтверждает только приём, ответ дописывается в ленту позже:
// ждём своё сообщение в ленте, затем конца ответа (phase снова idle) и берём сообщения Kay после него.
const ASK = /^\s*(?:kay|кай)\s*[:,]\s*([\s\S]+)$/i;
const MAX_REPLY = 3500;
const { replyText } = require('./replies.cjs');
const standard = (id, vars) => replyText({}, id, vars);

function parseKay(text) {
    const m = ASK.exec(String(text || ''));
    const question = m && m[1].trim();
    return question || null;
}
// reply(id, vars) — текст ответа из настроек пульта (remote/replies.cjs); без него — стандартный.
function createKay({ send, chat, reply = standard, ready = () => true, pollMs = 1000, timeoutMs = 120000, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
    async function ask(question, channel = 'imessage') {
        if (!send || !chat || !ready()) return reply('kay_offline');
        const before = new Set((chat().messages || []).map(m => m.id));
        let sent;
        // пометка источника: в общей ленте AI видно, откуда пришёл вопрос
        try { sent = await send('[' + (channel === 'imessage' ? 'iMessage' : 'Команды iPhone') + '] ' + question); } catch (_) { sent = null; }
        if (!sent || !sent.ok) return reply(sent && sent.error === 'busy' ? 'kay_busy' : sent && sent.error === 'not_connected' ? 'kay_lost' : 'kay_unsent');
        const deadline = now() + timeoutMs;
        while (now() < deadline) {
            await wait(pollMs);
            const state = chat(), list = state.messages || [];
            const mine = list.findIndex(m => !before.has(m.id) && m.role === 'user');
            if (mine < 0) continue;
            if (state.phase === 'error') return reply('kay_error', { error: state.error || 'ответ не получен' });
            if (state.phase !== 'idle') continue;
            const answer = list.slice(mine + 1).filter(m => m.role === 'assistant' && String(m.text || '').trim()).map(m => String(m.text).trim()).join('\n\n');
            if (!answer) return reply('kay_empty');
            return reply('kay_reply', { reply: answer.length > MAX_REPLY ? answer.slice(0, MAX_REPLY) + '… (полностью — в AI на станции)' : answer });
        }
        return reply('kay_timeout', { minutes: Math.round(timeoutMs / 60000) });
    }
    return { ask };
}
module.exports = { parseKay, createKay };
