// `cvm evals ci` and `cvm evals watch`: the pull request check from any CI
// system, and a wait on one run's verdict. The GitHub Action
// (public/integrations/github-action) does the same with the job's OIDC
// token; here the caller is a signed-in person, so nothing is written on
// GitHub and this command's exit code is the gate.
import {globSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {CloudClient,CloudError,inertJSON,runCloudCLI,versionConflictMessage} from '../dist/cloud-client.mjs';

const MAX_REPORTS=20,MAX_REPORT_BYTES=10*1024*1024; // the finish route's own limits
const say=line=>process.stderr.write(line+'\n');
const sha40=value=>/^[0-9a-f]{40}$/.test(value??'')&&!/^0+$/.test(value);
const digits=value=>/^\d+$/.test(value??'')?value:undefined;
const git=(...args)=>{try{return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return '';}};
export const xml=text=>String(text).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'})[c]).replace(/[^\x09\x0a\x0d\x20-퟿-�]/g,'');

// Flags, then CAVE_PROJECT_ID, then the repository's binding, then the saved default.
export async function connect(host,project){
 const cfg=await host();
 let bound;try{bound=JSON.parse(readFileSync('.caveman-cloud.json','utf8')).project_id;}catch{}
 const client=new CloudClient({...cfg,projectId:project??process.env.CAVE_PROJECT_ID??bound??cfg.projectId});
 // A server that no longer speaks this build's operation contract answers a
 // bare 409: say what to do about it in one line.
 const request=client.request.bind(client);
 client.request=async(...args)=>{try{return await request(...args);}catch(error){if(error?.code==='cave_operation_version_conflict')error.message=VERSION_CONFLICT;throw error;}};
 return client;
}
export const VERSION_CONFLICT=versionConflictMessage();
function projectPath(client){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(client.projectId??''))throw new CloudError('cave_project_required','Select a project with --project, CAVE_PROJECT_ID or cvm context bind.',2);
 return `/api/v1/projects/${client.projectId}`;
}
export function seconds(raw,fallback){
 const value=Number(raw??fallback);
 if(!Number.isFinite(value)||value<0||value>86400)throw new CloudError('cave_usage','--timeout is seconds, 0 to 86400.',2);
 return value*1000;
}
function limit(raw,name){
 if(raw===undefined)return undefined;
 const value=Number(raw);
 if(!Number.isFinite(value)||value<0)throw new CloudError('cave_usage',`--${name} must be a number of at least 0.`,2);
 return value;
}
// until reads again, 1 s apart growing to 10 s, until done says so or the
// time is up (undefined).
async function until(read,done,timeoutMs,waiting){
 const deadline=Date.now()+timeoutMs;
 for(let ms=1000;;ms=Math.min(ms*1.5,10000)){
  const value=await read();
  if(done(value))return value;
  if(Date.now()+ms>deadline)return undefined;
  waiting(value);
  await delay(ms);
 }
}

// detectRun reads the commit, branch, pull request and job from the CI
// system's own variables: GitHub Actions, GitLab CI, Buildkite, Jenkins, then
// the checkout itself. A flag wins over all of them.
export function detectRun(env,flags={},{gitRead=git,read=readFileSync}={}){
 const first=(...values)=>values.find(value=>value!==undefined&&value!=='');
 let event={};try{if(env.GITHUB_EVENT_PATH)event=JSON.parse(read(env.GITHUB_EVENT_PATH,'utf8'));}catch{}
 const branch=first(env.CI_COMMIT_REF_NAME,env.BUILDKITE_BRANCH,env.BRANCH_NAME,env.GIT_BRANCH);
 const pr=first(flags.pr,/^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF??'')?.[1],env.CI_MERGE_REQUEST_IID,digits(env.BUILDKITE_PULL_REQUEST),env.CHANGE_ID);
 const run={
  sha:flags.sha??[event.pull_request?.head?.sha,env.GITHUB_SHA,env.CI_COMMIT_SHA,env.BUILDKITE_COMMIT,env.GIT_COMMIT].find(sha40)??gitRead('rev-parse','HEAD'),
  ref:first(flags.ref,env.GITHUB_REF,branch&&`refs/heads/${branch}`)??`refs/heads/${gitRead('rev-parse','--abbrev-ref','HEAD')||'HEAD'}`,
  base_sha:first(flags['base-sha'],[event.pull_request?.base?.sha,event.merge_group?.base_sha,env.CI_MERGE_REQUEST_DIFF_BASE_SHA,event.before].find(sha40)),
  base_ref:first(flags['base-ref'],env.GITHUB_BASE_REF,env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,env.BUILDKITE_PULL_REQUEST_BASE_BRANCH,env.CHANGE_TARGET),
  pr_number:pr===undefined?undefined:Number(pr),
  event:first(flags.event,env.GITHUB_EVENT_NAME==='merge_group'?'merge_group':undefined,pr===undefined?'push':'pull_request'),
  job:first(flags.job,env.GITHUB_JOB,env.CI_JOB_NAME,env.BUILDKITE_STEP_KEY,env.BUILDKITE_LABEL,env.JOB_BASE_NAME,'ci').replace(/[^A-Za-z0-9_-]/g,'-').slice(0,100),
  // run_id and run_attempt only name the run to its reader; the request id is what makes it one run.
  run_id:first(flags['run-id'],digits(env.GITHUB_RUN_ID),digits(env.CI_PIPELINE_ID),digits(env.BUILDKITE_BUILD_NUMBER),digits(env.BUILD_NUMBER),String(Date.now())),
  run_attempt:Number(first(flags['run-attempt'],env.GITHUB_RUN_ATTEMPT,digits(env.BUILDKITE_RETRY_COUNT)&&Number(env.BUILDKITE_RETRY_COUNT)+1,1)),
  repository_id:Number(first(flags['repository-id'],env.GITHUB_REPOSITORY_ID,env.CI_PROJECT_ID,0)),
 };
 for(const key of Object.keys(run))if(run[key]===undefined)delete run[key];
 return run;
}

// collectReports reads the JUnit files the globs match, inside the upload's
// limits. What does not fit is left out and named, never silently truncated.
function collectReports(patterns,cwd){
 const files=[...new Set(patterns.flatMap(pattern=>globSync(pattern,{cwd,exclude:entry=>(entry.name??entry)==='node_modules'})))].sort();
 const reports=[],skipped=[];let bytes=0;
 for(const file of files){
  const text=readFileSync(join(cwd,file),'utf8'),size=Buffer.byteLength(text);
  if(reports.length>=MAX_REPORTS||bytes+size>MAX_REPORT_BYTES){skipped.push(file);continue;}
  bytes+=size;reports.push(text);
 }
 return {reports,skipped};
}

// judge reads a scored run: what fails the gate and why. A gating suite's
// failing check does; so does a limit the caller set. The limits only add a
// failure and --advisory only spares the job: the verdict stays Caveman's.
export function judge(answer,{advisory=false,maxQualityDropPP,maxCostIncreasePct}={}){
 const reasons=[];
 if(answer.mode==='gate'&&['failure','action_required'].includes(answer.conclusion))reasons.push(`the gating suite's check concluded ${answer.conclusion}`);
 const {quality,cost}=answer.check??{};
 if(maxQualityDropPP!==undefined&&quality&&quality.estimate<-maxQualityDropPP)reasons.push(`test pass rate moved ${quality.estimate.toFixed(1)} pp, past --max-quality-drop-pp ${maxQualityDropPP}`);
 if(maxCostIncreasePct!==undefined&&cost&&cost.estimate>maxCostIncreasePct)reasons.push(`cost moved ${cost.estimate>0?'+':''}${cost.estimate.toFixed(1)}%, past --max-cost-increase-pct ${maxCostIncreasePct}`);
 return {reasons,failed:reasons.length>0&&!advisory};
}

// verdictJUnit is the verdict as one JUnit test case, for a CI system that
// shows test reports: failed when the gate failed, skipped with no verdict.
export function verdictJUnit(suite,answer,verdict){
 const check=answer.check,name=check?.title??'No verdict yet';
 const body=!check?`<skipped message="${xml('No verdict within the wait; read it with cvm evals watch '+answer.run.id)}"/>`
  :verdict.failed?`<failure message="${xml(verdict.reasons.join('; '))}">${xml(check.sentence)}</failure>`:'';
 return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml('Caveman / '+suite)}" tests="1" failures="${check&&verdict.failed?1:0}" skipped="${check?0:1}">\n`+
  `  <testcase classname="${xml('caveman.'+suite)}" name="${xml(name)}">${body}<system-out>${xml([check?.summary,answer.details_url].filter(Boolean).join('\n\n'))}</system-out></testcase>\n</testsuite>\n`;
}

const ciUsage='cvm evals ci FILE.eval.json... (eval files: cvm evals ci FILE --help)  or  cvm evals ci [--suite NAME] [--junit GLOB]... [--junit-out PATH|-] [--advisory] [--max-usd N] [--max-quality-drop-pp N] [--max-cost-increase-pct N] [--timeout SECONDS] [--repository-id N] [--sha SHA] [--ref REF] [--base-sha SHA] [--base-ref REF] [--pr N] [--event push|pull_request|merge_group] [--job NAME] [--run-id N] [--run-attempt N] [--project UUID] -- TEST COMMAND';
const text={type:'string'};

export async function evalsCI(argv,{context}){
 const split=argv.indexOf('--');
 // Eval files instead of a test command: each is run and gated by cvm evals run's own path.
 if(split<0&&argv.some(arg=>!arg.startsWith('-')&&arg.endsWith('.json')))return (await import('./evals.mjs')).evalsRun(argv,{context},{ci:true});
 try{
  const {values}=parseArgs({args:split<0?argv:argv.slice(0,split),strict:true,allowPositionals:false,options:{suite:text,junit:{type:'string',multiple:true},'junit-out':text,advisory:{type:'boolean'},'max-usd':text,
   'max-quality-drop-pp':text,'max-cost-increase-pct':text,timeout:text,'repository-id':text,sha:text,ref:text,'base-sha':text,'base-ref':text,pr:text,event:text,job:text,'run-id':text,'run-attempt':text,project:text,help:{type:'boolean'}}});
  if(values.help){process.stdout.write(inertJSON({usage:ciUsage,exit_codes:'the test command\'s own when it fails; else 0 no gate failed (always with --advisory), 5 the gate failed, 6 a gating suite had no verdict within --timeout'},2)+'\n');return 0;}
  const command=split<0?[]:argv.slice(split+1);
  if(!command.length)throw new CloudError('cave_usage',ciUsage,2);
  const timeoutMs=seconds(values.timeout,180);
  const limits={advisory:!!values.advisory,maxQualityDropPP:limit(values['max-quality-drop-pp'],'max-quality-drop-pp'),maxCostIncreasePct:limit(values['max-cost-increase-pct'],'max-cost-increase-pct')};
  const run=detectRun(process.env,values);
  const suite=values.suite??run.job;
  const body={request_id:randomUUID(),...run,suite:{name:suite},...(values['max-usd']===undefined?{}:{max_usd:limit(values['max-usd'],'max-usd')})};
  if(!sha40(run.sha))throw new CloudError('cave_usage','No commit found: run inside the checkout or pass --sha with the full commit.',2);
  if(!(run.repository_id>0))throw new CloudError('cave_usage','Pass --repository-id: the numeric id of the repository connected to this project (gh api repos/OWNER/NAME --jq .id). GitHub Actions and GitLab CI supply it themselves.',2);

  // Start. With --advisory Caveman never fails the job, an unreachable or
  // refusing API included: the tests then run unmeasured.
  let client,base,started;
  try{
   client=await connect(context,values.project);base=projectPath(client)+'/ci/runs';
   started=await client.request(base,{body});
  }catch(error){
   if(!limits.advisory||error.exitCode===2&&error.code==='cave_usage')throw error;
   say(`caveman: ${error.code??'cave_request_failed'}: ${error.message} The tests run unmeasured (--advisory).`);
  }
  const env={...process.env};
  if(started?.key){
   Object.assign(env,{CAVE_API_KEY:started.key.token,CAVE_CI_RUN_ID:started.run.id},started.key.gateway_url?{CAVE_GATEWAY_URL:started.key.gateway_url}:{});
   say(`caveman: run ${started.run.id} started, ${started.mode} mode, baseline ${started.baseline?.match}, key capped at $${started.key.max_usd}.`);
  }else if(started)say(`caveman: run ${started.run.id} has no key; its model calls are not measured.`);

  // Windows runs a .cmd shim through cmd.exe with every argument quoted.
  const child=process.platform==='win32'
   ?spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c',`"${command.map(arg=>`"${String(arg).replaceAll('"','""')}"`).join(' ')}"`],{stdio:'inherit',env,windowsVerbatimArguments:true})
   :spawnSync(command[0],command.slice(1),{stdio:'inherit',env});
  if(child.error)say(`caveman: could not run ${command[0]}: ${child.error.message}`);
  const commandExit=child.status??(child.error?127:1);
  if(!started)return commandExit;

  const status=child.signal?'cancelled':commandExit===0?'completed':'failed';
  const patterns=values.junit?.length?values.junit:['**/junit*.xml'];
  const {reports,skipped}=collectReports(patterns,process.cwd());
  if(skipped.length)say(`caveman: ${skipped.length} JUnit reports were over the upload limit (20 files, 10 MiB) and were left out: ${skipped.join(', ')}`);
  if(!reports.length)say(`caveman: no JUnit report matched ${patterns.join(', ')}; there are no tests to compare.`);
  const finish=`${base}/${started.run.id}/finish`;
  let answer;
  try{
   answer=await client.request(finish,{body:{status,junit:reports}});
   say(`caveman: uploaded ${reports.length} JUnit reports for run ${started.run.id}.`);
   // A closed run is returned unchanged: repeating the finish reads its verdict.
   if(status!=='cancelled'&&timeoutMs>0)answer=await until(()=>client.request(finish,{body:{status}}),a=>a.run?.status==='complete',timeoutMs,()=>say('caveman: scoring…'))??answer;
  }catch(error){
   if(!limits.advisory)throw error;
   say(`caveman: ${error.code??'cave_request_failed'}: ${error.message} (--advisory: the job is not failed).`);
   return commandExit;
  }
  const mode=answer.mode??started.mode;
  const verdict=answer.check?judge({...answer,mode},limits):{reasons:[],failed:false};
  if(answer.check){
   say(`caveman: ${answer.check.title} (${mode} mode). ${answer.check.sentence}`);
   if(answer.check.summary)say('\n'+answer.check.summary+'\n');
  }else if(status!=='cancelled')say(`caveman: no verdict for run ${started.run.id} yet. Read it later with: cvm evals watch ${started.run.id} --project ${client.projectId}`);
  for(const reason of verdict.reasons)say(`caveman: ${reason}${verdict.failed?'':' (--advisory: the job is not failed)'}.`);
  if(answer.details_url)say(`caveman: ${answer.details_url}`);
  // A gating suite with no verdict has not passed: this exit code is its gate.
  const unread=!answer.check&&status!=='cancelled'&&timeoutMs>0&&mode==='gate'&&!limits.advisory;
  const exit=commandExit!==0?commandExit:verdict.failed?5:unread?6:0;
  const report=verdictJUnit(suite,answer,verdict);
  if(values['junit-out']&&values['junit-out']!=='-')writeFileSync(values['junit-out'],report);
  process.stdout.write(values['junit-out']==='-'?report:inertJSON({schema_version:1,ok:exit===0,run_id:started.run.id,suite,mode,status:answer.run?.status,conclusion:answer.conclusion??null,
   verdict:answer.check?{kind:answer.check.kind,title:answer.check.title,sentence:answer.check.sentence,quality:answer.check.quality??null,cost:answer.check.cost??null}:null,
   details_url:answer.details_url??null,advisory:limits.advisory,failed:verdict.failed,reasons:verdict.reasons,command_exit:commandExit})+'\n');
  return exit;
 }catch(error){
  const e=error instanceof CloudError?error:new CloudError('cave_usage',error.message??'Command failed.',2);
  process.stdout.write(inertJSON({schema_version:1,ok:false,status:'failed',error:{code:e.code,message:e.message}})+'\n');return e.exitCode;
 }
}

const watchUsage='cvm evals watch RUN_ID [--source eval_run|experiment|scenario_run] [--timeout SECONDS] [--project UUID]  or  cvm evals watch WORKBENCH_ID RUN_ID [--timeout SECONDS] [--project UUID]';

// evalsWatch waits for one run's verdict. Exit 0 ship, pass or skipped; 5
// don't ship, or a gating check that failed; 6 need more data, or no verdict
// within --timeout (the run continues).
export async function evalsWatch(argv,{context,login}){
 try{
  const {values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{source:text,timeout:text,project:text,format:text,help:{type:'boolean'}}});
  if(values.help){process.stdout.write(inertJSON({usage:watchUsage,exit_codes:'0 ship, pass or skipped; 5 don\'t ship or a failed gate; 6 need more data, or no verdict within --timeout'},2)+'\n');return 0;}
  const timeoutMs=seconds(values.timeout,3600);
  // A workbench run named with its workbench is the client's own wait, cell progress included.
  if(positionals.length===2)return runCloudCLI(['evals','wait',...positionals,'--wait-timeout',String(Math.max(1,timeoutMs)),...(values.project?['--project',values.project]:[]),...(values.format?['--format',values.format]:[])],{context,login});
  if(positionals.length!==1)throw new CloudError('cave_usage',watchUsage,2);
  const client=await connect(context,values.project),input={source:values.source??'eval_run',run_id:positionals[0]};
  projectPath(client);
  let last='';
  const tell=line=>{if(line!==last)say(`caveman: ${last=line}`);};
  // A run that has not produced a verdict row yet reads as not found.
  const read=()=>client.execute('verdicts.get',input).catch(error=>{if(error.code!=='cave_not_found')throw error;return undefined;});
  const result=await until(read,r=>r&&r.data.state!=='running',timeoutMs,r=>tell(r?`${r.data.label}: running`:'no verdict yet'));
  if(!result)throw new CloudError('cave_wait_timeout',`No verdict for run ${input.run_id} within the wait; the run continues. Reconnect with cvm evals watch ${input.run_id}.`,6);
  const {verdict,gate,label,sentence}=result.data;
  tell(`${label}: ${verdict}. ${sentence}`);
  process.stdout.write(inertJSON(result)+'\n');
  if(verdict==='dont_ship'||gate?.mode==='gate'&&['failure','action_required'].includes(gate.conclusion))return 5;
  return ['ship','pass','skipped'].includes(verdict)?0:6;
 }catch(error){
  const e=error instanceof CloudError?error:new CloudError('cave_usage',error.message??'Command failed.',2);
  process.stdout.write(inertJSON({schema_version:1,ok:false,status:'failed',error:{code:e.code,message:e.message}})+'\n');return e.exitCode;
 }
}
