(function () {
 'use strict';
 if (!document.body.classList.contains('console-page')) return;

 // Режим таймера — последняя ячейка строки служб: L (Live) или D (Dev).
 var services = document.querySelector('.service-line');
 if (!services) {
  services = document.createElement('div');
  services.className = 'service-line';
  document.body.appendChild(services);
 }
 var cell = document.createElement('div');
 cell.className = 'station-mode-line';
 services.appendChild(cell);

 function paint(clock) {
  var mode = clock && clock.mode;
  cell.textContent = mode === 'live' ? 'L' : mode === 'dev' ? 'D' : '-';
  cell.title = mode === 'live' ? 'Режим Live' : mode === 'dev' ? 'Режим Dev' : 'Режим не известен';
 }

 window.addEventListener('lost-clock', function (event) { paint(event.detail); });
 paint(window.__LOST_CLOCK || null);
})();
