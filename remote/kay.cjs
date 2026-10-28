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
// readyWaitMs: связь с Muse рвётся каждые несколько минут и восстанавливается за 5–12 с — вопрос, пришедший
// в этот промежуток, ждёт переподключения, а не получает сразу «НЕТ СВЯЗИ» (28.10, 17:10:33 → обрыв 17:10:35–17:10:47).
function createKay({ send, chat, ready = () => true, pollMs = 1000, timeoutMs = 120000, readyWaitMs = 30000, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
    async function ask(question, channel = 'imessage') {
        if (!send || !chat) return 'KAY: НЕТ СВЯЗИ';
        for (const until = now() + readyWaitMs; !ready() && now() < until;) await wait(pollMs || 1000);
        if (!ready()) return 'KAY: НЕТ СВЯЗИ';
        const before = new Set((chat().messages || []).map(m => m.id));
        let sent;
        // пометка источника: в общей ленте AI видно, откуда пришёл вопрос
        try { sent = await send('[' + (channel === 'imessage' ? 'iMessage' : 'Команды iPhone') + '] ' + question); } catch (_) { sent = null; }
        if (!sent || !sent.ok) return sent && sent.error === 'busy' ? 'KAY: ЗАНЯТ' : sent && sent.error === 'not_connected' ? 'KAY: НЕТ СВЯЗИ' : 'KAY: НЕ ОТПРАВЛЕНО';
        const deadline = now() + timeoutMs;
        while (now() < deadline) {
            await wait(pollMs);
            const state = chat(), list = state.messages || [];
            const mine = list.findIndex(m => !before.has(m.id) && m.role === 'user');
            if (mine < 0) continue;
            if (state.phase === 'error') return 'KAY: ОШИБКА — ' + String(state.error || 'НЕТ ОТВЕТА').toUpperCase();
            if (state.phase !== 'idle') continue;
            const reply = list.slice(mine + 1).filter(m => m.role === 'assistant' && String(m.text || '').trim()).map(m => String(m.text).trim()).join('\n\n');
            if (!reply) return 'KAY: НЕТ ОТВЕТА';
            return 'KAY: ' + (reply.length > MAX_REPLY ? reply.slice(0, MAX_REPLY) + '… (ПОЛНОСТЬЮ — В AI)' : reply);
        }
        return 'KAY: НЕТ ОТВЕТА ЗА ' + Math.round(timeoutMs / 60000) + ' МИН';
    }
    return { ask };
}
module.exports = { parseKay, createKay };
