// `cvm agent build`: the reference builder of the agent build output, the
// folder Caveman Cloud stores as one agent version (agent-build.schema.json in
// the open contracts). It reads an agent folder, or one agent file, and
// derives agent.json from what is there: no network, no frontmatter key of its
// own. The same folder always gives the same bytes and the same digest: files
// sorted bytewise by path, no timestamps, no absolute paths, and no commit (a
// commit that leaves the agent's files alone must not make a new version).
import {lstatSync,readdirSync,readFileSync,statSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,dirname,join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {version} from './agents.mjs';

// What Cloud takes (the server refuses the same with 400 or 413).
export const LIMITS={files:1000,file:2*1024*1024,agentFile:256*1024,total:8*1024*1024};
const NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,TOOL=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/,SKILL=/^[a-z0-9][a-z0-9-]{0,63}$/;
const ENGINES=['caveman','claude-agent','codex'];
const EVAL=/^(.+)\.eval\.(json|yaml|yml)$/,CODE=/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const usage=message=>Object.assign(new CloudError('cave_usage',message,2),{local:true});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const bytewise=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
export const size=n=>n<1024?`${n} B`:n<1024*1024?`${(n/1024).toFixed(n<10240?1:0)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
// ignoreBOM keeps a byte order mark as content: the digest is of the bytes.
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

// ---- frontmatter --------------------------------------------------------
// cvm carries no YAML parser (it has no runtime dependencies), so this reads
// exactly what the nine keys a build is derived from take: scalars (plain,
// 'single' or "double" quoted), flow lists and maps ([a, b], {type: object}),
// block lists of scalars or of maps, and nested block maps (a custom tool's
// input_schema, a connector's tools, a drive's mount). A frontmatter that is
// one JSON object reads too. Every other key is skipped unread; anything else
// in the nine is refused by its line.
export const FRONTMATTER_KEYS=['name','description','engine','model','computer','tools','connectors','budgets','drives','output_schema','schedules','channels','subagents'];
const isItem=text=>text==='-'||text.startsWith('- ');

// Cut a comment: # at the start or after a space, outside a quoted scalar. A
// quote opens a scalar only where one may start.
function stripComment(line){
 let quote='',prev='';
 for(let i=0;i<line.length;i++){
  const c=line[i];
  if(quote==='"'){if(c==='\\')i++;else if(c==='"')quote='';continue;}
  if(quote==="'"){if(c==="'"){if(line[i+1]==="'")i++;else quote='';}continue;}
  if((c==='"'||c==="'")&&(prev===''||':-[{,?'.includes(prev))){quote=c;prev=c;continue;}
  if(c==='#'&&(i===0||line[i-1]===' '||line[i-1]==='\t'))return line.slice(0,i);
  if(c!==' '&&c!=='\t')prev=c;
 }
 return line;
}
// The depth of open flow brackets in text, outside quotes.
function depth(text){
 let d=0,quote='';
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quote==='"'){if(c==='\\')i++;else if(c==='"')quote='';continue;}
  if(quote==="'"){if(c==="'")quote='';continue;}
  if(c==='"'||c==="'")quote=c;else if(c==='{'||c==='[')d++;else if(c==='}'||c===']')d--;
 }
 return d;
}

export function readFrontmatter(text,file='AGENT.md'){
 const fail=(no,why)=>usage(`${file} line ${no}: ${why}`);
 const lines=text.replace(/^\ufeff/,'').split(/\r?\n/);
 if(!/^---[ \t]*$/.test(lines[0]))return {};
 const end=lines.findIndex((line,i)=>i>0&&/^---[ \t]*$/.test(line));
 if(end<0)throw fail(1,'opens the frontmatter with --- but no later --- line closes it.');
 const rows=[];
 for(let i=1;i<end;i++){
  const body=stripComment(lines[i]).trimEnd(),indent=/^ */.exec(body)[0].length;
  if(body.trim())rows.push({no:i+1,indent,tab:body[indent]==='\t',text:body.slice(indent)});
 }
 if(!rows.length)return {};
 const where=new WeakMap(); // object or array -> the line of each key or item
 let i=0;
 const row=()=>{const r=rows[i];if(r.tab)throw fail(r.no,'indents with a tab; YAML indents with spaces.');return r;};

 function quoted(src,p,no){
  const q=src[p];let out='';p++;
  for(;;){
   if(p>=src.length)throw fail(no,'has a quoted value that does not close on its line.');
   const c=src[p];
   if(q==="'"){if(c==="'"){if(src[p+1]==="'"){out+="'";p+=2;continue;}return [out,p+1];}out+=c;p++;continue;}
   if(c==='"')return [out,p+1];
   if(c!=='\\'){out+=c;p++;continue;}
   const e=src[p+1],simple={'"':'"','\\':'\\','/':'/',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t','0':'\0',' ':' '};
   if(Object.hasOwn(simple,e)){out+=simple[e];p+=2;continue;}
   const digits={x:2,u:4,U:8}[e],hex=digits&&src.slice(p+2,p+2+digits);
   if(!digits||!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex))throw fail(no,`uses the escape \\${e??''}, which cvm does not read.`);
   out+=String.fromCodePoint(parseInt(hex,16));p+=2+digits;
  }
 }
 function plain(t,no){
  if(/^[&*!|>%@`]/.test(t))throw fail(no,`starts a value with ${t[0]}: anchors, aliases, tags and block scalars (| or >) are not read. Write the value on one line, quoted if it needs to be.`);
  if(/:([ \t]|$)/.test(t))throw fail(no,'holds ": " in an unquoted value; quote the value.');
  if(/^(null|Null|NULL|~)$/.test(t))return null;
  if(/^(true|True|TRUE)$/.test(t))return true;
  if(/^(false|False|FALSE)$/.test(t))return false;
  if(/^[-+]?(\d+|\d*\.\d+|\d+\.\d*)([eE][-+]?\d+)?$/.test(t))return Number(t);
  return t;
 }
 function scalar(rest,no){
  if(rest[0]!=='"'&&rest[0]!=="'")return plain(rest,no);
  const [value,p]=quoted(rest,0,no);
  if(rest.slice(p).trim())throw fail(no,'has text after a quoted value.');
  return value;
 }
 function flow(src,no){
  let p=0;
  const ws=()=>{while(p<src.length&&/\s/.test(src[p]))p++;};
  const bad=why=>fail(no,`${why} in the flow value ${JSON.stringify(src.length>60?src.slice(0,57)+'...':src)}.`);
  const atom=isKey=>{
   ws();
   if(src[p]==='"'||src[p]==="'"){const [value,next]=quoted(src,p,no);p=next;return value;}
   let q=p;
   while(q<src.length&&!',[]{}'.includes(src[q])&&!(src[q]===':'&&(q+1>=src.length||/[\s,\[\]{}]/.test(src[q+1]))))q++;
   const t=src.slice(p,q).trim();p=q;
   if(!t)throw bad('expects a value');
   return isKey?t:plain(t,no);
  };
  const value=()=>{
   ws();
   if(src[p]==='{'){
    p++;const out={},at={};where.set(out,at);
    for(;;){
     ws();if(src[p]==='}'){p++;return out;}
     const key=String(atom(true));ws();
     if(src[p]!==':')throw bad('expects : after the key '+key);
     p++;if(Object.hasOwn(out,key))throw fail(no,`repeats the key ${key}.`);
     at[key]=no;out[key]=value();ws();
     if(src[p]===','){p++;continue;}
     if(src[p]==='}'){p++;return out;}
     throw bad('expects , or }');
    }
   }
   if(src[p]==='['){
    p++;const out=[],at=[];where.set(out,at);
    for(;;){
     ws();if(src[p]===']'){p++;return out;}
     at.push(no);out.push(value());ws();
     if(src[p]===','){p++;continue;}
     if(src[p]===']'){p++;return out;}
     throw bad('expects , or ]');
    }
   }
   return atom(false);
  };
  const out=value();ws();
  if(p<src.length)throw bad('has text after the closing bracket');
  return out;
 }
 const keyOf=text=>{
  let key,p;
  if(text[0]==='"'||text[0]==="'"){try{[key,p]=quoted(text,0,0);}catch{return undefined;}}
  else{
   const m=/^[^\s'"{}[\],&*!|>%@`#-][^:#]*?:(?=[ \t]|$)|^-[^\s:#][^:#]*?:(?=[ \t]|$)/.exec(text);
   if(!m)return undefined;
   key=m[0].slice(0,-1).trimEnd();p=m[0].length-1;
  }
  const rest=text.slice(p);
  if(!/^[ \t]*:([ \t]|$)/.test(rest))return undefined;
  return {key,rest:rest.replace(/^[ \t]*:/,'').trim()};
 };
 // A flow value may run over several more-indented lines.
 const gather=(rest,indent)=>{let text=rest;while(depth(text)>0&&i<rows.length&&rows[i].indent>indent)text+='\n'+rows[i++].text;return text;};
 function value(rest,r,indent,inMap){
  if(rest===''){
   if(i<rows.length&&rows[i].indent>indent)return block();
   if(inMap&&i<rows.length&&rows[i].indent===indent&&isItem(rows[i].text))return list(indent);
   return null;
  }
  if(rest[0]==='{'||rest[0]==='[')return flow(gather(rest,indent),r.no);
  const out=scalar(rest,r.no);
  if(i<rows.length&&rows[i].indent>indent)throw fail(rows[i].no,'continues the value of the line before; write a value on one line, quoted if it needs to be.');
  return out;
 }
 function block(){return isItem(row().text)?list(rows[i].indent):map(rows[i].indent);}
 function map(indent){
  const out={},at={};where.set(out,at);
  while(i<rows.length&&rows[i].indent===indent){
   const r=row();
   if(isItem(r.text))throw fail(r.no,'is a list item where a key was expected.');
   const kv=keyOf(r.text);
   if(!kv)throw fail(r.no,'is not a "key: value" line.');
   if(Object.hasOwn(out,kv.key))throw fail(r.no,`repeats the key ${kv.key}.`);
   at[kv.key]=r.no;i++;
   out[kv.key]=value(kv.rest,r,indent,true);
  }
  if(i<rows.length&&rows[i].indent>indent)throw fail(rows[i].no,'is indented more than the lines before it.');
  return out;
 }
 function list(indent){
  const out=[],at=[];where.set(out,at);
  while(i<rows.length&&rows[i].indent===indent&&isItem(rows[i].text)){
   const r=row(),rest=r.text.slice(1).replace(/^ +/,''),column=indent+r.text.length-rest.length;
   at.push(r.no);
   if(rest===''){i++;out.push(i<rows.length&&rows[i].indent>indent?block():null);continue;}
   if(isItem(rest))throw fail(r.no,'nests a list on one line (- - ...); write the inner list as [a, b].');
   if(rest[0]!=='{'&&rest[0]!=='['&&keyOf(rest)){rows[i]={...r,indent:column,text:rest};out.push(map(column));continue;}
   i++;out.push(value(rest,r,indent,false));
  }
  return out;
 }

 let doc;
 if(rows[0].indent===0&&rows[0].text[0]==='{'){
  // A JSON frontmatter: one flow map.
  doc=flow(rows.map(r=>r.text).join('\n'),rows[0].no);
  const at={};for(const key of Object.keys(doc))at[key]=rows[0].no;where.set(doc,at);
 }else{
  doc={};const at={};where.set(doc,at);
  while(i<rows.length){
   const r=row();
   if(r.indent!==0)throw fail(r.no,'is indented, but no key above it takes a nested value.');
   const kv=keyOf(r.text);
   if(!kv)throw fail(r.no,'is not a "key: value" line.');
   i++;
   if(!FRONTMATTER_KEYS.includes(kv.key)){
    // Not a key a build is derived from: skipped, never read.
    if(kv.rest[0]==='{'||kv.rest[0]==='[')gather(kv.rest,0);
    while(i<rows.length&&(rows[i].indent>0||isItem(rows[i].text)))i++;
    continue;
   }
   if(Object.hasOwn(doc,kv.key))throw fail(r.no,`repeats the key ${kv.key}.`);
   at[kv.key]=r.no;
   doc[kv.key]=value(kv.rest,r,0,true);
  }
 }
 const front={};
 for(const key of FRONTMATTER_KEYS)if(doc[key]!==undefined&&doc[key]!==null)front[key]=doc[key];
 Object.defineProperty(front,'lineOf',{value:(container,key,fallback)=>where.get(container??doc)?.[key]??fallback??rows[0].no});
 return front;
}

// The manifest's part that comes from AGENT.md, each value checked against the
// build contract with the line it came from.
export function agentFields(text,file='AGENT.md'){
 const front=readFrontmatter(text,file),line=front.lineOf;
 const fail=(no,why)=>usage(`${file} line ${no}: ${why}`);
 const string=(key,check,rule)=>{
  const value=front[key];
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!check(value))throw fail(line(undefined,key),`${key} must be ${rule}.`);
  return value;
 };
 const out={
  name:string('name',v=>NAME.test(v),'1 to 100 letters, digits, ".", "_" or "-", starting with a letter or digit'),
  description:string('description',v=>v.length<=500,'text of at most 500 characters'),
  engine:string('engine',v=>ENGINES.includes(v),ENGINES.join(', ').replace(/, (?=[^,]+$)/,' or ')),
  model:string('model',v=>v.length>=1&&v.length<=200,'a model id or class of 1 to 200 characters'),
  computer:string('computer',v=>v.length>0,'text, such as none, readonly or full'),
  tools:[],
 };
 if(front.tools!==undefined){
  if(!Array.isArray(front.tools))throw fail(line(undefined,'tools'),'tools must be a list, such as [Read, Grep] or a list of custom tools.');
  const seen=new Set();
  for(const [n,entry] of front.tools.entries()){
   const no=line(front.tools,n,line(undefined,'tools'));
   let tool;
   if(typeof entry==='string'){
    if(!TOOL.test(entry))throw fail(no,`the tool ${JSON.stringify(entry)} must be 1 to 64 letters, digits, "_" or "-", starting with a letter.`);
    tool={name:entry,kind:'builtin'};
   }else if(entry&&typeof entry==='object'&&!Array.isArray(entry)){
    const at=key=>line(entry,key,no);
    if(entry.type!=='custom')throw fail(no,`a tool ${entry.type===undefined?'with no type':`of type ${JSON.stringify(entry.type)}`} is not one cvm builds: a tool is a built-in tool's name or {type: custom, name, description, input_schema}.`);
    if(typeof entry.name!=='string'||!TOOL.test(entry.name))throw fail(at('name'),'a custom tool\'s name must be 1 to 64 letters, digits, "_" or "-", starting with a letter.');
    if(typeof entry.description!=='string'||!entry.description.length||entry.description.length>4000)throw fail(at('description'),`the custom tool ${entry.name} needs a description of 1 to 4,000 characters.`);
    if(!entry.input_schema||typeof entry.input_schema!=='object'||Array.isArray(entry.input_schema))throw fail(at('input_schema'),`the custom tool ${entry.name} needs an input_schema: a JSON Schema object.`);
    tool={name:entry.name,kind:'caller',description:entry.description,input_schema:entry.input_schema};
   }else throw fail(no,'a tool is a built-in tool\'s name or {type: custom, name, description, input_schema}.');
   if(seen.has(tool.name))throw fail(no,`the tool ${tool.name} is listed twice.`);
   seen.add(tool.name);out.tools.push(tool);
  }
 }
 // Only when written: a frontmatter without them derives what it always did.
 if(front.connectors!==undefined)out.connectors=connectorsOf(front,fail);
 if(front.budgets!==undefined)out.budgets=budgetsOf(front,fail);
 if(front.drives!==undefined)out.drives=drivesOf(front,fail);
 if(front.output_schema!==undefined){
  if(!isMap(front.output_schema))throw fail(line(undefined,'output_schema'),'output_schema must be a JSON Schema object.');
  out.output_schema=front.output_schema;
 }
 if(front.schedules!==undefined){
  if(!isMap(front.schedules))throw fail(line(undefined,'schedules'),'schedules must be a map of schedule names to {cron, task, ...}.');
  out.schedules=front.schedules;
 }
 if(front.channels!==undefined){
  if(!isMap(front.channels))throw fail(line(undefined,'channels'),'channels must be a map of channel providers (slack, github, linear, webhook, web, ...) to their settings.');
  out.channels=front.channels;
 }
 if(front.subagents!==undefined){
  if(!Array.isArray(front.subagents))throw fail(line(undefined,'subagents'),'subagents must be a list of {name, deployment} delegations.');
  out.subagents=front.subagents;
 }
 return out;
}

// ---- connectors and budgets ---------------------------------------------------
// connectors names what the agent may call through the organization's
// connectors: a list of names (connectors: [linear, notion]), or a map from a
// name to what that one may use ({tools, as, args, approve, unpinned}).
// agent.json always holds the map, its names in the frontmatter's order, a
// listed name as {}. cvm checks the shape the build contract limits; whether a
// name is a connector of the organization, and what it may grant, is the
// deploy's to say.
const CONNECTOR=/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,ACTS=['shared','user','end_user'],CONNECTOR_KEYS=['tools','as','args','approve','unpinned','after_untrusted'];
export const CONNECTOR_LIMITS={connectors:32,tools:200,args:16,budget:[100,100000]};
const isMap=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const quote=value=>JSON.stringify(value)??String(value);
function connectorsOf(front,fail){
 const line=front.lineOf,at=line(undefined,'connectors'),given=front.connectors;
 // A key written __proto__ would become the object's prototype, not a key.
 const plain=(map,no)=>{if(Object.getPrototypeOf(map)!==Object.prototype)throw fail(no,'uses the key __proto__, which cvm does not read.');return map;};
 const named=(name,no)=>{if(typeof name!=='string'||name.length>32||!CONNECTOR.test(name))throw fail(no,`the connector ${quote(name)} must be a connector's name: lowercase letters, digits and single hyphens, a letter first, at most 32 characters.`);return name;};
 let entries;
 if(Array.isArray(given)){
  entries=given.map((name,i)=>{
   const no=line(given,i,at);
   if(isMap(name))throw fail(no,'lists a map: a list names connectors, such as [linear, notion]. To say what one may use, write connectors as a map: {linear: {tools: [list_issues]}}.');
   return [named(name,no),null,no];
  });
 }else if(isMap(given)){
  plain(given,at);
  entries=Object.entries(given).map(([name,value])=>[named(name,line(given,name,at)),value,line(given,name,at)]);
 }else throw fail(at,'connectors must be a list of names, such as [linear, notion], or a map from a name to what it may use, such as {linear: {tools: [list_issues]}}.');
 if(entries.length>CONNECTOR_LIMITS.connectors)throw fail(at,`connectors names ${entries.length} connectors; an agent uses at most ${CONNECTOR_LIMITS.connectors}.`);
 const out={};
 for(const [name,value,no] of entries){
  if(Object.hasOwn(out,name))throw fail(no,`the connector ${name} is listed twice.`);
  if(value===null){out[name]={};continue;}
  if(!isMap(value))throw fail(no,`${name} takes a map of what it may use, such as {tools: [list_issues]}, or nothing.`);
  plain(value,no);
  out[name]=connectorEntry(name,value,no,line,fail);
 }
 return out;
}
// names reads a list of tool names: strings of 1 to 128 characters with no
// space or control character, none twice.
function names(list,what,no,line,fail,max){
 if(!Array.isArray(list))throw fail(no,`${what} must be a list of tool names, such as [list_issues, get_issue].`);
 if(max&&(list.length<1||list.length>max))throw fail(no,`${what} names ${list.length} tools; it names 1 to ${max}.`);
 const seen=new Set();
 for(const [i,name] of list.entries()){
  const at=line(list,i,no);
  if(typeof name!=='string'||!/^[^\s\x00-\x1f\x7f]{1,128}$/.test(name))throw fail(at,`${what}: ${quote(name)} is not a tool name (1 to 128 characters, no space).`);
  if(seen.has(name))throw fail(at,`${what} lists ${name} twice.`);
  seen.add(name);
 }
 return list;
}
function connectorEntry(name,value,no,line,fail){
 const at=key=>line(value,key,no),entry={};
 for(const key of Object.keys(value)){
  if(!CONNECTOR_KEYS.includes(key))throw fail(at(key),`${name} takes tools, as, args, approve and unpinned; ${key} is not one of them.`);
  const v=value[key];
  if(key==='tools')entry.tools=[...names(v,`${name}'s tools`,at(key),line,fail,CONNECTOR_LIMITS.tools)];
  else if(key==='after_untrusted'){
   if(typeof v!=='string'||!['allow','approve','deny'].includes(v))throw fail(at(key),`${name}'s after_untrusted must be allow, approve or deny.`);
   entry.after_untrusted=v;
  }else if(key==='as'){
   const act=x=>typeof x==='string'&&ACTS.includes(x);
   if(isMap(v)){
    const keys=Object.keys(v);
    if(Object.getPrototypeOf(v)!==Object.prototype||keys.length!==2||!keys.includes('read')||!keys.includes('write')||!act(v.read)||!act(v.write))throw fail(at(key),`${name}'s as split by effect is {read: ..., write: ...}, each shared, user or end_user.`);
    entry.as={read:v.read,write:v.write};
   }else if(act(v))entry.as=v;
   else throw fail(at(key),`${name}'s as must be shared, user or end_user, or {read: ..., write: ...}.`);
  }else if(key==='args'){
   if(!isMap(v))throw fail(at(key),`${name}'s args must be a map from an argument to its value, such as {owner: acme}.`);
   if(Object.getPrototypeOf(v)!==Object.prototype)throw fail(at(key),'uses the key __proto__, which cvm does not read.');
   const keys=Object.keys(v);
   if(keys.length>CONNECTOR_LIMITS.args)throw fail(at(key),`${name}'s args pins ${keys.length} arguments; it pins at most ${CONNECTOR_LIMITS.args}.`);
   for(const arg of keys){
    const x=v[arg];
    if(!(typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x)))throw fail(line(v,arg,at(key)),`${name}'s argument ${arg} must be a string, a number or true or false.`);
   }
   entry.args={...v};
  }else{
   names(v,`${name}'s ${key}`,at(key),line,fail);
   for(const [i,tool] of v.entries())if(Array.isArray(value.tools)&&!value.tools.includes(tool))throw fail(line(v,i,at(key)),`${name}'s ${key} names ${tool}, which is not in its tools.`);
   entry[key]=[...v];
  }
 }
 return entry;
}
function budgetsOf(front,fail){
 const line=front.lineOf,at=line(undefined,'budgets'),given=front.budgets;
 if(!isMap(given))throw fail(at,'budgets must be a map, such as {tools: 6000}.');
 if(Object.getPrototypeOf(given)!==Object.prototype)throw fail(at,'uses the key __proto__, which cvm does not read.');
 for(const key of Object.keys(given))if(key!=='tools')throw fail(line(given,key,at),`budgets takes tools (the most tokens the agent's tool card may take); ${key} is not one of them.`);
 const [min,max]=CONNECTOR_LIMITS.budget,tools=given.tools;
 if(!Number.isInteger(tools)||tools<min||tools>max)throw fail(line(given,'tools',at),`budgets.tools must be a whole number of tokens from ${min} to ${max.toLocaleString('en-US')}.`);
 return {tools};
}

// ---- drives -------------------------------------------------------------------
// drives mounts folders of the organization's drives where the agent sees
// them: a map from a mount path (/kb) to a drive's name, which mounts the whole
// drive read-only, or to {drive, folder, write, review, trusted, description}.
// folder may hold {name} placeholders, which a session's subject fills when it
// starts. agent.json keeps each value as written, a name as a name. Whether a
// drive exists, and whether the deployer may grant what a mount asks, is the
// deploy's to say.
const MOUNT=/^\/[a-z0-9][a-z0-9_-]{0,62}$/,DRIVE=/^[a-z0-9][a-z0-9-]{0,62}$/,PLACEHOLDER=/\{([a-z][a-z0-9_]{0,31})\}/g,MOUNT_KEYS=['drive','folder','write','review','trusted','description'];
export const DRIVE_LIMITS={mounts:8,folder:1024,description:200,subject:16};
// The {names} a folder holds, in order, each once.
export const placeholders=folder=>[...new Set([...String(folder??'').matchAll(PLACEHOLDER)].map(m=>m[1]))];
function drivesOf(front,fail){
 const line=front.lineOf,at=line(undefined,'drives'),given=front.drives;
 if(!isMap(given))throw fail(at,'drives must be a map from a mount path to a drive, such as {/kb: support-kb, /work: {drive: customers, write: true}}.');
 if(Object.getPrototypeOf(given)!==Object.prototype)throw fail(at,'uses the key __proto__, which cvm does not read.');
 const mounts=Object.keys(given);
 if(mounts.length>DRIVE_LIMITS.mounts)throw fail(at,`drives mounts ${mounts.length} folders; an agent mounts at most ${DRIVE_LIMITS.mounts}.`);
 const out={},names=new Set();
 for(const mount of mounts){
  const no=line(given,mount,at),value=given[mount],key=`drives.${mount}`;
  if(!MOUNT.test(mount))throw fail(no,`${key}: a mount path is / and 1 to 63 lowercase letters, digits, '_' or '-', starting with a letter or digit, such as /kb.`);
  const drive=(name,where)=>{if(typeof name!=='string'||!DRIVE.test(name))throw fail(where,`${key}: ${quote(name)} is not a drive's name: 1 to 63 lowercase letters, digits or '-', starting with a letter or digit.`);return name;};
  if(typeof value==='string'){out[mount]=drive(value,no);continue;}
  if(!isMap(value))throw fail(no,`${key} is a drive's name, such as support-kb, or {drive: ..., folder: ..., write: true}.`);
  if(Object.getPrototypeOf(value)!==Object.prototype)throw fail(no,'uses the key __proto__, which cvm does not read.');
  const where=k=>line(value,k,no),entry={};
  for(const k of Object.keys(value))if(!MOUNT_KEYS.includes(k))throw fail(where(k),`${key} takes drive, folder, write, review, trusted and description; ${k} is not one of them.`);
  if(value.drive===undefined)throw fail(no,`${key} names no drive: write {drive: <name>, ...}.`);
  entry.drive=drive(value.drive,where('drive'));
  if(value.folder!==undefined){
   const f=value.folder;
   if(typeof f!=='string'||!f.length||f.length>DRIVE_LIMITS.folder||/[\x00-\x1f\x7f]/.test(f))throw fail(where('folder'),`${key}.folder is a folder of the drive: text of 1 to ${DRIVE_LIMITS.folder.toLocaleString('en-US')} characters, such as policies or "{customer}".`);
   if(/[{}]/.test(f.replace(PLACEHOLDER,'')))throw fail(where('folder'),`${key}.folder: a placeholder is {name}, a lowercase letter then up to 31 lowercase letters, digits or '_', such as "{customer}"; no other { or } may be in a folder.`);
   if(f.replace(/^\//,'').split('/').some(s=>s===''||s==='.'||s==='..'))throw fail(where('folder'),`${key}.folder names folders between single slashes, with no . or .. and no / at its end, such as customers/{customer}.`);
   for(const name of placeholders(f))names.add(name);
   entry.folder=f;
  }
  for(const flag of ['write','review','trusted'])if(value[flag]!==undefined){
   if(typeof value[flag]!=='boolean')throw fail(where(flag),`${key}.${flag} is true or false.`);
   entry[flag]=value[flag];
  }
  if(value.description!==undefined){
   const d=value.description;
   if(typeof d!=='string'||[...d].length>DRIVE_LIMITS.description||/[\x00-\x1f\x7f]/.test(d))throw fail(where('description'),`${key}.description is one line of at most ${DRIVE_LIMITS.description} characters the agent is shown.`);
   entry.description=d;
  }
  out[mount]=entry;
 }
 if(names.size>DRIVE_LIMITS.subject)throw fail(at,`drives' folders hold ${names.size} placeholders; a session's subject fills at most ${DRIVE_LIMITS.subject}.`);
 return out;
}

// ---- the folder -----------------------------------------------------------
const isFile=path=>{try{const st=lstatSync(path);return st.isFile()||st.isSymbolicLink();}catch{return false;}};
// locate finds what to build: a folder holding AGENT.md or one agent file.
// With no path, the current folder when it holds AGENT.md, else the one agent
// under .caveman/agents/.
export function locate(path,cwd=process.cwd()){
 if(path!==undefined){
  const at=resolve(cwd,path);let st;
  try{st=lstatSync(at);}catch{throw usage(`${path} does not exist.`);}
  if(st.isSymbolicLink()){st=statSync(at,{throwIfNoEntry:false});if(!st?.isDirectory())throw usage(`${path} is a symlink; name the agent file itself.`);}
  if(st.isDirectory()){
   if(!isFile(join(at,'AGENT.md')))throw usage(`${path} holds no AGENT.md. Name a folder that holds AGENT.md, or one agent file (*.md).`);
   return {kind:'folder',root:at,label:path};
  }
  if(!st.isFile()||!/\.md$/i.test(at))throw usage(`${path} is not an agent. Name a folder that holds AGENT.md, or one agent file (*.md).`);
  return {kind:'file',root:dirname(at),file:at,label:path};
 }
 if(isFile(join(cwd,'AGENT.md')))return {kind:'folder',root:cwd,label:'.'};
 const agents=join(cwd,'.caveman','agents');let found=[];
 try{
  for(const entry of readdirSync(agents,{withFileTypes:true})){
   if(entry.isFile()&&/\.md$/i.test(entry.name))found.push({kind:'file',root:agents,file:join(agents,entry.name),label:`.caveman/agents/${entry.name}`});
   else if(entry.isDirectory()&&isFile(join(agents,entry.name,'AGENT.md')))found.push({kind:'folder',root:join(agents,entry.name),label:`.caveman/agents/${entry.name}/`});
  }
 }catch{}
 found=found.sort((a,b)=>bytewise(a.label,b.label));
 if(found.length===1)return found[0];
 if(!found.length)throw usage('No AGENT.md in this folder and no agent under .caveman/agents/. Name a folder that holds AGENT.md, or one agent file: cvm agent build PATH.');
 throw usage(`More than one agent under .caveman/agents/: ${found.map(f=>f.label.slice('.caveman/agents/'.length)).join(', ')}. Name one: cvm agent build ${found[0].label}`);
}

// collect lists the folder's build files and what is not part of the build.
// Included: AGENT.md, skills/<name>/** with a SKILL.md, agents/<name>/** with
// an AGENT.md, evals/*.eval.{json,yaml,yml}.
function collect(root){
 const files=[],excluded=[];
 const refuse=(path,why)=>{throw usage(`${path} ${why}`);};
 const link=path=>refuse(path,'is a symlink; a build holds only regular files. Copy the file into the folder instead.');
 const kind=(entry,path)=>{if(entry.isSymbolicLink())link(path);if(!entry.isFile()&&!entry.isDirectory())refuse(path,'is not a regular file.');};
 const walk=rel=>{for(const entry of readdirSync(join(root,rel),{withFileTypes:true})){const path=`${rel}/${entry.name}`;kind(entry,path);if(entry.isDirectory())walk(path);else files.push(path);}};
 // Code in a tools/ folder is a code tool, which needs the interpreter sandbox.
 const code=rel=>{
  let hit;
  for(const entry of readdirSync(join(root,rel),{withFileTypes:true}).sort((a,b)=>bytewise(a.name,b.name))){
   const path=`${rel}/${entry.name}`;
   if(entry.isDirectory()&&!entry.isSymbolicLink())hit??=code(path);else if(CODE.test(entry.name))hit??=path;
  }
  return hit;
 };
 const noCode=rel=>{const hit=code(rel);if(hit)refuse(hit,'is code in a tools/ folder. Code tools need the interpreter sandbox, which this version of cvm does not build; declare the tool as a custom tool in AGENT.md\'s tools, or move the file out of tools/.');};
 for(const entry of readdirSync(root,{withFileTypes:true})){
  const name=entry.name,shown=entry.isDirectory()?name+'/':name;
  if(name==='AGENT.md'){kind(entry,name);if(entry.isDirectory())refuse(name,'is a folder; AGENT.md is the agent file.');files.push(name);continue;}
  if(!['skills','agents','evals','tools'].includes(name)){excluded.push(shown);continue;}
  if(entry.isSymbolicLink())link(name);
  if(!entry.isDirectory()){excluded.push(shown);continue;}
  if(name==='tools'){
   for(const child of readdirSync(join(root,name),{withFileTypes:true}).sort((a,b)=>bytewise(a.name,b.name))){
    const path=`${name}/${child.name}`,childShown=child.isDirectory()?path+'/':path;
    if(child.isSymbolicLink())link(path);
    if(child.isDirectory()||!CODE.test(child.name)){excluded.push(childShown);continue;}
    kind(child,path);
    files.push(path);
   }
   continue;
  }
  for(const child of readdirSync(join(root,name),{withFileTypes:true})){
   const path=`${name}/${child.name}`,childShown=child.isDirectory()?path+'/':path;
   if(name==='evals'){
    if(!EVAL.test(child.name)){excluded.push(childShown);continue;}
    kind(child,path);
    if(child.isDirectory())excluded.push(childShown);else files.push(path);
    continue;
   }
   if(child.isSymbolicLink())link(path);
   if(!child.isDirectory()||!isFile(join(root,path,name==='skills'?'SKILL.md':'AGENT.md'))){excluded.push(childShown);continue;}
   if(name==='agents'&&existsSync(join(root,path,'tools'))&&lstatSync(join(root,path,'tools')).isDirectory())noCode(`${path}/tools`);
   walk(path);
  }
 }
 return {files:files.sort(bytewise),excluded:excluded.sort(bytewise)};
}

// build reads source (from locate) into the build: the manifest, agent.json's
// text and digest, and every file's text.
export function build(source){
 const listed=source.kind==='file'?{files:['AGENT.md'],excluded:[]}:collect(source.root);
 if(listed.files.length>LIMITS.files)throw usage(`The build has ${listed.files.length} files; the most is ${LIMITS.files.toLocaleString('en-US')} besides agent.json.`);
 let total=0;
 const files=listed.files.map(path=>{
  const at=source.kind==='file'?source.file:join(source.root,...path.split('/'));
  const max=path==='AGENT.md'?LIMITS.agentFile:LIMITS.file,st=lstatSync(at);
  if(st.size>max)throw usage(`${path} is ${size(st.size)}, over the ${size(max)} one ${path==='AGENT.md'?'agent file':'file'} may be.`);
  if(Buffer.byteLength(path)>512||/[\\\u0000-\u001f\u007f]/.test(path))throw usage(`${path}: a build's paths are at most 512 bytes, with no backslash and no control character. Rename it.`);
  const bytes=readFileSync(at);let text;
  try{text=utf8.decode(bytes);}catch{throw usage(`${path} is not UTF-8 text; a build holds text files only.`);}
  if(text.includes('\0'))throw usage(`${path} is not text (it holds a NUL byte); a build holds text files only.`);
  total+=bytes.length;
  if(total>LIMITS.total)throw usage(`The build is over ${size(LIMITS.total)} at ${path}; the most a build may be is ${size(LIMITS.total)}.`);
  return {path,text,bytes:bytes.length,sha256:sha256(bytes)};
 });
 const agentFile=files.find(f=>f.path==='AGENT.md');
 if(!agentFile.text.trim())throw usage('AGENT.md is empty: it holds the agent\'s instructions.');
 const fields=agentFields(agentFile.text,source.kind==='file'?source.label:'AGENT.md');
 const fallback=source.kind==='file'?basename(source.file).replace(/\.md$/i,''):basename(source.root);
 const name=fields.name??fallback;
 if(!NAME.test(name))throw usage(`The agent's name would be ${JSON.stringify(name)}, from its ${source.kind==='file'?'file':'folder'} name, which is not one: name it in AGENT.md's frontmatter (name: ...), 1 to 100 letters, digits, ".", "_" or "-".`);
 const named=(prefix,anchor)=>listed.files.filter(path=>path.startsWith(prefix)&&path.endsWith('/'+anchor)&&path.split('/').length===3).map(path=>({name:path.split('/')[1],path}));
 const skills=named('skills/','SKILL.md'),subagents=named('agents/','AGENT.md');
 for(const skill of skills)if(!SKILL.test(skill.name))throw usage(`skills/${skill.name}/: a skill's folder name is its name: 1 to 64 lowercase letters, digits or "-", starting with a letter or digit. Rename the folder.`);
 for(const agent of subagents)if(!NAME.test(agent.name))throw usage(`agents/${agent.name}/: a subagent's folder name is its name: 1 to 100 letters, digits, ".", "_" or "-". Rename the folder.`);
 const evals=listed.files.filter(path=>path.startsWith('evals/')).map(path=>({name:EVAL.exec(path.slice(6))[1],path}));
 for(const item of evals)if(item.name.length>200)throw usage(`${item.path}: an eval's name (its file name) is at most 200 characters.`);
 const codeTools=listed.files.filter(path=>path.startsWith('tools/')&&path.split('/').length===2).map(path=>{
  const file=files.find(f=>f.path===path),base=path.slice(6),ext=base.slice(base.lastIndexOf('.')+1).toLowerCase();
  const toolName=base.slice(0,base.lastIndexOf('.'));
  if(!TOOL.test(toolName))throw usage(`${path}: a code tool's filename must be 1 to 64 letters, digits, "_" or "-", starting with a letter.`);
  const runtime=ext==='py'?'python':'js';
  const spec={name:toolName,kind:'code',description:`Code tool ${toolName}`,input_schema:{type:'object',properties:{}},effect:'read',entry:path,runtime};
  for(const line of file.text.split(/\r?\n/)){
   const trimmed=line.trim(),prefix=trimmed.startsWith('// @caveman-tool ')?'// @caveman-tool ':trimmed.startsWith('# @caveman-tool ')?'# @caveman-tool ':'';
   if(prefix){
    try{
     const meta=JSON.parse(trimmed.slice(prefix.length));
     if(typeof meta.description==='string'&&meta.description)spec.description=meta.description;
     if(isMap(meta.input_schema))spec.input_schema=meta.input_schema;
     if(['read','write','idempotent','external'].includes(meta.effect))spec.effect=meta.effect;
     if(typeof meta.approve==='boolean'||meta.approve==='after_untrusted')spec.approve=meta.approve;
    }catch(err){throw usage(`${path}: invalid @caveman-tool JSON header: ${err.message}`);}
    break;
   }
  }
  return spec;
 });
 const allTools=[...fields.tools,...codeTools];
 const allSubagents=[...subagents,...(fields.subagents??[])];
 let tier=fields.computer==='none'?'none':fields.computer==='code'?'code':'linux';
 if(tier==='none'&&codeTools.length)tier=codeTools.some(t=>t.runtime==='python')?'linux':'code';
 const manifest={
  schema:'caveman.agent.build.v1',name,
  ...(fields.description?{description:fields.description}:{}),
  loop:{kind:'managed',...(fields.engine?{engine:fields.engine}:{})},
  ...(fields.model?{model:fields.model}:{}),
  sandbox:{tier},
  ...(allTools.length?{tools:allTools}:{}),
  ...(skills.length?{skills}:{}),
  ...(allSubagents.length?{subagents:allSubagents}:{}),
  ...(evals.length?{evals}:{}),
  ...(fields.connectors?{connectors:fields.connectors}:{}),
  ...(fields.budgets?{budgets:fields.budgets}:{}),
  ...(fields.drives?{drives:fields.drives}:{}),
  ...(fields.output_schema?{output_schema:fields.output_schema}:{}),
  ...(fields.schedules?{schedules:fields.schedules}:{}),
  ...(fields.channels?{channels:fields.channels}:{}),
  files:files.map(({path,sha256,bytes})=>({path,sha256,bytes})),
  built_by:{name:'cvm',version},
 };
 const agentJSON=JSON.stringify(manifest,null,2)+'\n',manifestBytes=Buffer.byteLength(agentJSON);
 if(manifestBytes>LIMITS.agentFile)throw usage(`agent.json would be ${size(manifestBytes)}, over the ${size(LIMITS.agentFile)} it may be: the build lists too many files or too large a tool schema.`);
 if(total+manifestBytes>LIMITS.total)throw usage(`The build with agent.json is ${size(total+manifestBytes)}; the most a build may be is ${size(LIMITS.total)}.`);
 return {name,manifest,agentJSON,digest:sha256(agentJSON),files,excluded:listed.excluded,bytes:total+manifestBytes,count:files.length+1,source:source.label};
}

// The build as the agent routes take it: {path: text}, agent.json first.
export const buildFiles=b=>Object.fromEntries([['agent.json',b.agentJSON],...b.files.map(f=>[f.path,f.text])]);

// writeBuild writes exactly the build into dir, which must be new or empty.
export function writeBuild(b,dir){
 if(existsSync(dir)&&(!statSync(dir).isDirectory()||readdirSync(dir).length))throw usage(`--out ${dir} is not an empty folder; name a new or empty one.`);
 for(const [path,text] of Object.entries(buildFiles(b))){
  const at=join(dir,...path.split('/'));
  mkdirSync(dirname(at),{recursive:true});writeFileSync(at,text);
 }
}

// The lines a build prints on a terminal. A build that names connectors or
// mounts drives says how many.
const connectorCount=b=>{
 const n=Object.keys(b.manifest?.connectors??{}).length,d=Object.keys(b.manifest?.drives??{}).length;
 return (n?`, ${n} connector${n===1?'':'s'}`:'')+(d?`, ${d} drive mount${d===1?'':'s'}`:'');
};
export const summaryLine=b=>`${b.count} files, ${size(b.bytes)}${connectorCount(b)}  sha256 ${b.digest.slice(0,12)}`;
export function buildTable(b,out){
 const rows=[['agent.json',Buffer.byteLength(b.agentJSON)],...b.files.map(f=>[f.path,f.bytes])];
 const width=Math.max(...rows.map(([path])=>path.length));
 return [`agent    ${b.name}`,...rows.map(([path,n])=>`  ${path.padEnd(width)}  ${size(n)}`),`total    ${b.count} files, ${size(b.bytes)}${connectorCount(b)}`,`sha256   ${b.digest}`,
  ...(b.excluded.length?[`not in the build: ${b.excluded.join(', ')}`]:[]),...(out?[`wrote    ${out}`]:[])].join('\n')+'\n';
}
export const buildJSON=(b,out)=>({schema_version:1,ok:true,status:'built',agent:b.name,sha256:b.digest,file_count:b.count,bytes:b.bytes,
 files:[{path:'agent.json',bytes:Buffer.byteLength(b.agentJSON)},...b.files.map(f=>({path:f.path,bytes:f.bytes}))],excluded:b.excluded,out:out??null,manifest:b.manifest});

export const formatOf=(values,allowed=['json','table'])=>{
 const format=values.format??(process.stdout.isTTY?'table':'json');
 if(!allowed.includes(format))throw usage(`Format must be ${allowed.join(' or ')}.`);
 return format;
};
const buildUsage='cvm agent build [PATH] [--out DIR] [--format json|table]';

export async function agentBuild(argv){
 let format=process.stdout.isTTY?'table':'json';
 try{
  let values,positionals;
  try{({values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{out:{type:'string'},format:{type:'string'},help:{type:'boolean',short:'h'}}}));}
  catch(error){throw usage(`${error.message} Use ${buildUsage}.`);}
  format=formatOf(values);
  if(values.help){process.stdout.write(inertJSON({usage:buildUsage,summary:'Build an agent folder (AGENT.md, skills/, agents/, evals/) or one agent file into the agent build output: agent.json and the files it lists. Prints each file, the total and the digest. No network; --out writes the build folder, else nothing is written.'},format==='table'?2:undefined)+'\n');return 0;}
  if(positionals.length>1)throw usage(`Name one agent. Use ${buildUsage}.`);
  const b=build(locate(positionals[0]));
  if(values.out)writeBuild(b,resolve(values.out));
  process.stdout.write(format==='table'?buildTable(b,values.out):inertJSON(buildJSON(b,values.out))+'\n');
  return 0;
 }catch(error){
  const e=error instanceof CloudError?error:new CloudError('cave_failed',error.code==='EACCES'||error.code==='EPERM'?`Could not read or write a file: ${error.code}.`:'The build failed.',1);
  process.stdout.write(format==='table'?`failed  ${e.code}: ${e.message}\n`:inertJSON({schema_version:1,ok:false,status:'failed',error:{code:e.code,message:e.message}})+'\n');
  return e.exitCode;
 }
}
