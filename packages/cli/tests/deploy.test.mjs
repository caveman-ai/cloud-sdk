import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {deploy as deployVerb,failure} from '../bin/deploy.mjs';
import {CloudError} from '../dist/cloud-client.mjs';
import {build,locate,size,summaryLine} from '../bin/agent-build.mjs';
import * as F from './fixtures/connectors.mjs';
import {TEST_CONCURRENCY,limitSpawn,mapPool} from './pool.mjs';
// Where git is: the system directories, or on Windows wherever the runner put it.
const gitPath=process.platform==='win32'?process.env.PATH:'/usr/bin:/bin';

const bin=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const secret='synthetic-deploy-secret-never-print';
const agentId='00000000-0000-4000-8000-0000000000a1',deploymentId='00000000-0000-4000-8000-0000000000d1',sessionId='00000000-0000-4000-8000-0000000000c1';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const notFound=[404,{error:{code:'cave_not_found',message:'Deployment not found.'}}];

// Isolated home with a synthetic credential and an agent folder; the control
// API is a loopback server whose routes each test writes.
async function fixture(t,routes={}){
 const home=await mkdtemp(join(tmpdir(),'cvm-deploy-'));
 await mkdir(join(home,'.caveman'));
 for(const [path,text] of Object.entries({'triage/AGENT.md':'---\nname: triage\ndescription: Triages tickets\n---\nYou triage support tickets.\n','triage/skills/refunds/SKILL.md':'Refund rules.\n'})){
  await mkdir(dirname(join(home,path)),{recursive:true});await writeFile(join(home,path),text);
 }
 const seen=[];
 const server=createServer((req,res)=>{
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',async()=>{
   const request={method:req.method,path:req.url,headers:req.headers,body:body?JSON.parse(body):undefined};seen.push(request);
   const key=`${req.method} ${req.url.split('?')[0]}`;
   const route=routes[key];
   const [status,reply]=route?await route(request,seen):[404,{error:{code:'cave_not_found',message:`No route ${key}.`}}];
   res.writeHead(status,{'content-type':'application/json'});
   res.end(typeof reply==='string'?reply:JSON.stringify(reply));
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
 await writeFile(join(home,'.caveman','cloud.json'),JSON.stringify({baseURL:url,tokenStore:'file'}));
 await writeFile(join(home,'.caveman','credentials'),JSON.stringify({access_token:secret}),{mode:0o600});
 const run=(args,env={})=>limitSpawn(()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[bin,...args],{cwd:home,env:{HOME:home,USERPROFILE:home,CAVEMAN_HOME:join(home,'.caveman'),PATH:gitPath,CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',...env},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  child.on('error',reject);child.on('close',code=>{
   assert.ok(!(stdout+stderr).includes(secret),'must not print the credential');
   resolve({code,stdout,stderr,json:()=>JSON.parse(stdout)});
  });
 }));
 return {home,seen,url,run};
}
const agent=(version,build={})=>({id:agentId,organization_id:'org',name:'triage',version,summary:{name:'triage'},build:{sha256:'f'.repeat(64),bytes:900,files:3,loop:'managed',sandbox:'linux',requires:['skills'],blocked_by:[],...build}});
const deployment=({revision=1,status='live',config={},blocked_by=[],version=1}={})=>({id:deploymentId,organization_id:'org',name:'triage',agent_id:agentId,agent_name:'triage',status,revision,
 live:{deployment_id:deploymentId,revision,agent:{id:agentId,version},config,trigger:'cli',commit_sha:null,branch:null,rolled_back_to:null,build:{sha256:'f'.repeat(64),bytes:900,files:3,loop:'managed',sandbox:'linux',requires:['skills'],blocked_by},created_at:'2026-11-18T10:00:00Z'},
 created_at:'2026-11-18T09:00:00Z',updated_at:'2026-11-18T10:00:00Z',archived_at:null});

describe('deploy', {concurrency: TEST_CONCURRENCY}, () => {

test('deploy: a new agent and a new deployment, printed as agent, version, files, size and digest, then the deployment and the run line',async t=>{
 const f=await fixture(t,{
  'GET /api/v1/code/agents':()=>[200,{agents:[]}],
  'POST /api/v1/code/agents':()=>[201,agent(1)],
  'GET /api/v1/code/deployments/triage':()=>notFound,
  'POST /api/v1/code/deployments':req=>[201,{deployment:deployment({config:req.body.config}),state:'created'}],
 });
 const result=await f.run(['deploy','triage','--repo','acme/support','--budget','2','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.map(r=>`${r.method} ${r.path}`),['GET /api/v1/code/agents','POST /api/v1/code/agents','GET /api/v1/code/deployments/triage','POST /api/v1/code/deployments']);
 for(const r of f.seen)assert.equal(r.headers.authorization,`Bearer ${secret}`);
 const create=f.seen[1].body;
 assert.equal(create.name,'triage');assert.equal(create.version,undefined);
 assert.deepEqual(Object.keys(create.build.files),['agent.json','AGENT.md','skills/refunds/SKILL.md']);
 const manifest=JSON.parse(create.build.files['agent.json']);
 assert.equal(manifest.name,'triage');assert.deepEqual(manifest.skills,[{name:'refunds',path:'skills/refunds/SKILL.md'}]);
 assert.ok(!JSON.stringify(f.seen.map(r=>r.body)).includes(f.home),'no local path is sent');
 assert.deepEqual(f.seen[3].body,{name:'triage',agent:{id:agentId,version:1},config:{repo:'acme/support',budget_usd:2},source:{trigger:'cli'}});
 const lines=result.stdout.split('\n');
 assert.match(lines[0],/^triage {2}v1 {2}3 files, [\d.]+ (B|KB) {2}sha256 [0-9a-f]{12}$/);
 assert.match(lines[1],/^live {4}triage \(revision 1, created\)$/);
 assert.match(lines[2],/^try {5}cvm run triage "…"$/);
 const json=await f.run(['deploy','triage']);
 assert.equal(json.code,0,json.stdout);
 assert.deepEqual({...json.json(),build:undefined},{schema_version:1,ok:true,status:'created',agent:{id:agentId,name:'triage',version:1,stored:'new version'},build:undefined,
  deployment:{id:deploymentId,name:'triage',status:'live',revision:1},config:{},source:{trigger:'cli'},blocked_by:[],next:'cvm run triage "…"'});
});

test('deploy: an existing agent gets the changed build with the version read, and flags replace keys of the live config',async t=>{
 const f=await fixture(t,{
  'GET /api/v1/code/agents':()=>[200,{agents:[{...agent(2),name:'other',id:'x'},agent(2)]}],
  [`POST /api/v1/code/agents/${agentId}`]:()=>[200,agent(3)],
  'GET /api/v1/code/deployments/triage':()=>[200,deployment({revision:2,version:2,config:{repo:'acme/support',model:'auto',budget_usd:2,metadata:{team:'support'}}})],
  'POST /api/v1/code/deployments':req=>[200,{deployment:deployment({revision:3,version:3,config:req.body.config}),state:'updated'}],
 });
 const result=await f.run(['deploy','triage','--model','fast','--base-branch','main','--format','table']);
 assert.equal(result.code,0,result.stdout);
 const update=f.seen[1].body;
 assert.equal(update.version,2);assert.equal(update.name,undefined);assert.ok(update.build.files['agent.json']);
 assert.deepEqual(f.seen[3].body,{name:'triage',agent:{id:agentId,version:3},config:{repo:'acme/support',model:'fast',budget_usd:2,metadata:{team:'support'},base_branch:'main'},source:{trigger:'cli'}});
 assert.match(result.stdout,/^triage {2}v3 /m);assert.match(result.stdout,/^live {4}triage \(revision 3, updated\)$/m);
});

test('deploy: the same build and settings change nothing, and say so',async t=>{
 const f=await fixture(t,{
  'GET /api/v1/code/agents':()=>[200,{agents:[agent(2)]}],
  [`POST /api/v1/code/agents/${agentId}`]:()=>[200,agent(2)],
  'GET /api/v1/code/deployments/triage':()=>[200,deployment({revision:4,version:2,config:{repo:'acme/support'}})],
  'POST /api/v1/code/deployments':()=>[200,{deployment:deployment({revision:4,version:2,config:{repo:'acme/support'}}),state:'unchanged'}],
 });
 const result=await f.run(['deploy','triage','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen[3].body.config,{repo:'acme/support'});
 assert.match(result.stdout,/^triage {2}v2 .*\(build unchanged\)$/m);
 assert.match(result.stdout,/^live {4}triage \(revision 4, unchanged: same build and settings\)$/m);
 const json=await f.run(['deploy','triage']);
 assert.equal(json.json().status,'unchanged');assert.equal(json.json().agent.stored,'unchanged');
});

test('deploy --dry-run builds, prints what it would send, and sends nothing',async t=>{
 const f=await fixture(t);
 const result=await f.run(['deploy','triage','--dry-run','--repo','acme/support','--name','support-triage']);
 assert.equal(result.code,0,result.stdout);
 const out=result.json();
 assert.equal(out.status,'dry_run');assert.equal(out.deployment,'support-triage');assert.deepEqual(out.config,{repo:'acme/support'});assert.deepEqual(out.source,{trigger:'cli'});
 assert.deepEqual(out.would_send.map(s=>`${s.method} ${s.path}`),['GET /api/v1/code/agents','POST /api/v1/code/agents','POST /api/v1/code/agents/{agent id}','GET /api/v1/code/deployments/support-triage','POST /api/v1/code/deployments']);
 const table=await f.run(['deploy','triage','--dry-run','--format','table']);
 assert.match(table.stdout,/^dry run {2}nothing sent\. A deploy would:$/m);
 assert.deepEqual(f.seen,[]);
 await mapPool([['--repo','acme'],['--budget','0'],['--budget','x'],['--name','Bad_Name'],['--model','two words']],async bad=>{
  const refused=await f.run(['deploy','triage',...bad]);assert.equal(refused.code,2,refused.stdout);assert.equal(refused.json().error.code,'cave_usage');
 });
 assert.deepEqual(f.seen,[]);
});

test('deploy: a build this Cloud cannot run yet is stored, and the output says what blocks it',async t=>{
 const f=await fixture(t,{
  'GET /api/v1/code/agents':()=>[200,{agents:[]}],
  'POST /api/v1/code/agents':()=>[201,agent(1,{blocked_by:['skills']})],
  'GET /api/v1/code/deployments/triage':()=>notFound,
  'POST /api/v1/code/deployments':()=>[201,{deployment:deployment({blocked_by:['skills']}),state:'created'}],
 });
 const result=await f.run(['deploy','triage','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.match(result.stdout,/^note {4}The build is stored, but this Caveman Cloud cannot run skills yet: a session through triage is refused until it can\.$/m);
 const json=await f.run(['deploy','triage']);
 assert.deepEqual(json.json().blocked_by,['skills']);assert.match(json.json().warning,/cannot run skills yet/);
});

test('deploy: a server refusal is shown by its code and message; anything else is never echoed',async t=>{
 let reply=[409,{error:{code:'cave_conflict',message:'A deployment is one agent\'s: triage runs another agent.\u001b[31m'}}];
 const f=await fixture(t,{
  'GET /api/v1/code/agents':()=>[200,{agents:[]}],
  'POST /api/v1/code/agents':()=>[201,agent(1)],
  'GET /api/v1/code/deployments/triage':()=>notFound,
  'POST /api/v1/code/deployments':()=>reply,
 });
 let result=await f.run(['deploy','triage']);
 assert.equal(result.code,4,result.stdout);
 assert.deepEqual(result.json().error,{code:'cave_conflict',message:'A deployment is one agent\'s: triage runs another agent.'});
 result=await f.run(['deploy','triage','--format','table']);
 assert.equal(result.stdout,'failed   cave_conflict: A deployment is one agent\'s: triage runs another agent.\n');
 reply=[400,{message:`raw body ${secret}`,code:'cave_conflict'}];
 result=await f.run(['deploy','triage']);
 assert.equal(result.code,2);assert.deepEqual(result.json().error,{code:'cave_request_failed',message:'The deploy failed (HTTP 400).'});
 reply=[502,`<html>${secret}</html>`];
 result=await f.run(['deploy','triage']);
 assert.equal(result.code,1);assert.deepEqual(result.json().error,{code:'cave_request_failed',message:'The deploy failed (HTTP 502).'});
 const signedOut=await f.run(['deploy','triage'],{CAVE_API_URL:'http://127.0.0.1:9'});
 assert.equal(signedOut.code,3);assert.equal(signedOut.json().error.code,'cave_auth_required');
});

const events=list=>list.map(([type,data],i)=>({seq:i+1,type,created_at:'2026-11-18T10:00:00Z',data}));
const started=[201,{id:sessionId,organization_id:'org',status:'starting',stop_reason:null,deployment:{id:deploymentId,revision:3},usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,cost_usd:0}}];

test('run: a session that ends its turn prints the agent\'s messages and tool calls, then status, stop reason and usage; exit 0',async t=>{
 const log=events([['session.status',{status:'running',stop_reason:null}],['user.message',{text:'Where is order 1042?',origin:'api'}],['agent.message',{text:'Looking it up.'}],
  ['agent.tool_use',{id:'t1',name:'lookup_order',input:{id:'1042'}}],['agent.tool_result',{tool_use_id:'t1',is_error:false,output:'shipped'}],['agent.message',{text:'Order 1042 shipped \u001b]8;;https://x\u0007yesterday.'}],
  ['session.usage',{input_tokens:1234,output_tokens:56,cache_read_tokens:0,cost_usd:0.0123}],['session.status',{status:'idle',stop_reason:'end_turn'}]]);
 const f=await fixture(t,{
  'POST /api/v1/code/deployments/triage/sessions':()=>started,
  // Two pages: the reader asks again after the last seq it saw.
  [`GET /api/v1/code/sessions/${sessionId}/events`]:req=>{const after=Number(new URL(req.path,'http://x').searchParams.get('after'));return [200,{events:log.filter(e=>e.seq>after).slice(0,after===0?3:99)}];},
 });
 const result=await f.run(['run','triage','Where','is','order','1042?','--format','table']);
 assert.equal(result.code,0,result.stdout);
 const start=f.seen[0];
 assert.match(start.body.request_id,UUID);assert.equal(start.body.task,'Where is order 1042?');assert.deepEqual(Object.keys(start.body).sort(),['request_id','task']);
 assert.deepEqual(f.seen.slice(1).map(r=>r.path),[`/api/v1/code/sessions/${sessionId}/events?after=0`,`/api/v1/code/sessions/${sessionId}/events?after=3`]);
 assert.equal(result.stdout,[`session  ${sessionId}  triage, revision 3`,'Looking it up.','tool     lookup_order','Order 1042 shipped yesterday.','idle  end_turn  1,234 tokens in, 56 out, $0.0123',''].join('\n'));
 const json=await f.run(['run','triage','Where is order 1042?']);
 assert.equal(json.code,0,json.stdout);
 assert.deepEqual(json.json(),{schema_version:1,ok:true,status:'idle',stop_reason:'end_turn',session_id:sessionId,deployment:{id:deploymentId,revision:3},
  messages:['Looking it up.','Order 1042 shipped \u001b]8;;https://x\u0007yesterday.'],tool_calls:['lookup_order'],errors:[],ask:null,usage:{input_tokens:1234,output_tokens:56,cache_read_tokens:0,cost_usd:0.0123}});
 assert.ok(!json.stdout.includes('\u001b'),'JSON output escapes terminal controls');
});

test('run: an error stop exits 1 with the error shown',async t=>{
 const f=await fixture(t,{
  'POST /api/v1/code/deployments/triage/sessions':()=>started,
  [`GET /api/v1/code/sessions/${sessionId}/events`]:()=>[200,{events:events([['session.status',{status:'running',stop_reason:null}],['session.error',{code:'model_unavailable',message:'The model did not answer.'}],['session.status',{status:'idle',stop_reason:'error'}]])}],
 });
 const result=await f.run(['run','triage','Do it','--format','table']);
 assert.equal(result.code,1,result.stdout);
 assert.match(result.stdout,/^error {4}model_unavailable: The model did not answer\.$/m);
 assert.match(result.stdout,/^idle {2}error {2}no usage reported$/m);
 const json=await f.run(['run','triage','Do it']);
 assert.equal(json.code,1);assert.equal(json.json().ok,false);assert.equal(json.json().stop_reason,'error');
});

test('run --no-follow prints the session and returns without reading events',async t=>{
 const f=await fixture(t,{'POST /api/v1/code/deployments/triage/sessions':()=>started});
 const result=await f.run(['run','triage','Do it','--no-follow']);
 assert.equal(result.code,0,result.stdout);
 assert.equal(result.json().id,sessionId);assert.equal(f.seen.length,1);
 const table=await f.run(['run','triage','Do it','--no-follow','--format','table']);
 assert.match(table.stdout,new RegExp(`^follow {3}cvm run --session ${sessionId}$`,'m'));
});

test('run --subject sends who the session is for, one folder name a value; a malformed one is refused before anything is sent',async t=>{
 const f=await fixture(t,{'POST /api/v1/code/deployments/triage/sessions':()=>started});
 const result=await f.run(['run','triage','Where is order 1042?','--subject','customer=acme-42','--subject','region=eu_west','--no-follow']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual({...f.seen[0].body,request_id:undefined},{request_id:undefined,task:'Where is order 1042?',subject:{customer:'acme-42',region:'eu_west'}});
 const none=await f.run(['run','triage','Do it','--no-follow']);
 assert.equal(none.code,0);assert.ok(!('subject' in f.seen[1].body),'no --subject sends no subject');
 await Promise.all([
  mapPool([
   [['--subject','customer'],/^--subject is NAME=VALUE/],
   [['--subject','Customer=acme'],/^--subject is NAME=VALUE/],
   [['--subject','customer=a/b'],/^--subject customer= is one folder name/],
   [['--subject','customer=..'],/^--subject customer= is one folder name/],
   [['--subject','customer='],/^--subject customer= is one folder name/],
   [['--subject',`customer=${'x'.repeat(129)}`],/^--subject customer= is one folder name/],
   [['--subject','customer=a','--subject','customer=b'],/^--subject names customer twice\.$/],
   [Array.from({length:17},(_,i)=>['--subject',`k${i}=v`]).flat(),/^--subject is given at most 16 times\.$/],
  ],async([args,pattern])=>{
   const refused=await f.run(['run','triage','Do it',...args]);
   assert.equal(refused.code,2,refused.stdout);
   assert.equal(refused.json().error.code,'cave_usage');assert.match(refused.json().error.message,pattern);
  }),
  (async()=>{
   const follow=await f.run(['run','--session',sessionId,'--subject','customer=a']);
   assert.equal(follow.code,2);assert.match(follow.json().error.message,/takes no deployment, task, --subject or --no-follow/);
  })(),
 ]);
 assert.equal(f.seen.length,2,'a refused --subject sends nothing');
});

test('run: a paused deployment\'s refusal is shown by code and message, exit 4',async t=>{
 const f=await fixture(t,{'POST /api/v1/code/deployments/triage/sessions':()=>[409,{error:{code:'cave_code_deployment_paused',message:'The deployment triage is paused: resume it to start sessions.'}}]});
 const result=await f.run(['run','triage','Do it']);
 assert.equal(result.code,4,result.stdout);
 assert.deepEqual(result.json().error,{code:'cave_code_deployment_paused',message:'The deployment triage is paused: resume it to start sessions.'});
 assert.equal(f.seen.length,1);
});

test('run: a quiet session ends the wait (not the session) with the command to watch it again; --session follows it',async t=>{
 let log=[];
 const f=await fixture(t,{
  'POST /api/v1/code/deployments/triage/sessions':()=>started,
  [`GET /api/v1/code/sessions/${sessionId}/events`]:()=>[200,{events:log}],
  [`GET /api/v1/code/sessions/${sessionId}`]:()=>[200,{...started[1],status:'running'}],
 });
 const result=await f.run(['run','triage','Do it','--timeout','1']);
 assert.equal(result.code,6,result.stdout);
 assert.deepEqual(result.json().error,{code:'cave_wait_timeout',message:`Session ${sessionId} has sent no events for 1 seconds; it may still be running. Watch it again with: cvm run --session ${sessionId}`});
 log=events([['session.status',{status:'requires_action',stop_reason:'requires_action'}],['requires_action',{ask_id:'a1',kind:'tool',name:'approve_refund'}]]);
 const again=await f.run(['run','--session',sessionId,'--format','table']);
 assert.equal(again.code,6,again.stdout);
 assert.match(again.stdout,/^waits {4}tool approve_refund: cvm cannot answer it$/m);
 await mapPool([['run'],['run','triage'],['run','Bad/Name','x'],['run','--session','nope'],['run','--session',sessionId,'triage'],['run','triage','x','--timeout','0']],async bad=>{
  const refused=await f.run(bad);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);
 });
});

test('deployments: each command calls its route with its body; archive needs --yes',async t=>{
 const f=await fixture(t,{
  'GET /api/v1/code/deployments':()=>[200,{deployments:[deployment({revision:3,config:{repo:'acme/support'}})]}],
  'GET /api/v1/code/deployments/triage':()=>[200,deployment({revision:3})],
  'GET /api/v1/code/deployments/triage/revisions':()=>[200,{revisions:[{...deployment().live,revision:2,trigger:'rollback',rolled_back_to:1},{...deployment().live,revision:1,commit_sha:'0123456789abcdef0123456789abcdef01234567',branch:'main'}]}],
  'POST /api/v1/code/deployments/triage/rollback':req=>[200,deployment({revision:4})],
  'POST /api/v1/code/deployments/triage/pause':()=>[200,deployment({status:'paused'})],
  'POST /api/v1/code/deployments/triage/resume':()=>[200,deployment()],
  [`POST /api/v1/code/deployments/${deploymentId}/archive`]:()=>[200,{...deployment(),archived_at:'2026-11-18T11:00:00Z'}],
 });
 for(const [args,method,path,body] of [
  [[],'GET','/api/v1/code/deployments',undefined],
  [['list','--archived'],'GET','/api/v1/code/deployments?archived=true',undefined],
  [['get','triage'],'GET','/api/v1/code/deployments/triage',undefined],
  [['revisions','triage'],'GET','/api/v1/code/deployments/triage/revisions',undefined],
  [['rollback','triage','2'],'POST','/api/v1/code/deployments/triage/rollback',{revision:2}],
  [['pause','triage'],'POST','/api/v1/code/deployments/triage/pause',{}],
  [['resume','triage'],'POST','/api/v1/code/deployments/triage/resume',{}],
  [['archive',deploymentId,'--yes'],'POST',`/api/v1/code/deployments/${deploymentId}/archive`,{}],
 ]){
  const result=await f.run(['deployments',...args]);
  assert.equal(result.code,0,`${args.join(' ')}: ${result.stdout}`);
  const req=f.seen.at(-1);
  assert.deepEqual([req.method,req.path,req.body],[method,path,body]);
  JSON.parse(result.stdout);
 }
 const count=f.seen.length;
 const unconfirmed=await f.run(['deployments','archive','triage']);
 assert.equal(unconfirmed.code,2);assert.equal(unconfirmed.json().error.code,'cave_confirmation_required');
 await mapPool([['get'],['get','Bad_Name'],['rollback','triage','0'],['rollback','triage','two'],['pause','triage','--yes'],['get','triage','--archived'],['remove','triage'],['list','extra']],async bad=>{
  const refused=await f.run(['deployments',...bad]);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);
 });
 assert.equal(f.seen.length,count,'nothing is sent for a refused command');
 const list=await f.run(['deployments','--format','table']);
 assert.match(list.stdout,/^NAME {4}STATUS {2}REVISION {2}AGENT {6}UPDATED$/m);
 assert.match(list.stdout,/^triage {2}live {4}3 {9}triage v1 {2}2026-11-18T10:00:00Z$/m);
 const revisions=await f.run(['deployments','revisions','triage','--format','table']);
 assert.match(revisions.stdout,/^REVISION {2}TRIGGER {8}SOURCE {8}AGENT VERSION/m);
 assert.match(revisions.stdout,/^2 {9}rollback to 1 {2}- {13}v1/m);
 assert.match(revisions.stdout,/^1 {9}cli {12}0123456 main {2}v1/m);
 const one=await f.run(['deployments','pause','triage','--format','table']);
 assert.match(one.stdout,/^triage {4}paused, revision 1$/m);
 assert.match(one.stdout,/^since {5}2026-11-18T10:00:00Z  cli$/m);
});

// A checkout made with a scratch HOME, so no user git config is read.
const gitIn=(dir,home,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-C',dir,...args],{env:{HOME:home,USERPROFILE:home,PATH:gitPath,GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();

test('deploy: the source is always the CLI, plus the commit and branch of the checkout the agent is in, and nothing else of the repository',async t=>{
 const f=await fixture(t,{
  'GET /api/v1/code/agents':()=>[200,{agents:[agent(1)]}],
  [`POST /api/v1/code/agents/${agentId}`]:()=>[200,agent(1)],
  'GET /api/v1/code/deployments/triage':()=>[200,deployment()],
  'POST /api/v1/code/deployments':req=>[200,{deployment:{...deployment(),live:{...deployment().live,...req.body.source}},state:'unchanged'}],
 });
 const dir=join(f.home,'triage');
 gitIn(dir,f.home,'init','--quiet','-b','agents');gitIn(dir,f.home,'add','.');gitIn(dir,f.home,'commit','--quiet','-m','agent');
 const sha=gitIn(dir,f.home,'rev-parse','HEAD');
 gitIn(dir,f.home,'remote','add','origin','https://example.invalid/acme/private-repo.git');
 let result=await f.run(['deploy','triage','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.at(-1).body.source,{trigger:'cli',commit_sha:sha,branch:'agents'});
 assert.match(result.stdout,new RegExp(`^from {4}${sha.slice(0,7)} agents$`,'m'));
 const sent=JSON.stringify(f.seen.map(r=>r.body));
 for(const word of ['example.invalid','private-repo','Test',f.home])assert.ok(!sent.includes(word),`sends nothing else of the repository: ${word}`);
 const dry=await f.run(['deploy','triage','--dry-run']);
 assert.deepEqual(dry.json().source,{trigger:'cli',commit_sha:sha,branch:'agents'});
 assert.deepEqual(dry.json().would_send.at(-1).body.source,{trigger:'cli',commit_sha:sha,branch:'agents'});
 const dryTable=await f.run(['deploy','triage','--dry-run','--format','table']);
 assert.match(dryTable.stdout,new RegExp(`^  source    cli ${sha.slice(0,7)} agents$`,'m'));
 // A detached HEAD sends the commit and no branch.
 gitIn(dir,f.home,'checkout','--quiet','--detach');
 result=await f.run(['deploy','triage']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.at(-1).body.source,{trigger:'cli',commit_sha:sha});
 // No git on PATH: the CLI alone, and not an error.
 result=await f.run(['deploy','triage'],{PATH:'/nonexistent'});
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.at(-1).body.source,{trigger:'cli'});
});

test('deploy: a create refused because an archived agent holds the name says so; another conflict stays the server\'s',async t=>{
 let archived=[{...agent(4),archived_at:'2026-11-01T00:00:00Z'}];
 const f=await fixture(t,{
  'GET /api/v1/code/agents':req=>[200,{agents:req.path.includes('archived=true')?archived:[]}],
  'POST /api/v1/code/agents':()=>[409,{error:{code:'cave_conflict',message:'An agent of that name already exists: update it instead.'}}],
 });
 let result=await f.run(['deploy','triage']);
 assert.equal(result.code,4,result.stdout);
 assert.deepEqual(result.json().error,{code:'cave_code_agent_archived',message:'The agent triage is archived, so its name is taken. Deploy under another agent name: set name in AGENT.md\'s frontmatter.'});
 assert.deepEqual(f.seen.map(r=>`${r.method} ${r.path}`),['GET /api/v1/code/agents','POST /api/v1/code/agents','GET /api/v1/code/agents?archived=true']);
 archived=[];
 result=await f.run(['deploy','triage']);
 assert.equal(result.code,4);assert.deepEqual(result.json().error,{code:'cave_conflict',message:'An agent of that name already exists: update it instead.'});
});

test('help for each verb answers without a sign-in or a request',async t=>{
 const f=await fixture(t);
 const [,top,screen]=await Promise.all([
  Promise.all(['deploy','run','deployments'].map(async verb=>{
   const result=await f.run([verb,'--help']);
   assert.equal(result.code,0,result.stdout);assert.match(result.json().usage,new RegExp(`^cvm ${verb} `));
  })),
  f.run(['--help','--format','json']),
  f.run(['--help','--format','table']),
 ]);
 assert.equal(top.json().deploy,'cvm agent init ask [DIR] | cvm agent build [PATH] | cvm deploy [PATH] | cvm run NAME "TASK" | cvm deployments');
 assert.match(screen.stdout,/\nDeploy\n  cvm agent init ask \[DIR\] +Ask Caveman: an agent that answers from your data\n  cvm agent build \[PATH\] +an agent folder to its build: files, size, digest\n  cvm deploy \[PATH\] +store the build and make it live under a name\n  cvm run NAME "TASK" +a session through a deployment, followed\n  cvm deployments +list, roll back, pause, resume or archive\n\nFamilies\n/);
 assert.deepEqual(f.seen,[]);
});

// ---- a build that names connectors ----------------------------------------------
test('deploy: a build that names no connectors sends no plan request and prints, byte for byte, what it printed before connectors',async t=>{
 // Recorded on the commit before connectors (486fe276b) with this file's fixture.
 const recording=JSON.parse(await readFile(new URL('./fixtures/deploy-before-connectors.json',import.meta.url),'utf8'));
 const f=await fixture(t,{
  'GET /api/v1/code/agents':()=>[200,{agents:[]}],
  'POST /api/v1/code/agents':()=>[201,agent(1)],
  'GET /api/v1/code/deployments/triage':()=>notFound,
  'POST /api/v1/code/deployments':req=>[201,{deployment:deployment({config:req.body.config}),state:'created'}],
 });
 const b=build(locate(join(f.home,'triage')));
 // The build is the one recorded: the same bytes once the version cvm stamps in built_by is the one it had.
 const at000=b.agentJSON.replace(`"version": ${JSON.stringify(b.manifest.built_by.version)}`,'"version": "0.0.0"');
 assert.equal(createHash('sha256').update(at000).digest('hex'),recording['build_at_cvm_0.0.0'].digest);
 const fill=text=>text.replaceAll('{digest12}',b.digest.slice(0,12)).replaceAll('{digest}',b.digest).replaceAll('{size}',size(b.bytes)).replaceAll('{bytes}',String(b.bytes)).replaceAll('{agent.json bytes}',String(Buffer.byteLength(b.agentJSON)));
 for(const [name,args] of [['created_table',['deploy','triage','--repo','acme/support','--format','table']],['created_json',['deploy','triage','--repo','acme/support','--format','json']],['dry_table',['deploy','triage','--dry-run','--format','table']],['dry_json',['deploy','triage','--dry-run','--format','json']]]){
  const want=recording.cases[name],before=f.seen.length;
  const result=await f.run(args);
  assert.equal(result.code,want.code,name);
  assert.equal(result.stdout,fill(want.stdout),name);
  const sent=f.seen.slice(before).map(r=>({method:r.method,path:r.path,...(r.body?{body:r.body}:{})}));
  assert.deepEqual(sent,JSON.parse(fill(JSON.stringify(want.requests)).replace('"{agent.json}"',()=>JSON.stringify(b.agentJSON))),name);
 }
 assert.ok(!f.seen.some(r=>r.path.includes('/plan')),'no plan request');
});

// The triage agent naming SPEC 6.1's connectors, in its own folder.
const linked='---\nname: triage\nconnectors:\n  linear: {tools: [list_issues, get_issue, create_comment]}\n  stripe: {tools: [get_charge, create_refund]}\n  notion: {}\nbudgets: {tools: 6000}\n---\nYou triage support tickets.\n';
const wants={name:'triage',connectors:{linear:{tools:['list_issues','get_issue','create_comment']},stripe:{tools:['get_charge','create_refund']},notion:{}},budgets:{tools:6000}};
async function linkedFixture(t,routes){
 const f=await fixture(t,routes);
 await mkdir(join(f.home,'linked'));await writeFile(join(f.home,'linked','AGENT.md'),linked);
 return {...f,b:build(locate(join(f.home,'linked')))};
}
const deployRoutes=(answer,more={})=>({
 'POST /api/v1/code/deployments/plan':()=>[200,F.plan63],
 'GET /api/v1/code/agents':()=>[200,{agents:[agent(4)]}],
 [`POST /api/v1/code/agents/${agentId}`]:()=>[200,agent(5)],
 'GET /api/v1/code/deployments/triage':()=>[200,deployment({revision:4,version:4})],
 'POST /api/v1/code/deployments':()=>answer??[200,{deployment:deployment({revision:5,version:5}),state:'updated',plan:F.plan63}],
 ...more,
});
// cvm deploy in this process, with the terminal, the answers typed, the
// browser and the clock the test holds (cvm connect's own seams).
async function inProcess(f,args,{terminal=false,answers=[]}={}){
 const out=[],asked=[],opened=[];let clock=0;
 const code=await deployVerb([join(f.home,'linked'),...args],{context:async()=>({baseURL:f.url,token:secret}),out:s=>{out.push(s);},err:s=>{out.push(s);},terminal:()=>terminal,
  ask:async(prompt,write)=>{write(prompt);asked.push(prompt.trim());const answer=answers.length?answers.shift():null;write(`${answer??''}\n`);return answer;},
  open:address=>opened.push(address),env:{},sleep:async ms=>{clock+=ms;},now:()=>clock,interrupt:()=>()=>{}});
 const stdout=out.join('');
 assert.ok(!stdout.includes(secret));
 return {code,stdout,asked,opened,json:()=>JSON.parse(stdout)};
}
const planLines=[
 'connects  linear   shared (Caveman Bot, an app, not a person)   3 tools   read, write',
 '        + stripe   shared (Dana)                                2 tools   read, external',
 '        + notion   shared (Lee), reads only                     4 tools   read',
 'grants    + triage may use stripe and notion   you manage both   granted',
 '          triage may use linear   covered by its grant',
 'tools     12 tools, about 800 tokens   budget 6,000   ok',
 'checks    linear changed upstream: 1 tool. This deploy uses the list accepted on 2026-11-12.',
 '            see it: cvm connect diff linear',
 '          notion\'s shared sign-in is Lee\'s own, marked read only.',
 '            fix: cvm connect allow-writes notion',
];

test('deploy with connectors: the plan first, then the build and deploy as today, the plan printed between the build and what went live (SPEC 6.3)',async t=>{
 const f=await linkedFixture(t,deployRoutes());
 const result=await f.run(['deploy','linked','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.map(r=>`${r.method} ${r.path}`),['POST /api/v1/code/deployments/plan','GET /api/v1/code/agents',`POST /api/v1/code/agents/${agentId}`,'GET /api/v1/code/deployments/triage','POST /api/v1/code/deployments']);
 assert.deepEqual(f.seen[0].body,wants);
 assert.deepEqual(JSON.parse(f.seen[2].body.build.files['agent.json']).connectors,wants.connectors);
 assert.deepEqual(f.seen[4].body,{name:'triage',agent:{id:agentId,version:5},config:{},source:{trigger:'cli'}},'the deploy request is today\'s');
 assert.equal(result.stdout,[`triage    v5  ${summaryLine(f.b)}`,...planLines,'live      triage (revision 5, updated)','try       cvm run triage "…"',''].join('\n'));
 assert.match(summaryLine(f.b),/, 3 connectors {2}sha256 /);
 const json=await f.run(['deploy','linked']);
 assert.equal(json.code,0,json.stdout);
 const out=json.json();
 assert.deepEqual(out.plan,F.plan63);
 assert.deepEqual({...out,plan:undefined,build:undefined},{schema_version:1,ok:true,status:'updated',agent:{id:agentId,name:'triage',version:5,stored:'new version'},build:undefined,
  deployment:{id:deploymentId,name:'triage',status:'live',revision:5},config:{},source:{trigger:'cli'},blocked_by:[],next:'cvm run triage "…"',plan:undefined});
});

test('deploy with connectors --dry-run sends nothing; its steps start with the plan request',async t=>{
 const f=await linkedFixture(t);
 const dry=await f.run(['deploy','linked','--dry-run']);
 assert.equal(dry.code,0,dry.stdout);
 const steps=dry.json().would_send;
 assert.deepEqual(steps.map(s=>`${s.method} ${s.path}`),['POST /api/v1/code/deployments/plan','GET /api/v1/code/agents','POST /api/v1/code/agents','POST /api/v1/code/agents/{agent id}','GET /api/v1/code/deployments/triage','POST /api/v1/code/deployments']);
 assert.deepEqual(steps[0].body,wants);
 const table=await f.run(['deploy','linked','--dry-run','--format','table']);
 assert.match(table.stdout,/^triage {3}2 files, [\d.]+ (B|KB), 3 connectors {2}sha256 [0-9a-f]{12}\ndry run  nothing sent\. A deploy would:\n {2}1\. ask for the plan: whether each connector triage names is there and signed in, what this deploy grants or asks for, and what the tools cost \(it changes nothing\) \(POST \/api\/v1\/code\/deployments\/plan\)\n {2}2\. find the agent named triage/);
 assert.deepEqual(f.seen,[]);
});

// ---- drives -------------------------------------------------------------------
const mounted='---\nname: triage\ndrives:\n  /kb:     support-kb\n  /memory: { drive: triage-memory, write: true }\n  /work:   { drive: customers, folder: "{customer}", write: true }\n---\nYou triage support tickets.\n';
const drivesWanted={'/kb':'support-kb','/memory':{drive:'triage-memory',write:true},'/work':{drive:'customers',folder:'{customer}',write:true}};
const mount=(m,drive,folder,access,more={})=>({mount:m,drive,folder,access,new_drive:false,widens:false,review:false,trusted:false,description:'',placeholders:[],...more});
// The plan of SPEC 3.2: a drives-only build has no connectors and no card.
const drivesPlan={connectors:[],tools:0,tokens:0,budget:6000,fits:true,checks:[],card:'',drives:[
 mount('/kb','support-kb','','read'),
 mount('/memory','triage-memory','','read, write',{new_drive:true,widens:true}),
 mount('/work','customers','{customer}','read, write',{widens:true,placeholders:['customer']}),
]};
async function mountedFixture(t,routes){
 const f=await fixture(t,routes);
 await mkdir(join(f.home,'mounted'));await writeFile(join(f.home,'mounted','AGENT.md'),mounted);
 return {...f,b:build(locate(join(f.home,'mounted')))};
}

test('deploy with drives: the plan first, with one row a mount as SPEC 3.2 draws it: + where it widens, the drive and folder, the access, new drive and one folder per customer',async t=>{
 const f=await mountedFixture(t,deployRoutes([200,{deployment:deployment({revision:5,version:5}),state:'updated',plan:drivesPlan}],{'POST /api/v1/code/deployments/plan':()=>[200,drivesPlan]}));
 const result=await f.run(['deploy','mounted','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.map(r=>`${r.method} ${r.path}`),['POST /api/v1/code/deployments/plan','GET /api/v1/code/agents',`POST /api/v1/code/agents/${agentId}`,'GET /api/v1/code/deployments/triage','POST /api/v1/code/deployments']);
 assert.deepEqual(f.seen[0].body,{name:'triage',drives:drivesWanted},'the plan request sends the build\'s drives as agent.json holds them');
 assert.deepEqual(JSON.parse(f.seen[2].body.build.files['agent.json']).drives,drivesWanted);
 assert.equal(result.stdout,[
  `triage  v5  ${summaryLine(f.b)}`,
  'drives  /kb       support-kb             read',
  '      + /memory   triage-memory          read, write   new drive',
  '      + /work     customers/{customer}   read, write   one folder per customer',
  'live    triage (revision 5, updated)',
  'try     cvm run triage "…"',
  ''].join('\n'));
 assert.match(summaryLine(f.b),/, 3 drive mounts {2}sha256 /);
 const json=await f.run(['deploy','mounted']);
 assert.equal(json.code,0,json.stdout);
 assert.deepEqual(json.json().plan,drivesPlan);
});

test('deploy with drives: review and trusted say so; a deployer without a right is refused by the server\'s own sentence, and nothing is stored',async t=>{
 const plan={...drivesPlan,drives:[mount('/kb','support-kb','/handbook','read',{trusted:true}),mount('/work','customers','accounts/{region}/{customer}','read, write',{review:true,placeholders:['region','customer']})]};
 const f=await mountedFixture(t,deployRoutes([200,{deployment:deployment({revision:5,version:5}),state:'updated',plan}],{'POST /api/v1/code/deployments/plan':()=>[200,plan]}));
 const result=await f.run(['deploy','mounted','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.match(result.stdout,/\ndrives {2}\/kb {5}support-kb\/handbook {22}read {10}trusted content only\n {8}\/work {3}customers\/accounts\/\{region\}\/\{customer\} {3}read, write {3}one folder per region, one folder per customer, held for review\nlive /);
 const refusal=[403,{error:{code:'cave_code_drive_grant_needed',message:'You cannot grant write on customers. A person can run: cvm drive grant customers --to triage-bot --write'}}];
 const g=await mountedFixture(t,deployRoutes(undefined,{'POST /api/v1/code/deployments/plan':()=>refusal}));
 const refused=await g.run(['deploy','mounted','--format','table']);
 assert.notEqual(refused.code,0);
 assert.equal(refused.stdout,'failed   cave_code_drive_grant_needed: You cannot grant write on customers. A person can run: cvm drive grant customers --to triage-bot --write\n');
 assert.deepEqual(g.seen.map(q=>q.path),['/api/v1/code/deployments/plan'],'nothing stored, nothing deployed');
});

test('deploy with drives --dry-run sends nothing; its steps start with the plan request, which carries the drives',async t=>{
 const f=await mountedFixture(t);
 const dry=await f.run(['deploy','mounted','--dry-run']);
 assert.equal(dry.code,0,dry.stdout);
 const steps=dry.json().would_send;
 assert.equal(steps[0].path,'/api/v1/code/deployments/plan');
 assert.deepEqual(steps[0].body,{name:'triage',drives:drivesWanted});
 assert.match(steps[0].why,/^ask for the plan: each drive triage mounts, with the access it asks for and the drives the deploy would create \(it changes nothing\)$/);
 assert.deepEqual(f.seen,[]);
});

test('deploy held: the deploy waits for the connectors\' managers; it says who was asked and exits 0, and JSON says held',async t=>{
 const asked={id:F.ids.hold,asked:[{connector:'stripe',people:[{user_id:F.ids.dana,name:'Dana'},{user_id:F.ids.lee,name:'Lee'}]}]};
 const f=await linkedFixture(t,deployRoutes([202,{state:'held',deployment:null,plan:F.planAsks,hold:asked}],{'POST /api/v1/code/deployments/plan':()=>[200,F.planAsks]}));
 const result=await f.run(['deploy','linked','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.equal(result.stdout,[
  `triage    v5  ${summaryLine(f.b)}`,
  'connects+ stripe   shared (Dana)   2 tools   read, external',
  'grants    triage asks to use stripe   Dana and Lee will be asked',
  'tools     2 tools, about 210 tokens   budget 6,000   ok',
  'held      triage: nothing goes live until the managers asked answer.',
  'asked     stripe: Dana and Lee',
  'see       cvm connect requests',
  ''].join('\n'));
 const json=await f.run(['deploy','linked']);
 assert.equal(json.code,0);
 assert.deepEqual(json.json(),{schema_version:1,ok:true,status:'held',agent:{id:agentId,name:'triage',version:5,stored:'new version'},build:{sha256:f.b.digest,file_count:f.b.count,bytes:f.b.bytes},
  deployment:null,hold:asked,config:{},source:{trigger:'cli'},plan:F.planAsks,next:'cvm connect requests'});
 // A deployment that exists stays as it is, and is named.
 const g=await linkedFixture(t,deployRoutes([202,{state:'held',deployment:deployment({revision:4,version:4}),plan:F.planAsks,hold:asked}]));
 const existing=await g.run(['deploy','linked']);
 assert.deepEqual(existing.json().deployment,{id:deploymentId,name:'triage',status:'live',revision:4});
});

const notConnected=F.refusal(409,'cave_code_connector_not_connected','linear has no shared sign-in.',{connector:'linear',fix:'cvm connect add linear'});
test('deploy: a connector not signed in, at a terminal: the connects line, Connect it now?, cvm connect add\'s sign-in, then the plan again and the deploy',async t=>{
 let plans=0,gets=0;
 const f=await linkedFixture(t,deployRoutes(undefined,{
  'POST /api/v1/code/deployments/plan':()=>++plans===1?notConnected:[200,F.plan63],
  // Before the start a sign-in that needs doing again, then pending, then completed.
  'GET /api/v1/code/connectors/linear':()=>{const n=gets++;return [200,{connector:F.connector({connection:F.connection(n===0?{status:'needs_reconnect',signed_in_at:'2026-11-12T09:00:00Z'}:n===1?{status:'pending',signed_in_at:'2026-11-12T09:00:00Z'}:{updated_at:'2026-11-19T10:09:00Z',signed_in_at:'2026-11-19T10:09:00Z'})})}];},
  'POST /api/v1/code/connectors/linear/connect':()=>[200,{authorize_url:F.authorize}],
  'POST /api/v1/code/connectors/linear/read':()=>[200,F.readSame],
 }));
 const r=await inProcess(f,['--format','table'],{terminal:true,answers:['y']});
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(f.seen.map(q=>`${q.method} ${q.path}`),['POST /api/v1/code/deployments/plan','GET /api/v1/code/connectors/linear','POST /api/v1/code/connectors/linear/connect','GET /api/v1/code/connectors/linear','GET /api/v1/code/connectors/linear','POST /api/v1/code/connectors/linear/read','POST /api/v1/code/deployments/plan','GET /api/v1/code/agents',`POST /api/v1/code/agents/${agentId}`,'GET /api/v1/code/deployments/triage','POST /api/v1/code/deployments']);
 assert.deepEqual(r.asked,['Connect it now? Opens your browser.  [Y/n]']);
 assert.deepEqual(r.opened,[F.authorize]);
 assert.equal(r.stdout,[
  'connects  linear   not connected',
  '          Connect it now? Opens your browser.  [Y/n] y',
  'connect   linear exists: signing it in again.',
  `sign in   ${F.authorize}`,
  'waiting   your browser is open: sign in to linear. cvm waits at most 5 minutes; Ctrl-C stops waiting, and the sign-in stays open.',
  '          ✓ linear   signed in as "Dana" (a person)',
  'tools     linear: no change since 2026-11-12, 23 tools accepted.',
  `triage    v5  ${summaryLine(f.b)}`,...planLines,'live      triage (revision 5, updated)','try       cvm run triage "…"',''].join('\n'));
});

test('deploy: a fixable refusal answered no, or with no terminal, prints the refusal and its fix and stops as a failure does',async t=>{
 const f=await linkedFixture(t,deployRoutes(undefined,{'POST /api/v1/code/deployments/plan':()=>notConnected}));
 const no=await inProcess(f,['--format','table'],{terminal:true,answers:['n']});
 assert.equal(no.code,4);
 assert.equal(no.stdout,'connects  linear   not connected\n          Connect it now? Opens your browser.  [Y/n] n\nfailed   cave_code_connector_not_connected: linear has no shared sign-in.\nfix      cvm connect add linear\n');
 assert.deepEqual(f.seen.map(q=>q.path),['/api/v1/code/deployments/plan'],'nothing stored, nothing deployed');
 // No terminal: spawned as a person's script runs it.
 const spawned=await f.run(['deploy','linked','--format','table']);
 assert.equal(spawned.code,4);assert.equal(spawned.stdout,'failed   cave_code_connector_not_connected: linear has no shared sign-in.\nfix      cvm connect add linear\n');
 const json=await f.run(['deploy','linked']);
 assert.deepEqual(json.json(),{schema_version:1,ok:false,status:'failed',error:{code:'cave_code_connector_not_connected',message:'linear has no shared sign-in.'},fix:'cvm connect add linear'});
 assert.equal(f.seen.filter(q=>q.path!=='/api/v1/code/deployments/plan').length,0);
 // A refusal no one can put right here is printed with its fix, terminal or not.
 const g=await linkedFixture(t,deployRoutes(undefined,{'POST /api/v1/code/deployments/plan':()=>F.refusal(409,'cave_code_connector_tool_unknown','linear has no tool named list_issue. It has: list_issues, get_issue.',{connector:'linear',fix:'cvm connect diff linear'})}));
 const unknown=await inProcess(g,['--format','table'],{terminal:true});
 assert.equal(unknown.code,4);assert.deepEqual(unknown.asked,[]);
 assert.equal(unknown.stdout,'failed   cave_code_connector_tool_unknown: linear has no tool named list_issue. It has: list_issues, get_issue.\nfix      cvm connect diff linear\n');
});

test('deploy: a missing connector is added from the catalog at a terminal; one no template names cannot be, and the fix says add it by its address',async t=>{
 let plans=0,gets=0;
 const missing=F.refusal(409,'cave_code_connector_missing','This organization has no connector named notion.',{connector:'notion',fix:'cvm connect add notion'});
 const f=await linkedFixture(t,deployRoutes(undefined,{
  'POST /api/v1/code/deployments/plan':()=>++plans===1?missing:[200,F.plan63],
  'GET /api/v1/code/connectors/catalog':()=>[200,F.catalog],
  'GET /api/v1/code/connectors/notion':()=>{gets++;return gets===1?F.refusal(404,'cave_not_found','This organization has no connector named notion. List them: cvm connect ls'):[200,{connector:F.connector({name:'notion',connection:F.connection({status:gets<3?'pending':'connected',writes_in:[],updated_at:gets<3?'2026-11-19T10:00:00Z':'2026-11-19T10:09:00Z',signed_in_at:gets<3?null:'2026-11-19T10:09:00Z'})})}];},
  'POST /api/v1/code/connectors':()=>[201,{connector:F.connector({name:'notion',address:'https://mcp.notion.com/mcp',template:'notion'}),authorize_url:F.authorize}],
  'POST /api/v1/code/connectors/notion/read':()=>[200,{...F.readFresh,connector:'notion'}],
  'POST /api/v1/code/connectors/notion/accept':()=>[200,F.accepted(1,5)],
 }));
 const r=await inProcess(f,['--format','table'],{terminal:true,answers:['','y','n']});
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(r.asked,['Add it from the catalog and connect it now? Opens your browser.  [Y/n]','Accept these 5 tools?  [Y/n]','Let agents write with your sign-in to notion in production?  [y/N]']);
 assert.deepEqual(f.seen.find(q=>q.path==='/api/v1/code/connectors').body,{template:'notion'});
 assert.match(r.stdout,/^connects  notion   not added\n {10}Add it from the catalog and connect it now\? Opens your browser\. {2}\[Y\/n\] \nadded {5}notion  https:\/\/mcp\.notion\.com\/mcp  \(from the catalog\)\n/);
 assert.match(r.stdout,/\naccepted  notion  version 1: 5 tools \(2 read, 2 write, 1 external\)\n/);
 assert.match(r.stdout,/\nreads {5}notion reads only: agents read with your sign-in\. To let them write: cvm connect allow-writes notion\ntriage {4}v5 /);
 assert.equal(plans,2);
 // crm is no template: nothing is asked or added.
 const g=await linkedFixture(t,deployRoutes(undefined,{
  'POST /api/v1/code/deployments/plan':()=>F.refusal(409,'cave_code_connector_missing','This organization has no connector named notion.',{connector:'notion',fix:'cvm connect add notion'}),
  'GET /api/v1/code/connectors/catalog':()=>[200,{templates:F.catalog.templates.filter(x=>x.name!=='notion')}],
 }));
 const none=await inProcess(g,['--format','table'],{terminal:true,answers:['y']});
 assert.equal(none.code,4);assert.deepEqual(none.asked,[]);
 assert.equal(none.stdout,'connects  notion   not added, and no template of the catalog has that name\nfailed   cave_code_connector_missing: This organization has no connector named notion.\nfix      cvm connect add <url> --name notion\n');
 assert.deepEqual(g.seen.map(q=>q.path),['/api/v1/code/deployments/plan','/api/v1/code/connectors/catalog']);
});

test('deploy: tools waiting to be accepted, at a terminal: Accept its 5 tools now?, then the plan again; no terminal prints the fix',async t=>{
 let plans=0;
 const unpinned=F.refusal(409,'cave_code_connector_unpinned','linear\'s tools were never accepted.',{connector:'linear',fix:'cvm connect accept linear'});
 const f=await linkedFixture(t,deployRoutes(undefined,{
  'POST /api/v1/code/deployments/plan':()=>++plans===1?unpinned:[200,F.plan63],
  'POST /api/v1/code/connectors/linear/read':()=>[200,F.readChanged],
  'POST /api/v1/code/connectors/linear/accept':()=>[200,F.accepted()],
 }));
 const r=await inProcess(f,['--format','table'],{terminal:true,answers:['y']});
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(f.seen.slice(0,4).map(q=>[q.method,q.path,q.body]),[['POST','/api/v1/code/deployments/plan',wants],['POST','/api/v1/code/connectors/linear/read',{}],['POST','/api/v1/code/connectors/linear/accept',{version:3}],['POST','/api/v1/code/deployments/plan',wants]]);
 assert.ok(r.stdout.startsWith([
  'connects  linear   5 tools wait to be accepted',
  'tools     5 tools: 2 read, 2 write, 1 external',
  'problem   a b: a name with a space is left off every card until the server renames it.',
  'external  these act outside: notify_slack',
  '          Accept its 5 tools now?  [Y/n] y',
  'accepted  linear  version 3: 5 tools (2 read, 2 write, 1 external)',
  `triage    v5  ${summaryLine(f.b)}`].join('\n')),r.stdout);
 // No terminal: the refusal and its fix, and nothing read.
 const h=await linkedFixture(t,deployRoutes(undefined,{'POST /api/v1/code/deployments/plan':()=>unpinned}));
 const json=await h.run(['deploy','linked']);
 assert.equal(json.code,4);assert.equal(json.json().fix,'cvm connect accept linear');
 assert.deepEqual(h.seen.map(q=>q.path),['/api/v1/code/deployments/plan']);
 // Fixed once and refused again for the same reason: printed, not asked again.
 const g=await linkedFixture(t,deployRoutes(undefined,{'POST /api/v1/code/deployments/plan':()=>unpinned,'POST /api/v1/code/connectors/linear/read':()=>[200,F.readChanged],'POST /api/v1/code/connectors/linear/accept':()=>[200,F.accepted()]}));
 const again=await inProcess(g,['--format','table'],{terminal:true,answers:['y','y']});
 assert.equal(again.code,4);assert.equal(again.asked.length,1);
 assert.match(again.stdout,/\nfailed {3}cave_code_connector_unpinned: linear's tools were never accepted\.\nfix {6}cvm connect accept linear\n$/);
});

test('deploy: what the plan holds never reaches the terminal raw',async t=>{
 const evil=`ev\x1b[31mil\u{202e}gnp\nINJECTED\u{2028}\x9b2J\u{feff}`,long='on and '.repeat(400);
 const plan={connectors:[{name:evil,added:true,state:evil,connection:{identity:'service',signed_in_by_name:evil+long,writes_in:[evil]},tools:evil,effects:[evil,long],grant:'asks',asked:[{name:evil}]},{name:'x',grant:'granted',connection:null,state:evil},{name:long,grant:'covered'}],
  tools:evil,tokens:evil,budget:evil,fits:evil,checks:[{connector:evil,kind:evil,line:evil+long,fix:`cvm connect diff ${evil}`}],card:evil};
 const f=await linkedFixture(t,deployRoutes([202,{state:'held',deployment:{...deployment(),name:evil},plan,hold:{id:evil,asked:[{connector:evil,people:[{name:evil+long}]}]}}],{'POST /api/v1/code/deployments/plan':()=>[200,plan]}));
 const r=await f.run(['deploy','linked','--format','table']);
 assert.equal(r.code,0,r.stdout);
 assert.doesNotMatch(r.stdout,/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{2028}\u{2029}\p{Cf}]/u);
 for(const line of r.stdout.split('\n')){assert.ok(!line.startsWith('INJECTED'));assert.ok(line.length<=800,line.length);}
});

test('a long refusal is cut at a word, with an ellipsis',()=>{
 const refusal=message=>{const e=new CloudError('cave_http_error','x',1);e.httpStatus=409;e.details={error:{code:'cave_code_refused',message}};return failure(e,'Deploy').message;};
 assert.equal(refusal('Short and whole.'),'Short and whole.');
 const long=refusal('word '.repeat(200));
 assert.ok(long.length<=500&&long.endsWith('word…'),long.slice(-20));
});

});
