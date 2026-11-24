// `cvm sandbox`: make a sandbox, run commands in it from this terminal, put it to sleep, wake it and
// delete it; take snapshots of its disk, restore it to one and make new sandboxes from one. A sandbox
// is a computer in Caveman Cloud with nothing of Caveman inside it; its API is
// /api/v1/code/computers, and a command reaches it through the relay. Every verb runs on the
// TypeScript SDK's Sandboxes client (dist/sandboxes.mjs, bundled by scripts/build.mjs), signed in
// as cvm always is: an organization's code:run key in CAVE_TOKEN acts as its service account and sees
// the sandboxes that service account made. Nothing here prints a credential or echoes a response
// body, but url: its link (and, as JSON, its token) is a short-lived credential for one port of one
// sandbox, made to be handed to a browser or a program. A refusal shows the API's error code and its
// message.
import {parseArgs} from 'node:util';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {open,rename,rm,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {basename,dirname,join} from 'node:path';
import {CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {CloudError as SDKError,SandboxCommand,Sandboxes,SandboxError,SandboxExecError,SandboxStateError,SnapshotStateError,sandboxReasons} from '../dist/sandboxes.mjs';
import {formatOf} from './agent-build.mjs';
import {clean} from './deploy.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,SIZE=/^[1-9][0-9]?cpu-[1-9][0-9]{0,3}gb$/;
const own=(code,message,exit)=>Object.assign(new CloudError(code,message,exit),{local:true});
const usage=message=>own('cave_usage',message,2);
const one=text=>clean(text).replace(/\s+/g,' ').trim();
const statusExit=status=>status===401||status===403?3:status===409?4:status===429?7:status===422||status===400?2:1;
// The computers API switched off (computers.api.enabled): every route then answers as before it
// existed, with no code that says off, so cvm reads it from what its sign-in gets (the contract's
// GET /code/computers says how): a key's 403 cave_api_key_route_forbidden, any caller's 405 on a
// create, a person's list without computers_api or get without bare. Each is this one line.
const off=()=>own('cave_sandboxes_off','Sandboxes are switched off on this Caveman Cloud (computers.api.enabled): ask its admin to turn them on.',4);

// The verbs, in the order `cvm sandbox` lists them.
export const verbs=[
 {id:'sandbox.create',usage:'cvm sandbox create [--name NAME] [--size 4cpu-16gb] [--sleep-after 10m|2h|0] [--lifetime 1h] [--network none|internet] [--no-wait]',summary:'Make a sandbox and wait until it runs. It goes to sleep after 10 minutes unused unless --sleep-after says otherwise (0: never); --lifetime deletes it that long after it was made, whatever it is doing (1m to 30d); --network none gives it no network.'},
 {id:'sandbox.list',usage:'cvm sandbox list [--mine]',summary:'The sandboxes your key made, newest first. Signed in as a person, --mine keeps the ones you made.'},
 {id:'sandbox.get',usage:'cvm sandbox get SANDBOX',summary:'One sandbox: whether it runs, sleeps or failed, and its size.'},
 {id:'sandbox.exec',usage:'cvm sandbox exec [-i] [-t] [-e KEY=VALUE]... [-w DIR] [-u USER] SANDBOX -- COMMAND [ARG...]',summary:'Run a command in a running sandbox, its output streamed here; cvm exits with the command\'s exit code. -i sends this terminal\'s input, -t gives the command a terminal of this one\'s size, -e sets its environment, -w its folder, -u its user. Ctrl-C sends it INT; a second ends it.'},
 {id:'sandbox.cp',usage:'cvm sandbox cp [--root] SOURCE TARGET',summary:'Copy one file into a sandbox or out of it: SANDBOX:/PATH is the sandbox\'s side, the other a file here, or - for this terminal\'s input or output. --root reads and writes as the sandbox\'s root.'},
 {id:'sandbox.ls',usage:'cvm sandbox ls [--root] SANDBOX PATH',summary:'List a folder of a sandbox: each file\'s type and permissions, size, time modified and name.'},
 {id:'sandbox.port-forward',usage:'cvm sandbox port-forward SANDBOX [LOCAL:]PORT',summary:'Reach a port on a sandbox\'s own loopback from 127.0.0.1:LOCAL here (the same number unless LOCAL says, 0 for any free one), until Ctrl-C.'},
 {id:'sandbox.url',usage:'cvm sandbox url SANDBOX PORT [--public|--private] [--ttl 1h]',summary:'A port of a sandbox at its own URL (https://PORT-SANDBOX.DOMAIN, where this Caveman Cloud serves ports so): a link to open it in a browser, good for a few minutes, after which the browser keeps it open until --ttl (1m to 24h, an hour by default). A port is private until --public makes it open to anyone with the address (only who made the sandbox may); --private closes it again. --format json adds the token a program sends in its Caveman-Port-Token header.'},
 {id:'sandbox.sleep',usage:'cvm sandbox sleep SANDBOX [--wait]',summary:'Put a sandbox to sleep: it stops running and keeps its disk.'},
 {id:'sandbox.resume',usage:'cvm sandbox resume SANDBOX [--no-wait]',summary:'Wake a sleeping sandbox and wait until it runs.'},
 {id:'sandbox.delete',usage:'cvm sandbox delete SANDBOX --yes',summary:'Delete a sandbox and its disk, for good; any command running in it ends.'},
 {id:'sandbox.snapshot',usage:'cvm sandbox snapshot SANDBOX [--name NAME] [--no-wait]',summary:'Take a snapshot of a sandbox\'s disk and wait until it is ready. Only the key whose service account made the sandbox sees it.'},
 {id:'sandbox.snapshots',usage:'cvm sandbox snapshots SANDBOX',summary:'A sandbox\'s snapshots, newest first: each one\'s state, name, and when it was asked for and taken.'},
 {id:'sandbox.restore',usage:'cvm sandbox restore SANDBOX SNAPSHOT [--no-wait]',summary:'Put a running sandbox back on one of its snapshots: its commands end and it starts again on the snapshot\'s disk. Waits until it is restored.'},
 {id:'sandbox.fork',usage:'cvm sandbox fork SANDBOX SNAPSHOT [--name NAME] [--size 4cpu-16gb] [--sleep-after 10m|2h|0] [--no-wait]',summary:'Make a new sandbox from a snapshot\'s disk and wait until it runs. It runs at the snapshot\'s size unless --size says otherwise.'},
 {id:'sandbox.snapshot-delete',usage:'cvm sandbox snapshot-delete SANDBOX SNAPSHOT --yes',summary:'Delete a snapshot, for good; sandboxes made from it keep their disks.'},
 {id:'sandbox.status',usage:'cvm sandbox status',summary:'Whether sandboxes work right now on this Caveman Cloud, from its canary\'s recent rounds: each step\'s state, when it last passed and how long it takes.'},
];
const usageOf=verb=>verbs.find(v=>v.id==='sandbox.'+verb).usage;
const verbNames=verbs.map(v=>v.id.slice('sandbox.'.length)).join('|');
const common='[--relay URL] [--format json|table]';

// failure turns any error into one cvm prints: the API's refusal or the sandbox's (its code and
// message, made terminal-inert, and what to do next when cvm knows), else a fixed line.
export function failure(error,id){
 if(error?.local)return error;
 const id2=id??'SANDBOX';
 const next={
  cave_forbidden:' Sandboxes are made and used with an organization\'s code:run key: set CAVE_TOKEN to one (cave_live_...).',
  cave_code_computer_not_running:` Wake it with: cvm sandbox resume ${id2}`,
  cave_code_computer_stopped:' It was put to sleep or deleted while the command ran.',
  cave_code_computer_host_unreachable:` Its host is restarting; cvm tried again for as long as it may. Run the command again in a moment.`,
  cave_code_computer_asleep:` Wake it with: cvm sandbox resume ${id2}`,
  cave_code_computer_snapshot_not_ready:` cvm sandbox snapshots ${id2} says each one's state: only a ready one is restored or forked.`,
  cave_code_computer_limit_snapshots:` Delete one with: cvm sandbox snapshot-delete ${id2} SNAPSHOT --yes`,
 };
 // What cvm says in place of the API's own words, where it knows what to do here.
 const instead={
  cave_code_computer_device_login_forbidden:'cvm login cannot make or enter a sandbox. Set CAVE_TOKEN to an organization\'s code:run key (cave_live_...), made under Settings > Service accounts.',
 };
 if(error instanceof SandboxStateError)return new CloudError('cave_sandbox_state',one(error.message),1);
 if(error instanceof SnapshotStateError)return new CloudError('cave_snapshot_state',one(error.message),1);
 if(error instanceof SandboxError||error instanceof SandboxExecError){
  if(error instanceof SandboxError&&['cave_api_key_route_forbidden','cave_method_not_allowed'].includes(error.code))return off();
  const code=/^[a-z0-9_]{1,80}$/.test(error.code)?error.code:'cave_request_failed';
  const said=(one(error.message)||'The request was refused.').slice(0,500);
  const message=instead[code]??(next[code]?said.replace(/([^.!?])$/,'$1.')+next[code]:said);
  const exit=error.code==='cave_timeout'?6:error.status?statusExit(error.status):['cave_rate_limit_exceeded','cave_code_computer_streams_limit','cave_code_computer_clients_limit','cave_code_computer_host_unreachable'].includes(error.code)?7:1;
  return new CloudError(code,message,exit);
 }
 // The SDK's own refusals of what it was given (its CloudError, apart from cvm's): an address, a key.
 if((error instanceof CloudError||error instanceof SDKError)&&['cave_auth_required','cave_endpoint_invalid','cave_timeout_invalid'].includes(error.code))
  return new CloudError(error.code,error.code==='cave_auth_required'?'Set CAVE_TOKEN to an organization\'s code:run key (cave_live_...).':one(error.message),error.code==='cave_auth_required'?3:2);
 return new CloudError('cave_failed','The sandbox request failed.',1);
}
function printFailure(format,error,{stderr=false}={}){
 const line=format==='table'||stderr?`failed   ${error.code}: ${error.message}\n`:inertJSON({schema_version:1,ok:false,status:'failed',error:{code:error.code,message:error.message}})+'\n';
 (stderr?process.stderr:process.stdout).write(line);
 return error.exitCode;
}
// Pads columns two spaces apart.
const table=rows=>{
 const widths=rows.reduce((w,row)=>row.map((cell,i)=>Math.max(w[i]??0,String(cell).length)),[]);
 return rows.map(row=>row.map((cell,i)=>i===row.length-1?String(cell):String(cell).padEnd(widths[i])).join('  ').trimEnd()).join('\n')+'\n';
};
// What a sandbox is doing, in a person's words: its observed state, and what it is asked to be when that differs.
const WORDS={pending:'starting',starting:'starting',running:'running',stopping:'going to sleep',stopped:'asleep',suspended:'asleep',deleted:'deleted',failed:'failed'};
const ASKED={running:'waking',suspended:'going to sleep',stopped:'going to sleep',deleted:'being deleted'};
// A reason's code (observed_reason_code) that passes by itself or needs the caller says its sentence: a sandbox
// whose host is restarting reads waiting, not failed; one its host stopped says to start it again. One on its
// way to running says why it is not there yet (booting, or waiting for room).
function stateOf(s){
 const now=WORDS[s.observed_state]??one(s.observed_state);
 const asked=s.desired_state==='running'?'running':s.desired_state==='deleted'?'deleted':'asleep';
 const wait=Object.hasOwn(sandboxReasons,s.observed_reason_code??'')?sandboxReasons[s.observed_reason_code]:'ends_if_failed';
 if(wait==='continues'&&s.observed_reason)return `${s.observed_state==='failed'?'waiting':now}: ${one(s.observed_reason)}`;
 if(s.observed_state==='failed')return `failed${s.observed_reason?`: ${one(s.observed_reason)}`:''}`;
 if(wait==='ends'&&s.observed_reason)return `${now}: ${one(s.observed_reason)}`;
 if(now==='starting'&&asked==='running'&&s.observed_reason)return `starting: ${one(s.observed_reason)}`;
 return now===asked||now==='starting'&&asked==='running'?now:`${now}, ${ASKED[s.desired_state]??one(s.desired_state)}`;
}
const sizeOf=s=>s.size?one(s.size):'default';
// The public status of sandboxes (GET /api/v1/status/sandboxes) not served here: computers.status.enabled,
// or the computers API, is off.
// Ports at their own URLs switched off (computers.portUrls): their routes answer as unknown ones do.
const portsOff=id=>own('cave_sandbox_ports_off',`This Caveman Cloud does not serve ports at their own URLs (computers.portUrls): reach the port from here with cvm sandbox port-forward ${id} PORT.`,4);
const statusOff=()=>own('cave_sandbox_status_off','This Caveman Cloud does not publish whether sandboxes work (computers.status.enabled): ask its admin.',4);
const ms=v=>typeof v==='number'?`${v}ms`:'-';
// statusTable is the status as a person reads it: the whole, then each step the canary takes.
function statusTable(s){
 const head=`sandboxes ${one(s.state)}, as of ${one(s.checked_at)}${s.last_round_at?`; the canary's last round ended ${one(s.last_round_at)}`:'; no round of the canary\'s read'}\n\n`;
 const rows=[['STEP','STATE','LAST PASSED','ATTEMPTS','FAILED','P50','P95'],...(s.probes??[]).map(p=>[one(p.name),one(p.state),p.last_success_at?one(p.last_success_at):'-',String(p.attempts),String(p.failures),ms(p.p50_ms),ms(p.p95_ms)])];
 const c=s.create_to_command??{};
 return head+table(rows)+`\nnew sandbox to its first command: ${one(c.state??'unknown')}, p95 ${ms(c.p95_ms)} (objective ${ms(c.threshold_ms)}); counted over the last ${Math.round((s.window_seconds??3600)/60)} minutes\n`;
}
const rowsOf=s=>[['sandbox',one(s.id)],['name',one(s.name)||'-'],['state',stateOf(s)],['size',sizeOf(s)],
 ...(s.sleep_after_seconds!==undefined?[['sleeps after',s.sleep_after_seconds===0?'never':duration(s.sleep_after_seconds)+' unused']]:[]),
 ...(s.idle?.pause_after_seconds>0?[['pauses after',duration(s.idle.pause_after_seconds)+' idle']]:[]),
 ...(s.network!==undefined?[['network',one(s.network)]]:[]),
 ...(s.expires_at!==undefined?[['deleted at',one(s.expires_at)]]:[]),['made',one(s.created_at)]];
const duration=seconds=>seconds%3600===0?`${seconds/3600}h`:seconds%60===0?`${seconds/60}m`:`${seconds}s`;
// A time as cvm takes one: a whole number of seconds, or a number with s, m, h or d; NaN otherwise.
const secondsOf=text=>{const m=/^(\d+)(s|m|h|d)?$/.exec(text);return m?Number(m[1])*({s:1,m:60,h:3600,d:86400}[m[2]??'s']):NaN;};
// --sleep-after: 0 or never, or a time up to 30 days.
function sleepAfter(text){
 if(text===undefined)return undefined;
 if(text==='never'||text==='0')return 0;
 const seconds=secondsOf(text);
 if(!Number.isSafeInteger(seconds)||seconds>2592000)throw usage('--sleep-after is 0 (never), or a time up to 30d: 600, 10m, 2h, 1d.');
 return seconds;
}
// --lifetime: a time from a minute to 30 days.
function lifetime(text){
 if(text===undefined)return undefined;
 const seconds=secondsOf(text);
 if(!Number.isSafeInteger(seconds)||seconds<60||seconds>2592000)throw usage('--lifetime is a time from 1m to 30d: 90s, 10m, 2h, 7d.');
 return seconds;
}
// --ttl: how long a port's token opens it, from a minute to a day.
function portTTL(text){
 if(text===undefined)return undefined;
 const seconds=secondsOf(text);
 if(!Number.isSafeInteger(seconds)||seconds<60||seconds>86400)throw usage('--ttl is a time from 1m to 24h: 90s, 10m, 2h.');
 return seconds;
}
const sandboxID=(value,line)=>{
 if(value===undefined)throw usage(`Name the sandbox. Use ${line}.`);
 if(!UUID.test(value))throw usage('A sandbox is named by its id, such as 01a1f5db-671c-7622-93b8-9ed320c07da7 (cvm sandbox list shows them).');
 return value.toLowerCase();
};

const snapshotID=(value,line)=>{
 if(value===undefined)throw usage(`Name the snapshot. Use ${line}.`);
 if(!UUID.test(value))throw usage('A snapshot is named by its id, such as 01a1f5db-671c-7622-93b8-9ed320c07da7 (cvm sandbox snapshots SANDBOX shows them).');
 return value.toLowerCase();
};
// What a snapshot is, and its last restore, in a person's words: a failure with its sentence.
const SNAP={taking:'being taken',ready:'ready',failed:'failed',deleting:'being deleted',deleted:'deleted'};
const snapStateOf=s=>`${SNAP[s.state]??one(s.state)}${s.state==='failed'&&s.reason?`: ${one(s.reason)}`:''}`;
const restoreOf=r=>r.state==='failed'?`failed${r.reason?`: ${one(r.reason)}`:''}`:r.state==='restored'?`restored ${one(r.done_at??'')}`.trim():one(r.state);
const snapRowsOf=s=>[['snapshot',one(s.id)],['sandbox',one(s.computer_id)],['name',one(s.name)||'-'],['state',snapStateOf(s)],['size',sizeOf(s)],
 ['asked',one(s.created_at)],['taken',s.ready_at?one(s.ready_at):'-'],...(s.restore&&s.restore.state!=='none'?[['restore',restoreOf(s.restore)]]:[])];
// The snapshot routes are not served while the computers API is off: every one answers 404 then, as a path that is
// not there. A 404 is read again as the sandbox: one cvm cannot read as a sandbox says sandboxes are off.
async function snapshotsOff(sandboxes,id,error){
 if(!(error instanceof SandboxError)||error.status!==404)return error;
 try{if((await sandboxes.get(id)).bare===undefined)return off();}catch(read){if(read instanceof SandboxError&&['cave_api_key_route_forbidden','cave_method_not_allowed'].includes(read.code))return off();}
 return error;
}
// What a create and a fork take: --name, --size, --sleep-after.
function makeInput(values){
 if(values.size!==undefined&&!SIZE.test(values.size))throw usage('--size is <cores>cpu-<gigabytes>gb, such as 2cpu-4gb.');
 if(values.name!==undefined&&(values.name.length>200||/[\x00-\x1f\x7f]/.test(values.name)))throw usage('--name is at most 200 characters, with no control characters.');
 const after=sleepAfter(values['sleep-after']);
 return {...(values.name!==undefined?{name:values.name}:{}),...(values.size!==undefined?{size:values.size}:{}),...(after!==undefined?{sleep_after_seconds:after}:{})};
}

// A path in a sandbox is absolute, as the files API takes it.
const sandboxPath=path=>{
 if(typeof path!=='string'||!path.startsWith('/'))throw usage('A path in a sandbox is absolute, such as /home/user/notes.txt.');
 if(path.length>4096||path.includes('\0'))throw usage('A path in a sandbox is at most 4096 bytes, with no NUL.');
 return path;
};
// SANDBOX:/PATH, the sandbox's side of a cp; anything else is a file here.
const remoteOf=text=>{
 const m=/^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):(.*)$/is.exec(text);
 return m?{id:m[1].toLowerCase(),path:sandboxPath(m[2])}:undefined;
};
// A file's type and permission bits as ls -l writes them: drwxr-xr-x.
const modeOf=f=>({dir:'d',symlink:'l',file:'-'}[f.type]??'?')+[6,3,0].map(shift=>{const bits=(f.mode>>shift)&7;return (bits&4?'r':'-')+(bits&2?'w':'-')+(bits&1?'x':'-');}).join('');
// A file here that cvm could not read or write: its system's code, in a line of cvm's.
const localFailure=(error,path)=>error?.code==='ENOENT'?own('cave_local_file_not_found',`There is no ${one(path)} here.`,1)
 :error?.code==='EISDIR'?usage(`${one(path)} is a folder: cp copies one file.`)
 :own('cave_local_file_refused',`cvm could not use ${one(path)} here: ${one(error?.code??'')||'it was refused'}.`,1);

// client is the SDK's Sandboxes for cvm's sign-in. The relay is CAVE_RELAY_URL or --relay, else the
// Cloud address itself (where a Caveman Cloud serves /relay beside /api/v1).
async function client(context,relay){
 const {baseURL,token}=await context();
 if(!token)throw new CloudError('cave_auth_required','Set CAVE_TOKEN to an organization\'s code:run key.',3);
 const relayURL=relay??process.env.CAVE_RELAY_URL;
 return new Sandboxes({controlURL:baseURL,apiKey:token,...(relayURL?{relayURL}:{})});
}

function help(format){
 if(format==='table'){
  process.stdout.write('cvm sandbox: sandboxes, computers in Caveman Cloud you run commands in from here.\nSign in with an organization\'s code:run key: CAVE_TOKEN=cave_live_...\n\n'+table(verbs.map(v=>[v.usage,v.summary]))+`\nEvery verb takes ${common}. A sandbox is named by its id.\n`);
 }else process.stdout.write(inertJSON({usage:`cvm sandbox ${verbNames}`,summary:'Sandboxes: computers in Caveman Cloud you run commands in from here, with an organization\'s code:run key (CAVE_TOKEN).',commands:verbs})+'\n');
 return 0;
}

// The snapshot verbs: each one's calls, and its wait unless --no-wait. A wait that fails names what was asked: a
// snapshot asked for, a sandbox made from one, exists all the same.
const snapshotVerbs={
 async snapshot(sandboxes,id,_,input,values){
  const taken=await sandboxes.snapshot(id,input);
  if(values['no-wait'])return taken;
  try{return await sandboxes.waitForSnapshot(id,taken.id);}
  catch(error){const f=failure(error,id);throw own(f.code,`Asked for snapshot ${one(taken.id)}, but it is not ready: ${f.message}`,f.exitCode);}
 },
 snapshots:(sandboxes,id)=>sandboxes.listSnapshots(id),
 async restore(sandboxes,id,snap,_,values){
  const asked=await sandboxes.restore(id,snap);
  return values['no-wait']?asked:sandboxes.waitForRestore(id,snap);
 },
 async fork(sandboxes,id,snap,input,values){
  const made=await sandboxes.fork(id,snap,input);
  if(values['no-wait'])return made;
  try{return {...made,...await sandboxes.waitFor(made.id,'running')};}
  catch(error){const f=failure(error,made.id);throw own(f.code,`Made ${one(made.id)} from snapshot ${snap}, but it is not running: ${f.message}`,f.exitCode);}
 },
 'snapshot-delete':(sandboxes,id,snap)=>sandboxes.deleteSnapshot(id,snap),
};

export async function sandbox(argv,{context}){
 const [verb,...args]=argv;
 if(verb==='exec')return exec(args,{context});
 if(verb==='cp')return cp(args,{context});
 if(verb==='port-forward')return portForward(args,{context});
 let format=process.stdout.isTTY?'table':'json',id;
 try{
  // The format a failure prints in is the one asked for, even when the rest of the line is wrong.
  const loose=parseArgs({args:argv,strict:false,allowPositionals:true,options:{format:{type:'string'}}}).values.format;
  if(['json','table'].includes(loose))format=loose;
  if(verb===undefined||verb==='help'||verb.startsWith('-'))return help(formatOf({format:loose}));
  const known=verbs.find(v=>v.id==='sandbox.'+verb);
  if(!known)throw usage(`Unknown sandbox command ${one(verb)}. Use cvm sandbox ${verbNames}.`);
  const line=`${known.usage} ${common}`;
  let values,positionals;
  try{({values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
   format:{type:'string'},help:{type:'boolean',short:'h'},relay:{type:'string'},
   ...(['create','fork'].includes(verb)?{name:{type:'string'},size:{type:'string'},'sleep-after':{type:'string'}}:{}),
   ...(verb==='create'?{lifetime:{type:'string'},network:{type:'string'}}:{}),
   ...(verb==='snapshot'?{name:{type:'string'}}:{}),
   ...(['create','resume','snapshot','restore','fork'].includes(verb)?{'no-wait':{type:'boolean'}}:{}),
   ...(verb==='sleep'?{wait:{type:'boolean'}}:{}),
   ...(['delete','snapshot-delete'].includes(verb)?{yes:{type:'boolean',short:'y'}}:{}),
   ...(verb==='list'?{mine:{type:'boolean'}}:{}),
   ...(verb==='ls'?{root:{type:'boolean'}}:{}),
   ...(verb==='url'?{public:{type:'boolean'},private:{type:'boolean'},ttl:{type:'string'}}:{}),
  }}));}catch(error){throw usage(`${error.message} Use ${line}.`);}
  format=formatOf(values);
  if(values.help){process.stdout.write(inertJSON({usage:line,summary:known.summary},format==='table'?2:undefined)+'\n');return 0;}
  const snapshotVerb=['snapshot','snapshots','restore','fork','snapshot-delete'].includes(verb);
  const takes=['create','list','status'].includes(verb)?0:['ls','restore','fork','snapshot-delete','url'].includes(verb)?2:1;
  if(positionals.length!==takes)throw usage(`Use ${line}.`);
  if(takes)id=sandboxID(positionals[0],line);
  if(verb==='ls')sandboxPath(positionals[1]);
  const snap=['restore','fork','snapshot-delete'].includes(verb)?snapshotID(positionals[1],line):undefined;
  let input;
  if(verb==='create'||verb==='fork')input=makeInput(values);
  if(verb==='url'){
   const port=/^\d{1,5}$/.test(positionals[1])?Number(positionals[1]):0;
   if(port<1||port>65535)throw usage('The port is a number from 1 to 65535, such as 3000.');
   if(values.public&&values.private)throw usage('A port is --public or --private, not both.');
   input={port,ttlSeconds:portTTL(values.ttl),...(values.public||values.private?{public:Boolean(values.public)}:{})};
  }
  if(verb==='create'){
   const life=lifetime(values.lifetime);
   if(values.network!==undefined&&!['none','internet'].includes(values.network))throw usage('--network is none (no network) or internet.');
   input={...input,...(life!==undefined?{lifetime_seconds:life}:{}),...(values.network!==undefined?{network:values.network}:{})};
  }
  if(verb==='snapshot'){
   if(values.name!==undefined&&(values.name.length>200||/[\x00-\x1f\x7f]/.test(values.name)))throw usage('--name is at most 200 characters, with no control characters.');
   input=values.name!==undefined?{name:values.name}:{};
  }
  // Confirmed before anything is sent, a sign-in refresh included.
  if(verb==='delete'&&!values.yes)throw own('cave_confirmation_required',`Deleting ${id} ends any command running in it and deletes its disk, for good. Repeat with --yes to confirm.`,2);
  if(verb==='snapshot-delete'&&!values.yes)throw own('cave_confirmation_required',`Deleting snapshot ${snap} deletes it for good; sandboxes made from it keep their disks. Repeat with --yes to confirm.`,2);
  const sandboxes=await client(context,values.relay);
  let answer;
  if(snapshotVerb)try{answer=await snapshotVerbs[verb](sandboxes,id,snap,input,values);}catch(error){throw await snapshotsOff(sandboxes,id,error);}
  else if(verb==='create'){
   answer=await sandboxes.create(input);
   // A wait that fails still names the sandbox: it was made, and may need deleting.
   if(!values['no-wait'])try{answer={...answer,...await sandboxes.waitFor(answer.id,'running')};}
   catch(error){const f=failure(error,answer.id);throw own(f.code,`Made ${one(answer.id)}, but it is not running: ${f.message}`,f.exitCode);}
  }else if(verb==='list'){
   // Every page: a list says next_cursor until its last (none at all while the computers API is off).
   const mine=values.mine?{mine:true}:{};
   answer=await sandboxes.list(mine);
   for(const seen=new Set();answer.next_cursor&&!seen.has(answer.next_cursor);){
    seen.add(answer.next_cursor);
    const next=await sandboxes.list({...mine,cursor:answer.next_cursor});
    answer={...next,computers:[...answer.computers??[],...next.computers??[]]};
   }
   if(answer.computers_api!==true)throw off();
  }else if(verb==='status'){
   // Public: the key cvm sends is ignored there. An install that does not serve it answers as an
   // unknown path does (404 cave_not_found).
   try{answer=await sandboxes.status();}
   catch(error){if(error instanceof SandboxError&&error.code==='cave_not_found')throw statusOff();throw error;}
  }else if(verb==='get'){
   answer=await sandboxes.get(id);
   if(answer.bare===undefined)throw off();
  }else if(verb==='url'){
   // The sandbox is read first, so one that is not there, or sandboxes switched off, is said as such; a 404 or a
   // 405 after it is the port routes not served here.
   if((await sandboxes.get(id)).bare===undefined)throw off();
   const {port,ttlSeconds,...visibility}=input;
   let got;
   try{got=await sandboxes.url(id,port,{...(ttlSeconds!==undefined?{ttlSeconds}:{}),...visibility});}
   catch(error){if(error instanceof SandboxError&&['cave_not_found','cave_method_not_allowed'].includes(error.code))throw portsOff(id);throw error;}
   answer={sandbox:id,port,visibility:got.visibility,url:got.url,link:got.link,link_expires_at:got.linkExpiresAt,token:got.token,
    header:Object.keys(got.headers)[0],expires_at:got.expiresAt};
  }
  else if(verb==='ls'){
   const entries=await sandboxes.listFiles(id,positionals[1],values.root?{root:true}:{});
   answer={path:positionals[1],entries:entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)};
  }else if(verb==='sleep'){
   answer=await sandboxes.sleep(id);
   if(values.wait)answer=await sandboxes.waitFor(id,'suspended');
  }else if(verb==='resume'){
   answer=await sandboxes.resume(id);
   if(!values['no-wait'])answer=await sandboxes.waitFor(id,'running');
  }else answer=await sandboxes.delete(id);
  if(format!=='table'){process.stdout.write(inertJSON(answer)+'\n');return 0;}
  if(verb==='status')process.stdout.write(statusTable(answer));
  else if(verb==='snapshots'){
   const list=answer.snapshots??[];
   process.stdout.write(list.length?table([['SNAPSHOT','STATE','NAME','ASKED','TAKEN'],...list.map(s=>[one(s.id),snapStateOf(s),one(s.name)||'-',one(s.created_at),s.ready_at?one(s.ready_at):'-'])])
    :`No snapshots of ${id} yet. Take one with: cvm sandbox snapshot ${id}\n`);
  }else if(verb==='snapshot-delete')process.stdout.write(answer.state==='deleted'?`Deleted snapshot ${one(answer.id)}.\n`:`Deleting snapshot ${one(answer.id)}: its copies are being deleted.\n`);
  else if(verb==='snapshot'||verb==='restore'){
   process.stdout.write(table(snapRowsOf(answer)));
   if(verb==='snapshot'&&answer.state==='ready')process.stdout.write(`\nMake a sandbox from it: cvm sandbox fork ${one(answer.computer_id)} ${one(answer.id)}\n`);
  }
  else if(verb==='url'){
   // stdout is what to open; stderr says for how long, and how a program sends the token instead.
   const at=one(answer.url);
   if(answer.visibility==='public'){
    process.stdout.write(at+'\n');
    process.stderr.write(`Port ${answer.port} of ${one(id)} is public: anyone with ${at} reaches it. Close it with: cvm sandbox url ${one(id)} ${answer.port} --private\n`);
   }else{
    process.stdout.write(one(answer.link)+'\n');
    process.stderr.write(`Open the link before ${one(answer.link_expires_at)}; the browser then keeps port ${answer.port} open until ${one(answer.expires_at)}. `+
     `A program sends the ${one(answer.header)} header with each request to ${at} (cvm sandbox url --format json shows the token).\n`);
   }
  }
  else if(verb==='list'){
   const list=answer.computers??[];
   process.stdout.write(list.length?table([['SANDBOX','NAME','STATE','SIZE','MADE'],...list.map(s=>[one(s.id),one(s.name)||'-',stateOf(s),sizeOf(s),one(s.created_at)])]):'No sandboxes yet. Make one with: cvm sandbox create\n');
  }else if(verb==='ls'){
   process.stdout.write(answer.entries.length?table([['MODE','SIZE','MODIFIED','NAME'],...answer.entries.map(f=>[modeOf(f),String(f.size),one(f.mtime),one(f.name)+(f.link!==undefined?` -> ${one(f.link)}`:'')])]):`${one(answer.path)} is empty.\n`);
  }else if(verb==='delete')process.stdout.write(`Deleted ${one(answer.id)}.\n`);
  else{
   process.stdout.write(table(rowsOf(answer)));
   if(['create','resume','fork'].includes(verb))process.stdout.write(`\nRun a command in it: cvm sandbox exec ${one(answer.id)} -- uname -a\n`);
  }
  return 0;
 }catch(error){return printFailure(format,failure(error,id));}
}

// exec streams the command's output to this terminal and exits with its exit code. Its own failures
// go to stderr (stdout is the command's) with the CLI's exit codes.
async function exec(args,{context}){
 const split=args.indexOf('--');
 const line=`${usageOf('exec')} [--relay URL]`;
 let id,sandboxes,asked=false;
 try{
  let values,positionals;
  try{({values,positionals}=parseArgs({args:split<0?args:args.slice(0,split),strict:true,allowPositionals:true,options:{
   interactive:{type:'boolean',short:'i'},tty:{type:'boolean',short:'t'},relay:{type:'string'},help:{type:'boolean',short:'h'},
   env:{type:'string',short:'e',multiple:true},workdir:{type:'string',short:'w'},user:{type:'string',short:'u'},
  }}));}catch(error){throw usage(`${error.message} Use ${line}.`);}
  if(values.help){process.stdout.write(inertJSON({usage:line,summary:verbs.find(v=>v.id==='sandbox.exec').summary},process.stdout.isTTY?2:undefined)+'\n');return 0;}
  const command=split<0?positionals.slice(1):args.slice(split+1);
  if(positionals.length!==1||!command.length)throw usage(`Name the sandbox, then the command after --. Use ${line}.`);
  id=sandboxID(positionals[0],line);
  if(values.tty&&!process.stdin.isTTY)throw usage('-t gives the command a terminal, and this input is not one. Leave out -t, or run cvm from a terminal.');
  // -e KEY=VALUE, as many as asked (a later one of a key wins); -w an absolute folder.
  const env={};
  for(const pair of values.env??[]){
   const at=pair.indexOf('=');
   if(at<1)throw usage(`-e is KEY=VALUE, not ${one(pair)}.`);
   env[pair.slice(0,at)]=pair.slice(at+1);
  }
  if(values.workdir!==undefined&&!values.workdir.startsWith('/'))throw usage('-w is an absolute folder in the sandbox, such as /tmp.');
  const options={...(Object.keys(env).length?{env}:{}),...(values.workdir!==undefined?{cwd:values.workdir}:{}),...(values.user?{user:values.user}:{})};
  asked=Object.keys(options).length>0;
  sandboxes=await client(context,values.relay);
  const controller=new AbortController(),control=new SandboxCommand();
  // Ctrl-C sends the command INT, and a second ends the stream (the sandbox then ends the command);
  // so does the first, where the sandbox cannot send a signal. With -t -i it is the command's: the
  // terminal's raw input carries it there.
  const end=()=>controller.abort(own('cave_interrupted','Interrupted: the command was ended.',130));
  let interrupted=false;
  const interrupt=()=>{if(interrupted)return end();interrupted=true;control.sendSignal('INT');};
  process.on('SIGINT',interrupt);
  const raw=values.tty&&values.interactive&&process.stdin.isTTY;
  if(raw)process.stdin.setRawMode(true);
  // -t: the terminal is this one's size, and follows it.
  const sized=values.tty&&process.stdout.isTTY&&process.stdout.columns>0&&process.stdout.rows>0;
  const resize=()=>{if(process.stdout.columns>0&&process.stdout.rows>0)control.resize(process.stdout.columns,process.stdout.rows);};
  if(sized)process.on('SIGWINCH',resize);
  const writer=stream=>async chunk=>{if(!stream.write(chunk))await once(stream,'drain');};
  try{
   const code=await sandboxes.exec(id,command,{tty:Boolean(values.tty),signal:controller.signal,stdout:writer(process.stdout),stderr:writer(process.stderr),
    ...(values.interactive?{stdin:process.stdin}:{}),...options,...(sized?{cols:process.stdout.columns,rows:process.stdout.rows}:{}),control,
    // A signal the sandbox cannot send: the stream ends instead, as it did before signals.
    onRefused:refusal=>{if(refusal.of==='signal'&&interrupted)end();}});
   return code;
  }finally{
   if(raw)process.stdin.setRawMode(false);
   process.removeListener('SIGINT',interrupt);
   if(sized)process.removeListener('SIGWINCH',resize);
   if(values.interactive)process.stdin.destroy();
  }
 }catch(error){
  let failed=error?.code==='cave_interrupted'?error:failure(error,id);
  // cave_code_computer_not_running is a sandbox asleep, or one still starting (asked to run, not up yet): say which.
  if(error instanceof SandboxExecError&&error.code==='cave_code_computer_not_running'&&sandboxes){
   const s=await sandboxes.get(id).catch(()=>undefined);
   if(s?.desired_state==='running')failed=new CloudError('cave_code_computer_not_running',`The sandbox is still starting: run the command again once cvm sandbox get ${id} says running.`,failed.exitCode);
  }
  // A sandbox that takes no options: say which of cvm's flags asked for one.
  if(asked&&error instanceof SandboxExecError&&error.code==='cave_code_computer_unsupported')
   failed=new CloudError(failed.code,`${failed.message.replace(/([^.!?])$/,'$1.')} This sandbox runs commands without options: leave out -e, -w and -u.`,failed.exitCode);
  return printFailure('table',failed,{stderr:true});
 }
}

// cp copies one file into a sandbox or out of it, a piece at a time. Out of one, it is written beside its target and
// renamed over it once whole, so a failed copy leaves no half file; - writes it to stdout, which then carries only
// the file (cvm's own failures go to stderr). Into one, a file here keeps its permission bits.
async function cp(args,{context}){
 const line=`${usageOf('cp')} ${common}`;
 let format=process.stdout.isTTY?'table':'json',id,toStdout=false;
 const controller=new AbortController();
 const interrupt=()=>controller.abort(own('cave_interrupted','Interrupted: the copy was ended.',130));
 process.once('SIGINT',interrupt);
 try{
  let values,positionals;
  try{({values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
   root:{type:'boolean'},format:{type:'string'},relay:{type:'string'},help:{type:'boolean',short:'h'},
  }}));}catch(error){throw usage(`${error.message} Use ${line}.`);}
  format=formatOf(values);
  if(values.help){process.stdout.write(inertJSON({usage:line,summary:verbs.find(v=>v.id==='sandbox.cp').summary},format==='table'?2:undefined)+'\n');return 0;}
  if(positionals.length!==2)throw usage(`Name the file and where it goes. Use ${line}.`);
  const [from,to]=positionals,[there,here]=[remoteOf(from),remoteOf(to)];
  if(Boolean(there)===Boolean(here))throw usage(`One side is the sandbox's, SANDBOX:/PATH, and the other a file here or -. Use ${line}.`);
  const root=values.root?{root:true}:{};
  if(here){
   // Into the sandbox: a target ending in / is a folder, the file keeps its name.
   id=here.id;
   if(here.path.endsWith('/')&&from==='-')throw usage('Name the file to write in the sandbox: SANDBOX:/PATH/NAME.');
   const path=here.path.endsWith('/')?here.path+basename(from):here.path;
   let data=process.stdin,mode;
   if(from!=='-'){
    const info=await stat(from).catch(error=>{throw localFailure(error,from);});
    if(info.isDirectory())throw localFailure({code:'EISDIR'},from);
    // The file keeps its permission bits. A Windows file has none: Node reports 0o666 for every
    // writable one (0o444 read-only), which would land world-writable in the sandbox. There the
    // sandbox's own 0o644 applies, as drive put sends no executable bit from Windows.
    if(process.platform!=='win32')mode=info.mode&0o777;
    data=createReadStream(from);
    // A read refused here ends the copy with its own line, not the stream's.
    await once(data,'open').catch(error=>{throw localFailure(error,from);});
   }
   const sandboxes=await client(context,values.relay);
   const file=await sandboxes.writeFile(id,path,data,{...root,...(mode?{mode}:{}),signal:controller.signal});
   process.stdout.write(format==='table'?`Copied ${file.size} bytes to ${id}:${one(path)}.\n`:inertJSON({sandbox:id,path,file})+'\n');
   return 0;
  }
  // Out of the sandbox: a target that is a folder here keeps the file's name.
  id=there.id;
  toStdout=to==='-';
  const sandboxes=await client(context,values.relay);
  if(toStdout){
   await sandboxes.streamFile(id,there.path,async chunk=>{if(!process.stdout.write(chunk))await once(process.stdout,'drain');},{...root,signal:controller.signal});
   return 0;
  }
  const folder=to.endsWith('/')||(await stat(to).catch(()=>undefined))?.isDirectory();
  const target=folder?join(to,basename(there.path)):to;
  const part=join(dirname(target),`.${basename(target)}.cvm-${process.pid}-${Date.now()}`);
  const handle=await open(part,'wx',0o666).catch(error=>{throw localFailure(error,dirname(target));});
  let file;
  try{
   file=await sandboxes.streamFile(id,there.path,async chunk=>{for(let at=0;at<chunk.length;)at+=(await handle.write(chunk,at)).bytesWritten;},{...root,signal:controller.signal});
   // An executable there is one here: x wherever this file may be read (this terminal's umask kept).
   if(file.mode&0o111){const made=(await handle.stat()).mode&0o777;await handle.chmod(made|((made&0o444)>>2));}
   await handle.close();
   await rename(part,target).catch(error=>{throw localFailure(error,target);});
  }catch(error){
   await handle.close().catch(()=>undefined);
   await rm(part,{force:true});
   throw error;
  }
  process.stdout.write(format==='table'?`Copied ${file.size} bytes from ${id}:${one(there.path)} to ${one(target)}.\n`:inertJSON({sandbox:id,path:there.path,file,to:target})+'\n');
  return 0;
 }catch(error){
  const failed=error?.code==='cave_interrupted'?error:failure(error,id);
  return printFailure(toStdout?'table':format,failed,{stderr:toStdout});
 }finally{process.removeListener('SIGINT',interrupt);}
}

// port-forward listens on 127.0.0.1 here (never another address) and carries each connection to the port on the
// sandbox's own loopback, a connection through the relay each; one end's half close reaches the other. A connection
// the sandbox refuses (nothing listens there) is closed with its line on stderr, and the rest go on until Ctrl-C.
async function portForward(args,{context}){
 const line=`${usageOf('port-forward')} ${common}`;
 let format=process.stdout.isTTY?'table':'json',id;
 try{
  let values,positionals;
  try{({values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
   format:{type:'string'},relay:{type:'string'},help:{type:'boolean',short:'h'},
  }}));}catch(error){throw usage(`${error.message} Use ${line}.`);}
  format=formatOf(values);
  if(values.help){process.stdout.write(inertJSON({usage:line,summary:verbs.find(v=>v.id==='sandbox.port-forward').summary},format==='table'?2:undefined)+'\n');return 0;}
  if(positionals.length!==2)throw usage(`Name the sandbox and its port. Use ${line}.`);
  id=sandboxID(positionals[0],line);
  const m=/^(?:(\d{1,5}):)?(\d{1,5})$/.exec(positionals[1]);
  const port=m?Number(m[2]):0,local=m?.[1]!==undefined?Number(m[1]):port;
  if(!m||port<1||port>65535||local>65535)throw usage('The port is a number from 1 to 65535, after LOCAL: for another number here (0 for any free one), such as 8080 or 0:8080.');
  const sandboxes=await client(context,values.relay);
  // The sandbox is read first, so one that is not there, or sandboxes switched off, is said before anything listens.
  if((await sandboxes.get(id)).bare===undefined)throw off();
  // Each connection here, and its connection there once dialed.
  const live=new Map();
  const server=createServer({allowHalfOpen:true},socket=>{
   live.set(socket,undefined);
   // back: the sandbox's side has half-closed; sent: this side's has. Gone before the way back is done, the
   // connection there is dropped; after, it ends as the sandbox ends it (gone before sending all, it is closed).
   const dropped=new AbortController();
   let back=false,sent=false;
   socket.once('close',()=>{const there=live.get(socket);live.delete(socket);if(!back)dropped.abort();else if(!sent)there?.close();});
   socket.on('error',()=>undefined);
   socket.pause();
   void (async()=>{
    try{
     const connection=await sandboxes.dialPort(id,port,{signal:dropped.signal});
     if(live.has(socket))live.set(socket,connection);
     // Here to there, a chunk at a time; this side's end is a half close. (Not for await: its end would destroy the
     // socket, and with it the way back.)
     socket.on('data',chunk=>{socket.pause();connection.write(chunk).then(()=>socket.resume(),()=>socket.destroy());});
     socket.once('end',()=>{sent=true;connection.closeWrite();});
     socket.resume();
     // There to here, until the sandbox's side half-closes.
     for await(const chunk of connection)if(!socket.write(chunk))await Promise.race([once(socket,'drain'),once(socket,'close')]);
     back=true;
     socket.end();
     await connection.closed;
    }catch(error){
     if(!dropped.signal.aborted)printFailure('table',failure(error,id),{stderr:true});
     socket.destroy();
    }
   })();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(local,'127.0.0.1',resolve);}).catch(error=>{
   throw error?.code==='EADDRINUSE'?own('cave_local_port_in_use',`Port ${local} here is in use: name another, or 0:${port} for any free one.`,1):localFailure(error,`port ${local}`);
  });
  const at=`127.0.0.1:${server.address().port}`;
  process.stdout.write(format==='table'?`Forwarding ${at} to port ${port} of ${id}. Ctrl-C ends it.\n`:inertJSON({sandbox:id,port,local:at})+'\n');
  let stop;
  await new Promise(resolve=>{stop=resolve;process.once('SIGINT',stop);process.once('SIGTERM',stop);});
  process.removeListener('SIGINT',stop);
  process.removeListener('SIGTERM',stop);
  server.close();
  for(const [socket,there] of live){there?.close();socket.destroy();}
  return 0;
 }catch(error){return printFailure(format,failure(error,id));}
}
