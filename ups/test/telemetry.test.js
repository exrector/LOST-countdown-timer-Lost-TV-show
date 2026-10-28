const test=require('node:test'),assert=require('node:assert/strict');
const {view}=require('../telemetry');
function state(status='OL',vars={}){return {online:true,updatedAt:100000,vars:{'ups.status':status,'battery.charge':'100','battery.runtime':'3780','input.voltage':'230','output.voltage':'230',...vars}};}
test('mains -> battery -> low battery -> mains changes the same four cells',()=>{
 for(const [status,kind,source] of [['OL','','EXT'],['OB','reserve','RESERVE'],['OB LB','critical','RESERVE'],['OL','','EXT']]){
  const s=view(state(status),100000,100001);assert.equal(s.kind,kind);assert.equal(s.cells[0][1],source);assert.equal(s.cells.length,4);
 }
});
test('low reserve and runtime thresholds only become critical on battery',()=>{
 for(const vars of [{'battery.charge':'14'},{'battery.runtime':'120'}]){
  assert.equal(view(state('OB',vars),100000,100001).kind,'critical');
  assert.equal(view(state('OL',vars),100000,100001).kind,'');
 }
});
test('disconnected agent, stale samples and server errors hide old numbers',()=>{
 for(const [s,response,now] of [[state(),0,100001],[state(),120000,120001],[{...state(),online:false},100000,100001],[{...state(),pollInterval:120000},280000,280001]]){
  const v=view(s,response,now);assert.equal(v.kind,'stale');assert.equal(v.cells[0][1],'LOST');assert.equal(v.cells[1][1],'---');assert.equal(v.cells[2][1],'---');
 }
});
test('missing runtime is unknown; actual zero remains zero and voltage is not invented',()=>{
 assert.equal(view(state('OB',{'battery.runtime':undefined}),100000,100001).cells[2][1],'---');
 assert.equal(view(state('OB',{'battery.runtime':'0','input.voltage':'0'}),100000,100001).cells[2][1],'~000m');
 assert.equal(view(state('OB',{'input.voltage':'0'}),100000,100001).cells[3][1],'0 → 230V');
 assert.equal(view(state(''),100000,100001).cells[0][1],'UNKNOWN');
});
test('agent polled by the 2-minute station cycle: a sample stays fresh for 1.5 intervals, the window may read every 30 s',()=>{
 const s={...state(),pollInterval:120000};
 assert.equal(view(s,250000,279999).kind,'');
 assert.equal(view(s,250000,280001).kind,'stale');
 assert.equal(view({...s,updatedAt:100000},100000,190001).kind,'stale','the window has not heard from the agent for 90 s');
 assert.equal(view({...s,updatedAt:100000},100000,189999).kind,'');
});
