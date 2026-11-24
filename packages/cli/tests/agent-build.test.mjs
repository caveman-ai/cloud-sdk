import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build,buildFiles,locate,readFrontmatter,agentFields,summaryLine,LIMITS} from '../bin/agent-build.mjs';

const bin=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const sha=text=>createHash('sha256').update(text).digest('hex');
// Ajv is a dependency of the agent surface the client is bundled from, the one
// package the cvm job installs; cvm ships none, so the test resolves it there.
const contracts=createRequire(fileURLToPath(new URL('../package.json',import.meta.url)));
const Ajv2020=contracts('ajv/dist/2020.js').default,addFormats=contracts('ajv-formats').default;
const ajv=new Ajv2020({allErrors:true,strict:true,strictTypes:false});addFormats(ajv);
const validManifest=ajv.compile(JSON.parse(await readFile(new URL('../../../contracts/schemas/agent-build.schema.json',import.meta.url),'utf8')));
const schemaValid=manifest=>assert.ok(validManifest(manifest),JSON.stringify(validManifest.errors));

const agentFile='---\nname: triage\ndescription: Triages support tickets\nmodel: auto\ntools:\n  - Read\n  - type: custom\n    name: lookup_order\n    description: Look up an order\n    input_schema: { type: object, properties: { id: { type: string } }, required: [id] }\n---\nYou triage support tickets.\n';
const triage={
 'AGENT.md':agentFile,
 'skills/refunds/SKILL.md':'---\nname: refunds\n---\nRefund rules.\n',
 'skills/refunds/a.md':'lower\n',
 'skills/refunds/B.md':'upper\n',
 'skills/notes/readme.txt':'not a skill: no SKILL.md\n',
 'agents/coder/AGENT.md':'---\nname: coder\ncomputer: full\n---\nWrite the code.\n',
 'evals/basic.eval.json':'{"name":"basic"}\n',
 'evals/notes.md':'not an eval\n',
 'tools/README.md':'no code here\n',
 'README.md':'# triage\n',
};
async function folder(t,files,{name='triage',order}={}){
 const root=await mkdtemp(join(tmpdir(),'cvm-agent-build-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=join(root,name);await mkdir(dir);
 for(const path of order??Object.keys(files)){await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),files[path]);}
 return dir;
}
const run=(args,cwd,env={})=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[bin,...args],{cwd,env:{HOME:cwd,USERPROFILE:cwd,CAVEMAN_HOME:join(cwd,'.caveman-home'),PATH:'/usr/bin:/bin',CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',...env},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
});
async function tree(dir,rel=''){
 const out=[];
 for(const entry of await readdir(join(dir,rel),{withFileTypes:true})){const path=rel?`${rel}/${entry.name}`:entry.name;if(entry.isDirectory())out.push(...await tree(dir,path));else out.push(path);}
 return out.sort();
}

test('one agent file builds alone, as AGENT.md, named by its file',async t=>{
 const dir=await folder(t,{'.caveman/agents/support-bot.md':'You answer support questions.\n'},{name:'repo'});
 const b=build(locate('.caveman/agents/support-bot.md',dir));
 assert.equal(b.name,'support-bot');
 assert.deepEqual(Object.keys(buildFiles(b)),['agent.json','AGENT.md']);
 assert.deepEqual(b.manifest,{schema:'caveman.agent.build.v1',name:'support-bot',loop:{kind:'managed'},sandbox:{tier:'linux'},
  files:[{path:'AGENT.md',sha256:sha('You answer support questions.\n'),bytes:30}],built_by:{name:'cvm',version:b.manifest.built_by.version}});
 assert.equal(b.agentJSON,JSON.stringify(b.manifest,null,2)+'\n');
 assert.equal(b.digest,sha(b.agentJSON));
 assert.equal(b.count,2);
 schemaValid(b.manifest);
});

test('a folder with a skill, a subagent and an eval builds every included file, sorted bytewise, and lists the rest',async t=>{
 const dir=await folder(t,triage);
 const b=build(locate(dir));
 assert.deepEqual(b.manifest.files.map(f=>f.path),['AGENT.md','agents/coder/AGENT.md','evals/basic.eval.json','skills/refunds/B.md','skills/refunds/SKILL.md','skills/refunds/a.md']);
 for(const f of b.manifest.files)assert.equal(f.sha256,sha(triage[f.path]),f.path);
 assert.deepEqual(b.excluded,['README.md','evals/notes.md','skills/notes/','tools/README.md']);
 assert.deepEqual(b.manifest.skills,[{name:'refunds',path:'skills/refunds/SKILL.md'}]);
 assert.deepEqual(b.manifest.subagents,[{name:'coder',path:'agents/coder/AGENT.md'}]);
 assert.deepEqual(b.manifest.evals,[{name:'basic',path:'evals/basic.eval.json'}]);
 assert.equal(b.manifest.description,'Triages support tickets');
 assert.equal(b.manifest.model,'auto');
 assert.deepEqual(b.manifest.loop,{kind:'managed'});
 assert.deepEqual(b.manifest.tools,[{name:'Read',kind:'builtin'},{name:'lookup_order',kind:'caller',description:'Look up an order',input_schema:{type:'object',properties:{id:{type:'string'}},required:['id']}}]);
 assert.ok(!b.agentJSON.includes(dir),'no absolute path in agent.json');
 schemaValid(b.manifest);
 // computer: none and an engine come from the frontmatter too.
 const lean=build(locate(await folder(t,{'AGENT.md':'---\nengine: caveman\ncomputer: none\n---\nAnswer.\n'},{name:'lean'})));
 assert.deepEqual([lean.manifest.loop,lean.manifest.sandbox],[{kind:'managed',engine:'caveman'},{tier:'none'}]);
 schemaValid(lean.manifest);
});

test('the same folder builds byte-identical agent.json and digest, whatever order its files were written in',async t=>{
 const one=await folder(t,triage);
 const two=await folder(t,triage,{order:Object.keys(triage).reverse()});
 const first=await run(['agent','build',one,'--format','json'],dirname(one));
 const again=await run(['agent','build',one,'--format','json','--out','out-a'],dirname(one));
 const other=await run(['agent','build',two,'--format','json','--out','out-b'],dirname(two));
 for(const r of [first,again,other])assert.equal(r.code,0,r.stdout);
 const [a,b,c]=[first,again,other].map(r=>JSON.parse(r.stdout));
 assert.equal(a.sha256,b.sha256);assert.equal(a.sha256,c.sha256);
 assert.deepEqual(a.manifest,c.manifest);
 const bytesA=await readFile(join(dirname(one),'out-a','agent.json')),bytesB=await readFile(join(dirname(two),'out-b','agent.json'));
 assert.ok(bytesA.equals(bytesB));
 assert.equal(sha(bytesA),a.sha256);
 assert.ok(!('source' in a.manifest),'the build names no commit: one that leaves the agent alone makes no new version');
});

test('--out writes exactly the build, and nothing is written without it',async t=>{
 const dir=await folder(t,triage);
 const before=await tree(dirname(dir));
 const plain=await run(['agent','build','triage'],dirname(dir));
 assert.equal(plain.code,0,plain.stdout);
 assert.deepEqual(await tree(dirname(dir)),before);
 const result=await run(['agent','build','triage','--out','build','--format','table'],dirname(dir));
 assert.equal(result.code,0,result.stdout);
 const out=join(dirname(dir),'build');
 const b=build(locate(dir));
 assert.deepEqual(await tree(out),Object.keys(buildFiles(b)).sort());
 for(const [path,text] of Object.entries(buildFiles(b)))assert.equal(await readFile(join(out,path),'utf8'),text,path);
 assert.match(result.stdout,/^agent {4}triage$/m);
 assert.match(result.stdout,/^ {2}skills\/refunds\/SKILL\.md +\d+ B$/m);
 assert.match(result.stdout,/^total {4}7 files, [\d.]+ KB$/m);
 assert.match(result.stdout,new RegExp(`^sha256   ${b.digest}$`,'m'));
 assert.match(result.stdout,/^not in the build: README\.md, evals\/notes\.md, skills\/notes\/, tools\/README\.md$/m);
 const again=await run(['agent','build','triage','--out','build'],dirname(dir));
 assert.equal(again.code,2);assert.match(JSON.parse(again.stdout).error.message,/not an empty folder/);
});

test('with no path: the folder\'s AGENT.md, else the one agent under .caveman/agents/, and more than one is a usage error that lists them',async t=>{
 const here=await folder(t,{'AGENT.md':'Here.\n','.caveman/agents/other.md':'Other.\n'},{name:'here'});
 let result=await run(['agent','build'],here);
 assert.equal(result.code,0,result.stdout);assert.equal(JSON.parse(result.stdout).agent,'here');
 const repo=await folder(t,{'.caveman/agents/support.md':'Support.\n'},{name:'repo'});
 result=await run(['agent','build'],repo);
 assert.equal(result.code,0,result.stdout);assert.equal(JSON.parse(result.stdout).agent,'support');
 const nested=await folder(t,{'.caveman/agents/coder/AGENT.md':'Code.\n','.caveman/agents/coder/skills/git/SKILL.md':'Git.\n'},{name:'nested'});
 result=await run(['agent','build'],nested);
 assert.equal(result.code,0,result.stdout);assert.deepEqual(JSON.parse(result.stdout).manifest.skills,[{name:'git',path:'skills/git/SKILL.md'}]);
 const many=await folder(t,{'.caveman/agents/b.md':'B.\n','.caveman/agents/a/AGENT.md':'A.\n'},{name:'many'});
 result=await run(['agent','build'],many);
 assert.equal(result.code,2,result.stdout);
 const error=JSON.parse(result.stdout).error;
 assert.equal(error.code,'cave_usage');assert.match(error.message,/More than one agent under \.caveman\/agents\/: a\/, b\.md\./);
 const none=await folder(t,{'README.md':'x\n'},{name:'none'});
 result=await run(['agent','build'],none);
 assert.equal(result.code,2);assert.match(JSON.parse(result.stdout).error.message,/No AGENT\.md/);
});

const refused=async(t,files,pattern,prepare)=>{
 const dir=await folder(t,{'AGENT.md':'Answer.\n',...files});
 await prepare?.(dir);
 const result=await run(['agent','build','triage'],dirname(dir));
 assert.equal(result.code,2,result.stdout);
 const error=JSON.parse(result.stdout).error;
 assert.equal(error.code,'cave_usage');assert.match(error.message,pattern);
 assert.equal(result.stderr,'');
};
test('a symlink is refused by name',async t=>{
 await refused(t,{'skills/refunds/SKILL.md':'Rules.\n'},/^skills\/refunds\/policy\.md is a symlink/,dir=>symlink(join(dir,'AGENT.md'),join(dir,'skills','refunds','policy.md')));
});
test('a file that is not UTF-8 text is refused by name',async t=>{
 await refused(t,{'skills/logo/SKILL.md':'Logo.\n','skills/logo/logo.png':Buffer.from([0x89,0x50,0x4e,0x47,0xff,0xfe])},/^skills\/logo\/logo\.png is not UTF-8 text/);
 await refused(t,{'evals/zero.eval.json':'{"a":"\u0000"}'},/^evals\/zero\.eval\.json is not text \(it holds a NUL byte\)/);
});
test('a file over its limit is refused by name',async t=>{
 await refused(t,{'skills/big/SKILL.md':'x'.repeat(LIMITS.file+1)},/^skills\/big\/SKILL\.md is 2\.0 MB, over the 2\.0 MB one file may be/);
 const dir=await folder(t,{'AGENT.md':'x'.repeat(LIMITS.agentFile+1)},{name:'huge'});
 const result=await run(['agent','build','huge'],dirname(dir));
 assert.equal(result.code,2);assert.match(JSON.parse(result.stdout).error.message,/^AGENT\.md is 256 KB, over the 256 KB one agent file may be/);
});
test('a build over 8 MiB is refused, naming the file that crosses it',async t=>{
 const part='y'.repeat(LIMITS.file-100),files={};
 for(const n of [1,2,3,4,5])files[`skills/s${n}/SKILL.md`]=part;
 await refused(t,files,/^The build is over 8\.0 MB at skills\/s5\/SKILL\.md/);
});
test('a tools/ folder holding JS or Python code builds schema-valid code tools',async t=>{
 const dir=await folder(t,{
  'AGENT.md':'---\ncomputer: none\n---\nAnswer.\n',
  'tools/lookup_order.ts':'// @caveman-tool {"description":"Look up an order","effect":"read","input_schema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}\nexport default async function(input){ return input; }\n',
  'tools/calc.py':'# @caveman-tool {"description":"Calculate","effect":"read"}\nprint(1)\n',
 });
 const b=build(locate(dir));
 assert.equal(b.manifest.sandbox.tier,'linux');
 assert.equal(b.manifest.tools.length,2);
 assert.deepEqual(b.manifest.tools.map(x=>({name:x.name,kind:x.kind,runtime:x.runtime,entry:x.entry})),[
  {name:'calc',kind:'code',runtime:'python',entry:'tools/calc.py'},
  {name:'lookup_order',kind:'code',runtime:'js',entry:'tools/lookup_order.ts'},
 ]);
 schemaValid(b.manifest);
 const jsOnly=build(locate(await folder(t,{
  'AGENT.md':'---\ncomputer: none\n---\nAnswer.\n',
  'tools/lookup_order.mjs':'// @caveman-tool {"description":"Look up an order","effect":"read"}\nexport default async function(input){ return input; }\n',
 })));
 assert.equal(jsOnly.manifest.sandbox.tier,'code');
 schemaValid(jsOnly.manifest);
});

test('the frontmatter reader reads the shapes the six keys take',()=>{
 assert.deepEqual(readFrontmatter('no frontmatter\n'),{});
 assert.deepEqual({...readFrontmatter('---\nname: "a b" # a comment\ndescription: Don\'t # trailing\nmodel: \'it\'\'s\'\nengine: caveman\ncomputer: none\ntools: [Read, "Grep", Bash]\n---\nbody\n')},
  {name:'a b',description:'Don\'t',model:'it\'s',engine:'caveman',computer:'none',tools:['Read','Grep','Bash']});
 // Block lists of scalars and of maps, with a nested block map; unknown keys are skipped unread.
 const front=readFrontmatter('\ufeff---\r\nname: x\r\npermissions:\r\n  allow: |\r\n    anything: [goes\r\nhooks: {a: [1,\r\n  2]}\r\ntools:\r\n- Read\r\n- type: custom\r\n  name: t\r\n  description: "Find \\"it\\" \\u00e9"\r\n  input_schema:\r\n    type: object\r\n    properties:\r\n      id: {type: integer, minimum: 1}\r\n    required:\r\n      - id\r\n    additionalProperties: false\r\n---\r\n');
 assert.deepEqual({...front},{name:'x',tools:['Read',{type:'custom',name:'t',description:'Find "it" é',input_schema:{type:'object',properties:{id:{type:'integer',minimum:1}},required:['id'],additionalProperties:false}}]});
 // A frontmatter that is one JSON object, as the agent SDK writes it.
 const json=agentFields('---\n{"name": "engineer", "computer": "full", "tools": [{"type": "custom", "name": "finish", "description": "End.", "input_schema": {"type": "object"}}]}\n---\nFix it.\n');
 assert.deepEqual(json,{name:'engineer',description:undefined,engine:undefined,model:undefined,computer:'full',tools:[{name:'finish',kind:'caller',description:'End.',input_schema:{type:'object'}}]});
});

test('the frontmatter reader refuses what it cannot read, naming the line',()=>{
 for(const [text,pattern] of [
  ['---\nname: x\n',/AGENT\.md line 1: opens the frontmatter with --- but no later --- line closes it/],
  ['---\nname: x\ndescription: |\n  long\n---\n',/line 3: starts a value with \|/],
  ['---\nmodel: &m auto\n---\n',/line 2: starts a value with &/],
  ['---\ntools:\n\t- Read\n---\n',/line 3: indents with a tab/],
  ['---\nname: a\n  b\n---\n',/line 3: continues the value of the line before/],
  ['---\nname: a\nname: b\n---\n',/line 3: repeats the key name/],
  ['---\ndescription: Look up: an order\n---\n',/line 2: holds ": " in an unquoted value/],
  ['---\ntools: [Read, {type: custom\n---\n',/line 2: expects , or }/],
  ['---\nmodel: "auto\n---\n',/line 2: has a quoted value that does not close/],
  ['---\njust words\n---\n',/line 2: is not a "key: value" line/],
  ['---\ntools:\n  - - Read\n---\n',/line 3: nests a list on one line/],
 ])assert.throws(()=>readFrontmatter(text),error=>error.exitCode===2&&error.code==='cave_usage'&&pattern.test(error.message),text);
 for(const [text,pattern] of [
  ['---\nengine: claude\n---\n',/line 2: engine must be caveman, claude-agent or codex/],
  ['---\nname: 12\n---\n',/line 2: name must be 1 to 100 letters/],
  ['---\ntools: Read, Grep\n---\n',/line 2: tools must be a list/],
  ['---\ntools:\n  - Read\n  - type: mcp\n    name: orders\n---\n',/line 4: a tool of type "mcp" is not one cvm builds/],
  ['---\ntools:\n  - type: custom\n    name: t\n    description: d\n---\n',/line 3: the custom tool t needs an input_schema/],
  ['---\ntools: [Read, Read]\n---\n',/line 2: the tool Read is listed twice/],
  ['---\ntools: ["Bash(git:*)"]\n---\n',/line 2: the tool "Bash\(git:\*\)" must be/],
 ])assert.throws(()=>agentFields(text),error=>error.exitCode===2&&pattern.test(error.message),text);
});

// ---- connectors and budgets ----------------------------------------------------
const spec61='---\nname: triage\nconnectors:\n  linear: { tools: [list_issues, get_issue, create_comment] }\n  github:\n    tools: [get_issue, list_pull_requests, create_pull_request]\n    args: { owner: acme, repo: support }\n  stripe: { tools: [get_charge, create_refund], approve: [create_refund] }\n  notion: { as: user }\nbudgets:\n  tools: 6000\n---\nYou triage support tickets.\n';

test('a build without connectors or budgets is byte for byte what it was before they were read',async t=>{
 // The digest of the triage folder's agent.json on the commit before connectors
 // (486fe276b), built by cvm 0.0.0. A release stamps its own version into
 // built_by, so the version is put back before the bytes are compared.
 const b=build(locate(await folder(t,triage)));
 const as000=b.agentJSON.replace(`"version": ${JSON.stringify(b.manifest.built_by.version)}`,'"version": "0.0.0"');
 assert.equal(sha(as000),'31ede7c8dfc8534a6097bda660f9de5e32969f54e7462b4ea8296b9a8e7e0da2');
 assert.ok(!('connectors' in b.manifest)&&!('budgets' in b.manifest));
 assert.doesNotMatch(b.agentJSON,/connector|budget/);
});

test('connectors as SPEC 6.1 writes them: the map, in the frontmatter\'s order, and budgets',async t=>{
 const b=build(locate(await folder(t,{'AGENT.md':spec61})));
 assert.deepEqual(Object.keys(b.manifest.connectors),['linear','github','stripe','notion']);
 assert.deepEqual(b.manifest.connectors,{
  linear:{tools:['list_issues','get_issue','create_comment']},
  github:{tools:['get_issue','list_pull_requests','create_pull_request'],args:{owner:'acme',repo:'support'}},
  stripe:{tools:['get_charge','create_refund'],approve:['create_refund']},
  notion:{as:'user'},
 });
 assert.deepEqual(b.manifest.budgets,{tools:6000});
 // Beside the other keys, before files.
 assert.deepEqual(Object.keys(b.manifest),['schema','name','loop','sandbox','connectors','budgets','files','built_by']);
 assert.match(b.agentJSON,/"connectors": \{\n {4}"linear": \{\n {6}"tools": \[/);
 // The summary line counts them.
 assert.match(summaryLine(b),/^2 files, [\d.]+ (B|KB), 4 connectors {2}sha256 [0-9a-f]{12}$/);
 const dir=await folder(t,{'AGENT.md':spec61},{name:'spec'});
 const screen=await run(['agent','build','spec','--format','table'],dirname(dir));
 assert.equal(screen.code,0,screen.stdout);
 assert.match(screen.stdout,/^total {4}2 files, [\d.]+ (B|KB), 4 connectors$/m);
 const json=JSON.parse((await run(['agent','build','spec'],dirname(dir))).stdout);
 assert.deepEqual(json.manifest.connectors,b.manifest.connectors);
});

test('the short form: each listed name becomes {}; nothing written after a name is {} too; a split as and pinned args of each type',async t=>{
 for(const text of ['---\nconnectors: [linear, notion]\n---\nx\n','---\nconnectors:\n  - linear\n  - notion\n---\nx\n','---\nconnectors:\n  linear:\n  notion: {}\n---\nx\n','---\n{"connectors": ["linear", "notion"]}\n---\nx\n']){
  const b=build(locate(await folder(t,{'AGENT.md':text})));
  assert.deepEqual(b.manifest.connectors,{linear:{},notion:{}},text);
  assert.equal(b.manifest.budgets,undefined);
  assert.match(summaryLine(b),/, 2 connectors {2}sha256/);
 }
 const one=build(locate(await folder(t,{'AGENT.md':'---\nconnectors: [crm-2]\n---\nx\n'})));
 assert.match(summaryLine(one),/, 1 connector {2}sha256/);
 const fields=agentFields('---\nconnectors:\n  github:\n    tools: [create_pull_request, list_repos]\n    as: {write: user, read: shared}\n    args: {owner: acme, number: 12, draft: false}\n    unpinned: [list_repos]\n    approve: [create_pull_request]\nbudgets: {tools: 100}\n---\n');
 assert.deepEqual(fields.connectors,{github:{tools:['create_pull_request','list_repos'],as:{read:'shared',write:'user'},args:{owner:'acme',number:12,draft:false},unpinned:['list_repos'],approve:['create_pull_request']}});
 assert.deepEqual(fields.budgets,{tools:100});
 // Without tools a connector's approve and unpinned name tools the deploy checks.
 assert.deepEqual(agentFields('---\nconnectors:\n  github: {unpinned: [list_repos]}\n---\n').connectors,{github:{unpinned:['list_repos']}});
 // 32 connectors, 200 tools, 16 arguments and a budget of 100,000 are the most.
 const many=Array.from({length:32},(_,i)=>`c${i}`);
 assert.equal(Object.keys(agentFields(`---\nconnectors: [${many}]\n---\n`).connectors).length,32);
 const tools=Array.from({length:200},(_,i)=>`t${i}`),args=Object.fromEntries(Array.from({length:16},(_,i)=>[`a${i}`,i]));
 assert.equal(agentFields(`---\nconnectors:\n  big: {tools: [${tools}], args: ${JSON.stringify(args)}}\nbudgets: {tools: 100000}\n---\n`).connectors.big.tools.length,200);
});

test('connectors and budgets refuse what the build contract does not take, naming the line',()=>{
 const many=n=>Array.from({length:n},(_,i)=>`c${i}`).join(', ');
 for(const [text,pattern] of [
  ['---\nconnectors: linear\n---\n',/line 2: connectors must be a list of names, such as \[linear, notion\], or a map/],
  ['---\nconnectors: [Linear]\n---\n',/line 2: the connector "Linear" must be a connector's name: lowercase letters, digits and single hyphens, a letter first, at most 32 characters\./],
  ['---\nconnectors:\n  1password: {}\n---\n',/line 3: the connector "1password" must be a connector's name/],
  ['---\nconnectors: [linear--two]\n---\n',/line 2: the connector "linear--two" must be/],
  [`---\nconnectors: [${'a'.repeat(33)}]\n---\n`,/line 2: the connector "a{33}" must be/],
  ['---\nconnectors:\n  - linear\n  - notion\n  - linear\n---\n',/line 5: the connector linear is listed twice\./],
  ['---\nconnectors:\n  - linear: {tools: [a]}\n---\n',/line 3: lists a map: a list names connectors/],
  [`---\nconnectors: [${many(33)}]\n---\n`,/line 2: connectors names 33 connectors; an agent uses at most 32\./],
  ['---\nconnectors:\n  linear: 5\n---\n',/line 3: linear takes a map of what it may use/],
  ['---\nconnectors:\n  linear: {mode: x}\n---\n',/line 3: linear takes tools, as, args, approve and unpinned; mode is not one of them\./],
  ['---\nconnectors:\n  linear:\n    tools: []\n---\n',/line 4: linear's tools names 0 tools; it names 1 to 200\./],
  [`---\nconnectors:\n  linear: {tools: [${many(201)}]}\n---\n`,/line 3: linear's tools names 201 tools; it names 1 to 200\./],
  ['---\nconnectors:\n  linear:\n    tools: list_issues\n---\n',/line 4: linear's tools must be a list of tool names/],
  ['---\nconnectors:\n  linear:\n    tools:\n      - list_issues\n      - 12\n---\n',/line 6: linear's tools: 12 is not a tool name/],
  ['---\nconnectors:\n  linear:\n    tools: [a, a]\n---\n',/line 4: linear's tools lists a twice\./],
  ['---\nconnectors:\n  linear: {tools: ["two words"]}\n---\n',/line 3: linear's tools: "two words" is not a tool name/],
  ['---\nconnectors:\n  linear: {as: admin}\n---\n',/line 3: linear's as must be shared, user or end_user/],
  ['---\nconnectors:\n  linear:\n    as: {read: shared}\n---\n',/line 4: linear's as split by effect is \{read: \.\.\., write: \.\.\.\}/],
  ['---\nconnectors:\n  linear:\n    args: [owner]\n---\n',/line 4: linear's args must be a map/],
  ['---\nconnectors:\n  linear:\n    args:\n      owner: acme\n      team: null\n---\n',/line 6: linear's argument team must be a string, a number or true or false\./],
  [`---\nconnectors:\n  linear: {args: ${JSON.stringify(Object.fromEntries(Array.from({length:17},(_,i)=>[`a${i}`,1])))}}\n---\n`,/line 3: linear's args pins 17 arguments; it pins at most 16\./],
  ['---\nconnectors:\n  linear:\n    tools: [a]\n    approve: [a, b]\n---\n',/line 5: linear's approve names b, which is not in its tools\./],
  ['---\nconnectors:\n  linear:\n    tools: [a]\n    unpinned: [a, a]\n---\n',/line 5: linear's unpinned lists a twice\./],
  ['---\nconnectors:\n  linear: {__proto__: {tools: [a]}}\n---\n',/line 3: uses the key __proto__/],
  ['---\nbudgets: 6000\n---\n',/line 2: budgets must be a map, such as \{tools: 6000\}\./],
  ['---\nbudgets: {usd: 5}\n---\n',/line 2: budgets takes tools .*; usd is not one of them\./],
  ['---\nbudgets:\n  tools: 99\n---\n',/line 3: budgets\.tools must be a whole number of tokens from 100 to 100,000\./],
  ['---\nbudgets: {tools: 100001}\n---\n',/line 2: budgets\.tools must be/],
  ['---\nbudgets: {tools: 600.5}\n---\n',/line 2: budgets\.tools must be/],
  ['---\nbudgets: {}\n---\n',/line 2: budgets\.tools must be/],
 ])assert.throws(()=>agentFields(text),error=>error.exitCode===2&&error.code==='cave_usage'&&pattern.test(error.message),text);
});

// ---- drives --------------------------------------------------------------------
const spec31='---\nname: triage\ndrives:\n  /kb:     support-kb\n  /memory: { drive: triage-memory, write: true }\n  /work:   { drive: customers, folder: "{customer}", write: true }\n---\nYou triage support tickets.\n';

test('drives as SPEC 3.1 writes them: a name stays a name, a mount keeps what it says, and the build says how many',async t=>{
 const dir=await folder(t,{'AGENT.md':spec31});
 const b=build(locate(dir));
 assert.deepEqual(b.manifest.drives,{'/kb':'support-kb','/memory':{drive:'triage-memory',write:true},'/work':{drive:'customers',folder:'{customer}',write:true}});
 assert.deepEqual(Object.keys(b.manifest),['schema','name','loop','sandbox','drives','files','built_by']);
 schemaValid(b.manifest);
 assert.match(summaryLine(b),/^2 files, [\d.]+ (B|KB), 3 drive mounts {2}sha256 [0-9a-f]{12}$/);
 const json=JSON.parse((await run(['agent','build'],dir)).stdout);
 assert.deepEqual(json.manifest.drives,b.manifest.drives);
 // Every key a mount takes, in block form and in a JSON frontmatter.
 const every={drive:'customers',folder:'/accounts/{region}/{customer}',write:true,review:true,trusted:false,description:"This customer's folder."};
 for(const text of ['---\ndrives:\n  /work:\n    drive: customers\n    folder: "/accounts/{region}/{customer}"\n    write: true\n    review: true\n    trusted: false\n    description: "This customer\'s folder."\n---\nx\n',`---\n${JSON.stringify({drives:{'/work':every}})}\n---\nx\n`]){
  const fields=agentFields(text);
  assert.deepEqual(fields.drives,{'/work':every},text);
  schemaValid({schema:'caveman.agent.build.v1',name:'x',loop:{kind:'managed'},sandbox:{tier:'none'},drives:fields.drives,files:[{path:'AGENT.md',sha256:'a'.repeat(64),bytes:1}]});
 }
 // Eight mounts are the most.
 const eight=Array.from({length:8},(_,i)=>`  /m${i}: kb`).join('\n');
 assert.equal(Object.keys(agentFields(`---\ndrives:\n${eight}\n---\n`).drives).length,8);
});

test('drives refuse what the build contract does not take, naming the key and the line',async t=>{
 for(const [text,pattern] of [
  ['---\ndrives: [kb]\n---\n',/line 2: drives must be a map from a mount path to a drive/],
  ['---\ndrives:\n  /Work: customers\n---\n',/line 3: drives\.\/Work: a mount path is \/ and 1 to 63 lowercase letters, digits, '_' or '-'/],
  ['---\ndrives:\n  kb: support-kb\n---\n',/line 3: drives\.kb: a mount path is \//],
  ['---\ndrives:\n  /a/b: support-kb\n---\n',/line 3: drives\.\/a\/b: a mount path is/],
  [`---\ndrives:\n  /${'a'.repeat(64)}: kb\n---\n`,/line 3: drives\.\/a{64}: a mount path is/],
  ['---\ndrives:\n  /kb: Support_KB\n---\n',/line 3: drives\.\/kb: "Support_KB" is not a drive's name/],
  ['---\ndrives:\n  /kb: 12\n---\n',/line 3: drives\.\/kb is a drive's name, such as support-kb, or \{drive: \.\.\./],
  ['---\ndrives:\n  /kb: {write: true}\n---\n',/line 3: drives\.\/kb names no drive: write \{drive: <name>, \.\.\.\}\./],
  ['---\ndrives:\n  /kb:\n    drive: kb\n    mode: rw\n---\n',/line 5: drives\.\/kb takes drive, folder, write, review, trusted and description; mode is not one of them\./],
  ['---\ndrives:\n  /kb:\n    drive: kb\n    write: yes\n---\n',/line 5: drives\.\/kb\.write is true or false\./],
  ['---\ndrives:\n  /kb: {drive: kb, folder: "x{Customer}"}\n---\n',/line 3: drives\.\/kb\.folder: a placeholder is \{name\}/],
  ['---\ndrives:\n  /kb: {drive: kb, folder: "a}"}\n---\n',/line 3: drives\.\/kb\.folder: a placeholder is/],
  ['---\ndrives:\n  /kb: {drive: kb, folder: a/../b}\n---\n',/line 3: drives\.\/kb\.folder names folders between single slashes/],
  ['---\ndrives:\n  /kb: {drive: kb, folder: "a/"}\n---\n',/line 3: drives\.\/kb\.folder names folders between single slashes/],
  ['---\ndrives:\n  /kb: {drive: kb, folder: ""}\n---\n',/line 3: drives\.\/kb\.folder is a folder of the drive: text of 1 to 1,024 characters/],
  [`---\ndrives:\n  /kb: {drive: kb, description: "${'x'.repeat(201)}"}\n---\n`,/line 3: drives\.\/kb\.description is one line of at most 200 characters/],
  [`---\ndrives:\n${Array.from({length:9},(_,i)=>`  /m${i}: kb`).join('\n')}\n---\n`,/line 2: drives mounts 9 folders; an agent mounts at most 8\./],
  [`---\ndrives:\n  /a: {drive: kb, folder: "${Array.from({length:9},(_,i)=>`{p${i}}`).join('/')}"}\n  /b: {drive: kb, folder: "${Array.from({length:8},(_,i)=>`{q${i}}`).join('/')}"}\n---\n`,/line 2: drives' folders hold 17 placeholders; a session's subject fills at most 16\./],
  ['---\ndrives:\n  /kb: kb\n  /kb: other\n---\n',/line 4: repeats the key \/kb\./],
  ['---\ndrives:\n  __proto__: {drive: kb}\n---\n',/line 2: uses the key __proto__/],
 ])assert.throws(()=>agentFields(text),error=>error.exitCode===2&&error.code==='cave_usage'&&pattern.test(error.message),text);
 // Through the command: the refusal names the key and what to write.
 await refused(t,{'AGENT.md':'---\ndrives:\n  /Work: customers\n---\nx\n'},/^AGENT\.md line 3: drives\.\/Work: a mount path is \/ and 1 to 63 lowercase letters, digits, '_' or '-', starting with a letter or digit, such as \/kb\.$/);
});

test('help answers without a sign-in or a request',async t=>{
 const dir=await folder(t,{'AGENT.md':'x\n'});
 const result=await run(['agent','build','--help'],dir);
 assert.equal(result.code,0);assert.match(JSON.parse(result.stdout).usage,/^cvm agent build /);
 const family=await run(['agent','--help','--format','json'],dir);
 assert.ok(JSON.parse(family.stdout).verbs.some(v=>v.verb==='build'));
 assert.ok(relative(dir,bin).length>0);
});
