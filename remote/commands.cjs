'use strict';
// Команды пульта LOST — одним списком для обоих каналов: iMessage (глобально) и Siri (только домашняя сеть).
// Порядок важен: побеждает первое совпадение («звук выкл» разбирается раньше «старта» с его «выкл»).
// Код (только цифры) разбирается отдельно; выход и Dev намеренно недоступны удалённо.
const COMMANDS = [
    { id: 'code', label: 'КОД', phrases: ['4 8 15 16 23 42'] },
    { id: 'journal', label: 'ЖУРНАЛ', phrases: ['Журнал'], match: /^(журнал|journal)/ },
    { id: 'status', label: 'СТАТУС', phrases: ['Статус', '?'], match: /^(статус|status|\?)/ },
    { id: 'sound-off', label: 'ЗВУК ВЫКЛ', phrases: ['Звук выкл', 'Без звука', 'Тихо'], match: /звук выкл|без звука|тихо|mute/ },
    { id: 'speakers', label: 'ДИНАМИКИ', phrases: ['Динамики'], match: /динамик/ },
    { id: 'monitor', label: 'МОНИТОР', phrases: ['Монитор', 'HDMI'], match: /монитор|hdmi/ },
    { id: 'sound', label: 'ЗВУК ПО КРУГУ', phrases: ['Звук'], match: /^звук/ },
    { id: 'resume', label: 'СТАРТ', phrases: ['Старт', 'Утро', 'Подъём'], match: /(выкл|проснул|подъем|утро|встал|старт|пуск|продолж|play)/ },
    { id: 'pause', label: 'ПАУЗА', phrases: ['Пауза', 'Сон', 'Стоп'], match: /(пауза|сон|спать|сплю|стоп|pause)/ },
];
const normalize = text => String(text || '').trim().toLowerCase().replace(/ё/g, 'е');
function parse(text) {
    const t = normalize(text);
    if (/^[\d\s]+$/.test(t) && /\d/.test(t)) return { id: 'code', code: t.split(/\s+/).filter(Boolean).join(' ') };
    const command = COMMANDS.find(c => c.match && c.match.test(t));
    return command ? { id: command.id } : null;
}
module.exports = { COMMANDS, parse };
