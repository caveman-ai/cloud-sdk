import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect,POLL,WAIT} from '../bin/connect.mjs';
import * as F from './fixtures/connectors.mjs';
import {TEST_CONCURRENCY,limitSpawn,mapPool} from './pool.mjs';

const bin=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const secret='synthetic-connect-secret-never-print';
const C='/api/v1/code/connectors';
const notFound=F.refusal(404,'cave_not_found','This organization has no connector named linear. List them: cvm connect ls');

// A loopback control API whose routes each test writes, and two ways to run
// cvm connect against it: in this process, with the terminal, the answers
// typed, the browser and the clock the test holds (run), or as a person types
// it, cvm.mjs in its own process with no terminal (spawned).
async function api(t,routes={}){
 const seen=[];
 const server=createServer((req,res)=>{
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',async()=>{
   const request={method:req.method,path:req.url,headers:req.headers,body:body?JSON.parse(body):undefined};seen.push(request);
   const key=`${req.method} ${req.url.split('?')[0]}`;
   const [status,reply]=routes[key]?await routes[key](request,seen):[404,{error:{code:'cave_not_found',message:`No route ${key}.`}}];
   res.writeHead(status,{'content-type':'application/json'});
   res.end(typeof reply==='string'?reply:JSON.stringify(reply));
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const run=async(argv,{terminal=false,answers=[],env={},onSleep}={})=>{
  const out=[],err=[],asked=[],opened=[],slept=[];let clock=0,interrupt;
  const io={context:async()=>({baseURL:url,token:secret}),out:s=>{out.push(s);},err:s=>{err.push(s);},terminal:()=>terminal,
   // A terminal echoes what was typed: the answer follows its question.
   ask:async(prompt,write)=>{write(prompt);asked.push(prompt.trim());const answer=answers.length?answers.shift():null;write(`${answer??''}\n`);return answer;},
   open:address=>opened.push(address),env,
   sleep:async ms=>{slept.push(ms);clock+=ms;await onSleep?.(slept.length,()=>interrupt?.());},now:()=>clock,
   interrupt:handler=>{interrupt=handler;return()=>{interrupt=undefined;};}};
  const code=await connect(argv,io);
  const stdout=out.join(''),stderr=err.join('');
  assert.ok(!(stdout+stderr).includes(secret),'must not print the credential');
  return {code,stdout,stderr,asked,opened,slept,json:()=>JSON.parse(stdout)};
 };
 const spawned=async(args,env={})=>{
  const home=await mkdtemp(join(tmpdir(),'cvm-connect-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'.caveman'));
  await writeFile(join(home,'.caveman','cloud.json'),JSON.stringify({baseURL:url,tokenStore:'file'}));
  await writeFile(join(home,'.caveman','credentials'),JSON.stringify({access_token:secret}),{mode:0o600});
  return limitSpawn(()=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[bin,...args],{cwd:home,env:{HOME:home,USERPROFILE:home,CAVEMAN_HOME:join(home,'.caveman'),PATH:process.env.PATH,CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',...env},stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
   child.on('error',reject);child.on('close',code=>{assert.ok(!(stdout+stderr).includes(secret),'must not print the credential');resolve({code,stdout,stderr,json:()=>JSON.parse(stdout)});});
  }));
 };
 const sent=()=>seen.map(r=>[r.method,r.path,r.body]);
 return {seen,sent,url,run,spawned};
}

// A sign-in that lands on the third read after it starts: the connector reads
// as answered once per GET, in order, the last answer kept.
const reads=(...answers)=>{let n=0;return ()=>answers[Math.min(n++,answers.length-1)];};
const pending=(over={})=>[200,{connector:F.connector({connection:F.connection({status:'pending',writes_in:[],updated_at:'2026-11-19T10:00:00Z',signed_in_at:null}),pin:{accepted:null,proposed:null},...over})}];
const landed=(over={},connection={})=>[200,{connector:F.connector({connection:F.connection({writes_in:[],updated_at:'2026-11-19T10:01:00Z',signed_in_at:'2026-11-19T10:01:00Z',...connection}),pin:{accepted:null,proposed:null},...over})}];
// A connector whose sign-in last changed at updated and was last completed by a person at signed.
const signed=(updated,signedAt,connection={})=>[200,{connector:F.connector({connection:F.connection({updated_at:updated,signed_in_at:signedAt,...connection})})}];
const addRoutes=(extra={})=>({
 [`GET ${C}/linear`]:reads(notFound,pending(),pending(),landed()),
 [`POST ${C}`]:()=>[201,{connector:pending()[1].connector,authorize_url:F.authorize}],
 [`POST ${C}/linear/read`]:()=>[200,F.readFresh],
 [`POST ${C}/linear/accept`]:()=>[200,F.accepted(1,5)],
 [`POST ${C}/linear/writes`]:()=>[200,{connector:F.connector({connection:F.connection({updated_at:'2026-11-19T10:02:00Z'})})}],
 ...extra,
});

describe('connect', {concurrency: TEST_CONCURRENCY}, () => {

test('add from the catalog: the template, the sign-in opened and waited for (pending twice, then connected), the tools read, listed and accepted, then writes',async t=>{
 const f=await api(t,addRoutes());
 const r=await f.run(['add','linear','--format','table'],{terminal:true,answers:['','y']});
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(f.sent(),[
  ['GET',`${C}/linear`,undefined],
  ['POST',C,{template:'linear'}],
  ['GET',`${C}/linear`,undefined],
  ['GET',`${C}/linear`,undefined],
  ['GET',`${C}/linear`,undefined],
  ['POST',`${C}/linear/read`,{}],
  ['POST',`${C}/linear/accept`,{version:1}],
  ['POST',`${C}/linear/writes`,{in:['production']}],
 ]);
 for(const req of f.seen)assert.equal(req.headers.authorization,`Bearer ${secret}`);
 // The first sign-in of a new connector: there was none before, so the wait ends on the first poll
 // that shows it connected with a time it was completed: pending twice, then that, two seconds apart.
 assert.deepEqual(r.slept,[POLL,POLL,POLL]);assert.equal(POLL,2000);assert.equal(WAIT,300000);
 assert.deepEqual(r.opened,[F.authorize]);
 assert.deepEqual(r.asked,['Accept these 5 tools?  [Y/n]','Let agents write with your sign-in to linear in production?  [y/N]']);
 assert.equal(r.stdout,[
  'added    linear  https://mcp.linear.app/mcp  (from the catalog)',
  `sign in  ${F.authorize}`,
  'waiting  your browser is open: sign in to linear. cvm waits at most 5 minutes; Ctrl-C stops waiting, and the sign-in stays open.',
  '         ✓ linear   signed in as "Dana" (a person, reads only)',
  'tools    5 tools: 2 read, 2 write, 1 external',
  '         linear.list_issues({team?: string, state?: string}) -> {issues: [{…}], next}  read  List issues, 50 a page.',
  '         linear.get_issue({id: string}) -> {issue}  read  One issue.',
  '         linear.create_comment({issue_id: string, body: string}) -> {comment}  write  Comment on an issue.',
  '         linear.create_label({name: string, color?: string}) -> {label}  write  Make a label.',
  '         linear.notify_slack({channel: string, text: string}) -> {}  external  Post to Slack.',
  'external these act outside: notify_slack',
  '         Accept these 5 tools?  [Y/n] ',
  'accepted linear  version 1: 5 tools (2 read, 2 write, 1 external)',
  '         Let agents write with your sign-in to linear in production?  [y/N] y',
  'writes   linear writes in production with your sign-in.',
  'next     name linear under connectors: in an agent\'s AGENT.md, then cvm deploy',
  ''].join('\n'));
 assert.equal(r.stderr,'');
});

test('add answers no: nothing is accepted and the sign-in reads only, and each says the command that changes it',async t=>{
 const f=await api(t,addRoutes());
 const r=await f.run(['add','linear','--format','table'],{terminal:true,answers:['n','']});
 assert.equal(r.code,0,r.stdout);
 assert.ok(!f.seen.some(req=>/\/(accept|writes)$/.test(req.path)),'neither accept nor writes is sent');
 assert.match(r.stdout,/^ {9}Accept these 5 tools\? {2}\[Y\/n\] n\naccept {3}nothing accepted yet\. To accept: cvm connect accept linear\n/m);
 assert.match(r.stdout,/^reads {4}linear reads only: agents read with your sign-in\. To let them write: cvm connect allow-writes linear$/m);
});

test('add with no terminal: no browser, no question; the address printed, the tools listed, nothing accepted; JSON says what to run next',async t=>{
 const f=await api(t,addRoutes());
 const r=await f.run(['add','linear','--format','table']);
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(r.opened,[]);assert.deepEqual(r.asked,[]);
 assert.match(r.stdout,new RegExp(`^sign in  ${F.authorize.replace(/[?.]/g,'\\$&')}$`,'m'));
 assert.match(r.stdout,/^waiting  open that address and sign in to linear\./m);
 assert.match(r.stdout,/^accept {3}nothing accepted yet\. To accept: cvm connect accept linear$/m);
 assert.ok(!f.seen.some(req=>/\/(accept|writes)$/.test(req.path)));
 // JSON: the progress goes to stderr, the result to stdout.
 const g=await api(t,addRoutes());
 const json=await g.run(['add','linear']);
 assert.equal(json.code,0,json.stdout);
 const out=json.json();
 assert.equal(out.status,'connected');assert.equal(out.added,true);assert.equal(out.next,'cvm connect accept linear');
 assert.equal(out.authorize_url,F.authorize);assert.equal(out.accepted,null);assert.deepEqual(out.read,F.readFresh);
 assert.equal(out.connector.connection.status,'connected');
 assert.match(json.stderr,/^sign in  https:/m);
 // --yes accepts with no terminal, and never marks writes.
 const h=await api(t,addRoutes());
 const yes=await h.run(['add','linear','--yes']);
 assert.equal(yes.code,0,yes.stdout);assert.equal(yes.json().status,'accepted');assert.deepEqual(yes.json().accepted,F.accepted(1,5));
 assert.deepEqual(h.sent().filter(([,path])=>/accept|writes/.test(path)),[['POST',`${C}/linear/accept`,{version:1}]]);
 // --no-browser and CAVE_NO_BROWSER keep the browser shut at a terminal too.
 for(const [args,env] of [[['--no-browser'],{}],[[],{CAVE_NO_BROWSER:'1'}]]){
  const k=await api(t,addRoutes());
  const shut=await k.run(['add','linear','--yes',...args],{terminal:true,env,answers:['n']});
  assert.equal(shut.code,0,shut.stdout);assert.deepEqual(shut.opened,[]);
 }
});

test('add by address: --name is the name agents write; without it nothing is sent',async t=>{
 const address='https://tools.acme.dev/mcp';
 const f=await api(t,{
  [`GET ${C}/internal`]:reads(notFound,pending({name:'internal',address,template:null}),landed({name:'internal',address,template:null})),
  [`POST ${C}`]:()=>[201,{connector:F.connector({name:'internal',address,template:null}),authorize_url:F.authorize}],
  [`POST ${C}/internal/read`]:()=>[200,{...F.readFresh,connector:'internal'}],
  [`POST ${C}/internal/accept`]:()=>[200,F.accepted(1,5)],
 });
 const r=await f.run(['add',address,'--name','internal','--yes','--no-browser','--format','table']);
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(f.sent().slice(0,2),[['GET',`${C}/internal`,undefined],['POST',C,{address,name:'internal'}]]);
 assert.match(r.stdout,/^added {4}internal  https:\/\/tools\.acme\.dev\/mcp$/m);
 const count=f.seen.length;
 for(const [args,pattern] of [
  [['add',address],/needs the name agents write: cvm connect add URL --name NAME/],
  [['add','http://tools.acme.dev/mcp','--name','x'],/is an https:\/\/ URL/],
  [['add','Linear'],/A catalog template is a connector's name/],
  [['add',address,'--name','Bad_Name'],/--name is a connector's name/],
  [['add','linear','extra'],/^Use cvm connect add /],
  [['add','linear','--to','x'],/--to is not for cvm connect add/],
 ]){const refused=await f.run(args);assert.equal(refused.code,2,refused.stdout);assert.equal(refused.json().error.code,'cave_usage');assert.match(refused.json().error.message,pattern);}
 assert.equal(f.seen.length,count,'nothing is sent for a refused command');
 // A template under another name sends both.
 const g=await api(t,{[`GET ${C}/tracker`]:()=>notFound,[`POST ${C}`]:()=>F.refusal(422,'cave_code_connector_personal_data','slack holds people\'s private messages, so its connector cannot be signed in with one person\'s account for the whole team.')});
 const named=await g.run(['add','linear','--name','tracker']);
 assert.equal(named.code,2);assert.deepEqual(g.sent()[1],['POST',C,{template:'linear',name:'tracker'}]);
 assert.equal(named.json().error.code,'cave_code_connector_personal_data');
});

test('add on a connector that exists signs it in again (POST connect): the old sign-in works meanwhile, and only a sign-in completed later counts',async t=>{
 const at=time=>signed(time,'2026-11-18T08:00:00Z');
 const f=await api(t,{
  // Read before the start; then the restart touched the row, then a token refresh of the old
  // sign-in moved updated_at again: signed_in_at stays, so cvm waits; then the new sign-in.
  [`GET ${C}/linear`]:reads(at('2026-11-18T08:00:00Z'),at('2026-11-19T10:00:00Z'),at('2026-11-19T10:02:00Z'),signed('2026-11-19T10:03:00Z','2026-11-19T10:03:00Z')),
  [`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}],
  [`POST ${C}/linear/read`]:()=>[200,F.readSame],
 });
 const r=await f.run(['add','linear','--format','table'],{terminal:true});
 assert.equal(r.code,0,r.stdout);
 // The connector is read before POST connect, and not again until the first poll.
 assert.deepEqual(f.sent().map(([m,p,b])=>`${m} ${p}${b?' '+JSON.stringify(b):''}`),[`GET ${C}/linear`,`POST ${C}/linear/connect {}`,`GET ${C}/linear`,`GET ${C}/linear`,`GET ${C}/linear`,`POST ${C}/linear/read {}`]);
 assert.equal(r.slept.length,3);
 assert.match(r.stdout,/^connect  linear exists: signing it in again\. Its sign-in works until this one completes\.$/m);
 assert.match(r.stdout,/^ {9}✓ linear {3}signed in as "Dana" \(a person\)$/m);
 assert.match(r.stdout,/^tools {4}linear: no change since 2026-11-12, 23 tools accepted\.$/m);
 assert.deepEqual(r.asked,[],'a list already accepted and a sign-in that writes ask nothing');
 // The same name at another address is not this connector.
 const g=await api(t,{[`GET ${C}/linear`]:()=>at('2026-11-18T08:00:00Z')});
 const other=await g.run(['add','https://elsewhere.example/mcp','--name','linear']);
 assert.equal(other.code,4,other.stdout);
 assert.deepEqual(other.json().error,{code:'cave_code_connector_exists',message:'A connector named linear exists, at https://mcp.linear.app/mcp. Pick another name with --name, or sign it in again: cvm connect add linear'});
 assert.equal(g.seen.length,1);
 // Its own address, written with a trailing slash, is.
 const h=await api(t,{[`GET ${C}/linear`]:reads(at('2026-11-18T08:00:00Z'),at('2026-11-19T10:00:00Z'),signed('2026-11-19T10:03:00Z','2026-11-19T10:03:00Z')),[`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}],[`POST ${C}/linear/read`]:()=>[200,F.readSame]});
 assert.equal((await h.run(['add','https://mcp.linear.app/mcp/','--name','linear'])).code,0);
});

test('the wait ends after 5 minutes, or at Ctrl-C, saying the sign-in is still open and that accept finishes the add; a failed sign-in says why',async t=>{
 const f=await api(t,{...addRoutes(),[`GET ${C}/linear`]:reads(notFound,pending())});
 const r=await f.run(['add','linear','--format','table']);
 assert.equal(r.code,6,r.stdout);
 assert.equal(r.slept.length,WAIT/POLL);
 assert.match(r.stdout,/\nfailed {3}cave_wait_timeout: The sign-in to linear is still open in your browser\. When you have signed in there, cvm connect accept linear finishes the add\.\nfix {6}cvm connect accept linear\n$/);
 const g=await api(t,{...addRoutes(),[`GET ${C}/linear`]:reads(notFound,pending())});
 const stopped=await g.run(['add','linear'],{onSleep:(n,interrupt)=>{if(n===2)interrupt();}});
 assert.equal(stopped.code,130);
 assert.deepEqual(stopped.json(),{schema_version:1,ok:false,status:'failed',error:{code:'cave_interrupted',message:'The sign-in to linear is still open in your browser. When you have signed in there, cvm connect accept linear finishes the add.'},fix:'cvm connect accept linear'});
 assert.equal(g.seen.filter(req=>req.method==='GET').length,2,'the read before the start and one poll: none after Ctrl-C');
 // The sign-in came back refused: the problem, and the command to try again.
 const h=await api(t,{...addRoutes(),[`GET ${C}/linear`]:reads(notFound,pending(),landed({},{status:'error',signed_in_at:null,problem:'Linear refused the sign-in: access_denied.'}))});
 const failed=await h.run(['add','linear','--format','table']);
 assert.equal(failed.code,1);
 assert.match(failed.stdout,/\nfailed {3}cave_code_connection_failed: The sign-in to linear did not complete: Linear refused the sign-in: access_denied\.\nfix {6}cvm connect add linear\n$/);
 // A busy server while waiting is read again.
 const k=await api(t,{...addRoutes(),[`GET ${C}/linear`]:reads(notFound,pending(),[503,{error:{code:'cave_unavailable',message:'Busy.'}}],landed())});
 assert.equal((await k.run(['add','linear','--yes'])).code,0);
});

const lsAnswer={connectors:[
 F.connector(F.used()),
 F.connector({id:F.ids.stripe,name:'stripe',state:'paused',paused:{by_user_id:F.ids.dana,by_name:'Dana',at:'2026-11-19T09:00:00Z',reason:'refunds look wrong'},connection:F.connection({identity:'service',signed_in_by_name:'Caveman Bot'}),pin:{accepted:{version:4,accepted_at:'2026-11-01T00:00:00Z',tools:9},proposed:{version:5,read_at:'2026-11-19T09:00:00Z',tools:10}}}),
 F.connector({id:F.ids.notion,name:'notion',connection:null,pin:{accepted:null,proposed:null}}),
 F.connector({name:'crm',connection:F.connection({status:'needs_reconnect',problem:'The refresh token was refused.',writes_in:[]})}),
 F.connector({name:'linear',scope:'personal',origin:'adopted',connection:F.connection({status:'pending'}),pin:{accepted:null,proposed:{version:1,read_at:'2026-11-19T09:00:00Z',tools:4}}}),
 F.theirs,
]};

test('ls: name, state, who signed in, tools, what uses it and what waits; JSON is the answer',async t=>{
 const f=await api(t,{[`GET ${C}`]:()=>[200,lsAnswer]});
 const r=await f.run(['ls','--format','table']);
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(f.sent(),[['GET',C,undefined]]);
 assert.equal(r.stdout,[
  'NAME               STATE          SIGNED IN AS                  TOOLS       USED BY  WAITING',
  'linear             ok             Dana, a person                23          triage   1',
  'stripe             paused         Caveman Bot, a service        9, changed  -        -',
  'notion             not connected  -                             -           -        -',
  'crm                needs sign-in  Dana, a person, reads only    23          -        -',
  'linear (personal)  not connected  -                             0, changed  -        -',
  'acme (personal)    -              Lee\'s own, at tools.acme.dev  -           -        -',
  ''].join('\n'));
 const json=await f.run(['ls']);
 assert.deepEqual(json.json(),lsAnswer);
 const empty=await api(t,{[`GET ${C}`]:()=>[200,{connectors:[]}]});
 assert.equal((await empty.run(['ls','--format','table'])).stdout,'No connectors yet. Add one from the catalog (cvm connect add linear) or by its address (cvm connect add https://... --name NAME).\n');
});

test('ls: a list waiting to be accepted is counted as the server counts it against the accepted one; with no counts it says changed',async t=>{
 const waiting=(tools,added,changed,removed)=>({version:5,read_at:'2026-11-19T09:00:00Z',tools,added,removed,changed});
 const f=await api(t,{[`GET ${C}`]:()=>[200,{connectors:[
  F.connector({...F.used({used_by:[],waiting:0}),pin:{accepted:{version:2,accepted_at:'2026-11-12T09:30:00Z',tools:23},proposed:waiting(24,1,1,0)}}),
  F.connector({...F.used({used_by:[],waiting:0}),id:F.ids.notion,name:'notes',pin:{accepted:null,proposed:waiting(4,4,0,0)}}),
  F.connector({...F.used({used_by:[],waiting:0}),id:F.ids.stripe,name:'stripe',pin:{accepted:{version:4,accepted_at:'2026-11-01T00:00:00Z',tools:1200},proposed:waiting(1199,0,0,1)}}),
  // Its tools differ from the accepted ones only in their effects: no count moves.
  F.connector({...F.used({used_by:[],waiting:0}),name:'crm',pin:{accepted:{version:1,accepted_at:'2026-11-01T00:00:00Z',tools:9},proposed:waiting(9,0,0,0)}}),
 ]}]});
 const r=await f.run(['ls','--format','table']);
 assert.equal(r.code,0,r.stdout);
 assert.equal(r.stdout,[
  'NAME    STATE  SIGNED IN AS    TOOLS                   USED BY  WAITING',
  'linear  ok     Dana, a person  23, 1 added, 1 changed  -        -',
  'notes   ok     Dana, a person  0, 4 added              -        -',
  'stripe  ok     Dana, a person  1,200, 1 removed        -        -',
  'crm     ok     Dana, a person  9, changed              -        -',
  ''].join('\n'));
});

test('ls: a sign-in that never completed names nobody, whether it waits or its first try failed; one that did keeps its signer',async t=>{
 const never={signed_in_by:null,signed_in_by_name:null,signed_in_at:null,writes_in:[]};
 const f=await api(t,{[`GET ${C}`]:()=>[200,{connectors:[
  F.connector({...F.used({used_by:[],waiting:0}),name:'tasks',connection:F.connection({...never,status:'pending'}),pin:{accepted:null,proposed:null}}),
  F.connector({...F.used({used_by:[],waiting:0}),name:'files',connection:F.connection({...never,status:'error',problem:'You declined the sign-in.'}),pin:{accepted:null,proposed:null}}),
  F.connector({...F.used({used_by:[],waiting:0}),name:'crm',connection:F.connection({status:'needs_reconnect',problem:'The refresh token was refused.',writes_in:[]})}),
 ]}]});
 const r=await f.run(['ls','--format','table']);
 assert.equal(r.code,0,r.stdout);
 assert.equal(r.stdout,[
  'NAME   STATE          SIGNED IN AS                TOOLS  USED BY  WAITING',
  'tasks  not connected  -                           -      -        -',
  'files  needs sign-in  -                           -      -        -',
  'crm    needs sign-in  Dana, a person, reads only  23     -        -',
  ''].join('\n'));
});

test('test: one line, ok with the time and the count, or the problem; exit 1 when it failed',async t=>{
 let answer=F.testOk;
 const f=await api(t,{[`POST ${C}/linear/test`]:()=>[200,answer]});
 let r=await f.run(['test','linear','--format','table']);
 assert.equal(r.code,0);assert.deepEqual(f.sent(),[['POST',`${C}/linear/test`,{}]]);
 assert.equal(r.stdout,'ok       linear  23 tools in 412 ms\n');
 answer={...F.testOk,matches_pin:false,tools:24};
 r=await f.run(['test','linear','--format','table']);
 assert.equal(r.stdout,'ok       linear  24 tools in 412 ms; the list changed since it was accepted: cvm connect diff linear\n');
 answer=F.testFailed;
 r=await f.run(['test','linear','--format','table']);
 assert.equal(r.code,1);assert.equal(r.stdout,'failed   linear: linear did not answer in 30 seconds.\n');
 r=await f.run(['test','linear']);
 assert.equal(r.code,1);assert.deepEqual(r.json(),F.testFailed);
});

test('diff: what changed since the accepted list, each added and changed tool by its card line, then the accept line; or no change since a date',async t=>{
 let answer=F.readChanged;
 const f=await api(t,{[`POST ${C}/linear/read`]:()=>[200,answer]});
 const r=await f.run(['diff','linear','--format','table']);
 assert.equal(r.code,0,r.stdout);assert.deepEqual(f.sent(),[['POST',`${C}/linear/read`,{}]]);
 assert.equal(r.stdout,[
  'diff     linear: 1 added, 1 changed, 1 removed since version 2, accepted 2026-11-12',
  'added    linear.create_label({name: string, color?: string}) -> {label}  write  Make a label.',
  'changed  linear.list_issues({team?: string, state?: string}) -> {issues: [{…}], next}  read  List issues, 50 a page.',
  '           changed: description, arguments',
  'removed  linear.archive_cycle',
  'problem  a b: a name with a space is left off every card until the server renames it.',
  'accept   cvm connect accept linear',
  ''].join('\n'));
 answer=F.readSame;
 assert.equal((await f.run(['diff','linear','--format','table'])).stdout,'diff     linear: no change since 2026-11-12 (version 2, 23 tools)\n');
 answer=F.readFresh;
 const fresh=await f.run(['diff','linear','--format','table']);
 assert.match(fresh.stdout,/^diff {5}linear: 5 tools read, none accepted yet\nadded {4}linear\.list_issues/);
 assert.deepEqual((await f.run(['diff','linear'])).json(),F.readFresh);
});

test('accept: reads first, names every tool that acts outside, asks; with no terminal it accepts nothing and says the command',async t=>{
 const f=await api(t,{[`POST ${C}/linear/read`]:()=>[200,F.readChanged],[`POST ${C}/linear/accept`]:()=>[200,F.accepted()]});
 const r=await f.run(['accept','linear','--format','table'],{terminal:true,answers:['y']});
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(f.sent(),[['POST',`${C}/linear/read`,{}],['POST',`${C}/linear/accept`,{version:3}]]);
 assert.equal(r.stdout,[
  'tools    5 tools: 2 read, 2 write, 1 external',
  'problem  a b: a name with a space is left off every card until the server renames it.',
  'external these act outside: notify_slack',
  '         Accept version 3 of linear\'s tools (5 tools)?  [Y/n] y',
  'accepted linear  version 3: 5 tools (2 read, 2 write, 1 external)',
  ''].join('\n'));
 // An effect said here counts, and goes with the accept.
 const g=await api(t,{[`POST ${C}/linear/read`]:()=>[200,F.readChanged],[`POST ${C}/linear/accept`]:()=>[200,F.accepted()]});
 const said=await g.run(['accept','linear','--effect','notify_slack=write','--effect','list_issues=external','--yes','--format','table']);
 assert.equal(said.code,0,said.stdout);
 assert.deepEqual(g.sent()[1],['POST',`${C}/linear/accept`,{version:3,effects:{notify_slack:'write',list_issues:'external'}}]);
 assert.match(said.stdout,/^tools {4}5 tools: 1 read, 3 write, 1 external\nproblem .*\nexternal these act outside: list_issues\n/);
 // No terminal, no --yes: nothing accepted, exit 2, and the command that would.
 const h=await api(t,{[`POST ${C}/linear/read`]:()=>[200,F.readChanged]});
 const asked=await h.run(['accept','linear','--format','table']);
 assert.equal(asked.code,2);assert.equal(h.seen.length,1,'only the read');
 assert.match(asked.stdout,/\nfailed {3}cave_confirmation_required: Nothing accepted: cvm asks before it accepts linear's tools, and no one is at a terminal to answer\. Accept with --yes\.\nfix {6}cvm connect accept linear --version 3 --yes\n$/);
 const askedJSON=await h.run(['accept','linear','--effect','list_issues=read']);
 assert.equal(askedJSON.json().fix,'cvm connect accept linear --version 3 --effect list_issues=read --yes');
 assert.match(askedJSON.stderr,/^external these act outside: notify_slack$/m,'the summary goes to stderr beside JSON');
 // --version accepts that one with no read; a no at the terminal accepts nothing.
 const k=await api(t,{[`POST ${C}/linear/accept`]:()=>[200,F.accepted(4,24)]});
 const versioned=await k.run(['accept','linear','--version','4','--yes']);
 assert.equal(versioned.code,0);assert.deepEqual(k.sent(),[['POST',`${C}/linear/accept`,{version:4}]]);assert.deepEqual(versioned.json(),F.accepted(4,24));
 const no=await k.run(['accept','linear','--version','4','--format','table'],{terminal:true,answers:['n']});
 assert.equal(no.code,0);assert.equal(k.seen.length,1);assert.match(no.stdout,/\[Y\/n\] n\nkept {5}nothing accepted\.\n$/);
 // Nothing proposed: nothing to accept.
 const m=await api(t,{[`POST ${C}/linear/read`]:()=>[200,F.readSame]});
 const same=await m.run(['accept','linear','--format','table']);
 assert.equal(same.code,0);assert.equal(same.stdout,'accept   nothing to accept: linear has no change since 2026-11-12.\n');
 for(const bad of [['accept','linear','--effect','notify_slack'],['accept','linear','--effect','x=delete'],['accept','linear','--version','0']]){
  const refused=await m.run(bad);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);assert.equal(refused.json().error.code,'cave_usage');
 }
 // An effect for a tool the list does not have is refused after the read, before any accept.
 const unknown=await h.run(['accept','linear','--effect','nope=read','--yes']);
 assert.equal(unknown.code,2);assert.match(unknown.json().error.message,/^--effect names nope, which is not one of linear's tools\. See them: cvm connect diff linear$/);
 assert.ok(!h.seen.some(req=>req.path.endsWith('/accept')));
 // A version that is no longer the proposed one: the API's refusal and its fix.
 const n=await api(t,{[`POST ${C}/linear/accept`]:()=>F.refusal(409,'cave_code_connector_pin_stale','linear was read again since version 3: see what changed.',{connector:'linear',fix:'cvm connect diff linear'})});
 const stale=await n.run(['accept','linear','--version','3','--yes','--format','table']);
 assert.equal(stale.code,4);assert.equal(stale.stdout,'failed   cave_code_connector_pin_stale: linear was read again since version 3: see what changed.\nfix      cvm connect diff linear\n');
});

test('rotate: the connector is read before POST connect; a refresh of the old sign-in keeps the wait going, the new sign-in ends it',async t=>{
 const f=await api(t,{[`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}],
  [`GET ${C}/linear`]:reads(signed('2026-11-19T10:00:00Z','2026-11-19T10:00:00Z'),signed('2026-11-19T10:02:00Z','2026-11-19T10:00:00Z'),signed('2026-11-19T10:04:00Z','2026-11-19T10:04:00Z'))});
 const r=await f.run(['rotate','linear','--format','table'],{terminal:true});
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(f.sent().map(([m,p])=>`${m} ${p}`),[`GET ${C}/linear`,`POST ${C}/linear/connect`,`GET ${C}/linear`,`GET ${C}/linear`]);
 assert.deepEqual(f.seen[1].body,{});assert.deepEqual(r.opened,[F.authorize]);assert.equal(r.slept.length,2);
 assert.match(r.stdout,/^rotate {3}linear: its sign-in works until the new one completes\.\nsign in  https:/);
 assert.match(r.stdout,/^ {9}✓ linear {3}signed in as "Dana" \(a person\)\n$/m);
 // The old sign-in refreshed on every poll for 5 minutes: never the new one.
 let refreshed=0;
 const g=await api(t,{[`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}],[`GET ${C}/linear`]:()=>signed(new Date(Date.UTC(2026,10,19,10,0,refreshed++)).toISOString(),'2026-11-19T10:00:00Z')});
 const late=await g.run(['rotate','linear']);
 assert.equal(late.code,6);assert.deepEqual(late.json().error,{code:'cave_wait_timeout',message:'The new sign-in to linear is still open in your browser; the old one works until it completes.'});
 assert.equal(late.json().fix,undefined);
 assert.equal(late.slept.length,WAIT/POLL);assert.equal(refreshed,1+WAIT/POLL);
});

test('the wait rule: a sign-in where there was none, one whose time was null, and a Caveman Cloud older than signed_in_at',async t=>{
 // A connector with no sign-in: any completed one is the new one; nothing is read after the start.
 const none=[200,{connector:F.connector({connection:null})}];
 const a=await api(t,{[`GET ${C}/linear`]:reads(none,pending(),landed()),[`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}],[`POST ${C}/linear/read`]:()=>[200,F.readSame]});
 assert.equal((await a.run(['add','linear'])).code,0);
 assert.deepEqual(a.sent().map(([m,p])=>`${m} ${p}`),[`GET ${C}/linear`,`POST ${C}/linear/connect`,`GET ${C}/linear`,`GET ${C}/linear`,`POST ${C}/linear/read`]);
 // A sign-in with no time before (completed before Cloud kept one): a refresh keeps it null, a completed one sets it.
 const b=await api(t,{[`GET ${C}/linear`]:reads(signed('2026-11-18T08:00:00Z',null),signed('2026-11-19T10:02:00Z',null),signed('2026-11-19T10:03:00Z','2026-11-19T10:03:00Z')),[`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}],[`POST ${C}/linear/read`]:()=>[200,F.readSame]});
 const nulled=await b.run(['rotate','linear']);
 assert.equal(nulled.code,0,nulled.stdout);assert.equal(nulled.slept.length,2);
 // An older Cloud sends no signed_in_at. On a sign-in that exists, the rule before it holds:
 // the sign-in is read once more right after the start, and a change after that counts.
 const older=updated=>[200,{connector:F.connector({connection:F.olderConnection({updated_at:updated})})}];
 const c=await api(t,{[`GET ${C}/linear`]:reads(older('2026-11-18T08:00:00Z'),older('2026-11-19T10:00:00Z'),older('2026-11-19T10:00:00Z'),older('2026-11-19T10:03:00Z')),[`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}],[`POST ${C}/linear/read`]:()=>[200,F.readSame]});
 const fallback=await c.run(['add','linear','--format','table']);
 assert.equal(fallback.code,0,fallback.stdout);
 assert.deepEqual(c.sent().map(([m,p])=>`${m} ${p}`),[`GET ${C}/linear`,`POST ${C}/linear/connect`,`GET ${C}/linear`,`GET ${C}/linear`,`GET ${C}/linear`,`POST ${C}/linear/read`]);
 assert.equal(fallback.slept.length,2);
 assert.match(fallback.stdout,/^ {9}✓ linear {3}signed in as "Dana" \(a person\)$/m);
 const d=await api(t,{[`GET ${C}/linear`]:reads(older('2026-11-18T08:00:00Z'),older('2026-11-19T10:00:00Z'),older('2026-11-19T10:04:00Z')),[`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}]});
 const rotated=await d.run(['rotate','linear']);
 assert.equal(rotated.code,0,rotated.stdout);
 assert.deepEqual(d.sent().map(([m,p])=>`${m} ${p}`),[`GET ${C}/linear`,`POST ${C}/linear/connect`,`GET ${C}/linear`,`GET ${C}/linear`]);
 // A new connector on an older Cloud: there was none before, so connected is the new one.
 const olderPending=[200,{connector:F.connector({connection:F.olderConnection({status:'pending',writes_in:[]}),pin:{accepted:null,proposed:null}})}];
 const e=await api(t,{...addRoutes(),[`GET ${C}/linear`]:reads(notFound,olderPending,older('2026-11-19T10:01:00Z')),[`POST ${C}`]:()=>[201,{connector:olderPending[1].connector,authorize_url:F.authorize}]});
 const added=await e.run(['add','linear']);
 assert.equal(added.code,0,added.stdout);
 assert.deepEqual(e.sent().slice(0,4).map(([m,p])=>`${m} ${p}`),[`GET ${C}/linear`,`POST ${C}`,`GET ${C}/linear`,`GET ${C}/linear`]);
 assert.equal(added.json().connector.connection.status,'connected');
});

test('pause, resume and allow-writes: each its route and body, a line each',async t=>{
 const paused=F.connector({state:'paused',paused:{by_user_id:F.ids.dana,by_name:'Dana',at:'2026-11-19T09:00:00Z',reason:'an incident'}});
 let writes=['production'];
 const f=await api(t,{
  [`POST ${C}/linear/pause`]:()=>[200,{connector:paused}],
  [`POST ${C}/linear/resume`]:()=>[200,{connector:F.connector()}],
  [`POST ${C}/linear/writes`]:req=>[200,{connector:F.connector({connection:F.connection({writes_in:req.body.in})})}],
 });
 for(const [args,body,line] of [
  [['pause','linear'],{},'paused   linear: every call to it stops. Paused by Dana: an incident\nresume   cvm connect resume linear\n'],
  [['pause','linear','--reason','an incident'],{reason:'an incident'},null],
  [['resume','linear'],{},'resumed  linear: calls to it go through again.\n'],
  [['allow-writes','linear'],{in:['production']},'writes   linear writes in production with Dana\'s sign-in.\n'],
  [['allow-writes','linear','--in','development,production'],{in:['production','development']},'writes   linear writes in production and development with Dana\'s sign-in.\n'],
  [['allow-writes','linear','--none'],{in:[]},'reads    linear reads only: agents read with Dana\'s sign-in and write nothing.\n'],
 ]){
  const r=await f.run([...args,'--format','table']);
  assert.equal(r.code,0,r.stdout);
  assert.deepEqual(f.sent().at(-1),['POST',`${C}/linear/${args[0]==='allow-writes'?'writes':args[0]}`,body]);
  if(line)assert.equal(r.stdout,line);
  const json=await f.run(args);
  assert.ok(json.json().connector,'JSON is the answer');
 }
 const count=f.seen.length;
 for(const bad of [['allow-writes','linear','--in','staging'],['allow-writes','linear','--in','production','--none'],['pause','linear','--reason','two\nlines'],['pause','Linear'],['resume']]){
  const refused=await f.run(bad);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);
 }
 assert.equal(f.seen.length,count);
 // Only the person who signed it in marks a person's sign-in: the API's refusal and its fix.
 const g=await api(t,{[`POST ${C}/linear/writes`]:()=>F.refusal(403,'cave_forbidden','linear\'s sign-in is Dana\'s own: only Dana marks where it writes. Dana runs: cvm connect allow-writes linear')});
 const theirs=await g.run(['allow-writes','linear','--format','table']);
 assert.equal(theirs.code,3);assert.equal(theirs.stdout,'failed   cave_forbidden: linear\'s sign-in is Dana\'s own: only Dana marks where it writes. Dana runs: cvm connect allow-writes linear\n');
});

test('grant: set with its tools and ceiling, revoke, and decide a request, saying what became of the held deploy',async t=>{
 let hold=F.H('live');
 const f=await api(t,{
  [`POST ${C}/linear/grants`]:req=>[200,{grant:F.grant({tools:req.body.tools??[],ceiling:req.body.ceiling})}],
  [`POST ${C}/linear/grants/revoke`]:()=>[200,{revoked:true}],
  [`POST ${C}/requests/${F.ids.request}/decide`]:req=>[200,{request:F.R({state:req.body.grant?'granted':'refused',you_decide:false,decided_by_name:'Dana',reason:req.body.reason??null}),hold}],
 });
 for(const [args,path,body,line] of [
  [['grant','linear','--to','triage'],`${C}/linear/grants`,{deployment:'triage',ceiling:'write'},'granted  triage may use linear: every accepted tool, up to write.\n'],
  [['grant','linear','--to','triage','--tools','list_issues,get_issue','--ceiling','read'],`${C}/linear/grants`,{deployment:'triage',tools:['list_issues','get_issue'],ceiling:'read'},'granted  triage may use linear: list_issues and get_issue, up to read.\n'],
  [['grant','linear','--to','triage','--revoke'],`${C}/linear/grants/revoke`,{deployment:'triage'},'revoked  triage may no longer use linear.\n'],
  [['grant','--request',F.ids.request],`${C}/requests/${F.ids.request}/decide`,{grant:true},`granted  triage may use stripe (request ${F.ids.request}).\nlive     triage is live as revision 5.\n`],
 ]){
  const r=await f.run([...args,'--format','table']);
  assert.equal(r.code,0,r.stdout);
  assert.deepEqual(f.sent().at(-1),['POST',path,body]);
  assert.equal(r.stdout,line);
 }
 hold=F.H('stale');
 assert.match((await f.run(['grant','--request',F.ids.request,'--format','table'])).stdout,/\nheld {5}triage: granted; deploy again to go live\.\n$/);
 hold=F.H('pending');
 assert.match((await f.run(['grant','--request',F.ids.request,'--format','table'])).stdout,/\nwaits {4}triage still waits on other managers\.\n$/);
 hold=F.H('refused');
 const refused=await f.run(['grant','--request',F.ids.request,'--refuse','--reason','not for refunds','--format','table']);
 assert.deepEqual(f.sent().at(-1),['POST',`${C}/requests/${F.ids.request}/decide`,{grant:false,reason:'not for refunds'}]);
 assert.equal(refused.stdout,`refused  triage may not use stripe (request ${F.ids.request}).\nheld     triage's deploy does not go live.\n`);
 hold=null;
 assert.equal((await f.run(['grant','--request',F.ids.request,'--format','table'])).stdout,`granted  triage may use stripe (request ${F.ids.request}).\n`);
 const json=await f.run(['grant','--request',F.ids.request]);
 assert.equal(json.json().request.state,'granted');assert.equal(json.json().hold,null);
 const count=f.seen.length;
 for(const bad of [['grant','linear'],['grant','linear','--to','Bad_Name'],['grant','linear','--to','triage','--ceiling','admin'],['grant','linear','--to','triage','--revoke','--tools','a'],['grant','--request','nope'],['grant','linear','--request',F.ids.request],['grant','linear','--to','triage','--refuse'],['grant','--request',F.ids.request,'--to','triage'],['grant'],['grant','linear','--to','triage','--tools','a,a']]){
  const r=await f.run(bad);assert.equal(r.code,2,`${bad.join(' ')}: ${r.stdout}`);assert.equal(r.json().error.code,'cave_usage');
 }
 assert.equal(f.seen.length,count);
});

test('request and requests: ask a connector\'s managers; list what waits, and who decides',async t=>{
 let list=[F.R(),F.R({id:'00000000-0000-4000-8000-0000000000ca',connector:'linear',deployment:'support',requested_by_name:'Dana',you_decide:false,hold:null,created_at:'2026-11-19T11:30:00Z'})];
 const f=await api(t,{
  [`POST ${C}/stripe/requests`]:req=>[201,{request:F.R({want:{tools:req.body.tools??[],ceiling:req.body.ceiling??'write',args:{},unpinned:[]},hold:null,you_decide:false})}],
  [`GET ${C}/requests`]:()=>[200,{requests:list}],
 });
 let r=await f.run(['request','stripe','--for','triage','--tools','get_charge,create_refund','--ceiling','external','--format','table']);
 assert.equal(r.code,0,r.stdout);
 assert.deepEqual(f.sent().at(-1),['POST',`${C}/stripe/requests`,{deployment:'triage',tools:['get_charge','create_refund'],ceiling:'external'}]);
 assert.equal(r.stdout,`asked    stripe's managers to let triage use it: get_charge and create_refund, up to external.\nrequest  ${F.ids.request}\nsee      cvm connect requests\n`);
 r=await f.run(['request','stripe','--for','triage']);
 assert.deepEqual(f.sent().at(-1)[2],{deployment:'triage'});assert.equal(r.json().request.id,F.ids.request);
 r=await f.run(['requests','--format','table']);
 assert.equal(r.code,0,r.stdout);assert.deepEqual(f.sent().at(-1),['GET',`${C}/requests`,undefined]);
 assert.equal(r.stdout,[
  'ID                                    CONNECTOR  FOR      WHO ASKED  WHEN',
  `${F.ids.request}  stripe     triage   Sam        2026-11-19 09:58  you decide`,
  '00000000-0000-4000-8000-0000000000ca  linear     support  Dana       2026-11-19 11:30  waits',
  'decide   cvm connect grant --request ID [--refuse] [--reason TEXT]',
  ''].join('\n'));
 assert.deepEqual((await f.run(['requests'])).json(),{requests:list});
 list=[];
 assert.equal((await f.run(['requests','--format','table'])).stdout,'Nothing waits for an answer.\n');
 for(const bad of [['request','stripe'],['request','stripe','--for','triage','--ceiling','root'],['requests','extra']]){const refused=await f.run(bad);assert.equal(refused.code,2,refused.stdout);}
});

test('rm: after a yes; with no terminal it needs --yes and sends nothing',async t=>{
 const f=await api(t,{[`POST ${C}/linear/remove`]:()=>[200,{removed:true}]});
 let r=await f.run(['rm','linear','--format','table']);
 assert.equal(r.code,2);assert.equal(f.seen.length,0);
 assert.equal(r.stdout,'failed   cave_confirmation_required: Removing linear ends its sign-in, and no agent can use it again. Repeat with --yes to confirm.\nfix      cvm connect rm linear --yes\n');
 r=await f.run(['rm','linear','--format','table'],{terminal:true,answers:['']});
 assert.equal(r.code,0);assert.equal(f.seen.length,0);assert.match(r.stdout,/\[y\/N\] \nkept {5}linear: nothing removed\.\n$/);
 r=await f.run(['rm','linear','--format','table'],{terminal:true,answers:['yes']});
 assert.equal(r.code,0);assert.deepEqual(f.sent(),[['POST',`${C}/linear/remove`,{}]]);assert.match(r.stdout,/\nremoved  linear\n$/);
 r=await f.run(['rm','linear','--yes']);
 assert.deepEqual(r.json(),{removed:true});
});

test('every verb shows the API\'s refusal by code and message, and the fix it names: a fix line in a table, a fix key in JSON',async t=>{
 const refusal=F.refusal(409,'cave_code_connector_not_connected','linear has no finished sign-in yet. Sign it in first: cvm connect add linear',{connector:'linear',fix:'cvm connect add linear'});
 const routes={};
 for(const key of [`GET ${C}`,`GET ${C}/requests`,`GET ${C}/linear`,...['test','read','accept','connect','pause','resume','writes','grants','grants/revoke','requests','remove'].map(p=>`POST ${C}/linear/${p}`),`POST ${C}/requests/${F.ids.request}/decide`])routes[key]=()=>refusal;
 const f=await api(t,routes);
 for(const args of [['ls'],['test','linear'],['diff','linear'],['accept','linear'],['accept','linear','--version','2','--yes'],['rotate','linear'],['pause','linear'],['resume','linear'],['allow-writes','linear'],['grant','linear','--to','triage'],['grant','linear','--to','triage','--revoke'],['grant','--request',F.ids.request],['request','linear','--for','triage'],['requests'],['rm','linear','--yes'],['add','linear']]){
  const table=await f.run([...args,'--format','table']);
  assert.equal(table.code,4,`${args.join(' ')}: ${table.stdout}`);
  assert.equal(table.stdout.split('\n').slice(-3).join('\n'),'failed   cave_code_connector_not_connected: linear has no finished sign-in yet. Sign it in first: cvm connect add linear\nfix      cvm connect add linear\n',args.join(' '));
  const json=await f.run(args);
  assert.deepEqual(json.json(),{schema_version:1,ok:false,status:'failed',error:{code:'cave_code_connector_not_connected',message:'linear has no finished sign-in yet. Sign it in first: cvm connect add linear'},fix:'cvm connect add linear'},args.join(' '));
 }
 // A fix that is not one cvm line is not printed; a body with no envelope is never echoed.
 const g=await api(t,{[`GET ${C}`]:()=>F.refusal(409,'cave_conflict','No.',{fix:'rm -rf /'}),[`POST ${C}/linear/test`]:()=>[502,`<html>${secret}</html>`]});
 assert.deepEqual((await g.run(['ls'])).json(),{schema_version:1,ok:false,status:'failed',error:{code:'cave_conflict',message:'No.'}});
 assert.deepEqual((await g.run(['test','linear'])).json().error,{code:'cave_request_failed',message:'The connect test failed (HTTP 502).'});
});

test('a key instead of a person\'s sign-in: one sentence saying what to do, not the API\'s list of every route a key has',async t=>{
 const rule=`A Caveman API key may call only ${'GET /api/v1/somewhere, '.repeat(90)}and nothing else.`;
 const f=await api(t,{[`GET ${C}`]:()=>F.refusal(403,'cave_api_key_route_forbidden',rule),[`POST ${C}/linear/pause`]:()=>F.refusal(403,'cave_api_key_route_forbidden',rule)});
 const said='Connectors are looked after with a person\'s sign-in, and this ran with an API key. Run it without CAVE_TOKEN, after cvm login.';
 for(const args of [['ls'],['pause','linear']]){
  const table=await f.run([...args,'--format','table']);
  assert.equal(table.code,3,args.join(' '));
  assert.equal(table.stdout,`failed   cave_api_key_route_forbidden: ${said}\n`,args.join(' '));
  assert.deepEqual((await f.run(args)).json(),{schema_version:1,ok:false,status:'failed',error:{code:'cave_api_key_route_forbidden',message:said}},args.join(' '));
 }
});

test('what the API sends never reaches the terminal raw: escapes, bidi overrides, newlines in a name and a 2,000-character sentence, through every verb\'s table',async t=>{
 const evil=`ev\x1b[31mil\u{202e}txt.exe\u{2066}\nINJECTED\r\x07 \u{2028}two\x9b31m\u{feff}\u{61c}\u{e0041}`;
 const long='A sentence that goes on '+'and on '.repeat(300)+'.';
 const k=over=>F.connector({name:evil,address:`https://x.example/${evil}`,description:long,paused:{by_user_id:F.ids.dana,by_name:evil,at:'2026-11-19T09:00:00Z',reason:long},
  connection:F.connection({signed_in_by_name:evil,problem:long,writes_in:[evil]}),...F.used({used_by:[{deployment_id:F.ids.deployment,deployment:evil,tools:1,ceiling:evil}]}),...over});
 const toolOf=change=>({name:evil,effect:'external',change,changed:[evil,long],line:`${evil}  ${long}`});
 const read={connector:evil,same:false,accepted:{version:2,accepted_at:evil,tools:1},proposed:{version:3,read_at:evil,tools:[toolOf('added'),toolOf('changed'),toolOf('same')],removed:[evil,long],problems:[{tool:evil,kind:evil,line:long}]}};
 const r=F.R({connector:evil,deployment:evil,requested_by_name:evil,created_at:evil,state:evil,you_decide:false});
 const at=time=>[200,{connector:k({connection:F.connection({signed_in_by_name:evil,updated_at:time,signed_in_at:time,writes_in:[]})})}];
 const f=await api(t,{
  [`GET ${C}`]:()=>[200,{connectors:[k(),k({scope:'personal'}),{...F.theirs,name:evil,host:evil,owner_name:long}]}],
  [`GET ${C}/linear`]:reads(notFound,at('2026-11-19T10:00:00Z'),at('2026-11-19T10:05:00Z'),at('2026-11-19T10:05:00Z'),at('2026-11-19T10:06:00Z')),
  [`POST ${C}`]:()=>[201,{connector:k(),authorize_url:F.authorize}],
  [`POST ${C}/linear/connect`]:()=>[200,{authorize_url:F.authorize}],
  [`POST ${C}/linear/read`]:()=>[200,read],
  [`POST ${C}/linear/accept`]:()=>[200,{connector:evil,pin:{version:evil,accepted_at:evil,tools:evil},effects:{read:evil,write:1}}],
  [`POST ${C}/linear/test`]:()=>[200,{connector:evil,ok:false,problem:`${evil} ${long}`}],
  [`POST ${C}/linear/pause`]:()=>[200,{connector:k()}],
  [`POST ${C}/linear/resume`]:()=>[200,{connector:k()}],
  [`POST ${C}/linear/writes`]:()=>[200,{connector:k()}],
  [`POST ${C}/linear/grants`]:()=>[200,{grant:F.grant({deployment:evil,tools:[evil,long],ceiling:evil})}],
  [`POST ${C}/linear/grants/revoke`]:()=>[200,{revoked:evil}],
  [`POST ${C}/linear/requests`]:()=>[201,{request:{...r,id:evil}}],
  [`GET ${C}/requests`]:()=>[200,{requests:[r,{...r,you_decide:true,id:evil}]}],
  [`POST ${C}/requests/${F.ids.request}/decide`]:()=>[200,{request:r,hold:{id:evil,state:evil,deployment:{id:evil,name:evil,revision:evil}}}],
  [`POST ${C}/linear/remove`]:()=>[200,{removed:evil}],
  [`POST ${C}/other/test`]:()=>F.refusal(409,'cave_code_connector_paused',`${evil} ${long}`,{connector:evil,fix:`cvm connect resume ${evil}`}),
 });
 const outputs=[];
 for(const args of [['add','linear','--yes'],['ls'],['test','linear'],['diff','linear'],['accept','linear','--yes'],['rotate','linear'],['pause','linear'],['resume','linear'],['allow-writes','linear'],['grant','linear','--to','triage'],['grant','linear','--to','triage','--revoke'],['grant','--request',F.ids.request],['request','linear','--for','triage'],['requests'],['rm','linear','--yes'],['test','other']]){
  const result=await f.run([...args,'--format','table'],{terminal:true,answers:['y','y']});
  outputs.push([args.join(' '),result.stdout]);
 }
 for(const [what,out] of outputs){
  assert.ok(out.length>0,what);
  assert.doesNotMatch(out,/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{2028}\u{2029}\p{Cf}]/u,`${what}: a control or formatting character reached the terminal`);
  for(const line of out.split('\n')){
   assert.ok(!line.startsWith('INJECTED'),`${what}: a newline in a name started a line`);
   assert.ok(Array.from(line).length<=800,`${what}: a line of ${line.length} characters`);
  }
 }
 // A 2,000-character sentence is cut, and says so.
 assert.match(outputs.find(([what])=>what==='test linear')[1],/…\n$/);
});

test('help: the family, each verb, and the rows cvm.mjs lists, with no sign-in and no request; cvm --help lists the connect rows',async t=>{
 const f=await api(t);
 const verbs=['add','ls','test','diff','accept','rotate','pause','resume','allow-writes','grant','request','requests','rm'];
 const [top,dispatcher,verbHelps,bare,screen,unknown,cvmTop,cvmScreen]=await Promise.all([
  f.spawned(['connect','--help']),
  readFile(bin,'utf8'),
  mapPool(verbs,verb=>f.spawned(['connect',verb,'--help'])),
  f.spawned(['connect']),
  f.spawned(['connect','--help','--format','table']),
  f.spawned(['connect','lst']),
  f.spawned(['--help','--format','json']),
  f.spawned(['--help','--format','table']),
 ]);
 assert.equal(top.code,0,top.stdout);
 assert.deepEqual(top.json().commands.map(c=>c.verb),verbs);
 for(const command of top.json().commands){
  assert.match(command.usage,new RegExp(`^cvm connect ${command.verb} `.replace(/ $/,'( |$)')));
  assert.ok(dispatcher.includes(`{id:'connect.${command.verb}',usage:'${command.usage.replace(/'/g,"\\'")}',`),`cvm.mjs lists cvm connect ${command.verb} as its help does`);
 }
 verbs.forEach((verb,i)=>{
  const r=verbHelps[i];
  assert.equal(r.code,0,r.stdout);assert.match(r.json().usage,new RegExp(`^cvm connect ${verb}( |$)`));
 });
 assert.equal(bare.code,0);assert.equal(bare.json().usage,'cvm connect VERB [NAME] [flags] [--format json|table]');
 assert.match(screen.stdout,/^Connectors: the servers your organization's agents use, signed in once for the team\.\n\n {2}cvm connect add TEMPLATE\|URL /);
 assert.equal(unknown.code,2);assert.match(unknown.json().error.message,/^Unknown connect command lst\./);
 assert.ok(cvmTop.json().families.includes('connect'));
 assert.equal(cvmTop.json().connect,'cvm connect add NAME | cvm connect ls | cvm connect diff|accept NAME | cvm connect grant NAME');
 assert.match(cvmScreen.stdout,/\nConnect\n {2}cvm connect add NAME +add a connector and sign it in for the team\n {2}cvm connect ls +state, sign-in, tools and who uses each\n {2}cvm connect diff\|accept NAME +what changed upstream; accept its tools\n {2}cvm connect grant NAME +let a deployment use one, or answer a request\n\nDeploy\n/);
 assert.deepEqual(f.seen,[]);
});

test('cvm connect as a person types it: cvm.mjs dispatches, signs in as every verb does, and prints JSON with no terminal',async t=>{
 const f=await api(t,{[`GET ${C}`]:()=>[200,{connectors:[F.connector()]}],[`POST ${C}/linear/test`]:()=>[200,F.testOk]});
 const [ls,table,rm,signedOut]=await Promise.all([
  f.spawned(['connect','ls']),
  f.spawned(['connect','test','linear','--format','table']),
  f.spawned(['connect','rm','linear']),
  f.spawned(['connect','ls'],{CAVE_API_URL:'http://127.0.0.1:9'}),
 ]);
 assert.equal(ls.code,0,ls.stdout+ls.stderr);assert.equal(ls.json().connectors[0].name,'linear');
 assert.equal(f.seen.find(r=>r.path===C).headers.authorization,`Bearer ${secret}`);
 assert.equal(table.stdout,'ok       linear  23 tools in 412 ms\n');
 // No terminal: an add waits with no browser and no question, and rm needs --yes.
 assert.equal(rm.code,2);assert.equal(rm.json().fix,'cvm connect rm linear --yes');
 assert.equal(signedOut.code,3);assert.equal(signedOut.json().error.code,'cave_auth_required');
});

});
