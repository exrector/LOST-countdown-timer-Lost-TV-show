'use strict';
const DEFAULT_POLICY = Object.freeze({ enabled: false, chargePercent: 15, runtimeSeconds: 300, holdSeconds: 30, countdownSeconds: 60 });
function validatePolicy(p) {
 if (!p || typeof p.enabled !== 'boolean') throw new Error('Нужен явный переключатель защиты');
 const ranges = { chargePercent: [5,50], runtimeSeconds:[60,3600], holdSeconds:[15,300], countdownSeconds:[30,300] };
 const out = { enabled: p.enabled };
 for (const [key, [min,max]] of Object.entries(ranges)) {
  if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max) throw new Error(`${key}: допустимо ${min}–${max}`);
  out[key] = p[key];
 }
 return out;
}
module.exports = { DEFAULT_POLICY, validatePolicy };
