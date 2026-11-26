import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build,locate} from '../bin/agent-build.mjs';

const bin=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
const templateDir=fileURLToPath(new URL('../templates/ask',import.meta.url));
const templateInstructions=fileURLToPath(new URL('../templates/ask/instructions.md',import.meta.url));
const templateConfig=fileURLToPath(new URL('../templates/ask/agent.json',import.meta.url));
// The six tools Caveman's own MCP server lists, and the read-only ones among them.
const surface=await readFile(new URL('../client/mcp-catalog.mjs',import.meta.url),'utf8');
const served=[...surface.matchAll(/\{name:'(caveman_[a-z_]+)'[^\n]*annotations:(read|\{[^}]*\})\}/g)].map(([,name,hints])=>({name,read:hints==='read'}));

async function scratch(t){
 const dir=await mkdtemp(join(tmpdir(),'cvm-agent-init-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 return dir;
}
const run=(args,cwd,env={})=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[bin,...args],{cwd,env:{HOME:cwd,USERPROFILE:cwd,CAVEMAN_HOME:join(cwd,'.caveman-home'),PATH:'/usr/bin:/bin',CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',...env},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr,json:()=>JSON.parse(stdout)}));
});

test('Ask Caveman is a build with no sandbox, a concrete model and one connector: Caveman\'s own read tools',()=>{
 const b=build(locate(templateDir));
 assert.equal(b.name,'ask');
 assert.deepEqual(b.manifest.sandbox,{tier:'none'});
 assert.equal(b.manifest.model,'claude-sonnet-5-5');
 assert.deepEqual(Object.keys(b.manifest.connectors),['caveman']);
 // Every tool Ask names is one /mcp serves, read-only by its own annotations; it names no write.
 assert.equal(served.length,6,JSON.stringify(served));
 const tools=b.manifest.connectors.caveman.tools;
 assert.deepEqual(tools,['caveman_context','caveman_search','caveman_describe','caveman_read']);
 for(const tool of tools)assert.ok(served.some(s=>s.name===tool&&s.read),tool);
 assert.ok(served.some(s=>s.name==='caveman_write'&&!s.read));
 const text=b.files.find(f=>f.path==='AGENT.md').text;
 for(const tool of tools)assert.match(text,new RegExp(`caveman__${tool}`));
 assert.doesNotMatch(text,/\/workspace|finish|mcpServers|caveman__caveman_write/);
});

test('all five templates use instructions.md + agent.json and build cleanly',()=>{
 for(const name of ['ask','pr-reviewer','researcher-drive','support-slack','ts-tools']){
  const dir=fileURLToPath(new URL(`../templates/${name}`,import.meta.url));
  const b=build(locate(dir));
  assert.equal(b.name,name);
  assert.ok(b.files.some(f=>f.path==='AGENT.md'));
 }
});

test('cvm agent init ask writes the folder, builds it, and prints connect, deploy and run for the hosted Cloud',async t=>{
 const cwd=await scratch(t);
 const result=await run(['agent','init','ask','--format','json'],cwd);
 assert.equal(result.code,0,result.stdout+result.stderr);
 const out=result.json();
 assert.equal(out.status,'written');assert.equal(out.agent,'ask');assert.deepEqual(out.files,['agent.json','instructions.md']);assert.deepEqual(out.connectors,['caveman']);
 assert.equal(await readFile(join(cwd,'ask','instructions.md'),'utf8'),await readFile(templateInstructions,'utf8'));
 assert.equal(await readFile(join(cwd,'ask','agent.json'),'utf8'),await readFile(templateConfig,'utf8'));
 assert.deepEqual(out.next.map(step=>step.command),['cvm connect add caveman','cvm deploy ask --budget 1','cvm run ask "Which agent spent the most in the last 7 days, and on what?"']);
 assert.equal(out.sha256,build(locate(join(cwd,'ask'))).digest);
});

test('cvm agent init ask DIR on another installation names its own console\'s /mcp; a table on a terminal',async t=>{
 const cwd=await scratch(t);
 const result=await run(['agent','init','ask','agents/ask me','--format','table'],cwd,{CAVE_API_URL:'https://cloud.acme.example'});
 assert.equal(result.code,0,result.stdout+result.stderr);
 assert.match(result.stdout,/^wrote    agents\/ask me\/agent\.json, agents\/ask me\/instructions\.md\nagent    ask  2 files, [0-9.]+ KB, 1 connector  sha256 [0-9a-f]{12}\nnext     cvm connect add https:\/\/<your console's origin>\/mcp --name caveman\n/);
 assert.match(result.stdout,/\n         cvm deploy 'agents\/ask me' --budget 1\n/);
 assert.deepEqual((await readdir(join(cwd,'agents','ask me'))).sort(),['agent.json','instructions.md']);
});

test('cvm agent init refuses an unknown template, a folder that already holds instructions.md or agent.json, and a file; help needs no sign-in',async t=>{
 const cwd=await scratch(t);
 let result=await run(['agent','init','nope','--format','json'],cwd);
 assert.equal(result.code,2);assert.match(result.json().error.message,/no template "nope"\. Templates: ask/);
 await mkdir(join(cwd,'taken'));await writeFile(join(cwd,'taken','instructions.md'),'mine\n');
 result=await run(['agent','init','ask','taken','--format','json'],cwd);
 assert.equal(result.code,2);assert.match(result.json().error.message,/taken already holds instructions\.md; cvm writes over nothing/);
 assert.equal(await readFile(join(cwd,'taken','instructions.md'),'utf8'),'mine\n');
 await writeFile(join(cwd,'plain'),'x');
 result=await run(['agent','init','ask','plain','--format','json'],cwd);
 assert.equal(result.code,2);assert.match(result.json().error.message,/plain is a file/);
 result=await run(['agent','init','--help','--format','json'],cwd);
 assert.equal(result.code,0);assert.match(result.json().usage,/^cvm agent init TEMPLATE/);
 const family=await run(['agent','--help','--format','json'],cwd);
 assert.ok(family.json().verbs.some(v=>v.verb==='init'));
});
