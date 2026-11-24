import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Agents, CloudError} from '../dist/agents.js';

const session={id:'s1',workspace_id:'w1',origin:'api',status:'starting',usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,cost_usd:0},pull_requests:[],created_at:'2026-10-21T00:00:00Z',updated_at:'2026-10-21T00:00:00Z',metadata:{}};

test('the Agents API sends the key, the route and the body, and reads typed answers',async()=>{
 const seen=[];
 const agents=new Agents({controlURL:'https://control.example/',apiKey:'cave_live_x',fetch:async(url,init)=>{
  seen.push({url,method:init.method,auth:init.headers.authorization,redirect:init.redirect,body:init.body&&JSON.parse(init.body)});
  if(url.endsWith('/code/sessions'))return Response.json(session,{status:201});
  if(url.includes('/events?'))return Response.json({events:[{seq:3,type:'agent.message',created_at:'2026-10-21T00:00:00Z',data:{text:'hi'}}]});
  return Response.json({error:{code:'cave_not_found',message:'Session not found.'}},{status:404});
 }});
 assert.equal((await agents.startSession({request_id:'r1',repo:'acme/api',task:'Fix it',agent:{id:'a1',version:2}})).id,'s1');
 assert.deepEqual(seen[0],{url:'https://control.example/api/v1/code/sessions',method:'POST',auth:'Bearer cave_live_x',redirect:'error',body:{request_id:'r1',repo:'acme/api',task:'Fix it',agent:{id:'a1',version:2}}});
 assert.equal((await agents.listEvents('s 1',{after:2})).events[0].seq,3);
 assert.equal(seen[1].url,'https://control.example/api/v1/code/sessions/s%201/events?after=2');
 await assert.rejects(agents.getSession('gone'),error=>error instanceof CloudError&&error.code==='cave_not_found'&&error.status===404);
});

test('a session stream yields each event in order and surfaces a stream error',async()=>{
 const frames=': caveman session events\n\nid: 1\nevent: session.status\ndata: {"status":"running"}\n\nid: 2\nevent: agent.message\ndata: {"text":"Looking."}\n\n: keepalive\n\n';
 const agents=new Agents({controlURL:'http://127.0.0.1:8080',apiKey:'cave_live_x',fetch:async(url,init)=>{
  assert.equal(url,'http://127.0.0.1:8080/api/v1/code/sessions/s1/events/stream?after=0');
  assert.equal(init.headers.accept,'text/event-stream');
  const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frames.slice(0,40)));c.enqueue(new TextEncoder().encode(frames.slice(40)));c.close();}});
  return new Response(body,{headers:{'content-type':'text/event-stream'}});
 }});
 const got=[];
 for await (const e of agents.streamEvents('s1',{after:0}))got.push(e);
 assert.deepEqual(got,[{seq:1,type:'session.status',data:{status:'running'}},{seq:2,type:'agent.message',data:{text:'Looking.'}}]);
 const failing=new Agents({controlURL:'https://control.example',apiKey:'k',fetch:async()=>new Response('event: error\ndata: {"code":"cave_unauthorized"}\n\n')});
 await assert.rejects(async()=>{for await (const _ of failing.streamEvents('s1'));},{code:'cave_unauthorized'});
 assert.throws(()=>new Agents({controlURL:'http://control.example',apiKey:'k'}),{code:'cave_endpoint_invalid'});
});

test('files upload as multipart, download as bytes, and memories read by path',async()=>{
 const file={id:'f1',name:'notes.txt',media_type:'text/plain',size_bytes:5,sha256:'x',purpose:'input',created_at:'2026-10-21T00:00:00Z'};
 const seen=[];
 const agents=new Agents({controlURL:'https://control.example',apiKey:'cave_live_x',fetch:async(url,init)=>{
  seen.push({url,method:init.method});
  if(init.method==='POST'&&url.endsWith('/code/files')){
   assert.ok(init.body instanceof FormData);
   const part=init.body.get('file');
   if(part.name==='big.bin')return Response.json({error:{code:'cave_code_file_too_large',message:'Files are at most 100 MiB.'}},{status:413});
   assert.equal(part.name,'notes.txt');
   assert.equal(part.type,'text/plain');
   assert.equal(await part.text(),'hello');
   return Response.json(file,{status:201});
  }
  if(url.endsWith('/code/files/f%201/content'))return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'application/octet-stream'}});
  if(url.includes('/memories?path='))return Response.json({path:'a/b.md',content:'hi',sha256:'s',size_bytes:2,updated_at:'2026-10-21T00:00:00Z'});
  assert.equal(init.method,'DELETE');
  return new Response(null,{status:204});
 }});
 assert.equal((await agents.uploadFile('notes.txt',new TextEncoder().encode('hello'),{mediaType:'text/plain'})).id,'f1');
 assert.deepEqual(await agents.downloadFile('f 1'),new Uint8Array([1,2,3]));
 assert.equal((await agents.getMemory('m1',{path:'a/b.md'})).content,'hi');
 assert.equal(seen[2].url,'https://control.example/api/v1/code/memory-stores/m1/memories?path=a%2Fb.md');
 await agents.deleteFile('f1');
 await assert.rejects(agents.uploadFile('big.bin',new Blob(['x'])),error=>error instanceof CloudError&&error.code==='cave_code_file_too_large'&&error.status===413);
});
