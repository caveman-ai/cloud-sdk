import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentInit,TEMPLATES} from '../bin/agent-init.mjs';
import {build,locate} from '../bin/agent-build.mjs';
import {agentDev} from '../bin/agent-dev.mjs';

test('all cvm agent init templates write valid agent builds', async () => {
 const dir=mkdtempSync(join(tmpdir(),'cvm-parity-'));
 try{
  for(const name of Object.keys(TEMPLATES)){
   const target=join(dir,name);
   const code=await agentInit([name,target,'--format','json']);
   assert.equal(code,0,`init ${name} failed`);
   const built=build(locate(target));
   assert.equal(built.manifest.schema,'caveman.agent.build.v1');
   if(name==='support-slack'){
    assert.equal(built.manifest.skills?.length,1);
    assert.equal(built.manifest.channels?.slack?.thread_mode,'session');
    assert.equal(built.manifest.connectors?.linear?.after_untrusted,'approve');
   }
   if(name==='pr-reviewer'){
    assert.equal(built.manifest.subagents?.length,1);
    assert.equal(built.manifest.output_schema?.type,'object');
   }
   if(name==='researcher-drive'){
    assert.equal(built.manifest.schedules?.['daily-digest']?.cron,'0 9 * * 1-5');
    const devCode=await agentDev([target,'--trigger','schedule:daily-digest','--format','json'],{cwd:dir});
    assert.equal(devCode,0);
   }
   if(name==='ts-tools'){
    assert.equal(built.manifest.sandbox.tier,'code');
    assert.equal(built.manifest.tools?.length,1);
    assert.equal(built.manifest.tools[0].kind,'code');
    assert.equal(built.manifest.tools[0].name,'prorate_refund');
   }
  }
 }finally{
  rmSync(dir,{recursive:true,force:true});
 }
});
