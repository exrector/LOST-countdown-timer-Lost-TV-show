(function () {
 'use strict';
 if (!document.body.classList.contains('console-page')) return;
 var API='http://127.0.0.1:8766', state=null, lastResponse=0, pending=false, tab='all', editing=false, returnFocus=null;
 function el(tag,cls,text) { var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e; }
 var line=el('div','ups-line stale');line.setAttribute('aria-label','Телеметрия энергоконтура');
 document.body.appendChild(line);document.body.classList.add('lost-ups-ready');
 var panel=el('section','ups-panel');panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Энергоконтур');panel.setAttribute('aria-modal','true');
 var title=el('div','ups-title');title.appendChild(el('span','','LOST:\\МЕНЮ\\ЭНЕРГОКОНТУР'));var close=button('ESC ×',hide);title.appendChild(close);panel.appendChild(title);
 var tabs=el('div','ups-tabs');panel.appendChild(tabs);
 [['all','ОБЗОР'],['battery','РЕЗЕРВ'],['line','ЛИНИЯ'],['device','УСТРОЙСТВО'],['driver','ДРАЙВЕР'],['raw','ВСЕ ДАННЫЕ']].forEach(function(t){var b=button(t[1],function(){tab=t[0];editing=false;renderPanel();});b.dataset.tab=t[0];tabs.appendChild(b);});
 var content=el('div','ups-content');panel.appendChild(content);
 var notice=el('div','ups-notice');notice.setAttribute('role','status');panel.appendChild(notice);
 panel.appendChild(el('div','ups-footer','TAB / SHIFT+TAB — ВЫБОР   ENTER — ОК   ESC — НАЗАД   U — ЭНЕРГОКОНТУР'));
 document.body.appendChild(panel);
 function button(text,fn){var b=el('button','',text);b.type='button';b.addEventListener('click',fn);return b;}
 function fresh(){return window.LostUPSTelemetry.fresh(state,lastResponse,Date.now());}
 function renderLine(){
  var view=window.LostUPSTelemetry.view(state,lastResponse,Date.now()),ok=view.fresh;
  line.className='ups-line '+view.kind;line.replaceChildren();
  view.cells.forEach(function(p,i){if(i)line.appendChild(el('i','','·'));var cell=el('span','',p[0]+': ');cell.appendChild(el('b','',p[1]));line.appendChild(cell);});
  var health=panel.querySelector('.ups-status');if(health)health.textContent=statusText();
  Array.from(panel.querySelectorAll('[data-write]')).forEach(function(b){b.disabled=pending||!ok||!state.canEdit;});
  line.title=ok?'Энергоконтур: данные '+new Date(state.updatedAt).toLocaleTimeString():'TELEMETRY LOST — актуальные показания недоступны';
 }
 function message(text,error){notice.textContent=text;notice.className='ups-notice'+(error?' ups-error':'');}
 async function request(route,body){
  var res=await fetch(API+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-LOST-UPS':'1'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(6000),cache:'no-store'});
  var data=await res.json();if(!res.ok)throw new Error(data.error||'Ошибка связи');return data;
 }
 async function poll(){try{state=await request('/state');lastResponse=Date.now();}catch(_){/* No old values are presented as current. */}renderLine();if(!panel.hidden&&!editing&&!pending)renderPanel();}
 function hide(){panel.hidden=true;editing=false;if(returnFocus&&returnFocus.focus)returnFocus.focus();}
 function open(){returnFocus=document.activeElement;panel.hidden=false;editing=false;message('');renderPanel();tabs.querySelector('button').focus();}
 window.LostUPS={openMenu:open};
 function statusText(){var v=state&&state.vars||{};return fresh()?'CPS / '+(v['ups.model']||v['device.model']||'UPS')+' · '+state.connection.host+':'+state.connection.port+' · '+new Date(state.updatedAt).toLocaleTimeString():'TELEMETRY LOST — нет актуальных данных. Последние значения ниже справочные.';}
 function renderPanel(){
  var old=content.scrollTop,focused=document.activeElement,focusKey=focused&&focused.dataset&&focused.dataset.edit;
  Array.from(tabs.children).forEach(function(b){b.setAttribute('aria-selected',String(b.dataset.tab===tab));});content.replaceChildren();
  var ok=fresh(),v=state&&state.vars||{};
  content.appendChild(el('p','ups-status',statusText()));
  if(!state){content.appendChild(el('p','','Ожидание службы энергоконтура…'));return;}
  var fields=state.fields||[];
  if(tab==='all'){
   var keys=['ups.status','battery.charge','battery.runtime','ups.load','input.voltage','output.voltage','battery.voltage','ups.beeper.status','ups.test.result'];fields=keys.map(function(k){return fields.find(function(f){return f.key===k;});}).filter(Boolean);
  } else if(tab!=='raw')fields=fields.filter(function(f){return f.group===tab;});
  var table=el('table','ups-table');var body=el('tbody');table.appendChild(body);
  fields.forEach(function(f){var row=el('tr'),name=el('td','',f.label);name.appendChild(el('small','ups-key',f.key));row.appendChild(name);row.appendChild(el('td','',String(f.value)+(f.unit?' '+f.unit:'')));var action=el('td');
   if(f.editable){var edit=button('ИЗМЕНИТЬ',function(){editor(f);});edit.dataset.edit=f.key;edit.dataset.write='1';edit.disabled=!ok||!state.canEdit||pending;action.appendChild(edit);}else action.appendChild(el('span','ups-muted','ЧТЕНИЕ'));
   row.appendChild(action);body.appendChild(row);
  });content.appendChild(table);
  if(tab==='all'){
   var beeper=button(v['ups.beeper.status']==='disabled'?'ВКЛЮЧИТЬ СИГНАЛ UPS':'ВЫКЛЮЧИТЬ СИГНАЛ UPS',function(){confirmBeeper(v['ups.beeper.status']==='disabled');});beeper.dataset.edit='__beeper';beeper.dataset.write='1';beeper.disabled=!ok||!state.canEdit||pending;content.appendChild(beeper);
   content.appendChild(el('p','ups-muted','ENDURANCE — оценка ИБП при текущей нагрузке. Номинальная мощность — характеристика устройства, а не текущее потребление.'));
   content.appendChild(el('p','ups-muted','Автовыключение Mac: '+(state.guard&&state.guard.installed&&state.policy.enabled?'ВКЛЮЧЕНО':'НЕ ВКЛЮЧЕНО')+'.'));
  }
  if(tab==='raw')content.appendChild(el('p','ups-muted','Всего показаний: '+fields.length+'. Доступные настройки меняются только через подтверждение; служебные параметры драйвера показаны для чтения.'));
  content.scrollTop=old;if(focusKey){var target=Array.from(content.querySelectorAll('button')).find(function(b){return b.dataset.edit===focusKey;});if(target)target.focus({preventScroll:true});}
 }
 function editor(f){
  editing=true;var box=el('form','ups-editor');box.appendChild(el('p','',f.label+' — сейчас '+f.value+(f.unit?' '+f.unit:'')));box.appendChild(el('p','ups-muted',f.key));
  var input;if(f.limits.enum){input=el('select');f.limits.enum.filter(function(x){return !f.metadata.enum.length||f.metadata.enum.indexOf(x)>=0;}).forEach(function(x){var o=el('option','',x);o.value=x;input.appendChild(o);});}else{input=el('input');input.type='number';input.min=f.limits.min;input.max=f.limits.max;input.step=1;box.appendChild(el('p','ups-muted','Диапазон: '+input.min+'–'+input.max+(f.unit?' '+f.unit:'')));}
  input.value=f.value;input.required=true;input.setAttribute('aria-label',f.label);box.appendChild(input);
  var apply=button('ПРИМЕНИТЬ',function(){box.requestSubmit();});apply.dataset.write='1';box.appendChild(apply);box.appendChild(button('ОТМЕНА',function(){editing=false;renderPanel();}));
  box.addEventListener('submit',function(e){e.preventDefault();if(!box.reportValidity())return;mutate('/variable',{name:f.key,value:input.value,expected:f.value});});content.prepend(box);content.scrollTop=0;input.focus();
 }
 function confirmBeeper(enabled){editing=true;var box=el('div','ups-editor');box.appendChild(el('p','',enabled?'Включить звуковой сигнал ИБП?':'Выключить звуковой сигнал ИБП, включая предупреждения об отключении сети?'));box.appendChild(button('ПОДТВЕРДИТЬ',function(){mutate('/beeper',{enabled:enabled});}));box.appendChild(button('ОТМЕНА',function(){editing=false;renderPanel();}));box.querySelector('button').dataset.write='1';content.prepend(box);content.scrollTop=0;box.querySelector('button').focus();}
 async function mutate(route,body){if(pending)return;if(!fresh()){message('Нет актуальной связи с ИБП. Изменение не отправлено.',true);return;}pending=true;message('Передача параметра…');Array.from(content.querySelectorAll('button')).forEach(function(b){b.disabled=true;});try{state=await request(route,body);lastResponse=Date.now();editing=false;message('Параметр передан. Показания обновлены.');}catch(e){message(e.message,true);editing=false;}finally{pending=false;renderLine();renderPanel();tabs.querySelector('[aria-selected=true]').focus();}}
 ['keydown','keyup'].forEach(function(type){window.addEventListener(type,function(e){
  if(panel.hidden){if(type==='keydown'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.code==='KeyU'){e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)open();}return;}
  e.stopImmediatePropagation();
  if(type==='keydown'&&e.key==='Escape'){e.preventDefault();if(editing&&!pending){editing=false;renderPanel();tabs.querySelector('[aria-selected=true]').focus();}else if(!pending)hide();}
  if(type==='keydown'&&e.key==='Tab'){var all=Array.from(panel.querySelectorAll('button,input,select')).filter(function(n){return !n.disabled&&n.getClientRects().length;});var i=all.indexOf(document.activeElement);if(i<0||(e.shiftKey&&i<=0)||(!e.shiftKey&&i===all.length-1)){e.preventDefault();all[e.shiftKey?all.length-1:0].focus();}}
 },true);});
 renderLine();poll();setInterval(poll,5000);setInterval(renderLine,1000);
})();
