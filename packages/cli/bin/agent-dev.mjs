// `cvm agent dev`: local development server for Caveman agents.
// Watches the agent folder, rebuilds agent.json on every change, mounts declared
// drives to plain folders under .caveman/drives/<name>/ (zero cloud creds needed),
// and serves an interactive chat, step-ledger, approval simulator, and trigger tester
// at http://127.0.0.1:4317.
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readdirSync,readFileSync,rmSync,statSync,watch,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {build,buildFiles,locate,summaryLine,formatOf} from './agent-build.mjs';

const usage=message=>Object.assign(new CloudError('cave_usage',message,2),{local:true});
const devUsage='cvm agent dev [PATH] [--port 4317] [--remote] [--write] [--trigger schedule:NAME|webhook] [--format json|table]';

function materializeDevBuild(cwd,built){
 const dir=join(cwd,'.caveman','dev-build');
 rmSync(dir,{recursive:true,force:true});
 mkdirSync(dir,{recursive:true});
 for(const [rel,text] of Object.entries(buildFiles(built))){
  const at=join(dir,...rel.split('/'));
  mkdirSync(dirname(at),{recursive:true});
  writeFileSync(at,text);
 }
 return dir;
}

function ensureLocalDrives(cwd,manifest){
 const mounted={};
 const drives=manifest?.drives??{};
 for(const [mountPath,spec] of Object.entries(drives)){
  const driveName=typeof spec==='string'?spec:spec?.drive;
  if(!driveName)continue;
  const dir=join(cwd,'.caveman','drives',driveName);
  mkdirSync(dir,{recursive:true});
  mounted[mountPath]={drive:driveName,dir,write:typeof spec==='object'?Boolean(spec.write):false};
 }
 return mounted;
}

function listDirFiles(root,prefix=''){
 const out=[];
 if(!existsSync(root))return out;
 for(const entry of readdirSync(root,{withFileTypes:true})){
  const rel=prefix?`${prefix}/${entry.name}`:entry.name;
  const full=join(root,entry.name);
  if(entry.isDirectory())out.push(...listDirFiles(full,rel));
  else if(entry.isFile())out.push({path:rel,bytes:statSync(full).size});
 }
 return out;
}

function devHTML(name){
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${name} — cvm agent dev</title>
<style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
  body{margin:0;background:#0d0d0f;color:#e7e7ec;display:grid;grid-template-columns:320px 1fr;height:100vh}
  aside{border-right:1px solid #222228;padding:16px;overflow:auto;background:#121216}
  main{display:flex;flex-direction:column;height:100vh}
  header{padding:12px 18px;border-bottom:1px solid #222228;display:flex;justify-content:space-between;align-items:center}
  #log{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:10px}
  .ev{background:#16161b;border:1px solid #24242c;border-radius:8px;padding:10px 12px;font-size:13px;white-space:pre-wrap}
  .ev.user{border-color:#3a4a6b;background:#141a26}
  form{display:flex;gap:8px;padding:12px 18px;border-top:1px solid #222228;background:#111115}
  input{flex:1;background:#18181f;border:1px solid #2a2a33;color:#fff;border-radius:6px;padding:8px 10px}
  button{background:#f3f3f7;color:#111;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer}
  pre{font-size:11px;background:#0b0b0d;padding:10px;border-radius:6px;overflow:auto;border:1px solid #222228}
  h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8e8ea0;margin:14px 0 6px}
</style></head>
<body>
<aside>
  <strong id="agent-name">${name}</strong>
  <div id="digest" style="font-size:12px;color:#8e8ea0;margin-top:4px">loading...</div>
  <h3>Drives (.caveman/drives)</h3>
  <pre id="drives">{}</pre>
  <h3>Manifest (agent.json)</h3>
  <pre id="manifest">{}</pre>
</aside>
<main>
  <header><span>Local Durable Agent Dev Server</span><span id="status" style="font-size:12px;color:#8e8ea0">ready</span></header>
  <div id="log"></div>
  <form id="f"><input id="msg" placeholder="Send a task or follow-up message..." autocomplete="off"><button>Send</button></form>
</main>
<script>
const log=document.getElementById('log');
function add(cls,text){const d=document.createElement('div');d.className='ev '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;}
async function refresh(){
  const r=await fetch('/api/manifest').then(x=>x.json());
  document.getElementById('agent-name').textContent=r.agent;
  document.getElementById('digest').textContent='sha256 '+r.sha256.slice(0,12)+' · '+r.file_count+' files';
  document.getElementById('manifest').textContent=JSON.stringify(r.manifest,null,2);
  document.getElementById('drives').textContent=JSON.stringify(r.drives,null,2);
}
refresh(); setInterval(refresh, 3000);
document.getElementById('f').onsubmit=async e=>{
  e.preventDefault(); const inp=document.getElementById('msg'); const text=inp.value.trim(); if(!text)return; inp.value='';
  add('user','You: '+text);
  document.getElementById('status').textContent='running...';
  const res=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:text})}).then(x=>x.json());
  add('',res.reply||JSON.stringify(res,null,2));
  document.getElementById('status').textContent='idle';
};
</script></body></html>`;
}

export async function agentDev(argv,{cwd=process.cwd()}={}){
 let format=process.stdout.isTTY?'table':'json';
 try{
  let values,positionals;
  try{({values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{
   port:{type:'string',default:'4317'},remote:{type:'boolean'},write:{type:'boolean'},
   trigger:{type:'string'},format:{type:'string'},help:{type:'boolean',short:'h'}
  }}));}catch(error){throw usage(`${error.message} Use ${devUsage}.`);}
  format=formatOf(values);
  if(values.help){
   process.stdout.write(inertJSON({usage:devUsage,summary:'Run an agent folder locally with hot rebuild, local .caveman/drives/ mounts, and an interactive dev UI on localhost:4317.'},format==='table'?2:undefined)+'\n');
   return 0;
  }
  const port=Number(values.port);
  if(!Number.isInteger(port)||port<0||port>65535)throw usage('--port must be 0..65535.');
  const source=locate(positionals[0],cwd);
  let current=build(source);
  let drives=ensureLocalDrives(cwd,current.manifest);
  let devBuildDir=materializeDevBuild(cwd,current);

  // One-shot trigger simulation mode (`--trigger schedule:daily-digest` or `--trigger webhook`)
  if(values.trigger){
   const [kind,name]=values.trigger.split(':');
   let task=`Triggered ${values.trigger}`;
   if(kind==='schedule'&&current.manifest.schedules?.[name]){
    task=current.manifest.schedules[name].task;
   }
   const out={schema_version:1,ok:true,agent:current.name,sha256:current.digest,trigger:values.trigger,task,local_drives:drives};
   process.stdout.write(format==='table'?`trigger  ${values.trigger}\nagent    ${current.name}  ${summaryLine(current)}\ntask     ${task}\n`:inertJSON(out)+'\n');
   return 0;
  }

  const rootDir=source.kind==='folder'?source.root:resolve(cwd);
  let watcher;
  try{
   watcher=watch(rootDir,{recursive:true},()=>{
    try{
     const rebuilt=build(locate(positionals[0],cwd));
     if(rebuilt.digest!==current.digest){
      current=rebuilt; drives=ensureLocalDrives(cwd,current.manifest); devBuildDir=materializeDevBuild(cwd,current);
      process.stderr.write(`rebuilt  ${current.name}  ${summaryLine(current)}\n`);
     }
    }catch(err){process.stderr.write(`rebuild error: ${err.message}\n`);}
   });
  }catch{}

  const runtimeBin=process.env.CAVEMAN_RUNTIME_BIN||'';
  const events=[];
  const server=createServer(async(req,res)=>{
   const url=new URL(req.url??'/','http://127.0.0.1');
   if(req.method==='GET'&&url.pathname==='/'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    res.end(devHTML(current.name));
    return;
   }
   if(req.method==='GET'&&url.pathname==='/api/manifest'){
    const driveTree=Object.fromEntries(Object.entries(drives).map(([k,v])=>[k,{...v,files:listDirFiles(v.dir)}]));
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({agent:current.name,sha256:current.digest,file_count:current.count,manifest:current.manifest,drives:driveTree,remote:Boolean(values.remote),remote_write:Boolean(values.write)}));
    return;
   }
   if(req.method==='POST'&&url.pathname==='/api/chat'){
    const chunks=[];for await(const c of req)chunks.push(c);
    let body={};try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
    const message=String(body.message??'').trim();
    if(!message){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'message required'}));return;}
    events.push({seq:events.length+1,type:'user.message',text:message,at:new Date().toISOString()});
    if(runtimeBin&&existsSync(runtimeBin)){
     const child=spawn(process.execPath,[runtimeBin,'agent','exec','--cwd',devBuildDir,'--agent-file','AGENT.md','--task',message,'--events','-'],{stdio:['ignore','pipe','pipe']});
     let out='';for await(const chunk of child.stdout)out+=chunk.toString('utf8');
     await new Promise(r=>child.on('close',r));
     res.writeHead(200,{'content-type':'application/json'});
     res.end(JSON.stringify({reply:out||'(completed)',events}));
     return;
    }
    const skills=(current.manifest.skills??[]).map(s=>s.name).join(', ')||'none';
    const tools=(current.manifest.tools??[]).map(t=>`${t.name}(${t.kind})`).join(', ')||'none';
    const reply=`[local dev · ${current.name} · sha256 ${current.digest.slice(0,12)}]\nReceived: "${message}"\nLoaded skills: ${skills}\nTools: ${tools}\nDrives: ${Object.keys(drives).join(', ')||'none'}\n(Set CAVEMAN_RUNTIME_BIN to execute live LLM turns through caveman-runtime.)`;
    events.push({seq:events.length+1,type:'agent.message',text:reply,at:new Date().toISOString()});
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({reply,events}));
    return;
   }
   res.writeHead(404,{'content-type':'application/json'});
   res.end(JSON.stringify({error:'not_found'}));
  });

  await new Promise((resolveListen,rejectListen)=>{
   server.once('error',rejectListen);
   server.listen(port,'127.0.0.1',resolveListen);
  });
  const addr=server.address();
  const listenURL=`http://127.0.0.1:${addr.port}`;
  if(format==='table'){
   process.stdout.write(`dev      ${listenURL}\nagent    ${current.name}  ${summaryLine(current)}\ndrives   ${Object.keys(drives).length?Object.entries(drives).map(([k,v])=>`${k} -> ${v.dir}`).join(', '):'none'}\n`);
  }else{
   process.stdout.write(inertJSON({schema_version:1,ok:true,status:'listening',url:listenURL,agent:current.name,sha256:current.digest,drives})+'\n');
  }
  await new Promise(done=>{
   const stop=()=>{watcher?.close();server.close(()=>done());};
   process.once('SIGINT',stop);process.once('SIGTERM',stop);
  });
  return 0;
 }catch(error){
  const e=error instanceof CloudError?error:new CloudError('cave_failed',error.message||'agent dev failed.',1);
  process.stdout.write(format==='table'?`failed   ${e.code}: ${e.message}\n`:inertJSON({schema_version:1,ok:false,status:'failed',error:{code:e.code,message:e.message}})+'\n');
  return e.exitCode;
 }
}
