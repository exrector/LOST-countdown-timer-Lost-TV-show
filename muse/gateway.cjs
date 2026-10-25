'use strict';
function createMuseGateway({getModule,getChat=()=>({phase:'idle',messages:[],available:false}),sendMessage,port,preview=false}){
 const allowedOrigins=()=>{const p=typeof port==='function'?port():port;return new Set([`http://localhost:${p}`,`http://127.0.0.1:${p}`]);};
 const answer=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 function loopback(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);}
 return function handle(req,res,route){
  if(route!=='/__muse'&&!route.startsWith('/__muse/'))return false;
  const origins=allowedOrigins();
  if(!loopback(req)||(req.headers.origin&&!origins.has(req.headers.origin))){answer(res,403,{error:'forbidden'});return true;}
  if(route==='/__muse/state'&&req.method==='GET'){
   try{answer(res,200,{module:getModule(),chat:getChat(),preview});}catch(_){answer(res,503,{error:'state_unavailable'});}return true;
  }
  if(route!=='/__muse/message'){answer(res,404,{error:'not_found'});return true;}
  if(req.method!=='POST'){answer(res,405,{error:'method_not_allowed'});return true;}
  if(req.headers['x-lost-muse']!=='1'||!origins.has(req.headers.origin)||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){answer(res,403,{error:'invalid_request'});req.resume();return true;}
  const m=getModule();if(!m.enabled||m.status!=='ready'||!sendMessage){answer(res,503,{error:'muse_unavailable'});req.resume();return true;}
  let bytes=0,chunks=[],done=false;const timer=setTimeout(()=>fail(408,'request_timeout'),3000);
  function fail(code,error){if(done)return;done=true;clearTimeout(timer);answer(res,code,{error});req.resume();}
  req.on('data',c=>{if(done)return;bytes+=c.length;if(bytes>16384)return fail(413,'too_large');chunks.push(c);});
  req.on('error',()=>fail(400,'invalid_body'));req.on('aborted',()=>{done=true;clearTimeout(timer);});
  req.on('end',async()=>{
   if(done)return;clearTimeout(timer);let message;
   try{const d=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof d.message!=='string'||!d.message.trim()||d.message.length>4000)throw Error();message=d.message.trim();}catch(_){return fail(400,'invalid_message');}
   done=true;
   try{const result=await sendMessage(message);if(!res.destroyed)answer(res,result?.ok?200:result?.error==='busy'?409:503,result?.ok?{ok:true}:{error:result?.error==='busy'?'busy':'send_failed'});}catch(_){if(!res.destroyed)answer(res,503,{error:'send_failed'});}
  });return true;
 };
}
module.exports={createMuseGateway};
