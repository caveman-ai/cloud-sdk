import {CloudError,validateOperation} from './index.mjs';

export async function traceTranscript(client,selection){
 validateOperation('traces.payload',{...selection,kind:'request'});
 const captures=[];
 for(const kind of ['request','response'])captures.push((await client.execute('traces.payload',{...selection,kind})).data);
 return {schema_version:1,trace_id:selection.trace_id,request_id:selection.request_id,coverage:'single_captured_request',complete_conversation:false,captures,warnings:captures.filter(c=>c.status!=='captured').map(c=>`${c.kind}: ${c.reason}`)};
}
export async function datasetFromTraces(client,selections,{name='Trace regression',description=''}={}){
 if(!Array.isArray(selections)||selections.length<1||selections.length>100)throw new CloudError('cave_trace_selection_invalid','Select 1-100 captured requests with trace_id, request_id, from and to.',2);
 const rows=[];const seen=new Set();
 for(const selection of selections){
  if(seen.has(selection.request_id))throw new CloudError('cave_trace_selection_invalid','Duplicate request selection.',2);seen.add(selection.request_id);
  const transcript=await traceTranscript(client,selection);
  const [request,response]=transcript.captures;
  if(request.status!=='captured')throw new CloudError('cave_capture_unavailable',`Request capture is unavailable: ${request.reason}.`,6);
  rows.push({row_key:selection.request_id,values:{input:request.payload,...(response.status==='captured'?{observed_output:response.payload}:{}),source:{...selection,request_sha256:request.payload_sha256,...(response.status==='captured'?{response_sha256:response.payload_sha256}:{}),coverage:transcript.coverage,missing_expectation:true}}});
 }
 const manifest={schema_version:1,kind:'datasets',spec:{name,description,document:{schema_version:1,columns:[{key:'input',name:'Captured input',type:'json',role:'input'},{key:'observed_output',name:'Observed output',type:'json',role:'output'},{key:'source',name:'Trace provenance',type:'json',role:'metadata'}],rows}}};
 validateOperation('datasets.create',manifest.spec);
 return manifest;
}

// Trace provenance supports drafting, never supplies the expected answer or
// silently relabels a captured production request as a synthetic fixture.
export async function scenarioFromTrace(client,selection,{name='Trace regression scenario'}={}){
 const transcript=await traceTranscript(client,selection);
 const request=transcript.captures.find(c=>c.kind==='request');
 if(!request||request.status!=='captured')throw new CloudError('cave_capture_unavailable','Request capture is unavailable; cannot establish draft provenance.',6);
 return {schema_version:1,status:'draft',ready:false,manifest:{schema_version:1,kind:'scenarios',spec:{schema_version:1,adapter:'python-module-task-v1',name,invariant:'',entrypoint:'',input:null,initial_state:{},tools:[],read_only_tools:[],assertions:[],historical:[],provenance:{evidence_digests:[...new Set(transcript.captures.filter(c=>c.status==='captured').map(c=>c.query_digest))],fixture_basis:'synthetic',fixture_rationale:''}}},source:{...selection,request_sha256:request.payload_sha256,coverage:transcript.coverage,complete_conversation:false},warnings:['Fill entrypoint, independent invariant and assertions; create synthetic inputs and ordered tool fixtures before validation. List in read_only_tools only tools whose calls change nothing.','Captured output is observed behavior, never an expected answer.','This draft cannot execute or certify a test.',...transcript.warnings]};
}

// cvm traces tail: new traces as they arrive, by polling traces.search (newest
// first) and printing each trace once, oldest of a batch first. Client-only:
// one bounded query per interval over the last few minutes, never a stream
// the server holds open. Costs are the search's own (catalog list price).
export const tailUsage='cvm traces tail [--since 5m|2h|7d|ISO] [--interval SECONDS] [--filter JSON] [--filters JSON] [--limit N] [--timeout SECONDS] [--project UUID] [--format table|jsonl]';
const durationMs=raw=>{const m=/^(\d+)(s|m|h|d)$/.exec(raw??'');return m?Number(m[1])*{s:1000,m:60000,h:3600000,d:86400000}[m[2]]:undefined;};
const iso=ms=>new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z');
export function tailOptions(values,now=Date.now()){
 const interval=Number(values.interval??2);
 if(!Number.isFinite(interval)||interval<1||interval>60)throw new CloudError('cave_usage','--interval is seconds, 1 to 60.',2);
 let since=now-300000;
 if(values.since!==undefined){const back=durationMs(values.since),at=Date.parse(values.since);since=back!==undefined?now-back:Number.isFinite(at)&&/^\d{4}-\d{2}-\d{2}T/.test(values.since)?at:NaN;}
 if(!Number.isFinite(since)||since>now||now-since>7*86400000)throw new CloudError('cave_usage','--since is a duration (90s, 5m, 2h, 7d) or an RFC 3339 time within the last 7 days.',2);
 const limit=values.limit===undefined?undefined:Number(values.limit);
 if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1))throw new CloudError('cave_usage','--limit is a whole number of traces, at least 1.',2);
 const timeout=values.timeout===undefined?undefined:Number(values.timeout);
 if(timeout!==undefined&&(!Number.isFinite(timeout)||timeout<1||timeout>86400))throw new CloudError('cave_usage','--timeout is seconds, 1 to 86400.',2);
 const json=(flag,raw)=>{if(raw===undefined)return undefined;try{const v=JSON.parse(raw);if(v&&typeof v==='object'&&!Array.isArray(v))return v;}catch{}throw new CloudError('cave_usage',`--${flag} takes a JSON object, as traces search does.`,2);};
 return {intervalMs:interval*1000,since,limit,deadline:timeout===undefined?undefined:now+timeout*1000,filter:json('filter',values.filter),filters:json('filters',values.filters)};
}
const LOOKBACK_MS=120000,SEEN_MAX=5000,RETRYABLE=new Set(['cave_network_error','cave_timeout','cave_rate_limited','cave_request_failed']);
export async function tailTraces(client,options,{onTrace,onNotice=()=>{},signal,now=Date.now,sleep}={}){
 const seen=new Set();let newest=options.since,shown=0,failures=0;
 const wait=ms=>sleep?sleep(ms):new Promise(resolve=>{const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
 for(;;){
  if(signal?.aborted)return {shown,reason:'interrupted'};
  if(options.deadline!==undefined&&now()>=options.deadline)return {shown,reason:'timeout'};
  const to=now(),from=Math.min(Math.max(options.since,newest-LOOKBACK_MS),to-1000);
  let items;
  try{
   const result=await client.execute('traces.search',{from:iso(from),to:iso(to),page_size:100,sort:{by:'timestamp',dir:'desc'},...(options.filter?{filter:options.filter}:{}),...(options.filters?{filters:options.filters}:{})},{signal});
   items=result.data.data?.items??[];failures=0;
  }catch(error){
   if(signal?.aborted)return {shown,reason:'interrupted'};
   // A dropped poll is retried on the next tick; three in a row end the tail.
   if(!RETRYABLE.has(error?.code)&&!(error?.httpStatus>=500||error?.httpStatus===429)||++failures>=3)throw error;
   onNotice(`poll failed (${error.code}); retrying`);await wait(options.intervalMs);continue;
  }
  const fresh=items.filter(item=>!seen.has(item.trace_id));
  if(fresh.length===100&&items.length===100)onNotice('more than 100 new traces since the last poll: only the newest 100 are shown; narrow with --filter or a shorter --since');
  for(const item of fresh.reverse()){
   seen.add(item.trace_id);if(seen.size>SEEN_MAX)seen.delete(seen.values().next().value);
   const started=Date.parse(item.started_at);if(Number.isFinite(started)&&started>newest)newest=started;
   onTrace(item);shown++;
   if(options.limit!==undefined&&shown>=options.limit)return {shown,reason:'limit'};
  }
  await wait(options.intervalMs);
 }
}
// One line a person reads: time, model, agent/workflow, requests, latency, list-priced cost, status, trace id.
export function tailRow(item){
 const clean=text=>String(text??'').replace(/[\x00-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]/gu,' ');
 const time=/T(\d{2}:\d{2}:\d{2})/.exec(item.started_at??'')?.[1]??'--:--:--';
 const who=[item.agent_slug,item.workflow_slug].filter(Boolean).map(clean).join('/')||'-';
 const status=item.error_count>0?`${item.error_count} error${item.error_count===1?'':'s'}`:item.max_status_code?String(item.max_status_code):'ok';
 return [time,clean(item.model)||'-',who,`${item.request_count} req`,`${item.latency_ms} ms`,`$${Number(item.total_cost_usd??0).toFixed(4)} list`,status,clean(item.trace_id)].join('\t');
}
