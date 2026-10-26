'use strict';
const fs = require('node:fs');
const LIMIT = 120, MAX_BYTES = 256 * 1024;
const METHODS = new Set(['device.health', 'system.run', 'file.read', 'file.write']);
const STAGES = new Set(['received', 'completed', 'sent', 'send_failed', 'failed', 'cancelled']);
function event(value) {
 if (!value || !METHODS.has(value.method) || !STAGES.has(value.stage) ||
     !/^[a-f0-9]{32}$/.test(value.id || '') || !/^[a-f0-9]{16}$/.test(value.ref || '') ||
     !Number.isFinite(value.createdAt) || value.createdAt <= 0 || value.createdAt >= 9e15) return null;
 const row = {id:value.id, createdAt:value.createdAt, method:value.method, ref:value.ref, stage:value.stage};
 if (typeof value.ok === 'boolean') row.ok = value.ok;
 if (typeof value.timedOut === 'boolean') row.timedOut = value.timedOut;
 if (Number.isInteger(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 86400000) row.durationMs = value.durationMs;
 if (Number.isInteger(value.exitCode) && value.exitCode >= -255 && value.exitCode <= 255) row.exitCode = value.exitCode;
 return row;
}
function readAudit(file) {
 const result = {events:[], limit:LIMIT, maxBytes:MAX_BYTES, truncated:false, available:true};
 let fd;
 try {
  fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size, start = Math.max(0, size-MAX_BYTES);
  const data = Buffer.alloc(Math.min(size, MAX_BYTES));
  const read = fs.readSync(fd, data, 0, data.length, start);
  let lines = data.subarray(0,read).toString('utf8').split('\n');
  if (start) lines.shift();
  lines.pop(); // Ignore an incomplete append until the following poll.
  const seen = new Set(), rows = [];
  for (const line of lines) {
   if (!line || line.length > 2048) continue;
   try { const row = event(JSON.parse(line)); if(row && !seen.has(row.id)){seen.add(row.id);rows.push(row);} } catch (_) {}
  }
  result.truncated = start > 0 || rows.length > LIMIT;
  result.events = rows.slice(-LIMIT);
 } catch (error) { if(error.code !== 'ENOENT') result.available = false; }
 finally { if(fd !== undefined) fs.closeSync(fd); }
 return result;
}
module.exports = {readAudit, event, LIMIT, MAX_BYTES};
