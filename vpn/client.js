(function(){
 'use strict';
 if(!document.body.classList.contains('console-page'))return;
 var state={status:'unavailable',installed:false,enabled:true}, polling=false, timer=null;
 var services=document.querySelector('.service-line');if(!services){services=document.createElement('div');services.className='service-line';document.body.appendChild(services);}
 var line=document.createElement('div');line.className='vpn-line';line.setAttribute('aria-label','AdGuard VPN роутера');services.appendChild(line);
 function paint(){
  var known=state.updatedAt && Date.now()-state.updatedAt<90000;
  var status=known?state.status:'unavailable';
  line.className='vpn-line '+status;line.hidden=state.enabled===false;
  // нижняя строка — по-английски, как показания UPS и консоли мейнфреймов: VPN: CONNECTED: NEW YORK
  line.textContent='VPN: ';var b=document.createElement('b');b.textContent=status==='connected'?'CONNECTED: '+String(state.location||'UNKNOWN').toUpperCase():status==='disconnected'?'DISCONNECTED':status==='connecting'?'CONNECTING':'NO DATA';line.appendChild(b);
  line.title=state.error||'AdGuard VPN на роутере';
 }
 async function poll(){if(polling||state.enabled===false)return;polling=true;var c=new AbortController(),timeout=setTimeout(function(){c.abort();},5000);
  try{var res=await fetch('/__vpn/state',{cache:'no-store',signal:c.signal});if(!res.ok)throw Error();state=await res.json();}
  catch(_){state=Object.assign({},state,{status:'unavailable',location:'',updatedAt:0,error:'Статус роутера недоступен'});}
  finally{clearTimeout(timeout);polling=false;paint();}
 }
 async function execute(command){var c=new AbortController(),timeout=setTimeout(function(){c.abort();},65000);
  try{var res=await fetch('/__vpn/command',{method:'POST',headers:{'Content-Type':'application/json','X-LOST-VPN':'1'},body:JSON.stringify(command),signal:c.signal});var data=await res.json();if(data.state){state=data.state;paint();}if(!res.ok||!data.ok)throw Error(data.error||'router_unavailable');return data.output||'Команда выполнена';}
  catch(e){var errors={busy:'Другая команда ещё выполняется',disabled:'Модуль VPN выключен',not_installed:'Доступ к роутеру не настроен',invalid_value:'Недопустимое значение',invalid_action:'Команда не поддерживается',router_unavailable:'Роутер недоступен или не подтвердил выполнение'};return 'ОШИБКА: '+(errors[e.message]||'Не удалось подтвердить результат. Проверьте состояние перед повтором.');}
  finally{clearTimeout(timeout);poll();}
 }
 // Пункты — как во всём меню станции: короткие заглавные русские подписи, справа <DIR>/<ФАЙЛ>/<ВВОД>.
 // Команда CLI и её последствия видны в пояснении раздела до подтверждения.
 function menu(){
  var CHANGES='Изменит VPN на роутере для всех устройств за ним.';
  function read(label,action,value){return{label:label,view:true,command:{action:action,value:value}};}
  function info(label,text){return{label:label,view:true,staticText:text};}
  function confirm(label,cli,action,value,warning){return{label:label,description:'adguardvpn-cli '+cli+'\n'+(warning||CHANGES),dir:[{label:'ОТМЕНА',cancel:true},{label:'ВЫПОЛНИТЬ',command:{action:action,value:value}}]};}
  function entry(label,cli,build,warning,placeholder){return{label:label,editor:true,description:'adguardvpn-cli '+cli+'\n'+(warning||CHANGES),placeholder:placeholder||'',prepare:function(value){var cmd=build(value.trim());return confirm(label+': '+value.trim().toUpperCase(),cli.replace('…',value.trim()),cmd.action,cmd.value,warning);}};}
  var NAMES={on:'ВКЛ',off:'ВЫКЛ'};
  function choice(label,name,values,action,warning){return{label:label,description:'adguardvpn-cli config '+name+'\n'+(warning||CHANGES),dir:values.map(function(value){return confirm(NAMES[value]||value.toUpperCase(),'config '+name+' '+value,action||'setting',action?value:{name:name,value:value},warning);})};}
  var exclusions=[['general','ОБЩИЙ РЕЖИМ','Перечисленные сайты идут мимо VPN, остальное — через VPN.'],['selective','ВЫБОРОЧНЫЙ РЕЖИМ','Через VPN идут только перечисленные сайты.']].map(function(m){var mode=m[0];return{label:m[1],description:m[2],dir:[
   read('СПИСОК САЙТОВ','exclusions-show',mode),
   entry('ДОБАВИТЬ ДОМЕН','site-exclusions add … --for-mode '+mode,function(domain){return{action:'exclusions-add',value:{mode:mode,domain:domain}};},'Добавит домен и все его поддомены в список.','example.com'),
   entry('УДАЛИТЬ ДОМЕН','site-exclusions remove … --for-mode '+mode,function(domain){return{action:'exclusions-remove',value:{mode:mode,domain:domain}};},'Удалит домен и все его поддомены из списка.','example.com'),
   confirm('ВКЛЮЧИТЬ ЭТОТ РЕЖИМ','site-exclusions mode '+mode,'exclusions-mode',mode,m[2]),
   confirm('ОЧИСТИТЬ СПИСОК','site-exclusions clear --for-mode '+mode,'exclusions-clear',mode,'Все сайты этого списка будут удалены.')]};});
  var settings=[read('ТЕКУЩИЕ НАСТРОЙКИ','config'),
   choice('ПРОТОКОЛ','set-protocol',['auto','http2','quic'],'protocol'),
   choice('РЕЖИМ ТУННЕЛЯ','set-mode',['TUN','SOCKS']),
   entry('DNS-СЕРВЕР','config set-dns …',function(v){return{action:'setting',value:{name:'set-dns',value:v}};},'DNS внутри VPN. На Keenetic действует и роутерная обвязка.','1.1.1.1'),
   choice('СИСТЕМНЫЙ DNS','set-change-system-dns',['on','off'],undefined,'Разрешает VPN менять системный DNS роутера.'),
   choice('МАРШРУТЫ TUN','set-tun-routing-mode',['AUTO','SCRIPT','NONE']),
   entry('ПОРТ SOCKS','config set-socks-port …',function(v){return{action:'setting',value:{name:'set-socks-port',value:v}};},'Порт локального прокси: от 1 до 65535.','1080'),
   entry('АДРЕС SOCKS','config set-socks-host …',function(v){return{action:'setting',value:{name:'set-socks-host',value:v}};},'Адрес прослушивания прокси. Внешний адрес требует заранее настроенной авторизации.','127.0.0.1'),
   entry('ИСХОДЯЩИЙ ИНТЕРФЕЙС','config set-bound-if-override …',function(v){return{action:'setting',value:{name:'set-bound-if-override',value:v}};},'Пустое значение снимает привязку. Неверный интерфейс прервёт подключение.','')];
  [['ПОСТКВАНТОВАЯ ЗАЩИТА','set-post-quantum'],['ПОДРОБНЫЕ ЖУРНАЛЫ','set-debug-logging'],['ПОДСКАЗКИ CLI','set-show-hints'],['УВЕДОМЛЕНИЯ','set-show-notifications'],['ОТЧЁТЫ О СБОЯХ','set-crash-reporting'],['ТЕЛЕМЕТРИЯ ADGUARD','set-telemetry']].forEach(function(p){settings.push(choice(p[0],p[1],['on','off']));});
  settings.push(choice('КАНАЛ ОБНОВЛЕНИЙ','set-update-channel',['release','beta','nightly']));
  settings.push(info('АВТОРИЗАЦИЯ SOCKS','set-socks-username / set-socks-password / clear-socks-auth\n\nСекреты настраиваются непосредственно на роутере. LOST не принимает и не показывает пароли.'));
  settings.push(info('СЦЕНАРИЙ МАРШРУТОВ','create-route-script\n\nКоманда создаёт файл на роутере. Содержимое и путь сценария готовятся через SSH; LOST не перезаписывает действующую маршрутизацию.'));
  return{description:'AdGuard VPN на Keenetic. Команды выполняются только после выбора и подтверждения. Выключение модуля в разделе «Модули» останавливает мониторинг LOST, VPN роутера продолжает работать.',dir:[
   read('СОСТОЯНИЕ','status'),
   {label:'ПОДКЛЮЧЕНИЕ',dir:[
    confirm('ПОСЛЕДНЯЯ ЛОКАЦИЯ','connect','last'),
    confirm('САМАЯ БЫСТРАЯ','connect --fastest','fastest'),
    confirm('НЬЮ-ЙОРК','connect -l "New York"','connect','New York'),
    confirm('ФИНЛЯНДИЯ','connect -l Finland','connect','Finland'),
    entry('ДРУГАЯ ЛОКАЦИЯ','connect -l …',function(v){return{action:'connect',value:v};},'Город, страна или ISO-код. Подключение изменится для всех устройств за роутером.','New York'),
    confirm('ОТКЛЮЧИТЬ VPN','disconnect','disconnect',undefined,'Устройства за роутером вернутся к обычному интернет-соединению.')]},
   read('ЛОКАЦИИ','locations'),
   {label:'ИСКЛЮЧЕНИЯ САЙТОВ',dir:exclusions},
   {label:'НАСТРОЙКИ',dir:settings},
   {label:'ДИАГНОСТИКА',dir:[read('ТУННЕЛЬ И DNS','guard'),read('ВЕРСИЯ CLI','version'),read('ПОДПИСКА','license'),read('ПРОВЕРИТЬ ОБНОВЛЕНИЕ','check-update'),read('ВЫГРУЗИТЬ ЖУРНАЛЫ','export-logs')]},
   {label:'ОБСЛУЖИВАНИЕ',dir:[
    confirm('ОБНОВИТЬ CLI','update -y','update',undefined,'Обновление может прервать работу VPN на роутере.'),
    info('ВХОД В УЧЁТНУЮ ЗАПИСЬ','Интерактивный вход выполняется через SSH на роутере. Учётная запись уже настроена; LOST не создаёт новую сессию авторизации.'),
    confirm('ВЫХОД ИЗ УЧЁТНОЙ ЗАПИСИ','logout','logout',undefined,'После выхода VPN не подключится до повторного входа через SSH.')]}]};
 }
 // Подпись пункта в корне меню — как «ЗВУК: ДИНАМИКИ»: раздел и текущее состояние.
 function title(){
  var known=state.updatedAt && Date.now()-state.updatedAt<90000, status=known?state.status:'unavailable';
  return 'VPN: '+value(status);
 }
 function value(status){return status==='connected'?String(state.location||'ПОДКЛЮЧЁН').toUpperCase():status==='disconnected'?'ОТКЛЮЧЁН':status==='connecting'?'ПОДКЛЮЧЕНИЕ':'НЕТ ДАННЫХ';}
 window.LostVPN={menu:menu,title:title,execute:execute,status:function(){return state;}};
 window.addEventListener('lost-modules',function(e){var m=e.detail&&e.detail.vpn;if(m){state.enabled=m.enabled;paint();if(m.enabled)poll();}});
 paint();poll();timer=setInterval(poll,5000);window.addEventListener('pagehide',function(){clearInterval(timer);});
})();
