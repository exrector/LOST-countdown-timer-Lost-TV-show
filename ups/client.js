(function () {
 'use strict';
 // Энергоконтур: строка показаний внизу терминала и ветка «ЭНЕРГОКОНТУР» общего меню станции.
 // Управление — как во всём меню: ↑↓ выбор, → открыть/изменить, Enter подтвердить, ← назад.
 if (!document.body.classList.contains('console-page')) return;
 var enabled=true,pollTimer=null,lineTimer=null,polling=false,epoch=0,activeReads=[];
 var API='/__ups', state=null, lastResponse=0, pending=false, lastError='';
 function el(tag,cls,text) { var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e; }
 var line=el('div','ups-line stale');line.setAttribute('aria-label','Телеметрия энергоконтура');
 var services=document.querySelector('.service-line');if(!services){services=el('div','service-line');document.body.appendChild(services);}
 services.appendChild(line);
 document.body.classList.add('lost-ups-ready');

 function fresh(){return enabled&&window.LostUPSTelemetry.fresh(state,lastResponse,Date.now());}
 function changed(){window.dispatchEvent(new CustomEvent('lost-ups-update'));}
 function renderLine(){
  if(!enabled)return;
  var view=window.LostUPSTelemetry.view(state,lastResponse,Date.now()),ok=view.fresh;
  line.className='ups-line '+view.kind;line.replaceChildren();
  view.cells.forEach(function(p,i){if(i)line.appendChild(el('i','','·'));var cell=el('span','',p[0]+': ');cell.appendChild(el('b','',p[1]));line.appendChild(cell);});
  line.title=ok?'Энергоконтур: данные '+new Date(state.updatedAt).toLocaleTimeString():'TELEMETRY LOST — '+(lastError||'актуальные показания недоступны');
 }
 async function request(route,body){
  if(!enabled)throw new Error('Модуль UPS выключен');
  // AbortSignal.timeout is absent in the WebKit shipped on our Monterey Mac.
  var controller=new AbortController();if(!body)activeReads.push(controller);var timer=setTimeout(function(){controller.abort();},6000);
  try{
   var res=await fetch(API+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-LOST-UPS':'1'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});
   var data=await res.json();if(!res.ok)throw new Error(data.error||'Ошибка связи');return data;
  }finally{clearTimeout(timer);var index=activeReads.indexOf(controller);if(index>=0)activeReads.splice(index,1);}
 }
 async function poll(){
  if(!enabled||polling)return;polling=true;var generation=epoch;
  try{var next=await request('/state');if(!enabled||generation!==epoch)return;state=next;lastResponse=Date.now();lastError='';}
  catch(e){if(!enabled||generation!==epoch)return;lastError=e.name==='AbortError'?'Истекло время ожидания службы ИБП':e.message;}
  finally{polling=false;}
  if(!enabled||generation!==epoch)return;renderLine();changed();
 }
 function setEnabled(on){
  if(enabled===on&&pollTimer!==null)return;
  enabled=on;epoch++;clearInterval(pollTimer);clearInterval(lineTimer);pollTimer=null;lineTimer=null;
  activeReads.slice().forEach(function(controller){controller.abort();});
  state=null;lastResponse=0;lastError='';line.hidden=!on;
  if(!on){changed();return;}
  renderLine();poll();pollTimer=setInterval(poll,5000);lineTimer=setInterval(renderLine,1000);
 }
 window.addEventListener('lost-modules',function(e){setEnabled(!(e.detail&&e.detail.ups&&e.detail.ups.enabled===false));});

 // Передача в ИБП. Возвращает экран результата для меню; его текст меняется, когда ИБП ответит.
 function send(route,body,result){
  if(pending){result.text='ДРУГАЯ ПЕРЕДАЧА ЕЩЁ ИДЁТ. ЗНАЧЕНИЕ НЕ ОТПРАВЛЕНО.';return result;}
  if(!fresh()||!state.canEdit){result.text='НЕТ АКТУАЛЬНОЙ СВЯЗИ С ИБП ИЛИ ПРАВКА ЗАПРЕЩЕНА. ЗНАЧЕНИЕ НЕ ОТПРАВЛЕНО.';return result;}
  pending=true;result.text='ПЕРЕДАЧА ПАРАМЕТРА…';
  request(route,body).then(function(next){state=next;lastResponse=Date.now();result.text='ПАРАМЕТР ПЕРЕДАН. ПОКАЗАНИЯ ОБНОВЛЕНЫ.';})
   .catch(function(e){result.text='ОШИБКА: '+e.message+'\nЗНАЧЕНИЕ НЕ ИЗМЕНЕНО.';})
   .then(function(){pending=false;renderLine();changed();});
  return result;
 }
 function field(key){return state&&state.fields?state.fields.filter(function(f){return f.key===key;})[0]:null;}
 function shown(f){return f?String(f.value)+(f.unit?' '+f.unit:''):'—';}
 function statusText(){var v=state&&state.vars||{};return fresh()?'CPS / '+(v['ups.model']||v['device.model']||'UPS')+' · '+state.connection.host+':'+state.connection.port+' · '+new Date(state.updatedAt).toLocaleTimeString():'TELEMETRY LOST — '+(lastError||'нет актуальных данных; значения ниже справочные.');}
 var OVERVIEW=['ups.status','battery.charge','battery.runtime','ups.load','input.voltage','output.voltage','battery.voltage','ups.beeper.status','ups.test.result'];
 // Показание — строка «НАЗВАНИЕ: значение». Число правится полем (→, Enter передаёт), вариант — списком (Enter подтверждает).
 function rows(keys){
  return keys.map(function(key){
   var f=field(key); if(!f)return null;
   var label=function(){var now=field(key);return (now?now.label:key).toUpperCase()+': '+shown(now);};
   if(!f.editable)return {label:label};
   if(f.limits&&f.limits.enum){
    var options=f.limits.enum.filter(function(x){return !f.metadata||!f.metadata.enum||!f.metadata.enum.length||f.metadata.enum.indexOf(x)>=0;});
    return {label:label,pathLabel:f.label.toUpperCase(),description:f.label+' ('+key+'). Выбранный вариант Enter передаёт в ИБП.',dir:options.map(function(x){
     return {label:x.toUpperCase(),confirm:true,current:function(){var now=field(key);return !!now&&String(now.value)===x;},
      run:function(){var now=field(key);return send('/variable',{name:key,value:x,expected:now?now.value:f.value},{label:f.label.toUpperCase(),view:true,text:''});}};
    })};
   }
   return {label:label,pathLabel:f.label.toUpperCase(),editor:true,confirmLabel:'ПЕРЕДАТЬ В ИБП',draft:String(f.value),
    description:f.label+' ('+key+'): сейчас '+shown(f)+'. Диапазон '+f.limits.min+'–'+f.limits.max+(f.unit?' '+f.unit:'')+'.',
    prepare:function(value){
     var raw=String(value).trim(),n=Number(raw),result={label:f.label.toUpperCase(),view:true,text:''};
     if(!/^\d+$/.test(raw)||n<f.limits.min||n>f.limits.max){result.text='НЕДОПУСТИМОЕ ЗНАЧЕНИЕ «'+raw+'». ДИАПАЗОН '+f.limits.min+'–'+f.limits.max+'. ЗНАЧЕНИЕ НЕ ОТПРАВЛЕНО.';return result;}
     var now=field(key);return send('/variable',{name:key,value:String(n),expected:now?now.value:f.value},result);
    }};
  }).filter(Boolean);
 }
 function section(label,keys){return {label:label,dir:[],onEnter:function(){this.dir=rows(typeof keys==='function'?keys():keys);if(!this.dir.length)this.dir=[{label:'НЕТ ПОКАЗАНИЙ',view:true,staticText:statusText()}];}};}
 function group(name){return function(){return (state&&state.fields||[]).filter(function(f){return f.group===name;}).map(function(f){return f.key;});};}
 function menu(){
  var v=state&&state.vars||{};
  return {description:statusText(),dir:[
   section('ОБЗОР',OVERVIEW),section('РЕЗЕРВ',group('battery')),section('ЛИНИЯ',group('line')),section('УСТРОЙСТВО',group('device')),
   section('ВСЕ ДАННЫЕ',function(){return (state&&state.fields||[]).map(function(f){return f.key;});}),
   {label:function(){var now=state&&state.vars||{};return 'ЗВУКОВОЙ СИГНАЛ ИБП: '+(now['ups.beeper.status']==='disabled'?'ВЫКЛ':'ВКЛ');},confirm:true,
    run:function(){var now=state&&state.vars||{},on=now['ups.beeper.status']==='disabled';return send('/beeper',{enabled:on},{label:'ЗВУКОВОЙ СИГНАЛ ИБП',view:true,text:''});}},
   {label:'СПРАВКА',view:true,staticText:'ENDURANCE — оценка ИБП при текущей нагрузке. Номинальная мощность — характеристика устройства, а не текущее потребление.\n\nАвтовыключение Mac: '+(state&&state.guard&&state.guard.installed&&state.policy&&state.policy.enabled?'ВКЛЮЧЕНО':'НЕ ВКЛЮЧЕНО')+'.\nЗвуковой сигнал ИБП сейчас: '+(v['ups.beeper.status']||'—')+'.'}
  ]};
 }
 window.LostUPS={menu:menu,status:function(){return {enabled:enabled,busy:pending,polling:pollTimer!==null,fresh:fresh(),online:!!(state&&state.online),fields:state&&state.fields?state.fields.length:0,error:lastError};}};
 setEnabled(!(window.__LOST_MODULES&&window.__LOST_MODULES.ups&&window.__LOST_MODULES.ups.enabled===false));
})();
