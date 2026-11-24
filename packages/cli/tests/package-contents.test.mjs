import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {leaks} from '../scripts/leaks.mjs';
import {operations} from '../dist/cloud-client.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));

// Runs on the built files (`npm test` and CI build first); check-package.mjs
// repeats the scan on the packed tarball.
test('the files npm ships carry no admin routes, exclusion notes or private repository',async()=>{
 const {files}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.deepEqual(await leaks(root,files),[]);
});

test('the bundled catalogue holds callable operations only, without the server\'s exclusion notes',()=>{
 assert.ok(operations.length>0);
 for(const op of operations){
  assert.ok(!op.path.startsWith('/admin'),op.id);
  assert.equal(op.exclusion,undefined,op.id);
  assert.ok(['read','write','none'].includes(op.access),op.id);
 }
});
