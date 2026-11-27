import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,readdir,writeFile,stat,rm,access,utimes,cp} from 'node:fs/promises';
import {readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TEST_CONCURRENCY,limitSpawn} from './pool.mjs';

const cvm=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const whoami=JSON.parse(await readFile(new URL('../../../contracts/operations.public.json',import.meta.url),'utf8')).operations.find(o=>o.id==='context.whoami');
// The operation envelope the control API returns for `auth status`.
const me={schema_version:1,operation:whoami.id,version:whoami.version,contract_sha256:whoami.contract_sha256,ok:true,status:'completed',data:{user:{id:'u',email:'owner@caveman.local',name:'Owner',organization_id:'o',role:'owner'},plan:'free',deployment:'local',data:{level:'metadata',content:false,locked:false},can_invite:false,products:[]}};
const jwt=exp=>Buffer.from(JSON.stringify({exp})).toString('base64url')+'.sig';

async function home(){
 const dir=await mkdtemp(join(tmpdir(),'cvm-'));
 await mkdir(join(dir,'.caveman-cloud'));await mkdir(join(dir,'.caveman'));
 return dir;
}
// The scratch HOME holds every agent's config, and PATH reaches no real agent
// CLI: setup never touches this machine's own agents.
function run(args,{dir,env={},input}={}){
 return limitSpawn(()=>new Promise(resolve=>{
  const base={...process.env};for(const k of ['CAVE_TOKEN','CAVE_API_URL','CAVE_PROJECT_ID','CAVE_CLOUD_PROFILE','CLAUDE_CONFIG_DIR','CODEX_HOME','XDG_CONFIG_HOME'])delete base[k];
  const child=spawn(process.execPath,[cvm,...args],{cwd:dir,env:{...base,HOME:dir,USERPROFILE:dir,APPDATA:join(dir,'AppData','Roaming'),...process.platform==='win32'?{}:{PATH:'/usr/bin:/bin'},CAVEMAN_HOME:join(dir,'.caveman'),CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',...env}});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  if(input!==undefined)child.stdin.end(input);
  child.on('close',code=>resolve({code,stdout,stderr}));
 }));
}
async function cloud(handler){
 const seen=[];
 const server=createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',async()=>{seen.push({path:req.url,auth:req.headers.authorization,body});const [status,reply]=await handler(req,body);res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(reply));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {seen,url:`http://127.0.0.1:${server.address().port}`,close:()=>{server.closeAllConnections();server.close();}};
}

describe('cvm', {concurrency: TEST_CONCURRENCY}, () => {

test('uses caveman login\'s stored credential and writes a refreshed pair back to the same store',async()=>{
 const dir=await home();
 const fresh=jwt(Math.floor(Date.now()/1000)+3600);
 const api=await cloud(req=>req.url==='/api/v1/auth/refresh'?[200,{access_token:fresh,refresh_token:'r2'}]:[200,me]);
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:api.url,tokenStore:'file',projectId:'00000000-0000-4000-8000-000000000001',telemetry:{enabled:false}}));
  await writeFile(join(dir,'.caveman','credentials'),JSON.stringify({access_token:jwt(1),refresh_token:'r1',gateway_api_key:'gk'}));
  const result=await run(['auth','status','--format','json'],{dir});
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(api.seen[0].body),{refresh_token:'r1'});
  assert.equal(api.seen[1].auth,`Bearer ${fresh}`);
  const stored=JSON.parse(await readFile(join(dir,'.caveman','credentials'),'utf8'));
  assert.deepEqual(stored,{access_token:fresh,refresh_token:'r2',gateway_api_key:'gk'});
  if(process.platform!=='win32')assert.equal((await stat(join(dir,'.caveman','credentials'))).mode&0o777,0o600);
  const config=JSON.parse(await readFile(join(dir,'.caveman-cloud','config.json'),'utf8'));
  assert.deepEqual(config,{baseURL:api.url,tokenStore:'file',projectId:'00000000-0000-4000-8000-000000000001',telemetry:{enabled:false}});
 }finally{api.close();}
});

test('reads the config where caveman v4 keeps it ($CAVEMAN_HOME/cloud.json), else the old file; the new one wins',async()=>{
 const api=await cloud(()=>[200,me]),stale=await cloud(()=>[200,me]);
 const v4=['.caveman','cloud.json'],legacy=['.caveman-cloud','config.json'];
 const status=async files=>{
  const dir=await home(),before=api.seen.length;
  for(const [path,url] of files)await writeFile(join(dir,...path),JSON.stringify({baseURL:url,tokenStore:'file'}));
  await writeFile(join(dir,'.caveman','credentials'),JSON.stringify({access_token:'t'}));
  const result=await run(['auth','status','--format','json'],{dir});
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.ok(api.seen.length>before&&api.seen.at(-1).auth==='Bearer t');
 };
 try{
  await status([[v4,api.url]]);
  await status([[legacy,api.url]]);
  // A stale old file, left from an earlier sign-in, is never asked.
  await status([[v4,api.url],[legacy,stale.url]]);
  assert.deepEqual(stale.seen,[]);
 }finally{api.close();stale.close();}
});

test('CAVE_TOKEN wins over the stored credential and never refreshes',async()=>{
 const dir=await home();
 const api=await cloud(()=>[200,me]);
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:api.url,tokenStore:'file'}));
  await writeFile(join(dir,'.caveman','credentials'),JSON.stringify({access_token:jwt(1),refresh_token:'r1'}));
  const result=await run(['auth','status','--format','json'],{dir,env:{CAVE_TOKEN:'ci-token'}});
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.deepEqual(api.seen.map(s=>s.auth),['Bearer ci-token']);
 }finally{api.close();}
});

test('signed out exits 3 and names cvm login',async()=>{
 const result=await run(['projects','list','--format','json'],{dir:await home()});
 assert.equal(result.code,3);
 assert.match(result.stdout,/cvm login/);
});

test('mcp serves the Cloud MCP server over stdio',async()=>{
 const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'0'}}};
 const result=await run(['mcp'],{dir:await home(),input:JSON.stringify(init)+'\n'});
 const reply=JSON.parse(result.stdout.split('\n')[0]);
 assert.equal(reply.id,1);
 assert.ok(reply.result.serverInfo.name,result.stderr);
});

test('a logout during the refresh request wins: nothing is written back',async()=>{
 const dir=await home();
 let arrived,release;const inFlight=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);
 const api=await cloud(async req=>{if(req.url!=='/api/v1/auth/refresh')return [200,me];arrived();await gate;return [200,{access_token:jwt(Math.floor(Date.now()/1000)+3600),refresh_token:'r2'}];});
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:api.url,tokenStore:'file'}));
  await writeFile(join(dir,'.caveman','credentials'),JSON.stringify({access_token:jwt(1),refresh_token:'r1'}));
  const pending=run(['auth','status','--format','json'],{dir});
  await inFlight;
  // `caveman logout` end state: secret gone, address cleared.
  await rm(join(dir,'.caveman','credentials'));await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:''}));
  release();await pending;
  await assert.rejects(access(join(dir,'.caveman','credentials')));
  assert.deepEqual(JSON.parse(await readFile(join(dir,'.caveman-cloud','config.json'),'utf8')),{baseURL:''});
 }finally{api.close();}
});

test('a refused refresh leaves the store untouched',async()=>{
 const dir=await home();
 const api=await cloud(req=>req.url==='/api/v1/auth/refresh'?[401,{error:{code:'cave_auth_invalid'}}]:[200,me]);
 try{
  const config=JSON.stringify({baseURL:api.url,tokenStore:'file'}),secret=JSON.stringify({access_token:jwt(1),refresh_token:'r1'});
  await writeFile(join(dir,'.caveman-cloud','config.json'),config);await writeFile(join(dir,'.caveman','credentials'),secret);
  await run(['auth','status','--format','json'],{dir});
  assert.equal(api.seen[0].path,'/api/v1/auth/refresh');
  assert.equal(await readFile(join(dir,'.caveman','credentials'),'utf8'),secret);
  assert.equal(await readFile(join(dir,'.caveman-cloud','config.json'),'utf8'),config);
 }finally{api.close();}
});

test('a pending logout cleanup never refreshes; a legacy inline token still signs in',async()=>{
 const dir=await home();
 const api=await cloud(()=>[200,me]);
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:api.url,tokenStore:'file',logoutPendingLocalCleanup:true}));
  await writeFile(join(dir,'.caveman','credentials'),JSON.stringify({access_token:jwt(1),refresh_token:'r1'}));
  await run(['auth','status','--format','json'],{dir});
  assert.ok(api.seen.every(s=>s.path!=='/api/v1/auth/refresh'));
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:api.url,token:'inline-token'}));
  assert.equal((await run(['auth','status','--format','json'],{dir})).code,0);
  assert.equal(api.seen.at(-1).auth,'Bearer inline-token');
 }finally{api.close();}
});

test('after logout clears the address, CAVE_TOKEN with CAVE_API_URL still works',async()=>{
 const dir=await home();
 const api=await cloud(()=>[200,me]);
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:''}));
  const result=await run(['auth','status','--format','json'],{dir,env:{CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url}});
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.equal(api.seen[0].auth,'Bearer ci-token');
 }finally{api.close();}
});

test('mcp tool calls use the stored credential',async()=>{
 const dir=await home();
 const api=await cloud(()=>[200,me]);
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:api.url,tokenStore:'file',projectId:'00000000-0000-4000-8000-000000000001'}));
  await writeFile(join(dir,'.caveman','credentials'),'bare-token');
  const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'0'}}};
  const call={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'caveman_context',arguments:{}}};
  const result=await run(['mcp'],{dir,input:[init,{jsonrpc:'2.0',method:'notifications/initialized'},call].map(m=>JSON.stringify(m)).join('\n')+'\n'});
  assert.ok(api.seen.length>0,result.stderr);
  assert.ok(api.seen.every(s=>s.auth==='Bearer bare-token'));
 }finally{api.close();}
});

test('a first run with no config prints usage for no arguments, --help and help',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cvm-'));
 try{
  await Promise.all([[],['--help'],['help']].map(async args=>{
   const result=await run(args,{dir});
   assert.equal(result.code,0,result.stdout);
   assert.match(JSON.parse(result.stdout).usage,/^cvm /);
  }));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('help lists what cvm answers itself: setup and login on the screen, evals init in its family, cvm mcp --help its usage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cvm-'));
 try{
  const [screen,evalsRes,mcp,typo]=await Promise.all([
   run(['--help','--format','table'],{dir}),
   run(['evals','--help'],{dir}),
   run(['mcp','--help'],{dir}),
   run(['tracs','list'],{dir}),
  ]);
  assert.equal(screen.code,0,screen.stdout);
  assert.match(screen.stdout,/\n {2}cvm setup +connect your coding agents/);
  assert.match(screen.stdout,/\n {2}cvm login \| cvm logout +sign in with the browser/);
  const evals=JSON.parse(evalsRes.stdout);
  for(const verb of ['init','ci','watch','run','compare'])assert.ok(evals.verbs.some(row=>row.verb===verb),verb);
  assert.equal(mcp.code,0);assert.deepEqual(JSON.parse(mcp.stdout),{usage:'cvm mcp',summary:'Serve the Cloud MCP server over stdio.'});
  assert.equal(typo.code,2);assert.match(JSON.parse(typo.stdout).error.message,/Did you mean cvm traces\?/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a reader that closes the pipe early (cvm ... | head) ends cvm quietly with exit 0',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cvm-'));
 try{
  const result=await new Promise(resolve=>{
   const child=spawn(process.execPath,[cvm,'tools','list','--format','json'],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir,CAVEMAN_HOME:join(dir,'.caveman'),CAVE_NO_KEYCHAIN:'1'},stdio:['ignore','pipe','pipe']});
   child.stdout.destroy(); // the reader is gone before cvm writes
   let stderr='';child.stderr.on('data',d=>stderr+=d);
   child.on('close',code=>resolve({code,stderr}));
  });
  assert.equal(result.code,0,result.stderr);
  assert.doesNotMatch(result.stderr,/EPIPE|Unhandled/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const project='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const operation=id=>JSON.parse(readFileSync(new URL('../../../contracts/operations.public.json',import.meta.url),'utf8')).operations.find(o=>o.id===id);

test('CAVE_API_URL and CAVE_PROJECT_ID win over the saved login, and --project over both',async()=>{
 const dir=await home();
 // Each answers the MCP server's grant discovery and nothing else.
 const {operations,contract_sha256}=JSON.parse(readFileSync(new URL('../../../contracts/operations.public.json',import.meta.url),'utf8'));
 const answer=req=>req.url==='/api/v1/cloud/operations?view=ids'?[200,{schema_version:1,contract_sha256,operations:operations.map(({id})=>({id}))}]:req.url.endsWith('/context.whoami')?[200,me]:[500,{}];
 const saved=await cloud(answer),named=await cloud(answer);
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:saved.url,tokenStore:'file',projectId:project}));
  await writeFile(join(dir,'.caveman','credentials'),JSON.stringify({access_token:jwt(Math.floor(Date.now()/1000)+3600),refresh_token:'r1'}));
  const env={CAVE_API_URL:named.url,CAVE_TOKEN:'ci-token',CAVE_PROJECT_ID:other};
  await run(['ci','suites','--format','json'],{dir,env});
  assert.equal(saved.seen.length,0,'the saved address is not asked');
  assert.equal(named.seen[0].path,`/api/v1/projects/${other}/cloud/operations/ci.suites`);
  await run(['ci','suites','--project',project,'--format','json'],{dir,env});
  assert.equal(named.seen[1].path,`/api/v1/projects/${project}/cloud/operations/ci.suites`);
  // The MCP server reads the same context.
  const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'0'}}};
  const call={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'caveman_quality',arguments:{action:'ci_suites'}}};
  named.seen.length=0;
  await run(['mcp'],{dir,env,input:[init,{jsonrpc:'2.0',method:'notifications/initialized'},call].map(m=>JSON.stringify(m)).join('\n')+'\n'});
  assert.ok(named.seen.some(s=>s.path.startsWith(`/api/v1/projects/${other}/`)),JSON.stringify(named.seen.map(s=>s.path)));
  // With neither variable the saved login still answers.
  await run(['ci','suites','--format','json'],{dir});
  assert.equal(saved.seen[0].path,`/api/v1/projects/${project}/cloud/operations/ci.suites`);
 }finally{saved.close();named.close();}
});

test('the saved credential is never sent to another CAVE_API_URL',async()=>{
 const dir=await home();
 const elsewhere=await cloud(()=>[200,me]);
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:'https://api.caveman.so',tokenStore:'file'}));
  await writeFile(join(dir,'.caveman','credentials'),JSON.stringify({access_token:jwt(1),refresh_token:'r1'}));
  const result=await run(['auth','status','--format','json'],{dir,env:{CAVE_API_URL:elsewhere.url}});
  assert.equal(result.code,3,result.stdout);
  assert.equal(elsewhere.seen.length,0);
 }finally{elsewhere.close();}
});

// A control API that starts a CI run, takes its results and scores it on the
// given finish.
async function ciCloud(scored,after=2){
 let finishes=0;
 return cloud((req,body)=>{
  if(req.url===`/api/v1/projects/${project}/ci/runs`)return [201,{run:{id:'run-1',status:'running'},key:{token:'cave_live_secret',gateway_url:'https://gw.test',max_usd:2},mode:scored.mode,baseline:{match:'exact'}}];
  if(req.url!==`/api/v1/projects/${project}/ci/runs/run-1/finish`)return [404,{error:{code:'cave_not_found',message:'no'}}];
  return [202,++finishes>after?{run:{id:'run-1',status:'complete'},details_url:'https://app.caveman.test/experiments/eval_run/run-1',...scored}:{run:{id:'run-1',status:'scoring'},mode:scored.mode,conclusion:null,check:null}];
 });
}
const regress={kind:'regress',title:'Regress · test pass rate −4.1 pp [−6.0, −2.2]',sentence:'Test pass rate moved.',summary:'Flipped: 3 pass→fail, 1 fail→pass',quality:{estimate:-4.1,lower:-6,upper:-2.2},cost:null};
// The wrapped test command: writes what it was given and a JUnit report.
const tests=exit=>['--',process.execPath,'-e',`const fs=require('fs');fs.writeFileSync('seen.json',JSON.stringify([process.env.CAVE_API_KEY,process.env.CAVE_CI_RUN_ID,process.env.CAVE_GATEWAY_URL]));fs.writeFileSync('junit.xml','<testsuite><testcase classname="a" name="one"/></testsuite>');process.exit(${exit})`];
const gitlab={CAVE_TOKEN:'person-session',CAVE_PROJECT_ID:project,GITLAB_CI:'true',CI_COMMIT_SHA:'a'.repeat(40),CI_COMMIT_REF_NAME:'feature',CI_MERGE_REQUEST_IID:'12',CI_MERGE_REQUEST_DIFF_BASE_SHA:'b'.repeat(40),
 CI_MERGE_REQUEST_TARGET_BRANCH_NAME:'main',CI_JOB_NAME:'llm tests: 1/2',CI_PIPELINE_ID:'5150',CI_PROJECT_ID:'4242'};
for(const name of ['GITHUB_SHA','GITHUB_REF','GITHUB_JOB','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_REPOSITORY_ID','GITHUB_EVENT_PATH','GITHUB_EVENT_NAME','GITHUB_BASE_REF'])gitlab[name]='';

test('evals ci starts a run from the CI system\'s own variables, hands the key to the tests alone, and fails on a gating regression',async()=>{
 const dir=await home();
 const api=await ciCloud({mode:'gate',conclusion:'failure',check:regress});
 try{
  const result=await run(['evals','ci','--suite','evals','--junit','junit.xml','--max-usd','2','--junit-out','caveman.xml',...tests(0)],{dir,env:{...gitlab,CAVE_API_URL:api.url}});
  assert.equal(result.code,5,result.stdout+result.stderr);
  const {request_id,...start}=JSON.parse(api.seen[0].body);
  assert.match(request_id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(start,{sha:'a'.repeat(40),ref:'refs/heads/feature',base_sha:'b'.repeat(40),base_ref:'main',pr_number:12,event:'pull_request',job:'llm-tests--1-2',run_id:'5150',run_attempt:1,repository_id:4242,suite:{name:'evals'},max_usd:2});
  assert.ok(api.seen.every(s=>s.auth==='Bearer person-session'));
  // The tests got the run's key the way the GitHub Action exports it; nothing printed it.
  assert.deepEqual(JSON.parse(await readFile(join(dir,'seen.json'),'utf8')),['cave_live_secret','run-1','https://gw.test']);
  assert.ok(!(result.stdout+result.stderr).includes('cave_live_secret'));
  // The reports go up once; the verdict is read by repeating the finish.
  assert.deepEqual(api.seen.slice(1).map(s=>JSON.parse(s.body)),[{status:'completed',junit:['<testsuite><testcase classname="a" name="one"/></testsuite>']},{status:'completed'},{status:'completed'}]);
  const out=JSON.parse(result.stdout);
  assert.deepEqual([out.ok,out.mode,out.conclusion,out.failed,out.command_exit,out.verdict.kind,out.reasons],[false,'gate','failure',true,0,'regress',['the gating suite\'s check concluded failure']]);
  assert.match(result.stderr,/Regress · test pass rate −4\.1 pp[\s\S]*Flipped: 3 pass→fail, 1 fail→pass/);
  const junit=await readFile(join(dir,'caveman.xml'),'utf8');
  assert.match(junit,/<testsuite name="Caveman \/ evals" tests="1" failures="1" skipped="0">/);
  assert.match(junit,/<failure message="the gating suite&apos;s check concluded failure"|<failure message="the gating suite's check concluded failure">/);
 }finally{api.close();}
});

test('evals ci --advisory never fails on the verdict, prints JUnit on request, and keeps the tests\' own exit status',async()=>{
 const dir=await home();
 const api=await ciCloud({mode:'gate',conclusion:'failure',check:regress},1);
 try{
  const env={...gitlab,CAVE_API_URL:api.url};
  const spared=await run(['evals','ci','--advisory','--junit','junit.xml','--junit-out','-',...tests(0)],{dir,env});
  assert.equal(spared.code,0,spared.stdout+spared.stderr);
  assert.match(spared.stdout,/^<\?xml[\s\S]*<testsuite name="Caveman \/ llm-tests--1-2" tests="1" failures="0" skipped="0">/);
  assert.match(spared.stderr,/\(--advisory: the job is not failed\)/);
  // The tests' own failure is theirs, and the run is finished as failed.
  api.seen.length=0;
  const failing=await run(['evals','ci','--advisory','--junit','junit.xml',...tests(3)],{dir,env});
  assert.equal(failing.code,3);
  assert.equal(JSON.parse(api.seen[1].body).status,'failed');
  // A limit of the caller's own fails an advisory suite's job.
  const limited=await ciCloud({mode:'advisory',conclusion:'failure',check:regress},0);
  try{
   assert.equal((await run(['evals','ci','--junit','junit.xml',...tests(0)],{dir,env:{...gitlab,CAVE_API_URL:limited.url}})).code,0);
   assert.equal((await run(['evals','ci','--junit','junit.xml','--max-quality-drop-pp','4',...tests(0)],{dir,env:{...gitlab,CAVE_API_URL:limited.url}})).code,5);
  }finally{limited.close();}
 }finally{api.close();}
});

test('evals ci refuses before running anything when it cannot start, unless --advisory',async()=>{
 const dir=await home();
 const api=await cloud(()=>[403,{error:{code:'cave_ci_repo_not_bound',message:'This repository is not connected to a Caveman project through the GitHub App.'}}]);
 try{
  const env={...gitlab,CAVE_API_URL:api.url};
  const refused=await run(['evals','ci',...tests(0)],{dir,env});
  assert.equal(refused.code,3);
  assert.equal(JSON.parse(refused.stdout).error.code,'cave_ci_repo_not_bound');
  await assert.rejects(access(join(dir,'seen.json')),'the tests did not run');
  const advisory=await run(['evals','ci','--advisory',...tests(4)],{dir,env});
  assert.equal(advisory.code,4);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'seen.json'),'utf8')),[null,null,null]);
  // No command, and no repository id outside GitHub Actions and GitLab CI: usage.
  assert.equal((await run(['evals','ci'],{dir,env})).code,2);
  const bare=await run(['evals','ci','--sha','c'.repeat(40),...tests(0)],{dir,env:{...env,CI_PROJECT_ID:''}});
  assert.equal(bare.code,2);
  assert.match(JSON.parse(bare.stdout).error.message,/--repository-id/);
 }finally{api.close();}
});

// The smallest value an operation's output schema accepts.
function sample(schema){
 if(schema.const!==undefined)return schema.const;
 if(schema.enum)return schema.enum[0];
 if(schema.anyOf)return sample(schema.anyOf.find(s=>s.type==='null')??schema.anyOf[0]);
 if(schema.type==='object')return Object.fromEntries((schema.required??[]).map(key=>[key,sample(schema.properties[key])]));
 const type=[schema.type].flat().find(t=>t==='null')??schema.type;
 if(type==='null')return null;
 return {array:[],integer:0,number:0,boolean:false}[type]??(schema.format==='date-time'?'2026-10-08T00:00:00Z':schema.format==='uuid'?project:'x');
}

test('evals watch waits for a run\'s verdict and exits by it',async()=>{
 const dir=await home();
 const op=operation('verdicts.get'),runId='00000000-0000-4000-8000-0000000000aa';
 const envelope=data=>({schema_version:1,operation:op.id,version:op.version,contract_sha256:op.contract_sha256,ok:true,status:'completed',data:{...sample(op.output_schema),label:'evals at aaaaaaa',...data}});
 let reads=0,final={state:'complete',verdict:'dont_ship',sentence:'Test pass rate moved.'};
 const api=await cloud(()=>++reads===1?[404,{error:{code:'cave_not_found',message:'No verdict with that source and run id in this project.'}}]:reads===2?[200,envelope({state:'running',verdict:null})]:[200,envelope(final)]);
 try{
  const env={CAVE_TOKEN:'t',CAVE_API_URL:api.url,CAVE_PROJECT_ID:project};
  const worse=await run(['evals','watch',runId],{dir,env});
  assert.equal(worse.code,5,worse.stdout+worse.stderr);
  assert.equal(api.seen[0].path,`/api/v1/projects/${project}/cloud/operations/verdicts.get`);
  assert.deepEqual(JSON.parse(api.seen[0].body),{source:'eval_run',run_id:runId});
  assert.equal(JSON.parse(worse.stdout).data.verdict,'dont_ship');
  assert.match(worse.stderr,/no verdict yet\n.*running\n.*dont_ship/s);
  final={state:'complete',verdict:'pass'};
  assert.equal((await run(['evals','watch',runId],{dir,env})).code,0);
  final={state:'terminal',verdict:'need_more_data'};
  assert.equal((await run(['evals','watch',runId],{dir,env})).code,6);
  // The run is still going when the wait ends: the reconnect command, exit 6.
  final={state:'running',verdict:null};
  const waiting=await run(['evals','watch',runId,'--timeout','1'],{dir,env});
  assert.equal(waiting.code,6);
  assert.equal(JSON.parse(waiting.stdout).error.code,'cave_wait_timeout');
  assert.equal((await run(['evals','watch'],{dir,env})).code,2);
 }finally{api.close();}
});

// Sign-in and onboarding: the device grant, `cvm setup`, the installed skill.
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const bundle=fileURLToPath(new URL('../dist/skills/caveman-cloud/',import.meta.url));
const suite=JSON.parse(readFileSync(new URL('../../../skills/registry.json',import.meta.url),'utf8')).suites.cvm;
const envelope=(id,data)=>{const op=operation(id);return {schema_version:1,operation:id,version:op.version,contract_sha256:op.contract_sha256,ok:true,status:'completed',data:{...sample(op.output_schema),...data}};};
const access_token=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,oid:'org-1'})).toString('base64url')+'.sig';
const grant={access_token,token_type:'Bearer',expires_in:900,refresh_token:'r1',credential_kind:'gateway',gateway_api_key:'gk',gateway_key_id:'kid',gateway_url:'https://gw.test',project_id:project,delivery_ack_token:'ack'};
// A control API that answers the device grant (pending once, then approved,
// unless told otherwise) and the operations setup runs.
function device({token=polls=>polls===1?[400,{error:'authorization_pending'}]:[200,grant],projects=[{id:project,name:'Shop'}]}={}){
 let polls=0;
 return cloud(req=>{
  if(req.url==='/api/v1/auth/device/code')return [200,{device_code:'dc',user_code:'ABCD-EFGH',verification_uri:'http://127.0.0.1/activate',verification_uri_complete:'http://127.0.0.1/activate?user_code=ABCD-EFGH',expires_in:60,interval:0}];
  if(req.url==='/api/v1/auth/device/token')return token(++polls);
  if(req.url==='/api/v1/auth/device/ack')return [200,{acknowledged:true}];
  const id=req.url.split('/').pop();
  if(id==='context.whoami')return [200,me];
  const row=p=>({...sample(operation('projects.get').output_schema),...p});
  if(id==='projects.list')return [200,envelope(id,{data:projects.map(row),next_cursor:null})];
  if(id==='projects.get')return [200,envelope(id,row(projects.find(p=>req.url.includes(p.id))))];
  if(id==='wizard.start')return [200,envelope(id,{id:'00000000-0000-4000-8000-0000000000ee',heartbeat_interval_s:30})];
  if(id==='wizard.update')return [200,envelope(id,{})];
  return [404,{error:{code:'cave_not_found',message:'no'}}];
 });
}
const body=(api,path)=>JSON.parse(api.seen.find(s=>s.path.endsWith(path)).body);

test('login: a device code, a pending poll, the grant, then the receipt; stored as caveman login stores it, without gatewayUrl',async()=>{
 const dir=await home();
 const api=await device();
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({telemetry:{enabled:false},gatewayUrl:'https://old.test',token:'legacy',logoutPendingLocalCleanup:true}));
  const result=await run(['login','--instance',api.url+'/'],{dir});
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{signed_in:true,api:api.url,project_id:project});
  assert.match(result.stderr,/ABCD-EFGH/);
  assert.deepEqual(api.seen.map(s=>s.path),['/api/v1/auth/device/code','/api/v1/auth/device/token','/api/v1/auth/device/token','/api/v1/auth/device/ack']);
  assert.deepEqual(JSON.parse(api.seen[1].body),{device_code:'dc'});
  assert.deepEqual(JSON.parse(api.seen[3].body),{device_code:'dc',ack_token:'ack'});
  assert.equal(api.seen[3].auth,`Bearer ${access_token}`);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'.caveman','credentials'),'utf8')),{access_token,refresh_token:'r1',gateway_api_key:'gk',gateway_key_id:'kid',project_id:project});
  if(process.platform!=='win32')assert.equal((await stat(join(dir,'.caveman','credentials'))).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'.caveman-cloud','config.json'),'utf8')),{telemetry:{enabled:false},baseURL:api.url,tokenStore:'file',organizationId:'org-1',projectId:project});
  // The next command signs in with it.
  assert.equal((await run(['projects','list','--format','json'],{dir})).code,0);
  assert.equal(api.seen.at(-1).path,'/api/v1/cloud/operations/projects.list');
  assert.equal(api.seen.at(-1).auth,`Bearer ${access_token}`);
 }finally{api.close();}
});

test('login with no default keychain stores the file and never opens the macOS keychain dialog',async()=>{
 const dir=await home();
 const api=await device();
 const bin=join(dir,'bin');await mkdir(bin);
 // A `security` that has no default keychain, as in a sudo or remote shell, and logs every call.
 await writeFile(join(bin,'security'),`#!/bin/sh\necho "$1" >> "${join(dir,'security.log')}"\n[ "$1" = default-keychain ] && { echo 'security: SecKeychainCopyDefault: A default keychain could not be found.' >&2; exit 1; }\nexit 0\n`,{mode:0o755});
 try{
  const result=await run(['login','--instance',api.url],{dir,env:{CAVE_NO_KEYCHAIN:'',PATH:`${bin}:${process.env.PATH}`}});
  assert.equal(result.code,0,result.stdout+result.stderr);
  const calls=await readFile(join(dir,'security.log'),'utf8').catch(()=>'');
  assert.doesNotMatch(calls,/add-generic-password/);
  assert.equal(JSON.parse(await readFile(join(dir,'.caveman','credentials'),'utf8')).access_token,access_token);
  // A first sign-in writes the config caveman v4 reads.
  assert.equal(JSON.parse(await readFile(join(dir,'.caveman','cloud.json'),'utf8')).tokenStore,'file');
  await assert.rejects(access(join(dir,'.caveman-cloud','config.json')));
 }finally{api.close();}
});

test('login: a denied grant and a closed installation exit 3 and say so',async()=>{
 const denied=await device({token:()=>[400,{error:'access_denied'}]});
 const closed=await cloud(()=>[403,{error:{code:'cave_device_login_disabled',message:'Device login is not open on this installation.'}}]);
 try{
  const [refused,shut,plainHttp,withPath]=await Promise.all([
   run(['login'],{dir:await home(),env:{CAVE_API_URL:denied.url}}),
   run(['login','--no-browser'],{dir:await home(),env:{CAVE_API_URL:closed.url}}),
   run(['login','--instance','http://example.test'],{dir:await home()}),
   run(['login','--instance','https://example.test/api'],{dir:await home()}),
  ]);
  assert.equal(refused.code,3);
  assert.match(JSON.parse(refused.stdout).error.message,/denied/);
  assert.equal(shut.code,3);
  assert.equal(JSON.parse(shut.stdout).error.code,'cave_device_login_disabled');
  assert.equal(plainHttp.code,2,'plain HTTP only on localhost');
  assert.equal(withPath.code,2,'an origin, no path');
 }finally{denied.close();closed.close();}
});

test('setup signs in when signed out, takes the grant\'s project and installs for the agent named',async()=>{
 const dir=await home();
 const api=await device();
 try{
  const result=await run(['setup','--agent','codex'],{dir,env:{CAVE_API_URL:api.url}});
  assert.equal(result.code,0,result.stdout+result.stderr);
  const out=JSON.parse(result.stdout);
  assert.deepEqual(out.skill.installed,[{agent:'codex',path:join(dir,'.agents','skills','caveman-cloud')}]);
  assert.deepEqual([out.signed_in,out.project,out.onboarding_reported],[true,{id:project,name:'Shop'},true]);
  assert.equal(body(api,'wizard.start').client,'codex');
  assert.match(out.next,/^Open Codex /);
  assert.deepEqual(out.agents,[{id:'codex',skill:'changed',mcp:'changed'}]);
  assert.equal(await readFile(join(dir,'.codex','config.toml'),'utf8'),`[mcp_servers.caveman-cloud]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([cvm,'mcp'])}\n`);
  await assert.rejects(access(join(dir,'.claude')),'nothing for an agent not named');
 }finally{api.close();}
});

test('setup verifies the project, saves it as cvm context set does, installs the skill and reports to the onboarding screen',async()=>{
 const dir=await home();
 const api=await device();
 try{
  const result=await run(['setup','--project',project,'--agent','claude','--format','json'],{dir,env:{CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url}});
  assert.equal(result.code,0,result.stdout+result.stderr);
  const installed=join(dir,'.claude','skills','caveman-cloud');
  assert.deepEqual(JSON.parse(result.stdout),{ok:true,signed_in:true,api:api.url,project:{id:project,name:'Shop'},skill:{version,installed:[{agent:'claude',path:installed}],refused:[]},
   agents:[{id:'claude',skill:'changed',mcp:'changed'}],onboarding_reported:true,next:'Open Claude Code in your repository and ask: "Set up Caveman Cloud for this repository."'});
  assert.ok(api.seen.every(s=>s.auth==='Bearer ci-token'));
  assert.ok(!api.seen.some(s=>s.path.startsWith('/api/v1/auth/')),'CAVE_TOKEN is never traded for a sign-in');
  assert.equal(await readFile(join(installed,'SKILL.md'),'utf8'),await readFile(join(bundle,'SKILL.md'),'utf8'));
  for(const id of suite.slice(1))await access(join(installed,'references',id+'.md'));
  assert.equal(await readFile(join(installed,'.cvm-version'),'utf8'),version);
  assert.equal(JSON.parse(await readFile(join(dir,'.caveman-cloud','profiles.json'),'utf8')).project_id,project);
  await assert.rejects(access(join(dir,'.caveman-cloud.json')),'nothing written in the repository');
  assert.deepEqual(body(api,'wizard.start'),{client:'claude'}); // not a git checkout: no repository facts
  // Every update carries the seven tasks in order; the first back-fills what
  // ran before the session existed, the last closes it.
  const updates=api.seen.filter(s=>s.path.endsWith('/wizard.update')).map(s=>JSON.parse(s.body));
  const ids=['install','sign_in','project','agents','skills','mcp','ready'];
  assert.ok(updates.every(u=>u.session_id==='00000000-0000-4000-8000-0000000000ee'&&JSON.stringify(u.tasks.map(t=>t.id))===JSON.stringify(ids)));
  assert.deepEqual(updates[0].tasks.slice(0,3).map(t=>[t.status,t.label]),[['done','Install cvm'],['done','Sign in'],['done','Project']]);
  assert.equal(updates[0].tasks[1].detail,`owner@caveman.local · ${new URL(api.url).host}`);
  assert.deepEqual([...new Set(updates.map(u=>u.phase))],['planning','editing','completed']);
  const last=updates.at(-1);
  assert.deepEqual(last.tasks.map(t=>t.status),Array(7).fill('done'));
  assert.deepEqual([last.tasks[3].detail,last.tasks[6].detail,last.pending_input],['Claude Code','connected to Claude Code','']);
  // Run again: nothing to change, and the agent's config is read, not rewritten.
  const again=await run(['setup','--project',project,'--agent','claude'],{dir,env:{CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url}});
  assert.equal(again.code,0);
  assert.deepEqual(JSON.parse(again.stdout).agents,[{id:'claude',skill:'unchanged',mcp:'unchanged'}]);
 }finally{api.close();}
});

test('setup with no project and more than one to choose from exits 2 and lists them',async()=>{
 const dir=await home();
 const api=await device({projects:[{id:project,name:'Shop'},{id:other,name:'Blog'}]});
 try{
  const result=await run(['setup','--agent','claude'],{dir,env:{CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url}});
  assert.equal(result.code,2,result.stdout);
  const out=JSON.parse(result.stdout);
  assert.match(out.error.message,/--project UUID/);
  assert.deepEqual(out.projects,[{id:project,name:'Shop'},{id:other,name:'Blog'}]);
  await assert.rejects(access(join(dir,'.claude')));
 }finally{api.close();}
});

test('setup leaves a caveman-cloud skill it did not install alone and exits 1',async()=>{
 const dir=await home(),theirs=join(dir,'.claude','skills','caveman-cloud');
 await mkdir(theirs,{recursive:true});await writeFile(join(theirs,'SKILL.md'),'mine');
 const api=await device();
 try{
  const result=await run(['setup','--project',project,'--agent','claude','--format','json'],{dir,env:{CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url}});
  assert.equal(result.code,1,result.stdout+result.stderr);
  const out=JSON.parse(result.stdout);
  assert.deepEqual([out.ok,out.skill.installed,out.skill.refused,out.onboarding_reported],[false,[],[{path:theirs,reason:'it holds a caveman-cloud skill cvm did not install'}],true]);
  assert.deepEqual(out.agents,[{id:'claude',skill:'failed',mcp:'changed',reason:`left ${theirs.replace(dir,'~')} alone: it holds a caveman-cloud skill cvm did not install`}]);
  // The onboarding screen sees the failure and why.
  const last=JSON.parse(api.seen.filter(s=>s.path.endsWith('/wizard.update')).at(-1).body);
  assert.deepEqual([last.phase,last.tasks[4].status,last.tasks[6].status],['failed','failed','failed']);
  assert.match(last.error,/^Claude Code: left .* alone/);
  assert.equal(await readFile(join(theirs,'SKILL.md'),'utf8'),'mine');
  await assert.rejects(access(join(theirs,'.cvm-version')));
 }finally{api.close();}
});

test('setup --remove deletes only the skills cvm installed',async()=>{
 const dir=await home(),ours=join(dir,'.claude','skills','caveman-cloud'),theirs=join(dir,'.agents','skills','caveman-cloud');
 await mkdir(ours,{recursive:true});await writeFile(join(ours,'.cvm-version'),'0.0.1');
 await mkdir(theirs,{recursive:true});await writeFile(join(theirs,'SKILL.md'),'mine');
 await mkdir(join(dir,'.claude','skills','.caveman-cloud-interrupted'));
 const result=await run(['setup','--remove','--format','json'],{dir});
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(JSON.parse(result.stdout),{skill:{removed:[ours]},mcp:{removed:[]}});
 assert.deepEqual(await readdir(join(dir,'.claude','skills')),[],'what an interrupted install left goes too');
 assert.equal(await readFile(join(theirs,'SKILL.md'),'utf8'),'mine');
});

test('any command refreshes a skill an older cvm installed, and creates none',async()=>{
 const dir=await home(),ours=join(dir,'.claude','skills','caveman-cloud'),theirs=join(dir,'.agents','skills','caveman-cloud');
 await mkdir(ours,{recursive:true});await writeFile(join(ours,'.cvm-version'),'0.0.1');await writeFile(join(ours,'SKILL.md'),'stale');
 // A crashed cvm's lock, two minutes old, is taken over.
 const lock=join(dir,'.claude','skills','.caveman-cloud.lock');await mkdir(lock);await utimes(lock,new Date(Date.now()-120000),new Date(Date.now()-120000));
 await mkdir(theirs,{recursive:true});await writeFile(join(theirs,'SKILL.md'),'mine');
 assert.equal((await run(['tools','list','--format','json'],{dir})).code,0);
 assert.deepEqual(await readdir(join(dir,'.claude','skills')),['caveman-cloud']);
 assert.equal(await readFile(join(ours,'SKILL.md'),'utf8'),await readFile(join(bundle,'SKILL.md'),'utf8'));
 assert.equal(await readFile(join(ours,'.cvm-version'),'utf8'),version);
 assert.equal(await readFile(join(theirs,'SKILL.md'),'utf8'),'mine');
 const fresh=await home();
 await run(['tools','list','--format','json'],{dir:fresh});
 await assert.rejects(access(join(fresh,'.claude')));
 await assert.rejects(access(join(fresh,'.agents')));
});

test('logout revokes the device\'s key and session, then forgets the credential and the address',async()=>{
 const dir=await home();
 const api=await cloud(()=>[200,{ok:true}]);
 try{
  await writeFile(join(dir,'.caveman-cloud','config.json'),JSON.stringify({baseURL:api.url,tokenStore:'file',projectId:project,organizationId:'org-1',telemetry:{enabled:false}}));
  await writeFile(join(dir,'.caveman','credentials'),JSON.stringify({access_token,refresh_token:'r1',gateway_key_id:'kid'}));
  const result=await run(['logout'],{dir});
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{logged_out:true});
  assert.deepEqual(api.seen.map(s=>s.path),[`/api/v1/projects/${project}/keys/kid/revoke`,'/api/v1/auth/logout']);
  assert.deepEqual(JSON.parse(api.seen[1].body),{refresh_token:'r1'});
  await assert.rejects(access(join(dir,'.caveman','credentials')));
  assert.deepEqual(JSON.parse(await readFile(join(dir,'.caveman-cloud','config.json'),'utf8')),{telemetry:{enabled:false},baseURL:''});
  assert.equal((await run(['projects','list','--format','json'],{dir})).code,3);
 }finally{api.close();}
});

test('setup show, assert and hold stay the operations',async()=>{
 const api=await cloud(()=>[404,{error:{code:'cave_not_found',message:'no'}}]);
 try{
  await run(['setup','show','--format','json'],{dir:await home(),env:{CAVE_TOKEN:'t',CAVE_API_URL:api.url,CAVE_PROJECT_ID:project}});
  assert.deepEqual(api.seen.map(s=>s.path),[`/api/v1/projects/${project}/cloud/operations/setup.show`]);
 }finally{api.close();}
});

test('login keeps polling through a busy server',async()=>{
 const dir=await home();
 const api=await device({token:polls=>polls===1?[503,{error:{code:'cave_device_unavailable',message:'Device authorization is temporarily unavailable.'}}]:[200,grant]});
 try{
  const result=await run(['login'],{dir,env:{CAVE_API_URL:api.url}});
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.equal(api.seen.filter(s=>s.path==='/api/v1/auth/device/token').length,2);
 }finally{api.close();}
});

test('many cvm commands at once refresh a skill once, leaving no partial copies',async()=>{
 const dir=await home(),skills=join(dir,'.claude','skills'),ours=join(skills,'caveman-cloud');
 await mkdir(ours,{recursive:true});await writeFile(join(ours,'.cvm-version'),'0.0.1');
 const results=await Promise.all(Array.from({length:8},()=>run(['tools','describe','datasets.create','--format','json'],{dir})));
 assert.ok(results.every(r=>r.code===0),results.map(r=>r.stderr).join(''));
 assert.deepEqual((await readdir(skills)).sort(),['caveman-cloud']);
 assert.equal(await readFile(join(ours,'.cvm-version'),'utf8'),version);
 assert.equal(await readFile(join(ours,'SKILL.md'),'utf8'),await readFile(join(bundle,'SKILL.md'),'utf8'));
});

test('logout keeps the credential when the gateway key is not revoked, and a session already ended is no failure',async()=>{
 const dir=await home();
 let keyAnswer=[401,{error:{code:'cave_auth_invalid',message:'no'}}];
 const api=await cloud(req=>req.url.endsWith('/revoke')?keyAnswer:[401,{error:{code:'cave_invalid_session',message:'Session is invalid or already expired.'}}]);
 try{
  const config=JSON.stringify({baseURL:api.url,tokenStore:'file',projectId:project}),secret=JSON.stringify({access_token,refresh_token:'r1',gateway_api_key:'gk',gateway_key_id:'kid'});
  await writeFile(join(dir,'.caveman-cloud','config.json'),config);await writeFile(join(dir,'.caveman','credentials'),secret);
  const kept=await run(['logout'],{dir});
  assert.equal(kept.code,1,kept.stdout);
  assert.deepEqual(api.seen.map(s=>s.path),[`/api/v1/projects/${project}/keys/kid/revoke`]);
  assert.equal(await readFile(join(dir,'.caveman','credentials'),'utf8'),secret);
  assert.equal(await readFile(join(dir,'.caveman-cloud','config.json'),'utf8'),config);
  keyAnswer=[404,{error:{code:'cave_key_not_found',message:'gone'}}];
  assert.equal((await run(['logout'],{dir})).code,0);
  await assert.rejects(access(join(dir,'.caveman','credentials')));
 }finally{api.close();}
});

// Every agent setup connects, each config where its own docs put it, in a
// scratch HOME.
function agentHome(dir){
 const vscode=process.platform==='darwin'?join(dir,'Library','Application Support','Code','User'):process.platform==='win32'?join(dir,'AppData','Roaming','Code','User'):join(dir,'.config','Code','User');
 return {
  claude:join(dir,'.claude.json'),codex:join(dir,'.codex','config.toml'),cursor:join(dir,'.cursor','mcp.json'),vscode:join(vscode,'mcp.json'),
  windsurf:join(dir,'.codeium','windsurf','mcp_config.json'),gemini:join(dir,'.gemini','settings.json'),opencode:join(dir,'.config','opencode','opencode.json'),
  dirs:[join(dir,'.claude'),join(dir,'.codex'),join(dir,'.cursor'),vscode,join(dir,'.codeium','windsurf'),join(dir,'.gemini'),join(dir,'.config','opencode')],
 };
}
const exists=path=>access(path).then(()=>true,()=>false);

test('setup connects every agent it finds, a re-run changes nothing, and --remove gives every config back byte for byte',async()=>{
 const dir=await home(),paths=agentHome(dir);
 for(const d of paths.dirs)await mkdir(d,{recursive:true});
 const seeds={
  cursor:'{\n  "mcpServers": {}\n}\n',
  gemini:'{\n  "theme": "Dark",\n  "selectedAuthType": "oauth-personal"\n}\n',
  codex:'model = "o3"  # pinned\n\n[mcp_servers.other]\ncommand = "x"\nargs = [ "a",  "b" ]\n',
  // caveman v4's entry under the same name: replaced, and said so.
  opencode:'{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "caveman-cloud": {"type": "local", "command": ["node", "/opt/caveman/cli.js", "cloud", "mcp-serve"]}\n  }\n}\n',
 };
 for(const [id,text] of Object.entries(seeds))await writeFile(paths[id],text);
 const api=await device();
 try{
  const env={CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url};
  const first=await run(['setup','--project',project],{dir,env});
  assert.equal(first.code,0,first.stdout+first.stderr);
  const out=JSON.parse(first.stdout);
  assert.deepEqual(out.agents,['claude','codex','cursor','vscode','windsurf','gemini','opencode'].map(id=>({id,skill:'changed',mcp:'changed',...id==='opencode'?{reason:'replaced the caveman v4 entry'}:{}})));
  assert.deepEqual(out.skill.installed.map(i=>i.path),[join(dir,'.claude','skills','caveman-cloud'),...Array(6).fill(join(dir,'.agents','skills','caveman-cloud'))]);
  assert.equal(body(api,'wizard.start').client,'claude');
  // No cvm on PATH here: every agent runs this cvm by absolute paths.
  const server={command:process.execPath,args:[cvm,'mcp']};
  const read=async id=>JSON.parse(await readFile(paths[id],'utf8'));
  assert.deepEqual((await read('claude')).mcpServers['caveman-cloud'],{type:'stdio',...server,env:{}});
  assert.deepEqual(await read('cursor'),{mcpServers:{'caveman-cloud':{type:'stdio',...server}}});
  assert.deepEqual(await read('vscode'),{servers:{'caveman-cloud':{type:'stdio',...server}}});
  assert.deepEqual(await read('windsurf'),{mcpServers:{'caveman-cloud':server}});
  assert.deepEqual(await read('gemini'),{theme:'Dark',selectedAuthType:'oauth-personal',mcpServers:{'caveman-cloud':server}});
  assert.deepEqual((await read('opencode')).mcp,{'caveman-cloud':{type:'local',command:[process.execPath,cvm,'mcp'],enabled:true}});
  assert.equal(await readFile(paths.codex,'utf8'),seeds.codex+`\n[mcp_servers.caveman-cloud]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([cvm,'mcp'])}\n`);
  const written=Object.fromEntries(await Promise.all(['claude','codex','cursor','vscode','windsurf','gemini','opencode'].map(async id=>[id,await readFile(paths[id],'utf8')])));
  // Run again: every agent unchanged, every file byte for byte.
  const again=await run(['setup','--project',project],{dir,env});
  assert.equal(again.code,0,again.stdout);
  assert.deepEqual(JSON.parse(again.stdout).agents.map(a=>[a.skill,a.mcp]),Array(7).fill(['unchanged','unchanged']));
  for(const [id,text] of Object.entries(written))assert.equal(await readFile(paths[id],'utf8'),text,id);
  // --remove: the files cvm created are gone, the rest are what they were.
  const removed=await run(['setup','--remove','--format','json'],{dir});
  assert.equal(removed.code,0,removed.stdout);
  assert.deepEqual(JSON.parse(removed.stdout).mcp.removed.map(r=>r.agent),['claude','codex','cursor','vscode','windsurf','gemini','opencode']);
  for(const id of ['cursor','gemini','codex'])assert.equal(await readFile(paths[id],'utf8'),seeds[id],id);
  for(const id of ['claude','vscode','windsurf'])assert.equal(await exists(paths[id]),false,id);
  assert.deepEqual((await read('opencode')).mcp,{},'the v4 entry it replaced is not brought back');
  assert.equal(await exists(join(dir,'.agents','skills','caveman-cloud')),false);
 }finally{api.close();}
});

test('setup leaves a config that is not plain JSON, and a caveman-cloud server it did not add, alone and prints what to add',async()=>{
 const dir=await home(),paths=agentHome(dir);
 const seeds={vscode:'// my servers\n{"servers": {}}\n',windsurf:'{"mcpServers": {"caveman-cloud": {"command": "my-own-server"}}}'};
 for(const [id,text] of Object.entries(seeds)){await mkdir(join(paths[id],'..'),{recursive:true});await writeFile(paths[id],text);}
 const api=await device();
 try{
  const result=await run(['setup','--project',project,'--agent','vscode,windsurf'],{dir,env:{CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url}});
  assert.equal(result.code,1,result.stdout);
  const out=JSON.parse(result.stdout);
  assert.equal(out.ok,false);
  assert.deepEqual(out.agents.map(a=>[a.id,a.skill,a.mcp]),[['vscode','changed','failed'],['windsurf','changed','failed']]);
  assert.match(out.agents[0].reason,/mcp\.json is not plain JSON; add the server yourself/);
  assert.match(out.agents[1].reason,/already has a caveman-cloud server cvm did not add; left it alone/);
  for(const [id,text] of Object.entries(seeds))assert.equal(await readFile(paths[id],'utf8'),text,id);
  const last=JSON.parse(api.seen.filter(s=>s.path.endsWith('/wizard.update')).at(-1).body);
  assert.deepEqual([last.phase,last.tasks[5].status,last.tasks[5].detail],['failed','failed','2 failed']);
  // --remove takes nothing it did not add.
  assert.deepEqual(JSON.parse((await run(['setup','--remove','--format','json'],{dir})).stdout).mcp,{removed:[]});
  for(const [id,text] of Object.entries(seeds))assert.equal(await readFile(paths[id],'utf8'),text,id);
  // On a terminal the snippet to add is printed.
  const table=await run(['setup','--project',project,'--agent','vscode','--format','table'],{dir,env:{CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url,CI:'1'}});
  assert.match(table.stdout,/✗ VS Code: .*not plain JSON; add the server yourself:\n {4}\{\n {6}"servers": \{\n {8}"caveman-cloud": \{/);
 }finally{api.close();}
});

test('setup registers Claude Code through its own CLI when it is installed',{skip:process.platform==='win32'&&'a shell stub'},async()=>{
 const dir=await home(),bin=join(dir,'bin');await mkdir(bin);await mkdir(join(dir,'.claude'));
 // A `claude` that logs its arguments and keeps the user scope in ~/.claude.json, as the real one does.
 await writeFile(join(bin,'claude'),`#!${process.execPath}
const fs=require('fs'),path=require('path'),file=path.join(process.env.HOME,'.claude.json'),args=process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME,'claude.log'),JSON.stringify(args)+'\\n');
const config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};config.mcpServers??={};
if(args[1]==='add'){const [name,,...command]=args.slice(4);config.mcpServers[name]={type:'stdio',command:command[0],args:command.slice(1),env:{}};}
if(args[1]==='remove')delete config.mcpServers[args[2]];
fs.writeFileSync(file,JSON.stringify(config,null,2));
`,{mode:0o755});
 const api=await device();
 try{
  const env={CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url,PATH:`${bin}:/usr/bin:/bin`};
  assert.equal((await run(['setup','--project',project,'--agent','claude'],{dir,env})).code,0);
  assert.equal((await run(['setup','--project',project,'--agent','claude'],{dir,env})).code,0);
  assert.equal((await run(['setup','--remove'],{dir,env})).code,0);
  const calls=(await readFile(join(dir,'claude.log'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(calls,[['mcp','add','--scope','user','caveman-cloud','--',process.execPath,cvm,'mcp'],['mcp','remove','caveman-cloud','--scope','user']],'the re-run changed nothing');
 }finally{api.close();}
});

test('from the npx cache setup installs cvm globally and points the agents at it; when npm cannot, at npx',{skip:process.platform==='win32'&&'a shell stub'},async()=>{
 await Promise.all([false,true].map(async fails=>{
  const api=await device();
  try{
   const dir=await home(),bin=join(dir,'bin'),global=join(dir,'global'),cached=join(dir,'.npm','_npx','f00','node_modules','@caveman-ai','cloud');
   await mkdir(bin);await mkdir(join(dir,'.cursor'));
   for(const part of ['bin','dist','package.json'])await cp(fileURLToPath(new URL(`../${part}`,import.meta.url)),join(cached,part),{recursive:true});
   // An npm whose global prefix is in the scratch HOME; `i -g` copies the package there and links its bin.
   await writeFile(join(bin,'npm'),`#!${process.execPath}
const fs=require('fs'),path=require('path'),root=path.join(${JSON.stringify(global)},'lib','node_modules'),args=process.argv.slice(2);
if(args[0]==='root'){console.log(root);process.exit(0);}
if(${fails}){console.error('npm error code EACCES');process.exit(243);}
fs.cpSync(${JSON.stringify(cached)},path.join(root,'@caveman-ai','cloud'),{recursive:true});
fs.mkdirSync(path.join(${JSON.stringify(global)},'bin'),{recursive:true});
fs.symlinkSync(path.join(root,'@caveman-ai','cloud','bin','cvm.mjs'),path.join(${JSON.stringify(global)},'bin','cvm'));
`,{mode:0o755});
   const result=await limitSpawn(()=>new Promise(resolve=>{
    const child=spawn(process.execPath,[join(cached,'bin','cvm.mjs'),'setup','--project',project,'--agent','claude,cursor'],{cwd:dir,env:{HOME:dir,PATH:`${bin}:${join(global,'bin')}:/usr/bin:/bin`,CAVEMAN_HOME:join(dir,'.caveman'),CAVE_NO_KEYCHAIN:'1',CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url}});
    let stdout='';child.stdout.on('data',d=>stdout+=d);child.on('close',code=>resolve({code,stdout}));
   }));
   assert.equal(result.code,0,result.stdout);
   const installed=join(global,'lib','node_modules','@caveman-ai','cloud','bin','cvm.mjs'),npx=['npx','-y',`@caveman-ai/cloud@${version}`,'mcp'];
   const claude=JSON.parse(await readFile(join(dir,'.claude.json'),'utf8')).mcpServers['caveman-cloud'],cursor=JSON.parse(await readFile(join(dir,'.cursor','mcp.json'),'utf8')).mcpServers['caveman-cloud'];
   assert.deepEqual([claude.command,...claude.args],fails?npx:['cvm','mcp']);
   assert.deepEqual([cursor.command,...cursor.args],fails?npx:[process.execPath,installed,'mcp']);
   const install=JSON.parse(api.seen.filter(s=>s.path.endsWith('/wizard.update')).at(-1).body).tasks[0];
   assert.deepEqual([install.status,install.detail],fails?['failed','npm i -g failed (EACCES) · the MCP server runs through npx']:['done',`cvm ${version} installed`]);
  }finally{api.close();}
 }));
});

// A copy of the package somewhere else: its MCP entries run a different cvm.mjs.
async function packageCopy(dir){
 const copy=join(dir,'elsewhere','cloud');
 for(const part of ['bin','dist','package.json'])await cp(fileURLToPath(new URL(`../${part}`,import.meta.url)),join(copy,part),{recursive:true});
 return realpathSync(join(copy,'bin','cvm.mjs'));
}
const runAt=(script,args,{dir,env})=>limitSpawn(()=>new Promise(resolve=>{
 const child=spawn(process.execPath,[script,...args],{cwd:dir,env:{HOME:dir,USERPROFILE:dir,APPDATA:join(dir,'AppData','Roaming'),PATH:'/usr/bin:/bin',CAVEMAN_HOME:join(dir,'.caveman'),CAVE_NO_KEYCHAIN:'1',...env}});
 let stdout='';child.stdout.on('data',d=>stdout+=d);child.on('close',code=>resolve({code,stdout}));
}));

test('a server pasted beside cvm\'s entry survives a re-run with another command and --remove, and the file always parses',async()=>{
 const dir=await home(),config=join(dir,'.cursor','mcp.json');
 await mkdir(join(dir,'.cursor'));await writeFile(config,'{"mcpServers": {}}');
 const api=await device();
 try{
  const env={CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url};
  assert.equal((await run(['setup','--project',project,'--agent','cursor'],{dir,env})).code,0);
  // The user pastes another server above cvm's.
  await writeFile(config,(await readFile(config,'utf8')).replace('{\n','{\n  "x": {"command": "x"},\n'));
  const other=await packageCopy(dir);
  const again=await runAt(other,['setup','--project',project,'--agent','cursor'],{dir,env});
  assert.equal(again.code,0,again.stdout);
  assert.deepEqual(JSON.parse(await readFile(config,'utf8')),{mcpServers:{x:{command:'x'},'caveman-cloud':{type:'stdio',command:process.execPath,args:[other,'mcp']}}});
  assert.equal(JSON.parse((await run(['setup','--remove','--format','json'],{dir})).stdout).mcp.removed.length,1);
  assert.deepEqual(JSON.parse(await readFile(config,'utf8')),{mcpServers:{x:{command:'x'}}});
 }finally{api.close();}
});

test('a Codex sub-table under caveman-cloud goes with it on a replace and on --remove',async()=>{
 const dir=await home(),config=join(dir,'.codex','config.toml'),start='model = "o3"\n';
 await mkdir(join(dir,'.codex'));await writeFile(config,start);
 const api=await device();
 try{
  const env={CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url};
  assert.equal((await run(['setup','--project',project,'--agent','codex'],{dir,env})).code,0);
  await writeFile(config,(await readFile(config,'utf8'))+'\n[mcp_servers.caveman-cloud.env]\nFOO = "1"\n\n[profiles.fast]\nmodel = "x"\n');
  const other=await packageCopy(dir);
  assert.equal((await runAt(other,['setup','--project',project,'--agent','codex'],{dir,env})).code,0);
  assert.equal(await readFile(config,'utf8'),`${start}\n[profiles.fast]\nmodel = "x"\n\n[mcp_servers.caveman-cloud]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([other,'mcp'])}\n`);
  await writeFile(config,(await readFile(config,'utf8'))+'\n[mcp_servers."caveman-cloud".env]\nFOO = "2"\n');
  assert.equal((await run(['setup','--remove'],{dir})).code,0);
  assert.equal(await readFile(config,'utf8'),`${start}\n[profiles.fast]\nmodel = "x"\n`);
 }finally{api.close();}
});

test('with no coding agent setup fails, says so, closes the session failed, and exits promptly',async()=>{
 const dir=await home(),api=await device();
 try{
  const began=Date.now();
  const result=await run(['setup','--project',project],{dir,env:{CAVE_TOKEN:'ci-token',CAVE_API_URL:api.url}});
  assert.ok(Date.now()-began<4000,`took ${Date.now()-began} ms`);
  assert.equal(result.code,1,result.stdout);
  assert.deepEqual([JSON.parse(result.stdout).ok,JSON.parse(result.stdout).agents],[false,[]]);
  const last=JSON.parse(api.seen.filter(s=>s.path.endsWith('/wizard.update')).at(-1).body);
  assert.deepEqual([last.phase,last.error,last.tasks[6].status,last.tasks[6].detail],['failed','No coding agent found on this machine.','failed','No coding agent found on this machine.']);
 }finally{api.close();}
});

test('versions compare as semver, prereleases included',async()=>{
 const {older}=await import('../bin/setup.mjs');
 const order=['0.0.0','0.1.0-rc.2','0.1.0-rc.10','0.1.0-rc.10.1','0.1.0-rc.x','0.1.0','0.1.1','0.10.0','1.0.0-alpha','1.0.0'];
 for(const [i,a] of order.entries())for(const [j,b] of order.entries())assert.equal(older(a,b),i<j,`${a} < ${b}`);
 assert.deepEqual([older('garbage','0.0.1'),older('0.0.1','garbage'),older(undefined,undefined)],[true,false,false]);
});

});
