'use strict';
// User-level agent. It never runs shutdown or arbitrary shell commands.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NutClient } = require('./nut');
const { describe, validateVariable } = require('./fields');
const { DEFAULT_POLICY, validatePolicy } = require('./policy');
const DIR = process.env.LOST_UPS_CONFIG || path.join(os.homedir(), 'Library', 'Application Support', 'LOST UPS');
const PORT = Number(process.env.LOST_UPS_PORT || 8766);
const configFile = path.join(DIR, 'connection.json');
const policyFile = path.join(DIR, 'policy.json');
fs.mkdirSync(DIR, { recursive:true, mode:0o700 });
const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch (_) { return fallback; } };
const save = (f,v) => { const temp=f+'.tmp';fs.writeFileSync(temp,JSON.stringify(v,null,2)+'\n',{mode:0o600});fs.renameSync(temp,f); };
const cfg = read(configFile,{host:'192.168.1.1',port:3493,ups:'ups0'});
let policy = read(policyFile, DEFAULT_POLICY);
if (!fs.existsSync(policyFile)) save(policyFile,policy);
let current = { vars:{},writable:{},updatedAt:null,online:false,error:'Ожидание связи с энергоконтуром' };
let refreshing = null, writing = false;
function client() { return new NutClient(cfg); }
async function refresh(force=false) {
 if (refreshing) { await refreshing; if (!force) return; }
 refreshing=(async()=>{
  try { const s=await client().snapshot();current={...s,updatedAt:s.sampledAt,online:true,error:null}; }
  catch (e) { current={...current,online:false,error:String(e.message).slice(0,180)}; }
 })();
 try { await refreshing; } finally { refreshing=null; }
}
function guardState() {
 const s=read('/Library/Application Support/LOST UPS/status.json',null);
 return s && Date.now()-s.updatedAt<25000 ? {...s,installed:true} : {installed:false,phase:'unavailable'};
}
function state() {
 return { ...current,fields:describe(current.vars,current.writable),policy,guard:guardState(),
  connection:{host:cfg.host,port:cfg.port,ups:cfg.ups},canEdit:!!(cfg.username&&cfg.password),pollInterval:120000 };
}
function json(res,code,data,origin) {
 res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':origin||'null','Vary':'Origin','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));
}
const allowed = new Set(['http://localhost:8765','http://127.0.0.1:8765']);
if (process.env.LOST_UPS_PREVIEW_ORIGIN) allowed.add(process.env.LOST_UPS_PREVIEW_ORIGIN);
const server = http.createServer(async (req,res) => {
 const origin=req.headers.origin;
 if (!origin || !allowed.has(origin)) return json(res,403,{error:'Только локальный терминал LOST'});
 if (req.method==='OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-LOST-UPS','Vary':'Origin'});return res.end(); }
 if (req.method==='GET' && req.url==='/state') return json(res,200,state(),origin);
 // Общий цикл опроса станции (cast-app/start.js, раз в 2 мин) просит прочитать ИБП сейчас — своего таймера у агента нет.
 if (req.method==='GET' && req.url==='/state?refresh=1') { await refresh(true); return json(res,200,state(),origin); }
 if (req.method!=='POST' || req.headers['x-lost-ups']!=='1' || !String(req.headers['content-type']).startsWith('application/json')) return json(res,403,{error:'Запрос отклонён'},origin);
 let data='', acquired=false;
 try {
  for await (const chunk of req) { data+=chunk;if (data.length>4096) throw new Error('Слишком большой запрос'); }
  const body=JSON.parse(data);
  if (writing) return json(res,409,{error:'Дождитесь завершения предыдущей операции'},origin);
  writing=true;acquired=true;
  if (req.url==='/policy') {
   const next=validatePolicy(body);
   if (next.enabled && !guardState().installed) throw new Error('Системная служба выключения ещё не установлена. Защита не включена.');
   policy=next;save(policyFile,next);
  } else if (req.url==='/variable') {
   if (!cfg.username||!cfg.password) throw new Error('Изменение параметров не настроено');
   const fresh=await client().snapshot();
   if (String(fresh.vars[body.name])!==String(body.expected)) throw new Error('Значение уже изменилось. Обновите экран.');
   const value=validateVariable(body.name,body.value,fresh);
   await client().setVariable(body.name,value,cfg);
  } else if (req.url==='/beeper') {
   if (!cfg.username||!cfg.password || typeof body.enabled!=='boolean') throw new Error('Команда недоступна');
   await client().instant(body.enabled?'beeper.enable':'beeper.disable',cfg);
  } else throw new Error('Неизвестная операция');
  await refresh(true);
  if (req.url==='/variable' && (!current.online || String(current.vars[body.name])!==String(body.value))) throw new Error('Запись выполнена, но новое значение не подтверждено. Проверьте показания.');
  json(res,200,state(),origin);
 } catch(e) { json(res,400,{error:String(e.message).slice(0,200)},origin); }
 finally { if (acquired) writing=false; }
});
server.headersTimeout=6000;server.requestTimeout=8000;
server.listen(PORT,'127.0.0.1',()=>console.log('LOST UPS agent listening on loopback:'+PORT));
refresh(); // дальше — по запросу общего цикла опроса станции (GET /state?refresh=1)
