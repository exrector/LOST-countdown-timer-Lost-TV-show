'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const {spawn} = require('node:child_process');
const root = process.env.LOST_REVIEW_ROOT || path.resolve(__dirname, '..');
const WS = require(path.join(root, 'cast-app/node_modules/ws'));

function fixture() {
    const handlers = {}, emitted = [], timers = new Map(); let nextTimer = 1;
    const window = { addEventListener(name, fn) { handlers[name] = fn; }, dispatchEvent(e) { emitted.push(e); } };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'remote/client.js'), 'utf8'), {
        window, document: { body: { classList: { contains: () => true } } },
        CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
        setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }
    });
    function message(data) { handlers.message({data}); }
    message({type:'__remote', remote:{commands:[{id:'pause', label:'ПАУЗА', words:['пауза']}], shortcuts:[]}, senders:1});
    return {window, emitted, timers, message, prepare:value=>window.LostRemote.menu().dir[0].prepare(value),
        request:()=>emitted.filter(e=>e.type==='lost-remote-set').at(-1).detail};
}

test('remote editor waits for its own saved acknowledgement and shows normalized persisted words', () => {
    const f = fixture(), shown = f.prepare(' Стоп, СТОП, Ёлка '), req = f.request();
    assert.equal(shown.text, 'СОХРАНЕНИЕ…'); assert.equal(shown.label, 'СОХРАНЕНИЕ');
    f.message({type:'__remote', remote:{commands:[{id:'pause',label:'ПАУЗА',words:['стоп','елка']}],shortcuts:[]}});
    assert.equal(shown.text, 'СОХРАНЕНИЕ…', 'a broadcast snapshot alone is not the save acknowledgement');
    f.message({type:'__remote_set_result', requestId:'another', id:'pause', ok:true, words:['другое']});
    f.message({type:'__remote_set_result', requestId:req.requestId, id:'resume', ok:true, words:['другое']});
    assert.equal(shown.text, 'СОХРАНЕНИЕ…');
    f.message({type:'__remote_set_result', requestId:req.requestId, id:'pause', ok:true, words:['стоп','елка']});
    assert.equal(shown.label, 'СОХРАНЕНО'); assert.equal(shown.text, 'ПАУЗА: стоп, елка'); assert.equal(f.timers.size, 0);
    f.message({type:'__remote_set_result', requestId:req.requestId, id:'pause', ok:false});
    assert.equal(shown.label, 'СОХРАНЕНО', 'duplicate late acknowledgement does not replace the result');
});

test('rejected saves show an error; blank and oversized values never leave the editor', () => {
    const f = fixture();
    for (const value of ['', ' , , ', 'x'.repeat(2001), 'x'.repeat(61), null]) {
        assert.equal(f.prepare(value).label, 'ОШИБКА');
    }
    assert.equal(f.emitted.filter(e=>e.type==='lost-remote-set').length, 0);
    const shown = f.prepare('отбой'), req = f.request();
    f.message({type:'__remote_set_result',requestId:req.requestId,id:'pause',ok:false,error:'save_failed'});
    assert.equal(shown.label,'ОШИБКА'); assert.match(shown.text,/Прежние слова остаются/);
    assert.deepEqual(Array.from(f.window.LostRemote.state().remote.commands[0].words), ['пауза']);
});

test('timeout and malformed acknowledgements never claim success or retry automatically', () => {
    const f = fixture(), shown = f.prepare('отбой'), req = f.request();
    f.message({type:'__remote_set_result',requestId:'__proto__',ok:false});
    f.message({type:'__remote_set_result',requestId:'constructor',ok:false});
    f.message({type:'__remote_set_result',requestId:req.requestId,id:'pause',ok:true});
    assert.equal(shown.text,'СОХРАНЕНИЕ…');
    const expire = Array.from(f.timers.values())[0]; expire();
    assert.equal(shown.label,'НЕ ПОДТВЕРЖДЕНО'); assert.match(shown.text,/Проверьте слова в меню перед повтором/);
    f.message({type:'__remote_set_result',requestId:req.requestId,id:'pause',ok:true,words:['отбой']});
    assert.equal(shown.label,'НЕ ПОДТВЕРЖДЕНО');
    assert.equal(f.emitted.filter(e=>e.type==='lost-remote-set').length,1);
});

test('overlapping saves remain correlated when acknowledgements arrive out of order', () => {
    const f=fixture(), first=f.prepare('один'), a=f.request(), second=f.prepare('два'), b=f.request();
    assert.notEqual(a.requestId,b.requestId);
    f.message({type:'__remote_set_result',requestId:b.requestId,id:'pause',ok:true,words:['два']});
    f.message({type:'__remote_set_result',requestId:a.requestId,id:'pause',ok:false});
    assert.equal(first.label,'ОШИБКА'); assert.equal(second.text,'ПАУЗА: два');
});

function waitMessage(socket, predicate) {
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{socket.off('message',read);reject(Error('message timeout'));},3000);
        function read(raw){const data=JSON.parse(String(raw));if(predicate(data)){clearTimeout(timer);socket.off('message',read);resolve(data);}}
        socket.on('message',read);
    });
}
async function connect(port,role){
    const socket=new WS('ws://127.0.0.1:'+port+'/bridge?role='+role), initial=role==='console'?waitMessage(socket,d=>d.type==='__remote'):null;
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    if(initial)await initial;return socket;
}

test('real server acknowledges only the originating console; write failure keeps previous words', async t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lost-remote-ack-')), stateFile=path.join(dir,'state.json');
    const child=spawn(process.execPath,['-e',`
        const fs=require('node:fs'),cp=require('node:child_process');
        const file=process.env.REVIEW_STATE, rename=fs.renameSync;let writes=true;
        fs.renameSync=function(from,to){if(to===file&&!writes){const e=Error('fixture write failure');e.code='EACCES';throw e;}return rename.apply(this,arguments);};
        cp.execFile=function(_bin,_args,_options,cb){setImmediate(()=>cb(Error('fixture: no system shortcuts'),''));};
        require(process.env.REVIEW_SERVER).start(0,{host:'127.0.0.1',stateFile:file,audioDevice:false,clockNow:()=>0}).then(core=>{
          process.send({port:core.server.address().port});process.on('message',m=>{writes=m.writes;process.send({writes});});
        }).catch(e=>{console.error(e);process.exit(1);});
    `],{env:{...process.env,REVIEW_STATE:stateFile,REVIEW_SERVER:path.join(root,'cast-app/server.js')},stdio:['ignore','ignore','pipe','ipc']});
    const sockets=[];
    t.after(async()=>{for(const s of sockets)s.terminate();if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});});
    let errors='';child.stderr.on('data',d=>errors+=d);
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('core startup timeout: '+errors)),5000);child.once('error',reject);child.once('message',m=>{clearTimeout(timer);resolve(m.port);});});
    const a=await connect(port,'console'), b=await connect(port,'console'), tv=await connect(port,'tv');sockets.push(a,b,tv);
    const bAcks=[], tvAcks=[];b.on('message',raw=>{const d=JSON.parse(String(raw));if(d.type==='__remote_set_result')bAcks.push(d);});tv.on('message',raw=>{const d=JSON.parse(String(raw));if(d.type==='__remote_set_result')tvAcks.push(d);});
    let ack=waitMessage(a,d=>d.type==='__remote_set_result'&&d.requestId==='success');
    a.send(JSON.stringify({type:'__remote_set',requestId:'success',id:'pause',words:' Стоп, СТОП, Ёлка '}));
    assert.deepEqual(await ack,{type:'__remote_set_result',requestId:'success',id:'pause',ok:true,words:['стоп','елка']});
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).remote.words.pause,['стоп','елка']);
    await new Promise(resolve=>{child.once('message',resolve);child.send({writes:false});});
    const snapshot=waitMessage(a,d=>d.type==='__remote');ack=waitMessage(a,d=>d.type==='__remote_set_result'&&d.requestId==='failure');
    a.send(JSON.stringify({type:'__remote_set',requestId:'failure',id:'pause',words:'замена'}));
    assert.equal((await ack).ok,false);assert.deepEqual((await snapshot).remote.commands.find(c=>c.id==='pause').words,['стоп','елка']);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).remote.words.pause,['стоп','елка']);
    ack=waitMessage(a,d=>d.type==='__remote_set_result'&&d.requestId==='blank');a.send(JSON.stringify({type:'__remote_set',requestId:'blank',id:'pause',words:' , '}));assert.equal((await ack).ok,false);
    const afterTV=waitMessage(a,d=>d.type==='__remote_set_result'&&d.requestId==='barrier');
    tv.send(JSON.stringify({type:'__remote_set',requestId:'tv',id:'pause',words:'запрещено'}));
    a.send(JSON.stringify({type:'__remote_set',requestId:'barrier',id:'pause',words:' , '}));await afterTV;
    assert.deepEqual(bAcks,[]);assert.deepEqual(tvAcks,[]);
});
