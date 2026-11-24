// `cvm evals init|validate|run` and the eval files of `cvm evals ci`: one eval
// as a repository file (*.eval.json; its schema is eval-file.schema.json in
// public/shared/contracts/schemas). The file's name is the experiment, found
// or created by that name, so every run lines up with the last. A command
// task runs here and its outputs go up with the run; Caveman grades them and
// reads the run against the experiment's saved baseline. The verdict and its
// numbers are the server's: nothing here computes a comparison.
import {globSync,readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {connect,detectRun,seconds,xml} from './ci.mjs';

const KEY=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_OUTPUT=1024*1024; // characters of one task output; a run's upload is capped at 16 MiB
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// The fixed checks and the options each takes: the criterion registry
// generated from the server at this release,
// copied beside the client when cvm is built. A trajectory rule or code is a
// library criterion, named in a file, never a fixed check.
let checks;
const fixedChecks=()=>checks??=new Map(JSON.parse(readFileSync(new URL('../dist/criterion-registry.json',import.meta.url),'utf8')).kinds.filter(kind=>kind.kind==='output_grader'||kind.kind==='question').map(kind=>[kind.id,kind]));

// validateEvalFile checks a parsed file against eval-file.schema.json, plus
// what that schema cannot say (unique case ids, a recorded task's outputs, a
// fixed check's type and options). Every error names the JSON path it is about.
export function validateEvalFile(doc){
 const errors=[],bad=(path,message)=>{errors.push({path,message});};
 const fields=(value,path,required,optional=[])=>{
  if(!isObject(value)){bad(path,'must be an object');return false;}
  for(const key of Object.keys(value))if(!required.includes(key)&&!optional.includes(key))bad(`${path}.${key}`,`is not a field here; the fields are ${[...required,...optional].join(', ')}`);
  for(const key of required)if(value[key]===undefined)bad(`${path}.${key}`,'is required');
  return true;
 };
 const text=(value,path,max)=>{if(value!==undefined&&(typeof value!=='string'||!value.length||value.length>max))bad(path,`must be text of 1 to ${max} characters`);};
 const number=(value,path,min,max,whole=true)=>{if(value!==undefined&&(typeof value!=='number'||whole&&!Number.isInteger(value)||!(value>=min&&value<=max)))bad(path,`must be a ${whole?'whole ':''}number from ${min} to ${max}`);};
 const key=(value,path)=>{if(value!==undefined&&(typeof value!=='string'||!KEY.test(value)))bad(path,'must be 1 to 96 letters, digits, _ or -, starting with a letter or digit');};
 const list=(value,path,min,max)=>{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length<min||value.length>max){bad(path,max===Infinity?`must be a list of at least ${min} item`:`must be a list of ${min} to ${max} items`);return [];}
  return value;
 };

 if(!fields(doc,'$',['name','dataset','task','criteria'],['$schema','trials','gate','budget_usd']))return errors;
 if(doc.$schema!==undefined&&typeof doc.$schema!=='string')bad('$.$schema','must be text');
 text(doc.name,'$.name',200);
 number(doc.trials,'$.trials',1,10);
 number(doc.budget_usd,'$.budget_usd',0,1000,false);

 const {dataset,task,gate}=doc;
 const inline=isObject(dataset)&&dataset.cases!==undefined;
 if(inline){
  fields(dataset,'$.dataset',['cases']);
  const seen=new Map();
  for(const [i,item] of list(dataset.cases,'$.dataset.cases',1,10000).entries()){
   const path=`$.dataset.cases[${i}]`;
   if(!fields(item,path,['id','input'],['expected','output','tags']))continue;
   key(item.id,`${path}.id`);
   if(seen.has(item.id))bad(`${path}.id`,`repeats the id of $.dataset.cases[${seen.get(item.id)}]`);else seen.set(item.id,i);
   const tags=list(item.tags,`${path}.tags`,0,32);
   for(const [j,tag] of tags.entries())text(tag,`${path}.tags[${j}]`,100);
   if(new Set(tags).size!==tags.length)bad(`${path}.tags`,'names a tag twice');
  }
 }else if(isObject(dataset)&&dataset.name!==undefined){
  fields(dataset,'$.dataset',['name'],['version']);
  text(dataset.name,'$.dataset.name',200);
  number(dataset.version,'$.dataset.version',1,Number.MAX_SAFE_INTEGER);
 }else if(dataset!==undefined)bad('$.dataset','needs cases (written here) or name (a dataset of the project)');

 if(isObject(task)&&task.command!==undefined){
  fields(task,'$.task',['command'],['concurrency','timeout_seconds','retries']);
  for(const [i,arg] of list(task.command,'$.task.command',1,Infinity).entries())if(typeof arg!=='string'||!arg)bad(`$.task.command[${i}]`,'must be text');
  number(task.concurrency,'$.task.concurrency',1,64);
  number(task.retries,'$.task.retries',0,10);
  number(task.timeout_seconds,'$.task.timeout_seconds',0,3600,false);
  if(task.timeout_seconds===0)bad('$.task.timeout_seconds','must be over 0');
 }else if(isObject(task)&&task.recorded!==undefined){
  fields(task,'$.task',['recorded']);
  key(task.recorded,'$.task.recorded');
  if(inline&&Array.isArray(dataset.cases)){
   if(task.recorded!=='output')bad('$.task.recorded','must be "output": a case written in the file carries its recorded output as output');
   for(const [i,item] of dataset.cases.entries())if(isObject(item)&&item.output===undefined)bad(`$.dataset.cases[${i}].output`,'is required: the task reads recorded outputs');
  }
 }else if(isObject(task)&&task.kind!==undefined){
  fields(task,'$.task',['kind','config'],['input_mapping']);
  if(!['model','prompt','http'].includes(task.kind))bad('$.task.kind','must be model, prompt or http');
  if(task.config!==undefined&&!isObject(task.config))bad('$.task.config','must be an object');
  if(task.input_mapping!==undefined){
   if(!isObject(task.input_mapping))bad('$.task.input_mapping','must be an object');
   else for(const [name,column] of Object.entries(task.input_mapping))key(column,`$.task.input_mapping.${name}`);
  }
 }else if(task!==undefined)bad('$.task','needs command (run here), recorded (a dataset column) or kind (a target Caveman runs)');

 for(const [i,criterion] of list(doc.criteria,'$.criteria',1,24).entries()){
  const path=`$.criteria[${i}]`;
  if(typeof criterion==='string')text(criterion,path,200);
  else if(isObject(criterion)&&criterion.judge!==undefined){
   fields(criterion,path,['judge'],['name']);
   text(criterion.name,`${path}.name`,200);
   if(fields(criterion.judge,`${path}.judge`,['question'],['pass','fail'])){
    text(criterion.judge.question,`${path}.judge.question`,500);
    text(criterion.judge.pass,`${path}.judge.pass`,1000);
    text(criterion.judge.fail,`${path}.judge.fail`,1000);
   }
  }else if(isObject(criterion)&&criterion.type!==undefined){
   text(criterion.type,`${path}.type`,100);
   text(criterion.name,`${path}.name`,200);
   const check=fixedChecks().get(criterion.type);
   if(!check){if(typeof criterion.type==='string'&&criterion.type)bad(`${path}.type`,`"${criterion.type}" is no fixed check; cvm criteria catalog lists them`);continue;}
   const known=check.options.map(option=>option.name);
   for(const option of check.options)if(option.required&&criterion[option.name]===undefined)bad(`${path}.${option.name}`,`is required by ${criterion.type}`);
   if(!check.extra_options)for(const option of Object.keys(criterion))if(option!=='type'&&option!=='name'&&!known.includes(option))bad(`${path}.${option}`,`is not an option of ${criterion.type}; ${known.length?`its options are ${known.join(', ')}`:'it takes none'}`);
  }else bad(path,'must be a library criterion name, a fixed check ({"type": ...}) or a judge question ({"judge": ...})');
 }

 if(gate!==undefined&&fields(gate,'$.gate',[],['baseline','policy'])){
  if(gate.baseline!==undefined&&gate.baseline!=='saved'&&!(typeof gate.baseline==='string'&&UUID.test(gate.baseline)))bad('$.gate.baseline','must be "saved" or the id of a run of this experiment');
  if(gate.policy!==undefined&&!['statistical','strict'].includes(gate.policy))bad('$.gate.policy','must be statistical or strict');
 }
 return errors;
}

// readEvalFile reads and validates one file. A file that cannot be read or
// parsed is one error at the root.
function readEvalFile(file){
 let doc;
 try{doc=JSON.parse(readFileSync(file,'utf8'));}
 catch(error){return {file,errors:[{path:'$',message:error instanceof SyntaxError?`is not JSON: ${error.message}`:`cannot be read: ${error.code??error.message}`}]};}
 return {file,doc,errors:validateEvalFile(doc)};
}

// loadCases is the file's cases as dataset columns and rows: written in the
// file, or read from the project's dataset of that name. Rows are read only
// for a command task, which runs here on them; for a task Caveman runs, the
// dataset's columns and the version's identity are enough, and those any
// sign-in that may run an eval can read.
async function loadCases(doc,cloud){
 const {dataset,task}=doc;
 if(dataset.cases){
  const has=key=>dataset.cases.some(item=>item[key]!==undefined);
  return {errors:[],columns:[{key:'input',name:'Input',type:'json',role:'input'},...(has('expected')?[{key:'expected',name:'Expected',type:'json',role:'expected'}]:[]),...(has('output')?[{key:'output',name:'Output',type:'json',role:'output'}]:[])],
   rows:dataset.cases.map(item=>({row_key:item.id,values:{input:item.input,...(item.expected!==undefined?{expected:item.expected}:{}),...(item.output!==undefined?{output:item.output}:{})},...(item.tags?.length?{tags:item.tags}:{})}))};
 }
 const client=await cloud();
 // ponytail: datasets.list takes no cursor, so only its first page is searched (the SDKs' ceiling too); page here when it does.
 const found=((await client.execute('datasets.list',{})).data.data??[]).find(item=>item.name.toLowerCase()===dataset.name.toLowerCase());
 if(!found)return {errors:[{path:'$.dataset.name',message:`no dataset named "${dataset.name}" in this project`}]};
 const reference={key:'cases',dataset_id:found.id},noVersion={errors:[{path:'$.dataset.version',message:`dataset "${found.name}" has no version ${dataset.version}`}]};
 let columns,rows=[];
 if(!task.command){
  // ponytail: a pinned version is checked against the columns of the dataset's head; the server checks the version's own when the experiment is saved.
  columns=found.columns??[];
  if(dataset.version!==undefined){
   const version=((await client.execute('datasets.versions',{dataset_id:found.id})).data.data??[]).find(item=>item.version===dataset.version);
   if(!version)return noVersion;
   Object.assign(reference,{version:version.version,document_sha256:version.document_sha256});
  }
 }else{
  let detail;
  try{detail=(await client.execute('datasets.get',{dataset_id:found.id})).data;}
  catch(error){
   // Rows are captured content: a project key and a member below admin read none.
   if(!['cave_api_key_route_forbidden','cave_operation_forbidden','cave_forbidden'].includes(error.code))throw error;
   return {errors:[{path:'$.dataset.name',message:'this sign-in reads no dataset rows, and a command task runs here on them: write the cases in the file, or run it as an owner or admin'}]};
  }
  columns=detail.dataset.columns;rows=[...(detail.rows??[])].sort((a,b)=>a.position-b.position).map(row=>({row_key:row.row_key,values:row.values}));
  if(dataset.version!==undefined){
   const version=(detail.versions??[]).find(item=>item.version===dataset.version);
   if(!version)return noVersion;
   columns=version.document.columns;rows=version.document.rows;
   Object.assign(reference,{version:version.version,document_sha256:version.document_sha256});
  }
 }
 if(task.recorded&&!columns.some(column=>column.key===task.recorded))return {errors:[{path:'$.task.recorded',message:`dataset "${found.name}" has no column "${task.recorded}"`}]};
 return {errors:[],columns,rows,reference};
}

const slug=value=>value.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64)||'criterion';

// resolveCriteria turns the file's criteria into the experiment's evaluators:
// a library criterion at its current version, a fixed check or a judge question on
// the task's output. Keys are slugs of the names, sorted, as the SDKs write
// them: two runs compare when their criteria are the same, in any order.
async function resolveCriteria(doc,columns,cloud){
 const errors=[],drafts=[];
 const expected=columns.find(column=>column.role==='expected')?.key;
 const input_mapping={candidate:{source:'target',key:'$target'},...(expected?{reference:{source:'dataset',key:expected}}:{})};
 for(const [i,criterion] of doc.criteria.entries()){
  const path=`$.criteria[${i}]`;
  if(typeof criterion!=='string'){
   if(criterion.judge){
    const {question,pass,fail}=criterion.judge;
    drafts.push({name:criterion.name??question.slice(0,200),source:'inline',grader_type:'llm_judge',options:{rubric:[question,pass&&`Pass: ${pass}`,fail&&`Fail: ${fail}`].filter(Boolean).join('\n')},input_mapping});
   }else{
    const {type,name,...options}=criterion;
    drafts.push({name:name??type,source:'inline',grader_type:type,options,input_mapping});
   }
   continue;
  }
  const client=await cloud();
  let found;
  if(UUID.test(criterion)){
   try{found=[(await client.execute('criteria.get',{criterion_id:criterion})).data];}
   catch(error){if(error.code!=='cave_not_found')throw error;found=[];}
  }else{
   // Every state is read so a criterion that exists but is not on is named as such.
   const named=((await client.execute('criteria.list',{q:criterion,state:'all',limit:100})).data.data??[]).filter(item=>item.name.toLowerCase()===criterion.toLowerCase());
   found=named.filter(item=>(item.state??'active')==='active');
   if(!found.length&&named.length){errors.push({path,message:`"${criterion}" is ${named[0].state} in this project's library, not on: a person turns it on (console, Criteria) before a run can use it`});continue;}
  }
  if(found.length!==1)errors.push({path,message:found.length?`"${criterion}" names ${found.length} criteria of this project's library; use the id of one`:`no criterion named "${criterion}" in this project's library`});
  else drafts.push({name:found[0].name,source:'criterion',criterion_id:found[0].id,criterion_version:found[0].version});
 }
 const taken=new Set();
 const evaluators=drafts.map(draft=>{
  let key=slug(draft.name);
  for(let count=2;taken.has(key);count++)key=`${slug(draft.name)}_${count}`;
  taken.add(key);
  return {key,...draft};
 }).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 return {errors,evaluators};
}

function target(task){
 if(task.command)return {key:'local_task',name:'Local task (run by cvm)',kind:'external',input_mapping:{},config:{}};
 if(task.recorded)return {key:'recorded',name:'Recorded output',kind:'recorded',input_mapping:{},config:{output_column:task.recorded}};
 return {key:'task',name:`${task.kind} task`,kind:task.kind,input_mapping:task.input_mapping??{},config:task.config};
}

// One input column is the task's input; several are an object by column key.
function taskInput(columns,values){
 const keys=columns.filter(column=>column.role==='input').map(column=>column.key);
 return keys.length===1?values[keys[0]]:Object.fromEntries(keys.map(key=>[key,values[key]]));
}

// pick narrows the cases for --first or --sample. A sample is a seeded
// shuffle (mulberry32), so the same seed takes the same cases again.
export function pick(rows,{first,sample,seed=0}){
 if(first!==undefined)return rows.slice(0,first);
 if(sample===undefined)return rows;
 let state=seed>>>0;
 const random=()=>{state=state+0x6D2B79F5|0;let t=Math.imul(state^state>>>15,1|state);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
 const pool=[...rows];
 for(let i=pool.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
 return pool.slice(0,sample);
}

// runCommand runs the task once: the input as JSON on stdin, the output from
// stdout (JSON when it parses, else the text). A non-zero exit, a timeout or
// an output over the limit is a task error. The command is run directly,
// never through a shell.
function runCommand(command,input,timeoutMs){
 return new Promise(resolve=>{
  const started=Date.now(),child=spawn(command[0],command.slice(1),{stdio:['pipe','pipe','pipe']});
  let out='',err='',done=false;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve({...result,latency_ms:Date.now()-started});};
  const stop=error=>{child.kill('SIGKILL');finish({error});};
  const timer=setTimeout(()=>stop(`the task took longer than ${timeoutMs/1000} s`),timeoutMs);
  child.stdout.on('data',chunk=>{if((out+=chunk).length>MAX_OUTPUT)stop('the task wrote more than 1 MiB to stdout');});
  child.stderr.on('data',chunk=>{err=(err+chunk).slice(-1500);});
  child.on('error',error=>finish({error:`could not run ${command[0]}: ${error.message}`}));
  child.on('close',(code,signal)=>{
   if(code!==0)return finish({error:`exit ${code??signal}${err.trim()?': '+err.trim():''}`});
   let output=out.replace(/\r?\n$/,'');
   try{output=JSON.parse(out);}catch{}
   finish({output});
  });
  child.stdin.on('error',()=>{}); // a task that exits without reading its input
  child.stdin.end(JSON.stringify(input)??'null');
 });
}

// runTask runs the command over every case and trial, a bounded number at a
// time. Only a task error is tried again; the attempts are kept.
async function runTask(task,units,runOne,onDone){
 const {command,concurrency=4,retries=2,timeout_seconds=120}=task,results=new Array(units.length);
 let next=0,finished=0;
 await Promise.all(Array.from({length:Math.min(concurrency,units.length)},async()=>{
  for(let i;(i=next++)<units.length;){
   let result,attempts=0;
   do{result=await runOne(command,units[i].input,timeout_seconds*1000);attempts++;}while(result.error!==undefined&&attempts<=retries);
   const {row_key,trial}=units[i],{error,output,latency_ms}=result;
   results[i]={row_key,trial,attempts,...(latency_ms===undefined?{}:{latency_ms}),...(error===undefined?{output}:{error:String(error).slice(0,2000)})};
   onDone(++finished,units.length);
  }
 }));
 return results;
}

// tally reads marks (one per case, trial and criterion) into the report's
// rows: how many trials passed, failed or errored, and why those that did.
function tally(caseIds,criteria,marks){
 const zero=()=>Object.fromEntries(criteria.map(criterion=>[criterion.key,{passed:0,failed:0,errors:0}]));
 const cases=new Map(caseIds.map(id=>[id,zero()])),totals=zero(),rationales=[];
 for(const mark of marks){
  if(!totals[mark.key])continue;
  if(!cases.has(mark.case))cases.set(mark.case,zero());
  cases.get(mark.case)[mark.key][mark.result]++;totals[mark.key][mark.result]++;
  if(mark.result!=='passed')rationales.push({case:mark.case,criterion:criteria.find(criterion=>criterion.key===mark.key).name,trial:mark.trial,result:mark.result==='errors'?'error':'fail',reason:mark.reason||null,
   // The judge's own words and how it produced them; reason is Caveman's sentence about the verdict.
   ...(mark.rationale?{rationale:mark.rationale,rationale_kind:mark.rationale_kind??null}:{})});
 }
 return {cases:[...cases].map(([id,counts])=>({id,criteria:counts})),rationales,
  criteria:criteria.map(({key,name})=>{const count=totals[key],graded=count.passed+count.failed;return {key,name,...count,pass_rate:graded?count.passed/graded:null};})};
}

// A cell whose task did not finish is an error on every criterion.
function cellMarks(cells,criteria){
 const marks=[];
 for(const cell of cells){
  const at={case:cell.dataset_row_key,trial:cell.trial??1};
  if(cell.status!=='completed'){for(const {key} of criteria)marks.push({...at,key,result:'errors',reason:cell.error_message??`the task did not finish (${cell.status})`});continue;}
  for(const graded of Array.isArray(cell.evaluator_results)?cell.evaluator_results:[])
   marks.push({...at,key:graded.key,result:graded.status!=='completed'||typeof graded.passed!=='boolean'?'errors':graded.passed?'passed':'failed',reason:graded.reason??graded.error_code,rationale:graded.rationale,rationale_kind:graded.rationale_kind});
 }
 return marks;
}

// exitFor is the exit code of a file's status: 0 passed or nothing to gate,
// 5 the gate failed, 6 no verdict (more data needed, not comparable, outputs
// that could not all be graded), 2 an invalid file, 1 anything that crashed.
export const exitFor=status=>({passed:0,not_gated:0,no_baseline:0,partial:0,dry_run:0,failed:5,need_more_data:6,incomplete:6,not_comparable:6,invalid:2})[status]??1;

// The eval file's word for a gate policy, and the API's.
const POLICY_ON_WIRE={statistical:'kernel',strict:'strict'};
const STATUS_WORDS={valid:'Valid',passed:'Passed',failed:'Failed',need_more_data:'Need more data',incomplete:'No verdict',not_comparable:'Not compared',no_baseline:'No baseline yet',not_gated:'Not gated',partial:'Partial run',dry_run:'Dry run',invalid:'Invalid',error:'Error'};
const BASELINE_WORDS={experiment:'saved for this experiment',project:'the project default',query:'named in the file'};
const RATIONALE_WORDS={reasoned_before:'reasoned first',explained_after:'explained afterwards'};
const judgeLine=why=>`Judge${RATIONALE_WORDS[why.rationale_kind]?` (${RATIONALE_WORDS[why.rationale_kind]})`:''}: ${why.rationale}`;

// commitScope is a CI run (detectRun) as a run's scope carries it: the commit,
// ref, base and pull request, each only in the shape the server takes.
// Undefined when none is.
export function commitScope(run={}){
 const sha=value=>/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value??'')&&!/^0+$/.test(value),ref=value=>typeof value==='string'&&/^\S{1,255}$/.test(value)&&value!=='refs/heads/HEAD';
 const commit={...(sha(run.sha)?{sha:run.sha}:{}),...(ref(run.ref)?{ref:run.ref}:{}),...(sha(run.base_sha)?{base_sha:run.base_sha}:{}),...(ref(run.base_ref)?{base_ref:run.base_ref}:{}),
  ...(Number.isInteger(run.pr_number)&&run.pr_number>0?{pr_number:run.pr_number}:{})};
 return Object.keys(commit).length?commit:undefined;
}

// runEvalFile takes one valid file from nothing to a verdict. flags:
// {dryRun, trials, first, sample, seed, setBaseline, timeoutMs, projectKey, commit}.
// projectKey: the sign-in is a project API key, whose runs need a budget and
// whose reads carry no reasons. commit: commitScope of a run in CI. cloud()
// gives the signed-in client and is
// only called when the server is needed.
export async function runEvalFile(file,doc,flags,deps){
 const report={schema_version:1,ok:false,file,name:doc.name,status:'error',exit_code:1,sentence:'',partial:flags.first!==undefined||flags.sample!==undefined,trials:flags.trials??doc.trials??1,...(flags.sample!==undefined?{seed:flags.seed}:{})};
 try{return await runInto(report,doc,flags,deps);}
 catch(error){
  // What was reached stays on the report: a run that outlives the wait keeps its id.
  const e=error instanceof CloudError?error:new CloudError('cave_eval_crashed',error.message??'The eval crashed.',1);
  return Object.assign(report,{ok:false,status:'error',exit_code:e.exitCode,sentence:e.message,error:{code:e.code,message:e.message}});
 }
}
async function runInto(report,doc,flags,{cloud,runOne=runCommand,progress=()=>{},consoleURL}){
 const {trials,partial}=report;
 const end=(status,sentence,more={})=>Object.assign(report,more,{status,sentence,exit_code:exitFor(status),ok:exitFor(status)===0});
 if(partial&&!doc.task.command)return end('invalid','',{errors:[{path:'$.task',message:'--first and --sample need a command task: Caveman runs every case of a recorded, model, prompt or http task'}]});
 // The server refuses such a run; said here, before the task runs or anything is written.
 if(flags.projectKey&&!flags.dryRun&&doc.budget_usd===undefined)return end('invalid','',{errors:[{path:'$.budget_usd',message:'is required when a project key runs the file: every run a key starts is given a budget, held against the key\'s limit for the day'}]});

 const loaded=await loadCases(doc,cloud);
 if(loaded.errors.length)return end('invalid','',{errors:loaded.errors});
 const rows=pick(loaded.rows,flags);
 const units=rows.flatMap(row=>Array.from({length:trials},(_,i)=>({row_key:row.row_key,trial:i+1,input:taskInput(loaded.columns,row.values)})));
 const caseIds=rows.map(row=>row.row_key);
 const runLocally=()=>runTask(doc.task,units,runOne,(done,total)=>progress(`${doc.name}: task ${done}/${total}`));

 if(flags.dryRun){
  const outputs=doc.task.command?await runLocally():[],ran=[{key:'task',name:'Task ran'}];
  Object.assign(report,tally(caseIds,ran,outputs.map(output=>({case:output.row_key,trial:output.trial,key:'task',result:output.error===undefined?'passed':'errors',reason:output.error}))),{outputs});
  const failed=outputs.filter(output=>output.error!==undefined).length;
  if(failed)return end('incomplete',`Dry run: the task failed on ${failed} of ${outputs.length} runs. Nothing was sent to Caveman.`);
  return end('dry_run',doc.task.command?'Dry run: the task ran here and nothing was sent to Caveman, so nothing was graded.':'Dry run: Caveman runs this task, so nothing ran here and nothing was sent.');
 }

 const resolved=await resolveCriteria(doc,loaded.columns,cloud);
 if(resolved.errors.length)return end('invalid','',{errors:resolved.errors});
 const client=await cloud(),request=randomUUID(),criteria=resolved.evaluators.map(({key,name})=>({key,name}));
 const description=`Eval file "${doc.name}", run by cvm.`;
 progress(`${doc.name}: saving the dataset and the experiment`);
 const reference=loaded.reference??{key:'cases',dataset_id:(await client.execute('datasets.create',{name:doc.name,description,upsert:true,document:{schema_version:1,columns:loaded.columns,rows:loaded.rows}},{idempotencyKey:`${request}:dataset`})).data.id};
 const workbenchId=(await client.execute('evals.create',{name:doc.name,description,upsert:true,document:{schema_version:1,datasets:[reference],targets:[target(doc.task)],evaluators:resolved.evaluators}},{idempotencyKey:`${request}:experiment`})).data.id;
 // The file's gate policy is stored on the experiment, so the console, the
 // SDKs and this run all read a comparison by the same rule.
 if(doc.gate?.policy)await client.execute('evals.set_baseline',{workbench_id:workbenchId,gate_policy:POLICY_ON_WIRE[doc.gate.policy]});
 Object.assign(report,{dataset_id:reference.dataset_id,experiment_id:workbenchId,url:consoleURL?`${consoleURL.replace(/\/+$/,'')}/experiments/workbenches/${workbenchId}`:null});

 const outputs=doc.task.command?await runLocally():undefined;
 // The run says it is partial and which commit it is for: the server refuses a partial run as a baseline and in a comparison.
 const scope={kind:'all',...(trials>1?{trials}:{}),...(doc.budget_usd!==undefined?{budget_usd:doc.budget_usd}:{}),...(partial?{mode:'partial'}:{}),...(flags.commit?{commit:flags.commit}:{})};
 progress(`${doc.name}: starting the run`);
 const runId=(await client.execute('evals.run',{workbench_id:workbenchId,scope,...(outputs?{outputs}:{})},{idempotencyKey:`${request}:run`})).data.run.id;
 report.run_id=runId;
 const {run,cells,quality}=(await client.waitEvaluation(workbenchId,runId,{deadline:Date.now()+flags.timeoutMs,onProgress:p=>progress(`${doc.name}: grading ${p.completed}/${p.total}`)})).data;
 Object.assign(report,tally(caseIds,criteria,cellMarks(cells??[],criteria)),{cost_usd:run.summary?.cost_available?run.summary.cost_usd:null,
  // What Caveman's own judging cost, known even when the task's cost is not (the caller ran it).
  judge_cost_usd:run.summary?.judge_cost_available?run.summary.judge_cost_usd:null,
  // What the caller said its own task cost: its word, never added to the cost Caveman measured.
  reported_cost_usd:run.summary?.reported_cost_cells>0?run.summary.reported_cost_usd:null,gate:null});
 // A project key's read of a run carries no judge reason and no error text.
 if(flags.projectKey&&report.rationales.length)report.reasons_withheld=true;

 if(run.status!=='completed')return end('error',run.error_message??`The run ended ${run.status}.`);
 // A task error or a criterion that could not grade leaves no verdict to read.
 if(quality?.status==='incomplete')return end('incomplete',`Not every output was graded (${quality.reason||'run incomplete'}), so there is no verdict.`);
 if(partial)return end('partial','Partial run (--first or --sample): it is not compared and cannot become a baseline.');
 if(!doc.gate)return end('not_gated','This eval file sets no gate, so the run is not compared.');

 // No policy is sent: the experiment's stored one decides, and the answer says which it was.
 const baseline=doc.gate.baseline??'saved';
 let status,sentence;
 try{
  const compared=(await client.execute('evals.compare',{workbench_id:workbenchId,candidate_run_id:runId,...(baseline==='saved'?{}:{baseline_run_id:baseline})})).data;
  status=['passed','failed','need_more_data'].includes(compared.quality)?compared.quality:'incomplete';sentence=compared.summary??'';
  report.gate={baseline_run_id:compared.baseline_run_id,baseline_source:compared.baseline_source??null,policy:compared.policy==='strict'?'strict':'statistical',policy_source:compared.policy_source??null,quality:compared.quality,paired_cases:compared.paired_cells,regressions:compared.regressions,improvements:compared.improvements,
   unchanged:compared.unchanged??null,unpaired:compared.unpaired??null,regressed_cases:(compared.changed_cases??[]).filter(row=>row.regression_pts>0).map(row=>row.row_key)};
 }catch(error){
  // Only no baseline and a refusal to compare are answers. A project's
  // default baseline that is another experiment's run is no baseline here.
  if(error.code==='cave_eval_no_baseline'){status='no_baseline';sentence='No baseline is saved for this experiment, so there is nothing to compare with.';}
  else if(error.code==='cave_eval_comparison_incompatible'){
   status='not_comparable';
   sentence=`${error.message} If the cases or criteria changed on purpose, save this run as the new baseline: cvm evals set_baseline --workbench-id ${workbenchId} --run-id ${runId}`;
  }else throw error;
 }
 if(flags.setBaseline&&['passed','no_baseline'].includes(status)){
  await client.execute('evals.set_baseline',{workbench_id:workbenchId,run_id:runId});
  report.baseline_saved=true;sentence+=' This run is now the saved baseline.';
 }else if(status==='no_baseline')sentence+=' Save one with --set-baseline-on-pass.';
 return end(status,sentence);
}

// renderReport is a file's result for a terminal: a row per case, a column
// per criterion, why the failing ones failed, then pass rates, the server's
// sentence, the baseline it was read against, cost and where to open it.
// Meaning is in words, never colour; ascii also rewrites the server's text.
export function renderReport(report,{ascii=false}={}){
 const plain=value=>ascii?String(value).replaceAll('−','-').replaceAll('…','...').replace(/[^\x20-\x7e\n]/g,'?'):String(value);
 const lines=[`${report.name??report.file}: ${STATUS_WORDS[report.status]??report.status}`];
 for(const error of report.errors??[])lines.push(`  ${report.file}: ${error.path}: ${error.message}`);
 if(report.cases?.length){
  const trials=report.trials,short=text=>text.length>24?text.slice(0,23)+'~':text;
  const cell=count=>{const total=count.passed+count.failed+count.errors,word=!total?'-':count.errors?'error':count.failed?'fail':'pass';return total>1?`${word} ${count.passed}/${total}`:word;};
  const table=[['case',...report.criteria.map(criterion=>short(criterion.name))],...report.cases.map(item=>[item.id,...report.criteria.map(criterion=>cell(item.criteria[criterion.key]))])];
  const widths=table[0].map((_,column)=>Math.max(...table.map(row=>row[column].length)));
  lines.push('',`${report.cases.length} cases${trials>1?`, ${trials} trials each`:''}${report.partial?' (partial)':''}`);
  for(const [i,row] of table.entries()){
   lines.push(row.map((text,column)=>text.padEnd(widths[column])).join('  ').trimEnd());
   if(i===0)lines.push(widths.map(width=>'-'.repeat(width)).join('  '));
  }
  if(report.rationales.length){
   lines.push('','Failing:');
   for(const why of report.rationales.slice(0,20))lines.push(`  ${why.case} / ${why.criterion}${trials>1?` (trial ${why.trial})`:''}: ${why.result}${why.reason?' - '+why.reason:''}`,...(why.rationale?['    '+judgeLine(why)]:[]));
   if(report.rationales.length>20)lines.push(`  and ${report.rationales.length-20} more`);
   if(report.reasons_withheld)lines.push('  Reasons are not in a project key\'s read of a run: open the run in the console to see them.');
  }
  lines.push('','Pass rate: '+report.criteria.map(criterion=>`${criterion.name} ${criterion.pass_rate===null?'not graded':`${Math.round(criterion.pass_rate*100)}% (${criterion.passed}/${criterion.passed+criterion.failed})`}${criterion.errors?`, ${criterion.errors} errors`:''}`).join('; '));
 }
 // Only a comparison's sentence is a verdict.
 if(report.sentence)lines.push(`${report.status==='error'?'Error: ':report.gate?'Verdict: ':''}${report.sentence}`);
 if(report.gate)lines.push(`Baseline: run ${report.gate.baseline_run_id} (${BASELINE_WORDS[report.gate.baseline_source]??'baseline'}), ${report.gate.policy} policy${report.gate.policy_source==='experiment'?' (stored on the experiment)':''}`);
 // The whole measured cost when Caveman has it; else its own judging alone,
 // which it always measured, apart from what the caller says its task cost.
 if(report.run_id)lines.push(report.cost_usd!=null?`Cost: $${report.cost_usd.toFixed(4)}`
   :report.judge_cost_usd!=null?`Judging cost (measured by Caveman): $${report.judge_cost_usd.toFixed(4)}${report.reported_cost_usd==null?'; the task\'s own cost is not available':''}`:'Cost: not available',
  ...(report.reported_cost_usd==null?[]:[`Task cost reported by the caller (not measured by Caveman): $${report.reported_cost_usd.toFixed(4)}`]),report.url??`Experiment ${report.experiment_id}, run ${report.run_id}`);
 return plain(lines.join('\n'))+'\n';
}

// evalJUnit is the reports as JUnit: a suite per file, a test case per case
// and criterion, and one for the gate (failed only when the gate failed).
export function evalJUnit(reports){
 const suites=reports.map(report=>{
  const why=new Map((report.rationales??[]).map(item=>[`${item.case}\0${item.criterion}`,[item.reason,item.rationale&&judgeLine(item)].filter(Boolean).join('\n')]).reverse());
  const tests=(report.cases??[]).flatMap(item=>(report.criteria??[]).map(criterion=>{
   const count=item.criteria[criterion.key],total=count.passed+count.failed+count.errors,reason=xml(why.get(`${item.id}\0${criterion.name}`)??'');
   const body=!total?'<skipped/>':count.errors?`<error message="${count.errors} of ${total} could not be graded">${reason}</error>`:count.failed?`<failure message="${count.passed} of ${total} passed">${reason}</failure>`:'';
   return {body,xml:`  <testcase classname="${xml(report.name??report.file)}" name="${xml(item.id+' / '+criterion.name)}">${body}</testcase>`};
  }));
  const sentence=xml(report.sentence||(report.errors??[]).map(error=>`${error.path}: ${error.message}`).join('; ')||report.error?.message||report.status);
  const gate=report.exit_code===5?`<failure message="${sentence}"/>`:report.status==='passed'?'':[1,2,3,4,7].includes(report.exit_code)?`<error message="${sentence}"/>`:`<skipped message="${sentence}"/>`;
  tests.push({body:gate,xml:`  <testcase classname="${xml(report.name??report.file)}" name="Gate">${gate}</testcase>`});
  const count=tag=>tests.filter(test=>test.body.startsWith('<'+tag)).length;
  return ` <testsuite name="${xml('Caveman / '+(report.name??report.file))}" tests="${tests.length}" failures="${count('failure')}" errors="${count('error')}" skipped="${count('skipped')}">\n${tests.map(test=>test.xml).join('\n')}\n </testsuite>`;
 });
 return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`;
}

const text={type:'string'},flag={type:'boolean'};
const EXIT_CODES='0 passed or nothing to gate; 5 the gate failed; 6 no verdict (need more data, not comparable, or outputs that could not all be graded); 2 an invalid file or usage; 1 the run crashed; 3 signed out or forbidden; 4 the server refused the run (a project key\'s daily budget is held, or a conflict)';
const usage={
 init:'cvm evals init [PATH]  writes a starter eval file (default example.eval.json) and prints the next three commands',
 validate:'cvm evals validate FILE... [--offline] [--project UUID] [--format json|table]  (an experiment manifest: cvm evals validate --file MANIFEST)',
 run:'cvm evals run FILE... [--dry-run] [--trials N] [--first N] [--sample N --seed S] [--junit-out PATH|-] [--set-baseline-on-pass] [--timeout SECONDS] [--project UUID] [--format json|table]  (the operation: cvm evals run EXPERIMENT_ID)',
 ci:'cvm evals ci FILE... [--junit-out PATH|-] [--set-baseline-on-pass] [--advisory] [--trials N] [--timeout SECONDS] [--sha SHA] [--ref REF] [--base-sha SHA] [--base-ref REF] [--pr N] [--job NAME] [--project UUID] [--format json|table]',
};
function whole(raw,name,min,max){
 if(raw===undefined)return undefined;
 const value=Number(raw);
 if(!Number.isInteger(value)||value<min||value>max)throw new CloudError('cave_usage',`--${name} must be a whole number from ${min} to ${max}.`,2);
 return value;
}
function outputFormat(raw){
 const format=raw??(process.stdout.isTTY?'table':'json');
 if(!['json','table'].includes(format))throw new CloudError('cave_usage','--format must be json or table.',2);
 return format;
}
function evalFiles(positionals,name){
 const files=positionals.flatMap(path=>/[*?[]/.test(path)?globSync(path).sort():[path]);
 if(!files.length)throw new CloudError('cave_usage',usage[name],2);
 return files;
}
// One JSON object per file, or the readable form on a terminal.
const print=(reports,format)=>{for(const report of reports)process.stdout.write(format==='json'?inertJSON(report)+'\n':renderReport(report,{ascii:!/utf-?8/i.test(process.env.LC_ALL||process.env.LC_CTYPE||process.env.LANG||'')})+'\n');};
const invalid=({file,doc,errors})=>({schema_version:1,ok:false,file,...(typeof doc?.name==='string'?{name:doc.name}:{}),status:'invalid',exit_code:2,sentence:'',errors});
function failure(error){
 const e=error instanceof CloudError?error:new CloudError('cave_usage',error.message??'Command failed.',2);
 // The shape of a file's result: failed is a gate's word, never a usage error's.
 process.stdout.write(inertJSON({schema_version:1,ok:false,status:e.exitCode===2?'invalid':'error',exit_code:e.exitCode,sentence:e.message,error:{code:e.code,message:e.message}})+'\n');return e.exitCode;
}

// evalsValidate checks files against the schema and, unless --offline, their
// criterion and dataset names against the project. Exit 2 when any is invalid.
export async function evalsValidate(argv,{context}){
 try{
  const {values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{offline:flag,project:text,format:text,help:flag}});
  if(values.help){process.stdout.write(inertJSON({usage:usage.validate,exit_codes:'0 every file is valid; 2 a file is invalid (each error names its JSON path); 3 signed out (--offline checks the schema alone)'},2)+'\n');return 0;}
  const format=outputFormat(values.format);
  let client;const cloud=async()=>client??=await connect(context,values.project);
  const reports=[];
  for(const read of evalFiles(positionals,'validate').map(readEvalFile)){
   if(!read.errors.length&&!values.offline){
    const loaded=await loadCases(read.doc,cloud);
    read.errors=loaded.errors.length?loaded.errors:(await resolveCriteria(read.doc,loaded.columns,cloud)).errors;
   }
   reports.push(read.errors.length?invalid(read):{schema_version:1,ok:true,file:read.file,name:read.doc.name,status:'valid',exit_code:0,sentence:values.offline?'Matches the schema and its fixed checks take their options; names were not checked (--offline).':'Matches the schema, its fixed checks take their options, and its dataset and criteria names resolve.',checked:values.offline?'schema':'schema_and_names'});
  }
  print(reports,format);
  return reports.some(report=>!report.ok)?2:0;
 }catch(error){return failure(error);}
}

// evalsRun runs each file and exits by the worst of them. Nothing runs when
// any file is invalid. With ci it is `cvm evals ci FILE...`: the same path,
// with the commit, branch and pull request on each result.
export async function evalsRun(argv,{context},{ci=false}={}){
 const name=ci?'ci':'run';
 try{
  const {values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{'dry-run':flag,trials:text,first:text,sample:text,seed:text,'junit-out':text,'set-baseline-on-pass':flag,timeout:text,project:text,format:text,help:flag,
   ...(ci?{advisory:flag,sha:text,ref:text,'base-sha':text,'base-ref':text,pr:text,event:text,job:text}:{})}});
  if(values.help){process.stdout.write(inertJSON({usage:usage[name],exit_codes:EXIT_CODES},2)+'\n');return 0;}
  const format=outputFormat(values.format);
  const flags={dryRun:!!values['dry-run'],trials:whole(values.trials,'trials',1,10),first:whole(values.first,'first',1,10000),sample:whole(values.sample,'sample',1,10000),setBaseline:!!values['set-baseline-on-pass'],timeoutMs:seconds(values.timeout,1800),projectKey:/^cave_live_/.test(process.env.CAVE_TOKEN??'')};
  if(flags.first!==undefined&&flags.sample!==undefined)throw new CloudError('cave_usage','Use --first or --sample, not both.',2);
  if(values.seed!==undefined&&flags.sample===undefined)throw new CloudError('cave_usage','--seed needs --sample.',2);
  // Without a seed one is drawn and reported, so the sample can be taken again.
  if(flags.sample!==undefined)flags.seed=whole(values.seed,'seed',0,0xffffffff)??Math.floor(Math.random()*0x100000000);
  if(flags.setBaseline&&(flags.first!==undefined||flags.sample!==undefined||flags.dryRun))throw new CloudError('cave_usage','--set-baseline-on-pass needs a full run: a --first, --sample or --dry-run run cannot become a baseline.',2);
  const read=evalFiles(positionals,name).map(readEvalFile);
  let reports;
  if(read.some(file=>file.errors.length))reports=read.filter(file=>file.errors.length).map(invalid);
  else{
   let client;const cloud=async()=>client??=await connect(context,values.project);
   const live=process.stderr.isTTY,progress=live?line=>process.stderr.write(`\r\x1b[K${line}`):()=>{};
   const run=ci?detectRun(process.env,values):undefined;
   const commit=run&&Object.fromEntries(['sha','ref','base_sha','base_ref','pr_number','event','job'].filter(key=>run[key]!==undefined&&run[key]!=='').map(key=>[key,run[key]]));
   if(run)flags.commit=commitScope(run);
   reports=[];
   for(const {file,doc} of read){
    const report=await runEvalFile(file,doc,flags,{cloud,progress,consoleURL:process.env.CAVE_CONSOLE_URL});
    reports.push(commit?{...report,ci:commit}:report);
   }
   if(live)process.stderr.write('\r\x1b[K');
  }
  const junit=values['junit-out'];
  if(junit&&junit!=='-')writeFileSync(junit,evalJUnit(reports));
  if(junit==='-')process.stdout.write(evalJUnit(reports));else print(reports,format);
  // --advisory spares the job a verdict, never an invalid file or a crash.
  const codes=reports.map(report=>values.advisory&&[5,6].includes(report.exit_code)?0:report.exit_code);
  return [2,3,4,7,1,5,6].find(code=>codes.includes(code))??0;
 }catch(error){return failure(error);}
}

const starter={
 $schema:'https://caveman.so/schemas/eval-file.schema.json',
 name:'example',
 dataset:{cases:[
  {id:'refund',input:{question:'How do I get a refund?'},tags:['billing']},
  {id:'password',input:{question:'I forgot my password.'},tags:['account']},
  {id:'shipping',input:{question:'Where is my order?'},tags:['orders']},
 ]},
 task:{command:['node','-e','let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("You asked: "+JSON.parse(s).question))']},
 criteria:[{type:'contains',name:'Repeats the question',fragments:['You asked:']},{type:'not_contains',name:'Does not apologise',fragments:['sorry']}],
 // strict decides on three cases; the default, statistical, reads a pass on about 30 and more.
 gate:{policy:'strict'},
 // A run a project key starts (CI) must name one; these fixed checks spend none of it.
 budget_usd:0.25,
};

// evalsInit writes the starter file: three cases, a task that runs with no
// setup, two criteria that need no judge, a gate that can decide on three
// cases, and a budget.
export async function evalsInit(argv){
 try{
  const {values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{format:text,help:flag}});
  if(values.help){process.stdout.write(inertJSON({usage:usage.init},2)+'\n');return 0;}
  const format=outputFormat(values.format);
  if(positionals.length>1)throw new CloudError('cave_usage',usage.init,2);
  const file=positionals[0]??'example.eval.json';
  try{writeFileSync(file,JSON.stringify(starter,null,2)+'\n',{flag:'wx'});}
  catch(error){throw error.code==='EEXIST'?new CloudError('cave_file_exists',`${file} already exists; name another path.`,4):new CloudError('cave_usage',`Could not write ${file}: ${error.code??error.message}.`,2);}
  const next=[`cvm evals validate ${file}`,`cvm evals run ${file} --set-baseline-on-pass`,`cvm evals ci ${file}`];
  process.stdout.write(format==='json'?inertJSON({schema_version:1,ok:true,file,next})+'\n'
   :`Wrote ${file}. Replace its task command with your own, then:\n  ${next[0]}   check the file\n  ${next[1]}   run it and save the baseline\n  ${next[2]}   gate a change against that baseline\nIts gate is strict: it fails when a criterion got worse on any case. The statistical gate ("policy": "statistical") reads a pass on about 30 cases and more, and need more data under that.\n`);
  return 0;
 }catch(error){return failure(error);}
}
