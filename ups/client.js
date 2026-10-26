(function () {
 'use strict';
 if (!document.body.classList.contains('console-page')) return;
 var enabled=true,pollTimer=null,lineTimer=null,polling=false,epoch=0,activeReads=[];
 var API='/__ups', state=null, lastResponse=0, pending=false, tab='all', editing=false, returnFocus=null, returnRow=null, lastError='';
 function el(tag,cls,text) { var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e; }
 var line=el('div','ups-line stale');line.setAttribute('aria-label','Телеметрия энергоконтура');
 var services=document.querySelector('.service-line');if(!services){services=el('div','service-line');document.body.appendChild(services);}
 services.appendChild(line);
 var vpn=el('div','vpn-line','VPN: ');vpn.setAttribute('aria-label','VPN роутера');vpn.appendChild(el('b','','НЕТ ДАННЫХ'));vpn.title='AdGuard VPN на роутере: источник телеметрии ещё не подключён';services.appendChild(vpn);
 document.body.classList.add('lost-ups-ready');
 var panel=el('section','ups-panel');panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Энергоконтур');panel.setAttribute('aria-modal','true');
 var title=el('div','ups-title');title.appendChild(el('span','','LOST:\\МЕНЮ\\ЭНЕРГОКОНТУР'));var close=button('ESC НАЗАД',leave);title.appendChild(close);panel.appendChild(title);
 var tabs=el('div','ups-tabs');panel.appendChild(tabs);
 [['all','ОБЗОР'],['battery','РЕЗЕРВ'],['line','ЛИНИЯ'],['device','УСТРОЙСТВО'],['raw','ВСЕ ДАННЫЕ']].forEach(function(t){var b=button(t[1],function(){if(pending)return;tab=t[0];editing=false;renderPanel();});b.dataset.tab=t[0];tabs.appendChild(b);});
 var content=el('div','ups-content');panel.appendChild(content);
 var notice=el('div','ups-notice');notice.setAttribute('role','status');panel.appendChild(notice);
 panel.appendChild(el('div','ups-footer','← → — РАЗДЕЛЫ   ↑ ↓ — ПОКАЗАНИЯ   ENTER — ИЗМЕНИТЬ   ESC — НАЗАД'));
 (document.querySelector('.console-container') || document.body).appendChild(panel);
 function button(text,fn){var b=el('button','',text);b.type='button';b.addEventListener('click',fn);return b;}
 function fresh(){return enabled&& window.LostUPSTelemetry.fresh(state,lastResponse,Date.now());}
 function renderLine(){
  if(!enabled)return;
  var view=window.LostUPSTelemetry.view(state,lastResponse,Date.now()),ok=view.fresh;
  line.className='ups-line '+view.kind;line.replaceChildren();
  view.cells.forEach(function(p,i){if(i)line.appendChild(el('i','','·'));var cell=el('span','',p[0]+': ');cell.appendChild(el('b','',p[1]));line.appendChild(cell);});
  var health=panel.querySelector('.ups-status');if(health)health.textContent=statusText();
  Array.from(panel.querySelectorAll('[data-write]')).forEach(function(b){b.disabled=pending||!ok||!state.canEdit;});
  line.title=ok?'Энергоконтур: данные '+new Date(state.updatedAt).toLocaleTimeString():'TELEMETRY LOST — '+(lastError||'актуальные показания недоступны');
 }
 function message(text,error){notice.textContent=text;notice.className='ups-notice'+(error?' ups-error':'');}
 async function request(route,body){
  if(!enabled)throw new Error('Модуль UPS выключен');
  // AbortSignal.timeout is absent in the WebKit shipped on our Monterey Mac.
  var controller=new AbortController();if(!body)activeReads.push(controller);var timer=setTimeout(function(){controller.abort();},6000);
  try{
   var res=await fetch(API+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-LOST-UPS':'1'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});
   var data=await res.json();if(!res.ok)throw new Error(data.error||'Ошибка связи');return data;
  }finally{clearTimeout(timer);var index=activeReads.indexOf(controller);if(index>=0)activeReads.splice(index,1);}
 }
 function submitEditor(form){
  if(typeof form.requestSubmit==='function')form.requestSubmit();
  else if(form.reportValidity())form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 }
 async function poll(){
  if(!enabled||polling)return;polling=true;var generation=epoch;
  try{var next=await request('/state');if(!enabled||generation!==epoch)return;state=next;lastResponse=Date.now();lastError='';}
  catch(e){if(!enabled||generation!==epoch)return;lastError=e.name==='AbortError'?'Истекло время ожидания службы ИБП':e.message;}
  finally{polling=false;}
  if(!enabled||generation!==epoch)return;renderLine();if(!panel.hidden&&!editing&&!pending)renderPanel();
 }
 function setEnabled(on){
  if(enabled===on&&pollTimer!==null)return;
  enabled=on;epoch++;clearInterval(pollTimer);clearInterval(lineTimer);pollTimer=null;lineTimer=null;
  activeReads.slice().forEach(function(controller){controller.abort();});
  state=null;lastResponse=0;lastError='';line.hidden=!on;document.body.classList.add('lost-ups-ready');
  if(!on){var wasOpen=!panel.hidden;panel.hidden=true;document.body.classList.remove('station-panel-open');editing=false;if(wasOpen)window.dispatchEvent(new Event('lost-ups-close'));return;}
  renderLine();poll();pollTimer=setInterval(poll,5000);lineTimer=setInterval(renderLine,1000);
 }
 window.addEventListener('lost-modules',function(e){setEnabled(!(e.detail&&e.detail.ups&&e.detail.ups.enabled===false));});

 function leave(){if(pending)return;if(editing){editing=false;renderPanel();focusReturn();}else hide();}
 function hide(){if(pending)return;panel.hidden=true;document.body.classList.remove('station-panel-open');editing=false;if(returnFocus&&returnFocus.focus)returnFocus.focus();window.dispatchEvent(new Event('lost-ups-close'));}
 function open(){if(!enabled||!panel.hidden)return;returnFocus=document.activeElement;window.dispatchEvent(new Event('lost-ups-open'));panel.hidden=false;document.body.classList.add('station-panel-open');editing=false;message('');renderPanel();tabs.querySelector('[aria-selected=true]').focus();}
 window.LostUPS={openMenu:open,status:function(){return {enabled:enabled,busy:pending,polling:pollTimer!==null,fresh:fresh(),online:!!(state&&state.online),fields:state&&state.fields?state.fields.length:0,error:lastError};}};
 function statusText(){var v=state&&state.vars||{};return fresh()?'CPS / '+(v['ups.model']||v['device.model']||'UPS')+' · '+state.connection.host+':'+state.connection.port+' · '+new Date(state.updatedAt).toLocaleTimeString():'TELEMETRY LOST — '+(lastError||'нет актуальных данных. Последние значения ниже справочные.');}
 function renderPanel(){
  if(!enabled)return;
  var old=content.scrollTop,focused=document.activeElement,focusKind=focused&&focused.dataset&&(focused.dataset.edit?'edit':'row'),focusKey=focused&&focused.dataset&&focused.dataset[focusKind];
  Array.from(tabs.children).forEach(function(b){b.setAttribute('aria-selected',String(b.dataset.tab===tab));});content.replaceChildren();
  var ok=fresh(),v=state&&state.vars||{};
  content.appendChild(el('p','ups-status',statusText()));
  if(!state){content.appendChild(el('p','','Ожидание службы энергоконтура…'));return;}
  var fields=state.fields||[];
  if(tab==='all'){
   var keys=['ups.status','battery.charge','battery.runtime','ups.load','input.voltage','output.voltage','battery.voltage','ups.beeper.status','ups.test.result'];fields=keys.map(function(k){return fields.find(function(f){return f.key===k;});}).filter(Boolean);
  } else if(tab!=='raw')fields=fields.filter(function(f){return f.group===tab;});
  var table=el('table','ups-table');var body=el('tbody');table.appendChild(body);
  fields.forEach(function(f){var row=el('tr');row.tabIndex=0;row.dataset.row=f.key;var name=el('td','',f.label);name.appendChild(el('small','ups-key',f.key));row.appendChild(name);row.appendChild(el('td','',String(f.value)+(f.unit?' '+f.unit:'')));var action=el('td');
   if(f.editable){var edit=button('ИЗМЕНИТЬ',function(){editor(f);});edit.dataset.edit=f.key;edit.dataset.write='1';edit.disabled=!ok||!state.canEdit||pending;action.appendChild(edit);}else action.appendChild(el('span','ups-muted','ЧТЕНИЕ'));
   row.appendChild(action);body.appendChild(row);
  });content.appendChild(table);
  if(tab==='all'){
   var beeper=button(v['ups.beeper.status']==='disabled'?'ВКЛЮЧИТЬ СИГНАЛ UPS':'ВЫКЛЮЧИТЬ СИГНАЛ UPS',function(){confirmBeeper(v['ups.beeper.status']==='disabled');});beeper.dataset.edit='__beeper';beeper.dataset.write='1';beeper.disabled=!ok||!state.canEdit||pending;content.appendChild(beeper);
   content.appendChild(el('p','ups-muted','ENDURANCE — оценка ИБП при текущей нагрузке. Номинальная мощность — характеристика устройства, а не текущее потребление.'));
   content.appendChild(el('p','ups-muted','Автовыключение Mac: '+(state.guard&&state.guard.installed&&state.policy.enabled?'ВКЛЮЧЕНО':'НЕ ВКЛЮЧЕНО')+'.'));
  }
  if(tab==='raw')content.appendChild(el('p','ups-muted','Всего показаний: '+fields.length+'. Доступные настройки меняются только через подтверждение; служебные параметры драйвера показаны для чтения.'));
  content.scrollTop=old;if(focusKey){var target=Array.from(content.querySelectorAll('[data-'+focusKind+']')).find(function(b){return b.dataset[focusKind]===focusKey;});if(target)target.focus({preventScroll:true});}
 }
 function focusReturn(){if(panel.hidden)return;var target=Array.from(content.querySelectorAll("[data-row],[data-edit]")).find(function(n){return n.dataset.row===returnRow||n.dataset.edit===returnRow;});(target||tabs.querySelector("[aria-selected=true]")).focus();}
 function editor(f){
  editing=true;returnRow=f.key;var box=el('form','ups-editor');box.appendChild(el('p','ups-muted','СТРЕЛКИ — ЗНАЧЕНИЕ / ЦИФРЫ — ВВОД / ENTER — СОХРАНИТЬ / ESC — ОТМЕНА'));box.appendChild(el('p','',f.label+' — сейчас '+f.value+(f.unit?' '+f.unit:'')));box.appendChild(el('p','ups-muted',f.key));
  var input;if(f.limits.enum){input=el('select');f.limits.enum.filter(function(x){return !f.metadata.enum.length||f.metadata.enum.indexOf(x)>=0;}).forEach(function(x){var o=el('option','',x);o.value=x;input.appendChild(o);});}else{input=el('input');input.type='number';input.min=f.limits.min;input.max=f.limits.max;input.step=1;box.appendChild(el('p','ups-muted','Диапазон: '+input.min+'–'+input.max+(f.unit?' '+f.unit:'')));}
  input.value=f.value;input.required=true;input.setAttribute('aria-label',f.label);box.appendChild(input);
  var apply=button('ПРИМЕНИТЬ',function(){submitEditor(box);});apply.dataset.write='1';box.appendChild(apply);box.appendChild(button('ОТМЕНА',function(){editing=false;renderPanel();focusReturn();}));
  box.addEventListener('submit',function(e){e.preventDefault();if(!box.reportValidity())return;mutate('/variable',{name:f.key,value:input.value,expected:f.value});});content.prepend(box);content.scrollTop=0;input.focus();if(input.select)input.select();
 }
 function confirmBeeper(enabled){editing=true;returnRow='__beeper';var box=el('div','ups-editor');box.appendChild(el('p','',enabled?'Включить звуковой сигнал ИБП?':'Выключить звуковой сигнал ИБП, включая предупреждения об отключении сети?'));box.appendChild(button('ПОДТВЕРДИТЬ',function(){mutate('/beeper',{enabled:enabled});}));box.appendChild(button('ОТМЕНА',function(){editing=false;renderPanel();focusReturn();}));box.querySelector('button').dataset.write='1';content.prepend(box);content.scrollTop=0;box.querySelector('button').focus();}
 async function mutate(route,body){if(pending)return;if(!fresh()){message('Нет актуальной связи с ИБП. Изменение не отправлено.',true);return;}pending=true;close.disabled=true;Array.from(tabs.children).forEach(function(b){b.disabled=true;});message('Передача параметра…');Array.from(content.querySelectorAll('button,input,select')).forEach(function(b){b.disabled=true;});try{state=await request(route,body);lastResponse=Date.now();editing=false;message('Параметр передан. Показания обновлены.');}catch(e){message(e.message,true);editing=false;}finally{pending=false;close.disabled=false;Array.from(tabs.children).forEach(function(b){b.disabled=false;});renderLine();renderPanel();focusReturn();}}
 var lastMenuKey='',lastMenuAt=0;
 ['keydown','keyup'].forEach(function(type){window.addEventListener(type,function(e){
  if(!enabled||window.LostBootActive)return;
  if(panel.hidden)return;
  e.stopImmediatePropagation();
  if(type==='keydown'&&(e.key==='Enter'||e.key==='Escape')){e.preventDefault();var now=Date.now();if(e.repeat||(lastMenuKey===e.key&&now-lastMenuAt<250))return;lastMenuKey=e.key;lastMenuAt=now;}
  if(type==='keydown'&&editing&&!pending){
   var control=document.activeElement,box=control&&control.closest&&control.closest('.ups-editor');
   if(box&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].indexOf(e.key)>=0){
    e.preventDefault();var delta=e.key==='ArrowUp'||e.key==='ArrowRight'?1:-1;
    if(control.tagName==='INPUT'&&control.type==='number'){
     var value=Number(control.value),min=Number(control.min),max=Number(control.max),step=Number(control.step)||1;
     if(!Number.isFinite(value))value=min;
     control.value=String(Math.max(min,Math.min(max,value+delta*step)));control.select();
    }else if(control.tagName==='SELECT'){
     control.selectedIndex=(control.selectedIndex+delta+control.options.length)%control.options.length;
    }else{
     var controls=Array.from(box.querySelectorAll('input,select,button')).filter(function(n){return !n.disabled;});
     var ci=controls.indexOf(control);controls[(ci+delta+controls.length)%controls.length].focus();
    }return;
   }
   if(box&&e.key==='Enter'&&(control.tagName==='INPUT'||control.tagName==='SELECT')){e.preventDefault();submitEditor(box);return;}
  }
  if(type==='keydown'&&!editing&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter'].indexOf(e.key)>=0){
   var active=document.activeElement,row=active&&active.closest&&active.closest('tr[data-row],button[data-edit="__beeper"]');
   if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
    e.preventDefault();var buttons=Array.from(tabs.children),selected=buttons.findIndex(function(b){return b.dataset.tab===tab;});
    var next=buttons[(selected+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length];next.click();next.focus();return;
   }
   if(e.key==='ArrowUp'||e.key==='ArrowDown'){
    e.preventDefault();var rows=Array.from(content.querySelectorAll('tr[data-row],button[data-edit="__beeper"]')),index=rows.indexOf(row);
    var nextIndex=index<0?(e.key==='ArrowDown'?0:rows.length-1):index+(e.key==='ArrowDown'?1:-1);
    if(nextIndex<0){tabs.querySelector('[aria-selected=true]').focus();return;}
    if(rows.length){var target=rows[Math.min(nextIndex,rows.length-1)];target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});}return;
   }
   if(e.key==='Enter'&&row){e.preventDefault();var edit=row.tagName==='BUTTON'?row:row.querySelector('button:not(:disabled)');if(edit)edit.click();return;}
  }
  if(type==='keydown'&&!pending&&e.key==='Enter'&&document.activeElement.tagName==='BUTTON'&&!document.activeElement.disabled&&panel.contains(document.activeElement)){document.activeElement.click();return;}
  if(type==='keydown'&&e.key==='Escape'){e.preventDefault();leave();}
  if(type==='keydown'&&e.key==='Tab'){var all=Array.from(panel.querySelectorAll('button,input,select')).filter(function(n){return !n.disabled&&n.getClientRects().length;});if(!all.length){e.preventDefault();return;}var i=all.indexOf(document.activeElement);if(i<0||(e.shiftKey&&i<=0)||(!e.shiftKey&&i===all.length-1)){e.preventDefault();all[e.shiftKey?all.length-1:0].focus();}}
 },true);});
 setEnabled(!(window.__LOST_MODULES&&window.__LOST_MODULES.ups&&window.__LOST_MODULES.ups.enabled===false));
})();
