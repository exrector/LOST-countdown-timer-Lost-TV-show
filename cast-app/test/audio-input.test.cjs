const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
function boot(file, role='console', native=false) {
  const events = {}, played = [], paused = [], nativeMessages = []; let socket;
  class Audio { constructor(src) {this.src=src;} play() {played.push(this.src);return Promise.resolve();} pause() {paused.push(this.src);} }
  class Socket { constructor() {socket=this;this.readyState=1;} send() {} }
  const context = {location:{pathname:role==='console'?'/console.html':'/index.html',host:'localhost:8765'},window:{addEventListener(){}},document:{addEventListener(name,fn){(events[name]??=[]).push(fn);}},WebSocket:Socket,Audio,Promise,URLSearchParams,performance:{now:()=>0},setTimeout,clearTimeout,HTMLMediaElement:class {play(){played.push('native');return Promise.resolve();}pause(){}}};
  if(native)context.window.LostStation={audio:d=>nativeMessages.push(d)};
  const prefix=fs.readFileSync(file,'utf8').split('    // ================= ТВ =================')[0];
  vm.runInNewContext(prefix+'\nvar ui={};})();',context);
  return {played,paused,nativeMessages,context,fire(name,event){for(const fn of events[name]||[])fn(event);},input(name){for(const fn of events[name]||[])fn({});},message(d){socket.onmessage({data:JSON.stringify(d)});}};
}
const source=process.env.BRIDGE_SOURCE || require('node:path').join(__dirname,'../bridge.js');
for(const event of ['keydown','mousedown','touchstart']) test('first '+event+' does not play effects',()=>{const b=boot(source);b.input(event);assert.deepEqual(b.played,[]);});
test('explicit legacy sound still plays and stops',()=>{const b=boot(source);b.message({type:'__audio',mode:'mac'});b.message({type:'__sound',key:'systemfailure',op:'play'});assert.deepEqual(b.played,['assets/sounds/systemfailure.mp3']);b.message({type:'__sound',key:'systemfailure',op:'pause'});assert.equal(b.paused.length,1);});
test('speakers ignore console playback requests',()=>{const b=boot(source);b.message({type:'__sound',key:'systemfailure',op:'play'});assert.deepEqual(b.played,[]);});
test('TV retains real playback',()=>{const b=boot(source,'tv');const a=new b.context.HTMLMediaElement();a.getAttribute=()=> 'assets/sounds/systemfailure.mp3';a.play();assert.deepEqual(b.played,['native']);});

test('native effects go only to the native engine and stop there',()=>{const b=boot(source,'tv',true);const a=new b.context.HTMLMediaElement();a.getAttribute=()=> 'assets/sounds/alarm.mp3';a.play();a.pause();assert.deepEqual(b.played,[]);assert.equal(b.nativeMessages[0].op,'play');assert.equal(b.nativeMessages[0].key,'alarm');assert.equal(b.nativeMessages[1].op,'stop');});
test('audio off disables native effects without browser fallback',()=>{const b=boot(source,'tv',true);b.message({type:'__audio',mode:'off'});const a=new b.context.HTMLMediaElement();a.getAttribute=()=> 'assets/sounds/alarm.mp3';a.play();assert.deepEqual(b.played,[]);assert.equal(b.nativeMessages.length,1);assert.equal(b.nativeMessages[0].op,'mode');assert.equal(b.nativeMessages[0].mode,'off');});

test('native tick waits for the actual transform start',()=>{const b=boot(source,'tv',true);b.context.window.__LOST_TIMER={flips:{5:{}},audioEvents:[]};const a=new b.context.HTMLMediaElement();a.getAttribute=()=> 'assets/sounds/tick.mp3';a.play();assert.equal(b.nativeMessages.length,0);b.fire('transitionstart',{propertyName:'transform',target:{classList:{contains:()=>true}}});assert.equal(b.nativeMessages.length,1);assert.equal(b.nativeMessages[0].key,'tick');assert.equal(b.context.window.__LOST_TIMER.audioEvents[0].reason,'transitionstart');});
test('muting cancels a tick waiting for the animation frame',()=>{const b=boot(source,'tv',true);b.context.window.__LOST_TIMER={flips:{5:{}},audioEvents:[]};const a=new b.context.HTMLMediaElement();a.getAttribute=()=> 'assets/sounds/tick.mp3';a.play();b.message({type:'__audio',mode:'off'});b.fire('transitionstart',{propertyName:'transform',target:{classList:{contains:()=>true}}});assert.equal(b.nativeMessages.length,1);assert.equal(b.nativeMessages[0].op,'mode');});
