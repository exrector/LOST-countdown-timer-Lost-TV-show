const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const root = path.join(__dirname, '../..');
const bridge = fs.readFileSync(path.join(root, 'cast-app/bridge.js'), 'utf8');

function sourceArray(name) {
  const match = new RegExp('var ' + name + ' = (\\[[\\s\\S]*?\\]);').exec(bridge);
  assert.ok(match, 'не найден массив ' + name);
  return vm.runInNewContext('(' + match[1] + ')');
}

test('одобренный старт сохраняет 72 строки и полный ритм 20,77 с', () => {
  const boot = sourceArray('BOOT');
  const dots = sourceArray('BOOT_DOTS');
  const cadence = sourceArray('CADENCE');
  assert.equal(sourceArray('JITTER').length, 8);
  assert.equal(sourceArray('GHOST').length, 6);
  assert.match(bridge, /var ROWS = 72;/);

  // Та же арифметика, что в bridge.js: первая строка через 700 мс,
  // затем неровные точки, пауза результата, гашение и четыре периода CADENCE.
  let milliseconds = 700;
  for (const [name, result] of boot) {
    if (!result) {
      milliseconds += name ? 850 : 350;
      continue;
    }
    const count = Math.max(3, 32 - name.length);
    for (let index = 0; index < count; index += 1) milliseconds += dots[index % dots.length];
    milliseconds += 600;
  }
  milliseconds += 500 + 410 + 180;
  for (let row = 0; row < 72; row += 1) milliseconds += cadence[row % cadence.length];
  assert.equal(milliseconds, 20770);
});

test('стартовый звук является неизменным одобренным файлом и идёт через native engine', () => {
  const audioPath = path.join(root, 'assets/sounds/harddrive.mp3');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
  assert.equal(digest, '9446690a6e40789fc87d3dabe6f29d9bf70be12bd6848e5ec16476b44486c17a');
  assert.match(bridge, /startupAudio\('stop'\); startupAudio\('play'\);/);
  assert.match(bridge, /key: 'harddrive'/);
  const nativeSource = fs.readFileSync(path.join(root, 'native/Sources/main.swift'), 'utf8');
  assert.match(nativeSource, /let keys = \[[^\n]*"harddrive"/);
});

test('Canvas не оставляет терминал без логотипа и скрывается в AI', () => {
  assert.match(bridge, /logo\.onerror = function \(\) \{ logoFailed = true; \}/);
  assert.match(bridge, /container\.classList\.remove\('lost-logo-sequence'\)/);
  const timerCss = fs.readFileSync(path.join(root, 'css/lost-timer.css'), 'utf8');
  const museCss = fs.readFileSync(path.join(root, 'muse/client.css'), 'utf8');
  assert.match(timerCss, /\.console-container\.lost-logo-sequence::after/);
  assert.match(museCss, /lost-muse-active \.lost-logo-reveal/);
});
