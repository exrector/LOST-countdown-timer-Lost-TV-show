'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {NutClient, tokenize, NutError} = require('../nut');
async function mock(t, handler) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data; let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        handler(socket, line);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return {host: '127.0.0.1', port: server.address().port, timeout: 500};
}
test('tokenize preserves quoted values and rejects malformed input', () => {
  assert.deepEqual(tokenize('VAR ups0 name "a \\"b\\" \\\\ c"'), ['VAR', 'ups0', 'name', 'a "b" \\ c']);
  for (const line of ['"unfinished', '"a"b', 'x\ny', '"bad\\q"']) assert.throws(() => tokenize(line), NutError);
});
test('snapshot handles fragmented UTF8, enum, range, and optional errors', async t => {
  const commands = [];
  const replies = {
    'LIST VAR ups0': 'BEGIN LIST VAR ups0\nVAR ups0 device.model "Кибер \\"Power\\""\nVAR ups0 battery.charge "100"\nEND LIST VAR ups0\n',
    'LIST RW ups0': 'BEGIN LIST RW ups0\nRW ups0 ups.mode "normal"\nRW ups0 battery.charge.low "20"\nRW ups0 unsupported "x"\nEND LIST RW ups0\n',
    'GET TYPE ups0 ups.mode': 'TYPE ups0 ups.mode RW ENUM\n',
    'LIST ENUM ups0 ups.mode': 'BEGIN LIST ENUM ups0 ups.mode\nENUM ups0 ups.mode "normal"\nENUM ups0 ups.mode "eco mode"\nEND LIST ENUM ups0 ups.mode\n',
    'GET DESC ups0 ups.mode': 'DESC ups0 ups.mode "Operating mode"\n',
    'GET TYPE ups0 battery.charge.low': 'TYPE ups0 battery.charge.low RW RANGE\n',
    'LIST RANGE ups0 battery.charge.low': 'BEGIN LIST RANGE ups0 battery.charge.low\nRANGE ups0 battery.charge.low "10" "50"\nEND LIST RANGE ups0 battery.charge.low\n',
    'GET TYPE ups0 unsupported': 'ERR UNKNOWN-COMMAND\n'
  };
  const options = await mock(t, (socket, line) => {
    commands.push(line);
    const bytes = Buffer.from(replies[line] || 'ERR VAR-NOT-SUPPORTED\n');
    socket.write(bytes.subarray(0, 2));
    setTimeout(() => { socket.write(bytes.subarray(2, 52)); setTimeout(() => socket.write(bytes.subarray(52)), 2); }, 2);
  });
  const result = await new NutClient(options).snapshot();
  assert.equal(result.vars['device.model'], 'Кибер "Power"');
  assert.equal(result.vars['battery.charge'], '100');
  assert.deepEqual(result.writable['ups.mode'].enum, ['normal', 'eco mode']);
  assert.equal(result.writable['ups.mode'].description, 'Operating mode');
  assert.equal(result.writable['battery.charge.low'].type, 'RW RANGE');
  assert.deepEqual(result.writable['battery.charge.low'].range, [['10', '50']]);
  assert.equal(result.writable.unsupported.value, 'x');
  assert.equal(result.writable.unsupported.type, '');
  assert.ok(commands.includes('GET DESC ups0 unsupported'));
});
test('setVariable quotes values and credentials correctly', async t => {
  const commands = [];
  const options = await mock(t, (socket, line) => { commands.push(tokenize(line)); socket.write('OK\n'); });
  assert.equal(await new NutClient(options).setVariable('ups.description', 'a "quote" \\ path', {username: 'user name', password: 'p"a\\ss'}), true);
  assert.deepEqual(commands, [ ['USERNAME', 'user name'], ['PASSWORD', 'p"a\\ss'], ['SET', 'VAR', 'ups0', 'ups.description', 'a "quote" \\ path'] ]);
});
test('authentication rejection is sanitized and stops before mutation', async t => {
  const commands = [];
  const options = await mock(t, (socket, line) => { commands.push(tokenize(line)[0]); socket.write(line.startsWith('PASSWORD') ? 'ERR ACCESS-DENIED\n' : 'OK\n'); });
  await assert.rejects(new NutClient(options).setVariable('ups.description', 'x', {username: 'test', password: 'secret-never-shown'}), error => error.code === 'ACCESS-DENIED' && !error.message.includes('secret'));
  assert.deepEqual(commands, ['USERNAME', 'PASSWORD']);
});
test('command deadline does not reset for trickling data', async t => {
  const options = await mock(t, (socket) => {
    const interval = setInterval(() => socket.write('x'), 8);
    socket.on('close', () => clearInterval(interval));
  });
  const started = Date.now();
  await assert.rejects(new NutClient({...options, timeout: 60}).snapshot(), error => error.code === 'TIMEOUT');
  assert.ok(Date.now() - started < 400);
});
test('rejects line injection before any connection', async () => {
  const client = new NutClient({host: '127.0.0.1', port: 1});
  await assert.rejects(client.setVariable('ups.description', 'x\nSET VAR ups0 x y', {username: 'a', password: 'b'}), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(client.instant('beeper.enable\nBAD', {username: 'a', password: 'b'}), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(client.setVariable('ups.description', 'x', {username: 'a', password: 'b\rBAD'}), error => error.code === 'INVALID_ARGUMENT');
});
test('instant authenticates and checks OK using a mock only', async t => {
  const commands = [];
  const options = await mock(t, (socket, line) => { commands.push(tokenize(line)); socket.write('OK\n'); });
  await new NutClient(options).instant('beeper.enable', {username: 'u', password: 'p'});
  assert.deepEqual(commands[2], ['INSTCMD', 'ups0', 'beeper.enable']);
});
test('oversized line and incorrect list framing close the request', async t => {
  const options = await mock(t, (socket) => socket.write('x'.repeat(65537)));
  await assert.rejects(new NutClient(options).snapshot(), error => error.code === 'LIMIT');
  const invalid = await mock(t, (socket) => socket.write('BEGIN LIST RW ups0\n'));
  await assert.rejects(new NutClient(invalid).snapshot(), error => error.code === 'PROTOCOL');
});
test('metadata timeout retains collected snapshot', async t => {
  const options = await mock(t, (socket, line) => {
    if (line === 'LIST VAR ups0') socket.write('BEGIN LIST VAR ups0\nVAR ups0 battery.charge "100"\nEND LIST VAR ups0\n');
    if (line === 'LIST RW ups0') socket.write('BEGIN LIST RW ups0\nRW ups0 ups.mode "normal"\nEND LIST RW ups0\n');
  });
  const result = await new NutClient({...options, timeout: 40}).snapshot();
  assert.equal(result.vars['battery.charge'], '100');
  assert.equal(result.writable['ups.mode'].value, 'normal');
});

test('total snapshot deadline bounds multiple metadata requests and preserves sample timestamp', async t => {
  const options=await mock(t,(socket,line)=>{
    if(line==='LIST VAR ups0')return socket.write('BEGIN LIST VAR ups0\nVAR ups0 battery.charge "100"\nEND LIST VAR ups0\n');
    if(line==='LIST RW ups0')return socket.write('BEGIN LIST RW ups0\nRW ups0 first "1"\nRW ups0 second "2"\nRW ups0 third "3"\nEND LIST RW ups0\n');
    const timer=setTimeout(()=>{if(!socket.destroyed)socket.write('ERR UNKNOWN-COMMAND\n');},40);
    socket.on('close',()=>clearTimeout(timer));
  });
  const start=Date.now(),s=await new NutClient({...options,totalTimeout:90}).snapshot();
  assert.equal(s.vars['battery.charge'],'100');
  assert.ok(s.sampledAt-start<60);assert.ok(Date.now()-start<250);
});
