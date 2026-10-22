'use strict';
const net = require('node:net');
const { StringDecoder } = require('node:string_decoder');
const MAX_LINE = 65536;
const MAX_RESPONSE = 1024 * 1024;
class NutError extends Error {
  constructor(code, message = 'NUT request failed') { super(message); this.name = 'NutError'; this.code = code; }
}
function clean(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new NutError('INVALID_ARGUMENT', 'Invalid NUT argument');
  return value;
}
function identifier(value) {
  clean(value);
  if (!/^[A-Za-z0-9_.:@-]+$/.test(value)) throw new NutError('INVALID_ARGUMENT', 'Invalid NUT identifier');
  return value;
}
function quote(value) { return '"' + clean(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function tokenize(line) {
  clean(line);
  const out = []; let i = 0;
  while (i < line.length) {
    while (line[i] === ' ') i++;
    if (i === line.length) break;
    let token = '';
    if (line[i] === '"') {
      i++; let closed = false;
      while (i < line.length) {
        const ch = line[i++];
        if (ch === '"') { closed = true; break; }
        if (ch === '\\') {
          if (i === line.length || !['\\', '"'].includes(line[i])) throw new NutError('PROTOCOL', 'Invalid NUT escape');
          token += line[i++];
        } else token += ch;
      }
      if (!closed || (i < line.length && line[i] !== ' ')) throw new NutError('PROTOCOL', 'Malformed NUT quoted token');
    } else {
      while (i < line.length && line[i] !== ' ') {
        if (line[i] === '"' || line[i] === '\\') throw new NutError('PROTOCOL', 'Malformed NUT token');
        token += line[i++];
      }
    }
    out.push(token);
  }
  return out;
}
class Session {
  constructor(options) {
    this.timeout = options.timeout; this.deadline = Date.now() + options.totalTimeout; this.pending = null; this.buffer = ''; this.decoder = new StringDecoder('utf8'); this.dead = false;
    this.socket = net.createConnection({host: options.host, port: options.port});
    this.connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const error = new NutError('TIMEOUT', 'NUT connection timed out'); reject(error); this.fail(error); }, this.timeout);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', () => { clearTimeout(timer); reject(new NutError('CONNECTION', 'NUT connection failed')); });
      this.socket.once('close', () => { clearTimeout(timer); reject(new NutError('CONNECTION', 'NUT connection closed')); });
    });
    this.socket.on('data', chunk => {
      try {
        this.buffer += this.decoder.write(chunk);
        if (Buffer.byteLength(this.buffer) > MAX_RESPONSE) throw new NutError('LIMIT', 'NUT response too large');
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index).replace(/\r$/, ''); this.buffer = this.buffer.slice(index + 1);
          if (Buffer.byteLength(line) > MAX_LINE) throw new NutError('LIMIT', 'NUT line too long');
          this.line(line);
        }
        if (Buffer.byteLength(this.buffer) > MAX_LINE) throw new NutError('LIMIT', 'NUT line too long');
      } catch (error) { this.fail(error); }
    });
    this.socket.on('error', () => this.fail(new NutError('CONNECTION', 'NUT connection failed')));
    this.socket.on('close', () => this.fail(new NutError('CONNECTION', 'NUT connection closed')));
  }
  fail(error) {
    this.dead = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    this.socket.destroy();
  }
  line(line) {
    const p = this.pending;
    if (!p) throw new NutError('PROTOCOL', 'Unexpected NUT response');
    p.bytes += Buffer.byteLength(line) + 1;
    if (p.bytes > MAX_RESPONSE) throw new NutError('LIMIT', 'NUT response too large');
    const tokens = tokenize(line);
    if (tokens[0] === 'ERR') return this.finish(new NutError(tokens[1] || 'SERVER', 'NUT server rejected request'));
    if (!p.list) return this.finish(null, tokens);
    if (!p.started) {
      if (JSON.stringify(tokens) !== JSON.stringify(['BEGIN', ...p.list])) throw new NutError('PROTOCOL', 'Invalid NUT list header');
      p.started = true; return;
    }
    if (tokens[0] === 'END') {
      if (JSON.stringify(tokens) !== JSON.stringify(['END', ...p.list])) throw new NutError('PROTOCOL', 'Invalid NUT list footer');
      return this.finish(null, p.rows);
    }
    if (tokens[0] === 'BEGIN') throw new NutError('PROTOCOL', 'Unexpected NUT list header');
    p.rows.push(tokens);
  }
  finish(error, value) {
    const p = this.pending; this.pending = null; clearTimeout(p.timer);
    if (error) p.reject(error); else p.resolve(value);
  }
  async request(command, list = null) {
    await this.connected;
    if (this.dead) throw new NutError('CONNECTION', 'NUT connection closed');
    if (this.pending) throw new NutError('BUSY', 'NUT request already in progress');
    return new Promise((resolve, reject) => {
      this.pending = {resolve, reject, list, rows: [], bytes: 0, started: false,
        timer: setTimeout(() => this.fail(new NutError('TIMEOUT', 'NUT request timed out')), Math.max(1, Math.min(this.timeout, this.deadline-Date.now())))};
      this.socket.write(command + '\n');
    });
  }
  close() { this.socket.destroy(); }
}
function expect(tokens, prefix, length) {
  if (tokens.length !== length || prefix.some((v, i) => tokens[i] !== v)) throw new NutError('PROTOCOL', 'Invalid NUT response');
  return tokens;
}
function ok(tokens) { expect(tokens, ['OK'], 1); }
class NutClient {
  constructor({host, port = 3493, ups = 'ups0', timeout = 3500, totalTimeout = 7000} = {}) {
    clean(host);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(totalTimeout) || totalTimeout <= 0) throw new NutError('INVALID_ARGUMENT', 'Invalid NUT connection options');
    this.options = {host, port, ups: identifier(ups), timeout, totalTimeout};
  }
  async snapshot() {
    const session = new Session(this.options); const ups = this.options.ups;
    try {
      const vars = Object.create(null), writable = Object.create(null);
      for (const row of await session.request(`LIST VAR ${ups}`, ['LIST', 'VAR', ups])) {
        expect(row, ['VAR', ups], 4); identifier(row[2]); vars[row[2]] = row[3];
      }
      const sampledAt = Date.now();
      for (const row of await session.request(`LIST RW ${ups}`, ['LIST', 'RW', ups])) {
        expect(row, ['RW', ups], 4); identifier(row[2]);
        writable[row[2]] = {value: row[3], type: '', enum: [], range: [], description: ''};
      }
      for (const [name, meta] of Object.entries(writable)) {
        if (session.dead) break;
        try {
          const type = await session.request(`GET TYPE ${ups} ${name}`);
          if (type.length < 4 || type[0] !== 'TYPE' || type[1] !== ups || type[2] !== name) throw new NutError('PROTOCOL');
          meta.type = type.slice(3).join(' ');
          if (type.slice(3).includes('ENUM')) {
            meta.enum = (await session.request(`LIST ENUM ${ups} ${name}`, ['LIST', 'ENUM', ups, name])).map(row => expect(row, ['ENUM', ups, name], 4)[3]);
          }
          if (type.slice(3).includes('RANGE')) {
            meta.range = (await session.request(`LIST RANGE ${ups} ${name}`, ['LIST', 'RANGE', ups, name])).map(row => { expect(row, ['RANGE', ups, name], 5); return [row[3], row[4]]; });
          }
        } catch (_) { /* Metadata is optional; preserve the readable snapshot. */ }
        if (session.dead) break;
        try { meta.description = expect(await session.request(`GET DESC ${ups} ${name}`), ['DESC', ups, name], 4)[3]; } catch (_) { /* Optional metadata. */ }
      }
      return {vars, writable, sampledAt};
    } finally { session.close(); }
  }
  async authenticated(command, {username, password} = {}) {
    const user = quote(username), pass = quote(password);
    const session = new Session(this.options);
    try {
      ok(await session.request(`USERNAME ${user}`));
      ok(await session.request(`PASSWORD ${pass}`));
      ok(await session.request(command));
      return true;
    } finally { session.close(); }
  }
  async setVariable(name, value, credentials) {
    return this.authenticated(`SET VAR ${this.options.ups} ${identifier(name)} ${quote(value)}`, credentials);
  }
  async instant(command, credentials) {
    return this.authenticated(`INSTCMD ${this.options.ups} ${identifier(command)}`, credentials);
  }
}
module.exports = {NutClient, tokenize, NutError};
