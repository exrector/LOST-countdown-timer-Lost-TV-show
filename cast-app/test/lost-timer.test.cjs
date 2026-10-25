const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
let now=0,id=0,jobs=new Map(),white=false;
function schedule(fn,ms,repeat){jobs.set(++id,{fn,at:now+ms,repeat});return id;}
function advance(ms){const end=now+ms; for(;;){const next=[...jobs].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const [key,j]=next;now=j.at;if(j.repeat)j.at+=j.repeat;else jobs.delete(key);j.fn();}now=end;}
function $(selector){return {show(){white=true;return this},hide(){white=false;return this},animate(){return this},css(){return this},html(){return this},addClass(){return this},removeClass(){return this},each(){return this}};}
const ctx=vm.createContext({$,setTimeout:(f,t)=>schedule(f,t,0),setInterval:(f,t)=>schedule(f,t,t),clearTimeout:i=>jobs.delete(i),clearInterval:i=>jobs.delete(i)});
vm.runInContext(readFileSync(require('node:path').resolve(__dirname,'../../js/lost-timeline.js'),'utf8'),ctx);
vm.runInContext(readFileSync(require('node:path').resolve(__dirname,'../../js/lost-timer.js'),'utf8'),ctx);
const t=Object.create(ctx.lostTimer.prototype);Object.assign(t,{containerClassCss:'.lost-timer',initialSeconds:10,totalSeconds:0,mode:'live',onTick(){},playAudio(){},updateNumbers(){},flip(){}});
// Real glyph/failure/reset/countdown methods, with DOM/audio rendering stubbed.
t.rollGlyphs();advance(57999);assert.equal(white,false);advance(1);assert.equal(white,true);advance(9999);assert.equal(white,true);advance(1);assert.equal(white,false);advance(1320);assert.equal(t.totalSeconds,6480);advance(1000);assert.equal(t.totalSeconds,6479);
// Manual reset during the white hold cancels the pending automatic reset.
t.systemFailure();advance(46000);assert.equal(white,true);t.initialSeconds=240;t.reset();advance(1320);assert.equal(t.totalSeconds,240);advance(11000);assert.equal(t.initialSeconds,240);assert.equal(t.totalSeconds,229);
// Repeated reset owns one animation and starts one countdown.
t.reset();advance(120);t.reset();advance(1320);assert.equal(t.totalSeconds,240);advance(1000);assert.equal(t.totalSeconds,239);
// A later failure can complete the full cycle again.
t.rollGlyphs();advance(69320);assert.equal(white,false);assert.equal(t.totalSeconds,6480);advance(1000);assert.equal(t.totalSeconds,6479);
console.log('PASS: failure timeline, 108-minute restart, cancellation, repeated resets and second cycle');

// Reset must preserve an explicit pause, then resume exactly once.
t.pauseResume();assert.equal(t.paused,true);t.reset();advance(1320);assert.equal(t.totalSeconds,6480);advance(5000);assert.equal(t.totalSeconds,6480);t.pauseResume();advance(1000);assert.equal(t.totalSeconds,6479);console.log('PASS: reset preserves pause and resumes once');
