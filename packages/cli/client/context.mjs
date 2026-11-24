import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CloudClient,CloudError,contractSHA256,upgradeCommand} from './index.mjs';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const name=/^[a-z][a-z0-9_-]{0,63}$/;
async function json(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new CloudError('cave_context_invalid',`Invalid context file: ${path}`,2);}}
async function save(path,value){await mkdir(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,path);}
function project(value){if(value!==undefined&&!uuid.test(value))throw new CloudError('cave_project_required','Project must be a UUID.',2);return value;}
export function cloudContext(host,{home=homedir(),cwd=process.cwd(),env=process.env}={}){
 const profilesPath=join(home,'.caveman-cloud','profiles.json'),bindingPath=join(cwd,'.caveman-cloud.json');
 async function state(){const s=await json(profilesPath,{schema_version:1,profiles:{}});if(s.schema_version!==1||!s.profiles||typeof s.profiles!=='object'||Array.isArray(s.profiles))throw new CloudError('cave_context_invalid','Unsupported Cloud profiles document.',2);return s;}
 async function resolve({profile,projectId}={}){
  const s=await state();profile=profile??env.CAVE_CLOUD_PROFILE??s.selected??'default';
  if(!name.test(profile))throw new CloudError('cave_profile_invalid','Invalid profile name.',2);
  const binding=await json(bindingPath,{});
  if(Object.keys(binding).some(k=>!['schema_version','project_id'].includes(k))||binding.schema_version!==undefined&&binding.schema_version!==1)throw new CloudError('cave_context_invalid','Repository binding accepts only schema_version and project_id.',2);
  let cfg;
  if(profile==='default')cfg=await host();
  else {
   const p=s.profiles[profile];if(!p)throw new CloudError('cave_profile_missing',`Profile ${profile} is not configured. Use context save.`,3);
   if(!/^[A-Z][A-Z0-9_]{0,127}$/.test(p.token_env??''))throw new CloudError('cave_profile_invalid','Named profile needs a token environment variable.',2);
   cfg={baseURL:p.endpoint,token:env[p.token_env],projectId:p.project_id};
   if(!cfg.token)throw new CloudError('cave_profile_credential_missing',`Set ${p.token_env} for profile ${profile}. No default credential fallback.`,3);
  }
  const selected=project(projectId??env.CAVE_PROJECT_ID??binding.project_id??(profile==='default'?s.project_id:undefined)??cfg.projectId);
  return {...cfg,projectId:selected,profile,projectSource:projectId?'flag':env.CAVE_PROJECT_ID?'environment':binding.project_id?'repository':selected?'saved':'unset'};
 }
 async function command(verb,values,positionals,profile){
  const s=await state();
  if(verb==='list')return {schema_version:1,profiles:['default',...Object.keys(s.profiles)].map(id=>({id,selected:(s.selected??'default')===id,...(id==='default'?{}:{endpoint:s.profiles[id].endpoint,project_id:s.profiles[id].project_id,token_env:s.profiles[id].token_env})}))};
  if(verb==='save'){
   const id=positionals[0];if(positionals.length!==1||!name.test(id)||id==='default'||!values.endpoint||!/^[A-Z][A-Z0-9_]{0,127}$/.test(values['token-env']??''))throw new CloudError('cave_usage','Use context save NAME --endpoint URL --token-env ENV_NAME [--project UUID]. Named profiles reference environment credentials; they never store tokens.',2);
   new CloudClient({baseURL:values.endpoint,token:'endpoint-validation'});
   s.profiles[id]={endpoint:values.endpoint,token_env:values['token-env'],...(values.project?{project_id:project(values.project)}:{})};await save(profilesPath,s);return {schema_version:1,ok:true,profile:id};
  }
  if(verb==='use'){
   const id=positionals[0];if(positionals.length!==1||id!=='default'&&!Object.hasOwn(s.profiles,id))throw new CloudError('cave_profile_missing','Use context use NAME with an existing profile.',2);
   s.selected=id;await save(profilesPath,s);return {schema_version:1,ok:true,profile:id};
  }
  const cfg=await resolve({profile,projectId:values.project});
  if(verb==='bind'||verb==='set'){
   const id=project(values.project??positionals[0]);if(!id||positionals.length>1)throw new CloudError('cave_usage','Select one project UUID.',2);
   await new CloudClient({...cfg,projectId:id}).execute('projects.get',{});
   if(verb==='bind')await save(bindingPath,{schema_version:1,project_id:id});
   else {if(cfg.profile==='default')s.project_id=id;else s.profiles[cfg.profile].project_id=id;await save(profilesPath,s);}
   return {schema_version:1,ok:true,profile:cfg.profile,project_id:id,source:verb==='bind'?'repository':'saved'};
  }
  if(verb!=='show')throw new CloudError('cave_usage','Use context show|list|save|use|set|bind.',2);
  if(positionals.length)throw new CloudError('cave_usage','context show accepts no positional arguments.',2);
  return {schema_version:1,profile:cfg.profile,endpoint:cfg.baseURL,project_id:cfg.projectId??null,project_source:cfg.projectSource,credential_configured:!!cfg.token};
 }
 async function doctor(options){
  const cfg=await resolve(options),client=new CloudClient(cfg),remote=await client.discover();
  if(remote.schema_version!==1||!Array.isArray(remote.operations))throw new CloudError('cave_contract_invalid','Server discovery document is invalid.',6);
  const compatible=remote.contract_sha256===contractSHA256;
  const version=compatible?undefined:await client.serverVersion();
  return {schema_version:1,ok:compatible,status:compatible?'completed':'incompatible',profile:cfg.profile,endpoint:cfg.baseURL,project_id:cfg.projectId??null,installed_contract:contractSHA256,server_contract:remote.contract_sha256,granted_operations:remote.operations.map(o=>o.id),...(compatible?{}:{...(version?{server_version:version}:{}),next_action:`${upgradeCommand(version)}, then cvm doctor (a self-hosted server: the cvm version of its release).`})};
 }
 return {resolve,command,doctor};
}
