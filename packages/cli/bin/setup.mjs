// `cvm setup`: installs cvm when it runs from a package
// runner's cache, signs in, picks the project, finds the coding agents,
// installs the Caveman Cloud skill and registers the `caveman-cloud` MCP server
// in each, then offers to start the agent. Each step shows on the terminal and
// on the console's onboarding screen (a wizard session). Not on a terminal it
// asks nothing and prints one JSON object.
import {existsSync,realpathSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {join,dirname,delimiter,sep} from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as pause} from 'node:timers/promises';
import {agents,detected,onPath,skillDirs,installSkill,skillCurrent,removeSkill,connect,disconnect,version,tilde,quoted,stableNode} from './agents.mjs';
import {capabilities,screen,confirm,clip,colors} from './tui.mjs';

// The wizard session's tasks, in order: the console renders these ids.
const TASKS=[['install','Install cvm'],['sign_in','Sign in'],['project','Project'],['agents','Agents'],['skills','Skills'],['mcp','MCP'],['ready','Ready']];
const PROMPT='Set up Caveman Cloud for this repository.';
const byId=Object.fromEntries(agents.map(a=>[a.id,a]));
const names=ids=>ids.map(id=>byId[id].name);
const listed=items=>items.length<2?items.join(''):`${items.slice(0,-1).join(', ')} and ${items.at(-1)}`;
const plain=text=>String(text??'').replace(/[\x00-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]/gu,' ');
const win=process.platform==='win32';
const quiet={c:colors({depth:0}),start(){},update(){},waiting(){},note(){},async end(){}};
const real=path=>{try{return realpathSync(path);}catch{}};

// What the onboarding screen shows of the repository, each only when git
// answers it in a form the server accepts.
function repository(){
 const git=(...args)=>{try{return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000}).trim();}catch{return '';}};
 const [,owner,name]=git('remote','get-url','origin').match(/([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)??[];
 const facts={repo_owner:owner,repo_name:name,default_branch:git('symbolic-ref','--short','refs/remotes/origin/HEAD').replace(/^origin\//,'')||git('branch','--show-current'),head_sha:git('rev-parse','HEAD')};
 const valid={repo_owner:/^[A-Za-z0-9._-]{1,100}$/,repo_name:/^[A-Za-z0-9._-]{1,100}$/,default_branch:/^(?!-)(?!.*\.\.)[^\s~^:?*[\\\x00-\x1f\x7f]{1,255}$/,head_sha:/^[0-9a-f]{7,64}$/};
 return Object.fromEntries(Object.entries(facts).filter(([key,value])=>value&&valid[key].test(value)));
}
const exec=(command,args)=>new Promise(resolve=>{
 let err='';const child=spawn(command,args,{stdio:['ignore','ignore','pipe'],shell:win});
 child.stderr.on('data',d=>err+=d);child.on('error',e=>resolve({code:1,err:e.message}));child.on('close',code=>resolve({code,err}));
});
// A cvm on PATH that is not a package runner's or a project's copy.
const globalCvm=()=>(process.env.PATH??'').split(delimiter).filter(dir=>dir&&!/[\\/](_npx|node_modules)([\\/]|$)/.test(dir)).map(dir=>join(dir,win?'cvm.cmd':'cvm')).find(existsSync);
const npmRoot=()=>{try{return execFileSync('npm',['root','-g'],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','ignore'],shell:win}).trim()||undefined;}catch{}};
// Semver order, prereleases included: is version a older than b? A version
// that does not parse is the oldest.
export function older(a,b){
 const parse=v=>/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v??'');
 const x=parse(a),y=parse(b);
 if(!x)return Boolean(y);if(!y)return false;
 for(let i=1;i<4;i++)if(Number(x[i])!==Number(y[i]))return Number(x[i])<Number(y[i]);
 if(!x[4]||!y[4])return Boolean(x[4])&&!y[4]; // a prerelease comes before its release
 const p=x[4].split('.'),q=y[4].split('.');
 for(let i=0;i<Math.max(p.length,q.length);i++){
  if(p[i]===q[i])continue;
  if(p[i]===undefined)return true;if(q[i]===undefined)return false;
  const n=/^\d+$/.test(p[i]),m=/^\d+$/.test(q[i]);
  return n&&m?Number(p[i])<Number(q[i]):n!==m?n:p[i]<q[i];
 }
 return false;
}

export async function setup(args,{client,context,login,call,cvm}){
 const {CloudError,CloudClient,inertJSON}=await client();
 const usage='Use cvm setup [--project UUID] [--agent claude,codex,cursor,vscode,windsurf,gemini,opencode] [--yes] [--no-launch] [--remove] [--format json|table].';
 let values;try{({values}=parseArgs({args,strict:true,options:{project:{type:'string'},agent:{type:'string'},remove:{type:'boolean'},format:{type:'string'},yes:{type:'boolean',short:'y'},'no-launch':{type:'boolean'}}}));}catch{throw new CloudError('cave_usage',usage,2);}
 const named=values.agent?.split(',').map(id=>id.trim()).filter(Boolean);
 if(values.format&&!['json','table'].includes(values.format)||named&&(!named.length||named.some(id=>!byId[id])))throw new CloudError('cave_usage',usage,2);
 const json=(values.format??(process.stdout.isTTY?'table':'json'))==='json';
 const say=lines=>process.stdout.write(lines.join('\n')+'\n');
 if(values.remove){
  const removed=Object.values(skillDirs).filter(dir=>{try{return removeSkill(dir);}catch{return false;}});
  const results=agents.map(a=>({agent:a.id,...disconnect(a)})).filter(r=>r.path);
  const gone=results.filter(r=>!r.error).map(({agent,path})=>({agent,path})),stuck=results.filter(r=>r.error).map(({agent,path,error})=>({agent,path,reason:error}));
  if(json)say([inertJSON({skill:{removed},mcp:{removed:gone,...stuck.length?{failed:stuck}:{}}})]);
  else say([...removed.map(dir=>`Removed ${tilde(dir)}`),...gone.map(r=>`Removed the caveman-cloud MCP server from ${byId[r.agent].name} (${tilde(r.path)})`),
   ...stuck.map(r=>`✗ Could not remove the caveman-cloud MCP server from ${byId[r.agent].name}: ${plain(r.reason)}`),...results.length||removed.length?[]:['Nothing cvm installed was found.'],'cvm logout signs you out.']);
  return stuck.length?1:0;
 }
 const k=capabilities();
 // A prompt needs a terminal at both ends; --yes and JSON take the defaults.
 const ask=!json&&k.animate&&Boolean(process.stdin.isTTY)&&!values.yes;
 const rows=TASKS.map(([id,label])=>({id,label,status:'pending',detail:''}));
 const ui=json?quiet:screen({rows,version,k}),c=ui.c;
 const changed=[];

 // The onboarding screen follows the session: the full task list on every
 // change and every 10 s while open. Best effort: a failed report fails nothing.
 let api,session,sessionClient,heartbeat,phase='planning',pending='',chain=Promise.resolve(),reported=false;
 const report=(extra={})=>{
  if(!session)return;
  const body={session_id:session,phase,tasks:rows.map(({id,label,status,detail})=>({id,label,status,detail})),pending_input:pending,...extra};
  chain=chain.then(()=>api.execute('wizard.update',body)).then(()=>{reported=true;},()=>{reported=false;});
 };
 const close=async(end,extra)=>{
  clearInterval(heartbeat);
  if(session){phase=end;pending='';report(extra);await Promise.race([chain,pause(5000,undefined,{ref:false})]);session=undefined;}
 };
 const step=(id,status,detail)=>{
  const row=rows.find(r=>r.id===id);row.status=status;if(detail!==undefined)row.detail=clip(plain(detail),240);
  ui.update();report();
 };
 // Ctrl-C: the cursor back, the session cancelled, and what changed said.
 let cancelling=false;
 const cancel=async()=>{
  if(cancelling)return;cancelling=true;
  process.stdin.setRawMode?.(false);
  await ui.end('ash');await close('cancelled');
  const rerun=`Run cvm setup again to finish${changed.length?', or cvm setup --remove to take it back':''}.`;
  say(json?[inertJSON({schema_version:1,ok:false,status:'failed',error:{code:'cave_cancelled',message:`Setup was cancelled. ${rerun}`},changed})]
   :['Cancelled.',...changed.length?changed.map(line=>`  changed: ${line}`):['  Nothing was changed.'],rerun]);
  process.exit(130);
 };
 process.on('SIGINT',cancel);
 const fail=async result=>{
  const {code,...body}=result,message=body.error?.message??'Setup failed.';
  for(const row of rows)if(row.status==='running')row.status='failed';
  await ui.end('ash');await close('failed',{error:clip(plain(message),500)});
  process.off('SIGINT',cancel);
  say([json?inertJSON(body):`${c.red('✗')} ${plain(message)}`]);
  return code||1;
 };
 ui.start();

 // 1. cvm itself. A copy in a package runner's cache (npx, pnpm dlx, bunx) or
 // in a project's node_modules installs globally once, so agents start an
 // installed cvm and no config points at a copy that goes away. A global cvm
 // as new or newer is used as it is.
 const pkg=`@caveman-ai/cloud@${version}`,modules=/[\\/]node_modules[\\/]/.test(cvm);
 const root=modules?npmRoot():undefined,globalRoot=root&&real(root);
 const temporary=modules&&!(globalRoot&&cvm.startsWith(globalRoot+sep));
 const installedAt=()=>{const path=root&&join(root,'@caveman-ai','cloud','bin','cvm.mjs');return path&&existsSync(path)?path:undefined;};
 let installed=temporary?undefined:cvm;
 step('install','running','');
 if(!temporary)step('install','done',globalCvm()?'cvm is on your PATH':`running ${tilde(cvm)}`);
 else{
  const found=globalCvm(),current=found&&(()=>{try{return execFileSync(quoted([found])[0],['--version'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','ignore'],shell:win}).trim();}catch{}})();
  if(current&&!older(current,version)){
   installed=installedAt()??(real(found)?.endsWith('cvm.mjs')?real(found):undefined);
   step('install','done',`cvm ${current} is on your PATH`);
  }else{
   const yes=!ask||await ui.confirm(`${current?`Update cvm ${current} to`:'Install cvm'} ${version} with npm i -g?`);
   if(yes===null)return cancel();
   if(!yes)step('install','done','skipped · the MCP server runs through npx');
   else{
    step('install','running',`npm i -g ${pkg}`);
    const result=await exec('npm',['i','-g',pkg]);
    installed=result.code===0?installedAt():undefined;
    if(installed)changed.push(`cvm ${version} installed (npm uninstall -g @caveman-ai/cloud removes it)`);
    step('install',installed?'done':'failed',installed?`cvm ${version} installed`:`npm i -g failed (${plain(result.err).match(/E[A-Z]{3,}/)?.[0]??`exit ${result.code}`}) · the MCP server runs through npx`);
   }
  }
 }
 // Apps do not inherit the shell's PATH: they get absolute paths. Windows
 // starts the .cmd shims (cvm, npx) only through a shell, which no agent uses,
 // so there every agent gets node and a script.
 const node=stableNode(),npxCli=join(dirname(process.execPath),'node_modules','npm','bin','npx-cli.js');
 const app=installed?[node,installed,'mcp']:win&&existsSync(npxCli)?[node,npxCli,'-y',pkg,'mcp']:['npx','-y',pkg,'mcp'];
 const shell=!win&&installed&&globalCvm()?['cvm','mcp']:app;

 // 2. A credential that answers, or a sign-in in the browser.
 step('sign_in','running','');
 let me=await call('auth','status');
 if(me.code===3&&!process.env.CAVE_TOKEN){
  step('sign_in','running','confirm the code in your browser');
  ui.waiting(true);
  try{
   await login([],{onCode:json?undefined:(code,link)=>{ui.bell();ui.note(()=>[`${c.dim('Code')}  ${c.accent(c.bold([...plain(code)].join(' ')))}`,`${c.dim('Open')}  ${plain(link)}`]);}});
  }catch(error){ui.note();return fail({code:error.exitCode??1,schema_version:1,ok:false,status:'failed',error:{code:error.code??'cave_failed',message:error.message}});}
  ui.note();ui.waiting(false);
  me=await call('auth','status');
 }
 if(me.code)return fail(me);
 // 3. The project, resolved as every cvm command resolves it, saved the way
 // `cvm context set` saves it.
 step('project','running','');
 const shown=await call('context','show',...(values.project?['--project',values.project]:[]));
 if(shown.code)return fail(shown);
 step('sign_in','done',`${me.data.user.email} · ${new URL(shown.endpoint).host}`);
 let project;
 if(shown.project_id){const got=await call('projects','get',shown.project_id);if(got.code)return fail(got);project=got.data;}
 else{
  const list=await call('projects','list');if(list.code)return fail(list);
  const projects=(list.data.data??[]).map(({id,name})=>({id,name}));
  if(projects.length===1)project=projects[0];
  else if(ask&&projects.length){
   let at=0;
   project=await ui.ask(width=>[c.bold('Which project?'),...projects.slice(Math.max(0,Math.min(at-3,projects.length-7)),Math.max(0,Math.min(at-3,projects.length-7))+7).map(p=>`${p===projects[at]?c.accent(ui.g.pointer):' '} ${clip(plain(p.name),Math.max(8,width-42))}  ${c.dim(p.id)}`)],(key,done)=>{
    if(['return','enter'].includes(key.name))done(projects[at]);
    else if(['up','k'].includes(key.name))at=(at-1+projects.length)%projects.length;
    else if(['down','j','tab'].includes(key.name))at=(at+1)%projects.length;
   },'↑↓ enter');
   if(!project)return cancel();
  }else{
   const message=`This sign-in reaches ${projects.length} projects: pass --project UUID.`;
   await ui.end('ash');process.off('SIGINT',cancel);
   say(json?[inertJSON({schema_version:1,ok:false,status:'failed',error:{code:'cave_project_required',message},projects})]:[message,...projects.map(p=>`  ${p.id}  ${plain(p.name)}`)]);
   return 2;
  }
 }
 const saved=await call('context','set',project.id);if(saved.code)return fail(saved);
 step('project','done',project.name);

 // The session starts once there is a project. Its client is the agent the
 // hand-off starts, else the first one connected; a pick that changes that
 // starts the session again (the server cancels the first).
 const found=detected(),launchable=id=>['claude','codex'].includes(id)&&onPath(id),handOff=list=>list.find(launchable)??list[0];
 const begin=async id=>{
  try{
   api??=new CloudClient({...await context(),projectId:project.id});
   session=(await api.execute('wizard.start',{client:id,...repository()})).data.id;sessionClient=id;
   clearInterval(heartbeat);heartbeat=setInterval(()=>report(),10000);heartbeat.unref();
  }catch{}
  report();
 };
 const preset=named??found;
 await begin(handOff(preset)??'codex');

 // 4. The agents: every one found, or the ones named.
 step('agents','running',names(preset).join(' · ')||'none found');
 let chosen=preset;
 if(ask&&!named){
  const items=agents.map(a=>({id:a.id,on:found.includes(a.id)}));let at=0;
  const pick=()=>items.filter(item=>item.on).map(item=>item.id);
  phase='awaiting_confirmation';pending='Which coding agents should Caveman Cloud connect to?';report();
  chosen=await ui.ask(width=>{
   const lines=[c.dim('space toggles · enter connects · esc cancels')];let line='',length=0;
   for(const [i,item] of items.entries()){
    const text=`${item.on?ui.g.on:ui.g.off} ${byId[item.id].name}${found.includes(item.id)?'':' (not found)'}`;
    if(length&&length+3+text.length>width){lines.push(line);line='';length=0;}
    line+=(length?'   ':' ')+(i===at?c.accent(text):found.includes(item.id)?text:c.dim(text));length+=(length?3:1)+text.length;
   }
   return [...lines,line];
  },(key,done)=>{
   if(['return','enter'].includes(key.name))return done(pick());
   if(key.name==='space')items[at].on=!items[at].on;
   else if(['up','left','k','h'].includes(key.name)||key.name==='tab'&&key.shift)at=(at-1+items.length)%items.length;
   else if(['down','right','j','l','tab'].includes(key.name))at=(at+1)%items.length;
   rows[3].detail=names(pick()).join(' · ')||'none';
  },'↑↓ space enter');
  if(!chosen)return cancel();
  phase='planning';pending='';
  if(session&&chosen.length&&handOff(chosen)!==sessionClient)await begin(handOff(chosen));
 }
 const none=chosen.length?undefined:found.length&&ask&&!named?'No agent chosen.':'No coding agent found on this machine.';
 step('agents',none?'blocked':'done',names(chosen).join(' · ')||none);

 // 5. The skill, into each agent's skill directory (a directory several read
 // is written once).
 phase='editing';
 const skill=new Map();
 if(!none){
  step('skills','running','');
  for(const dir of new Set(chosen.map(id=>byId[id].skill))){
   try{
    if(skillCurrent(dir)){skill.set(dir,{status:'unchanged'});continue;}
    const refused=installSkill(dir);
    skill.set(dir,refused?{status:'failed',reason:`left ${tilde(dir)} alone: ${refused}`}:{status:'changed'});
    if(!refused)changed.push(`skill in ${tilde(dir)}`);
   }catch(error){skill.set(dir,{status:'failed',reason:`${tilde(dir)}: ${error.message}`});}
  }
  step('skills',[...skill.values()].some(s=>s.status==='failed')?'failed':'done',[...skill.keys()].map(tilde).join(' · '));
 }else step('skills','blocked','no coding agent to install it for');

 // 6. The MCP server, in every chosen agent.
 const mcp=new Map();
 if(!none){
  step('mcp','running','');
  for(const id of chosen){
   const result=connect(byId[id],byId[id].gui?app:shell);mcp.set(id,result);
   if(result.status==='changed')changed.push(`MCP server in ${byId[id].name} (${tilde(byId[id].config)})`);
  }
  const counts=['changed','unchanged','failed'].map(s=>[s,[...mcp.values()].filter(r=>r.status===s).length]).filter(([,n])=>n);
  step('mcp',counts.some(([s])=>s==='failed')?'failed':'done',counts.map(([s,n])=>`${n} ${s}`).join(' · '));
 }else step('mcp','blocked','no coding agent to connect');

 // 7. Ready: every agent's outcome, the session closed, the hand-off.
 const results=chosen.map(id=>{
  const s=skill.get(byId[id].skill),m=mcp.get(id),reason=[s.reason,m.reason].filter(Boolean).join('; ');
  return {id,skill:s.status,mcp:m.status,...reason?{reason}:{}};
 });
 const problems=results.filter(r=>r.skill==='failed'||r.mcp==='failed');
 const ok=!none&&!problems.length,connected=results.filter(r=>r.mcp!=='failed').map(r=>byId[r.id].name);
 step('ready',ok?'done':'failed',ok?`connected to ${listed(connected)}`:none??`${problems.length} of ${chosen.length} agents need attention`);
 await close(ok?'completed':'failed',ok?{}:{error:clip(plain(none??`${byId[problems[0].id].name}: ${problems[0].reason}`),500)});
 await ui.end(ok?'flare':'ash');
 process.off('SIGINT',cancel);
 const target=handOff(chosen);
 const next=`Open ${target?byId[target].name:'your coding agent'} in your repository and ask: "${PROMPT}"`;
 if(json){
  const installedSkills=chosen.filter(id=>skill.get(byId[id].skill).status!=='failed').map(id=>({agent:id,path:byId[id].skill}));
  const refused=[...skill].filter(([,s])=>s.status==='failed').map(([path,s])=>({path,reason:s.reason.replace(/^left \S+ alone: /,'')}));
  say([inertJSON({ok,signed_in:true,api:shown.endpoint,project:{id:project.id,name:project.name},skill:{version,installed:installedSkills,refused},agents:results,onboarding_reported:reported,next})]);
  return ok?0:1;
 }
 const lines=[''];
 if(connected.length)lines.push(`${c.green('✓')} Caveman Cloud is connected to ${listed(connected)}.`);
 for(const r of results){
  if(r.reason&&!problems.includes(r))lines.push(`  ${byId[r.id].name}: ${r.reason}.`);
  if(!problems.includes(r))continue;
  lines.push(`${c.red('✗')} ${byId[r.id].name}: ${r.reason}${mcp.get(r.id).snippet?':':'.'}`);
  if(r.mcp==='failed'&&mcp.get(r.id).snippet)lines.push(...mcp.get(r.id).snippet.split('\n').map(line=>`    ${line}`));
 }
 if(none)lines.push(`${c.yellow('!')} ${none} ${found.length?'Run cvm setup again to choose one.':'Install one (Claude Code, Codex, Cursor, …), then run cvm setup again.'}`);
 if(connected.length)lines.push('','Ask your agent:',c.bold(PROMPT));
 say(lines);
 // The hand-off: one key starts the agent with the task.
 if(ask&&!values['no-launch']&&target&&launchable(target)&&connected.includes(byId[target].name)){
  say(['']);
  if(await confirm(`Start ${byId[target].name} here now?`,{k})){
   const ignore=()=>{};process.on('SIGINT',ignore); // Ctrl-C belongs to the agent now
   const code=await new Promise(resolve=>spawn(target,quoted([PROMPT]),{stdio:'inherit',shell:win}).on('error',()=>resolve(1)).on('close',resolve));
   process.off('SIGINT',ignore);
   return code??0;
  }
 }
 return ok?0:1;
}
