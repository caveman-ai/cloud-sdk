// What must never reach the npm tarball: admin routes and the server's
// exclusion notes from the operation catalogue, the private source repository,
// and paths into it. check-package.mjs scans the packed tarball with this list
// and tests/package-contents.test.mjs scans the built files before packing.
import {readdir,readFile,stat} from 'node:fs/promises';
import {join,relative} from 'node:path';

export const forbidden=['/admin/','Not RBAC-guarded','boat.dev','Caveman-Cloud','caveman-code-app','cloud/agent-surface','cloud/internal/','/Users/'];

// The leaks in root's package.json and in each of paths (files or directories,
// relative to root; default everything under root), as [{path, problems}].
// An empty list is clean.
export async function leaks(root,paths=['.']){
 const files=new Set(['package.json']);
 for(const path of paths){
  if((await stat(join(root,path))).isFile()){files.add(relative(root,join(root,path)));continue;}
  for(const entry of await readdir(join(root,path),{recursive:true,withFileTypes:true}))if(entry.isFile())files.add(relative(root,join(entry.parentPath,entry.name)));
 }
 const found=[];
 for(const file of [...files].sort()){
  const text=await readFile(join(root,file),'utf8');
  const problems=forbidden.filter(word=>text.includes(word));
  // The source repository is private: a link to it is a dead end at best.
  if(file==='package.json'){const repoUrl=JSON.stringify(JSON.parse(text).repository??'');if(/Caveman-Cloud|caveman-code-app/i.test(repoUrl))problems.push('private repository URL in package.json');}
  if(problems.length)found.push({path:file,problems});
 }
 return found;
}
