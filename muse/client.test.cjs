'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 const listeners=new Map(),commands=[],fetches=[];let document;
 class Element{
  constructor(tag,cls=''){this.tagName=tag;this.className=cls;this.children=[];this.hidden=false;this.disabled=false;this.value='';this.placeholder='';this._maxLength=-1;this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100;this.style={};this.events={};this._dataset={};
   this.classList={contains:c=>this.className.split(' ').includes(c),add:c=>{if(!this.classList.contains(c))this.className+=' '+c;},remove:c=>{this.className=this.className.split(' ').filter(x=>x!==c).join(' ');},toggle:(c,on)=>on?this.classList.add(c):this.classList.remove(c)};
  }
  // как в браузере: dataset есть всегда и только для чтения (присваивание в строгом режиме — TypeError)
  get dataset(){return this._dataset;}
  appendChild(e){if(e.parent)e.parent.children=e.parent.children.filter(x=>x!==e);this.children.push(e);e.parent=this;return e;}
  get maxLength(){return this._maxLength;} set maxLength(v){if(v<0)throw new Error('IndexSizeError');this._maxLength=v;} removeAttribute(n){if(n==='maxlength')this._maxLength=-1;}
  setAttribute(){} addEventListener(k,fn){this.events[k]=fn;} replaceChildren(){this.children=[];} focus(){document.activeElement=this;} scrollBy(_,n){this.scrollTop+=n;}
  querySelector(q){const find=e=>e.children.flatMap(x=>[x,...find(x)]);return find(this).find(e=>q.startsWith('.')?q.slice(1).split('.').every(c=>e.classList.contains(c)):e.tagName===q)||null;}
 }
 const body=new Element('body','console-page'),surface=body.appendChild(new Element('div','console-container')),prompt=surface.appendChild(new Element('div','console-prompt')),wrap=surface.appendChild(new Element('div','console-input')),input=wrap.appendChild(new Element('input','my-console'));input.disabled=false;input.readOnly=true;
 document={body,activeElement:body,hidden:false,createElement:t=>new Element(t),querySelector:q=>body.querySelector(q),addEventListener(){}};
 function dispatch(e){e.preventDefault=()=>{};e.stopImmediatePropagation=()=>{e.stopped=true;};for(const fn of listeners.get(e.type)||[]){fn(e);if(e.stopped)break;}return true;}
 const win={document,__LOST_CLOCK:{phase:'countdown',left:6480},__LOST_MODULES:{muse:{enabled:true,installed:true,status:'ready'}},addEventListener(k,fn){listeners.set(k,[...(listeners.get(k)||[]),fn]);},dispatchEvent:dispatch};
 win.LostStation={microphone(c){commands.push(c.op);if(c.op==='start')win.LostMuse.setMicrophone({recording:true,finished:false,draftReady:false});if(c.op==='stop')win.LostMuse.setMicrophone({recording:false,finished:true,draftReady:true,elapsed:2});if(c.op==='cancel')win.LostMuse.setMicrophone({recording:false,finished:true,draftReady:false});if(c.op==='send')win.LostMuse.setMicrophone({draftReady:false,uploading:true});}};
 const context={window:win,document,CustomEvent:class{constructor(type,o={}){this.type=type;this.detail=o.detail;}},AbortController,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},fetch:(url,o)=>{fetches.push([url,o&&o.body]);return new Promise(()=>{});}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/station-input.js'),'utf8'),context);
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'client.js'),'utf8'),context);
 win.LostMuse.setMicrophone({available:true,supported:true,recording:false,requesting:false,uploading:false});
 return {win,commands,fetches,input,surface,body,dispatch,key:(type,key,code=key,extra={})=>dispatch({type,key,code,target:input,repeat:false,...extra})};
}
test('RESET release retains voice draft; only Enter sends once',()=>{
 const f=fixture();f.win.LostMuse.open();assert.equal(f.surface.querySelector('.my-console'),f.input);assert.equal(f.body.querySelector('.muse-panel'),null);
 f.key('keydown','Control','ControlLeft');f.key('keyup','Control','ControlLeft');
 assert.equal(f.commands.filter(x=>x==='stop').length,1);assert.equal(f.commands.includes('send'),false);assert.equal(f.input.readOnly,true);
 f.key('keydown','Enter');f.key('keydown','Enter','Enter',{repeat:true});assert.equal(f.commands.filter(x=>x==='send').length,1);
});
test('Escape discards unsent audio before leaving; original numeric input stays locked',()=>{
 const f=fixture();f.win.LostMuse.open();f.key('keydown','Control','ControlLeft');f.key('keyup','Control','ControlLeft');f.key('keydown','Escape');
 assert.equal(f.win.LostMuse.isOpen(),true);assert.equal(f.commands.at(-1),'cancel');assert.equal(f.commands.includes('send'),false);
 f.key('keydown','Escape');assert.equal(f.win.LostMuse.isOpen(),false);assert.equal(f.input.disabled,false);assert.equal(f.input.readOnly,true);
});
test('code priority closes AI and discards the draft without sending',()=>{
 const f=fixture();f.win.LostMuse.open();f.key('keydown','Control','ControlLeft');f.key('keyup','Control','ControlLeft');
 f.win.dispatchEvent({type:'lost-muse-code-priority',detail:{active:true}});assert.equal(f.win.LostMuse.isOpen(),false);assert.equal(f.commands.at(-1),'cancel');assert.equal(f.commands.includes('send'),false);
});

test('hidden AI command is invisible until complete and survives clock updates',()=>{
 const f=fixture();f.key('keydown','x','KeyX');f.key('keydown','a','KeyA');assert.equal(f.input.value,'');
 f.key('keydown','i','KeyI');assert.equal(f.input.value,'AI');assert.equal(f.input.disabled,false);assert.equal(f.input.readOnly,true);
 for(let i=0;i<5;i++)f.win.dispatchEvent({type:'message',data:{type:'enableConsole',enabled:false,remainingTime:6400-i}});
 assert.equal(f.input.value,'AI');f.key('keydown','x','KeyX');assert.equal(f.input.value,'AI');
 f.key('keydown','Enter');assert.equal(f.win.LostMuse.isOpen(),true);assert.equal(f.input.value,'');
});
test('Escape clears recognized secret; code window receives normal input',()=>{
 const f=fixture();f.key('keydown','a','KeyA');f.key('keydown','i','KeyI');f.key('keydown','Escape');assert.equal(f.input.value,'');
 f.key('keydown','a','KeyA');f.key('keydown','i','KeyI');f.win.dispatchEvent({type:'message',data:{type:'enableConsole',enabled:true,remainingTime:240}});
 assert.equal(f.input.value,'');assert.equal(f.win.LostConsoleInput.codeOpen(),true);assert.equal(f.win.LostMuse.isOpen(),false);
});

test('recognized command survives focus changes and modifier keys',()=>{
 const f=fixture();f.key('keydown','a','KeyA');f.key('keydown','i','KeyI');
 f.dispatch({type:'blur'});f.key('keydown','Control','ControlLeft',{ctrlKey:true});assert.equal(f.input.value,'AI');
});
test('secret Enter release is swallowed across the numeric-code transition',()=>{
 const f=fixture();f.key('keydown','a','KeyA');f.key('keydown','i','KeyI');f.key('keydown','Enter');
 f.win.dispatchEvent({type:'lost-muse-code-priority',detail:{active:true}});
 f.win.dispatchEvent({type:'message',data:{type:'enableConsole',enabled:true,remainingTime:240}});
 let leaked=false;f.win.addEventListener('keyup',()=>{leaked=true;});f.key('keyup','Enter');assert.equal(leaked,false);
});

test('AI Enter release is swallowed if the code window opens while sending',()=>{
 const f=fixture();f.win.LostMuse.open();f.input.value='Проверка';f.key('keydown','Enter');
 f.win.dispatchEvent({type:'lost-muse-code-priority',detail:{active:true}});
 f.win.dispatchEvent({type:'message',data:{type:'enableConsole',enabled:true,remainingTime:240}});
 let leaked=false;f.win.addEventListener('keyup',()=>{leaked=true;});f.key('keyup','Enter');assert.equal(leaked,false);
});


test('last eight minutes close AI and discard audio; four-minute numeric gate stays separate',()=>{
 const f=fixture();f.win.LostMuse.open();f.key('keydown','Control','ControlLeft');f.key('keyup','Control','ControlLeft');
 f.win.__LOST_CLOCK={phase:'countdown',left:480};
 f.dispatch({type:'lost-muse-code-priority',detail:{active:true}});
 f.dispatch({type:'message',data:{type:'enableConsole',enabled:false,remainingTime:480}});
 assert.equal(f.win.LostMuse.isOpen(),false);assert.equal(f.commands.at(-1),'cancel');assert.equal(f.commands.includes('send'),false);
 assert.equal(f.win.LostConsoleInput.codeOpen(),false);assert.equal(f.input.readOnly,true);
 f.key('keydown','a','KeyA');f.key('keydown','i','KeyI');f.key('keydown','Enter');f.key('keydown','F3','F3');
 assert.equal(f.input.value,'');assert.equal(f.win.LostMuse.isOpen(),false);
 let menu=false;f.win.addEventListener('keydown',e=>{if(e.key==='ArrowRight')menu=true;});f.key('keydown','ArrowRight');assert.equal(menu,true);
 f.dispatch({type:'message',data:{type:'enableConsole',enabled:true,remainingTime:240}});assert.equal(f.win.LostConsoleInput.codeOpen(),true);
 f.win.__LOST_CLOCK={phase:'countdown',left:6480};f.dispatch({type:'lost-muse-code-priority',detail:{active:false}});
 f.dispatch({type:'message',data:{type:'enableConsole',enabled:false,remainingTime:6480}});
 f.key('keydown','a','KeyA');f.key('keydown','i','KeyI');f.key('keydown','Enter');assert.equal(f.win.LostMuse.isOpen(),true);
});
test('Right returns from AI to developer menu even with a draft, without sending',()=>{
 const f=fixture();f.win.LostMuse.open();f.input.value='draft';let menu=false;
 f.win.addEventListener('keydown',e=>{if(e.key==='ArrowRight')menu=true;});f.key('keydown','ArrowRight');
 assert.equal(f.win.LostMuse.isOpen(),false);assert.equal(menu,true);assert.equal(f.commands.includes('send'),false);
});
test('conversation stays below the original form and the newest message is on top',()=>{
 const f=fixture();const form=f.surface.querySelector('.muse-compose'),history=f.surface.querySelector('.muse-transcript');
 assert.ok(f.surface.children.indexOf(form)<f.surface.children.indexOf(history));
 f.win.LostMuse.open();f.win.LostMuse.receive({chat:{phase:'idle',messages:[{role:'user',text:'old'},{role:'assistant',text:'old reply'},{role:'user',text:'new'},{role:'assistant',text:'new reply'}]}});
 assert.deepEqual(history.children.map(row=>row.children[1].textContent),['new reply','new','old reply','old']);
 assert.equal(history.scrollTop,0);
});
test('M and P reach the station menu outside tools, including the final eight minutes',()=>{
 const f=fixture();const reached=[];f.win.addEventListener('keydown',e=>reached.push(e.code));
 f.key('keydown','a','KeyA');f.key('keydown','m','KeyM');f.key('keydown','p','KeyP');f.key('keydown','ь','KeyM');
 assert.deepEqual(reached,['KeyM','KeyP','KeyM']);
 f.win.dispatchEvent({type:'lost-muse-code-priority',detail:{active:true}});f.key('keydown','p','KeyP');f.key('keydown','x','KeyX');
 assert.deepEqual(reached,['KeyM','KeyP','KeyM','KeyP']);
});
test('inside AI M and P are ordinary text',()=>{
 const f=fixture();f.win.LostMuse.open();const reached=[];f.win.addEventListener('keydown',e=>reached.push(e.code));
 f.key('keydown','m','KeyM');f.key('keydown','p','KeyP');assert.deepEqual(reached,[]);
});
test('leaving AI restores the hidden-command layer: AI can be typed again',()=>{
 const f=fixture();f.key('keydown','a','KeyA');f.key('keydown','i','KeyI');f.key('keydown','Enter');assert.equal(f.win.LostMuse.isOpen(),true);
 f.key('keydown','Escape');assert.equal(f.win.LostMuse.isOpen(),false);assert.equal(f.body.classList.contains('lost-muse-active'),false);assert.equal(f.input.maxLength,-1);
 f.key('keydown','a','KeyA');f.key('keydown','i','KeyI');assert.equal(f.input.value,'AI');f.key('keydown','Enter');assert.equal(f.win.LostMuse.isOpen(),true);
});
test('open menu swallows stray letters but keeps M and P for the station',()=>{
 const f=fixture();const reached=[];f.win.addEventListener('keydown',e=>reached.push(e.code));
 const menu=f.body.appendChild(new (f.body.constructor)('div','ctl open'));
 f.key('keydown','a','KeyA');f.key('keydown','m','KeyM');f.key('keydown','p','KeyP');f.key('keydown','ArrowDown','ArrowDown');
 assert.deepEqual(reached,['KeyM','KeyP','ArrowDown']);assert.equal(f.input.value,'');
});
test('pause plate is not hidden on the terminal after leaving AI',()=>{
 const f=fixture();f.win.LostMuse.open();f.win.LostMuse.close();f.win.LostMuse.open();f.key('keydown','ArrowRight');
 assert.equal(f.body.classList.contains('lost-muse-active'),false);
});
test('AI always opens at the newest message, not at the old scroll position',()=>{
 const f=fixture();const history=f.surface.querySelector('.muse-transcript');history.scrollTop=300;
 f.win.LostMuse.open();assert.equal(history.scrollTop,0);
});

test('received messages appear in the transcript (a real element\'s dataset is read-only)',()=>{
 const f=fixture();f.win.LostMuse.open();
 f.win.LostMuse.receive({module:{enabled:true,installed:true,status:'ready'},chat:{phase:'idle',available:true,messages:[{id:'u1',role:'user',text:'prosto odin test',createdAt:1},{id:'a1',role:'assistant',text:'Тест дошёл.',createdAt:2}]}});
 const transcript=f.surface.querySelector('.muse-transcript')||f.body.querySelector('.muse-transcript');
 assert.ok(transcript,'transcript exists');
 const rows=transcript.children.map(r=>[r.dataset.timelineId,r._label.textContent,r._body.textContent]);
 assert.deepEqual(rows,[['message:a1','AI','Тест дошёл.'],['message:u1','STATION','prosto odin test']]);
});

test('while Muse replies a voice note can be recorded; Enter queues it and it is sent once Muse is free',()=>{
 const f=fixture();f.win.LostMuse.open();
 const replying={module:{enabled:true,installed:true,status:'ready'},chat:{phase:'replying',messages:[]}};
 f.win.LostMuse.receive(replying);
 f.key('keydown','Control','ControlLeft');assert.equal(f.commands.includes('start'),true,'recording starts while Muse replies');
 f.key('keyup','Control','ControlLeft');f.key('keydown','Enter');
 assert.equal(f.commands.includes('send'),false,'not sent while Muse replies');
 f.win.LostMuse.receive(replying);assert.equal(f.commands.includes('send'),false);
 f.win.LostMuse.receive({chat:{phase:'idle',messages:[]}});
 assert.equal(f.commands.filter(x=>x==='send').length,1,'sent once when Muse is free');
 f.win.LostMuse.receive({chat:{phase:'idle',messages:[]}});assert.equal(f.commands.filter(x=>x==='send').length,1);
});
test('Escape drops the queued send but keeps the voice draft',()=>{
 const f=fixture();f.win.LostMuse.open();f.win.LostMuse.receive({chat:{phase:'waiting',messages:[]}});
 f.key('keydown','Control','ControlLeft');f.key('keyup','Control','ControlLeft');f.key('keydown','Enter');f.key('keydown','Escape');
 assert.equal(f.commands.includes('cancel'),false,'draft kept');
 f.win.LostMuse.receive({chat:{phase:'idle',messages:[]}});assert.equal(f.commands.includes('send'),false);
 f.key('keydown','Enter');assert.equal(f.commands.filter(x=>x==='send').length,1);
});
test('text can be typed while Muse replies; Enter sends it after the reply',()=>{
 const f=fixture();f.win.LostMuse.open();f.win.LostMuse.receive({chat:{phase:'replying',messages:[]}});
 assert.equal(f.input.disabled,false);f.input.value='следующий вопрос';f.key('keydown','Enter');
 assert.equal(f.fetches.some(x=>x[0]==='/__muse/message'),false);
 f.win.LostMuse.receive({chat:{phase:'idle',messages:[]}});
 const sent=f.fetches.filter(x=>x[0]==='/__muse/message');assert.equal(sent.length,1);assert.equal(JSON.parse(sent[0][1]).message,'следующий вопрос');
});
