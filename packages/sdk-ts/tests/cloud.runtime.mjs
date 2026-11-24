import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Cloud, CloudError, cloudOperationMetadata} from '../dist/cloud.js';

const projectId='11111111-1111-4111-8111-111111111111';
const envelope=(id,data={})=>({schema_version:1,operation:id,version:cloudOperationMetadata[id].version,contract_sha256:cloudOperationMetadata[id].contract,ok:true,status:'completed',data});

test('typed resource writes preserve scope, contract, and caller retry identity',async()=>{
 let calls=0;
 const cloud=new Cloud({controlURL:'https://control.example',accessToken:'secret',projectId,fetch:async(url,init)=>{
  calls++;
  assert.equal(url,`https://control.example/api/v1/projects/${projectId}/cloud/operations/datasets.create`);
  assert.equal(init.redirect,'error');
  assert.equal(init.headers.authorization,'Bearer secret');
  assert.equal(init.headers['idempotency-key'],'same-request');
  assert.equal(init.headers['x-cave-operation-contract'],cloudOperationMetadata['datasets.create'].contract);
  assert.equal(JSON.parse(init.body).name,'Cases');
  return Response.json(envelope('datasets.create',{id:'saved'}));
 }});
 await assert.rejects(cloud.datasets.create({name:'Cases',document:{}}),{code:'cave_idempotency_key_required'});
 assert.equal(calls,0);
 assert.equal((await cloud.datasets.create({name:'Cases',document:{}},{idempotencyKey:'same-request'})).data.id,'saved');
 assert.equal(calls,1);
});

test('resources reject mismatched envelopes and preserve denied scope without retries',async()=>{
 let calls=0;
 const cloud=new Cloud({controlURL:'https://control.example',accessToken:'secret',projectId,fetch:async()=>{
  calls++;
  return calls===1?Response.json(envelope('prompts.list')):calls===2?Response.json({error:{error:{code:'cave_scope_forbidden',message:'Scope denied.'}}},{status:403})
   :Response.json({error:{code:'cave_operation_version_conflict',message:'Installed operation contract differs from server; refresh client discovery.'}},{status:409});
 }});
 // One plain line: what is wrong and how to fix it.
 const upgrade='This @caveman-ai/sdk and the Caveman server speak different API versions. Upgrade the SDK (npm install @caveman-ai/sdk@latest), or install the version that matches a self-hosted server, then run again.';
 await assert.rejects(cloud.datasets.list(),{code:'cave_operation_version_conflict',message:upgrade});
 await assert.rejects(cloud.datasets.list(),error=>error instanceof CloudError&&error.code==='cave_scope_forbidden'&&error.status===403);
 // A server built after a contract change refuses an older SDK with a bare 409: the SDK says the same line.
 await assert.rejects(cloud.datasets.list(),{code:'cave_operation_version_conflict',status:409,message:upgrade});
 assert.equal(calls,3);
});

test('scenario resource uses existing operation identity, not alias on wire',async()=>{
 const id='evals.get_scenario_projects_projectid_scenario_runs_runid';
 const cloud=new Cloud({controlURL:'http://localhost:1234',accessToken:'secret',projectId,fetch:async(url)=>{
  assert.ok(url.endsWith('/'+id));return Response.json(envelope(id,{id:projectId,status:'cancelled'}));
 }});
 assert.equal((await cloud.scenarioRuns.get({run_id:projectId})).data.status,'cancelled');
});

test('credentials cannot travel to plaintext remote origins or implicit projects',async()=>{
 assert.throws(()=>new Cloud({controlURL:'http://remote.example',accessToken:'secret'}),{code:'cave_endpoint_invalid'});
 const cloud=new Cloud({controlURL:'https://control.example',accessToken:'secret',fetch:()=>{throw Error('must not connect');}});
 await assert.rejects(cloud.prompts.list(),{code:'cave_project_required'});
});
