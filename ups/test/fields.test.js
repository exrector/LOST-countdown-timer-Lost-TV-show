'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {describe,validateVariable}=require('../fields');
const {validatePolicy,DEFAULT_POLICY}=require('../policy');
test('all returned fields remain visible, including unknown vendor and driver fields',()=>{
 const fields=describe({'vendor.unknown':'x','driver.debug':'0','battery.charge':'90'},{'driver.debug':{}});
 assert.equal(fields.length,3);assert.equal(fields.find(f=>f.key==='driver.debug').editable,false);
 assert.equal(fields.find(f=>f.key==='vendor.unknown').value,'x');
});
test('only allowlisted writable variables accept validated values',()=>{
 const s={vars:{'battery.charge.warning':'20'},writable:{'battery.charge.low':{},'input.sensitivity':{enum:['low','normal']},'driver.debug':{}}};
 assert.equal(validateVariable('battery.charge.low','15',s),'15');
 for(const value of ['21','0','15\n','-1','abc','15.1'])assert.throws(()=>validateVariable('battery.charge.low',value,s));
 assert.throws(()=>validateVariable('driver.debug','1',s));
 assert.throws(()=>validateVariable('ups.delay.start','120',s));
 assert.throws(()=>validateVariable('input.sensitivity','high',s));
 assert.equal(validateVariable('input.sensitivity','low',s),'low');
});
test('reported device ranges also restrict changes',()=>{
 const s={vars:{},writable:{'input.transfer.low':{range:[['160','190']]}}};
 assert.equal(validateVariable('input.transfer.low','170',s),'170');
 assert.throws(()=>validateVariable('input.transfer.low','200',s));
});
test('shutdown policy defaults to disabled and rejects malformed values',()=>{
 assert.equal(DEFAULT_POLICY.enabled,false);
 assert.deepEqual(validatePolicy(DEFAULT_POLICY),DEFAULT_POLICY);
 assert.throws(()=>validatePolicy({...DEFAULT_POLICY,enabled:'true'}));
 assert.throws(()=>validatePolicy({...DEFAULT_POLICY,runtimeSeconds:0}));
});
