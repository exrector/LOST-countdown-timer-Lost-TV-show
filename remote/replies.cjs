'use strict';
// Тексты ответов пульта (iMessage и «Команды» iPhone). Владелец правит их в меню:
// МОДУЛИ → ПУЛЬТ iMESSAGE → ОТВЕТЫ. Поля в фигурных скобках подставляет станция; пустой текст — стандартный.
// Состояние станции и список команд собираются из данных и сюда не входят — меняются только их заголовки.
const REPLIES = [
    { id: 'pause', label: 'ПАУЗА', text: '', about: 'Перед состоянием станции после паузы. Пусто — только состояние.' },
    { id: 'resume', label: 'СТАРТ', text: '', about: 'Перед состоянием станции после старта. Пусто — только состояние.' },
    { id: 'status', label: 'СТАТУС', text: '', about: 'Перед состоянием станции в ответ на «статус». Пусто — только состояние.' },
    { id: 'code_sent', label: 'КОД ПРИНЯТ', text: 'Код отправлен.', about: 'Код пришёл в последние 4 минуты цикла.' },
    { id: 'code_closed', label: 'КОД РАНО', text: 'Код не принят: терминал открывается только в последние 4 минуты.', about: 'Код пришёл раньше последних 4 минут.' },
    { id: 'journal', label: 'ЖУРНАЛ', text: 'Журнал станции:\n{journal}', vars: ['journal'], about: '{journal} — последние записи журнала.' },
    { id: 'journal_empty', label: 'ЖУРНАЛ ПУСТ', text: '(пусто)', about: 'Вместо {journal}, когда журнал пуст.' },
    { id: 'help', label: 'СПРАВКА', text: 'LOST — команды пульта:\n{commands}', vars: ['commands'], about: '{commands} — команды LOST с их словами, код, Kay и команды Mac mini.' },
    { id: 'unknown', label: 'НЕ ПОНЯЛ', text: 'Не понял «{said}». Список команд — «{help}».', vars: ['said', 'help'], about: '{said} — присланный текст, {help} — первое слово справки.' },
    { id: 'shortcut', label: 'КОМАНДА MAC MINI', text: 'Команда «{name}»: {result}', vars: ['name', 'result'], about: '{name} — название команды, {result} — её итог или ошибка.' },
    { id: 'kay_reply', label: 'KAY: ОТВЕТ', text: 'Kay: {reply}', vars: ['reply'], about: '{reply} — ответ Kay.' },
    { id: 'kay_offline', label: 'KAY: НЕ НА СВЯЗИ', text: 'Kay не на связи: модуль AI выключен или не готов.', about: 'Модуль AI выключен или не готов.' },
    { id: 'kay_busy', label: 'KAY: ЗАНЯТ', text: 'Kay занят — ещё отвечает на прошлый вопрос. Повторите позже.', about: 'Kay ещё отвечает на прошлый вопрос.' },
    { id: 'kay_lost', label: 'KAY: СВЯЗЬ ПРОПАЛА', text: 'Kay не на связи.', about: 'Muse отказал: нет соединения.' },
    { id: 'kay_unsent', label: 'KAY: НЕ ОТПРАВЛЕНО', text: 'Kay: сообщение не отправлено.', about: 'Вопрос не удалось отправить.' },
    { id: 'kay_error', label: 'KAY: ОШИБКА', text: 'Kay: ошибка — {error}.', vars: ['error'], about: '{error} — что сообщил Muse.' },
    { id: 'kay_empty', label: 'KAY: МОЛЧИТ', text: 'Kay ничего не ответил.', about: 'Ответ пришёл пустым.' },
    { id: 'kay_timeout', label: 'KAY: НЕ УСПЕЛ', text: 'Kay не ответил за {minutes} мин. Ответ появится в AI на станции.', vars: ['minutes'], about: '{minutes} — сколько минут станция ждала.' },
    { id: 'kay_missing', label: 'KAY: НЕ ПОДКЛЮЧЁН', text: 'Kay не подключён.', about: 'Мост Kay на станции не создан.' },
    { id: 'unavailable', label: 'СОСТОЯНИЕ НЕДОСТУПНО', text: 'LOST: состояние недоступно.', about: 'Ответ пустой, а состояние станции прочитать не удалось.' },
];
const BY_ID = Object.fromEntries(REPLIES.map(r => [r.id, r]));
const MAX_REPLY_TEXT = 1000;

// Сохранённые правки: только известные ответы и строки; пустая или равная стандартной не хранится.
function normalizeReplies(value) {
    const own = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(REPLIES.filter(r => typeof own[r.id] === 'string' && own[r.id].trim() && own[r.id] !== r.text && own[r.id].length <= MAX_REPLY_TEXT).map(r => [r.id, own[r.id]]));
}
function fill(template, vars = {}) {
    return String(template).replace(/\{(\w+)\}/g, (all, name) => Object.hasOwn(vars, name) ? String(vars[name]) : all);
}
function replyText(own, id, vars) {
    const r = BY_ID[id];
    if (!r) return '';
    return fill(Object.hasOwn(own, id) ? own[id] : r.text, vars);
}
module.exports = { REPLIES, MAX_REPLY_TEXT, normalizeReplies, replyText, fill };
