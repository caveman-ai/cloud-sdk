// Help: a screen a person reads on a terminal, the same facts as one JSON
// object everywhere else. `cvm`, `cvm <family>` and
// `cvm <family> <verb> --help` each answer at their own level.
import {operations,localCommands,describeCommand} from './index.mjs';

// A summary's first sentence, plain: the catalog's markdown ticks and runs of
// whitespace go, and nothing that could steer a terminal survives.
const plain=text=>String(text??'').replace(/[\x00-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]/gu,' ').replace(/`/g,'').replace(/\s+/g,' ').trim();
const clip=(text,width)=>text.length<=width?text:text.slice(0,Math.max(1,width-1)).trimEnd()+'…';
// At most 200 characters: a verb list is a menu; the whole summary is in --help.
export function firstSentence(text){const s=plain(text),end=s.search(/[.!?](\s|$)/);return clip(end<0?s:s.slice(0,end+1),200);}
const width=()=>Math.max(60,Math.min(process.stdout.columns||100,120));
// What a client-side command does, for the verb list (its usage line is in --help).
const localSummary={
 'auth.login':'Sign in with the browser (cvm login).','auth.status':'Who this credential signs in as.',
 'context.show':'The endpoint, profile and project commands use.','context.list':'Saved profiles.','context.save':'Save a named profile.','context.use':'Switch to a saved profile.','context.set':'Pick the project commands use.','context.bind':'Bind this repository to a project.',
 'tools.list':'Every operation, one per line.','tools.describe':'One operation: input, access, permissions.','tools.schema':'One operation\'s input schema.',
 'traces.transcript':'One trace\'s captured conversation as a transcript.','traces.tail':'New traces as they arrive, one line each.','datasets.from-traces':'Draft a dataset from selected trace captures.','scenarios.from-trace':'Draft a scenario from one trace capture.',
 'targets.list':'The targets an eval workbench runs.','targets.get':'One target of an eval workbench.','targets.validate':'Check a target file, offline.',
 'manifests.validate':'Check a multi-resource bundle, offline.','manifests.push':'Apply a multi-resource bundle with a lock file.',
 'datasets.diff-manifest':'Compare a dataset manifest with the server.',
};
const manifestVerb={validate:'Check a manifest file, offline.',pull:'Write one resource as a manifest file.',diff:'Compare a manifest file with the server.',push:'Apply a manifest file.',versions:'The versions of one resource.',wait:'Wait until it finishes.'};
const visibleAliases=op=>op.aliases.filter(alias=>!alias.startsWith('caveman_'));
const familyOf=id=>id.split('.')[0];

// Families hold verbs: a host command with no verb (setup's onboarding, login, mcp) is listed under Start, not here.
export function commandFamilies(host=[]){
 return [...new Set([...operations.flatMap(op=>[op.id,...visibleAliases(op)]),...localCommands,...host.filter(command=>command.id.includes('.')).map(command=>command.id)].map(familyOf))].sort();
}
// Positional identifiers in the order the dispatcher fills them.
export function positionalIds(op){
 const properties=op.input_schema?.properties??{};
 return op.binding?.legacy?Object.keys(properties.parameters?.properties??{}):[...Object.values(op.binding?.path_inputs??{}),...(op.binding?.query_inputs??[]).filter(key=>key.endsWith('_id'))];
}
export function familyVerbs(family,host=[]){
 const rows=new Map();
 const add=(verb,row)=>{if(verb&&!rows.has(verb))rows.set(verb,{...row,verb});};
 for(const op of operations)for(const id of [op.id,...visibleAliases(op)])if(familyOf(id)===family)add(id.slice(family.length+1),{id:op.id,access:op.access,summary:firstSentence(op.summary)});
 if(['traces','experiments'].includes(family)&&rows.has('get'))add('show',{...rows.get('get')});
 for(const id of localCommands)if(familyOf(id)===family&&id.includes('.')){const verb=id.slice(family.length+1);add(verb,{id,access:'client',summary:localSummary[id]??manifestVerb[verb]??firstSentence(describeCommand(id).usage)});}
 for(const command of host)if(familyOf(command.id)===family&&command.id.includes('.'))add(command.id.slice(family.length+1),{id:command.id,access:'client',summary:firstSentence(command.summary),usage:command.usage});
 return [...rows.values()].sort((a,b)=>a.verb.localeCompare(b.verb));
}

// The deploy path: verbs a host CLI writes itself (cvm agent build, deploy,
// run, deployments), listed when it has them, as Start lists setup and login.
const deployRows=[
 ['agent.init','cvm agent init ask [DIR]','Ask Caveman: an agent that answers from your data'],
 ['agent.build','cvm agent build [PATH]','an agent folder to its build: files, size, digest'],
 ['deploy','cvm deploy [PATH]','store the build and make it live under a name'],
 ['run','cvm run NAME "TASK"','a session through a deployment, followed'],
 ['deployments','cvm deployments','list, roll back, pause, resume or archive'],
];
const deployCommands=host=>deployRows.filter(([id])=>host.some(command=>command.id===id));
// Connectors, the servers a deployment's agents call: verbs a host CLI writes
// itself (cvm connect), listed beside the deploy path when it has them.
const connectRows=[
 ['connect.add','cvm connect add NAME','add a connector and sign it in for the team'],
 ['connect.ls','cvm connect ls','state, sign-in, tools and who uses each'],
 ['connect.accept','cvm connect diff|accept NAME','what changed upstream; accept its tools'],
 ['connect.grant','cvm connect grant NAME','let a deployment use one, or answer a request'],
];
const connectCommands=host=>connectRows.filter(([id])=>host.some(command=>command.id===id));
export function topHelp(host=[]){
 const deploy=deployCommands(host),connect=connectCommands(host);
 return {usage:'cvm <resource> <verb> [--file input.json | --stdin] [--project UUID] [--profile NAME]',family_help:'cvm <resource>',verb_help:'cvm <resource> <verb> --help',context:'cvm context show|save|use|set|bind',diagnostics:'cvm doctor',auth:'cvm auth status|login',mcp:'cvm mcp',discover:'cvm tools list',schemas:'cvm tools describe datasets.create',formats:['json','jsonl','table'],write_retry:'A receipted write (tools describe: transactional) needs --idempotency-key, reused only for an identical retry; other writes take none, so read state before retrying.',...(deploy.length?{deploy:deploy.map(([,usage])=>usage).join(' | ')}:{}),...(connect.length?{connect:connect.map(([,usage])=>usage).join(' | ')}:{}),families:commandFamilies(host)};
}
export function familyHelp(family,host=[]){
 return {schema_version:1,family,usage:`cvm ${family} <verb> [flags]`,verb_help:`cvm ${family} <verb> --help`,verbs:familyVerbs(family,host)};
}

const columns=(words,indent,max)=>{const lines=[];let line='';for(const word of words){if(line&&indent.length+line.length+1+word.length>max){lines.push(indent+line);line=word;}else line=line?line+' '+word:word;}if(line)lines.push(indent+line);return lines.join('\n');};
export function renderTopHelp(help,host=[]){
 const max=width(),has=id=>host.some(command=>command.id===id);
 const row=(left,right)=>`  ${left.padEnd(30)}${right}`;
 return [
  'cvm, the Caveman Cloud CLI: evals, observability and Autopilot for the agents you build.','',
  'Start',
  ...(has('setup')?[row('cvm setup','connect your coding agents: sign-in, project, skill, MCP')]:[]),
  ...(has('login')?[row('cvm login | cvm logout','sign in with the browser, or sign out')]:[row('cvm auth status','who this credential signs in as')]),
  row('cvm doctor','check sign-in, project and contract'),
  row('cvm context show','the endpoint and project commands use'),'',
  'Find',
  row('cvm <family>','the verbs in one family, e.g. cvm traces'),
  row('cvm <family> <verb> --help','the flags one verb takes'),
  row('cvm tools list | grep WORD','every operation, one per line'),
  row('cvm mcp','the Cloud MCP server for coding agents'),'',
  ...(connectCommands(host).length?['Connect',...connectCommands(host).map(([,usage,summary])=>row(usage,summary)),'']:[]),
  ...(deployCommands(host).length?['Deploy',...deployCommands(host).map(([,usage,summary])=>row(usage,summary)),'']:[]),
  'Families',
  columns(help.families,'  ',max),'',
  'Output is a table on a terminal and JSON when piped (--format json|jsonl|table).',
  'A receipted write needs --idempotency-key (its --help says so); reuse it only to retry the identical write.',
 ].join('\n')+'\n';
}
export function renderFamilyHelp(help){
 const max=width(),verbWidth=Math.min(28,Math.max(...help.verbs.map(row=>row.verb.length),4)+2);
 const lines=help.verbs.map(row=>{const access=['read','write'].includes(row.access)?row.access:'';return clip(`  ${row.verb.padEnd(verbWidth)}${access.padEnd(7)}${row.summary}`,max);});
 return [`${help.usage}   ${help.verbs.length} verb${help.verbs.length===1?'':'s'}`,'',...lines,'',`${help.verb_help}   the flags one verb takes`].join('\n')+'\n';
}
// One verb's flags from its input schema, the way the dispatcher reads them.
const typeOf=schema=>{
 if(!schema||typeof schema!=='object')return 'value';
 if(Array.isArray(schema.enum))return clip(schema.enum.map(String).join('|'),48);
 if(schema.const!==undefined)return String(schema.const);
 const type=Array.isArray(schema.type)?schema.type.filter(t=>t!=='null')[0]:schema.type;
 if(type==='array')return (schema.items?.type==='string'||Array.isArray(schema.items?.enum))?'TEXT (repeat)':'JSON';
 if(type==='object')return 'JSON';
 if(type==='integer'||type==='number')return schema.minimum!==undefined&&schema.maximum!==undefined?`${schema.minimum}-${schema.maximum}`:'N';
 if(type==='boolean')return '';
 return schema.format?schema.format.toUpperCase().replace(/-/g,'_'):'TEXT';
};
export function renderVerbHelp(op){
 const max=width(),family=familyOf(op.id),verb=op.id.slice(family.length+1);
 if(op.execution==='client_workflow')return [op.usage,'',`JSON contract: cvm ${family} ${verb} --help --format json`].join('\n')+'\n';
 const properties=op.input_schema?.properties??{},required=new Set(op.input_schema?.required??[]),ids=positionalIds(op);
 const flagOf=key=>key==='format'?'input-format':key.replaceAll('_','-');
 const flags=Object.entries(properties);
 const usage=[`cvm ${family} ${verb}`,...ids.map(id=>id.toUpperCase()),...flags.filter(([key])=>required.has(key)&&!ids.includes(key)).map(([key,schema])=>`--${flagOf(key)}${typeOf(schema)?' '+typeOf(schema):''}`),'[flags]'].join(' ');
 const flagWidth=Math.min(30,Math.max(...flags.map(([key])=>flagOf(key).length+2),8)+2);
 const flagLines=flags.map(([key,schema])=>clip(`  ${('--'+flagOf(key)).padEnd(flagWidth)}${[typeOf(schema),required.has(key)?'required':'',firstSentence(schema?.description)].filter(Boolean).join('  ')}`,max));
 return [
  `${usage}`,'',
  clip(firstSentence(op.summary),max),
  `access ${op.access}${op.scope?', scope '+op.scope:''}${op.transactional?', needs --idempotency-key':''}`,'',
  ...(flagLines.length?['Flags',...flagLines,'']:[]),
  '  --file FILE | --stdin        the whole input as one JSON document',
  '  --project UUID  --format json|jsonl|table  --timeout MS',
  '',`JSON contract: cvm ${family} ${verb} --help --format json`,
 ].join('\n')+'\n';
}

// A list result on a terminal: its rows as aligned columns (the identifying and
// state fields first), not the JSON envelope. undefined when the result holds
// no list, which then prints as JSON. Piped output is never touched.
const preferredColumns=['number','id','trace_id','slug','name','display_name','title','kind','provider','model','status','state','priority','started_at','created_at','occurred_at','updated_at'];
export function resultRows(result){
 const data=result?.data;
 const candidates=[data,data?.data,data?.items,data?.data?.items];
 let rows=candidates.find(Array.isArray);
 if(!rows&&data&&typeof data==='object'){const arrays=Object.values(data).filter(Array.isArray);if(arrays.length===1)rows=arrays[0];}
 return Array.isArray(rows)&&rows.every(row=>row&&typeof row==='object'&&!Array.isArray(row))?rows:undefined;
}
export function renderRows(result){
 const rows=resultRows(result);if(!rows)return undefined;
 const max=width(),cursor=result?.data?.next_cursor??result?.data?.data?.next_cursor;
 const more=cursor?' (more: next_cursor in --format json)':'';
 if(!rows.length)return `0 rows${more}\n`;
 const scalar=(row,key)=>row[key]!==undefined&&row[key]!==null&&typeof row[key]!=='object';
 const sample=rows.slice(0,20);
 let columns=preferredColumns.filter(key=>sample.some(row=>scalar(row,key))).slice(0,6);
 if(columns.length<2)columns=[...new Set([...columns,...Object.keys(sample[0]).filter(key=>sample.some(row=>scalar(row,key)))])].slice(0,6);
 const cell=value=>clip(plain(value===undefined||value===null?'':String(value)),42);
 const table=[columns,...rows.map(row=>columns.map(key=>cell(row[key])))];
 const widths=columns.map((_,i)=>Math.max(...table.map(line=>line[i].length)));
 const lines=table.map(line=>clip(line.map((value,i)=>i===line.length-1?value:value.padEnd(widths[i])).join('  ').trimEnd(),max));
 return [...lines,'',`${rows.length} row${rows.length===1?'':'s'}${more}; --format json for every field`].join('\n')+'\n';
}

// doctor, auth status and context show on a terminal: the answer in a few
// lines, not a JSON document (doctor's lists every granted operation id).
const line=(label,value)=>`  ${label.padEnd(14)}${value}`;
export function renderDoctor(result){
 const project=result.project_id?`${result.project_id}`:'none selected: cvm context set PROJECT_ID';
 const contract=result.installed_contract===result.server_contract?`matches the server (${String(result.server_contract).slice(0,8)})`:`differs: this cvm ${String(result.installed_contract).slice(0,8)}, server ${String(result.server_contract).slice(0,8)}${result.server_version?` (${plain(result.server_version)})`:''}`;
 return ['cvm doctor',line('endpoint',`${plain(result.endpoint)} (profile ${plain(result.profile)})`),line('project',project),line('contract',contract),line('access',`${(result.granted_operations??[]).length} operations granted`),...(result.next_action?['',`Next: ${plain(result.next_action)}`]:[]),'',result.ok?'OK':'Not OK'].join('\n')+'\n';
}
export function renderWhoami(result){
 const d=result.data??{},user=d.user??{};
 return [`Signed in as ${plain(user.email??'?')}${user.name?` (${plain(user.name)})`:''}`,line('role',plain(user.role??'?')),line('organization',plain(user.organization_id??'?')),line('plan',`${plain(d.plan??'?')}${d.deployment?`, ${plain(d.deployment)} deployment`:''}`),...(d.data?.level?[line('data',`${plain(d.data.level)}${d.data.content?', content captured':''}${d.data.locked?', locked':''}`)]:[])].join('\n')+'\n';
}
export function renderContext(result){
 if(!('endpoint' in result))return undefined; // save, use, set and bind answer with their own object
 const source={flag:'--project',environment:'CAVE_PROJECT_ID',repository:'.caveman-cloud.json',saved:'saved default',unset:'none'}[result.project_source]??plain(result.project_source);
 return [line('profile',plain(result.profile)),line('endpoint',plain(result.endpoint)),line('project',result.project_id?`${result.project_id} (from ${source})`:'none selected: cvm context set PROJECT_ID'),line('credential',result.credential_configured?'configured':'missing: cvm login, or CAVE_TOKEN')].join('\n')+'\n';
}
