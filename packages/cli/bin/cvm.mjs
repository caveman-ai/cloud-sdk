#!/usr/bin/env node
// cvm, the Caveman Cloud CLI. It signs in with the browser device flow and
// stores the credential exactly where `caveman login` does (the Cloud config
// points at the macOS Keychain item or the 0600 credentials file), so either
// CLI's sign-in serves both, and a refreshed pair goes back to the same place,
// so neither CLI ever signs the other out.
import {readFileSync,writeFileSync,mkdirSync,chmodSync,renameSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as pause} from 'node:timers/promises';
import {version,skillDirs,marker,installSkill} from './agents.mjs';

// A reader that stops early (cvm tools list | head) closes the pipe: end
// quietly, as Unix tools do, instead of an unhandled EPIPE stack trace.
for(const stream of [process.stdout,process.stderr])stream.on('error',error=>{if(error.code!=='EPIPE')throw error;process.exit(process.exitCode??0);});
const client=()=>import('../dist/cloud-client.mjs');
const cavemanHome=process.env.CAVEMAN_HOME??join(homedir(),'.caveman');
const credentialsPath=join(cavemanHome,'credentials');
// The Cloud config is $CAVEMAN_HOME/cloud.json, as `caveman` (v4) keeps it; that
// CLI copies the old ~/.caveman-cloud/config.json there once, and until then the
// old file is the one both read and write.
const legacyConfigPath=join(homedir(),'.caveman-cloud','config.json');
function configPath(){const path=join(cavemanHome,'cloud.json');return existsSync(path)||!existsSync(legacyConfigPath)?path:legacyConfigPath;}
const keychain=['-s','caveman','-a','token'];
const origin=url=>(url??'').replace(/\/+$/,'');

function readConfig(){try{return JSON.parse(readFileSync(configPath(),'utf8'));}catch{return {};}}
function writePrivate(path,text){
 if(existsSync(path))path=realpathSync(path); // a symlinked config stays a symlink
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const tmp=`${path}.${randomUUID()}.tmp`;writeFileSync(tmp,text,{mode:0o600,flag:'wx'});renameSync(tmp,path);chmodSync(path,0o600);
}
function storedSecret(meta){
 try{
  if(meta.tokenStore==='keychain')return execFileSync('security',['find-generic-password',...keychain,'-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  if(meta.tokenStore==='file')return readFileSync(credentialsPath,'utf8').trim();
 }catch{return '';}
 return meta.token??''; // legacy inline config
}
// A stored secret is the credentials JSON, or a bare access token in older stores.
function decode(raw){try{const parsed=JSON.parse(raw);if(typeof parsed.access_token==='string')return parsed;}catch{}return {access_token:raw};}
const claims=token=>{try{return JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString('utf8'))??{};}catch{return {};}};
const expiresSoon=token=>claims(token).exp<=Date.now()/1000+60;
// Without a default keychain (a sudo or remote shell, a fresh account) the
// keychain write opens a macOS "A keychain cannot be found" dialog instead of
// failing, so the file is used without asking.
function defaultKeychain(){
 try{const path=execFileSync('security',['default-keychain'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().replace(/^"|"$/g,'');return path!==''&&existsSync(path);}catch{return false;}
}
function store(credentials){
 const secret=JSON.stringify(credentials);
 if(process.platform==='darwin'&&!process.env.CAVE_NO_KEYCHAIN&&defaultKeychain()){try{execFileSync('security',['add-generic-password','-U',...keychain,'-w',secret],{stdio:'ignore'});return 'keychain';}catch{}}
 writePrivate(credentialsPath,secret);return 'file';
}
// Refresh tokens rotate: the new pair goes back where caveman reads it, or the
// next `caveman` command would present a spent refresh token.
async function refresh(meta,credentials,baseURL){
 try{
  const endpoint=new URL(baseURL);
  if(endpoint.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))return credentials; // never send a refresh token in clear text
  const response=await fetch(`${baseURL}/api/v1/auth/refresh`,{method:'POST',redirect:'manual',headers:{'content-type':'application/json','x-cave-client':'cli'},body:JSON.stringify({refresh_token:credentials.refresh_token}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)return credentials;
  const body=await response.json();
  if(typeof body.access_token!=='string'||typeof body.refresh_token!=='string')return credentials;
  const next={...credentials,access_token:body.access_token,refresh_token:body.refresh_token};
  // A logout or another refresh may have run during the request: write back
  // only over the exact state this refresh spent.
  const now=readConfig();
  if(now.tokenStore===meta.tokenStore&&!now.logoutPendingLocalCleanup&&decode(storedSecret(now)).refresh_token===credentials.refresh_token){
   const {token,...rest}=now;
   writePrivate(configPath(),JSON.stringify({...rest,tokenStore:store(next)},null,2)+'\n');
  }
  return next;
 }catch{return credentials;}
}
async function context(){
 // The environment wins over the saved login, and a flag over both (--project,
 // read by the client). logout leaves baseURL empty.
 const meta=readConfig(),baseURL=process.env.CAVE_API_URL||meta.baseURL||'https://api.caveman.so';
 const projectId=process.env.CAVE_PROJECT_ID||meta.projectId;
 if(process.env.CAVE_TOKEN)return {baseURL,token:process.env.CAVE_TOKEN,projectId};
 // The saved credential was issued by the saved address and is sent nowhere
 // else: another CAVE_API_URL needs its own CAVE_TOKEN.
 if(meta.baseURL&&origin(baseURL)!==origin(meta.baseURL))return {baseURL,token:undefined,projectId};
 let credentials=decode(storedSecret(meta));
 if(!meta.logoutPendingLocalCleanup&&credentials.refresh_token&&expiresSoon(credentials.access_token))credentials=await refresh(meta,credentials,baseURL);
 return {baseURL,token:credentials.access_token,projectId:projectId??credentials.project_id};
}
const post=(url,body,headers={})=>fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-cave-client':'cli',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
function openBrowser(url){
 const [command,args]=process.platform==='darwin'?['open',[url]]:process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',url]]:['xdg-open',[url]];
 try{spawn(command,args,{detached:true,stdio:'ignore'}).on('error',()=>{}).unref();}catch{}
}
// RFC 8628 device grant: the requests `caveman login` makes, and the
// credential stored where it stores one. onCode shows the code instead of
// stderr (the setup screen).
async function login(args=[],{onCode}={}){
 const {CloudError}=await client();
 let values;try{({values}=parseArgs({args,strict:true,options:{instance:{type:'string'},'no-browser':{type:'boolean'}}}));}catch{throw new CloudError('cave_usage','Use cvm login [--instance URL] [--no-browser].',2);}
 const baseURL=origin(values.instance||process.env.CAVE_API_URL||readConfig().baseURL||'https://api.caveman.so');
 let url;try{url=new URL(baseURL);}catch{}
 if(!url||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new CloudError('cave_endpoint_invalid','Sign in over HTTPS (plain HTTP only on localhost), to an origin with no path, credentials, query or fragment.',2);
 const started=await post(`${baseURL}/api/v1/auth/device/code`,{}).catch(()=>{throw new CloudError('cave_network_error',`Could not reach ${baseURL}.`,1);});
 const code=await started.json().catch(()=>({}));
 if(started.status===403&&code.error?.code==='cave_device_login_disabled')throw new CloudError('cave_device_login_disabled','Device login is not open on this installation.',3);
 if(!started.ok||typeof code.device_code!=='string')throw new CloudError(code.error?.code??'cave_device_login_failed',`Could not start sign-in at ${baseURL} (HTTP ${started.status}).`,1);
 const link=code.verification_uri_complete??code.verification_uri;
 if(onCode)onCode(code.user_code,link);else process.stderr.write(`Confirm the code ${code.user_code} in your browser: ${link}\n`);
 if(!values['no-browser']&&!process.env.CAVE_NO_BROWSER&&/^https?:\/\//.test(link))openBrowser(link);
 let interval=Number(code.interval??5)*1000;const deadline=Date.now()+Number(code.expires_in??600)*1000;
 const expired=new CloudError('expired_token','The code expired before it was confirmed. Run cvm login again.',3);
 while(Date.now()<deadline){
  await pause(Math.max(interval,200));
  let response,grant;
  // A dropped poll, a rate limit or a busy server is retried until the code expires.
  try{response=await post(`${baseURL}/api/v1/auth/device/token`,{device_code:code.device_code});if(response.status>=500||response.status===429)continue;grant=await response.json();}catch{continue;}
  if(grant.error==='slow_down'){interval+=5000;continue;}
  if(grant.error==='authorization_pending')continue;
  if(grant.error==='expired_token')throw expired;
  if(grant.error==='access_denied')throw new CloudError('access_denied','Sign-in was denied in the browser.',3);
  if(typeof grant.access_token!=='string'||!grant.access_token)throw new CloudError(typeof grant.error==='string'?grant.error:'cave_device_login_failed',`Sign-in failed: ${typeof grant.error==='string'?grant.error:`HTTP ${response.status}`}.`,1);
  const credentials=Object.fromEntries(['access_token','refresh_token','gateway_api_key','gateway_key_id','project_id'].filter(key=>typeof grant[key]==='string'&&grant[key]).map(key=>[key,grant[key]]));
  const tokenStore=store(credentials),{oid}=claims(credentials.access_token);
  // No gatewayUrl: with one, `caveman enable claude` switches to managed mode
  // and writes a gateway base URL with no key into Claude Code's settings.
  const {token,logoutPendingLocalCleanup,gatewayUrl,organizationId,projectId,...rest}=readConfig();
  writePrivate(configPath(),JSON.stringify({...rest,baseURL,tokenStore,...(typeof oid==='string'?{organizationId:oid}:{}),...(credentials.project_id?{projectId:credentials.project_id}:{})},null,2)+'\n');
  // The receipt: the server replays a durable grant until told it was stored,
  // and may revoke one that never is.
  if(Object.keys(credentials).length>1){
   for(let attempt=0;;attempt++){
    const ack=typeof grant.delivery_ack_token==='string'&&await post(`${baseURL}/api/v1/auth/device/ack`,{device_code:code.device_code,ack_token:grant.delivery_ack_token},{authorization:`Bearer ${credentials.access_token}`}).catch(()=>undefined);
    if(ack?.ok)break;
    if(attempt===4||ack===false||ack&&ack.status<500&&ack.status!==429)throw new CloudError('cave_device_ack_failed','Signed in, but the server did not confirm this device stored the credential and may revoke it. Run cvm login again.',1);
    await pause(200*2**attempt);
   }
  }
  return {baseURL,projectId:credentials.project_id??null};
 }
 throw expired;
}
async function loginCommand(args){
 const {baseURL,projectId}=await login(args);
 if(process.stdout.isTTY)process.stdout.write(`Signed in to ${baseURL}.\n`);
 else{process.stderr.write(`Signed in to ${baseURL}.\n`);process.stdout.write(JSON.stringify({signed_in:true,api:baseURL,project_id:projectId})+'\n');}
 return 0;
}
// `caveman logout`'s steps: revoke the device's gateway key and the session,
// then forget the credential and the address.
async function logout(){
 const meta=readConfig(),baseURL=origin(meta.baseURL);
 let credentials=decode(storedSecret(meta));
 if(credentials.access_token&&baseURL&&!meta.logoutPendingLocalCleanup){
  const {CloudError}=await client();
  if(credentials.refresh_token&&expiresSoon(credentials.access_token))credentials=await refresh(meta,credentials,baseURL);
  const kept=new CloudError('cave_logout_failed','Could not revoke this sign-in on the server; you are still signed in. Run cvm logout again.',1);
  const revoke=(path,body,headers)=>post(baseURL+path,body,{authorization:`Bearer ${credentials.access_token}`,...headers}).catch(()=>{throw kept;});
  const project=meta.projectId??credentials.project_id;
  // The gateway key is gone only when the server says so (404 cave_key_not_found):
  // after any other answer this is the last copy of a live key, so it stays.
  if(project&&credentials.gateway_key_id){
   const response=await revoke(`/api/v1/projects/${encodeURIComponent(project)}/keys/${encodeURIComponent(credentials.gateway_key_id)}/revoke`,{},{'x-cave-csrf':'cli'});
   if(!response.ok&&!(response.status===404&&(await response.json().catch(()=>({}))).error?.code==='cave_key_not_found'))throw kept;
  }
  const response=await revoke('/api/v1/auth/logout',credentials.refresh_token?{refresh_token:credentials.refresh_token}:{});
  if(!response.ok&&response.status!==401)throw kept; // 401: the session already ended
 }
 // Remote revocation is recorded before the only local credential goes, so a
 // failed cleanup is retried without presenting a revoked session.
 writePrivate(configPath(),JSON.stringify({...meta,logoutPendingLocalCleanup:true},null,2)+'\n');
 if(meta.tokenStore==='keychain'||!meta.tokenStore&&process.platform==='darwin'&&!process.env.CAVE_NO_KEYCHAIN){
  try{execFileSync('security',['delete-generic-password',...keychain],{stdio:'ignore'});}catch(error){if(error.status!==44)throw new Error('Could not remove the credential from the macOS Keychain.');} // 44: no such item
 }
 if(meta.tokenStore!=='keychain')rmSync(credentialsPath,{force:true});
 const {token,tokenStore,projectId,organizationId,gatewayUrl,logoutPendingLocalCleanup,...rest}=meta;
 writePrivate(configPath(),JSON.stringify({...rest,baseURL:''},null,2)+'\n');
 process.stdout.write(process.stdout.isTTY?'Signed out.\n':JSON.stringify({logged_out:true})+'\n');
 return 0;
}

// Runs a client command for its JSON answer, the client's own printing held back.
async function call(...args){
 const {runCloudCLI}=await client();
 let out='';const write=process.stdout.write;process.stdout.write=chunk=>(out+=chunk,true);
 try{const code=await runCloudCLI([...args,'--format','json'],{context,login:loginCommand});return {...JSON.parse(out),code};}
 finally{process.stdout.write=write;}
}
// `cvm setup` lives in setup.mjs: the screen, the agents and the session.
async function setup(args){
 const {setup:run}=await import('./setup.mjs');
 return run(args,{client,context,login,call,cvm:realpathSync(fileURLToPath(import.meta.url))});
}

// Fixed human lifecycle routes, deliberately outside the operation/MCP catalog.
// The normal built-in context owns credentials; this command never exports them.
async function humanCode(args){
 const {CloudClient,CloudError,inertJSON}=await client();
 const usage='cvm human code computers|runtimes|workspace ID|archive ID --yes [--format json|jsonl|table]';
 const fail=(code,message,exit)=>new CloudError(code,message,exit);
 let format=process.stdout.isTTY?'table':'json';
 try{
  let values,positionals;
  try{({values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{help:{type:'boolean',short:'h'},format:{type:'string'},yes:{type:'boolean',short:'y'}}}));}
  catch{throw fail('cave_usage',`Use ${usage}.`,2);}
  format=values.format??format;
  if(!['json','jsonl','table'].includes(format))throw fail('cave_usage','Format must be json, jsonl, or table.',2);
  const [family,verb,id]=positionals;
  const write=value=>process.stdout.write(inertJSON(value,format==='table'?2:undefined)+'\n');
  if(values.help||!positionals.length||positionals.length===1&&family==='code'){
   write({usage,summary:'Human Code lifecycle. Uses your normal saved sign-in; agent connections remain forbidden. Archive terminates sessions and may delete an unused workspace computer. No computer allocation.'});return 0;
  }
  if(family!=='code'||!['computers','runtimes','workspace','archive'].includes(verb))throw fail('cave_usage',`Use ${usage}.`,2);
  const needsID=verb==='workspace'||verb==='archive';
  if(positionals.length!==(needsID?3:2)||needsID&&(id.length!==36||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)))throw fail('cave_usage','Supply exactly one workspace UUID for workspace or archive; no ID for computers or runtimes.',2);
  if(values.yes&&verb!=='archive')throw fail('cave_usage','--yes is only for archive.',2);
  // Validate and confirm before even resolving context (which may refresh login).
  if(verb==='archive'&&!values.yes)throw fail('cave_confirmation_required','Archiving terminates sessions and may delete the unused workspace computer. Repeat with --yes to confirm.',2);
  const path=needsID?`/api/v1/code/workspaces/${encodeURIComponent(id)}${verb==='archive'?'/archive':''}`:`/api/v1/code/${verb}`;
  try{
   const api=new CloudClient(await context());
   write(await api.request(path,verb==='archive'?{body:{}}:{}));return 0;
  }catch(error){
   // Do not print upstream bodies, messages, details, URLs or unknown errors:
   // they can contain credentials or terminal controls. Preserve denial codes.
   if(error.httpStatus){
    const code=error.httpStatus===403&&error.code==='cave_agent_operation_forbidden'?'cave_agent_operation_forbidden':'cave_request_failed';
    throw fail(code,`Code lifecycle request failed (HTTP ${error.httpStatus}).`,error.exitCode);
   }
   const safe={cave_auth_required:'Run cvm login.',cave_endpoint_invalid:'Cloud endpoint must be HTTPS or loopback HTTP without credentials, query or fragment.',cave_network_error:'Cloud request failed. Inspect workspace state before retrying archive.',cave_timeout:'Cloud request timed out. Inspect workspace state before retrying archive.',cave_invalid_response:'Cloud returned an invalid JSON response.',cave_result_too_large:'Cloud response exceeded the size limit.'};
   throw fail(Object.hasOwn(safe,error.code)?error.code:'cave_failed',safe[error.code]??'Code lifecycle command failed.',error instanceof CloudError?error.exitCode:1);
  }
 }catch(error){
  process.stdout.write(inertJSON({schema_version:1,ok:false,status:'failed',error:{code:error.code,message:error.message}},format==='table'?2:undefined)+'\n');return error.exitCode;
 }
}

// What cvm answers before the client, for `cvm --help` and `cvm <family>`.
const commands=[
 {id:'setup',usage:'cvm setup [--project UUID] [--agent claude,codex,...] [--yes] [--no-launch] [--remove]',summary:'Connect your coding agents: sign-in, project, skill and MCP server.'},
 {id:'login',usage:'cvm login [--instance URL] [--no-browser]',summary:'Sign in with the browser.'},
 {id:'logout',usage:'cvm logout',summary:'Sign out and revoke this device.'},
 {id:'mcp',usage:'cvm mcp',summary:'Serve the Cloud MCP server over stdio.'},
 {id:'human.code',usage:'cvm human code computers|runtimes|workspace ID|archive ID --yes',summary:'Human Code lifecycle using your normal saved sign-in; no agent access.'},
 {id:'evals.init',usage:'cvm evals init [PATH]',summary:'Write a starter eval file (example.eval.json).'},
 {id:'evals.ci',usage:'cvm evals ci FILE... | cvm evals ci [--suite NAME] -- TEST_COMMAND',summary:'Gate a pull request on eval files or a CI test run.'},
 {id:'evals.watch',usage:'cvm evals watch RUN_ID',summary:'Follow one run until it settles.'},
 {id:'agent.init',usage:'cvm agent init TEMPLATE [DIR]',summary:'Write an agent folder from a template (ask, support-slack, pr-reviewer, researcher-drive, ts-tools) and print the commands that deploy it. No network.'},
 {id:'agent.build',usage:'cvm agent build [PATH] [--out DIR]',summary:'Build an agent folder or file into the agent build output: its files, size and digest. No network.'},
 {id:'agent.dev',usage:'cvm agent dev [PATH] [--port 4317] [--trigger TEXT]',summary:'Run a local dev server with hot rebuild, local .caveman/drives/ mounts, and chat/manifest UI.'},
 {id:'deploy',usage:'cvm deploy [PATH] [--name NAME] [--repo OWNER/NAME] [--base-branch BRANCH] [--model MODEL] [--budget USD] [--dry-run]',summary:'Build the agent, store it when it changed, and make it the live revision of its deployment.'},
 {id:'run',usage:'cvm run DEPLOYMENT TASK... [--subject NAME=VALUE]... [--no-follow] [--timeout SECONDS] | cvm run --session ID',summary:'Start a session through a deployment and print its messages until it stops.'},
 {id:'deployments',usage:'cvm deployments [list | get NAME | revisions NAME | rollback NAME REVISION | pause NAME | resume NAME | archive NAME --yes | schedules NAME | channels NAME | sources | connect-repo OWNER/REPO --path DIR --name NAME]',summary:'List deployments; read, roll back, pause, resume, archive, inspect schedules/channels, or connect a Git repository.'},
 {id:'sessions',usage:'cvm sessions <waits ID | fork ID [--at SEQ] [--model M] [--message TEXT] | to-eval ID [--out FILE] | migrate ID [--revision N]>',summary:'Inspect durable waits, time-travel fork a session, export a deterministic replay eval case, or migrate a parked session revision.'},
 {id:'connect.add',usage:'cvm connect add TEMPLATE|URL [--name NAME] [--no-browser] [--yes]',summary:'Add a connector and sign it in for the whole team in the browser, then accept its tools.'},
 {id:'connect.ls',usage:'cvm connect ls',summary:'The connectors: state, sign-in, tools, who uses them and what waits.'},
 {id:'connect.test',usage:'cvm connect test NAME',summary:'Ask the server for its tools once with the shared sign-in.'},
 {id:'connect.diff',usage:'cvm connect diff NAME',summary:'What the server changed since the accepted list of tools.'},
 {id:'connect.accept',usage:'cvm connect accept NAME [--version N] [--effect TOOL=read|write|external ...] [--yes]',summary:'Accept the list of tools deploys build from.'},
 {id:'connect.rotate',usage:'cvm connect rotate NAME [--no-browser]',summary:'Sign the connector in again; the old sign-in works until then.'},
 {id:'connect.pause',usage:'cvm connect pause NAME [--reason TEXT]',summary:'Stop every call to the connector until it is resumed.'},
 {id:'connect.resume',usage:'cvm connect resume NAME',summary:'Let calls to a paused connector through again.'},
 {id:'connect.allow-writes',usage:'cvm connect allow-writes NAME [--in production[,preview,development]] [--none]',summary:'Say where agents may write with the connector\'s sign-in.'},
 {id:'connect.grant',usage:'cvm connect grant NAME --to DEPLOYMENT [--tools A,B] [--ceiling read|write|external] [--revoke]  or  cvm connect grant --request ID [--refuse] [--reason TEXT]',summary:'Let a deployment use a connector, or answer a request.'},
 {id:'connect.request',usage:'cvm connect request NAME --for DEPLOYMENT [--tools A,B] [--ceiling read|write|external]',summary:'Ask a connector\'s managers to let a deployment use it.'},
 {id:'connect.requests',usage:'cvm connect requests',summary:'The asks waiting for an answer.'},
 {id:'connect.rm',usage:'cvm connect rm NAME [--yes]',summary:'Remove a connector: its sign-in ends.'},
 {id:'drive.list',usage:'cvm drive [list]',summary:'The drives you can reach. With a share token (--token, CAVEMAN_DRIVE_TOKEN), what the token opens.'},
 {id:'drive.create',usage:'cvm drive create NAME [--description TEXT]',summary:'Make a drive: a versioned file tree your agents share.'},
 {id:'drive.ls',usage:'cvm drive ls DRIVE[/PATH] [--recursive]',summary:'List a folder: size, estimated tokens, who wrote each file, version.'},
 {id:'drive.cat',usage:'cvm drive cat DRIVE/PATH [--version N] [--lines FROM:TO]',summary:'Print a text file, whole or some lines, now or at an earlier version.'},
 {id:'drive.get',usage:'cvm drive get DRIVE/PATH [LOCAL] [--recursive] [--overwrite] [--version N] [--include-protected] [--force]',summary:'Download a file (- for stdout), or a folder with --recursive. A file over 64 MiB comes in ranges. Names a tool runs or obeys (.git, CLAUDE.md and the like) are skipped unless --include-protected.'},
 {id:'drive.put',usage:'cvm drive put LOCAL DRIVE/PATH [--overwrite] [--dry-run] [--resume UPLOAD_ID]',summary:'Upload a file (- for stdin) or a folder. A file over 8 MiB goes in parts; --resume goes on with a put that stopped.'},
 {id:'drive.grep',usage:'cvm drive grep PATTERN DRIVE[/PATH] [--glob G] [--ignore-case] [--fixed] [--context N] [--limit N]',summary:'Search the text files under a folder.'},
 {id:'drive.mv',usage:'cvm drive mv DRIVE/FROM TO_PATH',summary:'Move or rename a file or a folder inside its drive.'},
 {id:'drive.rm',usage:'cvm drive rm DRIVE/PATH [--recursive] --yes',summary:'Delete a file, or a folder with --recursive.'},
 {id:'drive.log',usage:'cvm drive log DRIVE/PATH',summary:'A file\'s versions and who wrote each.'},
 {id:'drive.changes',usage:'cvm drive changes DRIVE [--after SEQ] [--limit N]',summary:'The drive\'s commits after SEQ: what each did to which path.'},
 {id:'drive.restore',usage:'cvm drive restore DRIVE/PATH --version N | --to SEQ_OR_TIME',summary:'Bring back a file\'s earlier version, or a folder as it was at a commit or a time.'},
 {id:'drive.share',usage:'cvm drive share DRIVE[/PATH] --read | --write | --read --write [--for 15m] [--label TEXT]',summary:'Make a share token for a folder, for an agent outside the organization.'},
 {id:'drive.grants',usage:'cvm drive grants DRIVE',summary:'Who was given what on a drive.'},
 {id:'drive.grant',usage:'cvm drive grant DRIVE[/PATH] --to SERVICE_ACCOUNT_ID --read | --write [--until TIME]',summary:'Give a service account access to a folder.'},
 {id:'drive.revoke',usage:'cvm drive revoke DRIVE GRANT_ID',summary:'End a grant or a share token now.'},
 {id:'drive.verify',usage:'cvm drive verify DRIVE',summary:'Check that a drive\'s history is intact.'},
 {id:'drive.archive',usage:'cvm drive archive DRIVE --yes',summary:'End a drive: no more writes, and its name is freed; deleted for good after its retention window.'},
 {id:'drive.unarchive',usage:'cvm drive unarchive DRIVE_ID',summary:'Bring an archived drive back, inside its retention window.'},
 {id:'drive.set',usage:'cvm drive set DRIVE [--keep 90d] [--description TEXT]',summary:'How long the drive keeps old versions, or its description.'},
 {id:'drive.usage',usage:'cvm drive usage',summary:'What the organization\'s drives keep, and this month\'s storage and charge.'},
 {id:'drive.fork',usage:'cvm drive fork DRIVE NAME [--at SEQ]',summary:'A new drive that starts as DRIVE was at a commit, to change apart and merge back.'},
 {id:'drive.merge',usage:'cvm drive merge FORK [--dry-run]',summary:'Bring what a fork changed into the drive it was made from; conflicts are listed.'},
 {id:'drive.diff',usage:'cvm drive diff DRIVE[/PATH] [--from SEQ] [--to SEQ]',summary:'What changed between two commits, file by file.'},
 {id:'drive.review',usage:'cvm drive review DRIVE [CHANGESET] [--status pending|approved|rejected]',summary:'Sessions\' writes held for review, or one of them as a diff.'},
 {id:'drive.approve',usage:'cvm drive approve DRIVE CHANGESET --at SEQ [--dry-run]',summary:'Put a held changeset into the drive as yours, at the head you reviewed; conflicts are listed with what was done.'},
 {id:'drive.reject',usage:'cvm drive reject DRIVE CHANGESET --yes',summary:'Drop a held changeset.'},
 {id:'drive.undo',usage:'cvm drive undo DRIVE --session ID',summary:'Take back what one session wrote to a drive.'},
 {id:'sandbox.create',usage:'cvm sandbox create [--name NAME] [--size 4cpu-16gb] [--sleep-after 10m|2h|0] [--lifetime 1h] [--network none|internet] [--no-wait]',summary:'Make a sandbox and wait until it runs. It goes to sleep after 10 minutes unused unless --sleep-after says otherwise (0: never); --lifetime deletes it that long after it was made, whatever it is doing (1m to 30d); --network none gives it no network.'},
 {id:'sandbox.list',usage:'cvm sandbox list [--mine]',summary:'The sandboxes your key made, newest first. Signed in as a person, --mine keeps the ones you made.'},
 {id:'sandbox.get',usage:'cvm sandbox get SANDBOX',summary:'One sandbox: whether it runs, sleeps or failed, and its size.'},
 {id:'sandbox.exec',usage:'cvm sandbox exec [-i] [-t] [-e KEY=VALUE]... [-w DIR] [-u USER] SANDBOX -- COMMAND [ARG...]',summary:'Run a command in a running sandbox, its output streamed here; cvm exits with the command\'s exit code. -i sends this terminal\'s input, -t gives the command a terminal of this one\'s size, -e sets its environment, -w its folder, -u its user. Ctrl-C sends it INT; a second ends it.'},
 {id:'sandbox.cp',usage:'cvm sandbox cp [--root] SOURCE TARGET',summary:'Copy one file into a sandbox or out of it: SANDBOX:/PATH is the sandbox\'s side, the other a file here, or - for this terminal\'s input or output. --root reads and writes as the sandbox\'s root.'},
 {id:'sandbox.ls',usage:'cvm sandbox ls [--root] SANDBOX PATH',summary:'List a folder of a sandbox: each file\'s type and permissions, size, time modified and name.'},
 {id:'sandbox.port-forward',usage:'cvm sandbox port-forward SANDBOX [LOCAL:]PORT',summary:'Reach a port on a sandbox\'s own loopback from 127.0.0.1:LOCAL here (the same number unless LOCAL says, 0 for any free one), until Ctrl-C.'},
 {id:'sandbox.url',usage:'cvm sandbox url SANDBOX PORT [--public|--private] [--ttl 1h]',summary:'A port of a sandbox at its own URL (https://PORT-SANDBOX.DOMAIN, where this Caveman Cloud serves ports so): a link to open it in a browser, good for a few minutes, after which the browser keeps it open until --ttl (1m to 24h, an hour by default). A port is private until --public makes it open to anyone with the address (only who made the sandbox may); --private closes it again. --format json adds the token a program sends in its Caveman-Port-Token header.'},
 {id:'sandbox.sleep',usage:'cvm sandbox sleep SANDBOX [--wait]',summary:'Put a sandbox to sleep: it stops running and keeps its disk.'},
 {id:'sandbox.resume',usage:'cvm sandbox resume SANDBOX [--no-wait]',summary:'Wake a sleeping sandbox and wait until it runs.'},
 {id:'sandbox.delete',usage:'cvm sandbox delete SANDBOX --yes',summary:'Delete a sandbox and its disk, for good; any command running in it ends.'},
 {id:'sandbox.snapshot',usage:'cvm sandbox snapshot SANDBOX [--name NAME] [--no-wait]',summary:'Take a snapshot of a sandbox\'s disk and wait until it is ready. Only the key whose service account made the sandbox sees it.'},
 {id:'sandbox.snapshots',usage:'cvm sandbox snapshots SANDBOX',summary:'A sandbox\'s snapshots, newest first: each one\'s state, name, and when it was asked for and taken.'},
 {id:'sandbox.restore',usage:'cvm sandbox restore SANDBOX SNAPSHOT [--no-wait]',summary:'Put a running sandbox back on one of its snapshots: its commands end and it starts again on the snapshot\'s disk. Waits until it is restored.'},
 {id:'sandbox.fork',usage:'cvm sandbox fork SANDBOX SNAPSHOT [--name NAME] [--size 4cpu-16gb] [--sleep-after 10m|2h|0] [--no-wait]',summary:'Make a new sandbox from a snapshot\'s disk and wait until it runs. It runs at the snapshot\'s size unless --size says otherwise.'},
 {id:'sandbox.snapshot-delete',usage:'cvm sandbox snapshot-delete SANDBOX SNAPSHOT --yes',summary:'Delete a snapshot, for good; sandboxes made from it keep their disks.'},
 {id:'sandbox.status',usage:'cvm sandbox status',summary:'Whether sandboxes work right now on this Caveman Cloud, from its canary\'s recent rounds: each step\'s state, when it last passed and how long it takes.'},
 {id:'room',usage:'cvm room <list|create|threads|open|post|read|wait|claim|renew|release|complete|watch|rollup>',summary:'Shared Rooms & Threads decoupled from sessions: task leases, watchers, taint tracking and per-thread cost rollups.'},
 {id:'apps',usage:'cvm apps <list|create|fork|token|archive>',summary:'Drive-backed and sandbox-backed tenant Apps with capability-bridge tokens and 1-click Drive forking.'},
 {id:'listeners',usage:'cvm listeners <list|create|pause|resume|ingest|events|stats|delete>',summary:'Dynamic agent-authored event listeners with deterministic predicate filters and TTL expiry.'},
 {id:'workflows',usage:'cvm workflows <list|create|run|get>',summary:'Code-defined durable workflows riding on the shared Session step-ledger and awakeables.'},
 {id:'pools',usage:'cvm pools <list|create|computers|archive>',summary:'N:M org computer pools and unified Cloud + local Mac computer inventory.'},
 {id:'key.quick',usage:'cvm key quick [--days 30] [--print]',summary:'Idempotently bootstrap a personal 30-day code:run key from your cvm login for 30-second sandbox/SDK access.'},
 {id:'skills.add',usage:'cvm skills <list | add sandbox|drive|rooms|deploy|apps|listeners|workflows|all>',summary:'Install focused standalone Caveman skills into Claude Code and Agent Skills directories.'},
];
const argv=process.argv.slice(2);
// What only the operation form of `evals validate` and `evals run` takes.
// A bare id is the experiment to run, unless it is the value of --project.
const operationInput=(arg,i,args)=>/^--(file|stdin|workbench-id|scope|concurrency|outputs|wait|wait-timeout|idempotency-key|out)(=|$)/.test(arg)||args[i-1]!=='--project'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(arg);
// `cvm setup` with flags or nothing is onboarding; `cvm setup show|assert|hold` are operations.
const onboarding=argv[0]==='setup'&&!(argv[1]&&!argv[1].startsWith('-'));
// A skill cvm installed follows the installed cvm: an upgrade refreshes it on
// the next command. Nothing is created here, and nothing here fails a command.
if(!['--version','-v'].includes(argv[0])&&!(onboarding&&argv.includes('--remove'))){
 for(const dir of Object.values(skillDirs))try{if(readFileSync(join(dir,marker),'utf8')!==version)installSkill(dir);}catch{}
}
if(argv[0]==='--version'||argv[0]==='-v'){
 process.stdout.write(version+'\n');
}else if(['login','logout'].includes(argv[0])||onboarding){
 // No TTY needed: a coding agent runs these through its shell, and the person
 // confirms the sign-in in the browser.
 try{process.exitCode=await {login:loginCommand,logout,setup}[argv[0]](argv.slice(1));}
 catch(error){
  const exit=error.exitCode??1;
  process.stdout.write(JSON.stringify({schema_version:1,ok:false,status:'failed',error:{code:error.exitCode?error.code:'cave_failed',message:error.message}})+'\n');
  process.exitCode=exit;
 }
}else if(argv[0]==='human'&&argv[1]==='code'){
 process.exitCode=await humanCode(argv.slice(1));
}else if(argv[0]==='mcp'&&argv.length===1){
 const {serveCloudMCP}=await import('../dist/cloud-mcp.mjs');
 // A launcher may narrow the server to the operations one task needs.
 const granted=(process.env.CAVE_MCP_OPERATIONS??'').split(',').map(id=>id.trim()).filter(Boolean);
 await serveCloudMCP({context,...(granted.length?{grantedOperations:granted}:{})});
}else if(argv[0]==='evals'&&(argv[1]==='init'||['validate','run'].includes(argv[1])&&!argv.slice(2).some(operationInput))){
 // An eval file (*.eval.json) from nothing to a gated run. `evals validate
 // --file MANIFEST` and `evals run WORKBENCH_ID` stay the client's own.
 const evals=await import('./evals.mjs');
 process.exitCode=await {init:evals.evalsInit,validate:evals.evalsValidate,run:evals.evalsRun}[argv[1]](argv.slice(2),{context});
}else if(argv[0]==='agent'&&argv[1]==='build'){
 // An agent folder to the build output; no network.
 const {agentBuild}=await import('./agent-build.mjs');
 process.exitCode=await agentBuild(argv.slice(2));
}else if(argv[0]==='agent'&&argv[1]==='init'){
 // An agent folder from a template cvm ships; no network. The address only
 // picks the connect line it prints.
 const {agentInit}=await import('./agent-init.mjs');
 process.exitCode=await agentInit(argv.slice(2),{instance:()=>process.env.CAVE_API_URL||readConfig().baseURL||'https://api.caveman.so'});
}else if(argv[0]==='agent'&&argv[1]==='dev'){
 // Local development server with hot rebuild and local .caveman/drives/ mounts.
 const {agentDev}=await import('./agent-dev.mjs');
 process.exitCode=await agentDev(argv.slice(2));
}else if(['deploy','run','deployments'].includes(argv[0])){
 const verbs=await import('./deploy.mjs');
 // open: a deploy that connects what its build names opens the sign-in as cvm login does.
 process.exitCode=await verbs[argv[0]](argv.slice(1),{context,open:openBrowser});
}else if(argv[0]==='sessions'){
 const {sessions}=await import('./sessions.mjs');
 process.exitCode=await sessions(argv.slice(1),{context});
}else if(argv[0]==='connect'){
 // Connectors. A sign-in opens the browser as cvm login does.
 const {connect}=await import('./connect.mjs');
 process.exitCode=await connect(argv.slice(1),{context,open:openBrowser});
}else if(argv[0]==='drive'){
 // Drives. A share token (--token, CAVEMAN_DRIVE_TOKEN) needs no sign-in, only
 // the address context() would use: instance reads it and no credential.
 const {drive}=await import('./drive.mjs');
 process.exitCode=await drive(argv.slice(1),{context,instance:()=>process.env.CAVE_API_URL||readConfig().baseURL||'https://api.caveman.so'});
}else if(argv[0]==='sandbox'){
 // Sandboxes: computers made and used from outside them, on the SDK's Sandboxes client.
 const {sandbox}=await import('./sandbox.mjs');
 const {readCachedPersonalKey}=await import('./platform2027.mjs');
 const sandboxContext=async()=>{
  const ctx=await context();
  if(!process.env.CAVE_TOKEN&&!process.env.CAVE_NO_AUTO_KEY){
   const cached=readCachedPersonalKey();
   if(cached)return {...ctx,token:cached};
  }
  return ctx;
 };
 process.exitCode=await sandbox(argv.slice(1),{context:sandboxContext});
}else if(argv[0]==='room'){
 const {room}=await import('./rooms.mjs');
 process.exitCode=await room(argv.slice(1),{context});
}else if(['apps','listeners','workflows','pools','key','skills'].includes(argv[0])){
 const p27=await import('./platform2027.mjs');
 const map={apps:p27.appsCmd,listeners:p27.listenersCmd,workflows:p27.workflowsCmd,pools:p27.poolsCmd,key:p27.keyCmd,skills:p27.skillsCmd};
 process.exitCode=await map[argv[0]](argv.slice(1),{context});
}else if(argv[0]==='evals'&&['ci','watch'].includes(argv[1])){
 const {evalsCI,evalsWatch}=await import('./ci.mjs');
 process.exitCode=await (argv[1]==='ci'?evalsCI:evalsWatch)(argv.slice(2),{context,login:loginCommand});
}else{
 const {runCloudCLI}=await client();
 process.exitCode=await runCloudCLI(argv,{context,login:loginCommand,commands});
}
