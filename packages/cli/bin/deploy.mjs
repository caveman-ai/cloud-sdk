// `cvm deploy`, `cvm run` and `cvm deployments`: an agent folder to a live
// Deployment in one command, a Session through it, and the Deployment's
// revisions. Each is a thin client of the /api/v1/code agents, deployments and
// session events routes, signed in as cvm always is. Nothing here prints a
// credential or echoes a response body: a refusal shows only the code and
// message of the API's error envelope.
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {CloudClient,CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {build,buildFiles,locate,size,summaryLine,formatOf,placeholders} from './agent-build.mjs';

const DEPLOYMENT=/^[a-z0-9][a-z0-9-]{0,62}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const own=(code,message,exit)=>Object.assign(new CloudError(code,message,exit),{local:true});
const usage=message=>own('cave_usage',message,2);
const enc=encodeURIComponent;
// Terminal-inert text: no escape sequences, C0/C1 controls (newline and tab
// kept) or bidirectional overrides from a model or a server reach the screen.
export const clean=text=>String(text??'').replace(/\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)?|.)?/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g,'');
const one=text=>clean(text).replace(/\s+/g,' ').trim();
const ref=(value,what)=>{
 if(typeof value!=='string'||!(DEPLOYMENT.test(value)||UUID.test(value)))throw usage(`${what} is a deployment's name (lowercase letters, digits and -) or its id.`);
 return value;
};

// clip keeps a server's message to 500 characters, cut at a word with an
// ellipsis so a long one does not end mid-word.
const clip=text=>text.length<=500?text:text.slice(0,499).replace(/\s+\S*$/,'')+'…';

// failure turns any error into one cvm prints: the API's own refusal (the
// error envelope's code and message, made terminal-inert), else a fixed line
// by HTTP status or client error. An upstream body is never echoed.
export function failure(error,what){
 if(error?.local)return error;
 if(error instanceof CloudError&&error.httpStatus){
  const envelope=error.details?.error;
  if(envelope&&typeof envelope.code==='string'&&/^cave_[a-z0-9_]{1,80}$/.test(envelope.code)&&typeof envelope.message==='string'&&one(envelope.message))
   return new CloudError(envelope.code,clip(one(envelope.message)),error.exitCode);
  return new CloudError('cave_request_failed',`${what} failed (HTTP ${error.httpStatus}).`,error.exitCode);
 }
 const safe={cave_auth_required:'Run cvm login, or set CAVE_TOKEN.',cave_endpoint_invalid:'The Cloud address must be HTTPS, or HTTP on this machine, with no credentials, query or fragment.',
  cave_network_error:'Could not reach Caveman Cloud.',cave_timeout:'Caveman Cloud did not answer in time; the request may still have been applied.',cave_invalid_response:'Caveman Cloud returned an answer that is not JSON.',cave_result_too_large:'Caveman Cloud\'s answer was over the size limit.'};
 if(error instanceof CloudError&&Object.hasOwn(safe,error.code))return new CloudError(error.code,safe[error.code],error.exitCode);
 return new CloudError('cave_failed',`${what} failed.`,1);
}
function printFailure(format,error){
 process.stdout.write(format==='table'?`failed   ${error.code}: ${error.message}\n`:inertJSON({schema_version:1,ok:false,status:'failed',error:{code:error.code,message:error.message}})+'\n');
 return error.exitCode;
}
// command parses argv, answers --help, and prints any failure the same way.
async function command(argv,{options,usage:line,summary,what},body){
 let format=process.stdout.isTTY?'table':'json';
 try{
  let parsed;
  try{parsed=parseArgs({args:argv,strict:true,allowPositionals:true,options:{...options,format:{type:'string'},help:{type:'boolean',short:'h'}}});}
  catch(error){throw usage(`${error.message} Use ${line}.`);}
  format=formatOf(parsed.values);
  if(parsed.values.help){process.stdout.write(inertJSON({usage:line,summary},format==='table'?2:undefined)+'\n');return 0;}
  return await body(parsed.values,parsed.positionals,format);
 }catch(error){return printFailure(format,failure(error,what));}
}
const client=async(context,timeout=30000)=>new CloudClient({...await context(),timeout});
// Pads columns two spaces apart.
export const table=rows=>{
 const widths=rows.reduce((w,row)=>row.map((cell,i)=>Math.max(w[i]??0,String(cell).length)),[]);
 return rows.map(row=>row.map((cell,i)=>i===row.length-1?String(cell):String(cell).padEnd(widths[i])).join('  ').trimEnd()).join('\n')+'\n';
};
const BLOCKERS={code_tools:'code tools',skills:'skills',subagents:'subagents','loop:container':'its own container loop','sandbox:none':'an agent with no sandbox (computer: none)','sandbox:code':'the code sandbox'};
const blockedSentence=(blocked,name)=>`The build is stored, but this Caveman Cloud cannot run ${blocked.map(b=>BLOCKERS[b]??one(b)).join(', ')} yet: a session through ${name} is refused until it can.`;
const money=n=>typeof n==='number'?`$${n<1?n.toFixed(4):n.toFixed(2)}`:'';
const configLine=config=>{
 const parts=Object.entries(config??{}).map(([key,value])=>key==='budget_usd'?`budget ${money(value)}`:key==='base_branch'?`base branch ${one(value)}`:typeof value==='object'?`${key} ${one(JSON.stringify(value))}`:`${key} ${one(value)}`);
 return parts.length?parts.join(', '):'none';
};

// ---- cvm deploy ---------------------------------------------------------
// Where a deploy came from: always the CLI, plus the checkout's commit and
// branch when the agent's folder is in one. Nothing else about the repository
// (no remote, path or author) leaves this machine. Git failing, missing or
// slower than 5 s sends neither; a detached HEAD sends no branch.
const git=(dir,...args)=>{try{return execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000}).trim();}catch{return '';}};
export function deploySource(dir){
 const source={trigger:'cli'};
 const commit=git(dir,'rev-parse','--verify','--quiet','HEAD');
 if(/^[0-9a-f]{40}$/.test(commit))source.commit_sha=commit;
 const branch=git(dir,'symbolic-ref','--quiet','--short','HEAD');
 if(branch&&branch.length<=255&&!/[\s\x00-\x1f\x7f]/.test(branch))source.branch=branch;
 return source;
}
const sourceLine=s=>[s?.commit_sha?one(s.commit_sha).slice(0,7):'',s?.branch?one(s.branch):''].filter(Boolean).join(' ');
const triggerLine=r=>r?.trigger==='rollback'?`rollback to ${r.rolled_back_to}`:one(r?.trigger??'');
const deployUsage='cvm deploy [PATH] [--name NAME] [--repo OWNER/NAME] [--base-branch BRANCH] [--model MODEL] [--budget USD] [--dry-run] [--format json|table]';
// The deployment's default name: the agent's, lowercased, with every
// character outside [a-z0-9-] turned into -.
export const deploymentName=agent=>agent.toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,63);

// A create refused as a conflict may be an archived agent holding the name:
// say so, else the server's own refusal stands.
async function archivedName(api,name,error){
 if(error?.code!=='cave_conflict')throw error;
 let archived=[];
 try{archived=(await api.request('/api/v1/code/agents?archived=true')).agents??[];}catch{throw error;}
 if(archived.some(agent=>agent?.name===name&&agent.archived_at))throw own('cave_code_agent_archived',`The agent ${name} is archived, so its name is taken. Deploy under another agent name: set name in agent.json (or AGENT.md).`,4);
 throw error;
}

// ---- the plan of a build that names connectors or mounts drives -------------
// The refusals of the plan a person at a terminal can put right here, by
// running what cvm connect add and accept run.
const FIXABLE=['cave_code_connector_missing','cave_code_connector_not_connected','cave_code_connector_unpinned'];
const and=words=>words.length<2?words.join(''):`${words.slice(0,-1).join(', ')} and ${words.at(-1)}`;

// planFor asks for the plan (POST /code/deployments/plan), which changes
// nothing. A connector missing, not signed in, or whose tools wait to be
// accepted is offered at a terminal ("Connect it now?"), each once, and the
// plan is asked for again. A no, no terminal, or any other refusal prints the
// refusal and its fix, and the deploy stops: {exit}. Otherwise {plan}.
async function planFor(conn,api,wants,format,io){
 const c=conn.session(io,format,{width:10,api}),out=io.out??(chunk=>process.stdout.write(chunk));
 const tried=new Set();
 try{
  for(;;){
   let refused;
   try{return {plan:await api.request('/api/v1/code/deployments/plan',{body:wants})};}catch(error){refused=error;}
   if(!refused?.httpStatus)throw refused;
   const name=refused.details?.error?.details?.connector;
   const fixable=FIXABLE.includes(refused.code)&&typeof name==='string'&&Object.hasOwn(wants.connectors??{},name)&&!tried.has(`${refused.code} ${name}`)&&c.terminal();
   if(!fixable)return {exit:conn.printFailed(out,format,refused,'The deploy')};
   tried.add(`${refused.code} ${name}`);
   let fixed;
   try{fixed=await offer(conn,c,api,refused,name,tried);}
   catch(error){return {exit:conn.printFailed(out,format,error,'The deploy')};}
   if(fixed!==true)return {exit:conn.printFailed(out,format,fixed||refused,'The deploy')};
  }
 }finally{c.ask.close?.();}
}
// offer puts one refusal right at the terminal: the connects line of the
// first-run screen, the question, then cvm connect's own add or accept. It
// answers true when it ran, false for a no, or the refusal to print instead.
async function offer(conn,c,api,refused,name,tried){
 if(refused.code==='cave_code_connector_unpinned'){
  const read=await api.request(`/api/v1/code/connectors/${enc(name)}/read`,{body:{}});
  const tools=Array.isArray(read?.proposed?.tools)?read.proposed.tools.length:undefined;
  c.line('connects',`${name}   ${tools===undefined?'its tools wait':`${tools} tool${tools===1?'':'s'} wait`} to be accepted`);
  // Nothing waits to be accepted any more (someone accepted it meanwhile): the plan is asked for again.
  return Boolean(await conn.acceptFlow(c,name,{read,question:n=>`Accept its ${n} tool${n===1?'':'s'} now?`}))||!read?.proposed;
 }
 let template;
 if(refused.code==='cave_code_connector_missing'){
  const {templates}=await api.request('/api/v1/code/connectors/catalog');
  if(!(Array.isArray(templates)&&templates.some(t=>t?.name===name))){
   c.line('connects',`${name}   not added, and no template of the catalog has that name`);
   const sentence=failure(refused,'The deploy');
   return Object.assign(new CloudError(sentence.code,sentence.message,sentence.exitCode),{local:true,fix:`cvm connect add <url> --name ${name}`});
  }
  template=name;
  c.line('connects',`${name}   not added`);
  if(!await c.confirm('Add it from the catalog and connect it now? Opens your browser.',true))return false;
 }else{
  c.line('connects',`${name}   not connected`);
  if(!await c.confirm('Connect it now? Opens your browser.',true))return false;
 }
 const done=await conn.addFlow(c,{name,template});
 // A list read and not accepted there was answered no: the plan's refusal
 // for it is printed, not asked again.
 if(done.read?.proposed&&!done.accepted)tried.add(`cave_code_connector_unpinned ${name}`);
 return true;
}

// planTable is table with a mark: a row's mark (+, what this revision adds)
// takes the first place of the gap after its label, as the plan is drawn.
const planTable=rows=>{
 const width=Math.max(...rows.map(([label])=>String(label).length));
 return rows.map(([label,text,mark])=>(String(label).padEnd(width)+(mark?`${mark} `:'  ')+text).trimEnd()).join('\n')+'\n';
};
// driveRows are the plan's drives lines, one a mount: its path, the drive (and
// the folder in it), the access, and what to know about it, marked + where
// this revision gives more than the live one.
function driveRows(plan,say){
 const ds=Array.isArray(plan?.drives)?plan.drives:[];
 const cells=ds.map(d=>{
  const folder=typeof d?.folder==='string'?d.folder.replace(/^\/+/,''):'',names=Array.isArray(d?.placeholders)?d.placeholders:placeholders(folder);
  const notes=[...(d?.new_drive===true?['new drive']:[]),...names.map(x=>`one folder per ${say(x,32)}`),...(d?.review===true?['held for review']:[]),...(d?.trusted===true?['trusted content only']:[])];
  return [say(d?.mount,64),say(d?.drive,63)+(folder?'/'+say(folder,200):''),say(d?.access??'read',20),notes.join(', ')];
 });
 const widths=cells.reduce((w,row)=>row.map((cell,i)=>Math.max(w[i]??0,cell.length)),[]);
 return cells.map((row,i)=>[i?'':'drives',row.map((cell,j)=>j===row.length-1?cell:cell.padEnd(widths[j])).join('   ').trimEnd(),ds[i]?.widens===true?'+':undefined]);
}
// planRows are the plan's lines: drives (one a mount), connects (one a
// connector), grants, tools and checks, each check's fix under it. say is cvm
// connect's: what the API sends is one terminal-inert line, cut to a length.
function planRows(plan,deployment,say){
 const n=v=>Number.isSafeInteger(v)?v.toLocaleString('en-US'):'?',rows=driveRows(plan,say);
 const ks=Array.isArray(plan?.connectors)?plan.connectors:[];
 const who=k=>{
  const s=k?.connection;
  if(!s)return say(k?.state??'not connected',40);
  return [`shared (${say(s.signed_in_by_name??'someone',64)}${s.identity==='service'?', an app, not a person':''})`,
   ...(Array.isArray(s.writes_in)&&s.writes_in.includes('production')?[]:['reads only']),
   ...(k.state&&k.state!=='connected'?[say(k.state,40)]:[])].join(', ');
 };
 const cells=ks.map(k=>[say(k?.name,64),who(k),`${n(k?.tools)} tool${k?.tools===1?'':'s'}`,(Array.isArray(k?.effects)?k.effects:[]).map(e=>say(e,20)).join(', ')]);
 const widths=cells.reduce((w,row)=>row.map((cell,i)=>Math.max(w[i]??0,cell.length)),[]);
 cells.forEach((row,i)=>rows.push([i?'':'connects',row.map((cell,j)=>j===row.length-1?cell:cell.padEnd(widths[j])).join('   ').trimEnd(),ks[i]?.added===true?'+':undefined]));
 const by=grant=>ks.filter(k=>k?.grant===grant).map(k=>say(k.name,64));
 const granted=by('granted'),covered=by('covered'),grants=[];
 if(granted.length)grants.push(`+ ${deployment} may use ${and(granted)}   you manage ${granted.length===1?'it':granted.length===2?'both':'them'}   granted`);
 if(covered.length)grants.push(`${deployment} may use ${and(covered)}   covered by ${covered.length===1?'its grant':'their grants'}`);
 for(const k of ks.filter(k=>k?.grant==='asks')){
  const people=(Array.isArray(k.asked)?k.asked:[]).map(p=>say(p?.name??'a manager',64));
  grants.push(`${deployment} asks to use ${say(k.name,64)}   ${people.length?`${and(people)} will be asked`:'its managers will be asked'}`);
 }
 grants.forEach((line,i)=>rows.push([i?'':'grants',line]));
 // A plan of drives alone has no card: its tools line would say nothing.
 if(plan?.tools!==undefined&&(ks.length||!rows.length))rows.push(['tools',`${n(plan.tools)} tool${plan.tools===1?'':'s'}, about ${n(plan.tokens)} tokens   budget ${n(plan.budget)}   ${plan.fits===false?'over':'ok'}`]);
 (Array.isArray(plan?.checks)?plan.checks:[]).forEach((check,i)=>{
  rows.push([i?'':'checks',say(check?.line)]);
  const fix=say(check?.fix??'',300);
  if(/^cvm [a-z]/.test(fix))rows.push(['',`  ${check.kind==='pin_changed'?'see it':'fix'}: ${fix}`]);
 });
 return rows;
}

export function deploy(argv,{context,...io}){
 const text={type:'string'};
 return command(argv,{options:{name:text,repo:text,'base-branch':text,model:text,budget:text,'dry-run':{type:'boolean'}},usage:deployUsage,what:'The deploy',
  summary:'Builds the agent (as cvm agent build does), stores it as a new agent version when the build changed, and makes it the live revision of the deployment of that name. The live settings stay; the flags given replace their keys. Same build and settings: nothing changes. A build that names connectors or mounts drives asks for the plan first and prints it: each drive mount with its access, + where the revision gives more than the live one; it offers at a terminal to connect what is missing, and says who was asked when the deploy is held. --dry-run builds and prints what it would send, and sends nothing.'},async(values,positionals,format)=>{
  if(positionals.length>1)throw usage(`Name one agent. Use ${deployUsage}.`);
  const flags={};
  if(values.repo!==undefined){if(!REPO.test(values.repo))throw usage('--repo is OWNER/NAME, such as acme/support.');flags.repo=values.repo;}
  if(values['base-branch']!==undefined){if(!/^[^\s\x00-\x1f\x7f~^:?*[\\]{1,255}$/.test(values['base-branch']))throw usage('--base-branch is a branch name.');flags.base_branch=values['base-branch'];}
  if(values.model!==undefined){if(!/^[^\s\x00-\x1f\x7f]{1,200}$/.test(values.model))throw usage('--model is a model id or class, such as auto.');flags.model=values.model;}
  if(values.budget!==undefined){const n=Number(values.budget);if(values.budget.trim()===''||!Number.isFinite(n)||n<=0)throw usage('--budget is US dollars per session, more than 0.');flags.budget_usd=n;}
  const located=locate(positionals[0]),b=build(located),source=deploySource(located.root);
  const name=values.name??deploymentName(b.name);
  if(!DEPLOYMENT.test(name))throw usage(values.name===undefined?`The agent's name ${b.name} makes no deployment name; pass --name (lowercase letters, digits and -).`:'--name is 1 to 63 lowercase letters, digits and -, starting with a letter or digit.');
  const files=buildFiles(b);
  // A build that names connectors or mounts drives asks for the plan first. One
  // that does neither sends and prints exactly what a deploy did before them.
  const {connectors,drives,budgets}=b.manifest;
  const wants=connectors||drives?{name,...(connectors?{connectors}:{}),...(budgets?{budgets}:{}),...(drives?{drives}:{})}:undefined;
  const out=io.out??(chunk=>process.stdout.write(chunk));

  if(values['dry-run']){
   const steps=[
    ...(wants?[{method:'POST',path:'/api/v1/code/deployments/plan',why:`ask for the plan: ${[...(connectors?[`whether each connector ${b.name} names is there and signed in, what this deploy grants or asks for, and what the tools cost`]:[]),...(drives?[`each drive ${b.name} mounts, with the access it asks for and the drives the deploy would create`]:[])].join('; ')} (it changes nothing)`,body:wants}]:[]),
    {method:'GET',path:'/api/v1/code/agents',why:`find the agent named ${b.name}`},
    {method:'POST',path:'/api/v1/code/agents',why:`create the agent ${b.name} with this build, when there is none`,body:{name:b.name,build:{files:Object.fromEntries(Object.entries(files).map(([path,content])=>[path,`${Buffer.byteLength(content)} bytes`]))}}},
    {method:'POST',path:'/api/v1/code/agents/{agent id}',why:'or store this build as its next version, with the version read (nothing is stored when the build is unchanged)',body:{build:'the same files',version:'the version read'}},
    {method:'GET',path:`/api/v1/code/deployments/${name}`,why:`read the deployment ${name}: its live settings are kept`},
    {method:'POST',path:'/api/v1/code/deployments',why:`make the agent version live as ${name}`,body:{name,agent:{id:'the agent above',version:'its version'},config:flags,source},config_note:Object.keys(flags).length?'the live settings with these keys replaced':'the live settings, unchanged'},
   ];
   if(format==='table')out(table([[b.name,summaryLine(b)],['dry run','nothing sent. A deploy would:']])+steps.map((s,i)=>`  ${i+1}. ${s.why} (${s.method} ${s.path})`).join('\n')+'\n'+`  settings  ${Object.keys(flags).length?`${configLine(flags)}, over the live ones`:'the live ones, unchanged'}\n`+`  source    cli${sourceLine(source)?' '+sourceLine(source):''}\n`);
   else out(inertJSON({schema_version:1,ok:true,status:'dry_run',agent:b.name,sha256:b.digest,file_count:b.count,bytes:b.bytes,deployment:name,config:flags,source,would_send:steps})+'\n');
   return 0;
  }

  // Bodies up to the build limit: a slower link gets two minutes.
  const api=await client(context,120000);
  let conn,plan;
  if(wants){
   conn=await import('./connect.mjs');
   const planned=await planFor(conn,api,wants,format,io);
   if(planned.exit!==undefined)return planned.exit;
   plan=planned.plan;
  }
  const {agents=[]}=await api.request('/api/v1/code/agents');
  const found=agents.find(agent=>agent?.name===b.name);
  const agent=found
   ?await api.request(`/api/v1/code/agents/${enc(found.id)}`,{body:{build:{files},version:found.version}})
   :await api.request('/api/v1/code/agents',{body:{name:b.name,build:{files}}}).catch(error=>archivedName(api,b.name,error));
  const changed=!found||agent.version!==found.version;
  let live={};
  try{live=(await api.request(`/api/v1/code/deployments/${enc(name)}`)).live?.config??{};}
  catch(error){if(error?.httpStatus!==404)throw error;}
  const config={...live,...flags};
  const answer=await api.request('/api/v1/code/deployments',{body:{name,agent:{id:agent.id,version:agent.version},config,source}});
  const agentRow=[one(agent.name),`v${agent.version}  ${summaryLine(b)}${changed?'':'  (build unchanged)'}`];
  if(wants&&answer?.state==='held'){
   // Held: nothing went live, and the connectors' managers were asked.
   const held=answer.deployment,asked=Array.isArray(answer.hold?.asked)?answer.hold.asked:[];
   if(format!=='table'){
    out(inertJSON({schema_version:1,ok:true,status:'held',
     agent:{id:agent.id,name:agent.name,version:agent.version,stored:changed?'new version':'unchanged'},
     build:{sha256:b.digest,file_count:b.count,bytes:b.bytes},
     deployment:held?{id:held.id,name:held.name,status:held.status,revision:held.revision}:null,
     hold:answer.hold??null,config:held?.live?.config??config,source,plan:answer.plan??plan,next:'cvm connect requests'})+'\n');
    return 0;
   }
   out(planTable([agentRow,...planRows(answer.plan??plan,name,conn.say),
    ['held',`${held?.name?conn.say(held.name,63):name}: nothing goes live until the managers asked answer.`],
    ...asked.map((a,i)=>{const people=(Array.isArray(a?.people)?a.people:[]).map(p=>conn.say(p?.name??'a manager',64));return [i?'':'asked',`${conn.say(a?.connector,64)}: ${people.length?and(people):'its managers'}`];}),
    ['see','cvm connect requests'],
   ]));
   return 0;
  }
  const {deployment,state}=answer;
  const blocked=deployment?.live?.build?.blocked_by??agent.build?.blocked_by??[];
  const next=deployment.status==='paused'?`cvm deployments resume ${name}`:`cvm run ${name} "…"`;
  const result={schema_version:1,ok:true,status:state,
   agent:{id:agent.id,name:agent.name,version:agent.version,stored:changed?'new version':'unchanged'},
   build:{sha256:b.digest,file_count:b.count,bytes:b.bytes},
   deployment:{id:deployment.id,name:deployment.name,status:deployment.status,revision:deployment.revision},
   config:deployment.live?.config??config,source,blocked_by:blocked,...(blocked.length?{warning:blockedSentence(blocked,deployment.name)}:{}),next,
   ...(wants?{plan:answer.plan??plan}:{})};
  if(format!=='table'){out(inertJSON(result)+'\n');return 0;}
  const said={created:'created',updated:'updated',unchanged:'unchanged: same build and settings'}[state]??one(state);
  const rows=[
   agentRow,
   [one(deployment.status),`${one(deployment.name)} (revision ${deployment.revision}, ${said})`],
   ...(sourceLine(source)?[['from',sourceLine(source)]]:[]),
   ...(blocked.length?[['note',blockedSentence(blocked,one(deployment.name))]]:[]),
   [deployment.status==='paused'?'resume':'try',next],
  ];
  // The plan's lines go between the build and what went live.
  out(wants?planTable([rows[0],...planRows(answer.plan??plan,name,conn.say),...rows.slice(1)]):table(rows));
  return 0;
 });
}

// ---- cvm run --------------------------------------------------------------
const runUsage='cvm run DEPLOYMENT TASK... [--subject NAME=VALUE]... [--no-follow] [--timeout SECONDS] [--format json|table]  or  cvm run --session SESSION_ID [--timeout SECONDS]';
// subjectOf reads --subject NAME=VALUE, given up to 16 times: the values a
// session's drive mounts fill their {name} placeholders with. A value is one
// folder name of a drive path, as the server holds it.
const SUBJECT=/^[a-z][a-z0-9_]{0,31}$/;
export function subjectOf(given){
 if(!given?.length)return undefined;
 const out={};
 for(const pair of given){
  const at=pair.indexOf('='),name=at<0?pair:pair.slice(0,at),value=at<0?'':pair.slice(at+1);
  if(at<0||!SUBJECT.test(name))throw usage('--subject is NAME=VALUE, NAME a lowercase letter then up to 31 lowercase letters, digits or _, such as --subject customer=acme-42.');
  if(Object.hasOwn(out,name))throw usage(`--subject names ${name} twice.`);
  if(!value||Buffer.byteLength(value)>128||value.includes('/')||value==='.'||value==='..'||/[\x00-\x1f\x7f-\x9f]/.test(value))throw usage(`--subject ${name}= is one folder name: 1 to 128 bytes, no / and no control character, not . or ..`);
  out[name]=value;
 }
 if(Object.keys(out).length>16)throw usage('--subject is given at most 16 times.');
 return out;
}
const SETTLED=['idle','requires_action','terminated'];
const transient=error=>error instanceof CloudError&&(error.httpStatus>=500||error.httpStatus===429||['cave_network_error','cave_timeout'].includes(error.code));
const usageLine=u=>u?`${(u.input_tokens??0).toLocaleString('en-US')} tokens in, ${(u.output_tokens??0).toLocaleString('en-US')} out${typeof u.cost_usd==='number'?`, ${money(u.cost_usd)}`:''}`:'no usage reported';
const minutes=ms=>ms>=60000&&ms%60000===0?`${ms/60000} minute${ms===60000?'':'s'}`:`${Math.round(ms/1000)} seconds`;

// follow reads a session's events (GET /code/sessions/{id}/events?after=)
// until its last session.status is idle, requires_action or terminated. A
// session that sends nothing for timeoutMs ends the wait, not the session.
async function follow(api,id,{timeoutMs,say}){
 const seen={messages:[],tools:[],errors:[],status:undefined,ask:undefined,usage:undefined};
 let after=0,quietSince=Date.now(),checked=Date.now(),wait=250;
 const checkMs=Math.min(30000,timeoutMs/2);
 for(;;){
  let events=[];
  try{events=(await api.request(`/api/v1/code/sessions/${enc(id)}/events?after=${after}`)).events??[];}
  catch(error){if(!transient(error))throw error;}
  for(const event of events){
   if(!(event?.seq>after))continue;
   after=event.seq;const data=event.data??{};
   if(event.type==='agent.message'&&typeof data.text==='string'){seen.messages.push(data.text);say(clean(data.text).replace(/\n*$/,'\n'));}
   else if(event.type==='agent.tool_use'&&typeof data.name==='string'){seen.tools.push(data.name);say(`tool     ${one(data.name)}\n`);}
   else if(event.type==='session.error'){seen.errors.push({code:data.code,message:data.message});say(`error    ${one(data.code)}: ${one(data.message)}\n`);}
   else if(event.type==='requires_action'){seen.ask={kind:data.kind,name:data.name,question:data.question};}
   else if(event.type==='session.usage')seen.usage=data;
   else if(event.type==='session.status')seen.status={status:data.status,stop_reason:data.stop_reason??null};
  }
  if(events.length){quietSince=Date.now();wait=250;}
  if(events.length>=500)continue; // a full page: there is more to read first
  if(SETTLED.includes(seen.status?.status))return seen;
  const quiet=Date.now()-quietSince;
  if(quiet>=timeoutMs)throw own('cave_wait_timeout',`Session ${id} has sent no events for ${minutes(timeoutMs)}; it may still be running. Watch it again with: cvm run --session ${id}`,6);
  // A quiet session is read itself now and then: one that ended without a
  // last status event ends the wait.
  if(quiet>=checkMs&&Date.now()-checked>=checkMs){
   checked=Date.now();
   const session=await api.request(`/api/v1/code/sessions/${enc(id)}`).catch(error=>{if(transient(error))return undefined;throw error;});
   if(session?.status==='terminated'){seen.status={status:'terminated',stop_reason:session.stop_reason??null};seen.usage??=session.usage;return seen;}
  }
  await delay(Math.max(1,Math.min(wait,timeoutMs-quiet)));
  wait=Math.min(wait*2,2000);
 }
}
// 0 the turn ended; 6 the session waits for an answer cvm cannot give; 1 any
// other stop (an error, the budget, an interruption, an end with no turn).
const exitFor=status=>status.stop_reason==='end_turn'||status.status==='idle'&&!status.stop_reason?0:status.stop_reason==='requires_action'||status.status==='requires_action'?6:1;

export function run(argv,{context}){
 return command(argv,{options:{'no-follow':{type:'boolean'},session:{type:'string'},timeout:{type:'string'},subject:{type:'string',multiple:true}},usage:runUsage,what:'The run',
  summary:'Starts a session through a deployment (its live agent version and settings) and prints the agent\'s messages and tool calls until the session is idle, waits for an action or has ended, then its status, stop reason and usage. --no-follow prints the session and returns. --subject NAME=VALUE (up to 16) says who the session is for: each value fills the {NAME} placeholders of the deployment\'s drive mounts, so the session works in that folder and no other. --session follows a session already started. --timeout ends the wait (not the session) after that many seconds without an event (default 900). Exit 0 when the turn ended, 1 on an error or any other stop, 6 when the session waits for an action or the wait ran out.'},async(values,positionals,format)=>{
  const timeout=values.timeout===undefined?900:Number(values.timeout);
  if(!Number.isFinite(timeout)||timeout<=0||timeout>86400)throw usage('--timeout is seconds, more than 0 and at most 86400.');
  let id,started,api;
  if(values.session!==undefined){
   if(positionals.length||values['no-follow']||values.subject)throw usage(`--session follows a session already started: it takes no deployment, task, --subject or --no-follow. Use ${runUsage}.`);
   if(!UUID.test(values.session))throw usage('--session is a session id.');
   id=values.session;
   api=await client(context);
   if(format==='table')process.stdout.write(`session  ${id}\n`);
  }else{
   const [name,...words]=positionals;
   if(name===undefined)throw usage(`Name a deployment and a task. Use ${runUsage}.`);
   ref(name,'The deployment');
   const task=words.join(' ').trim();
   if(!task)throw usage(`Give the task after the deployment: cvm run ${name} "…"`);
   const subject=subjectOf(values.subject);
   api=await client(context);
   started=await api.request(`/api/v1/code/deployments/${enc(name)}/sessions`,{body:{request_id:randomUUID(),task,...(subject?{subject}:{})}});
   if(typeof started?.id!=='string'||!UUID.test(started.id))throw own('cave_invalid_response','Caveman Cloud answered without a session id.',6);
   id=started.id;
   if(values['no-follow']){
    if(format==='table')process.stdout.write(table([['session',`${started.id}  ${one(started.status)}`],...(started.deployment?[['through',`${one(name)} (revision ${started.deployment.revision})`]]:[]),['follow',`cvm run --session ${started.id}`]]));
    else process.stdout.write(inertJSON(started)+'\n');
    return 0;
   }
   if(format==='table')process.stdout.write(table([['session',`${started.id}${started.deployment?`  ${one(name)}, revision ${started.deployment.revision}`:''}`]]));
  }
  const say=format==='table'?text=>process.stdout.write(text):()=>{};
  const seen=await follow(api,id,{timeoutMs:timeout*1000,say});
  const exit=exitFor(seen.status),waiting=exit===6;
  if(format==='table'){
   if(waiting)say(`waits    ${seen.ask?one([seen.ask.kind,seen.ask.name??seen.ask.question].filter(Boolean).join(' ')):'for an action'}: cvm cannot answer it\n`);
   say(table([[one(seen.status.status),`${one(seen.status.stop_reason??'no stop reason')}  ${usageLine(seen.usage)}`]]));
  }else process.stdout.write(inertJSON({schema_version:1,ok:exit===0,status:seen.status.status,stop_reason:seen.status.stop_reason,session_id:id,
   ...(started?.deployment?{deployment:started.deployment}:{}),messages:seen.messages,tool_calls:seen.tools,errors:seen.errors,ask:waiting?seen.ask??null:null,usage:seen.usage??null})+'\n');
  return exit;
 });
}

// ---- cvm deployments -------------------------------------------------------
const deploymentsUsage='cvm deployments [list [--archived] | get NAME | revisions NAME | rollback NAME REVISION | pause NAME | resume NAME | archive NAME --yes | schedules NAME | channels NAME | sources | connect-repo OWNER/REPO [--path DIR] [--name NAME] [--branch main]] [--format json|table]';
const deploymentRows=d=>[
 [one(d.name),`${d.archived_at?'archived':one(d.status)}, revision ${d.revision}${d.environment==='preview'?` (preview${d.pr_number?` PR #${d.pr_number}`:''})`:''}`],
 ['agent',`${one(d.agent_name)} v${d.live?.agent?.version??'?'}${d.live?.build?.sha256?`  sha256 ${one(d.live.build.sha256).slice(0,12)}`:''}`],
 ['settings',configLine(d.live?.config)],
 ...(d.source_repo?[['git',`${one(d.source_repo)}${d.source_path&&d.source_path!=='.'?` (${one(d.source_path)})`:''}`]]:[]),
 ...(d.live?[['since',[one(d.live.created_at),d.live.trigger==='rollback'?`rollback to revision ${d.live.rolled_back_to}`:one(d.live.trigger),sourceLine(d.live)].filter(Boolean).join('  ')]]:[]),
 ...(d.live?.build?.blocked_by?.length?[['note',blockedSentence(d.live.build.blocked_by,one(d.name))]]:[]),
];

export function deployments(argv,{context}){
 const text={type:'string'};
 return command(argv,{options:{archived:{type:'boolean'},yes:{type:'boolean',short:'y'},path:text,name:text,branch:text,'no-previews':{type:'boolean'}},usage:deploymentsUsage,what:'The deployments request',
  summary:'Lists deployments and reads, rolls back, pauses, resumes, archives, inspects schedules/channels, or connects a Git repository for push-to-deploy and PR previews.'},async(values,positionals,format)=>{
  const [verb='list',name,extra,...rest]=positionals;
  const takes={list:0,get:1,revisions:1,rollback:2,pause:1,resume:1,archive:1,schedules:1,channels:1,sources:0,'connect-repo':1};
  if(!Object.hasOwn(takes,verb))throw usage(`Unknown deployments command ${one(verb)}. Use ${deploymentsUsage}.`);
  if([name,extra].filter(v=>v!==undefined).length!==takes[verb]||rest.length)throw usage(`Use ${deploymentsUsage}.`);
  if(values.archived&&verb!=='list')throw usage('--archived is only for list.');
  if(values.yes&&verb!=='archive')throw usage('--yes is only for archive.');
  const api=await client(context);
  if(verb==='sources'){
   const answer=await api.request('/api/v1/code/deployment-sources');
   if(format!=='table'){process.stdout.write(inertJSON(answer)+'\n');return 0;}
   const list=answer.sources??[];
   process.stdout.write(list.length?table([['DEPLOYMENT','REPO','PATH','BRANCH','PREVIEWS'],...list.map(s=>[one(s.deployment_name),one(s.repo),one(s.agent_path),one(s.production_branch),s.previews_enabled?'on':'off'])]):'No Git deployment sources connected.\n');
   return 0;
  }
  if(verb==='connect-repo'){
   if(!REPO.test(name))throw usage('connect-repo takes OWNER/NAME, such as acme/agents.');
   const body={repo:name,agent_path:values.path||'.',production_branch:values.branch||'main',previews_enabled:!values['no-previews']};
   if(values.name){ref(values.name,'--name');body.deployment_name=values.name;}
   const answer=await api.request('/api/v1/code/deployment-sources',{body});
   if(format!=='table'){process.stdout.write(inertJSON(answer)+'\n');return 0;}
   process.stdout.write(table([['connected',`${one(answer.repo)} (${one(answer.agent_path)}) -> ${one(answer.deployment_name)}`],['branch',one(answer.production_branch)],['previews',answer.previews_enabled?'enabled':'disabled']]));
   return 0;
  }
  if(verb!=='list')ref(name,'The deployment');
  let revision;
  if(verb==='rollback'){revision=Number(extra);if(!/^\d+$/.test(extra)||!Number.isSafeInteger(revision)||revision<1)throw usage('The revision is a whole number of 1 or more.');}
  // Confirmed before anything is sent, a sign-in refresh included.
  if(verb==='archive'&&!values.yes)throw own('cave_confirmation_required',`Archiving ${name} stops it for good: it starts no session again and its name is freed. Repeat with --yes to confirm.`,2);
  const base=`/api/v1/code/deployments`,path=verb==='list'?base+(values.archived?'?archived=true':''):`${base}/${enc(name)}${verb==='get'?'':'/'+verb}`;
  const body=verb==='rollback'?{revision}:['pause','resume','archive'].includes(verb)?{}:undefined;
  const answer=await api.request(path,body===undefined?{}:{body});
  if(format!=='table'){process.stdout.write(inertJSON(answer)+'\n');return 0;}
  if(verb==='list'){
   const list=answer.deployments??[];
   process.stdout.write(list.length?table([['NAME','STATUS','REVISION','AGENT','UPDATED'],...list.map(d=>[one(d.name),d.archived_at?'archived':one(d.status),String(d.revision),`${one(d.agent_name)} v${d.live?.agent?.version??'?'}`,one(d.updated_at)])]):'No deployments yet. Deploy an agent with: cvm deploy\n');
  }else if(verb==='revisions'){
   const list=answer.revisions??[];
   process.stdout.write(table([['REVISION','TRIGGER','SOURCE','AGENT VERSION','SETTINGS','CREATED'],...list.map(r=>[String(r.revision),triggerLine(r),sourceLine(r)||'-',`v${r.agent?.version??'?'}`,configLine(r.config),one(r.created_at)])]));
  }else if(verb==='schedules'){
   const list=answer.schedules??[];
   process.stdout.write(list.length?table([['NAME','CRON','TZ','CONCURRENCY','ENABLED','NEXT FIRE'],...list.map(s=>[one(s.name),one(s.cron),one(s.timezone),one(s.concurrency),s.enabled?'yes':'no',one(s.next_fire_at||'-')])]):'No schedules declared on this deployment.\n');
  }else if(verb==='channels'){
   const list=answer.channels??[];
   process.stdout.write(list.length?table([['PROVIDER','ENABLED','HOOK ID','UPDATED'],...list.map(c=>[one(c.provider),c.enabled?'yes':'no',one(c.hook_id||'-'),one(c.updated_at)])]):'No channels declared on this deployment.\n');
  }else process.stdout.write(table(deploymentRows(answer)));
  return 0;
 });
}
