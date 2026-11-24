import {createHash} from 'node:crypto';
import {CloudError,validateOperation} from './index.mjs';

const resources={datasets:{singular:'dataset',id:'dataset_id'},evaluators:{singular:'evaluator',id:'evaluator_id'},evals:{singular:'workbench',id:'workbench_id'},scenarios:{singular:'scenario',id:'dataset_id'}};
export const manifestFamilies=Object.keys(resources);
export function validateManifest(value,family){
 if(!resources[family]||value?.schema_version!==1||value.kind!==family||Object.keys(value).some(k=>!['schema_version','kind','resource','spec'].includes(k)))throw new CloudError('cave_manifest_invalid','Expected version 1 manifest with kind, optional resource, and spec.',2);
 validateOperation(`${family}.create`,value.spec);
 if(value.resource){
  if(Object.keys(value.resource).some(k=>!(family==='scenarios'?['id','revision','version']:['id','revision']).includes(k)))throw new CloudError('cave_manifest_invalid','Resource identity accepts id and revision only.',2);
  validateOperation(`${family}.update`,{...(family==='scenarios'?{definition:value.spec}:value.spec),[resources[family].id]:value.resource.id,revision:value.resource.revision});
  if(family==='scenarios'&&(!Number.isSafeInteger(value.resource.version)||value.resource.version<1))throw new CloudError('cave_manifest_invalid','Scenario resource requires an immutable version.',2);
 }
 return value;
}
export async function pullManifest(client,family,id,version){
 const descriptor=resources[family];
 // No version asked for means the current one: the revision a pull carries is always the current revision.
 if(family==='scenarios'&&version===undefined)version=(await client.execute('datasets.get',{dataset_id:id})).data.dataset.current_version||1;
 const result=await client.execute(`${family}.get`,{[descriptor.id]:id,...(family==='scenarios'?{version}:{})});
 if(family==='scenarios')return validateManifest({schema_version:1,kind:family,resource:{id:result.data.dataset_id,revision:result.data.revision,version:result.data.version},spec:result.data.definition},family);
 const resource=result.data[descriptor.singular];
 let content;
 if(family==='datasets')content={document:{schema_version:1,columns:resource.columns,rows:result.data.rows.map(row=>({row_key:row.row_key,values:row.values,...(row.tags?.length?{tags:row.tags}:{})}))}};
 else if(family==='evaluators')content={config:{schema_version:1,grader_type:resource.grader_type,options:resource.options,input_mapping:resource.input_mapping}};
 else content={document:resource.document};
 return validateManifest({schema_version:1,kind:family,resource:{id:resource.id,revision:resource.revision},spec:{name:resource.name,description:resource.description,...content}},family);
}
export function manifestDiff(before,after){
 const changes=[];
 function walk(a,b,path){
  if(JSON.stringify(a)===JSON.stringify(b))return;
  if(a&&b&&!Array.isArray(a)&&!Array.isArray(b)&&typeof a==='object'&&typeof b==='object'){
   for(const key of new Set([...Object.keys(a),...Object.keys(b)]))walk(a[key],b[key],path+'/'+key.replaceAll('~','~0').replaceAll('/','~1'));
  }else changes.push({path,change:a===undefined?'add':b===undefined?'remove':'replace'});
 }
 // Preview paths and change kinds, keeping captured content out of summaries.
 walk(before?.spec,after.spec,'/spec');return changes;
}
function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;}
export async function pushManifest(client,manifest,{idempotencyKey}={}){
 const family=manifest.kind;validateManifest(manifest,family);
 const input={...(family==='scenarios'&&manifest.resource?{definition:manifest.spec}:manifest.spec),...(manifest.resource?{[resources[family].id]:manifest.resource.id,revision:manifest.resource.revision}:{})};
 const id=`${family}.${manifest.resource?'update':'create'}`;
 const key=idempotencyKey??'manifest:'+createHash('sha256').update(JSON.stringify(canonical({project:client.projectId,id,input}))).digest('hex');
 const result=await client.execute(id,input,{idempotencyKey:key});
 const resourceID=result.data.id??result.data.dataset_id;
 return {...result,manifest:{...manifest,resource:{id:resourceID,revision:result.data.revision,...(family==='scenarios'?{version:result.data.version}:{})}},lock:{schema_version:1,kind:family,project_id:client.projectId,id:resourceID,revision:result.data.revision,current_version:result.data.current_version??result.data.version??0,contract_sha256:result.contract_sha256,receipt_id:result.receipt_id,idempotency_key:key}};
}

export function validateBundle(bundle){
 if(bundle?.schema_version!==1||!Array.isArray(bundle.resources)||bundle.resources.length<1||bundle.resources.length>50||Object.keys(bundle).some(k=>!['schema_version','resources'].includes(k)))throw new CloudError('cave_manifest_invalid','Bundle needs schema_version:1 and 1-50 named resources.',2);
 const names=new Set();
 for(const entry of bundle.resources){if(!entry||Object.keys(entry).some(k=>!['name','manifest'].includes(k))||!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.name)||names.has(entry.name))throw new CloudError('cave_manifest_invalid','Bundle resource names must be unique lowercase identifiers.',2);names.add(entry.name);validateManifest(entry.manifest,entry.manifest?.kind);}
 return bundle;
}
export async function pushBundle(client,bundle,{lock,onReceipt}={}){
 validateBundle(bundle);
 if(lock&&(lock.schema_version!==1||lock.project_id!==client.projectId||!lock.resources||typeof lock.resources!=='object'))throw new CloudError('cave_lock_conflict','Lock belongs to another project or has an unsupported version.',4);
 lock=structuredClone(lock??{schema_version:1,project_id:client.projectId,resources:{}});
 const results=[];
 for(const {name,manifest:source}of bundle.resources){
  try{
   const digest=createHash('sha256').update(JSON.stringify(canonical(source.spec))).digest('hex');
   const previous=lock.resources[name];let manifest=source;
   if(previous){
    if(previous.kind!==source.kind||source.resource&&source.resource.id!==previous.id)throw new CloudError('cave_lock_conflict',`Resource ${name} changed identity.`,4);
    if(previous.spec_sha256===digest){
     const remote=await pullManifest(client,source.kind,previous.id,previous.current_version||1);
     if(remote.resource.revision!==previous.revision)throw new CloudError('cave_eval_revision_conflict',`Resource ${name} changed remotely. Pull and reconcile before retrying.`,4);
     results.push({name,status:'unchanged',receipt_id:previous.receipt_id,resource_id:previous.id});continue;
    }
    // Preserve the original expected revision on retry. If the response was
    // lost after commit, its stable request key recovers the prior receipt.
    manifest={...source,resource:{id:previous.id,revision:previous.revision,...(source.kind==='scenarios'?{version:previous.current_version}:{})}};
   }
   const key='bundle:'+createHash('sha256').update(JSON.stringify(canonical({project:client.projectId,name,manifest}))).digest('hex');
   const result=await pushManifest(client,manifest,{idempotencyKey:key});
   lock.resources[name]={...result.lock,spec_sha256:digest};
   // Persist after each committed resource. A later failure cannot erase proof
   // of earlier success; lost responses retry the identical server receipt.
   await onReceipt?.(lock);
   results.push({name,status:'completed',receipt_id:result.receipt_id,resource_id:result.lock.id});
  }catch(error){results.push({name,status:'failed',error:{code:error.code??'cave_operation_failed',message:error.message,exit_code:error.exitCode??1}});}
 }
 const failed=results.filter(r=>r.status==='failed');
 return {schema_version:1,ok:failed.length===0,status:failed.length?'partial':'completed',atomic:false,results,lock,exit_code:failed[0]?.error.exit_code??0};
}
export function parseRows(text){
 if(Buffer.byteLength(text)>16*1024*1024)throw new CloudError('cave_input_too_large','Rows exceed 16 MiB.',2);
 const rows=[];
 for(const [index,line]of text.split(/\r?\n/).entries()){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{throw new CloudError('cave_invalid_jsonl',`Invalid JSON on row line ${index+1}.`,2);}}
 return rows;
}
