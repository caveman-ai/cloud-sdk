// `cvm connect`: the servers an organization's agents use, by the names the
// agents write. A connector is added by an admin and signed in once for the
// whole team; its managers sign it in again, read and accept its list of
// tools, pause it, grant it to deployments and answer requests for it. Each
// verb is a thin client of the /api/v1/code/connectors routes, signed in as
// cvm always is.
// Whatever a server sends reaches a terminal only through say: one line,
// terminal-inert, cut to a length. A refusal prints the API's code and
// message, and the command that puts it right when the API names one.
// A sign-in happens in the browser: cvm prints its address, opens it when a
// person is at a terminal, and reads the connector every 2 seconds for at most
// 5 minutes until the sign-in lands.
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {CloudClient,CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {formatOf} from './agent-build.mjs';
import {failure,clean} from './deploy.mjs';

const NAME=/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,DEPLOYMENT=/^[a-z0-9][a-z0-9-]{0,62}$/;
const EFFECTS=['read','write','external'],ENVIRONMENTS=['production','preview','development'];
const BASE='/api/v1/code/connectors';
// How often a sign-in is looked for, and for how long.
export const POLL=2000,WAIT=5*60*1000;
const own=(code,message,exit,fix)=>Object.assign(new CloudError(code,message,exit),{local:true,...(fix?{fix}:{})});
const usage=message=>own('cave_usage',message,2);
const enc=encodeURIComponent;
const one=text=>clean(text).replace(/\s+/g,' ').trim();
// say is a server's text as one terminal-inert line of at most max characters:
// clean and one, then any formatting character or lone surrogate dropped too.
// spaced keeps runs of spaces (a tool's card line aligns with them); any other
// whitespace still becomes one space.
export const say=(text,max=300,spaced=false)=>{
 const flat=spaced?clean(text).replace(/[^\S ]+/g,' ').trim():one(text);
 const chars=Array.from(flat.replace(/[\p{Cf}\p{Cs}\u2028\u2029]/gu,''));
 return chars.length>max?chars.slice(0,max-1).join('').trimEnd()+'…':chars.join('');
};
const num=n=>Number.isSafeInteger(n)?n.toLocaleString('en-US'):'?';
const count=(n,word,many=word+'s')=>`${num(n)} ${n===1?word:many}`;
const day=t=>typeof t==='string'&&/^\d{4}-\d{2}-\d{2}/.test(t)?t.slice(0,10):'?';
const when=t=>typeof t==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)?t.slice(0,16).replace('T',' '):'?';
const and=words=>words.length<2?words.join(''):`${words.slice(0,-1).join(', ')} and ${words.at(-1)}`;
const transient=error=>error instanceof CloudError&&(error.httpStatus>=500||error.httpStatus===429||['cave_network_error','cave_timeout'].includes(error.code));
// Pads columns two spaces apart.
const grid=rows=>{
 const widths=rows.reduce((w,row)=>row.map((cell,i)=>Math.max(w[i]??0,String(cell).length)),[]);
 return rows.map(row=>row.map((cell,i)=>i===row.length-1?String(cell):String(cell).padEnd(widths[i])).join('  ').trimEnd()).join('\n')+'\n';
};

// ---- what is typed ----------------------------------------------------------
// A connector is named by its name (an org connector's) or by its id.
const ref=value=>{
 if(typeof value!=='string'||!(value.length<=32&&NAME.test(value)||UUID.test(value)))throw usage('Name a connector by its name (lowercase letters, digits and single hyphens, a letter first) or its id. List them: cvm connect ls');
 return value;
};
const named=(value,flag)=>{
 if(value.length>32||!NAME.test(value))throw usage(`${flag} is a connector's name agents write: lowercase letters, digits and single hyphens, a letter first, at most 32 characters.`);
 return value;
};
const deploymentOf=(value,flag)=>{
 if(value===undefined)throw usage(`Name the deployment with ${flag} DEPLOYMENT.`);
 if(!DEPLOYMENT.test(value))throw usage(`${flag} is a deployment's name: lowercase letters, digits and -.`);
 return value;
};
const toolsOf=value=>{
 if(value===undefined)return undefined;
 const tools=value.split(',').map(tool=>tool.trim());
 if(!tools.length||tools.length>200||tools.some(tool=>!/^[^\s\x00-\x1f\x7f]{1,128}$/.test(tool)))throw usage('--tools is tool names split by commas, such as list_issues,get_issue: 1 to 200 of them.');
 if(new Set(tools).size!==tools.length)throw usage('--tools names a tool twice.');
 return tools;
};
const ceilingOf=value=>{
 if(value!==undefined&&!EFFECTS.includes(value))throw usage('--ceiling is read, write or external: the most a tool may do.');
 return value;
};
const reasonOf=value=>{
 if(value!==undefined&&(Array.from(value).length>200||/[\x00-\x1f\x7f]/.test(value)))throw usage('--reason is one line of at most 200 characters.');
 return value;
};
const whole=(text,flag)=>{
 const n=Number(text);
 if(!/^\d+$/.test(text)||!Number.isSafeInteger(n)||n<1)throw usage(`${flag} is a whole number of 1 or more.`);
 return n;
};
// --effect TOOL=EFFECT, repeated: what the person says a tool does, over what
// cvm was told it does.
const effectsOf=list=>{
 const out={};
 for(const item of list??[]){
  const m=/^([^\s=\x00-\x1f\x7f]{1,128})=(read|write|external)$/.exec(item);
  if(!m)throw usage('--effect is TOOL=read, TOOL=write or TOOL=external.');
  if(Object.hasOwn(out,m[1]))throw usage(`--effect names ${m[1]} twice.`);
  out[m[1]]=m[2];
 }
 return out;
};

// ---- printing ---------------------------------------------------------------
// fixOf is the command that puts a refusal right: the API's details.fix when
// it is one cvm line, or what cvm itself said.
export function fixOf(error){
 if(error?.local)return error.fix;
 const fix=error?.details?.error?.details?.fix;
 if(typeof fix!=='string')return undefined;
 const line=say(fix,300);
 return /^cvm [a-z]/.test(line)?line:undefined;
}
// printFailed prints a failure as every cvm verb does, plus its fix: a fix
// line on a terminal, a fix key in JSON. The message goes through say as well,
// so no formatting character of a server's sentence reaches the terminal.
// A key reaches no connector route, and the API's sentence for that is the list
// of every route a key has: say what to do about it here instead.
const KEY_REFUSED='Connectors are looked after with a person\'s sign-in, and this ran with an API key. Run it without CAVE_TOKEN, after cvm login.';
export function printFailed(write,format,raw,what){
 const error=failure(raw,what),fix=fixOf(raw),message=error.code==='cave_api_key_route_forbidden'?KEY_REFUSED:say(error.message,500);
 write(format==='table'?`failed   ${error.code}: ${message}\n${fix?`fix      ${fix}\n`:''}`:inertJSON({schema_version:1,ok:false,status:'failed',error:{code:error.code,message},...(fix?{fix}:{})})+'\n');
 return error.exitCode;
}

// terminalQuestion reads the answers to questions from stdin, a line each. One
// reader serves every question of a command, so a line typed ahead is kept for
// the next question instead of lost; close lets the process end.
function terminalQuestion(){
 let reader,ended=false;const lines=[],waiting=[];
 const ask=(prompt,write)=>{
  if(!reader){
   reader=createInterface({input:process.stdin,terminal:false});
   reader.on('line',line=>waiting.length?waiting.shift()(line):lines.push(line));
   reader.on('close',()=>{ended=true;for(const resolve of waiting.splice(0))resolve(null);});
  }
  write(prompt);
  return lines.length?Promise.resolve(lines.shift()):ended?Promise.resolve(null):new Promise(resolve=>waiting.push(resolve));
 };
 ask.close=()=>reader?.close();
 return ask;
}

// session is what every verb, and cvm deploy, works with: where the result and
// the progress go (stdout on a terminal; progress to stderr beside JSON), how
// to ask, open a browser, wait and read the API. io overrides any of it;
// width is the label column (cvm deploy's is 10).
export function session(io,format,{width=9,api}={}){
 const out=io.out??(chunk=>process.stdout.write(chunk)),err=io.err??(chunk=>process.stderr.write(chunk));
 const c={format,width,out,
  say:format==='table'?out:err,
  terminal:io.terminal??(()=>Boolean(process.stdin.isTTY&&process.stdout.isTTY)),
  ask:io.ask??terminalQuestion(),
  open:io.open??(()=>{}),
  env:io.env??process.env,
  sleep:io.sleep??(ms=>delay(ms)),
  now:io.now??(()=>Date.now()),
  interrupt:io.interrupt??(handler=>{process.once('SIGINT',handler);return()=>process.off('SIGINT',handler);}),
  api:async()=>c.client??=api??new CloudClient({...await io.context(),timeout:30000}),
 };
 const pad=label=>label+' '.repeat(Math.max(1,c.width-label.length));
 // line is progress, row is the result: one label, one line of text.
 c.line=(label,text)=>c.say(pad(label)+text+'\n');
 c.row=(label,text)=>c.out(pad(label)+text+'\n');
 c.print=value=>{c.out(inertJSON(value)+'\n');};
 c.confirm=async(question,byDefault)=>{
  const answer=await c.ask(`${' '.repeat(c.width)}${question}  ${byDefault?'[Y/n]':'[y/N]'} `,c.say);
  if(answer===null||answer===undefined)return false;
  const said=String(answer).trim().toLowerCase();
  return said===''?byDefault:/^y(es)?$/.test(said);
 };
 return c;
}

const find=async(api,name)=>{
 try{return (await api.request(`${BASE}/${enc(name)}`)).connector??null;}
 catch(error){if(error?.httpStatus===404)return null;throw error;}
};
const reachable=address=>{try{const u=new URL(address);return u.origin+u.pathname.replace(/\/+$/,'');}catch{return String(address);}};
const writesInProduction=s=>Array.isArray(s?.writes_in)&&s.writes_in.includes('production');
// Who a sign-in is: "Dana" (a person, reads only).
const signedInAs=s=>`${s?.signed_in_by_name?`"${say(s.signed_in_by_name,64)}"`:'someone'} (${[s?.identity==='service'?'an app, not a person':'a person',...(writesInProduction(s)?[]:['reads only'])].join(', ')})`;
const effectOf=(tool,effects)=>effects[tool?.name]??tool?.effect;
const tally=(tools,effects={})=>{
 const n={read:0,write:0,external:0};
 for(const tool of tools)if(Object.hasOwn(n,effectOf(tool,effects)))n[effectOf(tool,effects)]++;
 return EFFECTS.filter(e=>n[e]).map(e=>`${n[e]} ${e}`).join(', ')||'none read, written or acting outside';
};
const counted=effects=>EFFECTS.filter(e=>Number.isSafeInteger(effects?.[e])&&effects[e]>0).map(e=>`${num(effects[e])} ${e}`).join(', ');
const cardLine=(name,tool)=>say(tool?.line??`${name}.${tool?.name}  ${tool?.effect}`,400,true);
const problemsOf=p=>Array.isArray(p?.problems)?p.problems:[];
const proposedTools=p=>Array.isArray(p?.tools)?p.tools:[];
const acceptedLine=(name,done)=>`${name}  version ${num(done?.pin?.version)}: ${count(done?.pin?.tools,'tool')}${counted(done?.effects)?` (${counted(done.effects)})`:''}`;

// showProposal prints a list of tools read from the server and waiting to be
// accepted: the count by effect, with lines each tool's card line, any
// problem, and every tool that acts outside by name.
function showProposal(c,name,read,effects,{lines}){
 const p=read.proposed,tools=proposedTools(p);
 c.line('tools',`${count(tools.length,'tool')}: ${tally(tools,effects)}`);
 if(lines)for(const tool of tools)c.line('',cardLine(name,tool));
 for(const problem of problemsOf(p))c.line('problem',say(problem?.line??`${problem?.tool}: ${problem?.kind}`));
 const outside=tools.filter(tool=>effectOf(tool,effects)==='external').map(tool=>say(tool.name,128));
 if(outside.length)c.line('external',`these act outside: ${outside.join(', ')}`);
}

// ---- signing in -------------------------------------------------------------
const stillOpen=(name,rotate,code,exit)=>rotate
 ?own(code,`The new sign-in to ${name} is still open in your browser; the old one works until it completes.`,exit)
 :own(code,`The sign-in to ${name} is still open in your browser. When you have signed in there, cvm connect accept ${name} finishes the add.`,exit,`cvm connect accept ${name}`);

// landedSince answers, for the connector's sign-in as read before this sign-in
// was started (was: its connection, or null when it had none), whether a
// sign-in the poll reads (now) is the new one completed. A sign-in that is
// connected with no problem has landed when its signed_in_at, the time a person
// last completed it, is later than it was before the start (or is set at all,
// when there was no sign-in or no time before). A token refresh of the old
// sign-in never moves signed_in_at, and starting a sign-in does not either.
// afterStart is only read for a Caveman Cloud older than signed_in_at: it
// sends no such key, so the rule before it holds there, in this one place: a
// change to the sign-in (updated_at) after the start counts, which a refresh of
// the old sign-in also makes.
const time=t=>typeof t==='string'?Date.parse(t):NaN;
const olderCloud=was=>was!==null&&typeof was==='object'&&!Object.hasOwn(was,'signed_in_at');
function landedSince(was,now,afterStart){
 if(now?.status!=='connected'||now.problem)return false;
 if(olderCloud(was))return time(now.updated_at)>afterStart;
 const then=time(was?.signed_in_at),at=time(now.signed_in_at);
 // A poll with no time: connected is the new sign-in only where there was none before.
 if(!Object.hasOwn(now,'signed_in_at'))return !was;
 return !Number.isNaN(at)&&(Number.isNaN(then)||at>then);
}

// signIn prints where the sign-in starts, opens it at a terminal, and waits
// until it lands (landedSince), from before: the connector as it was read
// before the sign-in was started, or null when there was none. A problem the
// sign-in shows after the start (starting one clears the last) is a sign-in
// that failed.
async function signIn(c,api,name,authorize,{before,noBrowser,rotate}){
 if(typeof authorize!=='string'||!/^https?:\/\/\S{1,8000}$/.test(authorize)||clean(authorize)!==authorize)throw own('cave_invalid_response','Caveman Cloud answered without an address to sign in at.',6);
 const was=before?.connection??null;
 const afterStart=olderCloud(was)?time((await find(api,name))?.connection?.updated_at):undefined;
 c.line('sign in',authorize);
 const opened=!noBrowser&&!c.env.CAVE_NO_BROWSER&&c.terminal();
 if(opened)c.open(authorize);
 c.line('waiting',`${opened?'your browser is open: ':'open that address and '}sign in to ${name}. cvm waits at most 5 minutes; Ctrl-C stops waiting, and the sign-in stays open.`);
 const deadline=c.now()+WAIT;
 let stopped=false,wake;const woken=new Promise(resolve=>wake=resolve);
 const off=c.interrupt(()=>{stopped=true;wake();});
 try{
  for(;;){
   await Promise.race([c.sleep(POLL),woken]);
   if(stopped)throw stillOpen(name,rotate,'cave_interrupted',130);
   let k;
   try{k=await find(api,name);}catch(error){if(!transient(error))throw error;}
   const s=k?.connection;
   if(s&&landedSince(was,s,afterStart)){c.line('',`✓ ${name}   signed in as ${signedInAs(s)}`);return k;}
   if(s?.problem&&s.status!=='pending')throw own('cave_code_connection_failed',`The sign-in to ${name} did not complete: ${say(s.problem)}`,1,`cvm connect ${rotate?'rotate':'add'} ${name}`);
   if(c.now()>=deadline)throw stillOpen(name,rotate,'cave_wait_timeout',6);
  }
 }finally{off();}
}

// offerAccept accepts a list read from the server when --yes says so or the
// person at the terminal does. It answers the accept's answer, or null.
async function offerAccept(c,api,name,read,{yes,question,effects={},lines}){
 const p=read?.proposed;
 if(read?.same||!p){c.line('tools',`${name}: no change since ${day(read?.accepted?.accepted_at)}, ${count(read?.accepted?.tools,'tool')} accepted.`);return null;}
 showProposal(c,name,read,effects,{lines});
 if(!yes&&!(c.terminal()&&await c.confirm(question(proposedTools(p).length),true))){
  c.line('accept',`nothing accepted yet. To accept: cvm connect accept ${name}`);
  return null;
 }
 const done=await api.request(`${BASE}/${enc(name)}/accept`,{body:{version:p.version,...(Object.keys(effects).length?{effects}:{})}});
 c.line('accepted',acceptedLine(name,done));
 return done;
}

// offerWrites asks, of a person's sign-in that reads only, whether agents may
// write with it in production. Only at a terminal: --yes accepts tools, never
// writes.
async function offerWrites(c,api,name,k){
 const s=k?.connection;
 if(!s||s.identity!=='person'||writesInProduction(s))return null;
 if(c.terminal()&&await c.confirm(`Let agents write with your sign-in to ${name} in production?`,false)){
  const done=await api.request(`${BASE}/${enc(name)}/writes`,{body:{in:['production']}});
  c.line('writes',`${name} writes in production with your sign-in.`);
  return done.connector??null;
 }
 c.line('reads',`${name} reads only: agents read with your sign-in. To let them write: cvm connect allow-writes ${name}`);
 return null;
}

// addFlow is cvm connect add, and what cvm deploy runs to connect a connector
// it needs: add the connector (or, when one of that name exists, sign it in
// again), wait for the sign-in, read its tools and offer to accept them, then
// offer writes. The connector is read before anything starts: the wait is for
// a sign-in later than the one it had then.
export async function addFlow(c,{name,template,address,named:explicit,yes,noBrowser}){
 const api=await c.api();
 const before=await find(api,name);
 let authorize;
 if(before){
  if(address&&reachable(before.address)!==reachable(address))throw own('cave_code_connector_exists',`A connector named ${name} exists, at ${say(before.address,200)}. Pick another name with --name, or sign it in again: cvm connect add ${name}`,4);
  c.line('connect',`${name} exists: signing it in again.${before.connection?.status==='connected'?' Its sign-in works until this one completes.':''}`);
  authorize=(await api.request(`${BASE}/${enc(name)}/connect`,{body:{}}))?.authorize_url;
 }else{
  const added=await api.request(BASE,{body:template?{template,...(explicit?{name}:{})}:{address,name}});
  c.line('added',`${name}  ${say(added?.connector?.address,200)}${added?.connector?.template?'  (from the catalog)':''}`);
  authorize=added?.authorize_url;
 }
 let k=await signIn(c,api,name,authorize,{before,noBrowser,rotate:false});
 const read=await api.request(`${BASE}/${enc(name)}/read`,{body:{}});
 const accepted=await offerAccept(c,api,name,read,{yes,lines:true,question:n=>`Accept these ${count(n,'tool')}?`});
 k=await offerWrites(c,api,name,k)??k;
 return {added:!before,authorize_url:authorize,connector:k,read,accepted};
}

// acceptFlow is cvm connect accept after its read, and what cvm deploy runs for
// a connector whose tools wait: the summary, then the question.
export async function acceptFlow(c,name,{read,question}){
 return offerAccept(c,await c.api(),name,read,{yes:false,lines:false,question});
}

// ---- the verbs --------------------------------------------------------------
async function add(c){
 const [target]=c.args,{values}=c;
 let template,address,name=values.name;
 if(/^https:\/\//i.test(target)){
  if(/[\s\x00-\x1f\x7f]/.test(target)||target.length>2048)throw usage('A connector\'s address is one https:// URL of at most 2,048 characters.');
  if(name===undefined)throw usage('A connector added by its address needs the name agents write: cvm connect add URL --name NAME.');
  address=target;
 }else if(/^[a-z][a-z0-9+.-]*:/i.test(target))throw usage('A connector\'s address is an https:// URL.');
 else template=named(target,'A catalog template');
 name=named(name??template,'--name');
 const done=await addFlow(c,{name,template,address,named:values.name!==undefined,yes:values.yes,noBrowser:values['no-browser']});
 if(c.format!=='table')return c.print({schema_version:1,ok:true,status:done.accepted?'accepted':'connected',...done,...(done.accepted?{}:{next:`cvm connect accept ${name}`})});
 c.row('next',`name ${name} under connectors: in an agent's AGENT.md, then cvm deploy`);
}

const lsState=k=>k?.state==='paused'?'paused':!k?.connection||k.connection.status==='pending'?'not connected':k.connection.status==='connected'?'ok':'needs sign-in';
// Who signed it in; nobody (-) while no sign-in has completed: one started and
// pending, or a first one that failed, has no signer yet.
const lsSigned=s=>!s||s.status==='pending'||!s.signed_in_by&&!s.signed_in_by_name?'-':[say(s.signed_in_by_name??'someone',64),s.identity==='service'?'a service':'a person',...(writesInProduction(s)?[]:['reads only'])].join(', ');
// The accepted tools, then what a list waiting to be accepted changes, as the
// server counts it against them (5.1: added, changed, removed); "changed" alone
// when it counts none (a Caveman Cloud that sends no counts, or a list whose
// tools differ only in their effects).
const lsTools=pin=>{
 const a=pin?.accepted,p=pin?.proposed;
 if(!a&&!p)return '-';
 const n=a?num(a.tools):'0';
 if(!p)return n;
 const counts=['added','changed','removed'].filter(word=>Number.isSafeInteger(p[word])&&p[word]>0).map(word=>`${num(p[word])} ${word}`);
 return `${n}, ${counts.length?counts.join(', '):'changed'}`;
};
const lsUsed=used=>Array.isArray(used)&&used.length?say(used.map(u=>say(u?.deployment,63)).join(', '),120):'-';
async function ls(c){
 const answer=await (await c.api()).request(BASE);
 if(c.format!=='table')return c.print(answer);
 const all=Array.isArray(answer?.connectors)?answer.connectors:[];
 if(!all.length){c.out('No connectors yet. Add one from the catalog (cvm connect add linear) or by its address (cvm connect add https://... --name NAME).\n');return;}
 c.out(grid([['NAME','STATE','SIGNED IN AS','TOOLS','USED BY','WAITING'],...all.map(k=>{
  const name=say(k?.name,64)+(k?.scope==='personal'?' (personal)':'');
  // Another person's personal connector: its name, host and owner only.
  if(typeof k?.host==='string'&&k.state===undefined)return [name,'-',`${say(k.owner_name??'someone',64)}'s own, at ${say(k.host,100)}`,'-','-','-'];
  return [name,lsState(k),lsSigned(k?.connection),lsTools(k?.pin),lsUsed(k?.used_by),Number.isSafeInteger(k?.waiting)&&k.waiting>0?num(k.waiting):'-'];
 })]));
}

async function test(c){
 const name=ref(c.args[0]);
 const t=await (await c.api()).request(`${BASE}/${enc(name)}/test`,{body:{}});
 const ok=t?.ok===true;
 if(c.format!=='table'){c.print(t);return ok?0:1;}
 if(ok)c.row('ok',`${name}  ${count(t.tools,'tool')} in ${num(t.milliseconds)} ms${t.matches_pin===false?`; the list changed since it was accepted: cvm connect diff ${name}`:''}`);
 else c.row('failed',`${name}: ${say(t?.problem??'it did not answer as a connector should.')}`);
 return ok?0:1;
}

// The rows of a read: what changed since the accepted list, each added and
// changed tool by its card line, and the command that accepts it.
function diffRows(name,read){
 const a=read?.accepted,p=read?.proposed;
 if(read?.same||!p)return [['diff',`${name}: no change since ${day(a?.accepted_at)}${a?` (version ${num(a.version)}, ${count(a.tools,'tool')})`:''}`]];
 const tools=proposedTools(p),added=tools.filter(t=>t?.change==='added'),changed=tools.filter(t=>t?.change==='changed'),removed=Array.isArray(p.removed)?p.removed:[];
 const what=[added.length&&`${added.length} added`,changed.length&&`${changed.length} changed`,removed.length&&`${removed.length} removed`].filter(Boolean).join(', ')||'no tool added, changed or removed';
 const rows=[['diff',a?`${name}: ${what} since version ${num(a.version)}, accepted ${day(a.accepted_at)}`:`${name}: ${count(tools.length,'tool')} read, none accepted yet`]];
 added.forEach((t,i)=>rows.push([i?'':'added',cardLine(name,t)]));
 changed.forEach((t,i)=>rows.push([i?'':'changed',cardLine(name,t)],['',`  changed: ${(Array.isArray(t.changed)?t.changed:[]).map(x=>say(x,20)).join(', ')||'?'}`]));
 removed.forEach((t,i)=>rows.push([i?'':'removed',`${name}.${say(t,128)}`]));
 problemsOf(p).forEach((x,i)=>rows.push([i?'':'problem',say(x?.line??`${x?.tool}: ${x?.kind}`)]));
 rows.push(['accept',`cvm connect accept ${name}`]);
 return rows;
}
async function diff(c){
 const name=ref(c.args[0]);
 const read=await (await c.api()).request(`${BASE}/${enc(name)}/read`,{body:{}});
 if(c.format!=='table')return c.print(read);
 for(const [label,text] of diffRows(name,read))c.row(label,text);
}

async function accept(c){
 const name=ref(c.args[0]),effects=effectsOf(c.values.effect),api=await c.api();
 let version,read;
 if(c.values.version!==undefined)version=whole(c.values.version,'--version');
 else{
  read=await api.request(`${BASE}/${enc(name)}/read`,{body:{}});
  if(read?.same||!read?.proposed){
   if(c.format!=='table')return c.print({schema_version:1,ok:true,status:'unchanged',connector:name,read});
   c.row('accept',`nothing to accept: ${name} has no change since ${day(read?.accepted?.accepted_at)}.`);return;
  }
  version=read.proposed.version;
  for(const tool of Object.keys(effects))if(!proposedTools(read.proposed).some(t=>t?.name===tool))throw usage(`--effect names ${tool}, which is not one of ${name}'s tools. See them: cvm connect diff ${name}`);
  showProposal(c,name,read,effects,{lines:false});
 }
 if(!c.values.yes){
  const again=`cvm connect accept ${name} --version ${version}${Object.entries(effects).map(([tool,effect])=>` --effect ${tool}=${effect}`).join('')} --yes`;
  if(!c.terminal())throw own('cave_confirmation_required',`Nothing accepted: cvm asks before it accepts ${name}'s tools, and no one is at a terminal to answer. Accept with --yes.`,2,again);
  if(!await c.confirm(`Accept version ${version} of ${name}'s tools${read?` (${count(proposedTools(read.proposed).length,'tool')})`:''}?`,true)){
   if(c.format!=='table')return c.print({schema_version:1,ok:true,status:'declined',connector:name,version});
   c.row('kept','nothing accepted.');return;
  }
 }
 const done=await api.request(`${BASE}/${enc(name)}/accept`,{body:{version,...(Object.keys(effects).length?{effects}:{})}});
 if(c.format!=='table')return c.print(done);
 c.row('accepted',acceptedLine(name,done));
}

async function rotate(c){
 const name=ref(c.args[0]),api=await c.api();
 // The sign-in as it is before the new one starts: the wait is for a later one.
 const before=await find(api,name);
 c.line('rotate',`${name}: its sign-in works until the new one completes.`);
 const started=await api.request(`${BASE}/${enc(name)}/connect`,{body:{}});
 const k=await signIn(c,api,name,started?.authorize_url,{before,noBrowser:c.values['no-browser'],rotate:true});
 if(c.format!=='table')return c.print({schema_version:1,ok:true,status:'signed_in',connector:k});
}

async function pause(c){
 const name=ref(c.args[0]),reason=reasonOf(c.values.reason);
 const answer=await (await c.api()).request(`${BASE}/${enc(name)}/pause`,{body:reason===undefined?{}:{reason}});
 if(c.format!=='table')return c.print(answer);
 const p=answer?.connector?.paused;
 c.row('paused',`${name}: every call to it stops.${p?.by_name?` Paused by ${say(p.by_name,64)}${p.reason?`: ${say(p.reason,200)}`:'.'}`:p?.reason?` ${say(p.reason,200)}`:''}`);
 c.row('resume',`cvm connect resume ${name}`);
}

async function resume(c){
 const name=ref(c.args[0]);
 const answer=await (await c.api()).request(`${BASE}/${enc(name)}/resume`,{body:{}});
 if(c.format!=='table')return c.print(answer);
 c.row('resumed',`${name}: calls to it go through again.`);
}

async function allowWrites(c){
 const name=ref(c.args[0]),{values}=c;
 if(values.none&&values.in!==undefined)throw usage('Give --in, or --none for a sign-in that reads only, not both.');
 const where=values.none?[]:(values.in??'production').split(',').map(env=>env.trim());
 if(!values.none&&(!where.length||where.some(env=>!ENVIRONMENTS.includes(env))))throw usage('--in is production, preview or development, split by commas.');
 const envs=ENVIRONMENTS.filter(env=>where.includes(env));
 const answer=await (await c.api()).request(`${BASE}/${enc(name)}/writes`,{body:{in:envs}});
 if(c.format!=='table')return c.print(answer);
 const s=answer?.connector?.connection,writes=Array.isArray(s?.writes_in)?s.writes_in.filter(env=>ENVIRONMENTS.includes(env)):envs;
 const whose=s?.signed_in_by_name?`${say(s.signed_in_by_name,64)}'s`:'its';
 c.row(writes.length?'writes':'reads',writes.length?`${name} writes in ${and(writes)} with ${whose} sign-in.`:`${name} reads only: agents read with ${whose} sign-in and write nothing.`);
}

// What a decision did to the deploy that asked: live, granted for the next
// deploy, still waiting on other managers, or not going live.
const holdRow=(hold,deployment)=>{
 const name=say(hold?.deployment?.name??deployment,63);
 return {live:['live',`${name} is live as revision ${num(hold?.deployment?.revision)}.`],stale:['held',`${name}: granted; deploy again to go live.`],pending:['waits',`${name} still waits on other managers.`],refused:['held',`${name}'s deploy does not go live.`]}[hold?.state]??['held',`${name}: ${say(hold?.state,40)}.`];
};
async function grant(c){
 const {values}=c;
 if(values.request!==undefined){
  if(c.args.length||values.to!==undefined||values.tools!==undefined||values.ceiling!==undefined||values.revoke)throw usage('--request decides a request: it takes no connector, --to, --tools, --ceiling or --revoke. Use cvm connect grant --request ID [--refuse] [--reason TEXT].');
  if(!UUID.test(values.request))throw usage('--request is a request\'s id. List them: cvm connect requests');
  const reason=reasonOf(values.reason);
  const answer=await (await c.api()).request(`${BASE}/requests/${enc(values.request)}/decide`,{body:{grant:!values.refuse,...(reason===undefined?{}:{reason})}});
  if(c.format!=='table')return c.print(answer);
  const r=answer?.request,connector=say(r?.connector,64),deployment=say(r?.deployment,63);
  c.row(values.refuse?'refused':'granted',values.refuse?`${deployment} may not use ${connector} (request ${values.request}).`:`${deployment} may use ${connector} (request ${values.request}).`);
  if(answer?.hold)c.row(...holdRow(answer.hold,r?.deployment));
  return;
 }
 if(values.refuse||values.reason!==undefined)throw usage('--refuse and --reason answer a request: cvm connect grant --request ID --refuse.');
 if(c.args.length!==1)throw usage('Use cvm connect grant NAME --to DEPLOYMENT, or cvm connect grant --request ID.');
 const name=ref(c.args[0]),deployment=deploymentOf(values.to,'--to'),api=await c.api();
 if(values.revoke){
  if(values.tools!==undefined||values.ceiling!==undefined)throw usage('--revoke takes the whole grant away: it takes no --tools or --ceiling.');
  const answer=await api.request(`${BASE}/${enc(name)}/grants/revoke`,{body:{deployment}});
  if(c.format!=='table')return c.print(answer);
  c.row('revoked',`${deployment} may no longer use ${name}.`);
  return;
 }
 const tools=toolsOf(values.tools),ceiling=ceilingOf(values.ceiling)??'write';
 const answer=await api.request(`${BASE}/${enc(name)}/grants`,{body:{deployment,...(tools?{tools}:{}),ceiling}});
 if(c.format!=='table')return c.print(answer);
 const g=answer?.grant,granted=Array.isArray(g?.tools)?g.tools.map(t=>say(t,128)):[];
 c.row('granted',`${say(g?.deployment??deployment,63)} may use ${name}: ${granted.length?and(granted):'every accepted tool'}, up to ${say(g?.ceiling??ceiling,20)}.`);
}

async function request(c){
 const name=ref(c.args[0]),deployment=deploymentOf(c.values.for,'--for'),tools=toolsOf(c.values.tools),ceiling=ceilingOf(c.values.ceiling);
 const answer=await (await c.api()).request(`${BASE}/${enc(name)}/requests`,{body:{deployment,...(tools?{tools}:{}),...(ceiling?{ceiling}:{})}});
 if(c.format!=='table')return c.print(answer);
 c.row('asked',`${name}'s managers to let ${deployment} use it${tools?`: ${and(tools)}`:''}${ceiling?`, up to ${ceiling}`:''}.`);
 c.row('request',say(answer?.request?.id,40));
 c.row('see','cvm connect requests');
}

async function requests(c){
 const answer=await (await c.api()).request(`${BASE}/requests`);
 if(c.format!=='table')return c.print(answer);
 const all=Array.isArray(answer?.requests)?answer.requests:[];
 if(!all.length){c.out('Nothing waits for an answer.\n');return;}
 c.out(grid([['ID','CONNECTOR','FOR','WHO ASKED','WHEN',''],...all.map(r=>[say(r?.id,40),say(r?.connector,64),say(r?.deployment,63),say(r?.requested_by_name??'a key',64),when(r?.created_at),r?.you_decide?'you decide':r?.state==='pending'?'waits':say(r?.state,20)])]));
 if(all.some(r=>r?.you_decide))c.row('decide','cvm connect grant --request ID [--refuse] [--reason TEXT]');
}

async function rm(c){
 const name=ref(c.args[0]);
 if(!c.values.yes){
  if(!c.terminal())throw own('cave_confirmation_required',`Removing ${name} ends its sign-in, and no agent can use it again. Repeat with --yes to confirm.`,2,`cvm connect rm ${name} --yes`);
  if(!await c.confirm(`Remove ${name}? Its sign-in ends, and no agent can use it again.`,false)){
   if(c.format!=='table')return c.print({schema_version:1,ok:true,status:'kept',connector:name});
   c.row('kept',`${name}: nothing removed.`);return;
  }
 }
 const answer=await (await c.api()).request(`${BASE}/${enc(name)}/remove`,{body:{}});
 if(c.format!=='table')return c.print(answer);
 c.row('removed',name);
}

// ---- the command ------------------------------------------------------------
// flags: what a verb takes beyond --format and --help; args: how many names.
const VERBS={
 add:{usage:'cvm connect add TEMPLATE|URL [--name NAME] [--no-browser] [--yes]',summary:'Add a connector from the catalog by its template\'s name, or any MCP server by its https:// address and --name, and sign it in for the whole team in the browser. A connector of that name already there is signed in again. Then its tools are read and listed; --yes, or a yes at the terminal, accepts them. A person\'s sign-in reads only until its signer lets agents write with it.',flags:['name','no-browser','yes'],args:[1,1],run:add},
 ls:{usage:'cvm connect ls',summary:'The connectors: state, who signed each in, its accepted tools, the deployments that use it and what waits.',args:[0,0],run:ls},
 test:{usage:'cvm connect test NAME',summary:'Ask the server for its tools with the shared sign-in, once: ok with the time and the count, or the problem.',args:[1,1],run:test},
 diff:{usage:'cvm connect diff NAME',summary:'Read the server\'s tools now and show what changed since the accepted list: each added, changed and removed tool.',args:[1,1],run:diff},
 accept:{usage:'cvm connect accept NAME [--version N] [--effect TOOL=read|write|external ...] [--yes]',summary:'Accept the list of tools read from the server, the one deploys build from. Without --version it reads first and shows the count by effect and every tool that acts outside. --effect says what a tool does over what cvm was told. Asks at a terminal unless --yes; with no terminal and no --yes, nothing is accepted.',flags:['version','effect','yes'],args:[1,1],run:accept},
 rotate:{usage:'cvm connect rotate NAME [--no-browser]',summary:'Sign the connector in again in the browser. The old sign-in works until the new one completes; nothing is redeployed.',flags:['no-browser'],args:[1,1],run:rotate},
 pause:{usage:'cvm connect pause NAME [--reason TEXT]',summary:'Stop every call to the connector, from every agent, until it is resumed.',flags:['reason'],args:[1,1],run:pause},
 resume:{usage:'cvm connect resume NAME',summary:'Let calls to a paused connector through again.',args:[1,1],run:resume},
 'allow-writes':{usage:'cvm connect allow-writes NAME [--in production[,preview,development]] [--none]',summary:'Say where agents may write with the connector\'s sign-in (production unless --in says more); --none makes it read only. A person\'s sign-in is marked by the person who signed it in.',flags:['in','none'],args:[1,1],run:allowWrites},
 grant:{usage:'cvm connect grant NAME --to DEPLOYMENT [--tools A,B] [--ceiling read|write|external] [--revoke]  or  cvm connect grant --request ID [--refuse] [--reason TEXT]',summary:'Let a deployment use the connector: its tools (every accepted one unless --tools) up to a ceiling (write unless --ceiling). --revoke takes the grant away. --request answers a request instead, yes or --refuse, and says what became of the deploy that waited.',flags:['to','tools','ceiling','revoke','request','refuse','reason'],args:[0,1],run:grant},
 request:{usage:'cvm connect request NAME --for DEPLOYMENT [--tools A,B] [--ceiling read|write|external]',summary:'Ask the connector\'s managers to let a deployment use it.',flags:['for','tools','ceiling'],args:[1,1],run:request},
 requests:{usage:'cvm connect requests',summary:'The asks waiting for an answer: the ones you decide, and your own.',args:[0,0],run:requests},
 rm:{usage:'cvm connect rm NAME [--yes]',summary:'Remove the connector: its sign-in ends and no agent can use it again. Asks at a terminal unless --yes; with no terminal it needs --yes.',flags:['yes'],args:[1,1],run:rm},
};
for(const spec of Object.values(VERBS))spec.flags??=[];
const text={type:'string'},flag={type:'boolean'};
const OPTIONS={name:text,'no-browser':flag,yes:{...flag,short:'y'},version:text,effect:{...text,multiple:true},reason:text,in:text,none:flag,to:text,tools:text,ceiling:text,revoke:flag,request:text,refuse:flag,for:text,format:text,help:{...flag,short:'h'}};
const NOTES=[
 'A connector is named by the name agents write (lowercase letters, digits and single hyphens) or its id.',
 'A sign-in opens in the browser at a terminal (not with --no-browser or CAVE_NO_BROWSER); its address is printed either way, and cvm waits up to 5 minutes for it.',
 'Output is a table on a terminal and JSON when piped (--format json|table). A refusal prints its code, its message and, when the API names one, the command that fixes it.',
];
function help(verb,format){
 if(verb)return inertJSON({usage:VERBS[verb].usage,summary:VERBS[verb].summary},format==='table'?2:undefined)+'\n';
 const usageLine='cvm connect VERB [NAME] [flags] [--format json|table]',summary='Connectors: the servers your organization\'s agents use, signed in once for the team.';
 if(format!=='table')return inertJSON({usage:usageLine,summary,commands:Object.entries(VERBS).map(([name,v])=>({verb:name,usage:v.usage,summary:v.summary})),notes:NOTES})+'\n';
 return `${summary}\n\n${Object.values(VERBS).map(v=>`  ${v.usage}\n      ${v.summary}`).join('\n')}\n\n${NOTES.join('\n')}\n`;
}

// connect runs one cvm connect command. io replaces what the command reads and
// writes (context is the sign-in, as every cvm verb takes it); a test replaces
// the terminal, the question, the browser and the clock with its own.
export async function connect(argv,io={}){
 let format=process.stdout.isTTY?'table':'json',c,what='The connectors request';
 const write=io.out??(chunk=>process.stdout.write(chunk));
 try{
  let parsed;
  try{parsed=parseArgs({args:argv,strict:true,allowPositionals:true,options:OPTIONS});}
  catch(error){throw usage(`${error.message} See cvm connect --help.`);}
  const {values}=parsed,[verb,...args]=parsed.positionals;
  format=formatOf(values);
  if(verb!==undefined&&!Object.hasOwn(VERBS,verb))throw usage(`Unknown connect command ${say(verb,40)}. See cvm connect --help.`);
  if(values.help||verb===undefined){write(help(verb,format));return 0;}
  const spec=VERBS[verb];
  what=`The connect ${verb}`;
  for(const key of Object.keys(values))if(!['format','help'].includes(key)&&!spec.flags.includes(key))throw usage(`--${key} is not for cvm connect ${verb}. Use ${spec.usage}.`);
  if(args.length<spec.args[0]||args.length>spec.args[1])throw usage(`Use ${spec.usage}.`);
  c=session(io,format);
  c.values=values;c.args=args;
  // A verb answers its exit code, or nothing for 0.
  const code=await spec.run(c);
  return Number.isInteger(code)?code:0;
 }catch(error){return printFailed(write,format,error,what);}
 finally{c?.ask.close?.();}
}
