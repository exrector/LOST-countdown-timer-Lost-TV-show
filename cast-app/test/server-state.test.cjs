'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');const {spawn}=require('node:child_process');const WS=require('ws');
const source=path.resolve(__dirname,'..');
function request(port,route){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:route},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body}));}).on('error',reject);});}
async function health(port){return JSON.parse((await request(port,'/__health')).body);}
function boot(dir,liveInDev=false){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',`let now=0;require('./cast-app/server').start(0,{host:'127.0.0.1',audioDevice:false,liveInDev:${liveInDev},clockNow:()=>now}).then(c=>{process.send({port:c.server.address().port});process.on('message',m=>{now=m.now;process.send({ack:now})});process.on('SIGTERM',()=>{c.saveState();process.exit(0)});}).catch(e=>{console.error(e);process.exit(1)})`],{cwd:dir,stdio:['ignore','pipe','pipe','ipc']});let errors='';child.stderr.on('data',c=>errors+=c);child.once('message',m=>resolve({child,port:m.port}));child.once('error',reject);child.once('exit',c=>{if(c)reject(new Error('core exit '+c+': '+errors));});});}
function advance(child,now){return new Promise(resolve=>{child.once('message',resolve);child.send({now});});}
function stop(child,signal='SIGTERM'){return new Promise(resolve=>{child.once('exit',resolve);child.kill(signal);});}
function connect(port,role){return new Promise((resolve,reject)=>{const w=new WS('ws://127.0.0.1:'+port+'/bridge?role='+role);w.on('error',reject);w.once('open',()=>resolve(w));});}
async function until(fn){for(let i=0;i<80;i++){if(await fn())return;await new Promise(r=>setTimeout(r,15));}throw new Error('condition timeout');}
function fixture(saved){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lost-clock-'));const app=path.join(dir,'cast-app');fs.mkdirSync(app);for(const name of ['server.js','state-store.js','ups-gateway.js','clock.js'])fs.copyFileSync(path.join(source,name),path.join(app,name));fs.mkdirSync(path.join(dir,'js'));fs.copyFileSync(path.join(source,'../js/lost-timeline.js'),path.join(dir,'js/lost-timeline.js'));fs.symlinkSync(path.join(source,'node_modules'),path.join(app,'node_modules'),'dir');fs.writeFileSync(path.join(dir,'index.html'),'<head></head><body>timer</body>');fs.writeFileSync(path.join(app,'.state.json'),JSON.stringify(saved));return{dir,file:path.join(app,'.state.json')};}

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
