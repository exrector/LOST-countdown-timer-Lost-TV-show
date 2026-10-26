'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 const listeners=new Map(),commands=[];let document;
 class Element{
  constructor(tag,cls=''){this.tagName=tag;this.className=cls;this.children=[];this.hidden=false;this.disabled=false;this.value='';this.placeholder='';this.maxLength=524288;this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100;this.style={};this.events={};
   this.classList={contains:c=>this.className.split(' ').includes(c),add:c=>{if(!this.classList.contains(c))this.className+=' '+c;},remove:c=>{this.className=this.className.split(' ').filter(x=>x!==c).join(' ');},toggle:(c,on)=>on?this.classList.add(c):this.classList.remove(c)};
  }
  appendChild(e){if(e.parent)e.parent.children=e.parent.children.filter(x=>x!==e);this.children.push(e);e.parent=this;return e;}
  setAttribute(){} addEventListener(k,fn){this.events[k]=fn;} replaceChildren(){this.children=[];} focus(){document.activeElement=this;} scrollBy(_,n){this.scrollTop+=n;}
  querySelector(q){const find=e=>e.children.flatMap(x=>[x,...find(x)]);return find(this).find(e=>q.startsWith('.')?e.classList.contains(q.slice(1)):e.tagName===q)||null;}
 }
 const body=new Element('body','console-page'),surface=body.appendChild(new Element('div','console-container')),prompt=surface.appendChild(new Element('div','console-prompt')),wrap=surface.appendChild(new Element('div','console-input')),input=wrap.appendChild(new Element('input','my-console'));input.disabled=true;
 document={body,activeElement:body,hidden:false,createElement:t=>new Element(t),querySelector:q=>body.querySelector(q),addEventListener(){}};
 function dispatch(e){e.preventDefault=()=>{};e.stopImmediatePropagation=()=>{e.stopped=true;};for(const fn of listeners.get(e.type)||[]){fn(e);if(e.stopped)break;}return true;}
 const win={__LOST_MODULES:{muse:{enabled:true,installed:true,status:'ready'}},addEventListener(k,fn){listeners.set(k,[...(listeners.get(k)||[]),fn]);},dispatchEvent:dispatch};
 win.LostStation={microphone(c){commands.push(c.op);if(c.op==='start')win.LostMuse.setMicrophone({recording:true,finished:false,draftReady:false});if(c.op==='stop')win.LostMuse.setMicrophone({recording:false,finished:true,draftReady:true,elapsed:2});if(c.op==='cancel')win.LostMuse.setMicrophone({recording:false,finished:true,draftReady:false});if(c.op==='send')win.LostMuse.setMicrophone({draftReady:false,uploading:true});}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'client.js'),'utf8'),{window:win,document,CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail;}},AbortController,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},fetch:()=>new Promise(()=>{})});
 win.LostMuse.setMicrophone({available:true,supported:true,recording:false,requesting:false,uploading:false});
 return {win,commands,input,surface,body,key:(type,key,code=key,extra={})=>dispatch({type,key,code,target:input,repeat:false,...extra})};
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
 f.key('keydown','Escape');assert.equal(f.win.LostMuse.isOpen(),false);assert.equal(f.input.disabled,true);assert.equal(f.input.readOnly,false);
});
test('code priority closes AI and discards the draft without sending',()=>{
 const f=fixture();f.win.LostMuse.open();f.key('keydown','Control','ControlLeft');f.key('keyup','Control','ControlLeft');
 f.win.dispatchEvent({type:'lost-muse-code-priority',detail:{active:true}});assert.equal(f.win.LostMuse.isOpen(),false);assert.equal(f.commands.at(-1),'cancel');assert.equal(f.commands.includes('send'),false);
});
