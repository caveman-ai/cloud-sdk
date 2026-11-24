// `cvm sandbox` against the recorded wire (public/sdk/parity/sandboxes-wire.json, served by the
// SDK's fake Cloud): the installed command, run as a user runs it, in an isolated HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startFake,wire} from '../../sdk-ts/tests/sandbox-fake.mjs';
import {verbs} from '../bin/sandbox.mjs';

const bin=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const key='cave_live_wire';
const id=wire.rest.create.answer.id;

async function cvm(t,options={}){
 const fake=await startFake(options);
 const home=await mkdtemp(join(tmpdir(),'cvm-sandbox-'));
 t.after(async()=>{await fake.close();await rm(home,{recursive:true,force:true});});
 const run=(args,{stdin,env={}}={})=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[bin,...args],{cwd:home,env:{HOME:home,USERPROFILE:home,CAVEMAN_HOME:join(home,'.caveman'),PATH:process.env.PATH,CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',
   CAVE_API_URL:fake.url,CAVE_TOKEN:key,...env},stdio:[stdin===undefined?'ignore':'pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  if(stdin!==undefined)child.stdin.end(stdin);
  child.on('error',reject);child.on('close',code=>{
   assert.ok(!(stdout+stderr).includes(key),'must not print the key');
   resolve({code,stdout,stderr,json:()=>JSON.parse(stdout)});
  });
 });
 return {fake,run,home};
}

test('create waits until the sandbox runs; list, get, sleep, resume and delete read as a person reads them', async t => {
 const {fake,run}=await cvm(t);
 let r=await run(['sandbox','create','--name','wire','--sleep-after','0','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.match(r.stdout,new RegExp(`sandbox +${id}\\n`));
 assert.match(r.stdout,/state +running\n/);
 assert.match(r.stdout,/size +default\n/);
 assert.match(r.stdout,/sleeps after +never\n/);
 assert.match(r.stdout,new RegExp(`Run a command in it: cvm sandbox exec ${id} -- uname -a`));
 // The wait is one read the API holds until the sandbox runs (wait_for), not a poll.
 assert.deepEqual(fake.state.seen.map(s=>[s.method,s.path,s.body]),[['POST','/api/v1/code/computers','{"name":"wire","sleep_after_seconds":0}'],['GET',`/api/v1/code/computers/${id}?wait_for=running&timeout=60`,'']]);
 r=await run(['sandbox','list','--format','table']);
 assert.equal(r.code,0);
 assert.match(r.stdout,/^SANDBOX +NAME +STATE +SIZE +MADE\n/);
 assert.match(r.stdout,new RegExp(`${id} +wire +running +default`));
 r=await run(['sandbox','list','--mine']);
 assert.equal(r.json().computers[0].id,id);
 r=await run(['sandbox','sleep',id,'--format','table']);
 assert.match(r.stdout,/state +running, going to sleep\n/);
 r=await run(['sandbox','resume',id,'--no-wait','--format','table']);
 assert.match(r.stdout,/state +asleep, waking\n/);
 r=await run(['sandbox','delete',id,'--yes','--format','table']);
 assert.equal(r.stdout,`Deleted ${id}.\n`);
 // A delete asked again answers the deleted sandbox, as the first did.
 r=await run(['sandbox','delete',id,'--yes','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(r.stdout,`Deleted ${id}.\n`);
 assert.deepEqual(fake.state.errors,[]);
});

test('exec streams the command\'s stdout and stderr apart and exits with its exit code; -i sends stdin', async t => {
 const {fake,run}=await cvm(t);
 let r=await run(['sandbox','exec',id,'--','sh','-c','echo hello from the sandbox; echo careful >&2; exit 7']);
 assert.deepEqual([r.code,r.stdout,r.stderr],[7,'hello from the sandbox\n','careful\n']);
 r=await run(['sandbox','exec','-i',id,'--','cat'],{stdin:'stdin reaches it'});
 assert.deepEqual([r.code,r.stdout,r.stderr],[0,'stdin reaches it','']);
 r=await run(['sandbox','exec',id,'--','sh','-c',"head -c 40000 /dev/zero | tr '\\0' a"]);
 assert.equal(r.code,0);
 assert.equal(r.stdout,'a'.repeat(40000));
 r=await run(['sandbox','exec','-t',id,'--','sh']);
 assert.equal(r.code,2);
 assert.match(r.stderr,/-t gives the command a terminal, and this input is not one/);
 assert.deepEqual(fake.state.errors,[]);
});

test('a refused command says why on stderr, with the code, and exits as the CLI does', async t => {
 // A refused command reads the sandbox to say whether it sleeps or is still starting.
 let asked='suspended';
 const {fake,run}=await cvm(t,{rest:(req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({...wire.rest.get.answer,desired_state:asked}))});
 const refused=async(setup,args=['true'])=>{Object.assign(fake.state,{replay:'',refuse:'',closeRaw:null},setup);return run(['sandbox','exec',id,'--',...args]);};
 let r=await refused({refuse:'asleep'});
 assert.equal(r.code,4);
 assert.equal(r.stdout,'');
 assert.equal(r.stderr,`failed   cave_code_computer_not_running: the computer is not running; resume it first. Wake it with: cvm sandbox resume ${id}\n`);
 asked='running';
 r=await refused({refuse:'asleep'});
 assert.equal(r.stderr,`failed   cave_code_computer_not_running: The sandbox is still starting: run the command again once cvm sandbox get ${id} says running.\n`);
 r=await refused({refuse:'unknown'});
 assert.equal(r.code,1);
 assert.equal(r.stderr,'failed   cave_not_found: Computer not found.\n');
 // A sandbox that takes no options: the flags that asked for one are named.
 Object.assign(fake.state,{replay:'stdin',refuse:'',closeRaw:4405});
 r=await run(['sandbox','exec','-w','/tmp',id,'--','true']);
 assert.equal(r.code,1);
 assert.equal(r.stderr,'failed   cave_code_computer_unsupported: The sandbox cannot do what was asked. This sandbox runs commands without options: leave out -e, -w and -u.\n');
 r=await refused({replay:'stdin',closeRaw:4410});
 assert.match(r.stderr,/^failed   cave_code_computer_stopped: .* It was put to sleep or deleted while the command ran\.\n/);
 // A host restarting: opened again (the SDK's bound), then said, and exit 7 (try again).
 const opens=()=>fake.state.seen.filter(s=>s.upgrade).length;
 let before=opens();
 r=await refused({hostDown:2,retryAfter:0,replay:'large'});
 assert.equal(r.code,0,r.stderr);
 assert.equal(opens()-before,3);
 before=opens();
 r=await refused({hostDown:9,retryAfter:0});
 assert.equal(r.code,7);
 assert.equal(opens()-before,5);
 assert.match(r.stderr,/^failed   cave_code_computer_host_unreachable: .* Its host is restarting; cvm tried again for as long as it may\. Run the command again in a moment\.\n$/);
 Object.assign(fake.state,{hostDown:0});
});

test('exec sets the command\'s environment and folder, and Ctrl-C sends it INT', async t => {
 const {fake,run}=await cvm(t);
 const said=name=>wire.exec[name].server.filter(m=>m.channel===1).map(m=>m.data).join('');
 let r=await run(['sandbox','exec','-w','/tmp',id,'--','pwd']);
 assert.deepEqual([r.code,r.stdout,r.stderr],[0,said('start_with_cwd'),'']);
 r=await run(['sandbox','exec','-e','GREETING=hello env',id,'--','sh','-c','echo "$GREETING"']);
 assert.deepEqual([r.code,r.stdout,r.stderr],[0,'hello env\n','']);
 for(const [args,message] of [[['-e','NOEQUALS'],/-e is KEY=VALUE/],[['-e','=x'],/-e is KEY=VALUE/],[['-w','relative'],/-w is an absolute folder/]]){
  r=await run(['sandbox','exec',...args,id,'--','true']);
  assert.equal(r.code,2);
  assert.match(r.stderr,message);
 }
 // Ctrl-C: the command is sent INT (the recording's: it ends on it, 130), and cvm exits with its code.
 // Windows has no interrupt one process can send another: child.kill('SIGINT') ends cvm outright
 // there (TerminateProcess, exit code null), so cvm never hears it and only POSIX can check this.
 if(process.platform!=='win32'){
  const opened=()=>fake.state.seen.filter(s=>s.upgrade).length,before=opened();
  const child=spawn(process.execPath,[bin,'sandbox','exec',id,'--','sleep','5'],{env:{HOME:tmpdir(),PATH:process.env.PATH,CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',CAVE_API_URL:fake.url,CAVE_TOKEN:key},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  const exited=new Promise(resolve=>child.on('close',resolve));
  for(let i=0;i<500&&opened()===before;i++)await new Promise(resolve=>setTimeout(resolve,10));
  await new Promise(resolve=>setTimeout(resolve,200));
  child.kill('SIGINT');
  assert.equal(await exited,130);
 }
 assert.deepEqual(fake.state.errors,[]);
});

test('a sandbox\'s reason reads by its code: one that passes is waiting, one that needs the caller says so', async t => {
 const box=(n,observed,code,reason)=>({...wire.rest.get.answer,id:`01a1f63d-7fd5-782d-9c0e-c5656bcf81${n}`,name:`box-${n}`,desired_state:'running',observed_state:observed,
  observed_reason:reason,...(code?{observed_reason_code:code}:{})});
 const computers=[box(10,'failed','host_unavailable','Its host is restarting or not answering just now; Cloud tries again in a moment.'),
  box(11,'starting','waiting_for_capacity','Waiting for room: Cloud is short of capacity for this computer right now and keeps trying.'),
  box(12,'stopped','stopped_by_host','Its host restarted or ran short of memory, so it was stopped; its disk is kept. Start it again.'),
  box(13,'failed','internal_error','Cloud could not do this just now (reference 0a1b2c3d); it is tried again, and the operator can find why with that reference.'),
  box(14,'failed','a_later_code','went wrong'),box(15,'starting','booting','booting')];
 const {run}=await cvm(t,{rest:(req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({cloud_computers:true,computers_api:true,computers,next_cursor:null}))});
 const r=await run(['sandbox','list','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 const said=Object.fromEntries([...r.stdout.matchAll(/box-(\d+) +(.+?) +default/g)].map(m=>[m[1],m[2]]));
 assert.deepEqual(said,{'10':'waiting: Its host is restarting or not answering just now; Cloud tries again in a moment.',
  '11':'starting: Waiting for room: Cloud is short of capacity for this computer right now and keeps trying.',
  '12':'asleep: Its host restarted or ran short of memory, so it was stopped; its disk is kept. Start it again.',
  '13':'failed: Cloud could not do this just now (reference 0a1b2c3d); it is tried again, and the operator can find why with that reference.',
  '14':'failed: went wrong','15':'starting: booting'});
});

test('create asks a lifetime and a network, and get says them with the pause', async t => {
 const bodies=[];
 const made={...wire.rest.create.answer,network:'none',expires_at:'2026-11-20T08:00:00Z',idle:{pause_after_seconds:120}};
 const {run}=await cvm(t,{rest:(req,res,body)=>{
  if(req.method==='POST')bodies.push(JSON.parse(body));
  res.writeHead(req.method==='POST'?201:200,{'content-type':'application/json'}).end(JSON.stringify(made));
 }});
 let r=await run(['sandbox','create','--lifetime','2h','--network','none','--no-wait','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.deepEqual(bodies,[{lifetime_seconds:7200,network:'none'}]);
 assert.match(r.stdout,/pauses after +2m idle\n/);
 assert.match(r.stdout,/network +none\n/);
 assert.match(r.stdout,/deleted at +2026-11-20T08:00:00Z\n/);
 r=await run(['sandbox','get',id,'--format','table']);
 assert.match(r.stdout,/deleted at +2026-11-20T08:00:00Z\n/);
 // Refused before anything is sent: a lifetime out of its bounds, a network cvm does not know.
 for(const [args,said] of [[['--lifetime','30s'],/--lifetime is a time from 1m to 30d/],[['--lifetime','31d'],/--lifetime is a time from 1m to 30d/],[['--network','vpn'],/--network is none/]]){
  r=await run(['sandbox','create',...args,'--format','table']);
  assert.equal(r.code,2);
  assert.match(r.stdout,said);
 }
 assert.equal(bodies.length,1);
});

test('list reads every page, following next_cursor to the last', async t => {
 const box=n=>({...wire.rest.get.answer,id:`01a1f63d-7fd5-782d-9c0e-c5656bcf80${n}`,name:`box-${n}`});
 const pages={'/api/v1/code/computers':{computers:[box(10),box(11)],next_cursor:'p2'},'/api/v1/code/computers?cursor=p2':{computers:[box(12)],next_cursor:'p3'},
  '/api/v1/code/computers?cursor=p3':{computers:[box(13)],next_cursor:null},'/api/v1/code/computers?mine=true':{computers:[box(10)],next_cursor:'m2'},
  '/api/v1/code/computers?mine=true&cursor=m2':{computers:[box(14)],next_cursor:null}};
 const {fake,run}=await cvm(t,{rest:(req,res)=>{
  const page=pages[req.url];
  res.writeHead(page?200:418,{'content-type':'application/json'}).end(JSON.stringify(page&&{cloud_computers:true,computers_api:true,...page}));
 }});
 let r=await run(['sandbox','list','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.deepEqual([...r.stdout.matchAll(/box-(\d+)/g)].map(m=>m[1]),['10','11','12','13']);
 r=await run(['sandbox','list','--mine']);
 assert.deepEqual(r.json().computers.map(c=>c.name),['box-10','box-14']);
 assert.equal(r.json().next_cursor,null);
 assert.deepEqual(fake.state.seen.map(s=>s.path),[...Object.keys(pages)]);
});

test('with the switch off, or a sign-in that is not a key, cvm says what to do', async t => {
 const {run}=await cvm(t,{rest:(req,res)=>{
  const c=req.method==='POST'?wire.rest.off_create:wire.rest.off_list;
  res.writeHead(c.status,{'content-type':'application/json'}).end(JSON.stringify(c.answer));
 }});
 // A key: 403 cave_api_key_route_forbidden on a GET, 405 on a create. Each is the one line.
 const offLine='failed   cave_sandboxes_off: Sandboxes are switched off on this Caveman Cloud (computers.api.enabled): ask its admin to turn them on.\n';
 let r=await run(['sandbox','list','--format','table']);
 assert.equal(r.code,4);
 assert.equal(r.stdout,offLine);
 r=await run(['sandbox','get',id,'--format','table']);
 assert.deepEqual([r.code,r.stdout],[4,offLine]);
 r=await run(['sandbox','create','--no-wait']);
 assert.equal(r.code,4);
 assert.deepEqual(r.json().error,{code:'cave_sandboxes_off',message:'Sandboxes are switched off on this Caveman Cloud (computers.api.enabled): ask its admin to turn them on.'});
 const home=await mkdtemp(join(tmpdir(),'cvm-sandbox-none-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 r=await run(['sandbox','list','--format','table'],{env:{CAVE_RELAY_URL:'http://10.0.0.5:8080'}});
 assert.equal(r.code,2);
 assert.match(r.stdout,/^failed   cave_endpoint_invalid: relayURL: use an HTTPS origin/);
 r=await run(['sandbox','list'],{env:{CAVE_TOKEN:'',HOME:home,CAVEMAN_HOME:join(home,'.caveman')}});
 assert.equal(r.code,3);
 assert.equal(r.json().error.code,'cave_auth_required');
});

test('a person\'s sign-in with the switch off: a list without computers_api, a get without bare, is the one line too', async t => {
 // Off, a person's list and get answer as before the computers API existed: the organization's computers, no facts.
 const {answer}=wire.rest.get;
 const before=Object.fromEntries(Object.entries(answer).filter(([k])=>!['created_by','service_account_id','service_account_name','bare','sleep_after_seconds','exec_url','usage'].includes(k)));
 const {run}=await cvm(t,{key:'person-token',rest:(req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(req.url.startsWith('/api/v1/code/computers/')?before:{computers:[before],cloud_computers:true,caveman_on_computers:false}))});
 for(const args of [['sandbox','list','--format','table'],['sandbox','get',id,'--format','table']]){
  const r=await run(args,{env:{CAVE_TOKEN:'person-token'}});
  assert.deepEqual([r.code,r.stdout],[4,'failed   cave_sandboxes_off: Sandboxes are switched off on this Caveman Cloud (computers.api.enabled): ask its admin to turn them on.\n'],args.join(' '));
 }
});

test('a person\'s sign-in refused on a sandbox is told to use a code:run key', async t => {
 const {run}=await cvm(t,{key:'person-token',rest:(req,res)=>res.writeHead(403,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'cave_forbidden',message:'Only a person signed in to Caveman Cloud on the web can use this computer from outside it.'}}))});
 const r=await run(['sandbox','create','--no-wait','--format','table'],{env:{CAVE_TOKEN:'person-token'}});
 assert.equal(r.code,3);
 assert.match(r.stdout,/^failed   cave_forbidden: Only a person signed in .* Sandboxes are made and used with an organization's code:run key: set CAVE_TOKEN to one \(cave_live_\.\.\.\)\.\n$/);
});

test('cvm login refused a sandbox, on a create and on a command, says plainly to use a code:run key', async t => {
 // The API's refusal of a device login (code/computer_tickets.go errDeviceLogin), before a create and before a stream's upgrade.
 const refusal={error:{type:'cave_gateway_error',code:'cave_code_computer_device_login_forbidden',message:'A device sign-in (cvm login) cannot make or enter a sandbox. Use an organization\'s code:run key (cave_live_..., made under Settings > Service accounts), or the console on the web.'}};
 wire.refusals.device_login={status:403,content_type:'application/json',body:JSON.stringify(refusal)+'\n'};
 const {fake,run}=await cvm(t,{key:'device-token',rest:(req,res)=>res.writeHead(403,{'content-type':'application/json'}).end(JSON.stringify(refusal))});
 const said='cvm login cannot make or enter a sandbox. Set CAVE_TOKEN to an organization\'s code:run key (cave_live_...), made under Settings > Service accounts.';
 let r=await run(['sandbox','create','--no-wait','--format','table'],{env:{CAVE_TOKEN:'device-token'}});
 assert.equal(r.code,3);
 assert.equal(r.stdout,`failed   cave_code_computer_device_login_forbidden: ${said}\n`);
 fake.state.refuse='device_login';
 r=await run(['sandbox','exec',id,'--','true'],{env:{CAVE_TOKEN:'device-token'}});
 assert.equal(r.code,3);
 assert.equal(r.stdout,'');
 assert.equal(r.stderr,`failed   cave_code_computer_device_login_forbidden: ${said}\n`);
});

test('cp copies a file into a sandbox and out of it, whole or not at all; ls lists a folder', async t => {
 const {fake,run,home}=await cvm(t);
 const local=join(home,'run.sh');
 await writeFile(local,'#!/bin/sh\necho from the sandbox\n');
 await chmod(local,0o750);
 let r=await run(['sandbox','cp',local,`${id}:/`,'--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(r.stdout,`Copied 32 bytes to ${id}:/run.sh.\n`);
 // The file keeps its permission bits; stdin (-) is written as it comes. A Windows file has no
 // permission bits (Node reports 0o666 for any writable one), so from there cvm sends none and the
 // sandbox's 0o644 applies.
 const windows=process.platform==='win32';
 assert.deepEqual(fake.state.fileOps.map(o=>[o.op,o.path,o.mode]),[['write','/run.sh',windows?undefined:0o750]]);
 r=await run(['sandbox','cp','-',`${id}:/notes.txt`],{stdin:'from this terminal'});
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.deepEqual([r.json().path,r.json().file.size],['/notes.txt',18]);
 r=await run(['sandbox','ls',id,'/','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(r.stdout,`MODE        SIZE  MODIFIED              NAME\n-rw-r--r--  18    2026-11-20T05:00:00Z  notes.txt\n${windows?'-rw-r--r--':'-rwxr-x---'}  32    2026-11-20T05:00:00Z  run.sh\n`);
 assert.deepEqual(r.stdout&&(await run(['sandbox','ls',id,'/'])).json().entries.map(e=>e.name),['notes.txt','run.sh']);
 // Out of it: into a folder here, under its own name, executable as it was; to stdout, only its bytes.
 await mkdir(join(home,'out'));
 r=await run(['sandbox','cp',`${id}:/run.sh`,join(home,'out'),'--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(r.stdout,`Copied 32 bytes from ${id}:/run.sh to ${join(home,'out','run.sh')}.\n`);
 assert.equal(await readFile(join(home,'out','run.sh'),'utf8'),'#!/bin/sh\necho from the sandbox\n');
 // (Windows has no executable bit to give it.)
 if(!windows)assert.ok((await stat(join(home,'out','run.sh'))).mode&0o100,'an executable there is one here');
 r=await run(['sandbox','cp',`${id}:/notes.txt`,'-']);
 assert.deepEqual([r.code,r.stdout,r.stderr],[0,'from this terminal','']);
 // A file the sandbox does not have: its code and words, and no half file left here.
 r=await run(['sandbox','cp',`${id}:/gone.txt`,join(home,'out','gone.txt'),'--format','table']);
 assert.equal(r.code,1);
 assert.match(r.stdout,/^failed   cave_code_computer_file_not_found: open \/gone\.txt: no such file or directory\n$/);
 assert.deepEqual(await readdir(join(home,'out')),['run.sh']);
 r=await run(['sandbox','cp',`${id}:/gone.txt`,'-']);
 assert.equal(r.code,1);
 assert.equal(r.stdout,'');
 assert.match(r.stderr,/cave_code_computer_file_not_found/);
 r=await run(['sandbox','ls',id,'/nowhere','--format','table']);
 assert.equal(r.code,1);
 assert.match(r.stdout,/cave_code_computer_file_not_found/);
 // Refused before anything is sent: both sides here, a relative path there, a folder here, a file not here.
 const before=fake.state.fileOps.length;
 for(const [args,said] of [
  [[local,join(home,'x')],/One side is the sandbox's/],
  [[local,`${id}:run.sh`],/A path in a sandbox is absolute/],
  [[join(home,'out'),`${id}:/out`],/is a folder: cp copies one file/],
  [[join(home,'missing'),`${id}:/m`],/^failed   cave_local_file_not_found: There is no .*missing here\.\n$/],
  [['-',`${id}:/`],/Name the file to write in the sandbox/],
 ]){
  r=await run(['sandbox','cp',...args,'--format','table']);
  assert.ok(r.code>0,args.join(' '));
  assert.match(r.stdout,said);
 }
 r=await run(['sandbox','ls',id,'relative','--format','table']);
 assert.equal(r.code,2);
 assert.equal(fake.state.fileOps.length,before);
 assert.deepEqual(fake.state.errors,[]);
});

test('port-forward carries each connection here to the sandbox\'s port, says a refused one on stderr, and ends on Ctrl-C', async t => {
 const {fake,home}=await cvm(t);
 const child=spawn(process.execPath,[bin,'sandbox','port-forward',id,'0:8080','--format','json'],{cwd:home,env:{HOME:home,USERPROFILE:home,CAVEMAN_HOME:join(home,'.caveman'),PATH:process.env.PATH,CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',
  CAVE_API_URL:fake.url,CAVE_TOKEN:key},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill('SIGKILL'));
 let stdout='',stderr='';
 child.stderr.on('data',d=>stderr+=d);
 const exited=new Promise(resolve=>child.on('close',resolve));
 const said=await new Promise((resolve,reject)=>{
  child.stdout.on('data',d=>{stdout+=d;if(stdout.includes('\n'))resolve(JSON.parse(stdout.split('\n')[0]));});
  child.on('close',()=>reject(new Error('cvm ended: '+stdout+stderr)));
 });
 assert.deepEqual([said.sandbox,said.port],[id,8080]);
 assert.match(said.local,/^127\.0\.0\.1:\d+$/);
 const talk=text=>new Promise((resolve,reject)=>{
  const socket=connect(Number(said.local.split(':')[1]),'127.0.0.1');
  let heard='';
  socket.on('data',d=>heard+=d);
  socket.on('error',reject);
  socket.on('close',()=>resolve(heard));
  socket.end(text);
 });
 assert.equal(await talk('hello port'),'HELLO PORT');
 assert.equal(await talk('again'),'AGAIN');
 assert.deepEqual(fake.state.dialed,['8080','8080']);
 fake.state.portRefused=true;
 assert.equal(await talk('anyone?'),'');
 for(let i=0;i<100&&!stderr.includes('\n');i++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(stderr,'failed   cave_code_computer_port_refused: nothing listens on port 8080\n');
 // Ctrl-C ends it as a success. Windows has no interrupt one process can send another: kill ends
 // cvm outright there (TerminateProcess, exit code null), so only POSIX can check how it ends.
 const windows=process.platform==='win32';
 child.kill(windows?undefined:'SIGINT');
 const code=await exited;
 if(!windows)assert.equal(code,0);
 assert.ok(!(stdout+stderr).includes(key),'must not print the key');
 assert.deepEqual(fake.state.errors,[]);
});

test('port-forward refuses a port that is not one, and a sandbox it cannot read, before it listens', async t => {
 // The key's 403 while the computers API is off.
 const {fake,run}=await cvm(t,{rest:(req,res)=>res.writeHead(wire.rest.off_list.status,{'content-type':'application/json'}).end(JSON.stringify(wire.rest.off_list.answer))});
 for(const port of ['0','65536','80:','a:80','1:2:3']){
  const r=await run(['sandbox','port-forward',id,port,'--format','table']);
  assert.equal(r.code,2,port);
  assert.match(r.stdout,/The port is a number from 1 to 65535/);
 }
 assert.deepEqual(fake.state.seen,[]);
 const r=await run(['sandbox','port-forward',id,'8080','--format','table']);
 assert.equal(r.code,4);
 assert.match(r.stdout,/^failed   cave_sandboxes_off: /);
 assert.equal(fake.state.dialed,undefined);
});

test('status reads whether sandboxes work right now, and says so when this Cloud does not publish it', async t => {
 const status={state:'degraded',checked_at:'2026-11-19T12:00:05Z',last_round_at:'2026-11-19T12:00:00Z',interval_seconds:60,stale_after_seconds:300,window_seconds:3600,
  probes:[{name:'create',state:'ok',last_success_at:'2026-11-19T12:00:00Z',attempts:60,failures:0,p50_ms:210,p95_ms:480},
   {name:'running',state:'ok',last_success_at:'2026-11-19T12:00:00Z',attempts:60,failures:0,p50_ms:800,p95_ms:1200},
   {name:'exec_open',state:'degraded',last_success_at:'2026-11-19T12:00:00Z',attempts:60,failures:2,p50_ms:50,p95_ms:90},
   {name:'command',state:'ok',last_success_at:'2026-11-19T12:00:00Z',attempts:58,failures:0,p50_ms:100,p95_ms:140},
   {name:'delete',state:'unknown',last_success_at:null,attempts:0,failures:0,p50_ms:null,p95_ms:null}],
  create_to_command:{state:'ok',threshold_ms:2000,p95_ms:1400}};
 let served=true;
 const {fake,run}=await cvm(t,{rest:(req,res)=>{
  if(served&&req.method==='GET'&&req.url==='/api/v1/status/sandboxes')res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(status));
  else res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({error:{type:'cave_gateway_error',code:'cave_not_found',message:'Not found.',request_id:'req_1'}}));
 }});
 let r=await run(['sandbox','status','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.match(r.stdout,/^sandboxes degraded, as of 2026-11-19T12:00:05Z; the canary's last round ended 2026-11-19T12:00:00Z\n\nSTEP +STATE +LAST PASSED +ATTEMPTS +FAILED +P50 +P95\n/);
 assert.match(r.stdout,/\nexec_open +degraded +2026-11-19T12:00:00Z +60 +2 +50ms +90ms\n/);
 assert.match(r.stdout,/\ndelete +unknown +- +0 +0 +- +-\n/);
 assert.match(r.stdout,/\nnew sandbox to its first command: ok, p95 1400ms \(objective 2000ms\); counted over the last 60 minutes\n$/);
 r=await run(['sandbox','status']);
 assert.deepEqual(r.json(),status);
 assert.deepEqual(fake.state.seen.map(s=>[s.method,s.path]),[['GET','/api/v1/status/sandboxes'],['GET','/api/v1/status/sandboxes']]);
 served=false;
 r=await run(['sandbox','status','--format','table']);
 assert.deepEqual([r.code,r.stdout],[4,'failed   cave_sandbox_status_off: This Caveman Cloud does not publish whether sandboxes work (computers.status.enabled): ask its admin.\n']);
 r=await run(['sandbox','status','extra']);
 assert.equal(r.code,2);
});

// The recorded snapshot of the recorded sandbox (the lab's: wire.rest.snapshot).
const snap=wire.rest.snapshot.answer,box=snap.computer_id;

test('snapshot waits until it is ready; snapshots, restore, fork and snapshot-delete read as a person reads them', async t => {
 const {fake,run}=await cvm(t);
 let r=await run(['sandbox','snapshot',box,'--name','wire','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.match(r.stdout,new RegExp(`^snapshot +${snap.id}\nsandbox +${box}\nname +wire\nstate +ready\n`));
 assert.match(r.stdout,new RegExp(`\ntaken +${wire.rest.get_snapshot.answer.ready_at.replaceAll('.','\\.')}\n`));
 assert.match(r.stdout,new RegExp(`\nMake a sandbox from it: cvm sandbox fork ${box} ${snap.id}\n$`));
 const base=`/api/v1/code/computers/${box}/snapshots`;
 assert.deepEqual(fake.state.seen.map(s=>[s.method,s.path,s.body]),[['POST',base,'{"name":"wire"}'],['GET',`${base}/${snap.id}`,'']]);
 r=await run(['sandbox','snapshots',box,'--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.match(r.stdout,/^SNAPSHOT +STATE +NAME +ASKED +TAKEN\n/);
 assert.match(r.stdout,new RegExp(`\n${snap.id} +ready +wire +`));
 r=await run(['sandbox','restore',box,snap.id,'--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.match(r.stdout,new RegExp(`\nrestore +restored ${wire.rest.get_snapshot_restored.answer.restore.done_at.replaceAll('.','\\.')}\n$`));
 r=await run(['sandbox','fork',box,snap.id,'--name','wire-fork','--sleep-after','0','--no-wait','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.match(r.stdout,new RegExp(`^sandbox +${wire.rest.fork.answer.id}\nname +wire-fork\n`));
 assert.match(r.stdout,new RegExp(`Run a command in it: cvm sandbox exec ${wire.rest.fork.answer.id} -- uname -a\n$`));
 // A delete is confirmed before anything is sent; asked again it answers the snapshot as it is.
 const sent=fake.state.seen.length;
 r=await run(['sandbox','snapshot-delete',box,snap.id,'--format','table']);
 assert.deepEqual([r.code,fake.state.seen.length],[2,sent]);
 assert.match(r.stdout,/^failed   cave_confirmation_required: Deleting snapshot .* Repeat with --yes to confirm\.\n$/);
 r=await run(['sandbox','snapshot-delete',box,snap.id,'--yes','--format','table']);
 assert.equal(r.stdout,`Deleting snapshot ${snap.id}: its copies are being deleted.\n`);
 r=await run(['sandbox','snapshot-delete',box,snap.id,'--yes']);
 assert.equal(r.json().state,'deleted');
 // A snapshot that is not ready is made into no sandbox: the code, and where its state is read.
 r=await run(['sandbox','fork',box,snap.id,'--format','table']);
 assert.equal(r.code,4);
 assert.match(r.stdout,new RegExp(`^failed   cave_code_computer_snapshot_not_ready: This snapshot is not ready: .* cvm sandbox snapshots ${box} says each one's state: only a ready one is restored or forked\.\n$`));
 assert.deepEqual(fake.state.seen.slice(sent).map(s=>[s.method,s.path,s.body]),[['DELETE',`${base}/${snap.id}`,''],['DELETE',`${base}/${snap.id}`,''],['POST',`${base}/${snap.id}/fork`,'{}']]);
 assert.deepEqual(fake.state.errors,[]);
});

test('the snapshot verbs: json, a fork that waits until it runs, a take that failed, ids and confirmations refused before anything is sent', async t => {
 let take='failed';
 const reason='The sandbox has no disk on any host right now (it is not made yet, or it is deleted), so nothing was taken. Take it once the sandbox runs.';
 const {fake,run}=await cvm(t,{rest:(req,res)=>{
  const json=(status,body,headers={})=>res.writeHead(status,{'content-type':'application/json',...headers}).end(JSON.stringify(body));
  if(req.method==='POST'&&req.url.endsWith('/fork'))return json(201,wire.rest.fork.answer);
  if(req.method==='POST')return json(201,snap);
  if(req.url.startsWith(`/api/v1/code/computers/${wire.rest.fork.answer.id}`))return json(200,{...wire.rest.fork.answer,observed_state:'running'},{'cave-wait':'satisfied'});
  if(req.url.endsWith('/snapshots'))return json(200,{snapshots:[]});
  json(200,{...snap,state:take,reason_code:'computer_not_placed',reason});
 }});
 let r=await run(['sandbox','fork',box,snap.id,'--size','2cpu-8gb']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.deepEqual([r.json().id,r.json().observed_state],[wire.rest.fork.answer.id,'running']);
 assert.equal(fake.state.seen[0].body,'{"size":"2cpu-8gb"}');
 r=await run(['sandbox','snapshot',box,'--format','table']);
 assert.equal(r.code,1);
 assert.equal(r.stdout,`failed   cave_snapshot_state: Asked for snapshot ${snap.id}, but it is not ready: Snapshot ${snap.id} is failed: ${reason}\n`);
 r=await run(['sandbox','snapshot',box,'--no-wait']);
 assert.deepEqual([r.code,r.json().state],[0,'taking']);
 r=await run(['sandbox','snapshots',box,'--format','table']);
 assert.equal(r.stdout,`No snapshots of ${box} yet. Take one with: cvm sandbox snapshot ${box}\n`);
 const sent=fake.state.seen.length;
 for(const [args,said] of [[['restore',box],/Use cvm sandbox restore SANDBOX SNAPSHOT/],[['restore',box,'not-an-id'],/A snapshot is named by its id/],[['fork','nope',snap.id],/A sandbox is named by its id/],
  [['fork',box,snap.id,'--size','huge'],/--size is <cores>cpu-<gigabytes>gb/],[['snapshot',box,'--name','a\x01b'],/--name is at most 200 characters/],[['snapshots',box,snap.id],/Use cvm sandbox snapshots SANDBOX/],
  [['snapshot',box,'--yes'],/Unknown option '--yes'/]]){
  r=await run(['sandbox',...args,'--format','table']);
  assert.equal(r.code,2,args.join(' '));
  assert.match(r.stdout,said);
 }
 assert.equal(fake.state.seen.length,sent);
});

test('the snapshot verbs with the switch off say so in the one line', async t => {
 // Off, a snapshot route answers 404 as a path that is not there; the sandbox read again says off (a key's 403).
 const {run}=await cvm(t,{rest:(req,res)=>{
  if(req.url.includes('/snapshots'))return res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({error:{type:'cave_gateway_error',code:'cave_not_found',message:'Not found.',request_id:'r'}}));
  res.writeHead(wire.rest.off_list.status,{'content-type':'application/json'}).end(JSON.stringify(wire.rest.off_list.answer));
 }});
 for(const args of [['snapshot',box],['snapshots',box],['restore',box,snap.id],['fork',box,snap.id],['snapshot-delete',box,snap.id,'--yes']]){
  const r=await run(['sandbox',...args,'--format','table']);
  assert.deepEqual([r.code,r.stdout],[4,'failed   cave_sandboxes_off: Sandboxes are switched off on this Caveman Cloud (computers.api.enabled): ask its admin to turn them on.\n'],args.join(' '));
 }
 // On, a snapshot that is not there stays the API's own refusal.
 const on=await cvm(t,{rest:(req,res)=>{
  if(req.url.includes('/snapshots'))return res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({error:{type:'cave_gateway_error',code:'cave_not_found',message:'Snapshot not found.',request_id:'r'}}));
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(wire.rest.get.answer));
 }});
 const r=await on.run(['sandbox','restore',box,snap.id,'--format','table']);
 assert.deepEqual([r.code,r.stdout],[1,'failed   cave_not_found: Snapshot not found.\n']);
});

test('url prints a port\'s link, says on stderr how long it opens and how a program sends the token, and --public opens it to anyone', async t => {
 const portURL=`https://3000-${id}.sandbox.example.dev`;
 const token={computer_id:id,port:3000,visibility:'private',url:portURL,link:`${portURL}/_caveman/open?token=cvp_link`,link_expires_at:'2026-11-20T12:05:00Z',
  token:'cvp_access',header:'Caveman-Port-Token',expires_at:'2026-11-20T13:00:00Z'};
 let served=true,visibility='private';
 const {fake,run}=await cvm(t,{rest:(req,res,body)=>{
  const json=(status,answer)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(answer));
  if(req.method==='GET'&&req.url===`/api/v1/code/computers/${id}`)return json(200,wire.rest.get.answer);
  if(served&&req.method==='PUT'&&req.url===`/api/v1/code/computers/${id}/ports/3000`){visibility=JSON.parse(body).visibility;return json(200,{port:3000,visibility,url:portURL});}
  if(served&&req.method==='POST'&&req.url===`/api/v1/code/computers/${id}/ports/3000/token`)
   return json(200,{...token,visibility,expires_at:JSON.parse(body).ttl_seconds===600?'2026-11-20T12:10:00Z':token.expires_at});
  json(404,{error:{type:'cave_gateway_error',code:'cave_not_found',message:'Not found.',request_id:'req_port'}});
 }});
 let r=await run(['sandbox','url',id,'3000','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(r.stdout,token.link+'\n');
 assert.match(r.stderr,/Open the link before 2026-11-20T12:05:00Z; the browser then keeps port 3000 open until 2026-11-20T13:00:00Z\. A program sends the Caveman-Port-Token header with each request to https:\/\/3000-/);
 assert.ok(!r.stderr.includes('cvp_access'),'table output keeps the token to JSON');
 assert.deepEqual(fake.state.seen.map(s=>[s.method,s.path,s.body]),[['GET',`/api/v1/code/computers/${id}`,''],['POST',`/api/v1/code/computers/${id}/ports/3000/token`,'{}']]);
 // As JSON: the whole answer, the token among it; --ttl is sent as ttl_seconds.
 fake.state.seen.length=0;
 r=await run(['sandbox','url',id,'3000','--ttl','10m']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.deepEqual(r.json(),{sandbox:id,port:3000,visibility:'private',url:portURL,link:token.link,link_expires_at:token.link_expires_at,token:'cvp_access',header:'Caveman-Port-Token',expires_at:'2026-11-20T12:10:00Z'});
 assert.equal(fake.state.seen.at(-1).body,'{"ttl_seconds":600}');
 // --public makes it public first; stdout is then the address itself.
 fake.state.seen.length=0;
 r=await run(['sandbox','url',id,'3000','--public','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(r.stdout,portURL+'\n');
 assert.match(r.stderr,new RegExp(`is public: anyone with ${portURL.replaceAll('.','\\.')} reaches it\\. Close it with: cvm sandbox url ${id} 3000 --private`));
 assert.deepEqual(fake.state.seen.map(s=>[s.method,s.path,s.body]).slice(1),[['PUT',`/api/v1/code/computers/${id}/ports/3000`,'{"visibility":"public"}'],['POST',`/api/v1/code/computers/${id}/ports/3000/token`,'{}']]);
 // What cvm refuses before anything is sent.
 fake.state.seen.length=0;
 for(const args of [[id,'0'],[id,'65536'],[id,'http'],[id,'3000','--ttl','30s'],[id,'3000','--ttl','25h'],[id,'3000','--public','--private'],[id]]){
  r=await run(['sandbox','url',...args,'--format','table']);
  assert.equal(r.code,2,args.join(' ')+': '+r.stdout);
  assert.match(r.stdout,/^failed   cave_usage: /);
 }
 assert.deepEqual(fake.state.seen,[]);
 // A Caveman Cloud that does not serve ports at their own URLs: its routes answer as unknown ones do, said as one line.
 served=false;
 r=await run(['sandbox','url',id,'3000','--format','table']);
 assert.deepEqual([r.code,r.stdout],[4,`failed   cave_sandbox_ports_off: This Caveman Cloud does not serve ports at their own URLs (computers.portUrls): reach the port from here with cvm sandbox port-forward ${id} PORT.\n`]);
 assert.deepEqual(fake.state.errors,[]);
});

test('cvm --help lists the sandbox family, and cvm.mjs lists every sandbox verb as cvm sandbox does', async t => {
 const {run}=await cvm(t);
 const r=await run(['sandbox']);
 assert.deepEqual(r.json().commands,verbs);
 assert.ok((await run(['--help','--format','json'])).json().families.includes('sandbox'));
 // cvm.mjs answers `cvm --help` before loading sandbox.mjs: its copy of the verbs is the same.
 const source=await readFile(bin,'utf8');
 const listed=[...source.matchAll(/\{id:'(sandbox\.[\w-]+)',usage:'((?:\\'|[^'])*)',summary:'((?:\\'|[^'])*)'\}/g)].map(m=>({id:m[1],usage:m[2].replaceAll("\\'","'"),summary:m[3].replaceAll("\\'","'")}));
 assert.deepEqual(listed,verbs);
});

// docs/sandboxes-quickstart.md shows each end-to-end test's quickstart part as it is: a snippet there
// that is not its test's part, line for line, fails here.
test('the quickstart\'s snippets are the end-to-end tests\' own', async () => {
 const root=new URL('../../../',import.meta.url);
 const doc=await readFile(new URL('docs/sandboxes-quickstart.md',root),'utf8');
 const part=async(file,lang)=>{
  const text=await readFile(new URL(file,root),'utf8');
  const lines=text.split('\n');
  const from=lines.findIndex(l=>l.trim()===`// quickstart:${lang}`||l.trim()===`# quickstart:${lang}`),to=lines.findIndex((l,i)=>i>from&&/^(\/\/|#) quickstart:end$/.test(l.trim()));
  assert.ok(from>=0&&to>from,`${file} has no quickstart:${lang} part`);
  const body=lines.slice(from+1,to),indent=Math.min(...body.filter(l=>l.trim()).map(l=>/^\s*/.exec(l)[0].length));
  return body.map(l=>l.slice(indent)).join('\n');
 };
 const snippet=lang=>{
  const m=new RegExp(`<!-- snippet: ${lang} -->\\n\`\`\`\\w+\\n([\\s\\S]*?)\\n\`\`\``).exec(doc);
  assert.ok(m,`the quickstart has no ${lang} snippet`);
  return m[1];
 };
 for(const [lang,file] of [['typescript','packages/sdk-ts/tests/sandboxes.e2e.mjs'],['python','python/caveman-sdk/tests/test_sandboxes_e2e.py'],['go','go/sandboxes_e2e_test.go']]){
  const body=await part(file,lang);
  assert.ok(snippet(lang).endsWith('\n\n'+body),`the quickstart's ${lang} snippet is not ${file}'s quickstart part:\n${body}`);
 }
 const lines=[...(await part('packages/cli/tests/sandbox.e2e.mjs','cli')).matchAll(/^ *(['"])(cvm .*)\1,$/gm)].map(m=>m[2]);
 assert.equal(lines.length,3);
 assert.equal(snippet('cli'),lines.join('\n'));
});
