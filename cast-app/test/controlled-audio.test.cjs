const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=process.env.TIMER_SOURCE || require('node:path').join(__dirname,'../../js/lost-timer.js');
function fixture(){
 let scheduled=[];const audio=[];let now=0;
 const element={currentTime:.45,paused:false,muted:false,readyState:4,addEventListener(){},play(){audio.push(this.currentTime);return Promise.resolve();}};
 function $(s){return Object.assign({0:element,html(){return this},each(){return this},stop(){return this},hide(){return this},show(){return this},css(){return this},removeClass(){return this},addClass(){return this}},{});}
 const ctx={$,window:{},document:{hidden:false,getElementById(){return null;}},Date:{now:()=>now},console,setInterval:fn=>(scheduled.push(fn),scheduled.length),clearInterval(){},setTimeout:fn=>(scheduled.push(fn),scheduled.length),clearTimeout(){}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../../js/lost-timeline.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(source,'utf8'),ctx);const t=Object.create(ctx.lostTimer.prototype);Object.assign(t,{controlled:true,containerClassCss:'.lost-timer',mode:'live',updateNumbers(){},flip(){}});
 return {t,audio,ctx,setTime(x){now=x;},sample(left,extra={}){return {left,cycle:0,paused:false,phase:'countdown',failureAge:0,...extra};}};
}
test('original effect play does not seek or truncate a playing clip',()=>{const f=fixture();f.t.playAudio('tick');assert.deepEqual(f.audio,[.45]);});
test('controlled timer retains original per-second warning schedule, without duplicate sync sounds',()=>{
 const f=fixture(),events=[];f.t.playAudio=key=>events.push([f.t.totalSeconds,key]);f.t.applyClock(f.sample(242),true);
 for(let left=241;left>0;left--){const s=f.sample(left);f.t.applyClock(s);f.t.applyClock(s);}
 const expected=[];
 for(let left=241;left>0;left--){if(left%60===0||left<240)expected.push([left,'tick']);if(left<240&&left%2===0&&left>60)expected.push([left,'beep']);if((left<=60&&left%2===0)||left<10)expected.push([left,'alarm']);}
 assert.deepEqual(events,expected);
 assert.deepEqual(events.filter(x=>x[0]===60),[[60,'tick'],[60,'alarm']]);
 assert.deepEqual(events.filter(x=>x[0]===9),[[9,'tick'],[9,'alarm']]);
});
test('paused snapshots and initial restore never play countdown warnings',()=>{const f=fixture(),events=[];f.t.playAudio=k=>events.push(k);f.t.applyClock(f.sample(60),true);f.t.applyClock(f.sample(59,{paused:true}));assert.deepEqual(events,[]);});
test('failure effects follow the original glyph/spinup/alarm/white sequence once',()=>{
 const f=fixture(),events=[];f.t.playAudio=k=>events.push([f.t.clockLatest.failureAge,k]);f.t.clearClockVisuals=()=>{};f.t.drawClockGlyphs=()=>{};
 f.t.applyClock(f.sample(1),true);
 for(let age=0;age<=60;age++){const s=f.sample(0,{phase:'failure',failureAge:age});f.t.applyClock(s);f.t.applyClock(s);}
 assert.deepEqual(events.filter(x=>x[1]!=='systemfailure'),[[0,'timeout'],[12,'spinup'],[12,'discharge'],[58,'thud']]);
 assert.deepEqual(events.filter(x=>x[1]==='systemfailure').map(x=>x[0]),Array.from({length:35},(_,i)=>i+13));
});
