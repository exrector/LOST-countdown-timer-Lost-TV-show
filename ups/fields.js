'use strict';
const labels = {
 'battery.charge': ['Заряд аккумулятора', '%'], 'battery.charge.low': ['Низкий заряд', '%'],
 'battery.charge.warning': ['Предупреждение о заряде', '%'], 'battery.runtime': ['Расчётная автономность', 'с'],
 'battery.runtime.low': ['Малое оставшееся время', 'с'], 'battery.status': ['Статус аккумулятора', ''],
 'battery.voltage': ['Напряжение аккумулятора', 'В'], 'battery.voltage.nominal': ['Номинальное напряжение аккумулятора', 'В'],
 'battery.type': ['Тип аккумулятора', ''], 'battery.mfr.date': ['Данные производителя аккумулятора', ''],
 'input.voltage': ['Входное напряжение', 'В'], 'input.voltage.nominal': ['Номинальное входное напряжение', 'В'],
 'output.voltage': ['Выходное напряжение', 'В'], 'input.sensitivity': ['Чувствительность сети', ''],
 'input.transfer.low': ['Нижняя граница переключения', 'В'], 'input.transfer.high': ['Верхняя граница переключения', 'В'],
 'ups.load': ['Нагрузка', '%'], 'ups.status': ['Состояние питания', ''], 'ups.model': ['Модель', ''],
 'ups.mfr': ['Производитель', ''], 'ups.serial': ['Серийный номер', ''], 'ups.firmware': ['Микропрограмма', ''],
 'ups.realpower.nominal': ['Номинальная мощность', 'Вт'], 'ups.beeper.status': ['Звуковой сигнал', ''],
 'ups.delay.shutdown': ['Задержка отключения ИБП', 'с'], 'ups.delay.start': ['Задержка возврата питания', 'с'],
 'ups.timer.shutdown': ['Таймер отключения (значение NUT)', 'с'], 'ups.timer.start': ['Таймер включения (значение NUT)', 'с'],
 'ups.test.result': ['Результат самотеста', ''], 'device.type': ['Тип устройства', ''],
 'device.model': ['Модель устройства', ''], 'device.mfr': ['Производитель устройства', ''], 'device.serial': ['Серийный номер устройства', '']
};
const EDITABLE = {
 'battery.charge.low': { min: 5, max: 50 }, 'battery.runtime.low': { min: 60, max: 3600 },
 'input.sensitivity': { enum: ['low', 'normal', 'high'] },
 'input.transfer.low': { min: 140, max: 220 }, 'input.transfer.high': { min: 230, max: 290 },
 'ups.delay.shutdown': { min: 60, max: 600 }, 'ups.delay.start': { min: 60, max: 1800 }
};
function describe(vars, writable) {
 return Object.keys(vars).sort().map(key => ({key, value: vars[key], label: (labels[key] || [key])[0], unit: (labels[key] || ['', ''])[1],
  group: key.startsWith('driver.') ? 'driver' : key.startsWith('battery.') ? 'battery' : /^(input|output)\./.test(key) ? 'line' : 'device',
  editable: !!(EDITABLE[key] && writable[key]), limits: EDITABLE[key] || null, metadata: writable[key] || null}));
}
function validateVariable(name, value, snapshot) {
 const rule = EDITABLE[name];
 if (!rule || !snapshot.writable[name]) throw new Error('Этот параметр доступен только для чтения');
 value = String(value);
 if (rule.enum) {
  const choices = snapshot.writable[name].enum;
  if (!rule.enum.includes(value) || (choices && choices.length && !choices.includes(value))) throw new Error('Недопустимое значение');
 } else {
  if (!/^\d+$/.test(value) || +value < rule.min || +value > rule.max) throw new Error(`Допустимо целое число ${rule.min}–${rule.max}`);
  const ranges = snapshot.writable[name].range || [];
  if (ranges.length && !ranges.some(r => +value >= +r[0] && +value <= +r[1])) throw new Error('Значение вне диапазона, разрешённого ИБП');
  if (name === 'battery.charge.low' && Number(snapshot.vars['battery.charge.warning']) > 0 && +value > +snapshot.vars['battery.charge.warning']) throw new Error('Низкий заряд должен быть не выше порога предупреждения');
 }
 return value;
}
module.exports = { describe, validateVariable, EDITABLE };
