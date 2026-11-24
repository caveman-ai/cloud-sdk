import {CloudError, validateOperation} from './index.mjs';

const fields=['system_text','user_text','variables','model_defaults','tools','commit_message','tags'];
const content=version=>Object.fromEntries(fields.map(key=>[key,version[key]]));

export function validatePromptManifest(value){
 if(!value||value.schema_version!==1||value.kind!=='prompts'||Object.keys(value).some(key=>!['schema_version','kind','resource','spec'].includes(key)))throw new CloudError('cave_manifest_invalid','Expected a version 1 prompts manifest.',2);
 if(!value.spec||typeof value.spec!=='object'||Array.isArray(value.spec)||Object.keys(value.spec).some(key=>![...fields,...(Object.hasOwn(value,'resource')?[]:['name','description'])].includes(key)))throw new CloudError('cave_manifest_invalid','Prompt spec accepts content fields; identity and expected version belong in resource.',2);
 if(Object.hasOwn(value,'resource')&&(!value.resource||typeof value.resource!=='object'||Array.isArray(value.resource)))throw new CloudError('cave_manifest_invalid','Prompt resource must contain id and version.',2);
 if(value.resource){
  if(Object.keys(value.resource).some(key=>!['id','version'].includes(key))||!Number.isSafeInteger(value.resource.version)||value.resource.version<1)throw new CloudError('cave_manifest_invalid','Prompt resource requires id and expected version.',2);
  validateOperation('prompts.add_version',{...value.spec,prompt_id:value.resource.id,expected_version:value.resource.version});
 }else validateOperation('prompts.create',value.spec);
 return value;
}

export async function pullPromptManifest(client,id,version){
 const current=(await client.execute('prompts.get',{prompt_id:id})).data;
 const selected=version??current.prompt.latest_version;
 const snapshot=current.versions?.find(item=>item.version===selected);
 if(!snapshot)throw new CloudError('cave_prompt_version_not_found','Requested prompt version was not found.',4);
 return validatePromptManifest({schema_version:1,kind:'prompts',resource:{id:current.prompt.id,version:snapshot.version},spec:content(snapshot)});
}

export async function pushPromptManifest(client,manifest){
 validatePromptManifest(manifest);
 // Prompt writes are not receipt-backed. Never fabricate retry guarantees or
 // automatically retry a lost response. Expected version is checked under the
 // server's prompt row lock; pinning remains a separate explicit operation.
 const result=manifest.resource
  ?await client.execute('prompts.add_version',{...manifest.spec,prompt_id:manifest.resource.id,expected_version:manifest.resource.version})
  :await client.execute('prompts.create',manifest.spec);
 const resource=manifest.resource?{id:manifest.resource.id,version:result.data.version}:{id:result.data.id,version:result.data.latest_version};
 return {...result,manifest:{schema_version:1,kind:'prompts',resource,spec:Object.fromEntries(fields.filter(key=>Object.hasOwn(manifest.spec,key)).map(key=>[key,manifest.spec[key]]))},retry:'inspect_remote_before_retry'};
}
