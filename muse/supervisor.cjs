'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const net=require('node:net');
function createMuse({root,home=path.join(os.homedir(),'Library/Application Support/LOST Muse')}){
 const python=path.join(home,'venv/bin/python'),script=path.join(root,'muse/runtime.py');
 let child=null,retry=null,desired=false,closing=false,last={status:'disabled',error:null};
 const installed=()=>[python,script,...['identity.json','pairing.json','sdk_token'].map(n=>path.join(home,'state',n))].every(fs.existsSync);
 function read(){
  if(!desired)return {enabled:false,installed:installed(),status:'disabled',error:null};
  if(!installed())return {enabled:true,installed:false,status:'not_installed',error:'Runtime или сохранённая пара не установлены'};
  let data=last;
  if(child){try{const d=JSON.parse(fs.readFileSync(path.join(home,'status.json'),'utf8'));if(d.pid===child.pid)data=d;}catch(_){} }
  return {...data,enabled:true,installed:true,pid:child?.pid||null};
 }
 function launch(){
  if(!desired||closing||child||!installed())return;
  last={status:'starting',error:null};
  fs.mkdirSync(path.join(home,'logs'),{recursive:true,mode:0o700});
  const fd=fs.openSync(path.join(home,'logs/runtime.log'),'a',0o600);
  const proc=spawn(python,[script],{env:{...process.env,LOST_MUSE_HOME:home,PYTHONUNBUFFERED:'1',LOST_MUSE_OWNER_PID:String(process.pid)},stdio:['ignore',fd,fd]});fs.closeSync(fd);child=proc;
  proc.on('error',()=>{last={status:'error',error:'Не удалось запустить Muse'};});
  proc.on('close',(code)=>{
   if(child===proc){let reported;try{reported=JSON.parse(fs.readFileSync(path.join(home,'status.json'),'utf8'));}catch(_){}
    child=null;last=reported&&reported.pid===proc.pid&&['revoked','error'].includes(reported.status)?reported:{status:'unavailable',error:'Runtime Muse завершён'};
    if(desired&&!closing&&last.status!=='revoked')retry=setTimeout(launch,15000);
   }
  });
 }
 async function stop(){
  clearTimeout(retry);retry=null;
  if(!child)return;
  const proc=child;
  if(!proc.pid){await new Promise(resolve=>proc.once('close',resolve));return;}
  await new Promise((resolve,reject)=>{
   const force=setTimeout(()=>{try{proc.kill('SIGKILL');}catch(_){}},3000);
   const deadline=setTimeout(()=>reject(Error('Не удалось подтвердить остановку Muse')),5000);
   proc.once('close',()=>{clearTimeout(force);clearTimeout(deadline);resolve();});
   proc.kill('SIGTERM');
  });
 }
 function chat(){
  try{const p=path.join(home,'chat.json');if(fs.statSync(p).size>524288)throw Error();const d=JSON.parse(fs.readFileSync(p,'utf8'));return {phase:d.phase||'idle',messages:Array.isArray(d.messages)?d.messages:[],error:d.error||null,available:d.available===true};}
  catch(_){return {phase:'idle',messages:[],available:false,error:null};}
 }
 function requestChat(payload){
  if(!desired||read().status!=='ready')return Promise.resolve({ok:false,error:'not_connected'});
  return new Promise((resolve,reject)=>{
   const socket=net.createConnection(path.join(home,'muse.sock'));let body='',done=false;
   function finish(e,value){if(done)return;done=true;socket.destroy();e?reject(e):resolve(value);}
   socket.setTimeout(65000,()=>finish(Error('timeout')));socket.once('error',e=>finish(e));
   socket.once('connect',()=>socket.write(JSON.stringify(payload)+'\n'));
   socket.on('data',part=>{body+=part;if(body.length>65536)return finish(Error('reply too large'));if(body.includes('\n')){try{finish(null,JSON.parse(body.split('\n')[0]));}catch(e){finish(e);}}});
   socket.once('end',()=>{if(!done)finish(Error('empty reply'));});
  });
 }
 const sendMessage=message=>requestChat({action:'chat_send',message});
 const sendVoice=data=>requestChat({action:'chat_voice',audio_base64:data.toString('base64')});
 return {installed,read,chat,sendMessage,sendVoice,async apply(id,on){if(id!=='muse')throw Error('Unknown module');desired=on;if(on)launch();else await stop();return read();},async close(){closing=true;desired=false;await stop();}};
}
module.exports={createMuse};
