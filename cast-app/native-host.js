'use strict';
// LaunchServices gives the GUI its own macOS privacy identity. The core owns a
// tokenized lease, rather than assuming that the GUI is a direct child process.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process');const {EventEmitter}=require('node:events');
function launchNative({bundle,args,status,stdio=['ignore','inherit','inherit'],spawnProcess=spawn,killProcess=(pid,signal)=>process.kill(pid,signal),wait=ms=>new Promise(r=>setTimeout(r,ms)),verifyProcess}){
 const token=crypto.randomUUID(),lease=path.join(os.tmpdir(),'lost-native-owner-'+token+'.json');
 fs.mkdirSync(path.dirname(status),{recursive:true});
 const writeLease=()=>{const tmp=lease+'.tmp';fs.writeFileSync(tmp,JSON.stringify({owner:process.pid,token,updatedAt:Date.now()}),{mode:0o600});fs.renameSync(tmp,lease);};
 const removeLease=()=>{try{fs.unlinkSync(lease);}catch(_){};try{fs.unlinkSync(lease+'.tmp');}catch(_){}};
 writeLease();const timer=setInterval(writeLease,2000);timer.unref();
 let child;try{child=spawnProcess('/usr/bin/open',['-W','-n',bundle,'--args',...args,'--owner-token',token,'--owner-lease',lease],{stdio});}catch(error){clearInterval(timer);removeLease();throw error;}
 const handle=new EventEmitter();handle.pid=child.pid;handle.on('error',()=>{});
 const matchingStatus=()=>{try{const d=JSON.parse(fs.readFileSync(status,'utf8'));if(d.owner===process.pid&&d.ownerToken===token&&d.bundle===bundle&&Number.isInteger(d.pid)&&d.pid>1)return d;}catch(_){}return null;};
 const alive=pid=>{if(!pid)return false;try{killProcess(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
 const verify=verifyProcess||((pid)=>{try{const args=execFileSync('/bin/ps',['-ww','-p',String(pid),'-o','command='],{encoding:'utf8',timeout:1000}).trim();return args.startsWith(path.join(bundle,'Contents/MacOS/LOSTNative')+' ')&&args.includes('--owner-token '+token)&&args.includes('--owner-pid '+process.pid);}catch(_){return false;}});
 const delay=wait;let closed=false,stopTask=null;
 child.once('error',e=>handle.emit('error',e));
 child.once('close',(code,signal)=>{closed=true;clearInterval(timer);removeLease();handle.emit('exit',code,signal);});
 handle.stop=()=>{
  if(stopTask)return stopTask;
  stopTask=(async()=>{clearInterval(timer);const initial=matchingStatus();removeLease();
  for(let i=0;i<40;i++){if(initial?!alive(initial.pid):closed)return;await delay(100);}
  // Only a matching generation can be terminated; never signal the open PID as
  // a substitute for stopping the actual GUI application.
  const current=matchingStatus();
  if(initial&&current?.pid===initial.pid&&alive(initial.pid)){
   if(!verify(initial.pid))throw Error('Native process identity changed; refusing to signal');
   killProcess(initial.pid,'SIGTERM');
   for(let i=0;i<15;i++){if(!alive(initial.pid))return;await delay(100);}
   if(matchingStatus()?.pid===initial.pid&&alive(initial.pid)){if(!verify(initial.pid))throw Error('Native process identity changed');killProcess(initial.pid,'SIGKILL');await delay(200);}
   if(alive(initial.pid))throw Error('LOST native application did not stop');
   return;
  }
  if(initial&&alive(initial.pid))throw Error('Native ownership changed; cannot confirm stop');
  if(!initial&&!closed)throw Error('Native launch did not finish; refusing a duplicate');
  })().finally(()=>{stopTask=null;});
  return stopTask;
 };
 return handle;
}
module.exports={launchNative};
