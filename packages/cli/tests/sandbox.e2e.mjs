// `cvm sandbox` end to end against a real control-api and relay: Caveman Cloud API
// runs this with CAVE_SANDBOX_E2E_API, _RELAY and _KEY (a code:run key); a file goes in
// CAVE_SANDBOX_E2E_DIR (/tmp when unset), and CAVE_SANDBOX_E2E_PORT, when set, is a port in the
// sandbox that answers what it reads upper-cased. The quickstart's CLI lines are the first test's
// commands, between the quickstart markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const api=process.env.CAVE_SANDBOX_E2E_API,relay=process.env.CAVE_SANDBOX_E2E_RELAY,key=process.env.CAVE_SANDBOX_E2E_KEY;
const skip=api&&key?false:'set CAVE_SANDBOX_E2E_API and CAVE_SANDBOX_E2E_KEY (Caveman Cloud API runs it)';
const bin=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const env=home=>({HOME:home,USERPROFILE:home,CAVEMAN_HOME:join(home,'.caveman'),PATH:process.env.PATH,CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',CAVE_API_URL:api,CAVE_RELAY_URL:relay??'',CAVE_TOKEN:key});

// cvm as a terminal user runs it: CAVE_API_URL, CAVE_RELAY_URL and CAVE_TOKEN set, an empty HOME.
async function shell(t){
 const home=await mkdtemp(join(tmpdir(),'cvm-sandbox-e2e-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 // terminal: print as cvm prints on a terminal (tables), as the quickstart's reader sees it.
 const run=(line,{stdin,terminal}={})=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[bin,...line,...(terminal&&line[1]!=='exec'?['--format','table']:[])],{cwd:home,env:env(home),stdio:[stdin===undefined?'ignore':'pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  if(stdin!==undefined)child.stdin.end(stdin);
  child.on('error',reject);child.on('close',code=>{
   assert.ok(!(stdout+stderr).includes(key),'cvm must not print the key');
   resolve({code,stdout,stderr,json:()=>JSON.parse(stdout)});
  });
 });
 return Object.assign(run,{home});
}

// words splits one quickstart line as a shell would: words apart, '...' kept whole, $ID replaced.
const words=(line,id)=>[...line.matchAll(/'([^']*)'|(\S+)/g)].map(m=>m[1]??m[2].replaceAll('$ID',id));

test('a sandbox made, a command run in it, and the sandbox deleted, from the terminal',{skip:skip},async t=>{
 const cvm=await shell(t);
 // quickstart:cli
 const quickstart=[
  'cvm sandbox create --name quickstart-cli',
  "cvm sandbox exec $ID -- sh -c 'echo hello from the sandbox; echo careful >&2; exit 3'",
  'cvm sandbox delete $ID --yes',
 ];
 // quickstart:end
 const runs=[];
 let id='';
 for(const line of quickstart){
  const r=await cvm(words(line,id).slice(1),{terminal:true});
  runs.push(r);
  id||=/sandbox +(\S+)\n/.exec(r.stdout)?.[1]??'';
 }
 const [made,ran,deleted]=runs;
 assert.equal(made.code,0,made.stdout+made.stderr);
 assert.match(made.stdout,/state +running\n/);
 assert.deepEqual([ran.code,ran.stdout,ran.stderr],[3,'hello from the sandbox\n','careful\n']);
 assert.equal(deleted.stdout,`Deleted ${id}.\n`);
});

test('the lifecycle from the terminal: stdin, a file, a port, the list, sleep, a command refused asleep, resume, delete',{skip:skip},async t=>{
 const cvm=await shell(t);
 const made=await cvm(['sandbox','create','--name','e2e-cli','--sleep-after','0','--format','table']);
 assert.equal(made.code,0,made.stdout+made.stderr);
 const id=/sandbox +(\S+)\n/.exec(made.stdout)[1];
 assert.match(made.stdout,/state +running\n/);
 assert.match(made.stdout,/sleeps after +never\n/);
 let r=await cvm(['sandbox','exec','-i',id,'--','cat'],{stdin:'stdin reaches it'});
 assert.deepEqual([r.code,r.stdout],[0,'stdin reaches it']);
 // A file copied in, listed, and copied out whole.
 const dir=process.env.CAVE_SANDBOX_E2E_DIR||'/tmp',there=`${dir}/e2e-cli-${id}.txt`,here=join(cvm.home,'here.txt');
 await writeFile(here,'a file through the relay\n');
 r=await cvm(['sandbox','cp',here,`${id}:${there}`,'--format','table']);
 assert.equal(r.stdout,`Copied 25 bytes to ${id}:${there}.\n`,r.stderr);
 r=await cvm(['sandbox','ls',id,dir]);
 assert.ok(r.json().entries.some(f=>`${dir}/${f.name}`===there),r.stdout);
 r=await cvm(['sandbox','cp',`${id}:${there}`,join(cvm.home,'back.txt'),'--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(await readFile(join(cvm.home,'back.txt'),'utf8'),'a file through the relay\n');
 r=await cvm(['sandbox','cp',`${id}:${there}`,'-']);
 assert.deepEqual([r.code,r.stdout],[0,'a file through the relay\n']);
 // A command's environment and folder (the file is there).
 r=await cvm(['sandbox','exec','-e','GREETING=hello env','-w',dir,id,'--','sh','-c','echo "$GREETING"; ls']);
 assert.ok(r.code===0&&r.stdout.startsWith('hello env\n')&&r.stdout.includes(`e2e-cli-${id}.txt`),r.stdout+r.stderr);
 r=await cvm(['sandbox','exec',id,'--','rm',there]);
 assert.equal(r.code,0,r.stderr);
 if(process.env.CAVE_SANDBOX_E2E_PORT){
  // A port forwarded from here: what a connection sends reaches the sandbox's port, and its answer comes back.
  const child=spawn(process.execPath,[bin,'sandbox','port-forward',id,`0:${process.env.CAVE_SANDBOX_E2E_PORT}`,'--format','json'],{cwd:cvm.home,env:env(cvm.home),stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  const exited=new Promise(resolve=>child.on('close',resolve));
  let out='',err='';
  child.stderr.on('data',d=>err+=d);
  const said=await new Promise((resolve,reject)=>{
   child.stdout.on('data',d=>{out+=d;if(out.includes('\n'))resolve(JSON.parse(out.split('\n')[0]));});
   child.on('close',()=>reject(new Error('port-forward ended: '+out+err)));
  });
  const back=await new Promise((resolve,reject)=>{
   const socket=connect(Number(said.local.split(':')[1]),'127.0.0.1');
   let heard='';
   socket.on('data',d=>heard+=d);
   socket.on('error',reject);
   socket.on('close',()=>resolve(heard));
   socket.end('hello port');
  });
  assert.equal(back,'HELLO PORT',err);
  child.kill('SIGINT');
  assert.equal(await exited,0,err);
 }
 r=await cvm(['sandbox','list','--format','table']);
 assert.match(r.stdout,new RegExp(`${id} +e2e-cli +running`));
 r=await cvm(['sandbox','sleep',id,'--wait','--format','table']);
 assert.match(r.stdout,/state +asleep\n/);
 r=await cvm(['sandbox','exec',id,'--','true']);
 assert.equal(r.code,4);
 assert.match(r.stderr,new RegExp(`^failed   cave_code_computer_not_running: .* Wake it with: cvm sandbox resume ${id}\\n$`));
 r=await cvm(['sandbox','resume',id,'--format','table']);
 assert.match(r.stdout,/state +running\n/);
 r=await cvm(['sandbox','exec',id,'--','echo','awake']);
 assert.deepEqual([r.code,r.stdout],[0,'awake\n']);
 r=await cvm(['sandbox','delete',id,'--yes']);
 assert.equal(r.json().desired_state,'deleted');
 r=await cvm(['sandbox','get',id]);
 assert.equal(r.code,1);
 assert.equal(r.json().error.code,'cave_not_found');
});

test('a snapshot from the terminal: taken, listed, restored, made into a new sandbox, deleted',{skip:skip},async t=>{
 const cvm=await shell(t);
 const made=await cvm(['sandbox','create','--name','e2e-cli-snapshots','--sleep-after','0','--format','table']);
 assert.equal(made.code,0,made.stdout+made.stderr);
 const id=/sandbox +(\S+)\n/.exec(made.stdout)[1];
 let r=await cvm(['sandbox','snapshot',id,'--name','e2e-cli','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.match(r.stdout,/state +ready\n/);
 const snap=/^snapshot +(\S+)\n/.exec(r.stdout)[1];
 assert.match(r.stdout,new RegExp(`Make a sandbox from it: cvm sandbox fork ${id} ${snap}\\n$`));
 r=await cvm(['sandbox','snapshots',id]);
 assert.ok(r.json().snapshots.some(s=>s.id===snap&&s.state==='ready'),r.stdout);
 r=await cvm(['sandbox','restore',id,snap]);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(r.json().restore.state,'restored');
 r=await cvm(['sandbox','fork',id,snap,'--name','e2e-cli-fork','--sleep-after','0','--format','table']);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.match(r.stdout,/state +running\n/);
 const child=/sandbox +(\S+)\n/.exec(r.stdout)[1];
 r=await cvm(['sandbox','exec',child,'--','echo','forked']);
 assert.deepEqual([r.code,r.stdout],[0,'forked\n']);
 assert.equal((await cvm(['sandbox','delete',child,'--yes'])).code,0);
 r=await cvm(['sandbox','snapshot-delete',id,snap,'--yes']);
 assert.ok(['deleting','deleted'].includes(r.json().state),r.stdout);
 r=await cvm(['sandbox','fork',id,snap]);
 assert.equal(r.code,4);
 assert.equal(r.json().error.code,'cave_code_computer_snapshot_not_ready');
 assert.equal((await cvm(['sandbox','delete',id,'--yes'])).code,0);
});

// The sandbox the lab made larger than its one host (CAVE_SANDBOX_E2E_ROOM): cvm says it is starting and why, in the
// vocabulary's sentence (public/sdk/parity/sandbox-reasons.json), never that it failed.
const room=process.env.CAVE_SANDBOX_E2E_ROOM;
test('a sandbox the fleet has no room for reads as starting, and why, from the terminal',{skip:api&&key&&room?false:'set CAVE_SANDBOX_E2E_API, CAVE_SANDBOX_E2E_KEY and CAVE_SANDBOX_E2E_ROOM (Caveman Cloud API runs it)'},async t=>{
 const {readFile}=await import('node:fs/promises');
 const sentence=JSON.parse(await readFile(new URL('../../sdk/parity/sandbox-reasons.json',import.meta.url),'utf8')).codes.waiting_for_capacity.sentence;
 const cvm=await shell(t);
 let r=await cvm(['sandbox','get',room]);
 assert.equal(r.code,0,r.stdout+r.stderr);
 assert.equal(r.json().observed_reason,sentence);
 assert.equal(r.json().observed_reason_code,'waiting_for_capacity');
 r=await cvm(['sandbox','get',room],{terminal:true});
 assert.match(r.stdout,/state +starting: /);
 assert.ok(r.stdout.includes(`starting: ${sentence}\n`),r.stdout);
});
