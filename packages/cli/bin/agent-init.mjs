// `cvm agent init`: an agent folder written from a template cvm ships, and the
// commands that deploy it. No network, no sign-in: it reads only where cvm is
// pointed (CAVE_API_URL or the saved login's address), to print the connect
// line that fits that installation.
//
// Templates live in templates/<name>/ beside bin/. Ask Caveman (ask) is the
// first: an agent with no computer that answers questions about the
// organization's own Cloud data through the `caveman` connector, Caveman's own
// MCP server, signed in once for the team.
import {existsSync,mkdirSync,readdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join,posix,relative,resolve,sep} from 'node:path';
import {parseArgs} from 'node:util';
import {CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {build,locate,summaryLine,formatOf} from './agent-build.mjs';

const usage=message=>Object.assign(new CloudError('cave_usage',message,2),{local:true});
const initUsage='cvm agent init TEMPLATE [DIR] [--format json|table]';
const templatesRoot=new URL('../templates/',import.meta.url);

// What each template is and what it needs after the deploy. connector names the
// connector its build uses; hosted is the console origin of Caveman's hosted
// Cloud, whose catalog template carries that name.
export const TEMPLATES={
 ask:{summary:'Ask Caveman: answers questions about your agents from your own Caveman Cloud data (traces, spend, evals, reports), reading only, with no computer.',
  connector:'caveman',task:'Which agent spent the most in the last 7 days, and on what?'},
 'support-slack':{summary:'Durable Slack support agent with a knowledge-base Drive, refunds skill, and taint-aware approval escalation.',
  connector:'linear',task:'A customer asked for a $750 refund on invoice #4021 — check policy and draft next steps.'},
 'pr-reviewer':{summary:'GitHub PR reviewer with a nested security subagent and typed JSON output_schema.',
  task:'Review the latest pull request diff and return your structured verdict.'},
 'researcher-drive':{summary:'Weekday-scheduled researcher writing review-gated changesets to a shared Drive.',
  task:'Compile today\'s digest into /reports/daily.md.'},
 'ts-tools':{summary:'QuickJS code-tier agent with a deterministic prorate_refund tool.',
  task:'Calculate the exact prorated refund for a $300 monthly invoice used for 10 of 30 days.'},
};
// The hosts of Caveman's hosted Cloud: there, the catalog's caveman template is
// this installation's own MCP server. Anywhere else the connector is added by
// the console's address.
const HOSTED=['api.caveman.so','app.caveman.so'];
const hostedInstance=instance=>{try{return HOSTED.includes(new URL(instance).hostname);}catch{return false;}};

const walkFiles=(dir,prefix='')=>{
 const out=[];
 for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const rel=prefix?`${prefix}/${entry.name}`:entry.name;
  if(entry.isDirectory())out.push(...walkFiles(new URL(entry.name+'/',dir),rel));
  else out.push(rel);
 }
 return out;
};
const shell=path=>/^[A-Za-z0-9_./-]+$/.test(path)?path:`'${path.replaceAll("'","'\\''")}'`;
// A path as cvm prints it: forward slashes on every system. Node, PowerShell and
// the POSIX shells read them alike, so the lines it prints read the same
// everywhere and the commands it prints run as typed.
const slashed=path=>path.split(sep).join('/');

// next is the commands that follow an init, in order: connect (once per
// organization), deploy, run.
export function nextCommands(name,dir,{instance}={}){
 const t=TEMPLATES[name],steps=[];
 if(t.connector)steps.push(hostedInstance(instance)
  ?{command:`cvm connect add ${t.connector}`,why:`sign Caveman's own MCP server in for your team, in your browser (once per organization; cvm deploy offers it too)`}
  :{command:`cvm connect add https://<your console's origin>/mcp --name ${t.connector}`,why:`sign this installation's own MCP server in for your team, in your browser (once per organization)`});
 steps.push({command:`cvm deploy ${shell(dir)} --budget 1`,why:'store the agent and make it live as '+name+', at most $1 a session'});
 steps.push({command:`cvm run ${name} "${t.task}"`,why:'start a session and print its answer'});
 return steps;
}

export async function agentInit(argv,{instance=()=>process.env.CAVE_API_URL||'https://api.caveman.so',cwd=process.cwd()}={}){
 let format=process.stdout.isTTY?'table':'json';
 try{
  let values,positionals;
  try{({values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{format:{type:'string'},help:{type:'boolean',short:'h'}}}));}
  catch(error){throw usage(`${error.message} Use ${initUsage}.`);}
  format=formatOf(values);
  if(values.help){process.stdout.write(inertJSON({usage:initUsage,summary:'Write an agent folder from a template cvm ships, then print the commands that connect, deploy and run it. No network. Templates: '+Object.entries(TEMPLATES).map(([name,t])=>`${name} (${t.summary})`).join('; ')},format==='table'?2:undefined)+'\n');return 0;}
  const [name,dirArg,...rest]=positionals;
  if(name===undefined||rest.length)throw usage(`Name one template and at most one folder. Use ${initUsage}. Templates: ${Object.keys(TEMPLATES).join(', ')}.`);
  if(!Object.hasOwn(TEMPLATES,name))throw usage(`There is no template ${JSON.stringify(name).slice(0,60)}. Templates: ${Object.keys(TEMPLATES).join(', ')}.`);
  const shown=dirArg??name,dir=resolve(cwd,shown);
  if(existsSync(dir)&&!statSync(dir).isDirectory())throw usage(`${shown} is a file; name a folder.`);
  const source=new URL(`${name}/`,templatesRoot),files=walkFiles(source);
  const taken=files.filter(file=>existsSync(join(dir,file)));
  if(taken.length)throw usage(`${shown} already holds ${taken.join(', ')}; cvm writes over nothing. Name a new folder: cvm agent init ${name} DIR`);
  mkdirSync(dir,{recursive:true});
  for(const file of files){
   const target=join(dir,...file.split('/'));
   mkdirSync(join(target,'..'),{recursive:true});
   writeFileSync(target,readFileSync(new URL(file,source)),{flag:'wx'});
  }
  // What was written builds: the same check cvm deploy makes first.
  const b=build(locate(dir));
  const rel=slashed(relative(cwd,dir))||'.',next=nextCommands(name,rel.startsWith('..')?slashed(dir):rel,{instance:instance()});
  if(format==='table'){
   const pad=label=>label.padEnd(9);
   process.stdout.write([`${pad('wrote')}${files.map(file=>posix.join(rel,file)).join(', ')}`,`${pad('agent')}${b.name}  ${summaryLine(b)}`,
    ...next.map((step,i)=>`${pad(i?'':'next')}${step.command}\n${pad('')}  ${step.why}`)].join('\n')+'\n');
  }else process.stdout.write(inertJSON({schema_version:1,ok:true,status:'written',template:name,dir,files,agent:b.name,sha256:b.digest,connectors:Object.keys(b.manifest.connectors??{}),next})+'\n');
  return 0;
 }catch(error){
  const e=error instanceof CloudError?error:new CloudError('cave_failed',error.code==='EACCES'||error.code==='EPERM'||error.code==='EEXIST'?`Could not write the folder: ${error.code}.`:'The init failed.',1);
  process.stdout.write(format==='table'?`failed   ${e.code}: ${e.message}\n`:inertJSON({schema_version:1,ok:false,status:'failed',error:{code:e.code,message:e.message}})+'\n');
  return e.exitCode;
 }
}
