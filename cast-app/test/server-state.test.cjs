'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');const {spawn}=require('node:child_process');const WS=require('ws');
const source=path.resolve(__dirname,'..');
function request(port,route){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:route},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body}));}).on('error',reject);});}
async function health(port){return JSON.parse((await request(port,'/__health')).body);}
function boot(dir,liveInDev=false,upsPort=8766,extra=''){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',`let now=0;require('./cast-app/server').start(0,{host:'127.0.0.1',audioDevice:false,upsPort:${upsPort},liveInDev:${liveInDev},${extra}clockNow:()=>now}).then(c=>{process.send({port:c.server.address().port});process.on('message',m=>{now=m.now;process.send({ack:now})});process.on('SIGTERM',()=>{c.saveState();process.exit(0)});}).catch(e=>{console.error(e);process.exit(1)})`],{cwd:dir,stdio:['ignore','pipe','pipe','ipc']});let errors='';child.stderr.on('data',c=>errors+=c);child.once('message',m=>resolve({child,port:m.port}));child.once('error',reject);child.once('exit',c=>{if(c)reject(new Error('core exit '+c+': '+errors));});});}
function advance(child,now){return new Promise(resolve=>{child.once('message',resolve);child.send({now});});}
function stop(child,signal='SIGTERM'){return new Promise(resolve=>{child.once('exit',resolve);child.kill(signal);});}
function connect(port,role){return new Promise((resolve,reject)=>{const w=new WS('ws://127.0.0.1:'+port+'/bridge?role='+role);w.on('error',reject);w.once('open',()=>resolve(w));});}
async function until(fn){for(let i=0;i<80;i++){if(await fn())return;await new Promise(r=>setTimeout(r,15));}throw new Error('condition timeout');}
function fixture(saved){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lost-clock-'));const app=path.join(dir,'cast-app');fs.mkdirSync(app);for(const name of ['server.js','state-store.js','modules.js','ups-gateway.js','clock.js'])fs.copyFileSync(path.join(source,name),path.join(app,name));fs.symlinkSync(path.join(source,'../muse'),path.join(dir,'muse'),'dir');fs.symlinkSync(path.join(source,'../remote'),path.join(dir,'remote'),'dir');fs.mkdirSync(path.join(dir,'js'));fs.copyFileSync(path.join(source,'../js/lost-timeline.js'),path.join(dir,'js/lost-timeline.js'));fs.symlinkSync(path.join(source,'node_modules'),path.join(app,'node_modules'),'dir');fs.writeFileSync(path.join(dir,'index.html'),'<head></head><body>timer</body>');fs.writeFileSync(path.join(app,'.state.json'),JSON.stringify(saved));return{dir,file:path.join(app,'.state.json')};}

test('core clock advances without any windows, rejects renderer time, preserves pause/modes through crash',async()=>{
 const f=fixture({audio:'off',mode:'live',live:{left:500,paused:false},dev:{left:10,paused:false}});let app,ws;
 try{
  app=await boot(f.dir);await advance(app.child,20000);assert.equal((await health(app.port)).timer.left,480);
  ws=await connect(app.port,'tv');ws.send(JSON.stringify({type:'enableConsole',mode:'live',remainingTime:1}));ws.send(JSON.stringify({type:'__state',mode:'live',label:'▶ Старт'}));
  await new Promise(r=>setTimeout(r,30));assert.deepEqual((await health(app.port)).timer,{mode:'live',left:480,paused:false});
  ws.send(JSON.stringify({type:'__timer',mode:'live',op:'pause',paused:true}));await until(async()=>(await health(app.port)).timer.paused);
  await advance(app.child,30000);assert.equal((await health(app.port)).timer.left,480);
  await request(app.port,'/index.html?mode=dev');await advance(app.child,40000);assert.deepEqual((await health(app.port)).timer,{mode:'dev',left:0,paused:false});
  await advance(app.child,110000);assert.equal((await health(app.port)).timer.left,6480);
  await request(app.port,'/index.html?mode=live');assert.deepEqual((await health(app.port)).timer,{mode:'live',left:480,paused:true});
  app.child.kill('SIGKILL');await new Promise(r=>app.child.once('exit',r));ws.terminate();ws=null;app=null;
  app=await boot(f.dir);assert.deepEqual((await health(app.port)).timer,{mode:'live',left:480,paused:true});
  const saved=JSON.parse(fs.readFileSync(f.file));assert.equal(saved.audio,'off');assert.equal(saved.dev.left,6480);
 }finally{if(ws)ws.terminate();if(app)await stop(app.child);fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('active Dev and frozen Live restore; explicit controls persist and downtime is excluded',async()=>{
 const f=fixture({audio:'off',mode:'dev',live:{left:5000,paused:false},dev:{left:123,paused:true}});let app,ws;
 try{
  app=await boot(f.dir);const redir=await request(app.port,'/index.html');assert.equal(redir.headers.location,'/index.html?mode=dev');
  const page=await request(app.port,'/index.html?mode=dev');assert.match(page.body,/window.__LOST_CLOCK=/);assert.match(page.body,/"left":123,"paused":true/);
  ws=await connect(app.port,'tv');ws.send(JSON.stringify({type:'__timer',mode:'dev',op:'set',seconds:60}));await until(async()=>(await health(app.port)).timer.left===60);
  await advance(app.child,80000);assert.equal((await health(app.port)).timer.left,60);
  await request(app.port,'/index.html?mode=live');assert.deepEqual((await health(app.port)).timer,{mode:'live',left:5000,paused:false});
  await stop(app.child);ws.terminate();ws=null;app=null;
  app=await boot(f.dir);assert.deepEqual((await health(app.port)).timer,{mode:'live',left:5000,paused:false});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).dev,{left:60,paused:true});
 }finally{if(ws)ws.terminate();if(app)await stop(app.child);fs.rmSync(f.dir,{recursive:true,force:true});}
});


test('Live runs under paused Dev; mode switching works without a TV; both slots and audio survive restart',async()=>{
 const f=fixture({audio:'off',mode:'live',live:{left:1000,paused:false},dev:{left:60,paused:true}});let app,ws;
 try{
  app=await boot(f.dir,true);ws=await connect(app.port,'console');
  ws.send(JSON.stringify({type:'__cmd',cmd:'mode',value:'dev'}));await until(async()=>(await health(app.port)).timer.mode==='dev');
  await advance(app.child,20000);let h=await health(app.port);assert.equal(h.timer.left,60);assert.equal(h.clocks.live.left,980);
  ws.send(JSON.stringify({type:'__audio',mode:'monitor'}));await until(async()=>JSON.parse(fs.readFileSync(f.file)).audio==='monitor');
  await stop(app.child);ws.terminate();ws=null;app=null;
  app=await boot(f.dir,true);h=await health(app.port);assert.equal(h.clocks.live.left,980);assert.deepEqual(h.timer,{mode:'dev',left:60,paused:true});
  assert.equal(JSON.parse(fs.readFileSync(f.file)).audio,'monitor');
 }finally{if(ws)ws.terminate();if(app)await stop(app.child);fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('module off blocks all UPS upstream traffic, broadcasts/persists desired state without changing either clock',async()=>{
 const f=fixture({audio:'off',mode:'dev',live:{left:4321,paused:true},dev:{left:123,paused:true}});
 let app,ws,tv,seen=0;
 const upstream=http.createServer((_req,res)=>{seen++;res.end('{"online":true}');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const upsPort=upstream.address().port;
 try{
  app=await boot(f.dir,false,upsPort);ws=await connect(app.port,'console');tv=await connect(app.port,'tv');
  const before=(await health(app.port)).clocks;
  assert.equal((await request(app.port,'/__ups/state')).status,200);assert.equal(seen,1);
  const messages=[];ws.on('message',m=>{try{messages.push(JSON.parse(m));}catch{}});
  tv.send(JSON.stringify({type:'__module',id:'ups',enabled:false}));await new Promise(r=>setTimeout(r,30));
  assert.equal((await health(app.port)).modules.ups.enabled,true);
  ws.send(JSON.stringify({type:'__module',id:'muse',enabled:true}));ws.send(JSON.stringify({type:'__module',id:'ups',enabled:'false'}));
  await until(()=>messages.filter(m=>m.type==='__module_error').length===2);
  assert.equal((await health(app.port)).modules.ups.enabled,true);
  ws.send(JSON.stringify({type:'__module',id:'ups',enabled:false}));
  await until(async()=>(await health(app.port)).modules.ups.status==='disabled');
  for(const route of ['/__ups/state','/__ups/variable','/__ups/beeper','/__ups']){
   const response=await request(app.port,route);assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{error:'module_disabled'});
  }
  assert.equal(seen,1);assert.deepEqual((await health(app.port)).clocks,before);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).modules,{ups:false,muse:false});
  const snapshot=(await health(app.port)).modules;
  assert.ok(messages.some(m=>m.type==='__modules'&&m.modules.ups.status==='disabled'));
  assert.match((await request(app.port,'/index.html?mode=dev')).body,new RegExp('window.__LOST_MODULES='+JSON.stringify(snapshot).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  await stop(app.child);ws.terminate();tv.terminate();ws=tv=null;app=null;
  app=await boot(f.dir,false,upsPort);assert.equal((await health(app.port)).modules.ups.enabled,false);
  assert.equal((await request(app.port,'/__ups/state')).status,503);assert.equal(seen,1);
  assert.deepEqual((await health(app.port)).clocks,before);
  ws=await connect(app.port,'console');ws.send(JSON.stringify({type:'__module',id:'ups',enabled:true}));
  await until(async()=>(await health(app.port)).modules.ups.status==='ready');
  assert.equal((await request(app.port,'/__ups/state')).status,200);assert.equal(seen,2);
 }finally{ws?.terminate();tv?.terminate();if(app)await stop(app.child);await new Promise(r=>upstream.close(r));fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('K in the terminal: a Mac mini command runs only from the console; an unknown name answers with an error, nothing runs',async()=>{
 const f=fixture({});const {child,port}=await boot(f.dir);const tv=await connect(port,'tv'),con=await connect(port,'console');const got=[];con.on('message',m=>{const d=JSON.parse(m);if(d.type==='__shortcut_result')got.push(d);});
 try{tv.send(JSON.stringify({type:'__shortcut_run',id:1,name:'LOST test: no such command'}));con.send(JSON.stringify({type:'__shortcut_run',id:2,name:'LOST test: no such command'}));
  await until(()=>got.length>0);await new Promise(r=>setTimeout(r,100));
  assert.equal(got.length,1);assert.equal(got[0].id,2);assert.match(got[0].text,/^ошибка: команды «LOST test: no such command» нет/);
 }finally{tv.close();con.close();await stop(child);}
});

test('journal is Live only: a code accepted in Dev is not written, the Live code over the remote is',async()=>{
 const f=fixture({audio:'off',mode:'dev',live:{left:200,paused:false},dev:{left:100,paused:false}});let app,ws;
 const journal=path.join(f.dir,'cast-app','journal.txt');
 try{
  app=await boot(f.dir);ws=await connect(app.port,'console');
  ws.send(JSON.stringify({type:'numberSubmitted',value:'4 8 15 16 23 42'}));
  await until(async()=>(await health(app.port)).timer.left>6000);
  assert.equal(fs.existsSync(journal)&&fs.readFileSync(journal,'utf8'),false,'Dev code is not journaled');
  assert.equal((await request(app.port,'/__cmd?text='+encodeURIComponent('4 8 15 16 23 42'))).body,'КОД ПРИНЯТ 108.00');
  assert.match((await request(app.port,'/__journal?lines=2')).body,/^\d+:\d\d accepted$/);
  assert.equal((await health(app.port)).timer.mode,'dev');
 }finally{if(ws)ws.terminate();if(app)await stop(app.child);fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('Mac mini commands module switched off: the terminal gets a refusal and nothing runs',async()=>{
 const f=fixture({modules:{shortcuts:false}});const {child,port}=await boot(f.dir,false,8766,'moduleInstalled:{shortcuts:true},');const con=await connect(port,'console');const got=[];con.on('message',m=>{const d=JSON.parse(m);if(d.type==='__shortcut_result')got.push(d);});
 try{
  const m=(await health(port)).modules.shortcuts;assert.equal(m.enabled,false);assert.equal(m.installed,true);
  con.send(JSON.stringify({type:'__shortcut_run',id:7,name:'LOST test: no such command'}));
  await until(()=>got.length>0);assert.equal(got[0].text,'ошибка: модуль «Команды Mac mini» выключен');
 }finally{con.close();await stop(child);}
});

test('remote replies are one short line about Live: status, pause, start, code, with the minutes left',async()=>{
 const f=fixture({audio:'off',mode:'live',live:{left:1140,paused:false},dev:{left:6480,paused:true}});const {child,port}=await boot(f.dir);
 const cmd=async t=>(await request(port,'/__cmd?text='+encodeURIComponent(t))).body;
 try{
  const full=await cmd('статус');assert.match(full,/^ТАЙМЕР: ОСТАЛОСЬ 019\.00\n/);assert.doesNotMatch(full,/ЯДРО/);
  assert.equal(await cmd('4 8 15 16 23 42'),'КОД НЕ ПРИНЯТ 019.00');
  assert.equal(await cmd('пауза'),'ПАУЗА 019.00');
  assert.match(await cmd('статус'),/^ТАЙМЕР: ПАУЗА 019\.00\n/);
  assert.equal(await cmd('старт'),'СТАРТ 019.00');
  assert.equal(await cmd('LOST test: abracadabra'),'КОМАНДА НЕ РАСПОЗНАНА. СПИСОК: HELP');
 }finally{await stop(child);}
});
test('the right code in the last four minutes answers КОД ПРИНЯТ with the new 108 minutes',async()=>{
 const f=fixture({audio:'off',mode:'live',live:{left:200,paused:false},dev:{left:6480,paused:true}});const {child,port}=await boot(f.dir);
 try{assert.equal((await request(port,'/__cmd?text='+encodeURIComponent('4 8 15 16 23 42'))).body,'КОД ПРИНЯТ 108.00');}
 finally{await stop(child);fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('the remote ignores Dev: with the terminal in Dev it reports, pauses and resets Live only',async()=>{
 const f=fixture({audio:'off',mode:'dev',live:{left:200,paused:false},dev:{left:3000,paused:false}});const {child,port}=await boot(f.dir);
 const cmd=async t=>(await request(port,'/__cmd?text='+encodeURIComponent(t))).body;
 try{
  assert.match(await cmd('статус'),/^ТАЙМЕР: ОСТАЛОСЬ 003\.00 · ВВОД КОДА\n/);
  assert.equal(await cmd('пауза'),'ПАУЗА 003.00');
  let h=await health(port);assert.equal(h.clocks.live.paused,true);assert.equal(h.timer.mode,'dev');assert.equal(h.timer.paused,false);
  assert.equal(await cmd('старт'),'СТАРТ 003.00');
  assert.equal(await cmd('4 8 15 16 23 42'),'КОД ПРИНЯТ 108.00');
  h=await health(port);assert.ok(h.clocks.live.left>6470);assert.equal(h.timer.mode,'dev');assert.ok(h.timer.left<=3000&&h.timer.left>2990);
 }finally{await stop(child);fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('status answers at once with the data already collected, without waiting for a poll',async()=>{
 const f=fixture({audio:'off',mode:'live',live:{left:1140,paused:false},dev:{left:6480,paused:true}});const {child,port}=await boot(f.dir);
 try{
  const started=Date.now();const body=(await request(port,'/__cmd?text='+encodeURIComponent('статус'))).body;
  assert.match(body,/^ТАЙМЕР: ОСТАЛОСЬ 019\.00/);assert.ok(Date.now()-started<5000,'no wait for a poll cycle');
 }finally{await stop(child);fs.rmSync(f.dir,{recursive:true,force:true});}
});
