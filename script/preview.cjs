'use strict';
// Local workstation preview. No launchd, iMessage, UPS service or audio-device changes.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn,execFileSync}=require('node:child_process');
const [bundle,root,workspace]=process.argv.slice(2),port=18765;
if(!bundle||!root||!workspace)throw Error('preview: bundle, project and workspace required');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function request(route){return new Promise((resolve,reject)=>{const r=http.get({host:'127.0.0.1',port,path:route},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve(text));});r.on('error',reject);r.setTimeout(1000,()=>r.destroy());});}
(async()=>{
 try {const h=JSON.parse(await request('/__health'));if(h.components?.preview!==true)throw Error('Port 18765 belongs to another service');await request('/__quit');await sleep(500);}catch(e){if(!['ECONNREFUSED','ECONNRESET'].includes(e.code)&&e.message!=='socket hang up')throw e;}
 const appDir=path.join(workspace,'cast-app'),logs=path.join(require('node:os').homedir(),'Library/Logs/LOST Preview');fs.mkdirSync(appDir,{recursive:true});fs.mkdirSync(logs,{recursive:true});
 for(const folder of ['assets','css','js','ups','muse']){const dest=path.join(workspace,folder);if(!fs.existsSync(dest))fs.symlinkSync(path.join(root,folder),dest,'dir');}
 fs.copyFileSync(path.join(root,'index.html'),path.join(workspace,'index.html'));fs.copyFileSync(path.join(root,'console.html'),path.join(workspace,'console.html'));
 for(const file of ['server.js','clock.js','bridge.js','state-store.js','ups-gateway.js','modules.js'])fs.copyFileSync(path.join(root,'cast-app',file),path.join(appDir,file));
 for(const folder of ['node_modules','vendor']){const dest=path.join(appDir,folder);if(!fs.existsSync(dest))fs.symlinkSync(path.join(root,'cast-app',folder),dest,'dir');}
 const state=path.join(appDir,'.state.json');if(!fs.existsSync(state))fs.writeFileSync(state,JSON.stringify({audio:'speakers',mode:'dev',live:{left:6480,paused:true},dev:{left:240,paused:false}}));
 const dest=path.join(workspace,'LOST Preview.app');fs.cpSync(bundle,dest,{recursive:true,force:true});
 const plist=path.join(dest,'Contents/Info.plist');for(const [key,value]of [['CFBundleIdentifier','com.exrector.lost.preview'],['CFBundleName','LOST Preview'],['CFBundleDisplayName','LOST Preview']])execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]);
 execFileSync('/usr/bin/codesign',['--force','--sign','-',dest],{stdio:'ignore'});
 const museRuntime=require(path.join(root,'muse/supervisor.cjs')).createMuse({root});
 const museDemo=process.env.LOST_PREVIEW_MUSE_DEMO==='1';
 const demoChat={phase:'idle',available:true,error:null,messages:[]};
 if(museDemo){const saved=JSON.parse(fs.readFileSync(state));saved.modules={...saved.modules,muse:true};fs.writeFileSync(state,JSON.stringify(saved));}
 function demoSend(message){
  if(demoChat.phase!=='idle')return Promise.resolve({ok:false,error:'busy'});
  demoChat.messages.push({id:'demo-user-'+Date.now(),role:'user',text:message});demoChat.phase='waiting';
  setTimeout(()=>{const row={id:'demo-reply-'+Date.now(),role:'assistant',text:'',pending:true};demoChat.messages.push(row);demoChat.phase='replying';
   const text='Проверочный ответ интерфейса. Сообщение осталось на этом Mac; подключение к Muse не использовалось.';let i=0;const t=setInterval(()=>{row.text=text.slice(0,i+=5);if(i>=text.length){clearInterval(t);row.pending=false;demoChat.phase='idle';}},60);
  },600);return Promise.resolve({ok:true});
 }
 const {start,events}=require(path.join(appDir,'server.js'));
 const core=await start(port,{host:'127.0.0.1',audioDevice:false,liveInDev:true,upsPort:18766,stage:{width:1000,height:460},moduleInstalled:{muse:museDemo||museRuntime.installed()},musePreview:museDemo,getMuseChat:museDemo?()=>demoChat:museRuntime.chat,sendMuseMessage:museDemo?demoSend:museRuntime.sendMessage,sendMuseVoice:museDemo?undefined:museRuntime.sendVoice,applyModule:(id,on)=>id==='muse'&&!museDemo?museRuntime.apply(id,on):Promise.resolve({status:on?'ready':'disabled',installed:true}),getRuntimeStatus:()=>({preview:true})});
 const musePoll=setInterval(()=>core.updateMuse(museDemo?{enabled:true,installed:true,status:'ready'}:museRuntime.read()),2000);
 const log=fs.openSync(path.join(logs,'native.log'),'a');
 const child=require(path.join(root,'cast-app/native-host')).launchNative({bundle:dest,args:['--managed','--owner-pid',String(process.pid),'--url',`http://localhost:${port}`,'--preview','--status',path.join(logs,'native-status.json')],status:path.join(logs,'native-status.json'),stdio:['ignore',log,log]});
 let closing=false;async function quit(){if(closing)return;closing=true;clearInterval(musePoll);core.saveState();await child.stop();await museRuntime.close();core.server.close(()=>process.exit(0));}
 events.on('quit',quit);process.on('SIGINT',quit);process.on('SIGTERM',quit);child.on('exit',quit);
 console.log('Local LOST Preview: http://127.0.0.1:'+port+'; '+workspace);
})().catch(e=>{console.error(e);process.exitCode=1;});
