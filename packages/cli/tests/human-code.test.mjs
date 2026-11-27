import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {operations,localCommands} from '../dist/cloud-client.mjs';
import {TEST_CONCURRENCY,limitSpawn,mapPool} from './pool.mjs';

const bin=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const id='00000000-0000-4000-8000-000000000001';
const secret='synthetic-human-secret-never-print';
const refresh='synthetic-refresh-never-print';
const gateway='synthetic-gateway-never-print';
const jwt=exp=>Buffer.from(JSON.stringify({exp})).toString('base64url')+'.synthetic-signature';

// Isolated homes, synthetic credentials and loopback only. No operator env,
// installed CLI, real login files, keychain, agent configs or live API calls.
async function fixture(t,handler=()=>[200,{ok:true}]){
 const home=await mkdtemp(join(tmpdir(),'cvm-human-code-'));
 await mkdir(join(home,'.caveman'));
 const seen=[];
 const server=createServer((req,res)=>{
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',async()=>{
   seen.push({method:req.method,path:req.url,headers:req.headers,body});
   const [status,reply,headers={}]=await handler(req,body);
   res.writeHead(status,{'content-type':'application/json',...headers});
   res.end(typeof reply==='string'?reply:JSON.stringify(reply));
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
 const save=async({baseURL=url,token=secret,refreshToken}={})=>{
  await writeFile(join(home,'.caveman','cloud.json'),JSON.stringify({baseURL,tokenStore:'file'}));
  await writeFile(join(home,'.caveman','credentials'),JSON.stringify({access_token:token,...(refreshToken?{refresh_token:refreshToken}:{}),gateway_api_key:gateway}),{mode:0o600});
 };
 const run=(args,env={})=>limitSpawn(()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[bin,...args],{cwd:home,env:{HOME:home,USERPROFILE:home,CAVEMAN_HOME:join(home,'.caveman'),PATH:'/usr/bin:/bin',CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',...env},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
 }));
 return {home,seen,url,save,run};
}
function noSecrets(result,...more){
 for(const value of [secret,refresh,gateway,...more])assert.ok(!(result.stdout+result.stderr).includes(value),'must not print synthetic credential');
 assert.equal(result.stderr,'');
}

describe('human-code', {concurrency: TEST_CONCURRENCY}, () => {

test('public bin routes all four human Code commands using the saved context and existing client headers',async t=>{
 const f=await fixture(t,req=>[200,{resource:req.url}]);await f.save();
 const cases=[
  [['computers'],'GET','/api/v1/code/computers'],
  [['runtimes'],'GET','/api/v1/code/runtimes'],
  [['workspace',id],'GET',`/api/v1/code/workspaces/${id}`],
  [['archive',id,'--yes'],'POST',`/api/v1/code/workspaces/${id}/archive`],
 ];
 await mapPool(cases,async([args,method,path])=>{
  const result=await f.run(['human','code',...args,'--format','json']);
  assert.equal(result.code,0,result.stdout);assert.deepEqual(JSON.parse(result.stdout),{resource:path});noSecrets(result);
  const req=f.seen.find(r=>r.path===path);
  assert.ok(req,path);
  assert.deepEqual([req.method,req.path,req.body],[method,path,method==='POST'?'{}':'']);
  assert.equal(req.headers.authorization,`Bearer ${secret}`);
  assert.equal(req.headers['content-type'],method==='POST'?'application/json':undefined);
  assert.equal(req.headers['x-cave-csrf'],undefined,'uses CloudClient bearer treatment, not browser cookies');
  assert.equal(req.headers.cookie,undefined);
 });
 assert.equal(f.seen.length,4,'no discovery, whoami or allocation calls');
});

test('normal saved-context refresh stays private and supplies the refreshed bearer',async t=>{
 const fresh=jwt(Math.floor(Date.now()/1000)+3600),stale=jwt(1);
 const f=await fixture(t,(req,body)=>{
  if(req.url==='/api/v1/auth/refresh'){
   assert.deepEqual(JSON.parse(body),{refresh_token:refresh});
   return [200,{access_token:fresh,refresh_token:'synthetic-rotated-refresh'}];
  }
  return [200,{computers:[]}];
 });await f.save({token:stale,refreshToken:refresh});
 const result=await f.run(['human','code','computers']);
 assert.equal(result.code,0,result.stdout);noSecrets(result,fresh,stale,'synthetic-rotated-refresh');
 assert.deepEqual(f.seen.map(r=>r.path),['/api/v1/auth/refresh','/api/v1/code/computers']);
 assert.equal(f.seen[1].headers.authorization,`Bearer ${fresh}`);
});

test('archive cannot mutate or refresh without explicit confirmation; -y follows CLI convention',async t=>{
 const f=await fixture(t);await f.save({token:jwt(1),refreshToken:refresh});
 const missing=await f.run(['human','code','archive',id]);
 assert.equal(missing.code,2);assert.equal(JSON.parse(missing.stdout).error.code,'cave_confirmation_required');noSecrets(missing);
 assert.deepEqual(f.seen,[]);
 await f.save();const yes=await f.run(['human','code','archive',id,'-y']);
 assert.equal(yes.code,0,yes.stdout);assert.equal(f.seen.length,1);assert.equal(f.seen[0].method,'POST');
});

test('malformed and injected IDs, unexpected arguments and arbitrary HTTP options fail before context resolution',async t=>{
 const f=await fixture(t);await f.save({token:jwt(1),refreshToken:refresh});
 const idCases=[];
 for(const bad of ['', '..', '../computers', `${id}/archive`, `${id}?x=1`, `${id}#x`, '%2e%2e', `${id}%2farchive`, `${id}\\archive`, `${id}\n`, 'not-a-uuid', 'a'.repeat(4096)]){
  for(const verb of ['workspace','archive']){
   idCases.push(['human','code',verb,bad,...(verb==='archive'?['--yes']:[])]);
  }
 }
 const argCases=[
  ['workspace'],['archive','--yes'],['computers',id],['runtimes',id],['workspace',id,'extra'],
  ['computers','--yes'],['archive',id,'--yes=false'],['archive',id,'--yes','--body','{}'],
  ['computers','--headers',secret],['GET','/api/v1/code/computers'],['allocate'],['computers','--format','bogus'],
  ['computers','--profile','default'],['computers','--project',id],
 ].map(args=>['human','code',...args]);
 await Promise.all([
  mapPool(idCases,async args=>{
   const result=await f.run(args);
   assert.equal(result.code,2,result.stdout);noSecrets(result);assert.equal(JSON.parse(result.stdout).error.code,'cave_usage');
  }),
  mapPool(argCases,async args=>{
   const result=await f.run(args);assert.equal(result.code,2,result.stdout);noSecrets(result);
  }),
 ]);
 assert.deepEqual(f.seen,[],'not even refresh is permitted on invalid input');
});

test('signed-out and endpoint override retain normal credential isolation; explicit environment context still works',async t=>{
 const f=await fixture(t);
 let result=await f.run(['human','code','computers']);assert.equal(result.code,3);assert.match(result.stdout,/cvm login/);assert.deepEqual(f.seen,[]);
 await f.save({baseURL:'https://saved.invalid'});
 result=await f.run(['human','code','computers'],{CAVE_API_URL:f.url});
 assert.equal(result.code,3);assert.deepEqual(f.seen,[]);noSecrets(result);
 result=await f.run(['human','code','computers'],{CAVE_API_URL:f.url,CAVE_TOKEN:'synthetic-override'});
 assert.equal(result.code,0,result.stdout);assert.equal(f.seen[0].headers.authorization,'Bearer synthetic-override');noSecrets(result,'synthetic-override');
});

test('safe upstream failures keep exit semantics and do not disclose messages, codes, bodies or credentials',async t=>{
 let status=403,code='cave_agent_operation_forbidden';
 const f=await fixture(t,()=>[status,{error:{code,message:`${secret} ${refresh} ${gateway} \u001b[31m`},details:{authorization:secret}}]);await f.save();
 for(const [http,exit] of [[401,3],[403,3],[404,1],[409,4],[422,2],[429,7],[500,1]]){
  status=http;code=http===403?'cave_agent_operation_forbidden':secret;
  const result=await f.run(['human','code','computers']);
  assert.equal(result.code,exit,result.stdout);noSecrets(result);
  assert.deepEqual(JSON.parse(result.stdout).error,{code:http===403?'cave_agent_operation_forbidden':'cave_request_failed',message:`Code lifecycle request failed (HTTP ${http}).`});
 }
 assert.equal(f.seen.length,7,'no fallback to another identity or auth exceptions');
});

test('existing client refuses redirects and invalid JSON without exposing transport details',async t=>{
 let mode='redirect';const f=await fixture(t,()=>mode==='redirect'?[302,{}, {location:`${f.url}/${secret}`}]:[200,`not-json ${secret}`]);await f.save();
 let result=await f.run(['human','code','computers']);assert.equal(result.code,1,result.stdout);noSecrets(result);assert.equal(f.seen.length,1);
 mode='invalid';result=await f.run(['human','code','computers']);assert.equal(result.code,6,result.stdout);noSecrets(result);
 assert.equal(JSON.parse(result.stdout).error.code,'cave_invalid_response');
});

test('real public help advertises only the fixed human surface and never extends operation or agent catalogs',async t=>{
 const f=await fixture(t);await f.save({token:jwt(1),refreshToken:refresh});
 const [,pretty,family,existing,tools]=await Promise.all([
  mapPool([['--help'],['human'],['human','--help'],['human','code'],['human','code','--help'],['human','code','archive','--help'],['help','human']],async args=>{
   const result=await f.run(args);assert.equal(result.code,0,result.stdout);assert.match(result.stdout,/human/);noSecrets(result);
  }),
  f.run(['human','code','--help','--format','table']),
  f.run(['human','--help']),
  f.run(['human','organizations','--help']),
  f.run(['tools','list','--format','json']),
 ]);
 assert.equal(pretty.code,0);assert.match(pretty.stdout,/\n  "usage"/);
 assert.ok(JSON.parse(family.stdout).verbs.some(v=>v.verb==='organizations'));assert.ok(JSON.parse(family.stdout).verbs.some(v=>v.verb==='code'));
 assert.equal(existing.code,0,existing.stdout);assert.match(existing.stdout,/human.organizations/);
 assert.equal(tools.code,0,tools.stdout);
 const humanPaths=new Set(['/code/runtimes','/code/workspaces/{workspaceId}','/code/workspaces/{workspaceId}/archive']);
 assert.ok(operations.every(o=>!o.id.startsWith('human.code')&&!humanPaths.has(o.path)));
 // /code/computers is in the catalog only as computers.*: a bound connection's service account's sandboxes (migration 0749), never a person's.
 assert.ok(operations.filter(o=>o.path==='/code/computers').every(o=>o.id.startsWith('computers.')));
 assert.ok(localCommands.every(id=>!id.startsWith('human.')));
 assert.doesNotMatch(tools.stdout,/human\.code/);
 assert.deepEqual(f.seen,[],'help does not resolve or refresh login');
});

});
