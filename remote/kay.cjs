'use strict';
// Мост iMessage → Kay (AI, чат Muse). «kay: текст» уходит в тот же чат, что и диалог AI в терминале;
// ответ Kay возвращается отправителю. Muse подтверждает только приём, ответ дописывается в ленту позже:
// ждём своё сообщение в ленте, затем конца ответа (phase снова idle) и берём сообщения Kay после него.
const ASK = /^\s*(?:kay|кай)\s*[:,]\s*([\s\S]+)$/i;
const MAX_REPLY = 3500;

function parseKay(text) {
    const m = ASK.exec(String(text || ''));
    const question = m && m[1].trim();
    return question || null;
}
function createKay({ send, chat, ready = () => true, pollMs = 1000, timeoutMs = 120000, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
    async function ask(question, channel = 'imessage') {
        if (!send || !chat || !ready()) return 'Kay не на связи: модуль AI выключен или не готов.';
        const before = new Set((chat().messages || []).map(m => m.id));
        let sent;
        // пометка источника: в общей ленте AI видно, откуда пришёл вопрос
        try { sent = await send('[' + (channel === 'imessage' ? 'iMessage' : 'Команды iPhone') + '] ' + question); } catch (_) { sent = null; }
        if (!sent || !sent.ok) return sent && sent.error === 'busy' ? 'Kay занят — ещё отвечает на прошлый вопрос. Повторите позже.'
            : sent && sent.error === 'not_connected' ? 'Kay не на связи.' : 'Kay: сообщение не отправлено.';
        const deadline = now() + timeoutMs;
        while (now() < deadline) {
            await wait(pollMs);
            const state = chat(), list = state.messages || [];
            const mine = list.findIndex(m => !before.has(m.id) && m.role === 'user');
            if (mine < 0) continue;
            if (state.phase === 'error') return 'Kay: ошибка — ' + (state.error || 'ответ не получен') + '.';
            if (state.phase !== 'idle') continue;
            const reply = list.slice(mine + 1).filter(m => m.role === 'assistant' && String(m.text || '').trim()).map(m => String(m.text).trim()).join('\n\n');
            if (!reply) return 'Kay ничего не ответил.';
            return 'Kay: ' + (reply.length > MAX_REPLY ? reply.slice(0, MAX_REPLY) + '… (полностью — в AI на станции)' : reply);
        }
        return 'Kay не ответил за ' + Math.round(timeoutMs / 60000) + ' мин. Ответ появится в AI на станции.';
    }
    return { ask };
}
module.exports = { parseKay, createKay };
