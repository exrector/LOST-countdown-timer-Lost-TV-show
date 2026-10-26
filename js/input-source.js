(function () {
 'use strict';
 if (!document.body.classList.contains('console-page')) return;

 function element(tag, cls) {
  var node = document.createElement(tag);
  node.className = cls;
  return node;
 }

 var services = document.querySelector('.service-line');
 if (!services) {
  services = element('div', 'service-line');
  document.body.appendChild(services);
 }
 var line = element('div', 'input-source-line unavailable');
 line.setAttribute('aria-label', 'Текущая раскладка клавиатуры');
 services.appendChild(line);

 function paint(source) {
  var label = source && source.label ? String(source.label).toUpperCase() : '--';
  line.className = 'input-source-line' + (label === '--' ? ' unavailable' : '');
  line.textContent = 'LANG: ';
  var value = document.createElement('b');
  value.textContent = label;
  line.appendChild(value);
  line.title = source && source.id ? 'Раскладка macOS: ' + source.id : 'Раскладка macOS пока не определена';
 }

 window.addEventListener('lost-input-source', function (event) { paint(event.detail); });
 paint(window.__LOST_INPUT_SOURCE || null);
})();
