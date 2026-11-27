import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rename,rm,symlink,chmod,stat,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TEST_CONCURRENCY,limitSpawn,mapPool} from './pool.mjs';

const bin=fileURLToPath(new URL('../bin/cvm.mjs',import.meta.url));
// `cvm drive` as it runs when stdout is a terminal: the one fact it reads to
// decide that (process.stdout.isTTY) is set, and stdout is still captured.
const asTerminal='const {drive}=await import(process.argv[1]);process.stdout.isTTY=true;process.exitCode=await drive(process.argv.slice(2),{context:async()=>({baseURL:process.env.CVM_TEST_URL,token:process.env.CVM_TEST_TOKEN}),instance:()=>process.env.CVM_TEST_URL});';
const secret='synthetic-person-sign-in-never-print';
const key='cave_live_abcdefghijkl_synthetic-key-never-print';
const token='cdrv_00000000-0000-4000-8000-0000000000aa_c3ludGhldGljLXNoYXJlLXRva2VuLW5ldmVyLXByaW50';
const driveId='00000000-0000-4000-8000-0000000000d1',grantId='00000000-0000-4000-8000-0000000000e1',accountId='00000000-0000-4000-8000-0000000000f1';
const drives='/api/v1/code/drives',notes=`${drives}/notes`,share='/api/v1/code/share';
const refusal=(status,code,message,details)=>[status,{error:{code,message,...(details?{details}:{})}}];

// An isolated home (signed in as a person unless told not to) and a loopback
// control API whose routes each test writes. A route answers [status, reply,
// headers]: a Buffer is a file's bytes, anything else JSON. early names the
// requests answered before their body is read, as the API refuses a write.
async function fixture(t,routes={},{signedIn=true,early}={}){
 const home=await mkdtemp(join(tmpdir(),'cvm-drive-'));
 const seen=[];
 const reply=(res,[status,body,headers={}])=>{
  if(Buffer.isBuffer(body)){res.writeHead(status,{'content-type':'application/octet-stream','content-length':body.length,...headers});res.end(body);return;}
  res.writeHead(status,{'content-type':'application/json',...headers});res.end(typeof body==='string'?body:JSON.stringify(body));
 };
 const note=(req,raw)=>{
  const url=new URL(req.url,'http://x');
  let body;try{body=raw.length&&/json/.test(req.headers['content-type']??'')?JSON.parse(raw.toString('utf8')):undefined;}catch{}
  const request={method:req.method,path:req.url,route:url.pathname,query:Object.fromEntries(url.searchParams),headers:req.headers,raw,body};
  seen.push(request);return request;
 };
 const handle=(req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',async()=>{
   const request=note(req,Buffer.concat(chunks));
   const route=routes[`${req.method} ${request.route}`];
   reply(res,route?await route(request,seen):refusal(404,'cave_not_found',`No route ${req.method} ${request.route}.`));
  });
 };
 const server=createServer(handle);
 // Node answers 100 Continue itself unless asked: here a write may be refused first.
 server.on('checkContinue',(req,res)=>{
  const refused=early?.(req);
  if(!refused){res.writeContinue();handle(req,res);return;}
  note(req,Buffer.alloc(0));reply(res,refused);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
 if(signedIn){
  await mkdir(join(home,'.caveman'));
  await writeFile(join(home,'.caveman','cloud.json'),JSON.stringify({baseURL:url,tokenStore:'file'}));
  await writeFile(join(home,'.caveman','credentials'),JSON.stringify({access_token:secret}),{mode:0o600});
 }
 // showsToken: the one command that may print a share token (share).
 const start=(argv,label,env={},{input,showsToken=false}={})=>limitSpawn(()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,argv,{cwd:home,env:{HOME:home,USERPROFILE:home,CAVEMAN_HOME:join(home,'.caveman'),PATH:'/usr/bin:/bin',CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1',...env},stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
  const out=[];let stderr='';child.stdout.on('data',d=>out.push(d));child.stderr.on('data',d=>stderr+=d);
  if(input!==undefined)child.stdin.end(input);
  child.on('error',reject);child.on('close',code=>{
   const bytes=Buffer.concat(out),stdout=bytes.toString('utf8');
   assert.ok(!(stdout+stderr).includes(secret)&&!(stdout+stderr).includes(key),'must not print the credential');
   if(!showsToken)assert.ok(!(stdout+stderr).includes(token)&&!/cdrv_[A-Za-z0-9_-]{16,}/.test(stdout+stderr),`must not print a share token: ${label}`);
   resolve({code,stdout,stderr,bytes,json:()=>JSON.parse(stdout)});
  });
 }));
 const run=(args,env,options)=>start([bin,...args],args.join(' '),env,options);
 // onTerminal runs `cvm drive ARGS` signed in as run is, with stdout a terminal.
 const onTerminal=(args,env,options)=>start(['--input-type=module','-e',asTerminal,new URL('../bin/drive.mjs',import.meta.url).href,...args],args.join(' '),{CVM_TEST_URL:url,CVM_TEST_TOKEN:secret,...env},options);
 const write=async(path,content,mode)=>{await mkdir(dirname(join(home,path)),{recursive:true});await writeFile(join(home,path),content);if(mode)await chmod(join(home,path),mode);};
 return {home,seen,url,run,onTerminal,write,last:()=>seen.at(-1)};
}
const file=(path,over={})=>({id:'f'+path,path,kind:'file',size_bytes:12,version:3,media_type:'text/markdown',is_text:true,line_count:2,tokens_est:4,modified_at:'2026-11-18T10:00:00Z',writer_type:'user',writer_id:'u1',origin:'person',...over});
const folder=(path,over={})=>({id:'d'+path,path,kind:'folder',size_bytes:0,is_text:false,modified_at:'2026-11-18T09:00:00Z',writer_type:'service_account',writer_id:accountId,origin:'agent',...over});
const drive=(over={})=>({id:driveId,organization_id:'org',project_id:null,name:'notes',description:'Team notes',retention_days:30,totals:{files:2,folders:1,size_bytes:2048,head_seq:7,head_hash:'h'},created_by_user_id:'u1',created_by_service_account_id:null,created_at:'2026-11-18T09:00:00Z',updated_at:'2026-11-18T10:00:00Z',archived_at:null,...over});
const grant=(over={})=>({id:grantId,drive_id:driveId,folder_id:'n1',path:'/docs',read:true,write:false,principal_type:'token',service_account_id:null,label:'',expires_at:'2026-11-18T11:00:00Z',revoked_at:null,last_used_at:null,issued_by_user_id:'u1',created_at:'2026-11-18T10:00:00Z',live:true,...over});
const written=(req,over={})=>[200,{file:file(req.query.path,{size_bytes:req.raw.length,version:9,...over}),unchanged:false}];
const calls=f=>f.seen.map(r=>`${r.method} ${r.path}`);

describe('drive', {concurrency: TEST_CONCURRENCY}, () => {

test('cvm drive usage, set and unarchive call their routes and say what they did',async t=>{
 let usage={stored_bytes:3_200_000_000,ceiling_bytes:1000_000_000_000,billing:true,included_bytes:10_000_000_000,month:{start:'2026-11-01',gb_months:'0.410',billed_usd:0,unpaid_usd:0}};
 const f=await fixture(t,{
  [`GET ${drives}/usage`]:()=>[200,usage],
  [`PATCH ${notes}`]:req=>[200,drive({retention_days:req.body.retention_days??30,description:req.body.description??'Team notes'})],
  [`POST ${drives}/${driveId}/unarchive`]:()=>[200,drive()],
 });
 let result=await f.run(['drive','usage','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().path],['GET',`${drives}/usage`]);
 assert.equal(result.stdout,'stored   3.2 GB of 10 GB included\nmonth    0.410 GB-months, $0.00 charged\nceiling  1000 GB on this Caveman Cloud\nbilling  storage past the plan is paid from credits\n');
 usage={...usage,billing:false,included_bytes:null,month:{...usage.month,unpaid_usd:0}};
 result=await f.run(['drive','usage','--format','table']);
 assert.match(result.stdout,/^stored   3\.2 GB of 1000 GB\n.*billing  off: nothing is charged\n$/s);
 assert.equal((await f.run(['drive','usage'])).json().ceiling_bytes,1000_000_000_000);

 result=await f.run(['drive','set','notes','--keep','90d','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().path,f.last().body],['PATCH',notes,{retention_days:90}]);
 assert.equal(result.stdout,`drive  notes  ${driveId}\nkeeps  old versions 90 days\n`);
 await f.run(['drive','set','notes','--keep','7','--description','Kept a week']);
 assert.deepEqual(f.last().body,{retention_days:7,description:'Kept a week'});
 const before=f.seen.length;
 await mapPool([['set','notes'],['set','notes','--keep','0d'],['set','notes','--keep','3651d'],['set','notes','--keep','2w'],['set','notes/docs','--keep','9d'],['usage','notes'],['unarchive']],async bad=>{
  const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);assert.equal(refused.json().error.code,'cave_usage');
 });
 assert.equal(f.seen.length,before,'nothing is sent for a refused command');

 result=await f.run(['drive','unarchive',driveId,'--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().path,f.last().body],['POST',`${drives}/${driveId}/unarchive`,{}]);
 assert.equal(result.stdout,`unarchived  notes  ${driveId}\n`);
 await mapPool([['usage'],['set','x','--keep','9d'],['unarchive',driveId]],async verb=>{
  const refused=await f.run(['drive',...verb],{CAVEMAN_DRIVE_TOKEN:token});
  assert.equal(refused.code,2);assert.equal(refused.json().error.code,'cave_share_token_scope');
 });
});

test('cvm drive lists drives; create, archive and verify each call their route',async t=>{
 let verified={drive_id:driveId,head_seq:7,commits:7,ok:true,first_bad_seq:null};
 const f=await fixture(t,{
  [`GET ${drives}`]:()=>[200,{drives:[drive(),drive({id:'x',name:'scratch',description:'',totals:null})]}],
  [`POST ${drives}`]:req=>[201,{drive:drive({name:req.body.name}),created:true}],
  [`POST ${notes}/archive`]:()=>[200,drive({archived_at:'2026-11-18T11:00:00Z',deletes_at:'2026-12-18T11:00:00Z'})],
  [`GET ${notes}/verify`]:()=>[200,verified],
 });
 let result=await f.run(['drive','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.equal(result.stdout,'NAME     FILES  SIZE    CHANGED               DESCRIPTION\nnotes    2      2.0 KB  2026-11-18T10:00:00Z  Team notes\nscratch  -      -       2026-11-18T10:00:00Z\n');
 assert.deepEqual([f.last().method,f.last().path,f.last().headers.authorization],['GET',drives,`Bearer ${secret}`]);
 assert.deepEqual((await f.run(['drive','list'])).json().drives.map(d=>d.name),['notes','scratch']);

 result=await f.run(['drive','create','notes','--description','Team notes']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().path,f.last().body],['POST',drives,{name:'notes',description:'Team notes'}]);
 assert.equal(result.json().created,true);
 result=await f.run(['drive','create','notes','--format','table']);
 assert.deepEqual(f.last().body,{name:'notes'});
 assert.match(result.stdout,new RegExp(`^created  notes  ${driveId}\nput      cvm drive put \\./FOLDER notes\n$`));

 const before=f.seen.length;
 result=await f.run(['drive','archive','notes']);
 assert.equal(result.code,2);assert.equal(result.json().error.code,'cave_confirmation_required');
 await mapPool([['create','Bad_Name'],['create'],['archive','notes/docs','--yes'],['verify'],['list','extra'],['create','x','--yes'],['ls','notes','--format','xml']],async bad=>{
  const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);assert.equal(refused.json().error.code,'cave_usage');
 });
 assert.equal(f.seen.length,before,'nothing is sent for a refused command');
 result=await f.run(['drive','archive','notes','--yes','--format','table']);
 assert.deepEqual([f.last().method,f.last().path,f.last().body],['POST',`${notes}/archive`,{}]);
 assert.equal(result.stdout,`archived  notes  2026-11-18T11:00:00Z\ndeletes   2026-12-18T11:00:00Z, unless brought back first: cvm drive unarchive ${driveId}\n`);

 result=await f.run(['drive','verify','notes','--format','table']);
 assert.equal(result.code,0);assert.equal(result.stdout,'ok  7 commits, head #7: every commit matches its hash\n');
 assert.deepEqual([f.last().method,f.last().path],['GET',`${notes}/verify`]);
 verified={...verified,ok:false,first_bad_seq:4,reason:'the commit does not match its rows'};
 result=await f.run(['drive','verify','notes','--format','table']);
 assert.equal(result.code,1);assert.equal(result.stdout,'broken  commit #4: the commit does not match its rows\n');
 result=await f.run(['drive','verify','notes']);
 assert.equal(result.code,1);assert.equal(result.json().first_bad_seq,4);
});

test('ls follows next_cursor to the end and prints name, size, tokens, writer, version and when it changed',async t=>{
 const pages={'':{files:[folder('/docs/sub'),file('/docs/a.md',{size_bytes:1536,tokens_est:1234})],next_cursor:'Yw'},Yw:{files:[file('/docs/z.bin',{size_bytes:5*1024*1024,is_text:false,tokens_est:undefined,origin:'agent',version:11})],next_cursor:null}};
 const f=await fixture(t,{[`GET ${notes}/files`]:req=>[200,pages[req.query.cursor??'']]});
 let result=await f.run(['drive','ls','notes/docs','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.map(r=>r.query),[{path:'/docs',limit:'1000'},{path:'/docs',limit:'1000',cursor:'Yw'}]);
 assert.equal(result.stdout,['NAME   SIZE    TOKENS  WRITER  VERSION  CHANGED','sub/   -       -       agent   -        2026-11-18T09:00:00Z','a.md   1.5 KB  1,234   person  v3       2026-11-18T10:00:00Z','z.bin  5.0 MB  -       agent   v11      2026-11-18T10:00:00Z',''].join('\n'));
 result=await f.run(['drive','ls','notes/docs/','--recursive']);
 assert.deepEqual(f.seen.at(-2).query,{path:'/docs',recursive:'true',limit:'1000'});
 assert.deepEqual(result.json(),{files:[...pages[''].files,...pages.Yw.files].map(x=>JSON.parse(JSON.stringify(x))),next_cursor:null});
 // The root of a drive, by its id.
 await f.run(['drive','ls',driveId]);
 assert.equal(f.last().route,`${drives}/${driveId}/files`);assert.equal(f.last().query.path,'/');
 // A cursor that comes back again ends the listing as an answer cvm cannot use.
 pages.Yw.next_cursor='Yw';
 result=await f.run(['drive','ls','notes/docs']);
 assert.equal(result.code,6);assert.equal(result.json().error.code,'cave_invalid_response');
 await mapPool([['ls'],['ls','Bad Drive/x'],['ls','../x'],['ls','notes','--yes']],async bad=>{const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,bad.join(' '));});
});

test('ls of an empty folder says so; a file\'s own listing is its name',async t=>{
 let files=[];
 const f=await fixture(t,{[`GET ${notes}/files`]:()=>[200,{files,next_cursor:null}]});
 assert.equal((await f.run(['drive','ls','notes/empty','--format','table'])).stdout,'notes/empty is empty.\n');
 files=[file('/docs/a.md')];
 assert.match((await f.run(['drive','ls','notes/docs/a.md','--format','table'])).stdout,/\na\.md  12 B  4 {7}person  v3 /);
});

test('cat follows the read route\'s paging to the end; --lines and --version bound it',async t=>{
 const text=['one\n','two\n','three\n','four\n'];
 const f=await fixture(t,{[`POST ${notes}/read`]:req=>{
  const offset=req.body.offset,limit=Math.min(req.body.limit??2,2),lines=text.slice(offset-1,offset-1+limit),next=offset+lines.length;
  return [200,{path:'/docs/a.md',version:req.body.version??3,size_bytes:19,line_count:4,offset,lines:lines.length,content:lines.join(''),truncated:next<=text.length&&req.body.limit===undefined,next_offset:next<=text.length?next:null,origin:'person'}];
 }});
 let result=await f.run(['drive','cat','notes/docs/a.md','--format','table']);
 assert.equal(result.code,0,result.stdout+result.stderr);
 assert.equal(result.stdout,text.join(''));assert.equal(result.stderr,'');
 assert.deepEqual(f.seen.map(r=>r.body),[{path:'/docs/a.md',offset:1},{path:'/docs/a.md',offset:3}]);
 result=await f.run(['drive','cat','notes/docs/a.md']);
 assert.deepEqual(result.json(),{path:'/docs/a.md',version:3,size_bytes:19,line_count:4,origin:'person',offset:1,lines:4,content:text.join(''),truncated:false,next_offset:null});
 f.seen.length=0;
 result=await f.run(['drive','cat','notes/docs/a.md','--lines','2:4','--version','2','--format','table']);
 assert.equal(result.stdout,'two\nthree\nfour\n');
 assert.deepEqual(f.seen.map(r=>r.body),[{path:'/docs/a.md',offset:2,limit:3,version:2},{path:'/docs/a.md',offset:4,limit:1,version:2}]);
 result=await f.run(['drive','cat','notes/docs/a.md','--lines','2:2']);
 assert.equal(result.json().content,'two\n');assert.equal(result.json().next_offset,3);
 await f.run(['drive','cat','notes/docs/a.md','--lines','3:']);
 assert.deepEqual(f.last().body,{path:'/docs/a.md',offset:3});
 const before=f.seen.length;
 await mapPool([['cat','notes'],['cat','notes/a','--lines','0:2'],['cat','notes/a','--lines','5:2'],['cat','notes/a','--lines','x'],['cat','notes/a','--version','0'],['cat','notes/a','--recursive']],async bad=>{
  const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);
 });
 assert.equal(f.seen.length,before);
});

test('cat: a file that is not text says to use get, on stderr when stdout is the text; a line cut short is named and exits 6',async t=>{
 let reply=refusal(409,'cave_code_drive_not_text','/logo.png is not UTF-8 text: open its content as bytes instead.');
 const f=await fixture(t,{[`POST ${notes}/read`]:()=>reply});
 let result=await f.run(['drive','cat','notes/logo.png']);
 assert.equal(result.code,4);assert.deepEqual(result.json().error,{code:'cave_code_drive_not_text',message:'notes/logo.png is not text: get its bytes with cvm drive get notes/logo.png.'});
 result=await f.run(['drive','cat','notes/logo.png','--format','table']);
 assert.equal(result.stdout,'');assert.equal(result.stderr,'failed   cave_code_drive_not_text: notes/logo.png is not text: get its bytes with cvm drive get notes/logo.png.\n');
 const long='x'.repeat(40);
 reply=[200,{path:'/min.js',version:5,size_bytes:90,line_count:2,offset:1,lines:1,content:long,truncated:true,next_offset:2,origin:'agent'}];
 const g=await fixture(t,{[`POST ${notes}/read`]:req=>req.body.offset===1?reply:[200,{...reply[1],offset:2,lines:1,content:'tail\n',truncated:false,next_offset:null}]});
 result=await g.run(['drive','cat','notes/min.js','--format','table']);
 assert.equal(result.code,6);assert.equal(result.stdout,long+'\ntail\n');
 assert.equal(result.stderr,'Line 1 is longer than one read carries and was cut short: get the whole file with cvm drive get notes/min.js.\n');
 result=await g.run(['drive','cat','notes/min.js']);
 assert.equal(result.code,6);assert.deepEqual([result.json().truncated,result.json().cut_lines],[true,[1]]);
});

test('get streams a file to disk, to stdout with -, and never over an existing local file unless --overwrite',async t=>{
 const bytes=Buffer.from([0,1,2,255,254,10,13,0x1b,0x5b]);
 const f=await fixture(t,{
  [`GET ${notes}/content`]:req=>req.query.path==='/docs'?refusal(409,'cave_code_drive_is_folder','/docs is a folder: name a file inside it.'):[200,bytes,{etag:'"7"'}],
 });
 let result=await f.run(['drive','get','notes/docs/logo.png','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().route,f.last().query,f.last().headers.authorization],['GET',`${notes}/content`,{path:'/docs/logo.png'},`Bearer ${secret}`]);
 assert.deepEqual(await readFile(join(f.home,'logo.png')),bytes);
 assert.equal(result.stdout,'saved  logo.png  9 B  v7\n');
 assert.deepEqual((await readdir(f.home)).filter(name=>name.includes('.part')),[],'no partial file is left');
 // It is there now: refused, and nothing asked of the server.
 const before=f.seen.length;
 result=await f.run(['drive','get','notes/docs/logo.png']);
 assert.equal(result.code,4);assert.equal(result.json().error.code,'cave_local_exists');assert.equal(f.seen.length,before);
 result=await f.run(['drive','get','notes/docs/logo.png','--overwrite']);
 assert.equal(result.code,0);assert.deepEqual(result.json(),{schema_version:1,ok:true,status:'downloaded',files:[{path:'/docs/logo.png',local:'logo.png',size_bytes:9,version:7}],bytes:9});
 // A named local file, a local folder to put it in, and an earlier version.
 await mkdir(join(f.home,'out'));
 result=await f.run(['drive','get','notes/docs/logo.png','out','--version','4']);
 assert.equal(result.json().files[0].local,join('out','logo.png'));assert.deepEqual(f.last().query,{path:'/docs/logo.png',version:'4'});
 result=await f.run(['drive','get','notes/docs/logo.png','copy.bin']);
 assert.deepEqual(await readFile(join(f.home,'copy.bin')),bytes);
 // A symbolic link is never written through.
 await symlink(join(f.home,'copy.bin'),join(f.home,'link.bin'));
 result=await f.run(['drive','get','notes/docs/logo.png','link.bin','--overwrite']);
 assert.equal(result.code,1);assert.equal(result.json().error.code,'cave_local_unsafe');
 // stdout is the bytes and nothing else, whatever the format.
 result=await f.run(['drive','get','notes/docs/logo.png','-']);
 assert.equal(result.code,0);assert.deepEqual(result.bytes,bytes);assert.equal(result.stderr,'');
 // A folder without --recursive says how; with stdout the refusal goes to stderr.
 result=await f.run(['drive','get','notes/docs']);
 assert.equal(result.code,4);assert.deepEqual(result.json().error,{code:'cave_code_drive_is_folder',message:'notes/docs is a folder: add --recursive to get everything in it.'});
 assert.ok(!existsSync(join(f.home,'docs')),'a refused download leaves no file');
 result=await f.run(['drive','get','notes/docs','-']);
 assert.equal(result.code,4);assert.equal(result.stdout,'');assert.match(result.stderr,/cave_code_drive_is_folder/);
 await mapPool([['get','notes'],['get','notes/docs','-','--recursive'],['get','notes/a','b','c'],['get','notes/docs','--recursive','--version','2']],async bad=>{const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,bad.join(' '));});
});

test('get --recursive lists the folder to the end and writes it under LOCAL',async t=>{
 const pages={'':{files:[folder('/docs/empty'),file('/docs/a.md'),folder('/docs/sub')],next_cursor:'bg'},bg:{files:[file('/docs/sub/run.sh',{executable:true}),file('/docs/sub/deep/b.txt')],next_cursor:null}};
 const f=await fixture(t,{
  [`GET ${notes}/files`]:req=>[200,pages[req.query.cursor??'']],
  [`GET ${notes}/content`]:req=>[200,Buffer.from(`content of ${req.query.path}`),{etag:'"3"'}],
 });
 let result=await f.run(['drive','get','notes/docs','--recursive','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(calls(f).slice(0,2),[`GET ${notes}/files?path=%2Fdocs&recursive=true&limit=1000`,`GET ${notes}/files?path=%2Fdocs&recursive=true&limit=1000&cursor=bg`]);
 assert.deepEqual(f.seen.slice(2).map(r=>r.query.path),['/docs/a.md','/docs/sub/run.sh','/docs/sub/deep/b.txt']);
 const root=join(f.home,'docs');
 assert.equal(await readFile(join(root,'a.md'),'utf8'),'content of /docs/a.md');
 assert.equal(await readFile(join(root,'sub','deep','b.txt'),'utf8'),'content of /docs/sub/deep/b.txt');
 assert.ok((await stat(join(root,'empty'))).isDirectory(),'an empty folder is made too');
 if(process.platform!=='win32'){assert.ok((await stat(join(root,'sub','run.sh'))).mode&0o100,'an executable file stays one');assert.ok(!((await stat(join(root,'a.md'))).mode&0o100));}
 assert.equal(result.stdout,[`saved  ${join('docs','a.md')}  21 B  v3`,`saved  ${join('docs','sub','run.sh')}  27 B  v3`,`saved  ${join('docs','sub','deep','b.txt')}  31 B  v3`,'3 files, 79 B',''].join('\n'));
 // Again: every file is there, so nothing is written or downloaded.
 const before=f.seen.filter(r=>r.route.endsWith('/content')).length;
 result=await f.run(['drive','get','notes/docs','--recursive']);
 assert.equal(result.code,4);assert.equal(result.json().error.code,'cave_local_exists');assert.match(result.json().error.message,/^3 files already exist here .*pass --overwrite to replace them\. Nothing was written\.$/);
 assert.equal(f.seen.filter(r=>r.route.endsWith('/content')).length,before);
 result=await f.run(['drive','get','notes/docs','mirror','--recursive']);
 assert.equal(result.code,0);assert.equal(result.json().files.length,3);assert.equal(await readFile(join(f.home,'mirror','a.md'),'utf8'),'content of /docs/a.md');
 result=await f.run(['drive','get','notes/docs','--recursive','--overwrite']);
 assert.equal(result.code,0,result.stdout);assert.equal(result.json().bytes,79);assert.deepEqual(result.json().files.map(x=>x.local),[join('docs','a.md'),join('docs','sub','run.sh'),join('docs','sub','deep','b.txt')]);
});

test('get --recursive refuses a listing that names a path outside LOCAL, and writes nothing',async t=>{
 const badPaths=['/docs/../../escape.txt','/docs/..','/docs/a/../../../escape.txt','/docs/sub\\..\\..\\escape.txt','/docs/C:evil','/docs/.','/docs/nul','/docs/a\u0000b','/docs','/'];
 const cases=[
  ...badPaths.map(path=>[JSON.stringify(path),[file('/docs/fine.md'),file(path)],true]),
  ['case-collision',[file('/docs/same.md'),file('/docs/SAME.md')],false],
  ['symlink-kind',[{...file('/docs/x'),kind:'symlink'}],false],
 ];
 let files=[];
 const routes={
  [`GET ${notes}/files`]:()=>[200,{files,next_cursor:null}],
  [`GET ${notes}/content`]:()=>[200,Buffer.from('hostile')],
  ...Object.fromEntries(cases.map(([,listing],i)=>[`GET ${drives}/notes-${i}/files`,()=>[200,{files:listing,next_cursor:null}]])),
 };
 const f=await fixture(t,routes);
 await mapPool(cases,async([label,,checkMsg],i)=>{
  const result=await f.run(['drive','get',`notes-${i}/docs`,'local','--recursive']);
  if(checkMsg){assert.equal(result.code,1,`${label}: ${result.stdout}`);assert.match(result.json().error.message,/Nothing was written\.$/);}
  assert.equal(result.json().error.code,'cave_unsafe_listing',label);
 });
 assert.ok(!existsSync(join(f.home,'local')),'the local folder is not even made');
 assert.ok(!existsSync(join(f.home,'escape.txt'))&&!existsSync(join(dirname(f.home),'escape.txt')));
 assert.deepEqual(f.seen.filter(r=>r.route.endsWith('/content')),[],'no file is downloaded');
 // A symbolic link already inside LOCAL is not written through either.
 await mkdir(join(f.home,'outside'));await mkdir(join(f.home,'local'));
 await symlink(join(f.home,'outside'),join(f.home,'local','sub'));
 files=[file('/docs/sub/a.md')];
 let result=await f.run(['drive','get','notes/docs','local','--recursive','--overwrite']);
 assert.equal(result.code,1);assert.equal(result.json().error.code,'cave_local_unsafe');
 assert.deepEqual(await readdir(join(f.home,'outside')),[]);
 await writeFile(join(f.home,'outside','b.md'),'kept');
 await symlink(join(f.home,'outside','b.md'),join(f.home,'local','b.md'));
 files=[file('/docs/b.md')];
 result=await f.run(['drive','get','notes/docs','local','--recursive','--overwrite']);
 assert.equal(result.code,1);assert.equal(result.json().error.code,'cave_local_unsafe');
 assert.equal(await readFile(join(f.home,'outside','b.md'),'utf8'),'kept');
 assert.deepEqual(f.seen.filter(r=>r.route.endsWith('/content')),[]);
});

// A folder to put: a nested folder, a file that will already be in the drive,
// an executable, a name with no known type, a symbolic link and an empty folder.
async function tree(f){
 await f.write('up/a.md','# a\n');
 await f.write('up/exists.md','new text\n');
 await f.write('up/notes','plain\n');
 await f.write('up/sub/deep/b.json','{"b":1}\n');
 await f.write('up/sub/run.sh','#!/bin/sh\n',0o755);
 await mkdir(join(f.home,'up','void'));
 await symlink(join(f.home,'up','a.md'),join(f.home,'up','link.md'));
}
const exists=path=>refusal(409,'cave_code_drive_exists',`${path} already exists: read it and write with its version, or pick another path.`);

test('put of a folder as a person: regular files depth first in name order, links skipped out loud, a file already there refused unless --overwrite',async t=>{
 const f=await fixture(t,{[`PUT ${notes}/content`]:req=>req.query.path==='/docs/exists.md'&&req.query.if_absent?exists('/docs/exists.md'):written(req)});
 await tree(f);
 let result=await f.run(['drive','put','up','notes/docs','--format','table']);
 assert.equal(result.code,4,result.stdout);
 assert.deepEqual(f.seen.map(r=>[r.method,r.route,r.query.path]),[['PUT',`${notes}/content`,'/docs/a.md'],['PUT',`${notes}/content`,'/docs/exists.md'],['PUT',`${notes}/content`,'/docs/notes'],['PUT',`${notes}/content`,'/docs/sub/deep/b.json'],['PUT',`${notes}/content`,'/docs/sub/run.sh']]);
 for(const r of f.seen){assert.equal(r.headers.authorization,`Bearer ${secret}`);assert.equal(r.query.if_absent,'true');assert.equal(r.query.overwrite,undefined);assert.equal(r.headers['content-length'],String(r.raw.length));}
 assert.deepEqual(f.seen.map(r=>r.headers['content-type']),['text/markdown','text/markdown',undefined,'application/json','text/x-shellscript']);
 assert.equal(f.seen[0].raw.toString(),'# a\n');assert.equal(f.seen[3].raw.toString(),'{"b":1}\n');
 if(process.platform!=='win32')assert.deepEqual(f.seen.map(r=>r.query.executable),[undefined,undefined,undefined,undefined,'true']);
 assert.equal(result.stdout,['sent       /docs/a.md  4 B  v9','refused    /docs/exists.md  cave_code_drive_exists: /docs/exists.md already exists: read it and write with its version, or pick another path.','sent       /docs/notes  6 B  v9','sent       /docs/sub/deep/b.json  8 B  v9','sent       /docs/sub/run.sh  10 B  v9',
  `skipped    ${join('up','link.md')}  a symbolic link, which is not followed`,`skipped    ${join('up','void')}  an empty folder: a drive keeps a folder for the files in it`,'4 files sent (28 B), 1 refused, 2 skipped','1 file already exists in the drive: repeat with --overwrite to replace it.',''].join('\n'));
 f.seen.length=0;
 result=await f.run(['drive','put','up','notes/docs']);
 assert.equal(result.code,4);
 const out=result.json();
 assert.deepEqual([out.ok,out.status,out.drive,out.sent.length],[false,'incomplete','notes',4]);
 assert.deepEqual(out.sent[0],{path:'/docs/a.md',local:join('up','a.md'),size_bytes:4,version:9,media_type:'text/markdown',unchanged:false});
 assert.deepEqual(out.refused,[{path:'/docs/exists.md',local:join('up','exists.md'),code:'cave_code_drive_exists',message:'/docs/exists.md already exists: read it and write with its version, or pick another path.'}]);
 assert.deepEqual(out.skipped.map(s=>s.local),[join('up','link.md'),join('up','void')]);
 // --overwrite, signed in as a person: the API's own switch, and no listing first.
 f.seen.length=0;
 result=await f.run(['drive','put','up','notes/docs','--overwrite']);
 assert.equal(result.code,0,result.stdout);
 assert.equal(f.seen.length,5);
 for(const r of f.seen){assert.equal(r.method,'PUT');assert.equal(r.query.overwrite,'true');assert.equal(r.query.if_absent,undefined);assert.equal(r.query.if_version,undefined);}
 assert.deepEqual([result.json().ok,result.json().status,result.json().refused],[true,'uploaded',[]]);
});

test('put --overwrite with a key lists the target first and names each file\'s version; a new file must be absent',async t=>{
 const f=await fixture(t,{
  [`GET ${notes}/files`]:req=>req.query.path==='/docs'?[200,{files:[folder('/docs/sub'),file('/docs/exists.md',{version:41}),file('/docs/sub/run.sh',{version:42})],next_cursor:null}]:[200,{files:[file('/docs/Notes',{version:43})],next_cursor:null}],
  // The drive spells one name differently, so the listing did not match it.
  [`PUT ${notes}/content`]:req=>req.query.path==='/docs/notes'&&req.query.if_absent?exists('/docs/Notes'):written(req),
 });
 await tree(f);
 const result=await f.run(['drive','put','up','notes/docs','--overwrite'],{CAVE_TOKEN:key});
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(calls(f),[
  `GET ${notes}/files?path=%2Fdocs&recursive=true&limit=1000`,
  `PUT ${notes}/content?path=%2Fdocs%2Fa.md&if_absent=true`,
  `PUT ${notes}/content?path=%2Fdocs%2Fexists.md&if_version=41`,
  `PUT ${notes}/content?path=%2Fdocs%2Fnotes&if_absent=true`,
  `GET ${notes}/files?path=%2Fdocs%2Fnotes&limit=1000`,
  `PUT ${notes}/content?path=%2Fdocs%2Fnotes&if_version=43`,
  `PUT ${notes}/content?path=%2Fdocs%2Fsub%2Fdeep%2Fb.json&if_absent=true`,
  `PUT ${notes}/content?path=%2Fdocs%2Fsub%2Frun.sh&if_version=42${process.platform==='win32'?'':'&executable=true'}`,
 ]);
 for(const r of f.seen){assert.equal(r.headers.authorization,`Bearer ${key}`);assert.equal(r.query.overwrite,undefined);}
 assert.equal(result.json().sent.length,5);
 // Without --overwrite a key sends what a person does: no listing, and every file must be new.
 f.seen.length=0;
 const plain=await f.run(['drive','put','up','notes/docs'],{CAVE_TOKEN:key});
 assert.equal(plain.code,4,plain.stdout);
 assert.equal(f.seen.length,5);
 for(const r of f.seen){assert.equal(r.method,'PUT');assert.equal(r.query.if_absent,'true');assert.equal(r.query.if_version,undefined);}
 assert.deepEqual(plain.json().refused.map(r=>r.path),['/docs/notes']);
 f.seen.length=0;
 await f.run(['drive','put',join('up','a.md'),'notes/docs/'],{CAVE_TOKEN:key});
 assert.deepEqual(calls(f),[`PUT ${notes}/content?path=%2Fdocs%2Fa.md&if_absent=true`]);
});

test('put: a credential the API says is no person\'s goes on as a key does',async t=>{
 const f=await fixture(t,{
  [`GET ${notes}/files`]:()=>[200,{files:[file('/a.md',{version:5})],next_cursor:null}],
  [`PUT ${notes}/content`]:req=>req.query.overwrite?refusal(400,'cave_code_drive_version_required','/a.md exists: name the version you are replacing, or write to a new path.'):written(req),
 });
 await f.write('a.md','# a\n');
 const result=await f.run(['drive','put','a.md','notes','--overwrite']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(calls(f),[`PUT ${notes}/content?path=%2Fa.md&overwrite=true`,`GET ${notes}/files?path=%2Fa.md&limit=1000`,`PUT ${notes}/content?path=%2Fa.md&if_version=5`]);
});

test('put of one file: into a folder with a trailing slash, from stdin with -, and a folder in the way says how',async t=>{
 const f=await fixture(t,{[`PUT ${notes}/content`]:req=>req.query.path==='/docs'?refusal(409,'cave_code_drive_is_folder','/docs is a folder: name a file inside it.'):written(req)});
 await f.write('report.csv','a,b\n1,2\n');
 let result=await f.run(['drive','put','report.csv','notes/docs/','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().query,f.last().headers['content-type'],f.last().raw.toString()],[{path:'/docs/report.csv',if_absent:'true'},'text/csv','a,b\n1,2\n']);
 assert.equal(result.stdout,'sent       /docs/report.csv  8 B  v9\n1 file sent (8 B)\n');
 await f.run(['drive','put','report.csv','notes']);
 assert.equal(f.last().query.path,'/report.csv');
 await f.run(['drive','put','report.csv','notes/data/2026.csv']);
 assert.equal(f.last().query.path,'/data/2026.csv');
 result=await f.run(['drive','put','report.csv','notes/docs']);
 assert.equal(result.code,4);assert.deepEqual(result.json().refused.map(r=>r.message),['notes/docs is a folder: end the address with / to put report.csv inside it.']);
 // stdin: no length is known, so the body waits for the API's go-ahead and is sent as it comes.
 result=await f.run(['drive','put','-','notes/in/piped.txt'],{},{input:'from a pipe\n'});
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().query,f.last().headers['content-type'],f.last().headers['content-length'],f.last().headers.expect,f.last().raw.toString()],[{path:'/in/piped.txt',if_absent:'true'},'text/plain',undefined,'100-continue','from a pipe\n']);
 const before=f.seen.length;
 await symlink(join(f.home,'report.csv'),join(f.home,'alias.csv'));
 await mapPool([['put','-','notes'],['put','-','notes/docs/'],['put','missing.txt','notes'],['put','alias.csv','notes'],['put','report.csv'],['put','report.csv','notes','--recursive']],async bad=>{
  const refused=await f.run(['drive',...bad],{},{input:''});assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);
 });
 assert.equal(f.seen.length,before);
});

test('put from stdin with a key: refused before a byte is read, stdin is still whole for the try that names the version',async t=>{
 let lookups=0;
 const f=await fixture(t,{
  [`GET ${notes}/files`]:()=>lookups++?[200,{files:[file('/In/Piped.txt',{version:7})],next_cursor:null}]:refusal(404,'cave_not_found','No such drive, folder or file: check the drive and the path, or list the folder above it.'),
  [`PUT ${notes}/content`]:req=>written(req),
 },{early:req=>req.url.includes('if_absent')?exists('/In/Piped.txt'):undefined});
 const result=await f.run(['drive','put','-','notes/in/piped.txt','--overwrite'],{CAVE_TOKEN:key},{input:'from a pipe\n'});
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(calls(f),[`GET ${notes}/files?path=%2Fin%2Fpiped.txt&limit=1000`,`PUT ${notes}/content?path=%2Fin%2Fpiped.txt&if_absent=true`,`GET ${notes}/files?path=%2Fin%2Fpiped.txt&limit=1000`,`PUT ${notes}/content?path=%2Fin%2Fpiped.txt&if_version=7`]);
 assert.deepEqual([f.seen[1].raw.length,f.last().raw.toString()],[0,'from a pipe\n']);
 assert.equal(result.json().sent.length,1);
});

test('put --dry-run prints what it would send, in both formats, and sends nothing',async t=>{
 const f=await fixture(t);
 await tree(f);
 let result=await f.run(['drive','put','up','notes/docs','--dry-run']);
 assert.equal(result.code,0,result.stdout);
 const out=result.json();
 assert.deepEqual([out.ok,out.status,out.drive],[true,'dry_run','notes']);
 assert.deepEqual(out.would_send.map(s=>[s.method,s.path,s.local,s.bytes,s.media_type]),[
  ['PUT',`${notes}/content?path=%2Fdocs%2Fa.md&if_absent=true`,join('up','a.md'),4,'text/markdown'],
  ['PUT',`${notes}/content?path=%2Fdocs%2Fexists.md&if_absent=true`,join('up','exists.md'),9,'text/markdown'],
  ['PUT',`${notes}/content?path=%2Fdocs%2Fnotes&if_absent=true`,join('up','notes'),6,null],
  ['PUT',`${notes}/content?path=%2Fdocs%2Fsub%2Fdeep%2Fb.json&if_absent=true`,join('up','sub','deep','b.json'),8,'application/json'],
  ['PUT',`${notes}/content?path=%2Fdocs%2Fsub%2Frun.sh&if_absent=true${process.platform==='win32'?'':'&executable=true'}`,join('up','sub','run.sh'),10,'text/x-shellscript'],
 ]);
 assert.deepEqual(out.skipped,[{local:join('up','link.md'),reason:'a symbolic link, which is not followed'},{local:join('up','void'),reason:'an empty folder: a drive keeps a folder for the files in it'}]);
 result=await f.run(['drive','put','up','notes/docs','--dry-run','--overwrite','--format','table']);
 assert.match(result.stdout,/^dry run {2}nothing sent\. A put would send 5 files \(37 B\):\n/);
 assert.match(result.stdout,new RegExp(`\n  ${join('up','notes').replaceAll('\\','\\\\')} +-> {2}/docs/notes +6 B +labelled by the API\n`));
 assert.match(result.stdout,/\nskipped {2}.*link\.md: a symbolic link, which is not followed\n/);
 assert.match(result.stdout,/\neach {5}replaces what is there: overwrite=true when signed in as a person, else if_version/);
 // With a share token the dry run names the share mount, and still sends nothing.
 result=await f.run(['drive','put',join('up','a.md'),'in/','--dry-run'],{CAVEMAN_DRIVE_TOKEN:token,CAVE_API_URL:f.url});
 assert.deepEqual(result.json().would_send.map(s=>s.path),[`${share}/content?path=%2Fin%2Fa.md&if_absent=true`]);
 assert.deepEqual(f.seen,[]);
});

test('put: a large file waits for the API before its bytes go, so a refusal costs no upload; one let through arrives whole',async t=>{
 const big=Buffer.alloc(600*1024,'drive bytes ');
 const f=await fixture(t,{[`PUT ${notes}/content`]:req=>written(req)},{early:req=>req.url.includes('refused')?exists('/refused.bin'):undefined});
 await f.write('big.bin',big);
 let result=await f.run(['drive','put','big.bin','notes/refused.bin']);
 assert.equal(result.code,4,result.stdout);
 assert.equal(f.last().headers.expect,'100-continue');assert.equal(f.last().headers['content-length'],String(big.length));assert.equal(f.last().raw.length,0,'no byte of a refused file is read');
 assert.deepEqual(result.json().refused.map(r=>r.code),['cave_code_drive_exists']);
 result=await f.run(['drive','put','big.bin','notes/kept.bin']);
 assert.equal(result.code,0,result.stdout);
 assert.ok(f.last().raw.equals(big),'the file arrives whole');
 assert.equal(result.json().sent[0].size_bytes,big.length);
 // A small file is sent at once, with no round trip first.
 await f.write('small.txt','hi\n');
 await f.run(['drive','put','small.txt','notes']);
 assert.equal(f.last().headers.expect,undefined);
});

test('put: what would only repeat ends the put, with what was sent and what was not',async t=>{
 const f=await fixture(t,{[`PUT ${notes}/content`]:req=>req.query.path==='/docs/a.md'?written(req):refusal(403,'cave_code_drive_read_only','You may read this but not change it: write where you were given write access, or ask a person to share it with write.')});
 await tree(f);
 let result=await f.run(['drive','put','up','notes/docs']);
 assert.equal(result.code,3,result.stdout);
 const out=result.json();
 assert.deepEqual([out.ok,out.status,out.sent.length,out.refused.length,out.error.code],[false,'failed',1,0,'cave_code_drive_read_only']);
 assert.deepEqual(out.not_sent,[join('up','exists.md'),join('up','notes'),join('up','sub','deep','b.json'),join('up','sub','run.sh')]);
 assert.equal(f.seen.length,2,'the put stops at the first such refusal');
 result=await f.run(['drive','put','up','notes/docs','--format','table']);
 assert.match(result.stdout,/\n1 file sent \(4 B\), 2 skipped, 4 not sent\nfailed {3}cave_code_drive_read_only: You may read this but not change it/);
});

test('grep sends the engine\'s input, prints path:line: text, and says when a search was cut short and why',async t=>{
 let found={matches:[{path:'/docs/a.md',line:12,text:'the budget is 40',cut:false,before:['line ten','\tline eleven'],after:['line thirteen'],version:3},{path:'/docs/b.md',line:2,text:'Budget\u001b[31m review',cut:true,version:4}],
  coverage:{files_searched:14,skipped_binary:2,skipped_large:1,skipped_by_glob:9,bytes_scanned:52000,long_lines:3,stopped:'matches'}};
 const f=await fixture(t,{[`POST ${notes}/grep`]:()=>[200,found]});
 let result=await f.run(['drive','grep','budget','notes/docs','--glob','*.md','--ignore-case','--fixed','--context','2','--limit','2','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().route,f.last().body],['POST',`${notes}/grep`,{pattern:'budget',path:'/docs',glob:'*.md',ignore_case:true,literal:true,before:2,after:2,max_matches:2}]);
 assert.equal(result.stdout,['/docs/a.md-10- line ten','/docs/a.md-11- \tline eleven','/docs/a.md:12: the budget is 40','/docs/a.md-13- line thirteen','--','/docs/b.md:2: Budget\\x1b[31m review',''].join('\n'));
 assert.equal(result.stderr,['Stopped at 2 matches, the limit: there may be more. Raise --limit (up to 1000), or narrow the path, --glob or the pattern.','1 file too large to search was skipped.','3 lines too long to search were skipped.','1 matching line is shown cut to its first bytes.','2 files that are not text were not searched.',''].join('\n'));
 // JSON is the API's answer, coverage and all.
 result=await f.run(['drive','grep','budget','notes']);
 assert.deepEqual(f.last().body,{pattern:'budget',path:'/'});
 assert.equal(result.json().coverage.stopped,'matches');assert.equal(result.json().matches.length,2);assert.equal(result.stderr,'');
 for(const [stopped,line] of [['bytes',/^Stopped at the most one search reads, with 14 files searched \(51 KB\): the files after the last match were not searched\./],['time',/^Stopped at the time one search gets, with 14 files searched \(51 KB\): the rest were not searched\./]]){
  found={...found,coverage:{...found.coverage,stopped}};
  assert.match((await f.run(['drive','grep','budget','notes','--format','table'])).stderr,line);
 }
 // A whole search with matches adds nothing; one with none says what it read.
 found={matches:[{path:'/a.md',line:1,text:'budget',cut:false,version:1}],coverage:{files_searched:3,skipped_binary:1,skipped_large:0,skipped_by_glob:0,bytes_scanned:900,long_lines:0,stopped:''}};
 result=await f.run(['drive','grep','budget','notes','--format','table']);
 assert.equal(result.stdout,'/a.md:1: budget\n');assert.equal(result.stderr,'');
 found={...found,matches:[]};
 result=await f.run(['drive','grep','budget','notes','--format','table']);
 assert.equal(result.stdout,'');assert.equal(result.stderr,'No matches: 3 files searched (900 B).\n1 file that is not text was not searched.\n');
 const before=f.seen.length;
 await mapPool([['grep','budget'],['grep','','notes'],['grep','x','notes','--limit','0'],['grep','x','notes','--limit','1001'],['grep','x','notes','--context','two']],async bad=>{const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,bad.join(' '));});
 assert.equal(f.seen.length,before);
});

test('grep: a busy answer is tried again after the wait it names',async t=>{
 let n=0;
 const f=await fixture(t,{[`POST ${notes}/grep`]:()=>n++?[200,{matches:[],coverage:{files_searched:1,stopped:''}}]:[429,{error:{code:'cave_code_drive_busy',message:'Too many searches of this organization\'s drives are running here: try again in a few seconds.'}},{'retry-after':'1'}]});
 const result=await f.run(['drive','grep','x','notes']);
 assert.equal(result.code,0,result.stdout);assert.equal(f.seen.length,2);
});

test('mv, rm, log, changes and restore each call their route with their body',async t=>{
 const versions=[{version:9,current:true,size_bytes:20,media_type:'text/markdown',is_text:true,executable:false,writer_type:'service_account',writer_id:accountId,origin:'agent',created_at:'2026-11-18T10:00:00Z'},{version:4,current:false,size_bytes:12,media_type:'text/markdown',is_text:true,executable:false,writer_type:'user',writer_id:'u1',origin:'person',created_at:'2026-11-17T10:00:00Z'}];
 const feed={changes:[{seq:8,writer_type:'user',writer_id:'u1',grant_id:null,origin:'person',created_at:'2026-11-18T10:00:00Z',ops:[{op:'put',node_id:'n1',kind:'file',path:'/docs/a.md',version:8,size_bytes:2048},{op:'move',node_id:'n2',kind:'folder',path:'/archive',from:'/old'},{op:'delete',node_id:'n3',kind:'file',path:'/tmp.txt'}],nodes_total:3,truncated:false}],next:8,head_seq:12};
 let removal=[200,{path:'/docs/a.md',files:1,folders:0,head_seq:9}];
 const f=await fixture(t,{
  [`POST ${notes}/move`]:req=>[200,file(req.body.to)],
  [`POST ${notes}/delete`]:()=>removal,
  [`GET ${notes}/history`]:req=>[200,req.query.before?{path:'/docs/a.md',versions:versions.slice(1),next_before:null}:{path:'/docs/a.md',versions:versions.slice(0,1),next_before:9}],
  [`GET ${notes}/changes`]:()=>[200,feed],
  [`POST ${notes}/restore`]:req=>[200,req.body.version!==undefined?{file:file('/docs/a.md',{version:10}),unchanged:false}:{path:req.body.path,seq:req.body.seq??6,restored:3,removed:1,moved:0,head_seq:13,unchanged:false}],
 });
 let result=await f.run(['drive','mv','notes/docs/a.md','/docs/b.md','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().route,f.last().body],['POST',`${notes}/move`,{from:'/docs/a.md',to:'/docs/b.md'}]);
 assert.equal(result.stdout,'moved  /docs/a.md  ->  /docs/b.md\n');
 await f.run(['drive','mv','notes/docs/a.md','archive/a.md']);
 assert.deepEqual(f.last().body,{from:'/docs/a.md',to:'/archive/a.md'});

 const before=f.seen.length;
 result=await f.run(['drive','rm','notes/docs/a.md']);
 assert.equal(result.code,2);assert.equal(result.json().error.code,'cave_confirmation_required');
 await mapPool([['rm','notes','--yes'],['mv','notes/a'],['mv','notes','x'],['mv','notes/a','/'],['log','notes'],['restore','notes/a'],['restore','notes/a','--version','2','--to','3'],['restore','notes','--version','2'],['restore','notes/a','--to','yesterday'],['changes','notes/docs'],['changes','notes','--after','x']],async bad=>{
  const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);
 });
 assert.equal(f.seen.length,before,'nothing is sent for a refused command');
 result=await f.run(['drive','rm','notes/docs/a.md','--yes','--format','table']);
 assert.deepEqual([f.last().route,f.last().body],[`${notes}/delete`,{path:'/docs/a.md'}]);
 assert.equal(result.stdout,'deleted  /docs/a.md  1 file\n');
 removal=[200,{path:'/docs',files:4,folders:2,head_seq:10}];
 result=await f.run(['drive','rm','notes/docs','-r','-y']);
 assert.deepEqual(f.last().body,{path:'/docs',recursive:true});assert.equal(result.json().files,4);
 removal=refusal(409,'cave_code_drive_not_empty','/docs is a folder with something in it: delete it with recursive, or delete what is inside first.');
 result=await f.run(['drive','rm','notes/docs','--yes']);
 assert.equal(result.code,4);assert.deepEqual(result.json().error,{code:'cave_code_drive_not_empty',message:'notes/docs is a folder with something in it: add --recursive to delete it and everything inside.'});

 f.seen.length=0;
 result=await f.run(['drive','log','notes/docs/a.md','--format','table']);
 assert.deepEqual(f.seen.map(r=>[r.method,r.route,r.query]),[['GET',`${notes}/history`,{path:'/docs/a.md',limit:'1000'}],['GET',`${notes}/history`,{path:'/docs/a.md',limit:'1000',before:'9'}]]);
 assert.equal(result.stdout,['VERSION  SIZE  WRITER  BY                                                    WRITTEN',`v9       20 B  agent   service_account ${accountId}  2026-11-18T10:00:00Z  current`,'v4       12 B  person  user u1                                               2026-11-17T10:00:00Z',''].join('\n'));
 assert.deepEqual((await f.run(['drive','log','notes/docs/a.md'])).json(),{path:'/docs/a.md',versions,next_before:null});

 result=await f.run(['drive','changes','notes','--after','7','--limit','50','--format','table']);
 assert.deepEqual([f.last().method,f.last().route,f.last().query],['GET',`${notes}/changes`,{after:'7',limit:'50'}]);
 assert.equal(result.stdout,['#8        2026-11-18T10:00:00Z  person, user','  put     /docs/a.md            v8  2.0 KB','  move    /archive/             from /old','  delete  /tmp.txt','more     cvm drive changes notes --after 8',''].join('\n'));
 result=await f.run(['drive','changes','notes']);
 assert.deepEqual(f.last().query,{});assert.equal(result.json().more,'cvm drive changes notes --after 8');assert.equal(result.json().head_seq,12);

 result=await f.run(['drive','restore','notes/docs/a.md','--version','4','--format','table']);
 assert.deepEqual([f.last().route,f.last().body],[`${notes}/restore`,{path:'/docs/a.md',version:4}]);
 assert.equal(result.stdout,'restored  /docs/a.md  now v10, the content of v4\n');
 result=await f.run(['drive','restore','notes/docs','--to','6','--format','table']);
 assert.deepEqual(f.last().body,{path:'/docs',seq:6});
 assert.equal(result.stdout,'restored  /docs  as it was after #6: 3 files restored, 1 removed, 0 moved (now #13)\n');
 await f.run(['drive','restore','notes','--to','2026-11-18T09:30:00Z']);
 assert.deepEqual(f.last().body,{path:'/',at:'2026-11-18T09:30:00.000Z'});
 await f.run(['drive','restore','notes','--to','2026-11-17']);
 assert.deepEqual(f.last().body,{path:'/',at:'2026-11-17T00:00:00.000Z'});
});

test('fork, merge, diff, review, approve, reject and undo each call their route with their body',async t=>{
 const changesetId='00000000-0000-4000-8000-0000000000c1',sessionId='00000000-0000-4000-8000-0000000000a1',forkId='00000000-0000-4000-8000-0000000000d2';
 const merged=(over={})=>({fork_drive_id:forkId,parent_drive_id:driveId,base_seq:7,fork_seq:9,written:['/a.md'],moved:[],deleted:['/old.md'],conflicts:[],head_seq:13,origin:'person',dry_run:false,unchanged:false,...over});
 const diffAnswer={from:7,to:9,path:'/docs',files:[{op:'modify',kind:'file',path:'/docs/a.md',from_version:4,to_version:9,diff:'@@ -1,1 +1,1 @@\n-one\n+two\n',truncated:false},{op:'move',kind:'file',path:'/docs/b.bin',from_path:'/b.bin',from_version:2,to_version:8,truncated:false,omitted:'binary'}],truncated:false};
 const changeset={id:changesetId,drive_id:driveId,fork_drive_id:forkId,session_id:sessionId,folder_id:'n1',status:'pending',commits:2,created_at:'2026-11-18T10:00:00Z',decided_by_user_id:null,decided_at:null,merged_seq:null};
 let merge=()=>[200,merged()],approval=req=>[200,req.body?.dry_run?{changeset,merge:merged({dry_run:true,head_seq:12})}:{changeset:{...changeset,status:'approved',decided_by_user_id:'u1',decided_at:'2026-11-18T11:00:00Z',merged_seq:13},merge:merged()}];
 const f=await fixture(t,{
  [`POST ${notes}/fork`]:req=>[201,drive({id:forkId,name:req.body.name,parent_drive_id:driveId,parent_seq:req.body.seq??7,purpose:'drive'})],
  [`POST ${drives}/notes-next/merge`]:()=>merge(),
  [`GET ${notes}/diff`]:()=>[200,diffAnswer],
  [`GET ${notes}/changesets`]:req=>[200,{changesets:req.query.status==='pending'?[changeset]:[]}],
  [`GET ${notes}/changesets/${changesetId}`]:()=>[200,{changeset,diff:diffAnswer}],
  [`POST ${notes}/changesets/${changesetId}/approve`]:req=>approval(req),
  [`POST ${notes}/changesets/${changesetId}/reject`]:()=>[200,{changeset:{...changeset,status:'rejected',decided_by_user_id:'u1',decided_at:'2026-11-18T11:00:00Z'}}],
  [`POST ${notes}/undo`]:req=>[200,{session_id:req.body.session_id,restored:2,removed:1,moved:0,skipped:[{path:'/g.md',reason:'changed_later'}],outside:0,head_seq:14,unchanged:false}],
 });
 let result=await f.run(['drive','fork','notes','notes-next','--at','7','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().route,f.last().body],['POST',`${notes}/fork`,{name:'notes-next',seq:7}]);
 assert.equal(result.stdout,`forked  notes-next  ${forkId}  from notes as it was after #7\nmerge   cvm drive merge notes-next --dry-run\n`);
 await f.run(['drive','fork','notes','notes-next']);
 assert.deepEqual(f.last().body,{name:'notes-next'});

 result=await f.run(['drive','merge','notes-next','--dry-run']);
 assert.deepEqual([f.last().route,f.last().body],[`${drives}/notes-next/merge`,{dry_run:true}]);
 assert.equal(result.code,0);assert.deepEqual(result.json(),merged());
 result=await f.run(['drive','merge','notes-next','--format','table']);
 assert.deepEqual(f.last().body,{});
 assert.equal(result.stdout,['merged     notes-next into its parent from #7 to #9: one commit as person, the parent now at #13','  written  /a.md','  deleted  /old.md',''].join('\n'));
 merge=()=>[200,merged({written:[],deleted:[],conflicts:[{path:'/a.md',reason:'both_changed',resolution:'fork_copy_written',copy_path:'/a (conflict from notes-next).md'}]})];
 result=await f.run(['drive','merge','notes-next','--format','table']);
 assert.equal(result.code,4,'a merge that lists conflicts exits 4');
 assert.match(result.stdout,/conflict  \/a\.md  both_changed: kept, the other side written beside it \(at \/a \(conflict from notes-next\)\.md\)/);

 result=await f.run(['drive','diff','notes/docs','--from','7','--to','9','--format','table']);
 assert.deepEqual([f.last().method,f.last().route,f.last().query],['GET',`${notes}/diff`,{from:'7',to:'9',path:'/docs'}]);
 assert.equal(result.stdout,['#7 -> #9  under /docs','modify  /docs/a.md  v4 -> v9','@@ -1,1 +1,1 @@','-one','+two','move  /docs/b.bin  from /b.bin  v2 -> v8','  (no line diff: binary)',''].join('\n'));
 await f.run(['drive','diff','notes']);
 assert.deepEqual(f.last().query,{});

 result=await f.run(['drive','review','notes','--format','table']);
 assert.deepEqual([f.last().route,f.last().query],[`${notes}/changesets`,{status:'pending'}]);
 assert.match(result.stdout,new RegExp(`^CHANGESET +SESSION +STATUS +COMMITS +HELD SINCE\n${changesetId}  ${sessionId}  pending  2 +2026-11-18T10:00:00Z\nread    cvm drive review notes CHANGESET\n$`));
 result=await f.run(['drive','review','notes','--status','approved','--format','table']);
 assert.equal(result.stdout,'No approved changesets on notes.\n');
 result=await f.run(['drive','review','notes',changesetId,'--format','table']);
 assert.equal(f.last().route,`${notes}/changesets/${changesetId}`);
 assert.match(result.stdout,new RegExp(`approve +cvm drive approve notes ${changesetId} --at 9\n`));
 assert.match(result.stdout,/modify  \/docs\/a\.md  v4 -> v9\n@@ -1,1 \+1,1 @@\n-one\n\+two\n/);

 // A dry run with no --at reads the changeset's head first and shows the plan
 // at that head, with the approve line that pins it.
 result=await f.run(['drive','approve','notes',changesetId,'--dry-run','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.slice(-2).map(r=>[r.method,r.route]),[['GET',`${notes}/changesets/${changesetId}`],['POST',`${notes}/changesets/${changesetId}/approve`]]);
 assert.deepEqual(f.last().body,{fork_seq:9,dry_run:true});
 assert.equal(result.stdout,`dry run  changeset ${changesetId} of session ${sessionId}: approving would write 1 file written, 0 moved, 1 deleted\napprove  cvm drive approve notes ${changesetId} --at 9\n`);
 await f.run(['drive','approve','notes',changesetId,'--dry-run','--at','8']);
 assert.deepEqual(f.last().body,{fork_seq:8,dry_run:true});
 result=await f.run(['drive','approve','notes',changesetId,'--at','9','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().route,f.last().body],['POST',`${notes}/changesets/${changesetId}/approve`,{fork_seq:9}]);
 assert.equal(result.stdout,`approved  changeset ${changesetId} of session ${sessionId}\nmerged    1 file written, 0 moved, 1 deleted, the drive now at #13\n`);
 approval=()=>[200,{changeset:{...changeset,status:'approved',decided_by_user_id:'u1',decided_at:'2026-11-18T11:00:00Z',merged_seq:13},
  merge:merged({conflicts:[{path:'/a.md',reason:'both_changed',resolution:'fork_copy_written',copy_path:'/a (conflict from x).md'},{path:'/gone.md',reason:'deleted_in_parent',resolution:'fork_restored'}]})}];
 result=await f.run(['drive','approve','notes',changesetId,'--at','9','--format','table']);
 assert.equal(result.code,0,'an approval with conflicts goes in');
 assert.match(result.stdout,/conflict  \/a\.md  both_changed: kept, the other side written beside it \(at \/a \(conflict from x\)\.md\)\n/);
 assert.match(result.stdout,/conflict  \/gone\.md  deleted_in_parent: brought back with the changes\n/);

 const before=f.seen.length;
 await mapPool([['fork','notes'],['fork','notes','Bad Name'],['fork','notes/docs','x'],['fork','notes','x','--at','y'],['merge','notes/docs'],['diff','notes','--from','x'],['review','notes','not-an-id'],['review','notes','--status','open'],
  ['approve','notes'],['approve','notes','nope'],['approve','notes',changesetId],['approve','notes',changesetId,'--at','x'],['reject','notes',changesetId],['undo','notes'],['undo','notes','--session','x'],['undo','notes/docs','--session',sessionId]],async bad=>{
  const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);
 });
 assert.equal(f.seen.length,before,'nothing is sent for a refused command');
 result=await f.run(['drive','reject','notes',changesetId,'--yes','--format','table']);
 assert.equal(f.last().route,`${notes}/changesets/${changesetId}/reject`);
 assert.equal(result.stdout,`rejected  changeset ${changesetId} of session ${sessionId}\n`);

 result=await f.run(['drive','undo','notes','--session',sessionId,'--format','table']);
 assert.deepEqual([f.last().route,f.last().body],[`${notes}/undo`,{session_id:sessionId}]);
 assert.equal(result.stdout,`undone  session ${sessionId} in one commit, notes now at #14: 2 restored, 1 removed, 0 moved back\n  left  /g.md  changed later\n`);

 // With a share token, diff reads the share mount; the rest are not a token's.
 f.seen.length=0;
 result=await f.run(['drive','diff','docs','--from','1'],{CAVEMAN_DRIVE_TOKEN:token,CAVE_API_URL:f.url});
 assert.deepEqual(f.seen.map(r=>[r.method,r.route,r.query]),[['GET',`${share}/diff`,{from:'1',path:'/docs'}]]);
 await mapPool([['fork','notes','x'],['merge','notes'],['review','notes'],['undo','notes','--session',sessionId]],async verb=>{
  const refused=await f.run(['drive',...verb],{CAVEMAN_DRIVE_TOKEN:token});
  assert.equal(refused.json().error.code,'cave_share_token_scope',verb.join(' '));
 });
});

test('share prints the token once, when it ends, what it gives, the cvm line and an MCP entry; --for is 5m to 12h',async t=>{
 const f=await fixture(t,{[`POST ${notes}/shares`]:req=>[201,{token,grant:grant({read:req.body.read,write:req.body.write,label:req.body.label??''})}]});
 const mcp=JSON.stringify({mcpServers:{'caveman-drive':{type:'http',url:`${f.url}${share}/mcp`,headers:{Authorization:`Bearer ${token}`}}}});
 const use=`CAVEMAN_DRIVE_TOKEN=${token} cvm drive ls --instance ${f.url}`;
 let result=await f.run(['drive','share','notes/docs','--read','--write','--for','15m','--label','for the research agent','--format','table'],{},{showsToken:true});
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().route,f.last().body,f.last().headers.authorization],['POST',`${notes}/shares`,{path:'/docs',read:true,write:true,ttl_seconds:900,label:'for the research agent'},`Bearer ${secret}`]);
 assert.equal(result.stdout,[`token   ${token}`,'ends    2026-11-18T11:00:00Z','gives   read and write on notes/docs  (for the research agent)',`use     ${use}`,`mcp     ${mcp}`,`revoke  cvm drive revoke notes ${grantId}`,''].join('\n'));
 assert.equal(result.stdout.split(token).length-1,3,'the token: once by itself, once in each ready line');
 assert.equal(result.stderr,'');
 result=await f.run(['drive','share','notes','--read'],{},{showsToken:true});
 assert.deepEqual(f.last().body,{path:'/',read:true,write:false});
 assert.deepEqual(result.json(),{token,grant:grant(),use,mcp});
 assert.deepEqual(JSON.parse(result.json().mcp).mcpServers['caveman-drive'].headers,{Authorization:`Bearer ${token}`});
 for(const [span,seconds] of [['5m',300],['300s',300],['12h',43200],['90m',5400]]){
  await f.run(['drive','share','notes','--write','--for',span],{},{showsToken:true});
  assert.deepEqual(f.last().body,{path:'/',read:false,write:true,ttl_seconds:seconds});
 }
 const before=f.seen.length;
 await mapPool([['--read','--for','4m'],['--read','--for','299s'],['--read','--for','13h'],['--read','--for','721m'],['--read','--for','15'],['--read','--for','1d'],['--read','--for','soon'],['--read','--for',''],[],['--for','15m']],async bad=>{
  const refused=await f.run(['drive','share','notes',...bad]);
  assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);assert.equal(refused.json().error.code,'cave_usage');
 });
 assert.equal(f.seen.length,before,'a bad --for is refused before anything is sent');
 // An answer without a share token is not printed as one.
 const g=await fixture(t,{[`POST ${notes}/shares`]:()=>[201,{token:'\u001b[31mnot-a-token',grant:grant()}]});
 result=await g.run(['drive','share','notes','--read']);
 assert.equal(result.code,6);assert.equal(result.json().error.code,'cave_invalid_response');
});

test('grants, grant and revoke each call their route',async t=>{
 const account=grant({id:'00000000-0000-4000-8000-0000000000e2',principal_type:'service_account',service_account_id:accountId,read:true,write:true,expires_at:null,path:'/'});
 const f=await fixture(t,{
  [`GET ${notes}/grants`]:()=>[200,{grants:[grant({label:'research'}),account,grant({id:'00000000-0000-4000-8000-0000000000e3',revoked_at:'2026-11-18T10:30:00Z',live:false}),grant({id:'00000000-0000-4000-8000-0000000000e4',path:null})]}],
  [`POST ${notes}/grants`]:req=>[201,{...account,path:req.body.path,read:req.body.read,write:req.body.write,expires_at:req.body.expires_at??null}],
  [`POST ${notes}/grants/${grantId}/revoke`]:()=>[200,grant({revoked_at:'2026-11-18T10:30:00Z',live:false})],
 });
 let result=await f.run(['drive','grants','notes','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual([f.last().method,f.last().path],['GET',`${notes}/grants`]);
 const lines=result.stdout.split('\n');
 assert.match(lines[0],/^ID +FOR +GIVES +PATH +ENDS +STATE +LABEL$/);
 assert.match(lines[1],new RegExp(`^${grantId}  share token +read +/docs  2026-11-18T11:00:00Z  live +research$`));
 assert.match(lines[2],new RegExp(`account ${accountId}  read and write  / +when revoked +live$`));
 assert.match(lines[3],/ revoked$/);assert.match(lines[4],/ - +2026-11-18T11:00:00Z  folder gone$/);
 assert.equal((await f.run(['drive','grants','notes'])).json().grants.length,4);

 result=await f.run(['drive','grant','notes/docs','--to',accountId,'--read','--write','--until','2026-12-01T00:00:00Z','--format','table']);
 assert.deepEqual([f.last().method,f.last().route,f.last().body],['POST',`${notes}/grants`,{service_account_id:accountId,path:'/docs',read:true,write:true,expires_at:'2026-12-01T00:00:00.000Z'}]);
 assert.match(result.stdout,new RegExp(`^granted  read and write on notes/docs to account ${accountId}, until 2026-12-01T00:00:00\\.000Z\nrevoke   cvm drive revoke notes `));
 await f.run(['drive','grant','notes','--to',accountId,'--read']);
 assert.deepEqual(f.last().body,{service_account_id:accountId,path:'/',read:true,write:false});

 result=await f.run(['drive','revoke','notes',grantId,'--format','table']);
 assert.deepEqual([f.last().method,f.last().route,f.last().body],['POST',`${notes}/grants/${grantId}/revoke`,{}]);
 assert.equal(result.stdout,`revoked  ${grantId}  share token  2026-11-18T10:30:00Z\n`);
 const before=f.seen.length;
 await mapPool([['grant','notes','--read'],['grant','notes','--to','deploy-bot','--read'],['grant','notes','--to',accountId],['grant','notes','--to',accountId,'--read','--until','soon'],['revoke','notes'],['revoke','notes','../../archive'],['revoke','notes/docs',grantId],['grants']],async bad=>{
  const refused=await f.run(['drive',...bad]);assert.equal(refused.code,2,`${bad.join(' ')}: ${refused.stdout}`);
 });
 assert.equal(f.seen.length,before);
});

// Every route of the share mount, answering as the drive routes of the same name do.
const shared=()=>({
 [`GET ${share}`]:()=>[200,{read:true,write:true,expires_at:'2026-11-18T11:00:00Z',label:'for the research agent'}],
 [`GET ${share}/files`]:()=>[200,{files:[file('/a.md'),folder('/sub')],next_cursor:null}],
 [`POST ${share}/read`]:()=>[200,{path:'/a.md',version:3,size_bytes:4,line_count:1,offset:1,lines:1,content:'# a\n',truncated:false,next_offset:null,origin:'agent'}],
 [`GET ${share}/content`]:()=>[200,Buffer.from('# a\n'),{etag:'"3"'}],
 [`PUT ${share}/content`]:req=>written(req),
 [`POST ${share}/grep`]:()=>[200,{matches:[{path:'/a.md',line:1,text:'# a',cut:false,version:3}],coverage:{files_searched:1,stopped:''}}],
 [`POST ${share}/move`]:req=>[200,file(req.body.to)],
 [`POST ${share}/delete`]:req=>[200,{path:req.body.path,files:1,folders:0,head_seq:9}],
 [`GET ${share}/history`]:()=>[200,{path:'/a.md',versions:[{version:3,current:true,size_bytes:4,origin:'agent',writer_type:'token',writer_id:null,created_at:'2026-11-18T10:00:00Z'}],next_before:null}],
});

test('a share token works with an empty HOME: the share mount, the token as the bearer, and no drive in any address',async t=>{
 const f=await fixture(t,shared(),{signedIn:false});
 const env={CAVEMAN_DRIVE_TOKEN:token,CAVE_API_URL:f.url};
 await f.write('new.md','# new\n');
 await mapPool([
  [['drive'],'GET',share,undefined],
  [['drive','ls'],'GET',`${share}/files`,{path:'/',limit:'1000'}],
  [['drive','ls','sub','--recursive'],'GET',`${share}/files`,{path:'/sub',recursive:'true',limit:'1000'}],
  [['drive','cat','a.md'],'POST',`${share}/read`,{path:'/a.md',offset:1}],
  [['drive','get','/a.md','copy.md'],'GET',`${share}/content`,{path:'/a.md'}],
  [['drive','put','new.md'],'PUT',`${share}/content`,{path:'/new.md',if_absent:'true'}],
  [['drive','put','new.md','sub/renamed.md'],'PUT',`${share}/content`,{path:'/sub/renamed.md',if_absent:'true'}],
  [['drive','grep','a'],'POST',`${share}/grep`,{pattern:'a',path:'/'}],
  [['drive','grep','a','sub'],'POST',`${share}/grep`,{pattern:'a',path:'/sub'}],
  [['drive','mv','a.md','sub/a.md'],'POST',`${share}/move`,{from:'/a.md',to:'/sub/a.md'}],
  [['drive','rm','a.md','--yes'],'POST',`${share}/delete`,{path:'/a.md'}],
  [['drive','log','a.md'],'GET',`${share}/history`,{path:'/a.md',limit:'1000'}],
 ],async([args,method,route,sent],index)=>{
  const caseToken=`${token}-${index}`;
  const result=await f.run(args,{CAVEMAN_DRIVE_TOKEN:caseToken,CAVE_API_URL:f.url});
  assert.equal(result.code,0,`${args.join(' ')}: ${result.stdout}${result.stderr}`);
  const own=f.seen.filter(req=>req.headers.authorization===`Bearer ${caseToken}`);
  assert.equal(own.length,1,args.join(' '));
  const [req]=own;
  assert.equal(req.method,method,args.join(' '));
  assert.equal(req.route,route,args.join(' '));
  if(sent!==undefined)assert.deepEqual(req.method==='POST'?req.body:req.query,sent,args.join(' '));
  JSON.parse(result.stdout);
 });
 assert.equal(await readFile(join(f.home,'copy.md'),'utf8'),'# a\n');
 assert.deepEqual((await readdir(f.home)).sort(),['copy.md','new.md'],'nothing is saved in the home: no config, no credential, no token');
 // --token and --instance say the same as the two variables.
 let result=await f.run(['drive','--token',token,'--instance',f.url,'--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.equal(result.stdout,'share  read and write on one folder, until 2026-11-18T11:00:00Z\nlabel  for the research agent\ntry    cvm drive ls\n');
 result=await f.run(['drive','ls','--token',token,'--instance',f.url+'/','--format','table']);
 assert.match(result.stdout,/^NAME {2}SIZE {2}TOKENS {2}WRITER {2}VERSION {2}CHANGED\na\.md {2}12 B {2}4 {7}person {2}v3 /);
 // What a share token cannot do is refused here, and nothing is sent.
 const before=f.seen.length;
 await Promise.all([
  mapPool([[['list'],'list drives'],[['create','x'],'create a drive'],[['changes','notes'],'read a drive\'s changes'],[['restore','a.md','--version','2'],'restore'],[['share','notes','--read'],'make another share'],[['grants','notes'],'list a drive\'s grants'],
   [['grant','notes','--to',accountId,'--read'],'give a grant'],[['revoke','notes',grantId],'revoke a grant'],[['verify','notes'],'verify a drive'],[['archive','notes','--yes'],'archive a drive']],async([args,what])=>{
   const res=await f.run(['drive',...args],env);
   assert.equal(res.code,2,args.join(' '));
   assert.deepEqual(res.json().error,{code:'cave_share_token_scope',message:`A share token cannot ${what}: that takes a signed-in cvm (cvm login, with CAVEMAN_DRIVE_TOKEN unset).`});
  }),
  mapPool([['drive','ls','--token','not-a-token'],['drive','ls','--token','cdrv_short'],['drive','ls','--instance','not a url','--token',token],['drive','cat'],['drive','mv','a.md']],async bad=>{
   const res=await f.run(bad,bad.includes('--token')?{CAVE_API_URL:f.url}:env);assert.equal(res.code,2,bad.join(' '));assert.equal(res.json().error.code,'cave_usage');
  }),
 ]);
 assert.equal(f.seen.length,before);
 // Without a token and without a sign-in, the answer says both ways in.
 result=await f.run(['drive','ls','notes'],{CAVE_API_URL:f.url});
 assert.equal(result.code,3);assert.deepEqual(result.json().error,{code:'cave_auth_required',message:'Run cvm login, or set CAVE_TOKEN. With a share token, set CAVEMAN_DRIVE_TOKEN.'});
 result=await f.run(['drive','ls','notes','--instance',f.url],{CAVE_API_URL:f.url});
 assert.equal(result.code,2);assert.match(result.json().error.message,/^--instance goes with a share token\./);
});

test('a share token is the only credential sent, also on a machine that is signed in; and it is never printed back',async t=>{
 let reply;
 const f=await fixture(t,{...shared(),[`GET ${share}/files`]:()=>reply});
 // A server that echoes the bearer in its refusal, in a message and in a body that is not the envelope.
 reply=refusal(401,'cave_unauthorized',`This share token is not valid now: ${token} was refused.`);
 let result=await f.run(['drive','ls'],{CAVEMAN_DRIVE_TOKEN:token});
 assert.equal(result.code,3);
 assert.deepEqual(result.json().error,{code:'cave_unauthorized',message:'This share token is not valid now: [share token] was refused.'});
 assert.equal(f.last().headers.authorization,`Bearer ${token}`);
 assert.ok(!JSON.stringify(f.seen.map(r=>[r.headers,r.path])).includes(secret),'the saved sign-in is not sent with a share token');
 reply=[500,`<html>Bearer ${token}</html>`];
 result=await f.run(['drive','ls','--format','table'],{CAVEMAN_DRIVE_TOKEN:token});
 assert.equal(result.code,1);assert.equal(result.stdout,'failed   cave_request_failed: The drive ls failed (HTTP 500).\n');
 reply=refusal(400,'cave_bad_request',`Another token cdrv_someone-elses-token-in-a-message is in this message.`);
 result=await f.run(['drive','ls'],{CAVEMAN_DRIVE_TOKEN:token});
 assert.equal(result.json().error.message,'Another token [share token] is in this message.');
 // A token typed where an address goes is not echoed in the usage answer either.
 result=await f.run(['drive','ls',token]);
 assert.equal(result.code,2);
 await mapPool([['drive','put','missing.md'],['drive','get','a.md','copy.md'],['drive','cat','a.md','--format','table'],['drive','rm','a.md'],['drive','--help']],async args=>{
  const r=await f.run(args,{CAVEMAN_DRIVE_TOKEN:token});assert.ok(r.code!==undefined);
 });
 for(const entry of await readdir(f.home,{recursive:true}))if((await lstat(join(f.home,entry))).isFile())assert.ok(!(await readFile(join(f.home,entry),'utf8')).includes('cdrv_'),`${entry} holds no share token`);
});

test('put of a folder with a share token: create-only without --overwrite, versions named with it, and a write-only token says it cannot overwrite',async t=>{
 let listed=[200,{files:[file('/in/exists.md',{version:21})],next_cursor:null}];
 const f=await fixture(t,{
  [`GET ${share}/files`]:()=>listed,
  [`PUT ${share}/content`]:req=>req.query.path==='/in/exists.md'&&req.query.if_absent?refusal(409,'cave_code_drive_exists','/in/exists.md already exists: pick another path.'):written(req),
 },{signedIn:false});
 const env={CAVEMAN_DRIVE_TOKEN:token,CAVE_API_URL:f.url},x=process.platform==='win32'?'':'&executable=true';
 await tree(f);
 const puts=condition=>['a.md','exists.md','notes','sub%2Fdeep%2Fb.json','sub%2Frun.sh'].map((name,i)=>`PUT ${share}/content?path=%2Fin%2F${name}&${condition(name)}${i===4?x:''}`);
 // Without --overwrite nothing is listed: every file must be new, and the one that is not is refused.
 let result=await f.run(['drive','put','up','in'],env);
 assert.equal(result.code,4,result.stdout);
 assert.deepEqual(calls(f),puts(()=>'if_absent=true'));
 for(const r of f.seen)assert.equal(r.headers.authorization,`Bearer ${token}`);
 let out=result.json();
 assert.deepEqual([out.drive,out.sent.length,out.refused.map(r=>r.path),out.skipped.map(s=>s.local)],[undefined,4,['/in/exists.md'],[join('up','link.md'),join('up','void')]]);
 assert.equal(out.hint,'1 file already exists in the drive: repeat with --overwrite to replace it.');
 // With it, the folder is listed first and the file there is replaced by its version.
 f.seen.length=0;
 result=await f.run(['drive','put','up','in','--overwrite'],env);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(calls(f),[`GET ${share}/files?path=%2Fin&recursive=true&limit=1000`,...puts(name=>name==='exists.md'?'if_version=21':'if_absent=true')]);
 // Write only: the listing answers what a missing path does, so no version is known.
 listed=refusal(404,'cave_not_found','No such drive, folder or file: check the drive and the path, or list the folder above it.');
 f.seen.length=0;
 result=await f.run(['drive','put','up','in','--overwrite'],env);
 assert.equal(result.code,4,result.stdout);
 assert.deepEqual(calls(f),[`GET ${share}/files?path=%2Fin&recursive=true&limit=1000`,...puts(()=>'if_absent=true').slice(0,2),`GET ${share}/files?path=%2Fin%2Fexists.md&limit=1000`,...puts(()=>'if_absent=true').slice(2)]);
 out=result.json();
 assert.deepEqual(out.sent.map(sent=>sent.path),['/in/a.md','/in/notes','/in/sub/deep/b.json','/in/sub/run.sh']);
 assert.deepEqual(out.refused,[{path:'/in/exists.md',local:join('up','exists.md'),code:'cave_code_drive_exists',message:'/in/exists.md already exists, and this share token may write here but not read: it cannot name the version it would replace, so it cannot overwrite. It can still add new files.'}]);
 assert.equal(out.hint,undefined,'--overwrite was given: the hint to pass it is not');
 result=await f.run(['drive','put','up','in','--overwrite','--format','table'],env);
 assert.match(result.stdout,/\nrefused {4}\/in\/exists\.md {2}cave_code_drive_exists: \/in\/exists\.md already exists, and this share token may write here but not read/);
});

test('drives switched off, or a Cloud older than drives, is said in plain words; any other refusal is the API\'s message, once',async t=>{
 const off='Drives are off on this Caveman Cloud: an operator turns them on with the chart\'s code.drives.enabled.';
 const makeOff=reply=>fixture(t,{[`GET ${drives}`]:()=>reply,[`GET ${notes}/files`]:()=>reply,[`PUT ${notes}/content`]:()=>reply,[`GET ${notes}/content`]:()=>reply,[`GET ${share}/files`]:()=>reply,[`POST ${notes}/uploads`]:()=>reply});
 const [fNew,fOld,fBare]=await Promise.all([
  makeOff(refusal(404,'cave_code_drives_off',off)),
  // The release before said it as cave_not_found; cvm says it the one way.
  makeOff(refusal(404,'cave_not_found','Drives are not enabled on this installation.')),
  // A Cloud with no drive routes at all answers a bare 404.
  makeOff([404,'404 page not found\n']),
 ]);
 const big=Buffer.alloc(8*1024*1024+1);
 await Promise.all([fNew,fOld].flatMap(f=>[f.write('a.md','# a\n'),f.write('big.bin',big)]));
 const every=[[['drive']],[['drive','ls','notes']],[['drive','put','a.md','notes']],[['drive','put','big.bin','notes']],[['drive','get','notes/a.md','b.md']],[['drive','ls'],{CAVEMAN_DRIVE_TOKEN:token}],[['drive','put','a.md','notes','--overwrite'],{CAVE_TOKEN:key}]];
 const offCases=[];
 for(const f of [fNew,fOld]){
  for(const [args,env] of every){
   offCases.push([f,args,env,false]);
   offCases.push([f,[...args,'--format','table'],env,true]);
  }
 }
 await Promise.all([
  mapPool(offCases,async([f,args,env,table])=>{
   const res=await f.run(args,env);
   assert.equal(res.code,1,args.join(' '));
   if(table)assert.equal(res.stdout,off+'\n',args.join(' '));
   else assert.deepEqual(res.json().error,{code:'cave_code_drives_off',message:off},args.join(' '));
  }),
  mapPool([['drive'],['drive','ls','notes'],['drive','get','notes/a.md','b.md']],async args=>{
   const res=await fBare.run(args);
   assert.equal(res.code,1);
   assert.deepEqual(res.json().error,{code:'cave_not_found',message:'This Caveman Cloud serves no drives: they are switched off on this installation, or it is older than drives.'},args.join(' '));
  }),
 ]);
 let reply=refusal(403,'cave_forbidden','Only a person can share a drive: ask one to.\u001b[31m');
 const f=await fixture(t,{[`GET ${drives}`]:()=>reply});
 let result=await f.run(['drive'],{CAVE_TOKEN:key});
 assert.equal(result.code,3);assert.deepEqual(result.json().error,{code:'cave_forbidden',message:'Only a person can share a drive: ask one to.'});
 reply=[502,`<html>${secret}</html>`];
 result=await f.run(['drive']);
 assert.equal(result.code,1);assert.deepEqual(result.json().error,{code:'cave_request_failed',message:'The drive list failed (HTTP 502).'});
 result=await f.run(['drive','get','notes/a.md','b.md'],{CAVE_API_URL:'http://127.0.0.1:9',CAVE_TOKEN:key});
 assert.equal(result.code,1);assert.deepEqual(result.json().error,{code:'cave_network_error',message:'Could not reach Caveman Cloud.'});
 assert.ok(!existsSync(join(f.home,'b.md')));
});

test('help answers without a sign-in or a request, for the family and for each verb',async t=>{
 const f=await fixture(t,{},{signedIn:false});
 const verbs=['list','create','ls','cat','get','put','grep','mv','rm','log','changes','restore','share','grants','grant','revoke','verify','archive','unarchive','set','usage','fork','merge','diff','review','approve','reject','undo','mount'];
 const [topRes,dispatcher,verbResults,screen,rootHelp]=await Promise.all([
  f.run(['drive','--help']),
  readFile(bin,'utf8'),
  mapPool(verbs.slice(1),verb=>f.run(['drive',verb,'--help'])),
  f.run(['drive','--help','--format','table']),
  f.run(['--help','--format','json']),
 ]);
 const top=topRes.json();
 assert.match(top.usage,/^cvm drive /);
 assert.deepEqual(top.commands.map(c=>c.verb),verbs);
 // The rows cvm.mjs lists under the drive family say what each verb's own help says.
 for(const command of top.commands){assert.match(command.usage,/^cvm drive /);assert.ok(dispatcher.includes(`{id:'drive.${command.verb}',usage:'${command.usage}',`),`cvm.mjs lists cvm drive ${command.verb} as its help does`);}
 verbs.slice(1).forEach((verb,i)=>{
  const result=verbResults[i];
  assert.equal(result.code,0,result.stdout);assert.match(result.json().usage,new RegExp(`^cvm drive ${verb}( |$)`));
 });
 const getHelp=top.commands.find(c=>c.verb==='get');
 assert.match(getHelp.usage,/ \[--include-protected\] \[--force\]$/);
 assert.match(getHelp.summary,/is skipped and listed on stderr, and the exit is 4, unless --include-protected\./);assert.match(getHelp.summary,/To a terminal, - writes the bytes only with --force\.$/);
 assert.ok(top.notes.some(note=>/show a control or an invisible character as an escape/.test(note)));
 assert.match(screen.stdout,/^Drives: versioned file trees an organization shares with its agents\.\n\n {2}cvm drive \[list\]\n {6}The drives you can reach\.\n/);
 assert.match(screen.stdout,/\nWith a share token \(--token cdrv_\.\.\., or CAVEMAN_DRIVE_TOKEN\) there is no drive and no sign-in/);
 assert.ok(rootHelp.json().families.includes('drive'));
 assert.deepEqual(f.seen,[]);
});

// ---- what get does not write by itself, and what a terminal is not sent --------

test('get\'s protected names cover VCS, editor, agent, and env paths across case, Unicode, and 8.3 short names',async()=>{
 const {PROTECTED,protectedPath}=await import('../bin/drive.mjs');
 assert.ok(PROTECTED.folders.includes('.git')&&PROTECTED.folders.includes('.claude')&&PROTECTED.folders.includes('.vscode'));
 assert.ok(PROTECTED.files.includes('CLAUDE.md')&&PROTECTED.files.includes('AGENTS.md')&&PROTECTED.files.includes('.envrc')&&PROTECTED.files.includes('.mcp.json'));
 for(const path of [
  '/.git/hooks/pre-commit','/a/b/.git/config','/.claude/settings.json','/.vscode/tasks.json','/CLAUDE.md','/docs/AGENTS.md','/.envrc','/x/.mcp.json','/a/agent.json',
  // Spelled as a disk that keeps neither case nor normalisation apart reads it, on any name of the path.
  '/a/.GIT/config','/.Git/hooks/x','/.Claude/skills/x/notes.md','/docs/claude.MD','/a/Agents.md','/x/.MCP.JSON','/\uff0egit/config','/.cur\u017for/rules/always.mdc','/.g\u0131t/hooks/x','/a/.\u212aIRO/steering.md',
  // What such a disk drops from a name: the dots and spaces it ends with, and characters nobody sees.
  '/.git./config','/.git /config','/.g\u200bit/config','/docs/CLAUDE.md.',
  // The short name Windows keeps for one: its first letters, or two and four hex digits, then ~ and a number.
  '/GIT~1/hooks/pre-commit','/a/git~12/x','/CLAUDE~1/settings.json','/VSCODE~1/tasks.json','/DEVCON~1/devcontainer.json','/a/GI3F2A~1/config','/x/ENVRC~1','/MCP~1.JSO','/OPENCO~1.JSO',
 ])assert.equal(protectedPath(path),true,`${JSON.stringify(path)} is protected`);
 for(const path of ['/','/README.md','/docs/git/hooks/pre-commit','/docs/claude/settings.json','/.gitignore','/docs/rules','/agent.json.bak','/CLAUDE.md/notes.txt','/AGENTS.md/x','/~/x','/a~b/c','/x~1/y','/~1/y','/docs/report~2.txt'])
  assert.equal(protectedPath(path),false,`${JSON.stringify(path)} is not protected`);
});

test('get skips a name a tool runs or obeys, says each on stderr and in the answer, and exits 4; --include-protected writes them',async t=>{
 const listed=[folder('/docs/.claude'),file('/docs/.claude/settings.json'),file('/docs/a.md'),file('/docs/sub/.GIT/hooks/pre-commit',{executable:true}),file('/docs/sub/b.md'),file('/docs/sub/Agents.MD'),file('/docs/GIT~1/config'),file('/docs/.cur\u017for/rules/always.mdc')];
 const kept=['/docs/a.md','/docs/sub/b.md'],passed=listed.map(entry=>entry.path).filter(path=>!kept.includes(path));
 const reason='a name a tool runs or obeys from the folder it is in',few='6 paths were not written: pass --include-protected to write them.',single='1 path was not written: pass --include-protected to write it.';
 const said=[...passed.map(path=>`skipped  notes${path}${path==='/docs/.claude'?'/':''}  ${reason}`),few,''].join('\n');
 const f=await fixture(t,{
  [`GET ${notes}/files`]:()=>[200,{files:listed,next_cursor:null}],
  [`GET ${notes}/content`]:req=>[200,Buffer.from(`content of ${req.query.path}`),{etag:'"3"'}],
 });
 const downloads=()=>f.seen.filter(r=>r.route.endsWith('/content')).map(r=>r.query.path);
 // A person signed in, and a whole folder: the rest still arrives.
 let result=await f.run(['drive','get','notes/docs','--recursive']);
 assert.equal(result.code,4,result.stdout);
 assert.deepEqual(result.json(),{schema_version:1,ok:false,status:'incomplete',files:kept.map(path=>({path,local:join(...path.split('/').slice(1)),size_bytes:`content of ${path}`.length,version:3})),bytes:46,skipped:passed.map(path=>({path,reason})),hint:few});
 assert.equal(result.stderr,said);
 assert.deepEqual((await readdir(join(f.home,'docs'),{recursive:true})).sort(),['a.md','sub',join('sub','b.md')]);
 assert.deepEqual(downloads(),kept,'a skipped file is not even downloaded');
 result=await f.run(['drive','get','notes/docs','second','--recursive','--format','table']);
 assert.equal(result.code,4);
 assert.equal(result.stdout,[`saved  ${join('second','a.md')}  21 B  v3`,`saved  ${join('second','sub','b.md')}  25 B  v3`,'2 files, 46 B',''].join('\n'));
 assert.equal(result.stderr,said);
 // A folder that is itself such a name: nothing is written, the folder included.
 result=await f.run(['drive','get','notes/.claude','--recursive']);
 assert.equal(result.code,4);assert.deepEqual([result.json().status,result.json().files,result.json().skipped.length],['skipped',[],8]);
 assert.ok(!existsSync(join(f.home,'.claude')));
 // One file: by its own name, or by a folder it is in, at any depth and however spelled; with a share token too.
 const before=f.seen.length;
 result=await f.run(['drive','get','notes/docs/CLAUDE.md']);
 assert.equal(result.code,4);
 assert.deepEqual(result.json(),{schema_version:1,ok:false,status:'skipped',files:[],bytes:0,skipped:[{path:'/docs/CLAUDE.md',reason}],hint:single});
 assert.equal(result.stderr,`skipped  notes/docs/CLAUDE.md  ${reason}\n${single}\n`);
 await mapPool(['notes/.git/config','notes/a/.VSCode/tasks.json','notes/.envrc','notes/x/GIT~1/config','notes/docs/agents.MD'],async address=>{
  const r=await f.run(['drive','get',address,'got.txt']);
  assert.equal(r.code,4,address);assert.equal(r.json().status,'skipped',address);
 });
 result=await f.run(['drive','get','AGENTS.md'],{CAVEMAN_DRIVE_TOKEN:token});
 assert.equal(result.code,4);assert.equal(result.stderr,`skipped  /AGENTS.md  ${reason}\n${single}\n`);
 assert.equal(f.seen.length,before,'nothing is asked of the server for a name that is skipped');
 for(const name of ['CLAUDE.md','AGENTS.md','got.txt'])assert.ok(!existsSync(join(f.home,name)),name);
 // --include-protected writes them, and says nothing more.
 result=await f.run(['drive','get','notes/docs/CLAUDE.md','--include-protected']);
 assert.equal(result.code,0,result.stdout);assert.equal(result.stderr,'');
 assert.equal(await readFile(join(f.home,'CLAUDE.md'),'utf8'),'content of /docs/CLAUDE.md');
 result=await f.run(['drive','get','notes/docs','all','--recursive','--include-protected']);
 assert.equal(result.code,0,result.stdout);assert.equal(result.stderr,'');
 assert.deepEqual([result.json().ok,result.json().status,result.json().skipped,result.json().files.map(x=>x.path)],[true,'downloaded',undefined,listed.filter(entry=>entry.kind==='file').map(entry=>entry.path)]);
 assert.equal(await readFile(join(f.home,'all','sub','.GIT','hooks','pre-commit'),'utf8'),'content of /docs/sub/.GIT/hooks/pre-commit');
 assert.equal(await readFile(join(f.home,'all','.cur\u017for','rules','always.mdc'),'utf8'),'content of /docs/.cur\u017for/rules/always.mdc');
 if(process.platform!=='win32')assert.ok((await stat(join(f.home,'all','sub','.GIT','hooks','pre-commit'))).mode&0o100);
 const refused=await f.run(['drive','ls','notes','--include-protected']);
 assert.equal(refused.code,2);assert.equal(refused.json().error.code,'cave_usage');
});

test('to a terminal: get PATH - writes a file\'s bytes only with --force, and cat shows what would steer it; a pipe gets both as they are',async t=>{
 const raw=Buffer.from('notes\u001b]0;owned\u0007\u001b[2K\r\nend\n'),text='one\u001b[31m\ttab\r\ntwo\u202e\u200b\u0085 \r3\n';
 const f=await fixture(t,{
  [`GET ${notes}/content`]:()=>[200,raw,{etag:'"3"'}],
  [`POST ${notes}/read`]:()=>[200,{path:'/a.md',version:3,size_bytes:Buffer.byteLength(text),line_count:2,offset:1,lines:2,content:text,truncated:false,next_offset:null,origin:'agent'}],
 });
 let result=await f.onTerminal(['get','notes/a.bin','-']);
 assert.equal(result.code,2);assert.equal(result.stdout,'');
 assert.equal(result.stderr,'failed   cave_terminal_output: A file\'s bytes are not written to a terminal as they are, where they could steer it: redirect stdout, name a local file, or use cvm drive cat for text (--force writes them here anyway).\n');
 assert.deepEqual(f.seen,[],'nothing is asked of the server');
 result=await f.onTerminal(['get','notes/a.bin','-','--force']);
 assert.equal(result.code,0,result.stderr);assert.deepEqual(result.bytes,raw);assert.equal(result.stderr,'');
 // Redirected or piped, the bytes go out as before and --force is not needed.
 result=await f.run(['drive','get','notes/a.bin','-']);
 assert.equal(result.code,0);assert.deepEqual(result.bytes,raw);
 // To a named file a terminal changes nothing.
 result=await f.onTerminal(['get','notes/a.bin','kept.bin']);
 assert.equal(result.code,0,result.stdout);assert.equal(result.stdout,`saved  kept.bin  ${raw.length} B  v3\n`);assert.deepEqual(await readFile(join(f.home,'kept.bin')),raw);
 // cat: a line end stays a line end and a tab a tab; the rest that would steer or hide is an escape.
 result=await f.onTerminal(['cat','notes/a.md']);
 assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'one\\x1b[31m\ttab\ntwo\\u202e\\u200b\\x85 \\r3\n');
 result=await f.run(['drive','cat','notes/a.md','--format','table']);
 assert.equal(result.stdout,text,'a pipe gets the text as it is');
 const refused=await f.run(['drive','cat','notes/a.md','--force']);
 assert.equal(refused.code,2);assert.equal(refused.json().error.code,'cave_usage');
});

test('a table shows a control or an invisible character as an escape, and a number that is not one as ?',async t=>{
 const f=await fixture(t,{
  [`GET ${notes}/files`]:()=>[200,{files:[
   file('/a\u001b[2J\u202e.md',{size_bytes:'7\r',tokens_est:'9',version:'3\u0007',origin:'per\u0000son',modified_at:'now\n#2'}),
   folder('/new\nline\ud83d\ude00\u{e0041}'),
   file('/b.md',{size_bytes:2**60,version:1.5,tokens_est:1000}),
  ],next_cursor:null}],
  [`GET ${notes}/verify`]:()=>[200,{ok:true,commits:'7\u001b[2J',head_seq:7.5}],
 });
 let result=await f.run(['drive','ls','notes','--format','table']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(result.stdout.split('\n').map(line=>line.split(/ {2,}/)),[
  ['NAME','SIZE','TOKENS','WRITER','VERSION','CHANGED'],
  ['a\\x1b[2J\\u202e.md','?','-','per\\x00son','v?','now #2'],
  ['new\\nline\ud83d\ude00\\u{e0041}/','-','-','agent','-','2026-11-18T09:00:00Z'],
  ['b.md','?','1,000','person','v?','2026-11-18T10:00:00Z'],
  [''],
 ]);
 result=await f.run(['drive','verify','notes','--format','table']);
 assert.equal(result.stdout,'ok  ? commits, head #?: every commit matches its hash\n');
 // JSON carries what the API sent, escaped as JSON escapes.
 result=await f.run(['drive','ls','notes']);
 assert.deepEqual(result.json().files.map(x=>[x.path,x.version]),[['/a\u001b[2J\u202e.md','3\u0007'],['/new\nline\ud83d\ude00\u{e0041}',undefined],['/b.md',1.5]]);
 assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/.test(result.stdout));
});

test('put sends each file as the plan saw it: one that grew is cut at the size planned, one that shrank or was replaced is refused and none of it sent',async t=>{
 const f=await fixture(t,{[`PUT ${notes}/content`]:async req=>{
  // The answer about the first file is held while the others change.
  if(req.query.path==='/in/a.md'){
   const up=join(f.home,'up');
   await writeFile(join(up,'b-grew.log'),'line\nand more of it\n');
   await writeFile(join(up,'c-shrank.txt'),'012\n');
   await writeFile(join(up,'another'),'another one\n');await rename(join(up,'another'),join(up,'d-replaced.txt'));
  }
  return written(req);
 }});
 await f.write('up/a.md','# a\n');await f.write('up/b-grew.log','line\n');await f.write('up/c-shrank.txt','0123456789\n');await f.write('up/d-replaced.txt','first file!\n');
 const result=await f.run(['drive','put','up','notes/in']);
 assert.equal(result.code,1,result.stdout);
 const out=result.json(),local=name=>join('up',name);
 assert.deepEqual([out.ok,out.status,out.sent.map(sent=>[sent.path,sent.size_bytes])],[false,'incomplete',[['/in/a.md',4],['/in/b-grew.log',5]]]);
 assert.deepEqual(out.refused,[
  {path:'/in/c-shrank.txt',local:local('c-shrank.txt'),code:'cave_local_changed',message:`${local('c-shrank.txt')} got shorter after the put was planned, so it was not sent: run the put again.`},
  {path:'/in/d-replaced.txt',local:local('d-replaced.txt'),code:'cave_local_changed',message:`${local('d-replaced.txt')} was replaced by another file after the put was planned, so it was not sent: run the put again.`},
 ]);
 assert.deepEqual(f.seen.map(r=>[r.query.path,r.headers['content-length'],r.raw.toString()]),[['/in/a.md','4','# a\n'],['/in/b-grew.log','5','line\n']],'no request carries a byte of a file that changed, nor a byte past a planned size');
});

test('get gives a file its name only when every byte is here: one made meanwhile stays without --overwrite, and no unfinished file is left',async t=>{
 let during=async()=>{};
 const f=await fixture(t,{
  [`GET ${notes}/files`]:()=>[200,{files:[file('/docs/a.md'),file('/docs/sub/b.md')],next_cursor:null}],
  [`GET ${notes}/content`]:async req=>{await during(req.query.path);return [200,Buffer.from('from the drive\n'),{etag:'"2"'}];},
 });
 const here=async()=>(await readdir(f.home,{recursive:true})).filter(name=>!name.startsWith('.caveman')).sort();
 during=()=>writeFile(join(f.home,'a.md'),'made meanwhile\n');
 let result=await f.run(['drive','get','notes/docs/a.md']);
 assert.equal(result.code,4,result.stdout);
 assert.deepEqual(result.json().error,{code:'cave_local_exists',message:'a.md was made here while it was being downloaded, and it was kept: pass --overwrite to replace it, or name another local file.'});
 assert.equal(await readFile(join(f.home,'a.md'),'utf8'),'made meanwhile\n');
 assert.deepEqual(await here(),['a.md']);
 result=await f.run(['drive','get','notes/docs/a.md','--overwrite']);
 assert.equal(result.code,0,result.stdout);assert.equal(await readFile(join(f.home,'a.md'),'utf8'),'from the drive\n');
 // In a folder too: the file made meanwhile stays, the one before it is whole, and nothing else is there.
 during=async path=>{if(path==='/docs/sub/b.md'){await mkdir(join(f.home,'docs','sub'),{recursive:true});await writeFile(join(f.home,'docs','sub','b.md'),'made meanwhile\n');}};
 result=await f.run(['drive','get','notes/docs','--recursive']);
 assert.equal(result.code,4,result.stdout);assert.equal(result.json().error.code,'cave_local_exists');
 assert.equal(await readFile(join(f.home,'docs','sub','b.md'),'utf8'),'made meanwhile\n');
 assert.deepEqual(await here(),['a.md','docs',join('docs','a.md'),join('docs','sub'),join('docs','sub','b.md')]);
 // A local folder that is not there is said before anything is asked of the server.
 const before=f.seen.length;
 result=await f.run(['drive','get','notes/docs/a.md',join('nowhere','a.md')]);
 assert.equal(result.code,1);assert.deepEqual(result.json().error,{code:'cave_local_write',message:`Could not write ${join('nowhere','a.md')}: there is no folder to put it in.`});
 assert.equal(f.seen.length,before);
});

test('get writes to a file of its own short name and leaves none behind when it is interrupted',async t=>{
 // A Cloud that sends the start of a file and then nothing.
 const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream','content-length':'1048576'});res.write(Buffer.alloc(65536,'x'));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await mkdtemp(join(tmpdir(),'cvm-drive-'));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const child=spawn(process.execPath,[bin,'drive','get','big.bin','--token',token,'--instance',`http://127.0.0.1:${server.address().port}`],{cwd:dir,env:{HOME:dir,USERPROFILE:dir,CAVEMAN_HOME:join(dir,'.caveman'),PATH:'/usr/bin:/bin',CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1'},stdio:'ignore'});
 const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
 let part;
 for(let tries=0;tries<400&&!part;tries++){
  part=(await readdir(dir)).find(name=>/^\.cvm-[0-9a-f]{12}\.part$/.test(name));
  if(!part)await new Promise(resolve=>setTimeout(resolve,50));
 }
 try{
  assert.ok(part,'the bytes go to a file of a short name of its own');
  assert.ok(!existsSync(join(dir,'big.bin')),'the name asked for is not there until every byte is');
 }finally{child.kill(process.platform==='win32'?undefined:'SIGINT');}
 const ended=await closed;
 // Windows ends a process outright: there is no interrupt for cvm to hear.
 if(process.platform!=='win32'){
  assert.equal(ended.signal,'SIGINT','the interrupt still ends cvm as an interrupt');
  assert.deepEqual(await readdir(dir),[],'nothing is left of the download');
 }
});

// ---- large files ----------------------------------------------------------------
const PART=8*1024*1024,RANGE=64*1024*1024,UPLOAD='00000000-0000-4000-8000-0000000000c1';
// A fake upload in parts of a file of size bytes: begin, each part in order
// (part n answers the upload moved on), and complete. fail(n) makes part n
// answer 503 while it says so.
function uploads(size,{base=notes,fail=()=>false,path='/big.bin'}={}){
 const parts=Math.ceil(size/PART),got=new Map();let next=0;
 const state=()=>({upload_id:UPLOAD,path,size,part_bytes:PART,parts,next_part:next,received_bytes:Math.min(next*PART,size),status:'open',expires_at:'2026-11-20T10:00:00Z'});
 const routes={
  [`POST ${base}/uploads`]:()=>{next=0;got.clear();return [201,state()];},
  [`GET ${base}/uploads/${UPLOAD}`]:()=>[200,state()],
  [`POST ${base}/uploads/${UPLOAD}/complete`]:()=>next===parts?[200,{file:file(path,{size_bytes:size,version:9}),unchanged:false}]:refusal(409,'cave_code_drive_upload_incomplete','Not every part has arrived.',{next_part:next,parts}),
 };
 for(let n=0;n<parts;n++)routes[`PUT ${base}/uploads/${UPLOAD}/parts/${n}`]=req=>{
  if(fail(n))return refusal(503,'cave_unavailable','Caveman Cloud is busy: try again.');
  if(n===next-1)return got.get(n).equals(req.raw)?[200,state()]:refusal(409,'cave_code_drive_part_differs',`Part ${n} already arrived with other bytes.`);
  if(n!==next)return refusal(409,'cave_code_drive_part_order','Not the next part.',{next_part:next,parts});
  got.set(n,req.raw);next++;return [200,state()];
 };
 return {routes,got,parts,at:()=>next,set:n=>{next=n;}};
}
const patterned=size=>{const b=Buffer.alloc(size);for(let i=0;i<size;i+=4093)b[i]=(i/4093)%251+1;return b;};

test('put: a file over 8 MiB goes in parts of 8 MiB, a part that fails on the way is sent again, and the upload completes as the write',async t=>{
 const big=patterned(2*PART+5);
 let failures=1;
 const up=uploads(big.length,{fail:n=>n===1&&failures-->0});
 const f=await fixture(t,up.routes);
 await f.write('big.bin',big);
 const result=await f.run(['drive','put','big.bin','notes/big.bin']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.find(r=>r.route===`${notes}/uploads`).body,{path:'/big.bin',size:big.length,if_absent:true});
 assert.deepEqual([...up.got].map(([n,raw])=>[n,raw.length]),[[0,PART],[1,PART],[2,5]]);
 assert.ok(Buffer.concat([...up.got.values()]).equals(big),'the parts are the file, in order');
 assert.equal(f.seen.filter(r=>r.route.endsWith('/parts/1')).length,2,'the part that failed was sent again');
 assert.ok(f.seen.every(r=>r.raw.length<=PART),'no request carries more than a part');
 assert.ok(!f.seen.some(r=>r.route===`${notes}/content`),'no single PUT of the file');
 assert.deepEqual(result.json().sent,[{path:'/big.bin',local:'big.bin',size_bytes:big.length,version:9,media_type:'text/markdown',unchanged:false}]);
 // A file of 8 MiB exactly is one PUT, as before.
 await f.write('eight.bin',Buffer.alloc(PART,1));
 const routes=f.seen.length;
 await f.run(['drive','put','eight.bin','notes/eight.bin']);
 assert.deepEqual(f.seen.slice(routes).map(r=>[r.method,r.route]),[['PUT',`${notes}/content`]]);
});

test('put: a part that keeps failing stops the put with its upload id; --resume checks the part before and goes on from there',async t=>{
 const big=patterned(2*PART+5);
 let failing=true;
 const up=uploads(big.length,{fail:n=>n===1&&failing});
 const f=await fixture(t,{...up.routes,[`PUT ${notes}/content`]:req=>written(req)});
 await f.write('big.bin',big);
 let result=await f.run(['drive','put','big.bin','notes/big.bin']);
 assert.equal(result.code,1,result.stdout);
 const out=result.json();
 assert.deepEqual([out.ok,out.status,out.sent,out.not_sent],[false,'failed',[],['big.bin']]);
 assert.deepEqual([out.error.code,out.error.upload_id,out.error.next_part,out.error.parts],['cave_unavailable',UPLOAD,1,3]);
 assert.equal(out.error.message,`Caveman Cloud is busy: try again. The upload stopped at part 1 of 3: cvm drive put big.bin notes/big.bin --resume ${UPLOAD} goes on from there, until 2026-11-20T10:00:00Z.`);
 assert.equal(f.seen.filter(r=>r.route.endsWith('/parts/1')).length,5,'five tries, then it stops');
 // Going on: the part before the next is sent again first, then the rest.
 failing=false;
 const before=f.seen.length;
 result=await f.run(['drive','put','big.bin','notes/big.bin','--resume',UPLOAD]);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.slice(before).map(r=>[r.method,r.route.slice(notes.length)]),[['GET',`/uploads/${UPLOAD}`],['PUT',`/uploads/${UPLOAD}/parts/0`],['PUT',`/uploads/${UPLOAD}/parts/1`],['PUT',`/uploads/${UPLOAD}/parts/2`],['POST',`/uploads/${UPLOAD}/complete`]]);
 assert.ok(Buffer.concat([...up.got.values()]).equals(big));
 // A local file that changed since is refused at the part the API checks.
 up.set(1);
 await f.write('big.bin',Buffer.concat([Buffer.from('changed'),big.subarray(7)]));
 result=await f.run(['drive','put','big.bin','notes/big.bin','--resume',UPLOAD]);
 assert.notEqual(result.code,0);assert.equal(result.json().refused[0].code,'cave_code_drive_part_differs');
 // Another file's size, a folder, stdin, a bad id: refused before anything is sent.
 await f.write('small.bin','abc');await f.write('dir/x','x');
 result=await f.run(['drive','put','small.bin','notes/big.bin','--resume',UPLOAD]);
 assert.equal(result.code,2);assert.equal(result.json().error.code,'cave_resume_mismatch');
 const sent=f.seen.length;
 await mapPool([['dir','notes/big.bin','--resume',UPLOAD],['-','notes/big.bin','--resume',UPLOAD],['big.bin','notes/big.bin','--resume','nope'],['big.bin','notes/big.bin','--resume',UPLOAD,'--dry-run']],async args=>{
  const r=await f.run(['drive','put',...args]);
  assert.equal(r.code,2,args.join(' '));
 });
 assert.equal(f.seen.length,sent);
});

test('put: a Cloud with no uploads takes a large file in one PUT; a share token sends its parts on the share mount',async t=>{
 const big=patterned(PART+1);
 const up=uploads(big.length,{base:share});
 // A Cloud from before uploads has no such route: a bare 404.
 const f=await fixture(t,{[`PUT ${notes}/content`]:req=>written(req),[`POST ${notes}/uploads`]:()=>[404,'404 page not found\n'],...up.routes});
 await f.write('big.bin',big);
 let result=await f.run(['drive','put','big.bin','notes/big.bin']);
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.map(r=>[r.method,r.route]),[['POST',`${notes}/uploads`],['PUT',`${notes}/content`]]);
 assert.ok(f.last().raw.equals(big));
 const before=f.seen.length;
 result=await f.run(['drive','put','big.bin','big.bin'],{CAVEMAN_DRIVE_TOKEN:token});
 assert.equal(result.code,0,result.stdout);
 assert.deepEqual(f.seen.slice(before).map(r=>[r.method,r.route,r.headers.authorization]),[['POST',`${share}/uploads`,`Bearer ${token}`],['PUT',`${share}/uploads/${UPLOAD}/parts/0`,`Bearer ${token}`],['PUT',`${share}/uploads/${UPLOAD}/parts/1`,`Bearer ${token}`],['POST',`${share}/uploads/${UPLOAD}/complete`,`Bearer ${token}`]]);
});

// A Cloud that answers ranges of version 5 of content (and of version 6,
// other, when asked), cutting a range short once when cut says so, and
// answering ranges after the first as version swap when it is set.
async function ranged(t,content,{cut=false,swap,other=Buffer.alloc(content.length,7)}={}){
 const seen=[];
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://x'),range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');
  seen.push({path:url.pathname,query:Object.fromEntries(url.searchParams),range:req.headers.range});
  const version=url.searchParams.get('version')??'5',body=version==='6'?other:content;
  if(!range){res.writeHead(200,{'content-type':'application/octet-stream','content-length':body.length,etag:`"${version}"`});res.end(body);return;}
  const start=Number(range[1]),end=Math.min(Number(range[2]),body.length-1);
  if(start>=body.length){res.writeHead(416,{'content-type':'application/json','content-range':`bytes */${body.length}`});res.end(JSON.stringify({error:{code:'cave_code_drive_range',message:'The byte range is outside the file.'}}));return;}
  const tag=start>0&&swap?swap:version;
  res.writeHead(206,{'content-type':'application/octet-stream','content-length':end-start+1,'content-range':`bytes ${start}-${end}/${body.length}`,etag:`"${tag}"`});
  if(cut&&start>0){cut=false;res.write(body.subarray(start,start+1000));setTimeout(()=>res.destroy(),50);return;}
  res.end(body.subarray(start,end+1));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await mkdtemp(join(tmpdir(),'cvm-drive-'));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const run=args=>limitSpawn(()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[bin,'drive',...args,'--token',token,'--instance',`http://127.0.0.1:${server.address().port}`],{cwd:dir,env:{HOME:dir,USERPROFILE:dir,CAVEMAN_HOME:join(dir,'.caveman'),PATH:'/usr/bin:/bin',CAVE_NO_KEYCHAIN:'1',CAVE_NO_BROWSER:'1'},stdio:['ignore','pipe','pipe']});
  const out=[];let stderr='';child.stdout.on('data',d=>out.push(d));child.stderr.on('data',d=>stderr+=d);
  child.on('error',reject);child.on('close',code=>{const bytes=Buffer.concat(out);resolve({code,bytes,stderr,json:()=>JSON.parse(bytes.toString('utf8'))});});
 }));
 return {seen,dir,run};
}

test('get: a file over 64 MiB comes in ranges of 64 MiB, all of the first answer\'s version, and a range cut short goes on from where it stopped',async t=>{
 const content=patterned(RANGE+3000);
 const s=await ranged(t,content,{cut:true});
 let result=await s.run(['get','/big.bin']);
 assert.equal(result.code,0,result.bytes.toString());
 assert.ok((await readFile(join(s.dir,'big.bin'))).equals(content),'the file is whole');
 assert.deepEqual(result.json().files,[{path:'/big.bin',local:'big.bin',size_bytes:content.length,version:5}]);
 assert.deepEqual(s.seen.map(r=>[r.query.version,r.range]),[[undefined,`bytes=0-${RANGE-1}`],['5',`bytes=${RANGE}-${RANGE+2999}`],['5',`bytes=${RANGE+1000}-${RANGE+2999}`]]);
 assert.deepEqual((await readdir(s.dir)).filter(name=>name.includes('.part')),[]);
 // --version pins every range to that version from the first.
 s.seen.length=0;
 result=await s.run(['get','/big.bin','older.bin','--version','6']);
 assert.equal(result.code,0);
 assert.ok((await readFile(join(s.dir,'older.bin'))).equals(Buffer.alloc(content.length,7)));
 assert.deepEqual(s.seen.map(r=>r.query.version),['6','6']);
 // To stdout, in ranges too.
 result=await s.run(['get','/big.bin','-']);
 assert.equal(result.code,0);assert.ok(result.bytes.equals(content));
});

test('get: a range of another version than the first is refused and leaves nothing; an empty file is fetched whole',async t=>{
 const content=patterned(RANGE+10);
 const s=await ranged(t,content,{swap:'6'});
 let result=await s.run(['get','/big.bin']);
 assert.equal(result.code,6,result.bytes.toString());
 assert.equal(result.json().error.code,'cave_invalid_response');
 assert.deepEqual(await readdir(s.dir),[],'no file and no unfinished file');
 const empty=await ranged(t,Buffer.alloc(0));
 result=await empty.run(['get','/empty.txt']);
 assert.equal(result.code,0,result.bytes.toString());
 assert.equal((await readFile(join(empty.dir,'empty.txt'))).length,0);
 assert.deepEqual(empty.seen.map(r=>r.range),['bytes=0-67108863',undefined]);
});

});

test('share names no instance on the hosted Cloud',async()=>{
 // No server is reached: the hosted address is only read back from the output.
 const {drive:run}=await import('../bin/drive.mjs');
 const written=[];const write=process.stdout.write;
 const fetch=async()=>new Response(JSON.stringify({token,grant:grant()}),{status:201,headers:{'content-type':'application/json'}});
 const original=globalThis.fetch;globalThis.fetch=fetch;process.stdout.write=chunk=>(written.push(String(chunk)),true);
 let code;
 try{code=await run(['share','notes','--read','--format','json'],{context:async()=>({baseURL:'https://api.caveman.so',token:secret}),instance:()=>'https://api.caveman.so'});}
 finally{process.stdout.write=write;globalThis.fetch=original;}
 assert.equal(code,0,written.join(''));
 const out=JSON.parse(written.join(''));
 assert.equal(out.use,`CAVEMAN_DRIVE_TOKEN=${token} cvm drive ls`);
 assert.equal(JSON.parse(out.mcp).mcpServers['caveman-drive'].url,'https://api.caveman.so/api/v1/code/share/mcp');
});
