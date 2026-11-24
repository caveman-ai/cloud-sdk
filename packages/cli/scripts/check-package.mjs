// Packs @caveman-ai/cloud, installs the tarball offline into an empty prefix and
// runs the installed `cvm`: what a user gets from npm, not the source tree.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {leaks} from './leaks.mjs';

const packageDirectory=fileURLToPath(new URL('..',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'caveman-cloud-package-'));
const npm=process.platform==='win32'?'npm.cmd':'npm';
function run(command,args,cwd,{env=process.env,input}={}){
 const result=spawnSync(command,args,{cwd,env,input,encoding:'utf8',shell:process.platform==='win32'&&command===npm,timeout:120000});
 assert.equal(result.status,0,`${command} ${args.join(' ')} failed: ${result.error?.message??result.stderr}\n${result.stdout}`);
 return result.stdout;
}
try{
 // Windows' configured global install prefix need not contain npm itself.
 const npmCLI=process.platform==='win32'
  ?join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')
  :join(run(npm,['root','--global'],packageDirectory).trim(),'npm','bin','npm-cli.js');
 await access(npmCLI);
 run(process.execPath,[join(packageDirectory,'scripts','build.mjs')],packageDirectory);
 const [packed]=JSON.parse(run(process.execPath,[npmCLI,'pack','--ignore-scripts','--json','--pack-destination',directory],packageDirectory));
 // Publishing this client must never include adjacent private Cloud source,
 // source maps, local configuration, tests, or release tooling.
 const shipped=packed.files.map(file=>file.path);
 // cvm.mjs imports these on demand, so a tarball without them still installs
 // and only fails when `cvm evals ci|run|validate|init`, a deploy verb, `cvm agent init`, `cvm drive`, `cvm connect` or `cvm sandbox` is typed.
 // `cvm agent init ask` writes its folder from templates/ask/, read beside bin/ at run time.
  const templates=[
   'templates/ask/AGENT.md',
   'templates/pr-reviewer/AGENT.md',
   'templates/pr-reviewer/agents/security/AGENT.md',
   'templates/researcher-drive/AGENT.md',
   'templates/support-slack/AGENT.md',
   'templates/support-slack/skills/refunds/SKILL.md',
   'templates/ts-tools/AGENT.md',
   'templates/ts-tools/tools/prorate_refund.mjs',
  ];
  for(const file of ['bin/ci.mjs','bin/evals.mjs','bin/agent-build.mjs','bin/agent-init.mjs',...templates,'bin/deploy.mjs','bin/drive.mjs','bin/connect.mjs','bin/sandbox.mjs','dist/criterion-registry.json','dist/sandboxes.mjs'])assert.ok(shipped.includes(file),`npm tarball lacks ${file}: add it to "files" in package.json`);
  // The skill `cvm setup` installs: the registry's cvm suite, entry first.
  const [entry,...references]=JSON.parse(await readFile(join(packageDirectory,'..','skills','registry.json'),'utf8')).suites.cvm;
  assert.equal(entry,'caveman-cloud');
  const skill=['dist/skills/caveman-cloud/SKILL.md',...references.map(id=>`dist/skills/caveman-cloud/references/${id}.md`)];
  assert.deepEqual(shipped.sort(),[
   'LICENSE','README.md','bin/agent-build.mjs','bin/agent-init.mjs','bin/agents.mjs','bin/ci.mjs','bin/connect.mjs','bin/cvm.mjs','bin/deploy.mjs','bin/drive.mjs','bin/evals.mjs','bin/sandbox.mjs','bin/setup.mjs','bin/tui.mjs','dist/cloud-client.mjs','dist/cloud-mcp.mjs','dist/criterion-registry.json','dist/sandboxes.mjs','package.json',...templates,...skill,
  ].sort(),'npm tarball must contain only the reviewed client files, templates, and the Caveman Cloud skill');
 for(const file of ['dist/cloud-client.mjs','dist/cloud-mcp.mjs','dist/sandboxes.mjs']){
  const bundle=await readFile(join(packageDirectory,file),'utf8');
  assert.ok(!bundle.includes('sourceMappingURL='),'published client must not embed or reference source maps');
 }
 const install=join(directory,'install'),home=join(directory,'home');await mkdir(install);await mkdir(home);
 run(process.execPath,[npmCLI,'install','--offline','--ignore-scripts','--no-audit','--no-fund',join(directory,packed.filename)],install);
 const installed=join(install,'node_modules','@caveman-ai','cloud');
 const manifest=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
 // The installed copy is the tarball's content: no admin route, server
 // exclusion note, private repository link or path into the private source.
 assert.deepEqual(await leaks(installed),[],'npm tarball leaks private Cloud details');
 assert.equal(Object.keys(manifest.dependencies??{}).length,0,'published runtime dependencies must remain zero');
 const cvm=join(installed,manifest.bin.cvm);
 // Every agent config cvm could touch resolves inside the scratch HOME.
 const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData','Roaming'),CAVEMAN_HOME:join(home,'.caveman'),CAVE_NO_KEYCHAIN:'1',CI:'1'};
 for(const name of ['CAVE_TOKEN','CAVE_PROJECT_ID','CAVE_API_URL','CLAUDE_CONFIG_DIR','CODEX_HOME','XDG_CONFIG_HOME'])delete env[name];
 // A skill an older cvm installed is refreshed from the installed bundle by the next command.
 const installedSkill=join(home,'.claude','skills','caveman-cloud');
 await mkdir(installedSkill,{recursive:true});await writeFile(join(installedSkill,'.cvm-version'),'older');
 for(const args of [['tools','describe','datasets.create'],['tools','schema','evals.run'],['context','list']])JSON.parse(run(process.execPath,[cvm,...args,'--format','json'],install,{env}));
 assert.equal(await readFile(join(installedSkill,'.cvm-version'),'utf8'),manifest.version);
 assert.equal(await readFile(join(installedSkill,'SKILL.md'),'utf8'),await readFile(join(installed,'dist','skills','caveman-cloud','SKILL.md'),'utf8'));
 assert.deepEqual(JSON.parse(run(process.execPath,[cvm,'setup','--remove','--format','json'],install,{env})),{skill:{removed:[installedSkill]},mcp:{removed:[]}});
 // The eval commands answer from the installed tarball, with no sign-in and no server.
 const evalCommands=[['evals','ci','--help'],['evals','run','--help'],['evals','validate','--help'],['evals','watch','--help']];
 for(const args of evalCommands)assert.match(JSON.parse(run(process.execPath,[cvm,...args],install,{env})).usage,new RegExp(`^cvm ${args[0]} ${args[1]} `),`cvm ${args.join(' ')} must print its usage`);
 // And the on-ramp runs end to end: a starter file, checked, its task run here.
 const starter=JSON.parse(run(process.execPath,[cvm,'evals','init'],home,{env})).file;
 assert.equal(JSON.parse(run(process.execPath,[cvm,'evals','validate',starter,'--offline'],home,{env})).status,'valid');
 assert.equal(JSON.parse(run(process.execPath,[cvm,'evals','run',starter,'--dry-run'],home,{env})).status,'dry_run');
 assert.equal(JSON.parse(run(process.execPath,[cvm,'evals','ci',starter,'--dry-run'],home,{env})).status,'dry_run');
 // The deploy verbs answer their help offline, and an agent folder builds with no server.
 const deployCommands=[['agent','build','--help'],['deploy','--help'],['run','--help'],['deployments','--help']];
 for(const args of deployCommands)assert.match(JSON.parse(run(process.execPath,[cvm,...args],install,{env})).usage,new RegExp(`^cvm ${args.slice(0,-1).join(' ')} `),`cvm ${args.join(' ')} must print its usage`);
 // The drive verbs answer their help offline too: the family's, and one verb's.
 const driveVerbs=JSON.parse(run(process.execPath,[cvm,'drive','--help'],install,{env})).commands.map(command=>command.verb);
 assert.ok(driveVerbs.includes('put')&&driveVerbs.includes('share'),'cvm drive --help must list its verbs');
 assert.match(JSON.parse(run(process.execPath,[cvm,'drive','ls','--help'],install,{env})).usage,/^cvm drive ls /,'cvm drive ls --help must print its usage');
 // The connect verbs answer their help offline too: the family's, and one verb's.
 const connectVerbs=JSON.parse(run(process.execPath,[cvm,'connect','--help'],install,{env})).commands.map(command=>command.verb);
 assert.ok(connectVerbs.includes('add')&&connectVerbs.includes('accept'),'cvm connect --help must list its verbs');
 assert.match(JSON.parse(run(process.execPath,[cvm,'connect','add','--help'],install,{env})).usage,/^cvm connect add /,'cvm connect add --help must print its usage');
 const agentDir=join(home,'starter-agent');await mkdir(agentDir);await writeFile(join(agentDir,'AGENT.md'),'---\nname: starter\n---\nAnswer.\n');
 assert.equal(JSON.parse(run(process.execPath,[cvm,'agent','build',agentDir],home,{env})).manifest.name,'starter');
 // And `cvm agent init ask` writes the Ask agent from the template the tarball carries, offline, and it builds.
 const ask=JSON.parse(run(process.execPath,[cvm,'agent','init','ask',join(home,'ask-agent'),'--format','json'],home,{env}));
 assert.deepEqual([ask.status,ask.agent,ask.files],['written','ask',['AGENT.md']]);
 assert.equal(await readFile(join(home,'ask-agent','AGENT.md'),'utf8'),await readFile(join(installed,'templates','ask','AGENT.md'),'utf8'));
 const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'check-package',version:'0'}}};
 assert.equal(JSON.parse(run(process.execPath,[cvm,'mcp'],install,{env,input:JSON.stringify(init)+'\n'}).split('\n')[0]).id,1);
 process.stdout.write(JSON.stringify({platform:process.platform,package:manifest.name,packed_bytes:packed.size,unpacked_bytes:packed.unpackedSize,runtime_dependencies:0,leaks:0,offline_commands:3,skill_files:skill.length,eval_commands:evalCommands.length+4,deploy_commands:deployCommands.length+2,drive_commands:driveVerbs.length,connect_commands:connectVerbs.length,mcp_initialize:true})+'\n');
}finally{await rm(directory,{recursive:true,force:true});}
