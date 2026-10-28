(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.LostUPSTelemetry=api;})(typeof window==='object'?window:this,function(){
 'use strict';
 // Свежесть — от интервала, с которым агент читает ИБП (pollInterval, общий цикл станции 2 мин): полтора интервала;
 // окно читает агента раз в 30 с — ответ агента не старше 90 с. Прежние 20 с / 15 с — для опроса раз в 5 с.
 function fresh(state,lastResponse,now){var every=Math.max(5000,Number(state&&state.pollInterval)||5000);return !!(state&&state.online&&Number.isFinite(state.updatedAt)&&now>=state.updatedAt&&now-state.updatedAt<Math.max(20000,every*1.5)&&now-lastResponse<90000);}
 function number(value,unit){return value!==undefined&&value!==null&&value!==''&&Number.isFinite(Number(value))?String(value)+(unit||''):'---';}
 function view(state,lastResponse,now){
  var v=state&&state.vars||{},ok=fresh(state,lastResponse,now),flags=(v['ups.status']||'').split(/\s+/),ob=flags.indexOf('OB')>=0,ol=flags.indexOf('OL')>=0;
  var low=ob&&(flags.indexOf('LB')>=0||(v['battery.charge']!==undefined&&Number(v['battery.charge'])<=15)||(v['battery.runtime']!==undefined&&Number(v['battery.runtime'])<=300));
  var runtime=Number(v['battery.runtime']);
  return {fresh:ok,kind:!ok?'stale':low?'critical':ob?'reserve':'',cells:[
   ['PWR',!ok?'LOST':ob?'RESERVE':ol?'EXT':'UNKNOWN'],
   ['RSV',ok?number(v['battery.charge'],'%'):'---'],
   ['ENDURANCE',ok&&v['battery.runtime']!==undefined&&Number.isFinite(runtime)&&runtime>=0?'~'+String(Math.floor(runtime/60)).padStart(3,'0')+'m':'---'],
   ['BUS',ok?number(v['input.voltage'])+' → '+number(v['output.voltage'],'V'):'--- → ---']
  ]};
 }
 return {fresh:fresh,view:view};
});
