import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CloudError} from '../dist/cloud-client.mjs';
import {validateEvalFile,runEvalFile,renderReport,evalJUnit,exitFor,pick,commitScope} from '../bin/evals.mjs';
import {connect,VERSION_CONFLICT} from '../bin/ci.mjs';
import {TEST_CONCURRENCY,limitSpawn,mapPool} from './pool.mjs';

const cvm=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const schema=JSON.parse(readFileSync(new URL('../../../contracts/schemas/eval-file.schema.json',import.meta.url),'utf8'));
const valid=()=>({name:'support',dataset:{cases:[{id:'refund',input:'q1',expected:'a1'},{id:'two',input:'q2',tags:['split:test']}]},task:{command:['node','answer.mjs']},
 criteria:['Grounded',{type:'contains',name:'Mentions the answer',fragments:['a']},{judge:{question:'Is it polite?',pass:'Courteous',fail:'Rude'}}],trials:2,gate:{},budget_usd:1.5});
const change=edit=>{const doc=valid();edit(doc);return doc;};
const paths=doc=>validateEvalFile(doc).map(error=>error.path);

function cli(args,{cwd,env={}}={}){
 const base={...process.env};for(const key of ['CAVE_TOKEN','CAVE_API_URL','CAVE_PROJECT_ID','CAVE_CONSOLE_URL','GITHUB_EVENT_PATH','GITHUB_REF','GITHUB_SHA','GITHUB_BASE_REF'])delete base[key];
 return limitSpawn(()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cvm,...args],{cwd,env:{...base,HOME:cwd,USERPROFILE:cwd,CAVEMAN_HOME:join(cwd,'.caveman'),CAVE_NO_KEYCHAIN:'1',...env},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr,lines:stdout.trim().split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return line;}})}));
 }));
}

test('every validation error names its JSON path',()=>{
 assert.deepEqual(validateEvalFile(valid()),[]);
 assert.deepEqual(validateEvalFile([]),[{path:'$',message:'must be an object'}]);
 assert.deepEqual(paths({}),['$.name','$.dataset','$.task','$.criteria']);
 assert.deepEqual(validateEvalFile(change(doc=>{doc.dataset.cases[1].id='refund';})),[{path:'$.dataset.cases[1].id',message:'repeats the id of $.dataset.cases[0]'}]);
 assert.deepEqual(paths(change(doc=>{doc.dataset.cases[0].id='has space';delete doc.dataset.cases[1].input;doc.dataset.cases[1].note='x';})),['$.dataset.cases[0].id','$.dataset.cases[1].note','$.dataset.cases[1].input']);
 assert.deepEqual(paths(change(doc=>{doc.criteria=[{type:'contains',judge:{question:'q'}},{judge:{pass:'p'}},7,''];})),['$.criteria[0].type','$.criteria[1].judge.question','$.criteria[2]','$.criteria[3]']);
 assert.deepEqual(paths(change(doc=>{doc.task={command:[],retries:11,timeout_seconds:0};})),['$.task.command','$.task.retries','$.task.timeout_seconds']);
 assert.deepEqual(paths(change(doc=>{doc.task={kind:'agent',config:[]};})),['$.task.kind','$.task.config']);
 assert.deepEqual(paths(change(doc=>{doc.task={};doc.dataset={};})),['$.dataset','$.task']);
 assert.deepEqual(paths(change(doc=>{doc.trials=11;doc.gate={baseline:'last',policy:'loose',margin:1};doc.budget_usd=-1;doc.yaml=true;})),['$.yaml','$.trials','$.budget_usd','$.gate.margin','$.gate.baseline','$.gate.policy']);
 assert.deepEqual(paths(change(doc=>{doc.dataset={name:'Tickets',version:0};})),['$.dataset.version']);
 // Beyond the schema: a recorded task over cases written in the file reads each case's output.
 assert.deepEqual(paths(change(doc=>{doc.task={recorded:'answer'};})),['$.task.recorded','$.dataset.cases[0].output','$.dataset.cases[1].output']);
 assert.deepEqual(paths(change(doc=>{doc.task={recorded:'output'};for(const item of doc.dataset.cases)item.output='a';})),[]);
 // And a fixed check: its type is one of the registry's, with the options that type takes.
 assert.deepEqual(validateEvalFile(change(doc=>{doc.criteria=[{type:'contains'},{type:'no_such_grader',fragment:['x']},{type:'contains',name:'n',fragment:['x']},{type:'exact_match'}];})),[
  {path:'$.criteria[0].fragments',message:'is required by contains'},
  {path:'$.criteria[1].type',message:'"no_such_grader" is no fixed check; cvm criteria catalog lists them'},
  {path:'$.criteria[2].fragments',message:'is required by contains'},
  {path:'$.criteria[2].fragment',message:'is not an option of contains; its options are fragments'},
 ]);
 // The registry is the server's own: a type the server never offers is refused here too, a
 // trajectory rule is a library criterion and no fixed check, and a webhook takes options of its own.
 assert.deepEqual(validateEvalFile(change(doc=>{doc.criteria=[{type:'semantic'},{type:'called_tool',tool:'search'},{type:'custom_webhook',url:'https://example.com/grade',secret:'s'},{type:'rouge_score',reference:'r',stem:true}];})),[
  {path:'$.criteria[0].type',message:'"semantic" is no fixed check; cvm criteria catalog lists them'},
  {path:'$.criteria[1].type',message:'"called_tool" is no fixed check; cvm criteria catalog lists them'},
  {path:'$.criteria[3].stem',message:'is not an option of rouge_score; its options are reference, rouge_type, measure, threshold'},
 ]);
});

test('the published schema and the validator agree on what a valid eval file is',()=>{
 // ajv is a dependency of the agent surface the client is bundled from, not of cvm.
 const require=createRequire(new URL('../package.json',import.meta.url));
 const Ajv=require('ajv/dist/2020.js'),addFormats=require('ajv-formats');
 const ajv=new Ajv({strict:true,strictTypes:false,allErrors:true});addFormats(ajv);
 const accepts=ajv.compile(schema);
 const documents=[valid(),{},
  change(doc=>{doc.dataset={name:'Tickets',version:3};doc.task={kind:'model',config:{provider:'openai',model:'gpt-5.5',user_template:'{{input}}'},input_mapping:{input:'input'}};}),
  change(doc=>{doc.task={recorded:'output'};for(const item of doc.dataset.cases)item.output='a';}),
  change(doc=>{doc.gate={baseline:'00000000-0000-4000-8000-000000000001',policy:'strict'};}),
  change(doc=>{doc.dataset.cases[0].id='has space';}),change(doc=>{doc.dataset.cases[1].note='x';}),change(doc=>{doc.dataset.cases=[];}),
  change(doc=>{doc.dataset={name:'Tickets',cases:[]};}),change(doc=>{doc.dataset={name:'Tickets',version:0};}),
  change(doc=>{doc.criteria=[];}),change(doc=>{doc.criteria=[{type:'contains',judge:{question:'q'}}];}),change(doc=>{doc.criteria=[{judge:{pass:'p'}}];}),change(doc=>{doc.criteria=[7];}),
  change(doc=>{doc.task={command:[]};}),change(doc=>{doc.task={command:['a'],retries:11};}),change(doc=>{doc.task={command:['a'],timeout_seconds:0};}),change(doc=>{doc.task={command:['a'],recorded:'output'};}),
  change(doc=>{doc.task={kind:'agent',config:{}};}),change(doc=>{doc.task={kind:'http',config:{},input_mapping:{input:'bad key'}};}),
  change(doc=>{doc.trials=0;}),change(doc=>{doc.gate={baseline:'last'};}),change(doc=>{doc.gate={margin:1};}),change(doc=>{doc.budget_usd=1001;}),change(doc=>{doc.yaml=true;}),change(doc=>{doc.name='';}),
  change(doc=>{doc.dataset.cases[0].tags=['a','a'];}),
 ];
 for(const doc of documents)assert.equal(validateEvalFile(doc).length===0,accepts(doc),JSON.stringify(doc)+' '+JSON.stringify(validateEvalFile(doc))+' '+ajv.errorsText(accepts.errors));
});

// A Cloud that answers the operations a run makes. Every output is graded on
// every criterion of the experiment by `grade`.
function fakeCloud({quality={status:'passed'},runStatus='completed',baseline={experiment:{run_id:'run-0'},project:null},compare,grade=()=>true,refuse,why,summary={cost_available:false}}={}){
 const calls=[],sent=id=>calls.find(call=>call.id===id)?.input;
 const client={
  async execute(id,input,options){
   calls.push({id,input,options});
   if(refuse?.[id])throw refuse[id];
   if(id==='evals.compare'&&compare instanceof Error)throw compare;
   // The server's answer when neither the experiment nor, as one of its own runs, the project has a baseline.
   if(id==='evals.compare'&&!input.baseline_run_id&&!baseline.experiment&&!baseline.project)throw new CloudError('cave_eval_no_baseline','No baseline is saved for this experiment. Name a baseline run, or save one.',4);
   return {data:{'datasets.create':{id:'dataset-1'},'evals.create':{id:'workbench-1'},'evals.run':{run:{id:'run-1'}},'evals.compare':compare,'evals.set_baseline':{},
    'criteria.list':{data:[{id:'22222222-2222-4222-8222-222222222222',name:'Grounded',version:3},{id:'x',name:'Grounded answers',version:1},{id:'y',name:'Drafted',version:1,state:'proposed'}]}}[id]};
  },
  async waitEvaluation(){
   const evaluators=sent('evals.create').document.evaluators,outputs=sent('evals.run').outputs??[];
   return {data:{run:{status:runStatus,summary,...(runStatus==='completed'?{}:{error_message:'worker_retries_exhausted'})},quality,
    cells:outputs.map(output=>({dataset_row_key:output.row_key,trial:output.trial,status:output.error?'error':'completed',error_message:output.error,
     evaluator_results:output.error?[]:evaluators.map(evaluator=>({key:evaluator.key,name:evaluator.name,status:'completed',passed:grade(output,evaluator),reason:grade(output,evaluator)?'':'the answer is missing',...(why&&!grade(output,evaluator)?why:{})}))}))}};
  },
 };
 return {calls,sent,ids:()=>calls.map(call=>call.id),cloud:async()=>client};
}
const full={timeoutMs:1000},answers=async(_,input)=>({output:'a'+input,latency_ms:1});
const compared=(quality,policy='kernel')=>({baseline_run_id:'run-0',baseline_source:'experiment',policy,policy_source:'experiment',quality,summary:'Grounded: 1 of 2 cases improved, 0 regressed; +8 points (−24 to +48).',paired_cells:2,regressions:0,improvements:1,unchanged:5,unpaired:0,
 changed_cases:[{row_key:'refund',regression_pts:50},{row_key:'two',regression_pts:0}]});

test('a run finds or creates the dataset and the experiment by name, uploads the task\'s outputs and reads the server\'s comparison',async()=>{
 const api=fakeCloud({compare:compared('passed')});
 const report=await runEvalFile('support.eval.json',valid(),full,{cloud:api.cloud,runOne:answers,consoleURL:'https://console.example/'});
 assert.deepEqual(api.ids(),['criteria.list','datasets.create','evals.create','evals.run','evals.compare']);
 const description='Eval file "support", run by cvm.';
 assert.deepEqual(api.sent('datasets.create'),{name:'support',description,upsert:true,document:{schema_version:1,
  columns:[{key:'input',name:'Input',type:'json',role:'input'},{key:'expected',name:'Expected',type:'json',role:'expected'}],
  rows:[{row_key:'refund',values:{input:'q1',expected:'a1'}},{row_key:'two',values:{input:'q2'},tags:['split:test']}]}});
 const mapping={candidate:{source:'target',key:'$target'},reference:{source:'dataset',key:'expected'}};
 assert.deepEqual(api.sent('evals.create'),{name:'support',description,upsert:true,document:{schema_version:1,datasets:[{key:'cases',dataset_id:'dataset-1'}],
  targets:[{key:'local_task',name:'Local task (run by cvm)',kind:'external',input_mapping:{},config:{}}],
  evaluators:[
   {key:'grounded',name:'Grounded',source:'criterion',criterion_id:'22222222-2222-4222-8222-222222222222',criterion_version:3},
   {key:'is_it_polite',name:'Is it polite?',source:'inline',grader_type:'llm_judge',options:{rubric:'Is it polite?\nPass: Courteous\nFail: Rude'},input_mapping:mapping},
   {key:'mentions_the_answer',name:'Mentions the answer',source:'inline',grader_type:'contains',options:{fragments:['a']},input_mapping:mapping},
  ]}});
 assert.deepEqual(api.sent('evals.run'),{workbench_id:'workbench-1',scope:{kind:'all',trials:2,budget_usd:1.5},outputs:[
  {row_key:'refund',trial:1,attempts:1,latency_ms:1,output:'aq1'},{row_key:'refund',trial:2,attempts:1,latency_ms:1,output:'aq1'},
  {row_key:'two',trial:1,attempts:1,latency_ms:1,output:'aq2'},{row_key:'two',trial:2,attempts:1,latency_ms:1,output:'aq2'}]});
 assert.deepEqual(api.sent('evals.compare'),{workbench_id:'workbench-1',candidate_run_id:'run-1'});
 // Every write carries its own idempotency key.
 assert.equal(new Set(api.calls.filter(call=>call.options).map(call=>call.options.idempotencyKey)).size,3);
 assert.deepEqual([report.ok,report.status,report.exit_code,report.partial,report.run_id,report.url,report.cost_usd],[true,'passed',0,false,'run-1','https://console.example/experiments/workbenches/workbench-1',null]);
 assert.deepEqual([report.experiment_id,report.dataset_id],['workbench-1','dataset-1']);
 assert.deepEqual(report.gate,{baseline_run_id:'run-0',baseline_source:'experiment',policy:'statistical',policy_source:'experiment',quality:'passed',paired_cases:2,regressions:0,improvements:1,unchanged:5,unpaired:0,regressed_cases:['refund']});
 assert.equal(report.sentence,'Grounded: 1 of 2 cases improved, 0 regressed; +8 points (−24 to +48).');
 assert.deepEqual(report.cases[0],{id:'refund',criteria:{grounded:{passed:2,failed:0,errors:0},is_it_polite:{passed:2,failed:0,errors:0},mentions_the_answer:{passed:2,failed:0,errors:0}}});
});

test('the exit code is the server\'s reading of the run: 0 passed, 5 failed, 6 no verdict, 2 invalid, 1 crashed',async()=>{
 const run=async(options,flags=full,edit=()=>{})=>{const api=fakeCloud(options);return {api,report:await runEvalFile('f',change(edit),flags,{cloud:api.cloud,runOne:answers})};};
 const exits=async(options,flags,edit)=>{const {report}=await run(options,flags,edit);assert.equal(report.ok,report.exit_code===0);return [report.status,report.exit_code];};
 assert.deepEqual(await exits({compare:compared('passed')}),['passed',0]);
 assert.deepEqual(await exits({compare:compared('failed')}),['failed',5]);
 assert.deepEqual(await exits({compare:compared('need_more_data')}),['need_more_data',6]);
 assert.deepEqual(await exits({compare:compared('incomplete')}),['incomplete',6]);
 assert.deepEqual(await exits({compare:new CloudError('cave_eval_comparison_incompatible','These runs cannot be compared: dataset contents or source identity differ.',4)}),['not_comparable',6]);
 // A refused comparison says why and how to save the new baseline: it is no dead end.
 assert.equal((await run({compare:new CloudError('cave_eval_comparison_incompatible','These runs cannot be compared: dataset contents or source identity differ.',4)})).report.sentence,
  'These runs cannot be compared: dataset contents or source identity differ. If the cases or criteria changed on purpose, save this run as the new baseline: cvm evals set_baseline --workbench-id workbench-1 --run-id run-1');
 // No baseline saved, or no gate in the file: nothing to fail against. The
 // server says which: a project default that is another experiment's run is none.
 assert.deepEqual(await exits({baseline:{experiment:null,project:null}}),['no_baseline',0]);
 assert.deepEqual(await exits({},full,doc=>{delete doc.gate;}),['not_gated',0]);
 // Outputs that could not all be graded leave no verdict, gated or not.
 assert.deepEqual(await exits({quality:{status:'incomplete',reason:'cell_incomplete_or_duplicate'}}),['incomplete',6]);
 assert.deepEqual(await exits({quality:{status:'incomplete',reason:'missing_evaluation'}},full,doc=>{delete doc.gate;}),['incomplete',6]);
 assert.deepEqual(await exits({runStatus:'error'}),['error',1]);
 // The client's own conventions for a refused request: 422 is 2, a sign-in 3, a wait that ran out 6.
 assert.deepEqual(await exits({refuse:{'evals.create':new CloudError('cave_validation_failed','Unknown grader type.',2)}}),['error',2]);
 assert.deepEqual(await exits({refuse:{'criteria.list':new CloudError('cave_auth_required','Run caveman login.',3)}}),['error',3]);
 assert.deepEqual(await exits({compare:new CloudError('cave_network_error','Cloud request failed.',1)}),['error',1]);
 // A name the project does not have is an invalid file, at its path, before anything is written.
 const unknown=await run({},full,doc=>{doc.criteria=['Missing'];});
 assert.deepEqual([unknown.report.status,unknown.report.exit_code,unknown.report.errors,unknown.api.ids()],['invalid',2,[{path:'$.criteria[0]',message:'no criterion named "Missing" in this project\'s library'}],['criteria.list']]);
 // A criterion that exists but nobody turned on is named as that, not as missing.
 const drafted=await run({},full,doc=>{doc.criteria=['Drafted'];});
 assert.deepEqual([drafted.report.status,drafted.report.exit_code,drafted.report.errors,drafted.api.ids()],['invalid',2,[{path:'$.criteria[0]',message:'"Drafted" is proposed in this project\'s library, not on: a person turns it on (console, Criteria) before a run can use it'}],['criteria.list']]);
 assert.deepEqual(Object.fromEntries(['passed','not_gated','no_baseline','partial','dry_run','failed','need_more_data','incomplete','not_comparable','invalid','error'].map(status=>[status,exitFor(status)])),
  {passed:0,not_gated:0,no_baseline:0,partial:0,dry_run:0,failed:5,need_more_data:6,incomplete:6,not_comparable:6,invalid:2,error:1});

 // The file's gate names the baseline run. Its policy is stored on the
 // experiment, so the console and the SDKs read the same two runs by the
 // same rule; the comparison names none and reports the one that decided.
 const strict=await run({compare:compared('failed','strict')},full,doc=>{doc.gate={baseline:'00000000-0000-4000-8000-000000000009',policy:'strict'};});
 assert.deepEqual(strict.api.sent('evals.set_baseline'),{workbench_id:'workbench-1',gate_policy:'strict'});
 assert.deepEqual(strict.api.sent('evals.compare'),{workbench_id:'workbench-1',candidate_run_id:'run-1',baseline_run_id:'00000000-0000-4000-8000-000000000009'});
 assert.deepEqual([strict.report.gate.policy,strict.report.gate.policy_source],['strict','experiment']);
 assert.match(renderReport(strict.report),/, strict policy \(stored on the experiment\)$/m);
 const statistical=await run({compare:compared('passed')},full,doc=>{doc.gate={policy:'statistical'};});
 assert.deepEqual(statistical.api.sent('evals.set_baseline'),{workbench_id:'workbench-1',gate_policy:'kernel'});
 // A gate that names no policy leaves the experiment's stored one alone.
 assert.equal((await run({compare:compared('passed')},full,doc=>{doc.gate={};})).api.sent('evals.set_baseline'),undefined);
});

test('a project key needs a budget in the file before anything runs, and its report says reasons are withheld',async()=>{
 let ran=0;const counted=async(command,input)=>{ran++;return answers(command,input);};
 const none=fakeCloud();
 const refused=await runEvalFile('f',change(doc=>{delete doc.budget_usd;}),{...full,projectKey:true},{cloud:none.cloud,runOne:counted});
 assert.deepEqual([refused.status,refused.exit_code,refused.errors[0].path,ran,none.ids()],['invalid',2,'$.budget_usd',0,[]]);
 assert.match(refused.errors[0].message,/^is required when a project key runs the file/);
 // A person's run names none, and a key's dry run sends nothing to refuse.
 assert.equal((await runEvalFile('f',change(doc=>{delete doc.budget_usd;}),full,{cloud:fakeCloud({compare:compared('passed')}).cloud,runOne:answers})).status,'passed');
 assert.equal((await runEvalFile('f',change(doc=>{delete doc.budget_usd;}),{...full,projectKey:true,dryRun:true},{cloud:none.cloud,runOne:answers})).status,'dry_run');
 // What a key reads of a run holds no reason: the report says so instead of showing nothing.
 const stripped=fakeCloud({compare:compared('failed'),grade:()=>false}),client=await stripped.cloud(),wait=client.waitEvaluation;
 client.waitEvaluation=async()=>{const answer=await wait();for(const cell of answer.data.cells)for(const graded of cell.evaluator_results)delete graded.reason;return answer;};
 const report=await runEvalFile('f',valid(),{...full,projectKey:true},{cloud:stripped.cloud,runOne:answers});
 assert.equal(report.reasons_withheld,true);
 assert.match(renderReport(report),/\n  refund \/ Grounded \(trial 1\): fail\n[\s\S]*\n  Reasons are not in a project key's read of a run: open the run in the console to see them\.\n/);
 assert.equal((await runEvalFile('f',valid(),full,{cloud:fakeCloud({compare:compared('failed'),grade:()=>false}).cloud,runOne:answers})).reasons_withheld,undefined);
});

test('--set-baseline-on-pass saves a passed run, and the first run of an experiment, and nothing else',async()=>{
 const saves=async options=>{const api=fakeCloud(options);const report=await runEvalFile('f',valid(),{...full,setBaseline:true},{cloud:api.cloud,runOne:answers});return [api.sent('evals.set_baseline')??null,report.baseline_saved??false];};
 const saved={workbench_id:'workbench-1',run_id:'run-1'};
 assert.deepEqual(await saves({compare:compared('passed')}),[saved,true]);
 assert.deepEqual(await saves({baseline:{experiment:null,project:null}}),[saved,true]);
 for(const quality of ['failed','need_more_data','incomplete'])assert.deepEqual(await saves({compare:compared(quality)}),[null,false]);
 assert.deepEqual(await saves({quality:{status:'incomplete',reason:'missing_evaluation'},baseline:{experiment:null,project:null}}),[null,false]);
});

test('a --first or --sample run is partial: never compared, never a baseline',async()=>{
 for(const flags of [{first:1},{sample:1,seed:7}]){
  const api=fakeCloud({compare:compared('failed')});
  const report=await runEvalFile('f',valid(),{...full,...flags,setBaseline:true},{cloud:api.cloud,runOne:answers});
  assert.deepEqual([report.status,report.exit_code,report.partial,report.gate],['partial',0,true,null]);
  assert.match(report.sentence,/not compared and cannot become a baseline/);
  assert.deepEqual(api.ids(),['criteria.list','datasets.create','evals.create','evals.run']);
  assert.equal(new Set(api.sent('evals.run').outputs.map(output=>output.row_key)).size,1);
  // The run itself says it is partial, so the server refuses it as a baseline and in a comparison whoever asks.
  assert.equal(api.sent('evals.run').scope.mode,'partial');
  // The dataset keeps every case; the run holds the ones that ran.
  assert.equal(api.sent('datasets.create').document.rows.length,2);
 }
 // Caveman runs every case of a task it runs itself, so there is nothing to narrow.
 const recorded=await runEvalFile('f',change(doc=>{doc.task={recorded:'output'};for(const item of doc.dataset.cases)item.output='a';}),{...full,first:1},{cloud:fakeCloud().cloud});
 assert.deepEqual([recorded.status,recorded.exit_code,recorded.errors[0].path],['invalid',2,'$.task']);
 // The same seed takes the same cases; --first takes the leading ones.
 const rows=Array.from({length:50},(_,i)=>i);
 assert.deepEqual(pick(rows,{sample:5,seed:42}),pick(rows,{sample:5,seed:42}));
 assert.notDeepEqual(pick(rows,{sample:5,seed:42}),pick(rows,{sample:5,seed:43}));
 assert.deepEqual(pick(rows,{first:3}),[0,1,2]);
 assert.equal(pick(rows,{}),rows);
});

test('only a task error is tried again, and a case that keeps failing is an error cell with its attempts',async()=>{
 const tries=new Map();
 const flaky=async(_,input)=>{const n=(tries.get(input)??0)+1;tries.set(input,n);return input==='q1'&&n<2?{error:'exit 1: boom'}:input==='q2'?{error:'exit 2: always'}:{output:'ok'};};
 const api=fakeCloud({quality:{status:'incomplete',reason:'cell_incomplete_or_duplicate'}});
 const report=await runEvalFile('f',change(doc=>{doc.trials=1;doc.task.retries=2;}),full,{cloud:api.cloud,runOne:flaky});
 assert.deepEqual(api.sent('evals.run').outputs,[{row_key:'refund',trial:1,attempts:2,output:'ok'},{row_key:'two',trial:1,attempts:3,error:'exit 2: always'}]);
 assert.deepEqual(api.sent('evals.run').scope,{kind:'all',budget_usd:1.5});
 assert.deepEqual([report.status,report.exit_code],['incomplete',6]);
 assert.deepEqual(report.cases[1].criteria.grounded,{passed:0,failed:0,errors:1});
 assert.deepEqual(report.rationales[0],{case:'two',criterion:'Grounded',trial:1,result:'error',reason:'exit 2: always'});
});

test('a recorded or server-run task sends no outputs, and a named dataset is pinned to the version asked for',async()=>{
 const rows=[{row_key:'r1',values:{question:'q',answer:'a'}}];
 const api=fakeCloud();
 const client=await api.cloud(),execute=client.execute;
 const columns=[{key:'question',role:'input'},{key:'answer',role:'output'}];
 let rowsRefused;
 client.execute=async(id,input,options)=>{
  if(id==='datasets.list'){api.calls.push({id,input});return {data:{data:[{id:'dataset-9',name:'Tickets',columns}]}};}
  if(id==='datasets.versions'){api.calls.push({id,input});return {data:{data:[{version:3,document_sha256:'f'.repeat(64)}]}};}
  if(id==='datasets.get'){
   api.calls.push({id,input});
   if(rowsRefused)throw rowsRefused;
   return {data:{dataset:{columns:[]},rows:[],versions:[{version:3,document_sha256:'f'.repeat(64),document:{columns,rows}}]}};
  }
  return execute(id,input,options);
 };
 const doc=change(file=>{file.dataset={name:'tickets',version:3};file.task={recorded:'answer'};file.criteria=[{type:'contains',fragments:['a']}];delete file.gate;file.trials=1;delete file.budget_usd;});
 const report=await runEvalFile('f',doc,full,{cloud:api.cloud});
 // Caveman runs this task, so no row is read: the columns and the version's identity are enough, and a CI key reads both.
 assert.deepEqual(api.ids(),['datasets.list','datasets.versions','evals.create','evals.run']);
 assert.deepEqual(api.sent('evals.create').document.datasets,[{key:'cases',dataset_id:'dataset-9',version:3,document_sha256:'f'.repeat(64)}]);
 assert.deepEqual(api.sent('evals.create').document.targets,[{key:'recorded',name:'Recorded output',kind:'recorded',input_mapping:{},config:{output_column:'answer'}}]);
 assert.deepEqual(api.sent('evals.run'),{workbench_id:'workbench-1',scope:{kind:'all'}});
 assert.equal(report.status,'not_gated');
 for(const task of [{recorded:'answer'},{command:['node','answer.mjs']}]){
  const missing=await runEvalFile('f',change(file=>{file.dataset={name:'tickets',version:4};file.task=task;}),full,{cloud:api.cloud});
  assert.deepEqual(missing.errors,[{path:'$.dataset.version',message:'dataset "Tickets" has no version 4'}]);
 }
 const column=await runEvalFile('f',change(file=>{file.dataset={name:'tickets',version:3};file.task={recorded:'reply'};}),full,{cloud:api.cloud});
 assert.deepEqual(column.errors,[{path:'$.task.recorded',message:'dataset "Tickets" has no column "reply"'}]);
 // A command task runs here on the rows, which a project key or a member below admin may not read: said at its path, not as a bare 403.
 for(const code of ['cave_api_key_route_forbidden','cave_operation_forbidden']){
  rowsRefused=new CloudError(code,'Forbidden.',3);
  const local=await runEvalFile('f',change(file=>{file.dataset={name:'tickets'};}),full,{cloud:api.cloud,runOne:answers});
  assert.deepEqual([local.status,local.exit_code,local.errors[0].path],['invalid',2,'$.dataset.name']);
  assert.match(local.errors[0].message,/reads no dataset rows.*write the cases in the file/);
 }
 rowsRefused=new CloudError('cave_auth_required','Run caveman login.',3);
 assert.deepEqual([(await runEvalFile('f',change(file=>{file.dataset={name:'tickets'};}),full,{cloud:api.cloud,runOne:answers})).status],['error']);
});

test('the table shows a row per case, a column per criterion with trials, the failing rationales, pass rates, the server\'s sentence, the baseline, cost and where to open it',async()=>{
 const api=fakeCloud({compare:compared('failed'),quality:{status:'failed'},grade:(output,evaluator)=>!(output.row_key==='two'&&evaluator.key==='grounded'&&output.trial===2)});
 const report=await runEvalFile('f',valid(),full,{cloud:api.cloud,runOne:answers});
 assert.equal(renderReport(report),[
  'support: Failed',
  '',
  '2 cases, 2 trials each',
  'case    Grounded  Is it polite?  Mentions the answer',
  '------  --------  -------------  -------------------',
  'refund  pass 2/2  pass 2/2       pass 2/2',
  'two     fail 1/2  pass 2/2       pass 2/2',
  '',
  'Failing:',
  '  two / Grounded (trial 2): fail - the answer is missing',
  '',
  'Pass rate: Grounded 75% (3/4); Is it polite? 100% (4/4); Mentions the answer 100% (4/4)',
  'Verdict: Grounded: 1 of 2 cases improved, 0 regressed; +8 points (−24 to +48).',
  'Baseline: run run-0 (saved for this experiment), statistical policy (stored on the experiment)',
  'Cost: not available',
  'Experiment workbench-1, run run-1',
  '',
 ].join('\n'));
 // Without UTF-8 the same table is plain ASCII, the server's sentence included.
 const ascii=renderReport(report,{ascii:true});
 assert.match(ascii,/\+8 points \(-24 to \+48\)/);
 assert.ok(/^[\x20-\x7e\n]*$/.test(ascii));
 // One trial reads as a word alone; a known cost and a console address are shown.
 const once=await runEvalFile('f',change(doc=>{doc.trials=1;delete doc.budget_usd;}),full,{cloud:fakeCloud({compare:compared('passed')}).cloud,runOne:answers,consoleURL:'https://console.example'});
 const table=renderReport({...once,cost_usd:0.01234});
 assert.match(table,/^refund  pass      pass           pass$/m);
 assert.match(table,/^Cost: \$0\.0123\nhttps:\/\/console\.example\/experiments\/workbenches\/workbench-1$/m);
 assert.equal(renderReport({file:'bad.eval.json',status:'invalid',errors:[{path:'$.criteria[0]',message:'is required'}]}),'bad.eval.json: Invalid\n  bad.eval.json: $.criteria[0]: is required\n');
 // Only a comparison's sentence is called a verdict.
 const ungated=await runEvalFile('f',change(doc=>{delete doc.gate;}),full,{cloud:fakeCloud().cloud,runOne:answers});
 assert.match(renderReport(ungated),/\nThis eval file sets no gate, so the run is not compared\.\n/);
 assert.doesNotMatch(renderReport(ungated),/Verdict:/);
});

test('a full run names no mode; a run in CI carries its commit, ref, base and pull request on its scope',async()=>{
 const api=fakeCloud({compare:compared('passed')});
 await runEvalFile('f',valid(),full,{cloud:api.cloud,runOne:answers});
 assert.deepEqual([api.sent('evals.run').scope.mode,api.sent('evals.run').scope.commit],[undefined,undefined]);
 const sha='a'.repeat(40),ci=fakeCloud({compare:compared('passed')});
 // What the server would refuse is left out, never sent: a short sha, the ref of no branch, a base that is no commit.
 await runEvalFile('f',valid(),{...full,commit:commitScope({sha,ref:'refs/pull/12/merge',base_sha:'0'.repeat(7),base_ref:'main',pr_number:12,event:'pull_request',job:'evals'})},{cloud:ci.cloud,runOne:answers});
 assert.deepEqual(ci.sent('evals.run').scope.commit,{sha,ref:'refs/pull/12/merge',base_ref:'main',pr_number:12});
 assert.equal(commitScope({sha:'abc',ref:'refs/heads/HEAD',job:'ci'}),undefined);
});

test('a failed judgment shows the judge\'s own reason and how it was produced, in the table and in JUnit',async()=>{
 const why={rationale:'The reply never greets the customer.',rationale_kind:'reasoned_before'};
 const api=fakeCloud({compare:compared('failed'),quality:{status:'failed'},why,grade:(output,evaluator)=>!(output.row_key==='two'&&evaluator.key==='grounded'&&output.trial===2)});
 const report=await runEvalFile('f',valid(),full,{cloud:api.cloud,runOne:answers});
 assert.deepEqual(report.rationales,[{case:'two',criterion:'Grounded',trial:2,result:'fail',reason:'the answer is missing',...why}]);
 assert.match(renderReport(report),/\n  two \/ Grounded \(trial 2\): fail - the answer is missing\n    Judge \(reasoned first\): The reply never greets the customer\.\n/);
 assert.match(evalJUnit([report]),/<failure message="1 of 2 passed">the answer is missing\nJudge \(reasoned first\): The reply never greets the customer\.<\/failure>/);
 const after=await runEvalFile('f',valid(),full,{cloud:fakeCloud({compare:compared('failed'),why:{rationale:'Curt.',rationale_kind:'explained_after'},grade:()=>false}).cloud,runOne:answers});
 assert.match(renderReport(after),/    Judge \(explained afterwards\): Curt\./);
});

test('what the caller said its task cost is shown as the caller\'s word, apart from the cost Caveman measured',async()=>{
 const api=fakeCloud({compare:compared('passed'),summary:{cost_available:true,cost_usd:0.002,reported_cost_usd:0.5,reported_cost_cells:4}});
 const report=await runEvalFile('f',valid(),full,{cloud:api.cloud,runOne:answers});
 assert.deepEqual([report.cost_usd,report.reported_cost_usd],[0.002,0.5]);
 assert.match(renderReport(report),/^Cost: \$0\.0020\nTask cost reported by the caller \(not measured by Caveman\): \$0\.5000$/m);
 const none=await runEvalFile('f',valid(),full,{cloud:fakeCloud({compare:compared('passed')}).cloud,runOne:answers});
 assert.equal(none.reported_cost_usd,null);
 assert.doesNotMatch(renderReport(none),/reported by the caller/);
 // A run whose task the caller ran has no whole cost, and Caveman still
 // measured its own judging: both are shown, each as what it is.
 const external={cost_available:false,cost_usd:0.0031,judge_cost_available:true,judge_cost_usd:0.0031};
 const judged=await runEvalFile('f',valid(),full,{cloud:fakeCloud({compare:compared('passed'),summary:{...external,reported_cost_usd:0.5,reported_cost_cells:4}}).cloud,runOne:answers});
 assert.deepEqual([judged.cost_usd,judged.judge_cost_usd,judged.reported_cost_usd],[null,0.0031,0.5]);
 assert.match(renderReport(judged),/^Judging cost \(measured by Caveman\): \$0\.0031\nTask cost reported by the caller \(not measured by Caveman\): \$0\.5000$/m);
 assert.doesNotMatch(renderReport(judged),/not available/);
 const unreported=await runEvalFile('f',valid(),full,{cloud:fakeCloud({compare:compared('passed'),summary:external}).cloud,runOne:answers});
 assert.match(renderReport(unreported),/^Judging cost \(measured by Caveman\): \$0\.0031; the task's own cost is not available$/m);
 // A judge with no price leaves nothing measured to show.
 const unpriced=await runEvalFile('f',valid(),full,{cloud:fakeCloud({compare:compared('passed'),summary:{cost_available:false,judge_cost_available:false,judge_cost_usd:0}}).cloud,runOne:answers});
 assert.match(renderReport(unpriced),/^Cost: not available$/m);
});

test('a server that speaks another API version is answered in one line that says to upgrade and how',async()=>{
 const refusing=async()=>({baseURL:'http://127.0.0.1:1',token:'t',projectId:'00000000-0000-4000-8000-000000000001'});
 const prototype=Object.getPrototypeOf(await connect(refusing)),request=prototype.request;
 prototype.request=async()=>{throw new CloudError('cave_operation_version_conflict','Installed operation contract differs from server; refresh client discovery.',4);};
 try{
  await assert.rejects((await connect(refusing)).request('/x'),error=>error.code==='cave_operation_version_conflict'&&error.exitCode===4&&error.message===VERSION_CONFLICT);
 }finally{prototype.request=request;}
 // @rc, not @latest: npm's latest tag lags behind the release line the spec hands out.
 assert.match(VERSION_CONFLICT,/^This cvm and the Caveman server speak different API versions\. Upgrade cvm \(npm install -g @caveman-ai\/cloud@rc\)/);
 assert.doesNotMatch(VERSION_CONFLICT,/\n/);
});

test('JUnit has a test case per case and criterion, and one for the gate',async()=>{
 const api=fakeCloud({compare:compared('failed'),grade:(output,evaluator)=>!(output.row_key==='two'&&evaluator.key==='grounded')});
 const report=await runEvalFile('f',valid(),full,{cloud:api.cloud,runOne:answers});
 const junit=evalJUnit([report,{file:'bad.eval.json',status:'invalid',exit_code:2,errors:[{path:'$.name',message:'is required'}]}]);
 assert.match(junit,/<testsuite name="Caveman \/ support" tests="7" failures="2" errors="0" skipped="0">/);
 assert.match(junit,/<testcase classname="support" name="refund \/ Grounded"><\/testcase>/);
 assert.match(junit,/<testcase classname="support" name="two \/ Grounded"><failure message="0 of 2 passed">the answer is missing<\/failure><\/testcase>/);
 assert.match(junit,/<testcase classname="support" name="Gate"><failure message="Grounded: 1 of 2 cases improved[^"]*"\/><\/testcase>/);
 assert.match(junit,/<testsuite name="Caveman \/ bad.eval.json" tests="1" failures="0" errors="1" skipped="0">\n  <testcase classname="bad.eval.json" name="Gate"><error message="\$.name: is required"\/>/);
 // A run with nothing to gate is neither a pass nor a failure of the gate.
 assert.match(evalJUnit([{...report,status:'no_baseline',exit_code:0,sentence:'No baseline.'}]),/name="Gate"><skipped message="No baseline."\/>/);
});

describe('evals-cli', {concurrency: TEST_CONCURRENCY}, () => {

test('cvm: init writes a starter the next commands accept, and a dry run runs its task with nothing sent',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'cvm-evals-'));
 const init=await cli(['evals','init'],{cwd});
 assert.equal(init.code,0,init.stdout+init.stderr);
 assert.deepEqual(init.lines[0],{schema_version:1,ok:true,file:'example.eval.json',next:['cvm evals validate example.eval.json','cvm evals run example.eval.json --set-baseline-on-pass','cvm evals ci example.eval.json']});
 const starter=JSON.parse(readFileSync(join(cwd,'example.eval.json'),'utf8'));
 assert.equal(starter.dataset.cases.length,3);
 assert.deepEqual(validateEvalFile(starter),[]);
 // Three cases can never read a pass under the statistical gate (it needs about 30), so the starter's is strict; and it names a budget, which a CI key's run must.
 assert.deepEqual([starter.gate,typeof starter.budget_usd],[{policy:'strict'},'number']);
 const [otherInit,dupInit,checked,dry,table]=await Promise.all([
  cli(['evals','init','other.eval.json','--format','table'],{cwd}),
  cli(['evals','init'],{cwd}),
  cli(['evals','validate','example.eval.json','--offline'],{cwd}),
  cli(['evals','run','example.eval.json','--dry-run','--trials','2'],{cwd}),
  cli(['evals','run','example.eval.json','--dry-run','--format','table'],{cwd}),
 ]);
 assert.match(otherInit.stdout,/Its gate is strict[\s\S]*about 30 cases/);
 assert.equal(dupInit.code,4,'an existing file is never overwritten');
 // Offline validation and a dry run need no sign-in and no server.
 assert.deepEqual([checked.code,checked.lines[0].status,checked.lines[0].checked],[0,'valid','schema']);
 assert.equal(dry.code,0,dry.stdout+dry.stderr);
 assert.deepEqual([dry.lines[0].status,dry.lines[0].outputs.length,dry.lines[0].outputs[0]],['dry_run',6,{row_key:'refund',trial:1,attempts:1,latency_ms:dry.lines[0].outputs[0].latency_ms,output:'You asked: How do I get a refund?'}]);
 assert.match(table.stdout,/^example: Dry run\n\n3 cases\ncase      Task ran\n/);
 // Graders and judge questions name nothing in the project, so the starter validates signed out too.
 assert.equal((await cli(['evals','validate','*.eval.json'],{cwd})).code,0);
 // A library criterion is looked up in the project, which needs a sign-in: the client's own exit code.
 writeFileSync(join(cwd,'library.eval.json'),JSON.stringify({...starter,criteria:['Grounded']}));
 const [valOut,runOut,offlineLib]=await Promise.all([
  cli(['evals','validate','library.eval.json'],{cwd,env:{CAVE_PROJECT_ID:'00000000-0000-4000-8000-000000000001'}}),
  cli(['evals','run','library.eval.json'],{cwd,env:{CAVE_PROJECT_ID:'00000000-0000-4000-8000-000000000001'}}),
  cli(['evals','validate','library.eval.json','--offline'],{cwd}),
 ]);
 for(const signedOut of [valOut,runOut]){
  assert.equal(signedOut.code,3,signedOut.stdout);
  assert.match(signedOut.stdout,/cave_auth_required/);
 }
 assert.equal(offlineLib.code,0);
});

test('cvm: the task is a command with its input on stdin; a non-zero exit, a timeout and a missing program are task errors',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'cvm-evals-'));
 const file=(name,command,task={})=>{writeFileSync(join(cwd,name),JSON.stringify({name,dataset:{cases:[{id:'a',input:{n:2}},{id:'b',input:{n:3}}]},task:{command,retries:0,...task},criteria:[{type:'contains',fragments:['x']}]}));return name;};
 const run=async name=>(await cli(['evals','run',name,'--dry-run'],{cwd})).lines[0];
 const [doubled,failing,slow,missing]=await Promise.all([
  run(file('json.eval.json',[process.execPath,'-e','let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({twice:JSON.parse(s).n*2})))'])),
  run(file('fail.eval.json',[process.execPath,'-e','console.error("no key");process.exit(3)'],{retries:1})),
  run(file('slow.eval.json',[process.execPath,'-e','setTimeout(()=>{},30000)'],{timeout_seconds:0.3})),
  run(file('missing.eval.json',['cvm-no-such-program'])),
 ]);
 assert.deepEqual(doubled.outputs.map(output=>output.output),[{twice:4},{twice:6}]);
 assert.deepEqual([failing.status,failing.exit_code,failing.outputs[0].attempts,failing.outputs[0].error],['incomplete',6,2,'exit 3: no key']);
 assert.match(failing.sentence,/failed on 2 of 2 runs/);
 assert.equal(slow.outputs[0].error,'the task took longer than 0.3 s');
 assert.match(missing.outputs[0].error,/^could not run cvm-no-such-program/);
});

test('cvm: an invalid file exits 2 with its paths and nothing runs; a partial or dry run cannot set a baseline',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'cvm-evals-'));
 await cli(['evals','init','good.eval.json'],{cwd});
 const marker=join(cwd,'ran');
 writeFileSync(join(cwd,'runs.eval.json'),JSON.stringify({name:'runs',dataset:{cases:[{id:'a',input:1}]},task:{command:[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'')`]},criteria:[{type:'contains',fragments:['x']}]}));
 writeFileSync(join(cwd,'bad.eval.json'),JSON.stringify({name:'bad',dataset:{cases:[{id:'a'}]},task:{command:['true']},criteria:[]}));
 writeFileSync(join(cwd,'broken.eval.json'),'{name:');
 const project='123e4567-e89b-42d3-a456-426614174000';
 await Promise.all([
  mapPool([['evals','validate','good.eval.json','bad.eval.json','broken.eval.json','--offline'],['evals','run','runs.eval.json','bad.eval.json','broken.eval.json','--dry-run'],['evals','ci','runs.eval.json','bad.eval.json','broken.eval.json','--dry-run']],async args=>{
   const result=await cli(args,{cwd});
   assert.equal(result.code,2,result.stdout+result.stderr);
   const bad=result.lines.find(line=>line.file==='bad.eval.json'),broken=result.lines.find(line=>line.file==='broken.eval.json');
   assert.deepEqual(bad.errors.map(error=>error.path),['$.dataset.cases[0].input','$.criteria']);
   assert.deepEqual([bad.status,bad.exit_code,broken.errors[0].path],['invalid',2,'$']);
   assert.match(broken.errors[0].message,/^is not JSON: /);
  }),
  (async()=>{assert.match((await cli(['evals','validate','bad.eval.json','--offline','--format','table'],{cwd})).stdout,/^bad: Invalid\n  bad\.eval\.json: \$\.dataset\.cases\[0\]\.input: is required\n/);})(),
  mapPool([['--first','1'],['--sample','1','--seed','3'],['--dry-run']],async flags=>{
   const refused=await cli(['evals','run','good.eval.json','--set-baseline-on-pass',...flags],{cwd});
   assert.deepEqual([refused.code,refused.lines[0].error.code],[2,'cave_usage']);
   assert.match(refused.lines[0].error.message,/cannot become a baseline/);
  }),
  (async()=>{assert.equal((await cli(['evals','run','good.eval.json','--first','1','--sample','1'],{cwd})).code,2);})(),
  (async()=>{assert.equal((await cli(['evals','run','good.eval.json','--trials','11'],{cwd})).code,2);})(),
  (async()=>{assert.equal((await cli(['evals','run','none-*.eval.json'],{cwd})).code,2);})(),
  (async()=>{
   // A usage error is an invalid call (exit 2), never the gate's "failed".
   const usage=(await cli(['evals','run','good.eval.json','--first','0'],{cwd})).lines[0];
   assert.deepEqual([usage.ok,usage.status,usage.exit_code,usage.error.code],[false,'invalid',2,'cave_usage']);
  })(),
  // --project takes its id in either form without becoming the operation `evals run EXPERIMENT_ID`.
  mapPool([['--project',project],[`--project=${project}`]],async flag=>{
   const [v,r]=await Promise.all([cli(['evals','validate','good.eval.json','--offline',...flag],{cwd}),cli(['evals','run','good.eval.json','--dry-run',...flag],{cwd})]);
   assert.deepEqual([v.lines[0].status,r.lines[0].status],['valid','dry_run']);
  }),
  // The operation forms keep their own path: a manifest by --file, a run by its experiment's id.
  (async()=>{assert.equal((await cli(['evals','validate','--file','good.eval.json'],{cwd})).lines.length>0,true);})(),
  (async()=>{assert.notEqual((await cli(['evals','run','00000000-0000-4000-8000-000000000001','--idempotency-key','k'],{cwd})).lines[0]?.error?.code,'cave_usage');})(),
 ]);
 assert.ok(!existsSync(marker),'no task ran beside an invalid file');
});

test('cvm evals ci takes eval files: each result carries the commit, and the JUnit report is written',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'cvm-evals-'));
 await Promise.all([cli(['evals','init','one.eval.json'],{cwd}),cli(['evals','init','two.eval.json'],{cwd})]);
 const env={GITHUB_SHA:'a'.repeat(40),GITHUB_REF:'refs/pull/12/merge',GITHUB_BASE_REF:'main',GITHUB_JOB:'evals'};
 const [result,stdoutJunit,noArgs]=await Promise.all([
  cli(['evals','ci','one.eval.json','two.eval.json','--dry-run','--junit-out','report.xml'],{cwd,env}),
  cli(['evals','ci','one.eval.json','--dry-run','--junit-out','-'],{cwd,env}),
  cli(['evals','ci'],{cwd}),
 ]);
 assert.equal(result.code,0,result.stdout+result.stderr);
 assert.deepEqual(result.lines.map(line=>[line.file,line.status,line.ci]),['one.eval.json','two.eval.json'].map(file=>[file,'dry_run',{sha:'a'.repeat(40),ref:'refs/pull/12/merge',base_ref:'main',pr_number:12,event:'pull_request',job:'evals'}]));
 const junit=readFileSync(join(cwd,'report.xml'),'utf8');
 assert.equal(junit.match(/<testsuite /g).length,2);
 assert.match(junit,/<testcase classname="example" name="refund \/ Task ran"><\/testcase>/);
 assert.match(stdoutJunit.stdout,/^<\?xml[\s\S]*<testsuites>/);
 // The JUnit wrapper keeps its own usage.
 assert.equal(noArgs.code,2);
});

test('the three commands init prints end in exit 0 on an unchanged task: the first run saves the baseline and the next passes its strict gate',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'cvm-evals-'));
 await cli(['evals','init'],{cwd});
 const starter=JSON.parse(readFileSync(join(cwd,'example.eval.json'),'utf8')),echo=async(_,input)=>({output:'You asked: '+input.question});
 const first=fakeCloud({baseline:{experiment:null,project:null}});
 const saved=await runEvalFile('example.eval.json',starter,{...full,setBaseline:true,projectKey:true},{cloud:first.cloud,runOne:echo});
 assert.deepEqual([saved.status,saved.exit_code,saved.baseline_saved,first.sent('evals.run').scope],['no_baseline',0,true,{kind:'all',budget_usd:starter.budget_usd}]);
 // The server reads three identical cases as passed only under strict; under the kernel they are need more data.
 const next=fakeCloud();
 const client=await next.cloud(),execute=client.execute;
 // It reads them by the policy the file stored on the experiment, as every other reader of the two runs does.
 const stored=()=>next.sent('evals.set_baseline')?.gate_policy??'kernel';
 client.execute=async(id,input,options)=>id==='evals.compare'?(next.calls.push({id,input}),{data:compared(stored()==='strict'?'passed':'need_more_data',stored())}):execute(id,input,options);
 const gated=await runEvalFile('example.eval.json',starter,{...full,projectKey:true},{cloud:next.cloud,runOne:echo});
 assert.deepEqual([gated.status,gated.exit_code,next.sent('evals.compare').policy,gated.gate.policy],['passed',0,undefined,'strict']);
});

});
