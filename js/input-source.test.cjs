const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Element {
 constructor(tag) { this.tagName = tag; this.className = ''; this.children = []; this.attributes = {}; this._text = ''; this.title = ''; }
 set textContent(value) { this._text = String(value); this.children = []; }
 get textContent() { return this._text + this.children.map(function (child) { return child.textContent; }).join(''); }
 appendChild(child) { this.children.push(child); return child; }
 setAttribute(name, value) { this.attributes[name] = value; }
}

function load(initial) {
 const listeners = {};
 const services = new Element('div');
 services.className = 'service-line';
 const body = new Element('body');
 body.classList = { contains: function (name) { return name === 'console-page'; } };
 const document = {
  body: body,
  createElement: function (tag) { return new Element(tag); },
  querySelector: function (selector) { return selector === '.service-line' ? services : null; }
 };
 const window = {
  __LOST_INPUT_SOURCE: initial,
  addEventListener: function (name, callback) { listeners[name] = callback; }
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'input-source.js'), 'utf8'), { window: window, document: document });
 return { line: services.children[0], listeners: listeners };
}

test('layout indicator reflects the native macOS source and stays display-only', function () {
 const app = load({ id: 'com.apple.keylayout.ABC', label: 'EN' });
 assert.equal(app.line.textContent, 'LANG: EN');
 assert.equal(app.line.title, 'Раскладка macOS: com.apple.keylayout.ABC');

 app.listeners['lost-input-source']({ detail: { id: 'com.apple.keylayout.Russian', label: 'RU' } });
 assert.equal(app.line.textContent, 'LANG: RU');
 assert.equal(app.line.className, 'input-source-line');
});

test('layout indicator reports an unavailable source honestly', function () {
 const app = load(null);
 assert.equal(app.line.textContent, 'LANG: --');
 assert.match(app.line.className, /unavailable/);
});
