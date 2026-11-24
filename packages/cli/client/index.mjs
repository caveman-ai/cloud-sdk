import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import catalog from '../../../contracts/operations.public.json' with {type:'json'};
import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {setTimeout as pause} from 'node:timers/promises';
import {scenarioQuality} from './scenario-quality.mjs';

const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);
const validators=new Map();
export const operations=catalog.operations;
export const localCommands=['auth.login','auth.status','context.show','context.list','context.save','context.use','context.set','context.bind','doctor','tools.list','tools.describe','tools.schema','traces.transcript','traces.tail','datasets.from-traces','scenarios.from-trace','targets.list','targets.get','targets.validate','manifests.validate','manifests.push',...['datasets','evaluators','evals','scenarios','prompts'].flatMap(f=>['validate','pull','diff','push','versions'].map(v=>f+'.'+v)).filter(id=>!['datasets.diff','datasets.versions'].includes(id)),'datasets.diff-manifest','evals.wait','scenario-runs.wait','experiments.wait'];
export const contractSHA256=catalog.contract_sha256;
export class CloudError extends Error {
 constructor(code,message,exitCode=1,details){super(message);this.code=code;this.exitCode=exitCode;this.details=details;}
}
// The few names closest to a mistyped one: edit distance within a third of its
// length, or one that contains the other. Nearest first.
export function nearest(word,candidates,limit=3){
 const distance=(a,b)=>{let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(row[j]+1,next[j-1]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}return row[b.length];};
 const w=String(word??'').toLowerCase();if(!w)return [];
 return [...new Set(candidates)].map(c=>({c,d:distance(w,c.toLowerCase()),contains:w.length>=3&&(c.toLowerCase().includes(w)||w.includes(c.toLowerCase()))})).filter(x=>x.d<=Math.max(1,Math.floor(w.length/3))||x.contains).sort((a,b)=>a.d-b.d||a.c.localeCompare(b.c)).slice(0,limit).map(x=>x.c);
}
const didYouMean=names=>names.length?` Did you mean ${names.join(' or ')}?`:'';
// A mistyped verb is matched within its family; a mistyped family, by the whole id.
function nearestOperation(id){
 const names=operations.flatMap(o=>[o.id,...o.aliases.filter(a=>!a.startsWith('caveman_'))]);
 const at=String(id).indexOf('.'),family=String(id).slice(0,at+1);
 const siblings=at>0?names.filter(name=>name.startsWith(family)):[];
 return siblings.length?nearest(String(id).slice(at+1),siblings.map(name=>name.slice(family.length))).map(verb=>family+verb):nearest(id,names);
}
export function describeOperation(id){
 const op=operations.find(o=>o.id===id || o.aliases.includes(id));
 if(!op)throw new CloudError('cave_unknown_operation',`Unknown operation ${id}.${didYouMean(nearestOperation(id))} Run cvm tools list.`,2);
 return op;
}
export function describeCommand(id){
 if(!localCommands.includes(id))return describeOperation(id);
 const [family,verb]=id.split('.'),uuid={type:'string',format:'uuid'};
 let input_schema={type:'object',additionalProperties:false,properties:{}};
 let usage=`cvm ${id.replaceAll('.',' ')}`;
 if(['traces.transcript','datasets.from-traces','scenarios.from-trace'].includes(id)){
  const {kind,...properties}=describeOperation('traces.payload').input_schema.properties;
  input_schema={type:'object',additionalProperties:false,properties,required:Object.keys(properties)};
  usage+=' --file SELECTION.json [--out OUTPUT.json]';
 }else if(family==='targets'){
  input_schema=verb==='validate'?describeOperation('evals.create').input_schema.properties.document.properties.targets.items:{type:'object',additionalProperties:false,properties:{workbench_id:uuid,...(verb==='get'?{target_key:{type:'string'}}:{})},required:['workbench_id',...(verb==='get'?['target_key']:[])]};
  usage+=verb==='validate'?' --file TARGET.json':` WORKBENCH_ID${verb==='get'?' TARGET_KEY':''}`;
 }else if(family==='prompts'&&['validate','diff','push'].includes(verb)){
  input_schema={type:'object',required:['schema_version','kind','spec'],properties:{schema_version:{const:1},kind:{const:'prompts'},spec:{type:'object'},resource:{type:'object',required:['id','version'],properties:{id:uuid,version:{type:'integer',minimum:1}}}}};
  usage+=' --file MANIFEST.json';
 }else if(['datasets','evaluators','evals','scenarios'].includes(family)&&['validate','diff','diff-manifest','push'].includes(verb)){
  input_schema={type:'object',additionalProperties:false,required:['schema_version','kind','spec'],properties:{schema_version:{const:1},kind:{const:family},spec:describeOperation(family+'.create').input_schema,resource:{type:'object',additionalProperties:false,required:['id','revision',...(family==='scenarios'?['version']:[])],properties:{id:uuid,revision:{type:'integer',minimum:1},...(family==='scenarios'?{version:{type:'integer',minimum:1}}:{})}}}};
  usage+=' --file MANIFEST.json';
 }else if(['pull','versions'].includes(verb))usage+=' RESOURCE_ID [--out FILE]';
 else if(verb==='wait'){input_schema=describeOperation(family==='scenario-runs'?'scenario-runs.get':family==='experiments'?'experiments.get':'evals.result').input_schema;usage+=family==='evals'?' WORKBENCH_ID RUN_ID [--wait-timeout MS]':family==='experiments'?' EXPERIMENT_ID [--wait-timeout MS]  exit 0 verdict, 5 typed refusal, 6 failed/error/cancelled/rolled back, 7 wait timed out or interrupted':' RUN_ID [--wait-timeout MS]';}
 else if(family==='manifests')usage+=' --file BUNDLE.json'+(verb==='push'?' --lock LOCK.json':'');
 else if(id==='traces.tail')usage='cvm traces tail [--since 5m|2h|7d|ISO] [--interval SECONDS] [--filter JSON] [--filters JSON] [--limit N] [--timeout SECONDS] [--project UUID] [--format table|jsonl]  prints each new trace once as it arrives (polls traces.search); exit 0 at --limit, --timeout or Ctrl-C';
 else if(family==='context')usage+={save:' NAME --endpoint URL --token-env VARIABLE [--project UUID]',use:' NAME',set:' PROJECT_ID',bind:' PROJECT_ID',show:'',list:''}[verb];
 return {id,version:'1',execution:'client_workflow',summary:usage,input_schema,usage};
}
export function validateOperation(id,input){
 const op=describeOperation(id);
 for(const part of [input?.parameters,input?.query,input?.body])if(part&&['projectId','orgId','project_id','organization_id'].some(key=>Object.hasOwn(part,key)))throw new CloudError('cave_scope_argument_rejected','Scope comes from authenticated context and --project, not operation input.',2);
 if(!validators.has(op.id))validators.set(op.id,ajv.compile(op.input_schema));
 const validate=validators.get(op.id);
 if(!validate(input))throw new CloudError('cave_operation_input_invalid',`Invalid input for ${op.id}.`,2,validate.errors);
 return input;
}
// The one command that ends an API version conflict. cvm ships from the same
// tag as its Cloud release and @rc is the line the spec hands out
// (npm's latest lags behind it): a server that reports a release version gets
// exactly that version, any other (hosted Cloud reports a commit) the newest.
export function upgradeCommand(serverVersion){
 const version=typeof serverVersion==='string'?serverVersion.replace(/^v(?=\d)/,''):'';
 return `npm install -g @caveman-ai/cloud@${/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)?version:'rc'}`;
}
export const versionConflictMessage=(command=upgradeCommand(),then='run the command again')=>`This cvm and the Caveman server speak different API versions. Upgrade cvm (${command}), or install the cvm version that matches a self-hosted server, then ${then}.`;
const statusExit=status=>status===401||status===403?3:status===409?4:status===429?7:status===422||status===400?2:1;
export class CloudClient {
 // allowPlainHTTP: only the agent runner's MCP wrapper passes it, for an in-cluster control API over http.
 constructor({baseURL,token,projectId,fetch:transport=globalThis.fetch,timeout=30000,allowPlainHTTP=false}){
  const endpoint=new URL(baseURL);
  if(endpoint.protocol!=='https:' && !(endpoint.protocol==='http:' && (allowPlainHTTP===true || ['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))))throw new CloudError('cave_endpoint_invalid','Cloud endpoint must use HTTPS or loopback HTTP.',2);
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new CloudError('cave_endpoint_invalid','Cloud endpoint cannot contain credentials, query, or fragment.',2);
  if(!Number.isInteger(timeout)||timeout<100||timeout>120000)throw new CloudError('cave_timeout_invalid','Timeout must be 100-120000 ms.',2);
  this.baseURL=baseURL.replace(/\/$/,'');this.token=token;this.projectId=projectId;this.fetch=transport;this.timeout=timeout;
 }
 // method is GET without a body and POST with one, unless named (PATCH).
 async request(path,{body,headers={},signal,method}={}){
  if(!this.token)throw new CloudError('cave_auth_required','Run cvm login, or set CAVE_TOKEN for headless use.',3);
  const cancellation=signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeout)]):AbortSignal.timeout(this.timeout);
  let response;
  try{response=await this.fetch(this.baseURL+path,{method:method??(body===undefined?'GET':'POST'),redirect:'error',signal:cancellation,headers:{authorization:`Bearer ${this.token}`,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch(e){throw new CloudError(cancellation.aborted?'cave_timeout':'cave_network_error',cancellation.aborted?'Request timed out or wait was interrupted; remote work may continue.':'Cloud request failed. Inspect resource state; receipted writes can retry with the same idempotency key.',cancellation.aborted?6:1);}
  // Reads can contain payloads. Bound response bytes before parsing; neither
  // credentials nor request/response documents are written to logs.
  if(Number(response.headers.get('content-length'))>16*1024*1024)throw new CloudError('cave_result_too_large','Result exceeds 16 MiB; narrow the query.',6);
  const reader=response.body?.getReader();let bytes=0;const chunks=[];
  if(reader){try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16*1024*1024){await reader.cancel();throw new CloudError('cave_result_too_large','Result exceeds 16 MiB; narrow the query.',6);}chunks.push(value);}}finally{reader.releaseLock();}}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{if(response.ok)throw new CloudError('cave_invalid_response','Cloud returned an invalid JSON response.',6);result={};}
  if(!response.ok){const error=result.error?.error??result.error??result;const retry=Number(response.headers.get('retry-after'));const failure=new CloudError(error.code??'cave_request_failed',error.message??`Cloud request failed (${response.status}).`,statusExit(response.status),retry>0?{...result,retry_after_seconds:retry}:result);failure.httpStatus=response.status;throw failure;}
  return result;
 }
 async discover(){return this.request('/api/v1/cloud/operations');}
 // An operation with no permission is a public read (system version, provider
 // catalog): the operation ingress refuses every permissionless operation, so
 // it is read from its own route, with no credential, and wrapped like a result.
 async publicRead(op,input={}){
  if(op.permissions.length||op.method!=='GET'||op.access!=='none'||/[{]/.test(op.path))throw new CloudError('cave_operation_not_public',`${op.id} is not a public read.`,2);
  const query=new URLSearchParams();for(const [key,value]of Object.entries(input.query??{}))for(const item of [value].flat())query.append(key,String(item));
  let response;
  try{response=await this.fetch(`${this.baseURL}/api/v1${op.path}${query.size?'?'+query:''}`,{redirect:'error',signal:AbortSignal.timeout(this.timeout)});}
  catch{throw new CloudError('cave_network_error','Cloud request failed.',1);}
  const body=await response.json().catch(()=>undefined);
  if(!response.ok||body===undefined)throw new CloudError(body?.error?.code??'cave_request_failed',body?.error?.message??`Cloud request failed (${response.status}).`,statusExit(response.status));
  return {schema_version:1,operation:op.id,version:op.version,contract_sha256:op.contract_sha256,ok:true,status:'completed',data:body};
 }
 // The release a server reports (public, unauthenticated); undefined when it cannot say.
 async serverVersion(){
  try{const response=await this.fetch(this.baseURL+'/api/v1/system/version',{redirect:'error',signal:AbortSignal.timeout(Math.min(this.timeout,5000))});if(!response.ok)return undefined;const {version}=await response.json();return typeof version==='string'&&version.length<=100&&/^[\w.+-]+$/.test(version)?version:undefined;}
  catch{return undefined;}
 }
 async waitScenario(runId,{signal,deadline=Date.now()+3600000,pollMs=1000}={}){
  if(!Number.isSafeInteger(deadline)||!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>30000)throw new CloudError('cave_usage','Invalid wait deadline or polling interval.',2);
  while(Date.now()<deadline){
   const result=await this.execute('scenario-runs.get',{run_id:runId},{signal});
   if(result.data.id!==runId)throw new CloudError('cave_invalid_response','Run identity changed.',6);
   if(['completed','cancelled','interrupted','error'].includes(result.data.status))return result;
   if(!['queued','running'].includes(result.data.status))throw new CloudError('cave_invalid_response','Unknown scenario run status.',6);
   try{await pause(Math.min(pollMs,Math.max(1,deadline-Date.now())),undefined,{signal});}catch{throw new CloudError('cave_wait_interrupted','Wait interrupted; durable run continues. Reconnect with scenario-runs wait.',6);}
  }
  throw new CloudError('cave_wait_timeout','Wait expired; durable run continues. Reconnect with scenario-runs wait.',6);
 }
 // Experiments carry no lifecycle enum in their contract. These are every
 // state the worker ends one in (failExperiment writes error; the eval path
 // writes passed); anything else is still in flight until the deadline.
 async waitExperiment(experimentId,{signal,deadline=Date.now()+3600000,pollMs=2000}={}){
  if(!Number.isSafeInteger(deadline)||!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>30000)throw new CloudError('cave_usage','Invalid wait deadline or polling interval.',2);
  while(Date.now()<deadline){
   const result=await this.execute('experiments.get',{experiment_id:experimentId},{signal});
   if(result.data.id!==experimentId)throw new CloudError('cave_invalid_response','Experiment identity changed.',6);
   if(['completed','passed','failed','error','cancelled','rolled_back'].includes(result.data.state))return result;
   try{await pause(Math.min(pollMs,Math.max(1,deadline-Date.now())),undefined,{signal});}catch{throw new CloudError('cave_wait_interrupted','Wait interrupted; the experiment continues. Reconnect with experiments wait.',7);}
  }
  throw new CloudError('cave_wait_timeout','Wait expired; the experiment continues. Reconnect with experiments wait.',7);
 }
 async waitEvaluation(workbenchId,runId,{signal,deadline=Date.now()+3600000,pollMs=1000,onProgress}={}){
  if(!Number.isSafeInteger(deadline)||!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>30000)throw new CloudError('cave_usage','Invalid wait deadline or polling interval.',2);
  while(Date.now()<deadline){
   const result=await this.execute('evals.result',{workbench_id:workbenchId,run_id:runId},{signal});
   const run=result.data.run;
   if(run?.id!==runId||run?.workbench_id!==workbenchId)throw new CloudError('cave_invalid_response','Evaluation run identity changed.',6);
   if(['completed','failed','error','cancelled'].includes(run?.status))return result;
   if(!['queued','running','cancelling'].includes(run?.status))throw new CloudError('cave_invalid_response','Unknown evaluation run status.',6);
   onProgress?.({run_id:runId,status:run.status,completed:run.progress_completed,total:run.progress_total});
   try{await pause(Math.min(pollMs,Math.max(1,deadline-Date.now())),undefined,{signal});}catch{throw new CloudError('cave_wait_interrupted','Wait interrupted; durable run continues. Reconnect with evals wait.',6);}
  }
  throw new CloudError('cave_wait_timeout','Wait expired; durable run continues. Reconnect with evals wait.',6);
 }
 async execute(id,input={},options={}){
  const op=describeOperation(id);validateOperation(op.id,input);
  if(op.scope==='project'&&(!this.projectId||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(this.projectId))))throw new CloudError('cave_project_required','Select a project with --project or saved context. Ambiguous project selection is not allowed.',2);
  if(op.transactional&&!options.idempotencyKey)throw new CloudError('cave_idempotency_key_required','This write needs --idempotency-key; reuse it only for identical retries.',2);
  // The server refuses a key on any other operation (422): say so before the request, and what to do instead.
  if(!op.transactional&&options.idempotencyKey)throw new CloudError('cave_idempotency_unsupported',`${op.id} is not a receipted write, so it takes no idempotency key. Leave it out; after a failed attempt, read the current state before you retry.`,2);
  let result;
  try{result=await this.request(`/api/v1${op.scope==='project'?'/projects/'+this.projectId:''}/cloud/operations/${encodeURIComponent(op.id)}`,{body:input,headers:{'x-cave-operation-contract':op.contract_sha256,...(options.idempotencyKey?{'idempotency-key':options.idempotencyKey}:{})},signal:options.signal});}
  catch(error){
   // A refused contract says how to end it: the exact install command.
   if(error?.code!=='cave_operation_version_conflict')throw error;
   const version=await this.serverVersion(),command=upgradeCommand(version);
   error.message=versionConflictMessage(command);error.details={...(error.details&&typeof error.details==='object'?error.details:{}),next_action:command,...(version?{server_version:version}:{})};
   throw error;
  }
  if(result.schema_version!==1||result.operation!==op.id||result.version!==op.version||result.contract_sha256!==op.contract_sha256||result.ok!==true||!['completed','accepted'].includes(result.status))throw new CloudError('cave_invalid_response','Cloud returned a mismatched operation result.',6);
  const outputKey=op.id+':output';
  if(!validators.has(outputKey))validators.set(outputKey,ajv.compile(op.output_schema));
  if(!validators.get(outputKey)(result.data))throw new CloudError('cave_invalid_response','Cloud result does not match its operation schema.',6);
  return result;
 }
}
async function inputFile(file,stdin){
 if(file&&stdin)throw new CloudError('cave_usage','Use either --file or --stdin.',2);
 let text='{}';if(file)text=await readFile(file,'utf8');else if(stdin){const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=Buffer.byteLength(chunk);if(bytes>16*1024*1024)throw new CloudError('cave_input_too_large','Input exceeds 16 MiB.',2);chunks.push(chunk);}text=Buffer.concat(chunks).toString('utf8');}
 if(Buffer.byteLength(text)>16*1024*1024)throw new CloudError('cave_input_too_large','Input exceeds 16 MiB.',2);
 try{return JSON.parse(text);}catch{throw new CloudError('cave_invalid_json','Input must be one JSON document.',2);}
}
// inertJSON also escapes what JSON.stringify leaves raw (DEL, C1, format and
// line-separator characters): the same value, inert on a terminal.
export const inertJSON=(v,space)=>JSON.stringify(v,null,space).replace(/[\x7f-\x9f\p{Cf}\u2028\u2029]/gu,c=>c.split('').map(u=>'\\u'+u.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
function display(value,format){
 if(format==='json'||format==='jsonl'){process.stdout.write(inertJSON(value)+(format==='jsonl'?'\n':'\n'));return;}
 if(Array.isArray(value)){for(const row of value)process.stdout.write(typeof row==='string'?row+'\n':`${row.id??row.operation??''}\t${row.summary??row.status??''}\n`);return;}
 process.stdout.write(inertJSON(value,2)+'\n');
}
// The format a help screen answers in, read before any command parses its flags.
function helpFormat(argv,fallback){
 const at=argv.findIndex(a=>a==='--format'||a.startsWith('--format='));
 const format=at<0?fallback:argv[at].startsWith('--format=')?argv[at].slice(9):argv[at+1];
 if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be json, jsonl, or table.',2);
 return format;
}
const helpWord=word=>['--help','-h','help'].includes(word);
// commands: what the host CLI answers itself (cvm setup, login, evals init ...), as {id, usage, summary}, so help lists them.
export async function runCloudCLI(argv,{context:hostContext,login,commands:hostCommands=[]}={}){
 let format=process.stdout.isTTY?'table':'json';
 let reconnect;
 try{
  let profile;
  argv=[...argv];
  for(let i=0;i<argv.length;i++){if(argv[i]==='--profile'||argv[i].startsWith('--profile=')){if(profile!==undefined)throw new CloudError('cave_usage','Supply --profile once.',2);const inline=argv[i].startsWith('--profile=');profile=inline?argv[i].slice(10):argv[i+1];if(!profile||profile.startsWith('--'))throw new CloudError('cave_usage','--profile needs a name.',2);argv.splice(i,inline?1:2);i--;}}
  const {cloudContext}=await import('./context.mjs');
  const contexts=cloudContext(hostContext??(async()=>({baseURL:process.env.CAVE_API_URL??'https://api.caveman.so',token:process.env.CAVE_TOKEN,projectId:process.env.CAVE_PROJECT_ID})));
  const context=(options={})=>contexts.resolve({profile,...options});
  if(argv[0]==='help'&&argv[1]&&!argv[1].startsWith('-'))argv=[...argv.slice(1),'--help']; // cvm help traces [search]
  if(argv[0]==='evals'&&argv[1]==='drafts')argv.splice(0,2,'eval_drafts'); // `evals drafts list` reads as the eval_drafts family
  // datasets versions and datasets diff are the operations (the version list with what is pending; two versions
  // compared). A dataset manifest against the server is datasets diff-manifest; the other kinds keep diff.
  const [family,typed,...args]=argv;
  const datasetOperation=family==='datasets'&&['diff','versions'].includes(typed);
  const verb=family==='datasets'&&typed==='diff-manifest'?'diff':typed;
  if(localCommands.includes(`${family}.${typed}`)&&args.includes('--help')){
   format=helpFormat(args,format);const command=describeCommand(`${family}.${typed}`);
   if(format==='table'){const {renderVerbHelp}=await import('./help.mjs');process.stdout.write(renderVerbHelp(command));}else display(command,format);
   return 0;
  }
  if(family==='doctor'||family==='auth'&&verb==='status'||family==='context'&&['show','list','save','use','set','bind'].includes(verb)){
   const {values,positionals}=parseArgs({args:family==='doctor'?argv.slice(1):args,allowPositionals:true,strict:true,options:{format:{type:'string'},project:{type:'string'},...(family==='context'&&verb==='save'?{endpoint:{type:'string'},'token-env':{type:'string'}}:{})}});
   format=values.format??format;if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be json, jsonl, or table.',2);
   let result;
   if(family==='context')result=await contexts.command(verb,values,positionals,profile);
   else {if(positionals.length)throw new CloudError('cave_usage','Unexpected positional arguments.',2);result=family==='doctor'?await contexts.doctor({profile,projectId:values.project}):await new CloudClient(await context()).execute('context.whoami',{});}
   const screen=format==='table'?await import('./help.mjs').then(h=>family==='doctor'?h.renderDoctor(result):family==='auth'?h.renderWhoami(result):verb==='show'?h.renderContext(result):undefined):undefined;
   if(screen!==undefined)process.stdout.write(screen);else display(result,format);
   return result.ok===false?4:0;
  }
  if(family==='auth'&&verb==='login'){
   if((await contexts.resolve({profile})).profile!=='default')throw new CloudError('cave_usage','Named profiles use their configured token environment variable.',2);
   if(!process.stdin.isTTY)throw new CloudError('cave_auth_required','For headless use, set CAVE_TOKEN or a named profile token environment variable.',3);
   if(!login)throw new CloudError('cave_auth_required','Run cvm login.',3);
   await login(args);return 0;
  }
  if(!family||helpWord(family)||family.startsWith('--format')&&argv.slice(2).every(helpWord)){
   format=helpFormat(argv,format);const {topHelp,renderTopHelp}=await import('./help.mjs');const help=topHelp(hostCommands);
   if(format==='table')process.stdout.write(renderTopHelp(help,hostCommands));else display(help,format);
   return 0;
  }
  // A family alone (or with --help) lists its verbs; an unknown one names the nearest.
  // A host command with no verb (cvm mcp) reaches here only with something after it.
  const hostCommand=hostCommands.find(c=>c.id===family&&!operations.some(o=>o.id.startsWith(family+'.')));
  if(hostCommand){if(typed===undefined||helpWord(typed)){display({usage:hostCommand.usage,summary:hostCommand.summary},helpFormat(args,format));return 0;}throw new CloudError('cave_usage',`Use ${hostCommand.usage}.`,2);}
  if(family!=='sql'){
   const families=new Set([...operations.flatMap(o=>[o.id,...o.aliases.filter(a=>!a.startsWith('caveman_'))]),...localCommands,...hostCommands.map(c=>c.id)].map(id=>id.split('.')[0]));
   if(!families.has(family))throw new CloudError('cave_unknown_command',`Unknown command ${family}.${didYouMean(nearest(family,[...families]).map(f=>'cvm '+f))} Run cvm --help for the families.`,2);
   if(typed===undefined||helpWord(typed)||typed.startsWith('-')&&!args.some(a=>!a.startsWith('-')&&!['json','jsonl','table'].includes(a))){
    format=helpFormat(argv.slice(1),format);const {familyHelp,renderFamilyHelp}=await import('./help.mjs');const help=familyHelp(family,hostCommands);
    if(format==='table')process.stdout.write(renderFamilyHelp(help));else display(help,format);
    return 0;
   }
  }
  // cvm sql "<SQL>"; sql query|schema|tag_keys stay the generic operations.
  if(family==='sql'&&!['query','schema','tag_keys'].includes(verb)){
   const {sqlCommand}=await import('./sql.mjs');
   return await sqlCommand(argv.slice(1),{format,connect:async({projectId,timeout})=>{const cfg=await context({projectId});return new CloudClient({...cfg,projectId:projectId??cfg.projectId,timeout});}});
  }
  if(family==='traces'&&verb==='transcript'||family==='datasets'&&verb==='from-traces'||family==='scenarios'&&verb==='from-trace'){
   const {traceTranscript,datasetFromTraces,scenarioFromTrace}=await import('./traces.mjs');
   const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{file:{type:'string'},stdin:{type:'boolean'},trace:{type:'string'},'request-id':{type:'string'},from:{type:'string'},to:{type:'string'},name:{type:'string'},out:{type:'string'},project:{type:'string'},format:{type:'string'}}});
   format=values.format??format;if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be json, jsonl, or table.',2);
   if(positionals.length>1)throw new CloudError('cave_usage','Supply one trace ID or a selection file.',2);
   const selection=values.file||values.stdin?await inputFile(values.file,values.stdin):{trace_id:values.trace??positionals[0],request_id:values['request-id'],from:values.from,to:values.to};
   const cfg=await context({projectId:values.project});const client=new CloudClient({...cfg,projectId:values.project??cfg.projectId});
   const result=verb==='transcript'?await traceTranscript(client,selection):verb==='from-trace'?await scenarioFromTrace(client,selection,{name:values.name}):await datasetFromTraces(client,Array.isArray(selection)?selection:[selection],{name:values.name});
   if(values.out)await writeFile(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
   display(result,format);return verb==='transcript'&&result.warnings.length?6:0;
  }
  if(family==='traces'&&verb==='tail'){
   const {tailOptions,tailTraces,tailRow,tailUsage}=await import('./traces.mjs');
   const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{since:{type:'string'},interval:{type:'string'},filter:{type:'string'},filters:{type:'string'},limit:{type:'string'},timeout:{type:'string'},project:{type:'string'},format:{type:'string'}}});
   format=values.format??format;if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be table or jsonl.',2);
   if(positionals.length)throw new CloudError('cave_usage',`Use ${tailUsage}.`,2);
   const options=tailOptions(values);
   const cfg=await context({projectId:values.project});const client=new CloudClient({...cfg,projectId:values.project??cfg.projectId});
   // validate the first query before printing anything
   validateOperation('traces.search',{from:new Date(options.since).toISOString(),to:new Date().toISOString(),page_size:100,sort:{by:'timestamp',dir:'desc'},...(options.filter?{filter:options.filter}:{}),...(options.filters?{filters:options.filters}:{})});
   const cancel=new AbortController();const interrupt=()=>cancel.abort();process.once('SIGINT',interrupt);
   if(format==='table')process.stderr.write(`Waiting for traces in project ${client.projectId} (Ctrl-C to stop)…\n`);
   try{
    const done=await tailTraces(client,options,{signal:cancel.signal,onTrace:item=>process.stdout.write(format==='table'?tailRow(item)+'\n':inertJSON({schema_version:1,operation:'traces.tail',trace:item})+'\n'),onNotice:text=>process.stderr.write(text+'\n')});
    if(format==='table')process.stderr.write(`${done.shown} trace${done.shown===1?'':'s'} (${done.reason}).\n`);
   }finally{process.removeListener('SIGINT',interrupt);}
   return 0;
  }
  if(family==='targets'&&['list','get','validate'].includes(verb)){
   const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{file:{type:'string'},stdin:{type:'boolean'},project:{type:'string'},format:{type:'string'}}});
   format=values.format??format;if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be json, jsonl, or table.',2);
   const targetSchema=describeOperation('evals.create').input_schema.properties.document.properties.targets.items;
   if(verb==='validate'){
    if(positionals.length)throw new CloudError('cave_usage','Use targets validate --file TARGET.json.',2);
    const validate=ajv.compile(targetSchema),target=await inputFile(values.file,values.stdin);
    if(!validate(target))throw new CloudError('cave_target_invalid','Invalid target configuration.',2,validate.errors);
    display({schema_version:1,ok:true,validation:'json_schema',models_invoked:0,limitations:['Server resolves references, provider access and execution policy when creating a run.']},format);return 0;
   }
   if(values.file||values.stdin||positionals.length!==(verb==='get'?2:1))throw new CloudError('cave_usage','Use targets list WORKBENCH_ID or targets get WORKBENCH_ID TARGET_KEY.',2);
   const client=new CloudClient(await context({projectId:values.project}));
   const response=await client.execute('evals.get',{workbench_id:positionals[0]});
   const workbench=response.data.workbench;
   const targets=workbench.document.targets.filter(target=>verb==='list'||target.key===positionals[1]);
   if(verb==='get'&&targets.length!==1)throw new CloudError('cave_target_not_found','Target not found in this workbench.',1);
   display({schema_version:1,workbench_id:workbench.id,revision:workbench.revision,targets,limitations:['Configuration identity is recorded here. Run evidence establishes whether execution completed.']},format);return 0;
  }
  if(family==='manifests'&&['validate','push'].includes(verb)){
   const {validateBundle,pushBundle}=await import('./manifests.mjs');
   const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{file:{type:'string'},stdin:{type:'boolean'},lock:{type:'string'},project:{type:'string'},format:{type:'string'}}});
   format=values.format??format;if(!['json','jsonl','table'].includes(format)||positionals.length)throw new CloudError('cave_usage','Use manifests validate|push --file BUNDLE [--lock LOCK].',2);
   const bundle=validateBundle(await inputFile(values.file,values.stdin));
   if(verb==='validate'){display({schema_version:1,ok:true,resources:bundle.resources.map(r=>r.name),validation:'json_schema',models_invoked:0},format);return 0;}
   if(!values.lock)throw new CloudError('cave_usage','Multi-resource push needs --lock FILE to preserve partial receipts.',2);
   let lock;try{lock=JSON.parse(await readFile(values.lock,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new CloudError('cave_lock_invalid','Lock must be valid JSON.',2);}
   const cfg=await context({projectId:values.project});
   const result=await pushBundle(new CloudClient(cfg),bundle,{lock,onReceipt:async value=>{const {rename}=await import('node:fs/promises');const {randomUUID}=await import('node:crypto');const tmp=values.lock+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,values.lock);}});
   display(result,format);return result.exit_code;
  }
  if(family==='prompts'&&['validate','pull','diff','push','versions'].includes(verb)){
   const {validatePromptManifest,pullPromptManifest,pushPromptManifest}=await import('./prompt-manifests.mjs');
   const {manifestDiff}=await import('./manifests.mjs');
   const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{file:{type:'string'},stdin:{type:'boolean'},out:{type:'string'},project:{type:'string'},format:{type:'string'},version:{type:'string'}}});
   format=values.format??format;
   if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be json, jsonl, or table.',2);
   if(values.version!==undefined&&(!Number.isSafeInteger(Number(values.version))||Number(values.version)<1))throw new CloudError('cave_usage','--version must be a positive integer.',2);
   let manifest=['validate','diff','push'].includes(verb)?validatePromptManifest(await inputFile(values.file,values.stdin)):undefined;
   let result;
   if(verb==='validate')result={schema_version:1,ok:true,validation:'json_schema',kind:'prompts'};
   else{
    const client=new CloudClient(await context({projectId:values.project}));
    if(['pull','versions'].includes(verb)){
     if(positionals.length!==1)throw new CloudError('cave_usage','Supply one prompt ID.',2);
     result=verb==='pull'?await pullPromptManifest(client,positionals[0],values.version===undefined?undefined:Number(values.version)):(await client.execute('prompts.get',{prompt_id:positionals[0]})).data.versions;
    }else if(verb==='diff'){
     const previous=manifest.resource?await pullPromptManifest(client,manifest.resource.id):undefined;
     result={schema_version:1,ok:true,version:previous?.resource.version??null,revision_conflict:!!previous&&previous.resource.version!==manifest.resource.version,changes:manifestDiff(previous,manifest)};
    }else result=await pushPromptManifest(client,manifest);
   }
   if(values.out)await writeFile(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
   display(result,format);return result.revision_conflict?4:0;
  }
  if(!datasetOperation&&['datasets','evaluators','evals','scenarios'].includes(family)&&['validate','pull','diff','push','versions'].includes(verb)){
   const {validateManifest,pullManifest,manifestDiff,pushManifest,parseRows}=await import('./manifests.mjs');
   const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{file:{type:'string'},stdin:{type:'boolean'},out:{type:'string'},project:{type:'string'},format:{type:'string'},...(family==='scenarios'?{version:{type:'string'}}:{}),...(family==='datasets'?{rows:{type:'string'},'rows-out':{type:'string'}}:{}),'idempotency-key':{type:'string'}}});
   format=values.format??format;if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be json, jsonl, or table.',2);
   if(values['rows-out']&&verb!=='pull')throw new CloudError('cave_usage','--rows-out requires datasets pull.',2);
   let result;
   let manifest=['validate','diff','push'].includes(verb)?await inputFile(values.file,values.stdin):undefined;
   if(values.rows){if(!manifest?.spec?.document||manifest.spec.document.rows?.length)throw new CloudError('cave_usage','--rows requires a dataset manifest with empty document.rows.',2);manifest.spec.document.rows=parseRows(await readFile(values.rows,'utf8'));}
   if(manifest)manifest=validateManifest(manifest,family);
   if(verb==='validate')result={schema_version:1,ok:true,status:'completed',validation:'json_schema',kind:family,limitations:['Server checks resource references and domain constraints when applying. No write or model call performed.']};
   else{
    const cfg=await context({projectId:values.project});const client=new CloudClient({...cfg,projectId:values.project??cfg.projectId});
    if(verb==='pull'||verb==='versions'){
     if(positionals.length!==1)throw new CloudError('cave_usage',`${family} ${verb} requires one resource ID.`,2);
     if(verb==='pull')result=await pullManifest(client,family,positionals[0],values.version===undefined?undefined:Number(values.version));
     else {const op=describeOperation(`${family==='scenarios'?'datasets':family}.get`);result=(await client.execute(op.id,{[Object.values(op.binding.path_inputs)[0]]:positionals[0]})).data.versions;}
    }else if(verb==='diff'){
     const previous=manifest.resource?await pullManifest(client,family,manifest.resource.id,manifest.resource.version):undefined;
     result={schema_version:1,ok:true,status:'completed',revision:previous?.resource.revision??null,revision_conflict:!!previous&&previous.resource.revision!==manifest.resource.revision,changes:manifestDiff(previous,manifest)};
    }else result=await pushManifest(client,manifest,{idempotencyKey:values['idempotency-key']});
   }
   if(values['rows-out']){if(verb!=='pull')throw new CloudError('cave_usage','--rows-out requires datasets pull.',2);await writeFile(values['rows-out'],result.spec.document.rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx',mode:0o600});result.spec.document.rows=[];}
   if(values.out)await writeFile(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
   display(result,format);return result.revision_conflict?4:0;
  }
  if(family==='experiments'&&verb==='wait'){
   const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{format:{type:'string'},project:{type:'string'},timeout:{type:'string'},'wait-timeout':{type:'string'}}});
   format=values.format??format;if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be json, jsonl, or table.',2);
   if(positionals.length!==1)throw new CloudError('cave_usage','Use experiments wait EXPERIMENT_ID [--wait-timeout MS].',2);
   const duration=Number(values['wait-timeout']??3600000);
   if(!Number.isSafeInteger(duration)||duration<1||duration>86400000)throw new CloudError('cave_usage','--wait-timeout must be 1-86400000 ms; --timeout bounds each request.',2);
   validateOperation('experiments.get',{experiment_id:positionals[0]});
   const cfg=await context({projectId:values.project});
   const client=new CloudClient({...cfg,projectId:values.project??cfg.projectId,timeout:Number(values.timeout??30000)});
   const result=await client.waitExperiment(positionals[0],{deadline:Date.now()+duration});
   display(result,format);
   // 0 a verdict (or a passed eval), 5 a typed refusal, 6 a run that ended
   // without one (failed, error, cancelled, rolled back), 7 the wait itself
   // ran out or was interrupted (thrown above).
   const {state}=result.data;
   return ['completed','passed'].includes(state)?(result.data.results_json?.status==='refused'?5:0):6;
  }
  const special=family==='tools';
  const waiting=['evals','scenario-runs'].includes(family)&&verb==='wait';
  const scenarioWait=family==='scenario-runs'&&waiting;
  const canonicalVerb=verb==='show'&&['traces','experiments'].includes(family)?'get':verb;
  if(!special&&!waiting&&!operations.some(o=>o.id===`${family}.${canonicalVerb}`||o.aliases.includes(`${family}.${canonicalVerb}`))){
   const {familyVerbs}=await import('./help.mjs');
   throw new CloudError('cave_unknown_operation',`Unknown operation ${family}.${typed}.${didYouMean(nearest(typed,familyVerbs(family,hostCommands).map(row=>row.verb)).map(v=>`cvm ${family} ${v}`))} Run cvm ${family} for its verbs.`,2);
  }
  const op=special?undefined:describeOperation(waiting?(scenarioWait?'scenario-runs.get':'evals.result'):`${family}.${canonicalVerb}`);
  const properties=op?.input_schema.properties??{};
  const options={format:{type:'string'},file:{type:'string'},stdin:{type:'boolean'},project:{type:'string'},timeout:{type:'string'},'idempotency-key':{type:'string'},out:{type:'string'},help:{type:'boolean'},remote:{type:'boolean'}};
  if(op?.async_kind)options.wait={type:'boolean'};
  if(waiting||op?.async_kind)options['wait-timeout']={type:'string'};
  if(op?.id==='traces.search')options.limit={type:'string'};
  // autoclimb exclude --model is --candidate-model: the model a person stops Caveman proving.
  if(op?.id==='autoclimb.exclude')options.model={type:'string'};
  if(family==='traces'&&verb==='show')options.spans={type:'boolean'};
  // --format is the output format; an input property named format (datasets import) is --input-format.
  const flagOf=key=>key==='format'?'input-format':key.replaceAll('_','-');
  // A list of strings (scopes, models, tags) takes the flag once per item, or one JSON array.
  const stringList=schema=>schema.type==='array'&&(schema.items?.type==='string'||Array.isArray(schema.items?.enum)&&schema.items.enum.every(v=>typeof v==='string'));
  const jsonFlag=(flag,raw,schema)=>{try{return JSON.parse(raw);}catch{throw new CloudError('cave_usage',`--${flag} takes JSON, e.g. --${flag} '${schema.type==='array'?'["a","b"]':'{"key":"value"}'}'.`,2);}};
  for(const [key,schema]of Object.entries(properties)){if(!(flagOf(key) in options))options[flagOf(key)]={type:schema.type==='boolean'?'boolean':'string',...(stringList(schema)?{multiple:true}:{})};}
  const {values,positionals}=parseArgs({args,options,allowPositionals:true,strict:true});
  format=values.format??format;if(!['json','jsonl','table'].includes(format))throw new CloudError('cave_usage','Format must be json, jsonl, or table.',2);
  if(special){
   if(verb==='list'){const source=values.remote?(await new CloudClient({...await context(),timeout:Number(values.timeout??30000)}).discover()).operations:[...operations,...localCommands.filter(id=>!operations.some(o=>o.id===id)).map(describeCommand)];display(source.map(({id,version,summary,access})=>({id,version,summary,access})),format);return 0;}
   if(!['describe','schema'].includes(verb)||positionals.length!==1)throw new CloudError('cave_usage','Use tools list or tools describe|schema OPERATION.',2);
   const selected=describeCommand(positionals[0]);display(verb==='schema'?selected.input_schema:selected,format);return 0;
  }
  if(values.help){if(format==='table'){const {renderVerbHelp}=await import('./help.mjs');process.stdout.write(renderVerbHelp(op));}else display(op,format);return 0;}
  let input=await inputFile(values.file,values.stdin);
  if(!input||typeof input!=='object'||Array.isArray(input))throw new CloudError('cave_usage','Input must be a JSON object.',2);
  for(const [key,schema]of Object.entries(properties)){
   const flag=flagOf(key);if(values[flag]===undefined)continue;
   if(Object.hasOwn(input,key))throw new CloudError('cave_usage',`Input supplies ${key} twice.`,2);
   const raw=values[flag];
   if(stringList(schema)&&Array.isArray(raw))input[key]=raw.length===1&&raw[0].trimStart().startsWith('[')?jsonFlag(flag,raw[0],schema):raw;
   else input[key]=schema.type==='object'||schema.type==='array'?jsonFlag(flag,raw,schema):schema.type==='integer'||schema.type==='number'?Number(raw):raw;
  }
  if(op.id==='autoclimb.exclude'&&values.model!==undefined){if(input.candidate_model!==undefined)throw new CloudError('cave_usage','Use either --model or --candidate-model.',2);input.candidate_model=values.model;}
  if(op.id==='traces.search'&&values.limit!==undefined){if(input.page_size!==undefined)throw new CloudError('cave_usage','Use either --limit or --page-size.',2);input.page_size=Number(values.limit);}
  if(family==='projects'&&['get','update'].includes(verb)&&positionals.length){
   if(values.project!==undefined)throw new CloudError('cave_usage','Supply the project once: positional ID or --project.',2);
   values.project=positionals.shift();
  }
  const ids=op.binding.legacy?Object.keys(properties.parameters?.properties??{}):[...Object.values(op.binding.path_inputs??{}),...(op.binding.query_inputs??[]).filter(key=>key.endsWith('_id'))];
  if(positionals.length>ids.length)throw new CloudError('cave_usage','Too many positional identifiers; inspect tools describe.',2);
  if(positionals.length){
   const target=op.binding.legacy?(input.parameters??={}):input;
   for(const[index,value]of positionals.entries()){if(target[ids[index]]!==undefined)throw new CloudError('cave_usage','Duplicate resource identifier.',2);target[ids[index]]=value;}
  }
  validateOperation(op.id,input);
  const cfg=await context({projectId:values.project});
  const client=new CloudClient({...cfg,projectId:values.project??cfg.projectId,timeout:Number(values.timeout??30000)});
  let result;
  if(waiting||values.wait){
   const duration=Number(values['wait-timeout']??3600000);
   if(!Number.isSafeInteger(duration)||duration<1||duration>86400000)throw new CloudError('cave_usage','--wait-timeout must be 1-86400000 ms; --timeout bounds each request.',2);
   const deadline=Date.now()+duration;
   const cancel=new AbortController();const interrupt=()=>cancel.abort();process.once('SIGINT',interrupt);
   try{
    const accepted=waiting?undefined:await client.execute(op.id,input,{idempotencyKey:values['idempotency-key'],signal:cancel.signal});
    const waitFamily=scenarioWait||op.async_kind==='simulation'?'scenario-runs':'evals';
    const runId=accepted?(waitFamily==='evals'?accepted.data.run.id:accepted.data.id):input.run_id;
    reconnect={run_id:runId,...(waitFamily==='evals'?{workbench_id:input.workbench_id}:{}),project_id:client.projectId,argv:['cvm',waitFamily,'wait',...(waitFamily==='evals'?[input.workbench_id]:[]),runId,'--project',client.projectId,...(profile?['--profile',profile]:[])]};
    if(waitFamily==='scenario-runs')result=await client.waitScenario(runId,{signal:cancel.signal,deadline});
    else result=await client.waitEvaluation(input.workbench_id,runId,{signal:cancel.signal,deadline,onProgress:format==='table'?p=>process.stderr.write(`${p.status}: ${p.completed}/${p.total}\n`):undefined});
   }finally{process.removeListener('SIGINT',interrupt);}
  }else result=op.permissions.length===0?await client.publicRead(op,input):await client.execute(op.id,input,{idempotencyKey:values['idempotency-key']});
  if(values.spans)result={trace:result,spans:await client.execute('traces.spans',input)};
  if(values.out)await writeFile(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  // A list on a terminal reads as columns; anything else, and every piped result, as JSON.
  const rows=format==='table'&&!values.wait&&!waiting&&!values.spans?(await import('./help.mjs')).renderRows(result):undefined;
  if(rows!==undefined)process.stdout.write(rows);else display(result,format);
  if(scenarioWait||values.wait&&op.async_kind==='simulation')return {passed:0,failed:5,incomplete:6}[scenarioQuality(result.data)];
  const quality=['evals.compare','scenarios.compare'].includes(op.id)?result.data.quality:(waiting||values.wait)?result.data.quality?.status:undefined;
  return quality==='passed'||quality===undefined&&!(waiting||values.wait)?0:quality==='failed'?5:6;
 }catch(error){
  const e=error instanceof CloudError?error:new CloudError('cave_usage',error.message??'Command failed.',2);
  display({schema_version:1,ok:false,status:'failed',error:{code:e.code,message:e.message,...(e.details?{details:e.details}:{})},...(reconnect?{reconnect}:{})},format);return e.exitCode;
 }
}
