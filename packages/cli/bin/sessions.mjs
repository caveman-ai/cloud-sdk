// `cvm sessions`: durable session operations (waits, fork, to-eval, migrate).
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {CloudClient,CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {formatOf} from './agent-build.mjs';
import {clean,failure} from './deploy.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const enc=encodeURIComponent;
const one=text=>clean(text).replace(/\s+/g,' ').trim();
const own=(code,message,exit)=>Object.assign(new CloudError(code,message,exit),{local:true});
const usage=message=>own('cave_usage',message,2);
const table=rows=>{
 const widths=rows.reduce((w,row)=>row.map((cell,i)=>Math.max(w[i]??0,String(cell).length)),[]);
 return rows.map(row=>row.map((cell,i)=>i===row.length-1?String(cell):String(cell).padEnd(widths[i])).join('  ').trimEnd()).join('\n')+'\n';
};

const sessionsUsage='cvm sessions <waits SESSION_ID | fork SESSION_ID [--at SEQ] [--model MODEL] [--message TEXT] | to-eval SESSION_ID [--out FILE] | migrate SESSION_ID [--revision N]> [--format json|table]';

export async function sessions(argv,{context}){
 let format=process.stdout.isTTY?'table':'json';
 try{
  let parsed;
  try{
   parsed=parseArgs({
    args:argv,strict:true,allowPositionals:true,
    options:{
     at:{type:'string'},
     model:{type:'string'},
     message:{type:'string'},
     out:{type:'string'},
     revision:{type:'string'},
     format:{type:'string'},
     help:{type:'boolean',short:'h'},
    },
   });
  }catch(error){throw usage(`${error.message} Use ${sessionsUsage}.`);}
  const {values,positionals}=parsed;
  format=formatOf(values);
  if(values.help||positionals.length===0){
   process.stdout.write(inertJSON({
    usage:sessionsUsage,
    summary:'Inspect durable waits, time-travel fork a session (event log + Drive commits + VM snapshot), export a session with frozen step mocks to an eval case, or migrate a parked session to a newer deployment revision.',
   },format==='table'?2:undefined)+'\n');
   return 0;
  }
  const [verb,id,...rest]=positionals;
  if(!['waits','fork','to-eval','migrate'].includes(verb))throw usage(`Unknown sessions command ${one(verb)}. Use ${sessionsUsage}.`);
  if(!id||!UUID.test(id)||rest.length)throw usage(`Supply one session UUID. Use ${sessionsUsage}.`);
  const api=new CloudClient({...await context(),timeout:30000});

  if(verb==='waits'){
   const res=await api.request(`/api/v1/code/sessions/${enc(id)}/waits`);
   if(format!=='table'){process.stdout.write(inertJSON(res)+'\n');return 0;}
   const list=res.waits??[];
   process.stdout.write(list.length
    ?table([['WAIT ID','KIND','STATUS','TARGET / ASK','EXPIRES','ACTION'],...list.map(w=>[w.id.slice(0,8),one(w.kind),one(w.status),one(w.ask_id||w.target_id||'-'),one(w.expires_at||'-'),one(w.timeout_action||'resume')])])
    :'No durable waits recorded for this session.\n');
   return 0;
  }

  if(verb==='fork'){
   const body={request_id:randomUUID()};
   if(values.at!==undefined){
    const seq=Number(values.at);
    if(!Number.isSafeInteger(seq)||seq<0)throw usage('--at must be an event sequence number (0 or greater).');
    body.at_seq=seq;
   }
   if(values.model)body.model=values.model;
   if(values.message)body.message=values.message;
   const res=await api.request(`/api/v1/code/sessions/${enc(id)}/fork`,{body});
   if(format!=='table'){process.stdout.write(inertJSON(res)+'\n');return 0;}
   process.stdout.write(table([
    ['forked',res.session?.id??''],
    ['from',`${res.forked_from} @ seq ${res.at_seq}`],
    ...(res.forked_drives&&Object.keys(res.forked_drives).length?[['drives',Object.entries(res.forked_drives).map(([k,v])=>`${k}->${v}`).join(', ')]]:[]),
    ['follow',`cvm run --session ${res.session?.id??''}`],
   ]));
   return 0;
  }

  if(verb==='to-eval'){
   const res=await api.request(`/api/v1/code/sessions/${enc(id)}/to-eval`,{body:{}});
   if(values.out){
    const payload=JSON.stringify(res.case??res,null,2)+'\n';
    writeFileSync(values.out,payload,'utf8');
    if(format==='table')process.stdout.write(table([['eval',values.out],['mocks',String(res.case?.mocks?.length??0)]]));
    else process.stdout.write(inertJSON({ok:true,out:values.out,session_id:id,mocks:res.case?.mocks?.length??0})+'\n');
    return 0;
   }
   process.stdout.write(inertJSON(res,format==='table'?2:undefined)+'\n');
   return 0;
  }

  if(verb==='migrate'){
   const body={};
   if(values.revision!==undefined){
    const rev=Number(values.revision);
    if(!Number.isSafeInteger(rev)||rev<1)throw usage('--revision must be a positive integer.');
    body.revision=rev;
   }
   const res=await api.request(`/api/v1/code/sessions/${enc(id)}/migrate`,{body});
   if(format!=='table'){process.stdout.write(inertJSON(res)+'\n');return 0;}
   process.stdout.write(table([['session',id],['migrated',`revision ${res.revision}`]]));
   return 0;
  }
  return 0;
 }catch(error){
  const e=failure(error,'The sessions request');
  process.stdout.write(format==='table'?`failed   ${e.code}: ${e.message}\n`:inertJSON({schema_version:1,ok:false,status:'failed',error:{code:e.code,message:e.message}})+'\n');
  return e.exitCode;
 }
}
