// The coding agents `cvm setup` connects: where each keeps its skills and its
// MCP servers, and the edits that add or take back the Caveman Cloud ones.
// Every path here is the agent's documented user-level location.
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,realpathSync,cpSync,rmSync,readdirSync,statSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {homedir,tmpdir} from 'node:os';
import {join,dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';

export const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
export const NAME='caveman-cloud';
const home=homedir(),env=process.env,win=process.platform==='win32';
const xdg=env.XDG_CONFIG_HOME||join(home,'.config'),appData=env.APPDATA||join(home,'AppData','Roaming');
const claudeDir=env.CLAUDE_CONFIG_DIR||join(home,'.claude'),codexDir=env.CODEX_HOME||join(home,'.codex');
export const onPath=name=>(env.PATH??'').split(delimiter).find(dir=>dir&&['',...(win?['.cmd','.exe']:[])].some(ext=>existsSync(join(dir,name+ext))));

// The Caveman Cloud skill, built from public/skills into this package. Claude
// Code reads its own skills directory; every other agent here reads the open
// Agent Skills one.
export const skillDirs={claude:join(claudeDir,'skills',NAME),agents:join(home,'.agents','skills',NAME)};
export const marker='.cvm-version';
const bundle=fileURLToPath(new URL('../dist/skills/caveman-cloud',import.meta.url));
// One cvm at a time changes a skills directory, and first clears what an
// interrupted one left. A lock over a minute old is a crashed cvm's (two cvms
// taking over the same stale lock at one moment can both go ahead).
export function locked(dir,work){
 const parent=dirname(dir),lock=join(parent,'.caveman-cloud.lock'),busy='another cvm is installing it';
 try{mkdirSync(lock);}catch(error){
  if(error.code!=='EEXIST')throw error;
  if(Date.now()-statSync(lock).mtimeMs<60000)return busy;
  rmSync(lock,{recursive:true,force:true});
  try{mkdirSync(lock);}catch{return busy;}
 }
 try{
  for(const name of readdirSync(parent))if(name.startsWith('.caveman-cloud-'))rmSync(join(parent,name),{recursive:true,force:true});
  return work();
 }finally{rmSync(lock,{recursive:true,force:true});}
}
// Only a directory cvm wrote (its marker says so) is replaced, by renames: an
// agent reading it finds the old skill or the new one, never half of either.
export function installSkill(dir){
 mkdirSync(dirname(dir),{recursive:true});
 return locked(dir,()=>{
  if(existsSync(dir)&&!existsSync(join(dir,marker)))return 'it holds a caveman-cloud skill cvm did not install';
  const next=join(dirname(dir),`.caveman-cloud-${randomUUID()}`),old=next+'-old';
  try{
   cpSync(bundle,next,{recursive:true});writeFileSync(join(next,marker),version);
   if(existsSync(dir))renameSync(dir,old);
   renameSync(next,dir);
  }catch(error){
   rmSync(next,{recursive:true,force:true});
   if(!existsSync(dir)&&existsSync(old))renameSync(old,dir);
   throw error;
  }
  rmSync(old,{recursive:true,force:true});
 });
}
// The installed skill is this version's bundle, file for file.
export function skillCurrent(dir){
 const same=(a,b)=>readdirSync(a,{withFileTypes:true}).every(e=>e.isDirectory()?same(join(a,e.name),join(b,e.name)):readFileSync(join(a,e.name)).equals(readFileSync(join(b,e.name))));
 try{return readFileSync(join(dir,marker),'utf8')===version&&same(bundle,dir);}catch{return false;}
}
export const removeSkill=dir=>existsSync(dirname(dir))&&locked(dir,()=>existsSync(join(dir,marker))&&(rmSync(dir,{recursive:true,force:true}),true))===true;

// A JSON config: the servers live under one key; an edit inserts or cuts text
// and never re-serializes the file, so comments-free formatting, key order and
// every other server stay byte for byte.
function jsonFormat(key,entry){
 return {
  entry,
  read(text){const parsed=text.trim()?JSON.parse(text):{};if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed[key]!==undefined&&(typeof parsed[key]!=='object'||!parsed[key]||Array.isArray(parsed[key])))throw new Error('unexpected shape');return parsed[key]?.[NAME];},
  insert(text,value){
   if(!text.trim())return [0,JSON.stringify({[key]:{[NAME]:value}},null,2)+'\n'];
   const top=members(text,text.indexOf('{')),unit=top.list.length&&top.multiline?top.indent:'  ',box=top.list.find(m=>m.key===key);
   return box?into(text,members(text,box.valueStart),NAME,value,unit):into(text,top,key,{[NAME]:value},unit);
  },
  cut(text){
   const box=members(text,text.indexOf('{')).list.find(m=>m.key===key);if(!box)return text;
   const inner=members(text,box.valueStart),i=inner.list.findIndex(m=>m.key===NAME);if(i<0)return text;
   if(inner.list.length===1)return text.slice(0,box.valueStart+1)+text.slice(inner.close);
   return i?text.slice(0,inner.list[i-1].end)+text.slice(inner.list[i].end):text.slice(0,inner.list[0].start)+text.slice(inner.list[1].start);
  },
  snippet:value=>JSON.stringify({[key]:{[NAME]:value}},null,2),
 };
}
// An object's members in valid JSON text, from the index of its '{'.
function members(text,at){
 let i=at+1;const list=[];
 const ws=()=>{while(/\s/.test(text[i]))i++;};
 const string=()=>{const start=i++;while(i<text.length&&text[i]!=='"')i+=text[i]==='\\'?2:1;return JSON.parse(text.slice(start,++i));};
 const value=()=>{
  if(text[i]==='"')return string();
  if(text[i]!=='{'&&text[i]!=='['){while(i<text.length&&!/[\s,}\]]/.test(text[i]))i++;return;}
  let depth=0;
  do{if(text[i]==='"'){string();continue;}if('{['.includes(text[i]))depth++;else if('}]'.includes(text[i]))depth--;i++;}while(depth&&i<text.length);
 };
 for(;;){
  ws();if(text[i]===',')i++,ws();
  if(text[i]==='}'||i>=text.length)break;
  const start=i,key=string();ws();i++;ws();const valueStart=i;value();list.push({key,start,valueStart,end:i});
 }
 const first=list[0]?.start??i,lead=text.slice(at+1,first);
 return {list,open:at,close:i,multiline:lead.includes('\n'),indent:lead.slice(lead.lastIndexOf('\n')+1)};
}
// Where and what to insert so `name: value` becomes the object's last member,
// in the object's own layout.
function into(text,box,name,value,unit){
 const last=box.list.at(-1);
 if(last&&!box.multiline)return [last.end,`, ${JSON.stringify(name)}: ${JSON.stringify(value)}`];
 const member=indent=>`${JSON.stringify(name)}: ${JSON.stringify(value,null,unit).replaceAll('\n','\n'+indent)}`;
 if(last)return [last.end,`,\n${box.indent}${member(box.indent)}`];
 const line=text.slice(text.lastIndexOf('\n',box.open)+1).match(/^[ \t]*/)[0];
 return [box.open+1,`\n${line+unit}${member(line+unit)}\n${line}`];
}
// Codex's config.toml: the server is its table and any sub-tables under it
// ([mcp_servers.caveman-cloud.env]). cvm appends one table and cuts them all.
const own=`mcp_servers.${NAME}`;
function tomlTables(text){
 const heads=[...text.matchAll(/^[ \t]*\[\[?([^\]\n]+)\]\]?[ \t]*(?:#.*)?$/gm)];
 return heads.map((m,i)=>({name:m[1].replace(/["'\s]/g,''),start:m.index,body:m.index+m[0].length,end:heads[i+1]?.index??text.length}));
}
const toml={
 entry:command=>({command:command[0],args:command.slice(1)}),
 read(text){
  const main=tomlTables(text).find(t=>t.name===own);
  if(!main){if(/mcp_servers[ \t]*\.[ \t]*["']?caveman-cloud\b|^[ \t]*["']?caveman-cloud["']?[ \t]*=/m.test(text))throw new Error('unexpected shape');return;}
  const body=text.slice(main.body,main.end);
  const field=name=>{const raw=body.match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.+)$`,'m'))?.[1];if(raw===undefined)return;try{return JSON.parse(raw);}catch{return JSON.parse(raw.replace(/\s+#.*$/,''));}};
  return {command:field('command'),args:field('args')??[]};
 },
 insert(text,value){
  const table=`[${own}]\ncommand = ${JSON.stringify(value.command)}\nargs = ${JSON.stringify(value.args)}\n`;
  return [text.length,(text&&!text.endsWith('\n')?'\n':'')+(text.trim()?'\n':'')+table];
 },
 cut(text){
  for(const t of tomlTables(text).filter(t=>t.name===own||t.name.startsWith(own+'.')).reverse()){
   // A table that ran to the end takes the blank line before it along.
   const start=t.end>=text.length&&text[t.start-1]==='\n'&&text[t.start-2]==='\n'?t.start-1:t.start;
   text=text.slice(0,start)+text.slice(t.end);
  }
  return text;
 },
 snippet:value=>toml.insert('',value)[1].trimEnd(),
};

const stdio=command=>({command:command[0],args:command.slice(1)});
const devin=win?join(appData,'devin'):join(xdg,'devin'),windsurf=join(home,'.codeium','windsurf');
const vscode=process.platform==='darwin'?join(home,'Library','Application Support','Code','User'):win?join(appData,'Code','User'):join(xdg,'Code','User');
const opencode=join(xdg,'opencode');
// gui: the agent is an app that does not inherit the shell's PATH, so its
// server runs by absolute paths.
export const agents=[
 {id:'claude',name:'Claude Code',bin:'claude',dirs:[claudeDir],skill:skillDirs.claude,config:join(env.CLAUDE_CONFIG_DIR||home,'.claude.json'),format:jsonFormat('mcpServers',command=>({type:'stdio',...stdio(command),env:{}}))},
 {id:'codex',name:'Codex',bin:'codex',dirs:[codexDir],skill:skillDirs.agents,config:join(codexDir,'config.toml'),format:toml},
 {id:'cursor',name:'Cursor',gui:true,dirs:[join(home,'.cursor')],skill:skillDirs.agents,config:join(home,'.cursor','mcp.json'),format:jsonFormat('mcpServers',command=>({type:'stdio',...stdio(command)}))},
 {id:'vscode',name:'VS Code',gui:true,dirs:[vscode],skill:skillDirs.agents,config:join(vscode,'mcp.json'),format:jsonFormat('servers',command=>({type:'stdio',...stdio(command)}))},
 // Windsurf is now Devin Desktop: its config moved to ~/.config/devin, and an
 // older install still reads ~/.codeium/windsurf.
 {id:'windsurf',name:'Windsurf',gui:true,dirs:[devin,windsurf],skill:skillDirs.agents,config:join(existsSync(devin)?devin:windsurf,'mcp_config.json'),format:jsonFormat('mcpServers',stdio)},
 {id:'gemini',name:'Gemini CLI',bin:'gemini',dirs:[join(home,'.gemini')],skill:skillDirs.agents,config:join(home,'.gemini','settings.json'),format:jsonFormat('mcpServers',stdio)},
 {id:'opencode',name:'OpenCode',bin:'opencode',dirs:[opencode],skill:skillDirs.agents,config:join(opencode,existsSync(join(opencode,'opencode.json'))||!existsSync(join(opencode,'opencode.jsonc'))?'opencode.json':'opencode.jsonc'),format:jsonFormat('mcp',command=>({type:'local',command,enabled:true}))},
];
// The node an app should start: the PATH's own `node` (Homebrew's
// /opt/homebrew/bin/node) when it is this one, because the versioned path
// process.execPath resolves to is gone after the next upgrade. A per-shell
// link (fnm's multishells, anything under the temp dir) is gone sooner.
export function stableNode(){
 const dir=onPath('node');if(!dir)return process.execPath;
 const path=join(dir,win?'node.exe':'node');
 try{
  const temp=realpathSync(tmpdir());
  if(realpathSync(path)!==realpathSync(process.execPath)||/multishell/i.test(path)||realpathSync(dir).startsWith(temp))return process.execPath;
  return path;
 }catch{return process.execPath;}
}
export const detected=()=>agents.filter(a=>a.bin&&onPath(a.bin)||a.dirs.some(dir=>existsSync(dir))).map(a=>a.id);

// An entry is cvm's when it runs `cvm mcp`; caveman v4's `caveman cloud
// mcp-serve` entry of the same name is replaced; anything else is someone else's.
const words=entry=>[entry?.command,entry?.args].flat(2).filter(word=>typeof word==='string');
const owner=entry=>{
 const w=words(entry);
 if(w.includes('mcp')&&w.some(word=>/(^|[\\/])cvm(\.mjs|\.cmd|\.exe)?$/.test(word)||/^@caveman-ai\/cloud(@|$)/.test(word)))return 'cvm';
 if(w.includes('cloud')&&w.includes('mcp-serve'))return 'v4';
};
const same=(a,b)=>JSON.stringify(words(a))===JSON.stringify(words(b));

// What cvm inserted into each config, so --remove takes back exactly that.
const statePath=join(env.CAVEMAN_HOME??join(home,'.caveman'),'cvm-setup.json');
function state(next){
 let all={};try{all=JSON.parse(readFileSync(statePath,'utf8'));}catch{}
 if(!next)return all;
 const merged={...all,...next};for(const key of Object.keys(merged))if(!merged[key])delete merged[key];
 mkdirSync(dirname(statePath),{recursive:true,mode:0o700});
 const tmp=`${statePath}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(merged,null,2)+'\n',{mode:0o600});renameSync(tmp,statePath);
}
const readText=path=>{try{return readFileSync(path,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
function writeText(path,text){
 if(existsSync(path))path=realpathSync(path); // a symlinked config stays a symlink
 let mode=0o600;try{mode=statSync(path).mode&0o777;}catch{}
 mkdirSync(dirname(path),{recursive:true});
 const tmp=`${path}.${randomUUID()}.tmp`;writeFileSync(tmp,text,{mode,flag:'wx'});renameSync(tmp,path);
}
// Windows runs the agents' .cmd shims through a shell, which splits on spaces.
export const quoted=args=>win?args.map(arg=>/[\s"]/.test(arg)?`"${arg.replaceAll('"','""')}"`:arg):args;
const run=(bin,args)=>execFileSync(bin,quoted(args),{stdio:['ignore','pipe','pipe'],timeout:20000,shell:win});

const why=error=>String(error.stderr||error.message).trim().split('\n')[0].slice(0,160);
// The config without cvm's entry. The exact text cvm inserted comes out only
// when what is left parses, holds no entry, and a fresh insert would turn it
// back into this file: then the result is byte for byte the original. Any
// other edit since (a server pasted beside it) gets the entry cut out alone.
function without(format,text,before,existing){
 if(before&&text.split(before.inserted).length===2){
  const base=text.replace(before.inserted,'');
  try{if(format.read(base)===undefined){const [at,again]=format.insert(base,existing);if(base.slice(0,at)+again+base.slice(at)===text)return base;}}catch{}
 }
 return format.cut(text);
}
// Adds the server to one agent: changed, unchanged or failed (with a reason,
// and the snippet to add by hand when the file is not cvm's to edit). Nothing
// is written that does not parse back with the entry in it.
export function connect(agent,command){
 const {format,config}=agent,wanted=format.entry(command),snippet=format.snippet(wanted);
 let text,existing;
 try{text=readText(config);existing=format.read(text??'');}
 catch{return {status:'failed',reason:`${tilde(config)} is not plain ${format===toml?'TOML cvm can read':'JSON'}; add the server yourself`,snippet};}
 const who=existing&&owner(existing);
 if(existing&&!who)return {status:'failed',reason:`${tilde(config)} already has a caveman-cloud server cvm did not add; left it alone`,snippet};
 if(existing&&who==='cvm'&&same(existing,wanted))return {status:'unchanged'};
 const replaced=who==='v4'?'replaced the caveman v4 entry':undefined;
 try{
  // Claude Code rewrites ~/.claude.json while it runs: its own CLI makes the change.
  if(agent.id==='claude'&&onPath('claude')){
   if(existing)run('claude',['mcp','remove',NAME,'--scope','user']);
   run('claude',['mcp','add','--scope','user',NAME,'--',...command]);
   return {status:'changed',reason:replaced};
  }
  const before=state()[config];
  // A re-run first takes back its own earlier insert, so --remove can still
  // restore the original.
  const base=existing?without(format,text,before,existing):text??'';
  const [at,inserted]=format.insert(base,wanted),next=base.slice(0,at)+inserted+base.slice(at);
  let fits=false;try{fits=same(format.read(next),wanted);}catch{}
  if(!fits)throw new Error('cvm could not insert its entry cleanly; nothing was written');
  writeText(config,next);
  if(!same(format.read(readText(config)),wanted))throw new Error('the server did not read back');
  state({[config]:{inserted,created:text===null||Boolean(before?.created)}});
  return {status:'changed',reason:replaced};
 }catch(error){return {status:'failed',reason:`${tilde(config)}: ${why(error)}`,snippet};}
}
// Takes the server back out when it is cvm's. Returns {path} when it was
// removed, {path,error} when it could not be, nothing when there was none.
export function disconnect(agent){
 const {format,config}=agent;
 let text,existing;try{text=readText(config);existing=text===null?undefined:format.read(text);}catch{return;}
 if(owner(existing)!=='cvm')return;
 try{
  if(agent.id==='claude'&&onPath('claude')){run('claude',['mcp','remove',NAME,'--scope','user']);return {path:config};}
  const before=state()[config],next=without(format,text,before,existing);
  if(format.read(next)!==undefined)throw new Error('the entry did not come out cleanly; nothing was written');
  if(before?.created&&!next.trim())unlinkSync(config);else writeText(config,next);
  state({[config]:undefined});
  return {path:config};
 }catch(error){return {path:config,error:why(error)};}
}
export const tilde=path=>path===home||path.startsWith(home+(win?'\\':'/'))?'~'+path.slice(home.length):path;
