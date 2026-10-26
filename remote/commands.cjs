'use strict';
// Команды LOST для пульта iMessage. У каждой — список слов; владелец правит его в меню одной строкой через запятую.
// Сообщение сначала сверяется со словами целиком, затем по вхождению слова — в порядке списка.
// Код (одни цифры) разбирается отдельно; выход и Dev удалённо недоступны.
const COMMANDS = [
    { id: 'journal', label: 'ЖУРНАЛ', words: ['журнал', 'journal'] },
    { id: 'status', label: 'СТАТУС', words: ['статус', 'status', '?'] },
    { id: 'resume', label: 'СТАРТ', words: ['старт', 'утро', 'подъем', 'проснул', 'встал', 'пуск', 'продолж', 'play', 'выкл'] },
    { id: 'pause', label: 'ПАУЗА', words: ['пауза', 'сон', 'спать', 'сплю', 'стоп', 'pause'] },
];
const normalize = text => String(text || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
// Строка из меню → список слов: через запятую, пустые и повторы убираются.
function parseWords(line) {
    const out = [];
    for (const w of String(line || '').split(',').map(normalize)) if (w && w.length <= 60 && !out.includes(w)) out.push(w);
    return out.slice(0, 40);
}
function match(text, words) {
    const t = normalize(text);
    if (/^[\d\s]+$/.test(t) && /\d/.test(t)) return { id: 'code', code: t.split(' ').filter(Boolean).join(' ') };
    const exact = COMMANDS.find(c => (words[c.id] || []).includes(t));
    if (exact) return { id: exact.id };
    const part = COMMANDS.find(c => (words[c.id] || []).some(w => t.includes(w)));
    return part ? { id: part.id } : null;
}
module.exports = { COMMANDS, normalize, parseWords, match };
