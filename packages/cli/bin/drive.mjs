// `cvm drive`: a drive is a versioned file tree an organization shares with its
// agents. Each verb is a thin client of the /api/v1/code/drives routes, signed
// in as cvm always is, or of the /api/v1/code/share mount when a share token is
// given (--token, CAVEMAN_DRIVE_TOKEN). That mount takes no sign-in and names no
// drive: the token is one folder of one drive, and every path starts there.
// A share token is a secret. Only `share` prints one (the one it just made),
// nothing here writes one to disk, and no failure carries one. File bytes
// stream both ways, so no upload or download is held whole in memory.
// What a server, a drive or a local folder names is not trusted: it reaches a
// terminal only through show, and a local disk only through within and save.
import {constants,createWriteStream,existsSync,fstatSync,linkSync,lstatSync,mkdirSync,openSync,readdirSync,realpathSync,renameSync,statSync,unlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {open} from 'node:fs/promises';
import {request as plainRequest} from 'node:http';
import {request as tlsRequest} from 'node:https';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {CloudClient,CloudError,inertJSON} from '../dist/cloud-client.mjs';
import {formatOf} from './agent-build.mjs';
import {failure} from './deploy.mjs';

const NAME=/^[a-z0-9][a-z0-9-]{0,62}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,TOKEN=/^cdrv_[A-Za-z0-9_-]{16,512}$/;
const HOSTED='https://api.caveman.so',SHARE='/api/v1/code/share';
// A body of this size or more, or of no known size (stdin), waits for the
// server's 100 Continue (at most EXPECT_WAIT) before its bytes go, so a
// refused write costs no upload. IDLE is how long a transfer may send and
// receive nothing.
const EXPECT=256*1024,EXPECT_WAIT=1500,IDLE=120000;
const own=(code,message,exit)=>Object.assign(new CloudError(code,message,exit),{local:true});
const usage=message=>own('cave_usage',message,2);
const invalid=()=>own('cave_invalid_response','Caveman Cloud sent an answer cvm cannot use.',6);
const enc=encodeURIComponent;
// show is the one way anything a server or the local disk names reaches a
// table or a message. Text keeps what prints and nothing else: a control
// character (C0, DEL, C1), a formatting one (bidirectional and zero-width
// marks, tags), a lone surrogate and a line or paragraph separator each come
// out as a visible escape, \x1b for an ESC, so none steers the terminal or
// hides from whoever reads it. keep names the ones a caller lets through (a
// text's own line ends). A number prints when it is a safe integer, else ?.
// JSON output does not pass here: inertJSON escapes as JSON does.
const visible=ch=>{const n=ch.codePointAt(0);return ch==='\n'?'\\n':ch==='\r'?'\\r':ch==='\t'?'\\t':n<256?'\\x'+n.toString(16).padStart(2,'0'):n<65536?'\\u'+n.toString(16).padStart(4,'0'):`\\u{${n.toString(16)}}`;};
const show=(value,keep='')=>typeof value==='number'?(Number.isSafeInteger(value)?String(value):'?'):String(value??'').replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu,ch=>keep.includes(ch)?ch:visible(ch));
// num is a field the contract says is a number: anything else is a ?.
const num=value=>show(typeof value==='number'?value:NaN);
const one=text=>show(String(text??'').replace(/\s+/g,' ').trim());
const bytes=n=>!Number.isSafeInteger(n)||n<0?'?':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(n<10240?1:0)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
const count=(n,word,many=word+'s')=>`${Number.isSafeInteger(n)?n.toLocaleString('en-US'):'?'} ${n===1?word:many}`;
const access=g=>g?.read&&g?.write?'read and write':g?.read?'read':g?.write?'write':'nothing';
const segments=path=>String(path).split('/').filter(Boolean);
// Pads columns two spaces apart.
const table=rows=>{
 const widths=rows.reduce((w,row)=>row.map((cell,i)=>Math.max(w[i]??0,String(cell).length)),[]);
 return rows.map(row=>row.map((cell,i)=>i===row.length-1?String(cell):String(cell).padEnd(widths[i])).join('  ').trimEnd()).join('\n')+'\n';
};
const whole=(text,name,min=1,max=Number.MAX_SAFE_INTEGER)=>{
 const n=Number(text);
 if(!/^\d+$/.test(text)||!Number.isSafeInteger(n)||n<min||n>max)throw usage(`${name} is a whole number ${max===Number.MAX_SAFE_INTEGER?`of ${min} or more`:`from ${min} to ${max}`}.`);
 return n;
};
const TIME=/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const time=(text,name)=>{
 const at=new Date(String(text).replace(' ','T'));
 if(!TIME.test(text)||Number.isNaN(at.getTime()))throw usage(`${name} is a time such as 2026-11-18T14:30:00Z. A date alone is midnight UTC; a time with no zone is this machine's.`);
 return at.toISOString();
};

// ---- addresses --------------------------------------------------------------
// where reads DRIVE[/PATH]: the drive's name or id, then a path from its root.
// With a share token there is no drive and the whole address is a path in the
// shared folder. into says the address names a folder to put things in.
function where(text,shared){
 const raw=String(text??'');
 if(/[\x00-\x1f\x7f]/.test(raw))throw usage('An address holds no control characters.');
 if(shared)return {path:'/'+raw.replace(/^\/+|\/+$/g,''),into:raw===''||raw.endsWith('/')};
 const [,name,rest]=/^\/*([^/]*)\/?(.*)$/s.exec(raw);
 if(!NAME.test(name)&&!UUID.test(name))throw usage('An address is DRIVE or DRIVE/PATH: the drive\'s name (lowercase letters, digits and -) or its id, then a path inside it. List drives with cvm drive.');
 return {drive:name,path:'/'+rest.replace(/\/+$/,''),into:rest===''||rest.endsWith('/')};
}
const mount=w=>w.drive===undefined?SHARE:`/api/v1/code/drives/${enc(w.drive)}`;
const shown=(w,path=w.path)=>show(w.drive===undefined?path:w.drive+(path==='/'?'':path));
const query=params=>{
 const q=new URLSearchParams();
 for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==false&&value!=='')q.set(key,String(value));
 return q.size?'?'+q:'';
};

// ---- the wire ---------------------------------------------------------------
// JSON routes go through the Cloud client. A file's bytes go over node's own
// HTTP client: its timeout is an idle one, the body is a stream with a known
// length, and a refusal sent before the bytes are read is heard, not drowned
// by a broken pipe.
const statusExit=status=>status===401||status===403?3:status===409?4:status===429?7:status===422||status===400?2:1;
const network=()=>new CloudError('cave_network_error','',1);
// The headers are set on the request, not passed in its options: Node prints
// the options of each connection it opens when it is asked to trace them
// (NODE_DEBUG=net), and the bearer would be among them.
function wire(api,method,path,headers){
 if(!api.token)throw new CloudError('cave_auth_required','',3);
 const url=new URL(api.baseURL+path);
 const req=(url.protocol==='https:'?tlsRequest:plainRequest)(url,{method});
 for(const [name,value] of Object.entries({authorization:`Bearer ${api.token}`,...headers}))req.setHeader(name,value);
 req.setTimeout(IDLE,()=>req.destroy(new CloudError('cave_timeout','',6)));
 return req;
}
// answer reads a JSON answer of at most 1 MiB; a refusal becomes the error the
// Cloud client's own request throws (code, HTTP status, the envelope as details).
async function answer(res){
 const chunks=[];let size=0;
 try{for await(const chunk of res){size+=chunk.length;if(size>1<<20){res.destroy();throw new CloudError('cave_result_too_large','',6);}chunks.push(chunk);}}
 catch(error){throw error instanceof CloudError?error:network();}
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
 if(res.statusCode>=200&&res.statusCode<300){if(body===undefined||body===null)throw new CloudError('cave_invalid_response','',6);return body;}
 const error=body?.error??{};
 throw Object.assign(new CloudError(typeof error.code==='string'?error.code:'cave_request_failed',typeof error.message==='string'?error.message:'',statusExit(res.statusCode),body??{}),{httpStatus:res.statusCode});
}
// upload PUTs one file's bytes and answers the API's JSON. open makes the
// stream when the bytes are wanted: at once for a small body, after 100
// Continue for a large or unsized one. An answer that arrives first wins, and
// the bytes are then never sent.
function upload(api,path,{open,size,media}){
 return new Promise((done,fail)=>{
  const expect=size===undefined||size>=EXPECT;
  let req,body,timer,settled=false,answered=false;
  const settle=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);body?.destroy();fn(value);};
  try{req=wire(api,'PUT',path,{accept:'application/json',...(media?{'content-type':media}:{}),...(size===undefined?{}:{'content-length':String(size)}),...(expect?{expect:'100-continue'}:{})});}
  catch(error){fail(error);return;}
  const send=()=>{
   if(body||settled||answered)return;
   clearTimeout(timer);
   body=open();
   body.on('error',error=>{req.destroy();settle(fail,error?.local?error:own('cave_local_unreadable','The file could not be read.',1));});
   body.pipe(req);
  };
  req.on('error',error=>{if(!answered)settle(fail,error instanceof CloudError?error:network());});
  req.on('continue',send);
  req.on('response',res=>{
   answered=true;clearTimeout(timer);body?.unpipe(req);
   // A body cut short leaves a connection nothing else can use.
   answer(res).then(value=>settle(done,value),error=>settle(fail,error)).finally(()=>{if(!req.writableFinished)req.destroy();});
  });
  if(expect){req.flushHeaders();timer=setTimeout(send,EXPECT_WAIT);}else send();
 });
}
// download opens a file's bytes, or the range of them range names: the
// response to read them from, its version, its length and, for a range, the
// span the answer says it holds. A range past the end of an empty file
// answers empty and nothing to read.
async function download(api,path,range){
 const res=await new Promise((done,fail)=>{
  let req;try{req=wire(api,'GET',path,{accept:'application/octet-stream',...(range?{range}:{})});}catch(error){fail(error);return;}
  req.on('error',error=>fail(error instanceof CloudError?error:network()));
  req.on('response',done);
  req.end();
 });
 if(range&&res.statusCode===416){res.resume();return {empty:true};}
 if(res.statusCode!==200&&res.statusCode!==206){await answer(res);throw invalid();}
 const version=Number(/^"(\d+)"$/.exec(res.headers.etag??'')?.[1]),length=Number(res.headers['content-length']);
 let span;
 if(res.statusCode===206){
  const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers['content-range']??''),[start,end,total]=(m??[]).slice(1).map(Number);
  if(!m||![start,end,total].every(Number.isSafeInteger)||end<start||end>=total){res.destroy();throw invalid();}
  span={start,end,total};
 }
 return {res,span,version:Number.isSafeInteger(version)?version:undefined,length:res.headers['content-length']!==undefined&&Number.isSafeInteger(length)?length:undefined};
}
// Large files. Whatever stands in front of a Caveman Cloud (a proxy, an
// ingress) may end a request after a time or past a size, so no request
// carries more than one part of a file: PART bytes up (an upload in parts,
// above PART) and RANGE bytes down. A part or a range that fails on the way
// (the network, or an answer of 5xx or 429) is tried again, TRIES times in
// all, after a wait that doubles from WAIT.
const PART=8*1024*1024,RANGE=64*1024*1024,TRIES=5,WAIT=250;
const retryable=error=>!error?.local&&(['cave_network_error','cave_timeout'].includes(error?.code)||error?.httpStatus>=500||error?.httpStatus===429);
const pause=(error,attempt)=>delay(Math.max(WAIT*2**(attempt-1),Math.min(30,Number(error?.details?.error?.details?.retry_after_seconds??error?.details?.retry_after_seconds)||0)*1000));
async function tried(fn){
 for(let attempt=1;;attempt++){
  try{return await fn(attempt);}
  catch(error){if(attempt>=TRIES||!retryable(error))throw error;await pause(error,attempt);}
 }
}
// pinned is url naming version, unless it names one already.
const pinned=(url,version)=>{const u=new URL(url,'http://cvm.invalid');if(!u.searchParams.has('version'))u.searchParams.set('version',String(version));return u.pathname+u.search;};
// fetched reads the file at url into write, RANGE bytes a request. The first
// answer says the file's version (its ETag) and size (Content-Range); every
// range after it names that version, so the bytes are all one version's
// whatever is written meanwhile. A range that fails on the way is asked again
// from the byte it stopped at. An answer of the whole file (200, from a Cloud
// that ignored the range) is read as it is, and an empty file, which has no
// byte to range over, is asked for whole. A failure of write is never tried
// again. It answers the bytes read and the version.
async function fetched(api,url,write){
 let at=0,total,version,from=url,failures=0;
 for(;;){
  let d,writing=false;
  try{
   d=await download(api,from,`bytes=${at}-${at+(total===undefined?RANGE:Math.min(RANGE,total-at))-1}`);
   if(d.empty){
    if(total!==undefined)throw invalid();
    d=await download(api,from);
   }
   const span=d.span??{start:0,end:d.length===undefined?Infinity:d.length-1,total:d.length};
   if(!d.span&&total!==undefined||span.start!==at||total!==undefined&&(span.total!==total||d.version!==version))throw invalid();
   if(total===undefined&&d.span){
    if(d.version===undefined)throw invalid();
    total=span.total;version=d.version;from=pinned(url,version);
   }
   let got=0;
   for await(const chunk of d.res){
    got+=chunk.length;at+=chunk.length;
    if(got>span.end-span.start+1)throw invalid();
    writing=true;await write(chunk);writing=false;
   }
   if(!d.span){
    if(d.length!==undefined&&got!==d.length)throw network();
    return {size:got,version:d.version};
   }
   if(got!==span.end-span.start+1)throw network();
   failures=0;
   if(at>=total)return {size:total,version};
  }catch(raw){
   d?.res?.destroy();
   if(writing)throw raw;
   const error=raw instanceof CloudError?raw:network();
   // A whole file in one answer cannot be gone on with from where it stopped.
   if(d&&!d.span&&at>0||++failures>=TRIES||!retryable(error))throw error;
   await pause(error,failures);
  }
 }
}
// Every page of a listing: next_cursor is followed to the end, and one that
// comes back twice is an answer cvm cannot use.
async function listing(api,w,path,recursive){
 const files=[],seen=new Set();let cursor;
 for(;;){
  const page=await api.request(mount(w)+'/files'+query({path,recursive:recursive?true:undefined,limit:1000,cursor}));
  if(!Array.isArray(page?.files))throw invalid();
  for(const file of page.files){if(typeof file?.path!=='string')throw invalid();files.push(file);}
  cursor=page.next_cursor;
  if(cursor===null||cursor===undefined||cursor==='')return files;
  if(typeof cursor!=='string'||seen.has(cursor))throw invalid();
  seen.add(cursor);
 }
}

// ---- cvm drive, create, archive, verify ---------------------------------------
async function list(c){
 const {drives=[]}=await (await c.api()).request('/api/v1/code/drives');
 if(c.format!=='table')return c.print({drives});
 c.out(drives.length?table([['NAME','FILES','SIZE','CHANGED','DESCRIPTION'],...drives.map(d=>[one(d.name),d.totals?num(d.totals.files):'-',d.totals?bytes(d.totals.size_bytes):'-',one(d.updated_at),one(d.description)])]):'No drives yet. Make one with: cvm drive create NAME\n');
}
// With a share token, `cvm drive` says what the token opens.
async function info(c){
 const share=await (await c.api()).request(SHARE);
 if(c.format!=='table')return c.print(share);
 c.out(table([['share',`${access(share)} on one folder, until ${one(share.expires_at)}`],...(share.label?[['label',one(share.label)]]:[]),['try',share.read?'cvm drive ls':'cvm drive put FILE']]));
}
async function create(c){
 const [name]=c.args;
 if(!NAME.test(name))throw usage('A drive\'s name is 1 to 63 lowercase letters, digits or -, starting with a letter or digit.');
 const made=await (await c.api()).request('/api/v1/code/drives',{body:{name,...(c.values.description===undefined?{}:{description:c.values.description})}});
 if(c.format!=='table')return c.print(made);
 c.out(table([[made.created?'created':'exists',`${one(made.drive?.name)}  ${one(made.drive?.id)}${made.created?'':'  (nothing changed)'}`],['put',`cvm drive put ./FOLDER ${one(made.drive?.name)}`]]));
}
async function archive(c){
 const w=onlyDrive(c.args[0]);
 // Confirmed before anything is sent, a sign-in refresh included.
 if(!c.values.yes)throw own('cave_confirmation_required',`Archiving ${w.drive} ends it for everyone: it takes no more writes, its name is freed, and once its retention window has passed it is deleted for good. Repeat with --yes to confirm.`,2);
 const archived=await (await c.api()).request(mount(w)+'/archive',{body:{}});
 if(c.format!=='table')return c.print(archived);
 c.out(table([['archived',`${one(archived.name)}  ${one(archived.archived_at)}`],['deletes',`${one(archived.deletes_at)}, unless brought back first: cvm drive unarchive ${one(archived.id)}`]]));
}
// unarchive brings an archived drive back, by id: its name may be taken.
async function unarchive(c){
 const w=onlyDrive(c.args[0]);
 const back=await (await c.api()).request(mount(w)+'/unarchive',{body:{}});
 if(c.format!=='table')return c.print(back);
 c.out(table([['unarchived',`${one(back.name)}  ${one(back.id)}`]]));
}
// keep reads --keep: whole days, 90d or 90, from 1 to 3650.
const keep=text=>{
 const m=/^([0-9]{1,4})d?$/.exec(String(text??'').trim());
 const days=m?Number(m[1]):NaN;
 if(!(days>=1&&days<=3650))throw usage('--keep is how long old versions are kept, in days: 1d to 3650d, such as --keep 90d.');
 return days;
};
async function set(c){
 const w=onlyDrive(c.args[0]);
 const body={...(c.values.keep===undefined?{}:{retention_days:keep(c.values.keep)}),...(c.values.description===undefined?{}:{description:c.values.description})};
 if(!Object.keys(body).length)throw usage('Name what to change: --keep DAYS, --description TEXT, or both.');
 const changed=await (await c.api()).request(mount(w),{body,method:'PATCH'});
 if(c.format!=='table')return c.print(changed);
 c.out(table([['drive',`${one(changed.name)}  ${one(changed.id)}`],['keeps',`old versions ${count(changed.retention_days,'day')}${changed.deletes_at?`, deleted for good ${one(changed.deletes_at)}`:''}`],...(body.description===undefined?[]:[['about',one(changed.description)]])]));
}
// usage: what the organization's drives keep, and what that cost this month.
const gb=n=>!Number.isSafeInteger(n)||n<0?'?':`${(n/1e9).toFixed(n%1e9===0?0:1)} GB`;
const dollars=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?`$${n.toFixed(2)}`:'?';
async function storage(c){
 const u=await (await c.api()).request('/api/v1/code/drives/usage');
 if(c.format!=='table')return c.print(u);
 const month=u.month??{};
 const stored=u.billing&&Number.isSafeInteger(u.included_bytes)?`${gb(u.stored_bytes)} of ${gb(u.included_bytes)} included`:`${gb(u.stored_bytes)} of ${gb(u.ceiling_bytes)}`;
 c.out(table([['stored',stored],['month',`${one(month.gb_months)} GB-months, ${dollars(month.billed_usd)} charged${month.unpaid_usd>0?`, ${dollars(month.unpaid_usd)} unpaid`:''}`],['ceiling',`${gb(u.ceiling_bytes)} on this Caveman Cloud`],['billing',u.billing?'storage past the plan is paid from credits':'off: nothing is charged']]));
}
async function verify(c){
 const w=onlyDrive(c.args[0]);
 const checked=await (await c.api(120000)).request(mount(w)+'/verify');
 if(c.format!=='table')c.print(checked);
 else c.out(table([checked.ok?['ok',`${count(checked.commits,'commit')}, head #${num(checked.head_seq)}: every commit matches its hash`]:['broken',`commit #${num(checked.first_bad_seq)}: ${one(checked.reason)||'it does not match its hash'}`]]));
 return checked.ok?0:1;
}
// onlyDrive reads an address that names a drive and no path inside it.
function onlyDrive(text){
 const w=where(text,false);
 if(w.path!=='/')throw usage('Name the drive alone, without a path.');
 return w;
}

// ---- ls, cat, log, changes --------------------------------------------------------
async function ls(c){
 const w=where(c.args[0],c.shared);
 const files=await listing(await c.api(),w,w.path,c.values.recursive);
 if(c.format!=='table')return c.print({files,next_cursor:null});
 // A name is the path below the folder listed; a file's own listing is its name.
 const depth=segments(w.path).length;
 const name=f=>{const parts=segments(f.path);return show((parts.length>depth?parts.slice(depth):parts.slice(-1)).join('/'))+(f.kind==='folder'?'/':'');};
 c.out(files.length?table([['NAME','SIZE','TOKENS','WRITER','VERSION','CHANGED'],...files.map(f=>[name(f),f.kind==='folder'?'-':bytes(f.size_bytes??0),Number.isSafeInteger(f.tokens_est)?f.tokens_est.toLocaleString('en-US'):'-',one(f.origin)||'-',f.version?`v${num(f.version)}`:'-',one(f.modified_at)])]):`${shown(w)} is empty.\n`);
}
// The read route answers lines up to a byte cap and where to go on; cat
// follows it to the end of the file, or of --lines. A line longer than the cap
// comes cut to its first bytes: cat says which, and exits 6. A pipe gets the
// text as it is; a terminal gets it through show, its line ends kept.
async function cat(c){
 const w=where(c.args[0],c.shared);
 if(w.path==='/')throw usage(`Name a file. Use ${VERBS.cat.usage}.`);
 let offset=1,left=Infinity;
 if(c.values.lines!==undefined){
  const m=/^(\d+):(\d*)$/.exec(c.values.lines),from=m?Number(m[1]):0,to=m&&m[2]!==''?Number(m[2]):Infinity;
  if(!m||!Number.isSafeInteger(from)||from<1||to<from||to!==Infinity&&!Number.isSafeInteger(to))throw usage('--lines is FROM:TO, counting from 1, such as 10:40. 10: reads from line 10 to the end.');
  offset=from;left=to-from+1;
 }
 const version=c.values.version===undefined?undefined:whole(c.values.version,'--version');
 const text=c.format==='table';
 if(text)c.state.content=true;
 const api=await c.api();
 let first,content='',lines=0,next=null;const cut=[];
 for(;;){
  let page;
  try{page=await api.request(mount(w)+'/read',{body:{path:w.path,offset,...(left===Infinity?{}:{limit:left}),...(version?{version}:{})}});}
  catch(error){
   if(['cave_code_drive_not_text','cave_code_drive_text_too_large'].includes(error?.code))throw own(error.code,`${shown(w)} is ${error.code==='cave_code_drive_not_text'?'not text':'too large to print as text'}: get its bytes with cvm drive get ${shown(w)}.`,error.exitCode);
   throw error;
  }
  if(typeof page?.content!=='string'||!Number.isSafeInteger(page.lines)||page.lines<0)throw invalid();
  first??=page;
  const wasCut=page.truncated===true&&page.lines===1&&!page.content.endsWith('\n');
  if(wasCut)cut.push(offset);
  // A cut line gets its line end back, so the next line starts on its own.
  const piece=page.content+(wasCut?'\n':'');
  if(text)await c.bytes(process.stdout.isTTY?show(piece.replace(/\r\n/g,'\n'),'\n\t'):piece);else content+=piece;
  lines+=page.lines;left-=page.lines;next=page.next_offset??null;
  if(next===null||left<=0)break;
  if(!Number.isSafeInteger(next)||next<=offset)throw invalid();
  offset=next;
 }
 if(cut.length)c.note(`${cut.length===1?`Line ${cut[0]} is`:`Lines ${cut.join(', ')} are`} longer than one read carries and ${cut.length===1?'was':'were'} cut short: get the whole file with cvm drive get ${shown(w)}.`);
 if(!text)c.print({path:first.path,version:first.version,size_bytes:first.size_bytes,line_count:first.line_count,origin:first.origin,offset:first.offset,lines,content,truncated:cut.length>0,next_offset:next,...(cut.length?{cut_lines:cut}:{})});
 return cut.length?6:0;
}
async function log(c){
 const w=where(c.args[0],c.shared);
 if(w.path==='/')throw usage(`Name a file. Use ${VERBS.log.usage}.`);
 const api=await c.api();
 const versions=[];let before,path;
 for(;;){
  const page=await api.request(mount(w)+'/history'+query({path:w.path,limit:1000,before}));
  if(!Array.isArray(page?.versions))throw invalid();
  path??=page.path;versions.push(...page.versions);
  const next=page.next_before;
  if(next===null||next===undefined)break;
  if(!Number.isSafeInteger(next)||before!==undefined&&next>=before)throw invalid();
  before=next;
 }
 if(c.format!=='table')return c.print({path,versions,next_before:null});
 c.out(table([['VERSION','SIZE','WRITER','BY','WRITTEN',''],...versions.map(v=>[`v${num(v.version)}`,bytes(v.size_bytes??0),one(v.origin)||'-',[one(v.writer_type),one(v.writer_id)].filter(Boolean).join(' ')||'-',one(v.created_at),v.current?'current':''])]));
}
const opLine=op=>['  '+one(op.op),show(op.path)+(op.kind==='folder'?'/':''),op.op==='move'?`from ${show(op.from)}`:op.op==='put'?`v${num(op.version)}${typeof op.size_bytes==='number'?'  '+bytes(op.size_bytes):''}`:''];
// One page of the feed, oldest first, and the command that reads the next.
async function changes(c){
 const w=onlyDrive(c.args[0]);
 const after=c.values.after===undefined?undefined:whole(c.values.after,'--after',0),limit=c.values.limit===undefined?undefined:whole(c.values.limit,'--limit',1,1000);
 const page=await (await c.api()).request(mount(w)+'/changes'+query({after,limit}));
 if(!Array.isArray(page?.changes))throw invalid();
 // The line that reads on is built from numbers only: an agent may run it.
 const more=Number.isSafeInteger(page.next)&&Number.isSafeInteger(page.head_seq)&&page.next<page.head_seq?`cvm drive changes ${w.drive} --after ${page.next}`:null;
 if(c.format!=='table')return c.print({...page,...(more?{more}:{})});
 const rows=page.changes.flatMap(ch=>[[`#${num(ch.seq)}`,one(ch.created_at),[one(ch.origin),one(ch.writer_type)].filter(Boolean).join(', ')],...(ch.ops??[]).map(opLine),...(ch.truncated?[['  ...',`${count(ch.nodes_total,'file or folder','files and folders')} in all; the first ${(ch.ops??[]).length} shown`,'']]:[])]);
 c.out((rows.length?table(rows):'')+(more?`more     ${more}\n`:`${page.changes.length?'':'No changes after that. '}Caught up at #${num(page.head_seq)}.\n`));
}

// ---- names a machine acts on ----------------------------------------------------
// A tool runs or obeys these from the folder it finds them in: a git hook, an
// editor task, an agent's instructions, settings and MCP list. The two lists
// are a copy of the API's own (drivepath.Protected: its protectedFolders and
// protectedFiles), which refuses them to every writer that is not a person; a
// test holds this copy to that source. A folder's name counts at any depth, a
// file's name as the last name of a path.
export const PROTECTED={
 folders:['.caveman','.agents','.claude','.codex','.cursor','.gemini','.windsurf','.cline','.roo','.continue','.kiro','.amazonq','.opencode','.aider','.zed','.idea','.vscode','.devcontainer','.git','.github','.husky'],
 files:['AGENT.md','AGENTS.md','CLAUDE.md','GEMINI.md','SKILL.md','agent.json','.mcp.json','opencode.json','.cursorrules','.windsurfrules','.clinerules','.rules','.aider.conf.yml','.envrc'],
};
// fold is a name as a disk that keeps neither case nor normalisation apart
// (APFS, NTFS) compares it, so .GIT, .Git and .cursor spelled with a long s
// (U+017F) are each the name they would land on. What such a disk drops goes
// too: invisible characters, and the dots and spaces a name ends with.
const fold=name=>String(name).normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC').replace(/\p{Cf}/gu,'').replace(/[. ]+$/,'');
const lettersOf=name=>name.replace(/[^\p{L}\p{N}]/gu,'');
const keysOf=names=>({names:new Set(names.map(fold)),letters:names.map(name=>lettersOf(fold(name)))});
const FOLDERS=keysOf(PROTECTED.folders),FILES=keysOf(PROTECTED.files);
// The short name Windows keeps beside a long one opens the same file or
// folder: GIT~1 is .git. It is the first letters of the name, or two of them
// and four hex digits, then ~ and a number.
const named=(key,{names,letters})=>{
 if(names.has(key))return true;
 const stem=lettersOf(/^(.*?)~\d/.exec(key)?.[1]??'');
 return stem!==''&&letters.some(name=>name.startsWith(stem)||/^..[0-9a-f]{4}$/.test(stem)&&name.startsWith(stem.slice(0,2)));
};
export const protectedPath=path=>{const keys=segments(path).map(fold);return keys.some((key,i)=>named(key,FOLDERS)||i===keys.length-1&&named(key,FILES));};

// ---- get ----------------------------------------------------------------------
// A name a listing may give a local file: what a drive itself allows, so
// nothing a server sends is . or .., a separator, a device or a stream.
const unsafeName=name=>typeof name!=='string'||name===''||name==='.'||name==='..'||name.length>255||/[\/\\:*?"<>|\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)||/^ |[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9]) *(\.|$)/i.test(name);
const big={bigint:true},same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const stat=path=>{try{return lstatSync(path,big);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}};
// below walks from root down names before anything is asked of the server,
// and refuses a symbolic link or a file in the way.
function below(root,names){
 let path=root;
 for(const name of names){
  path=join(path,name);
  const st=stat(path);
  if(!st)return;
  if(st.isSymbolicLink())throw own('cave_local_unsafe',`${path} is a symbolic link, and cvm drive get writes through none. Nothing was written there.`,1);
  if(!st.isDirectory())throw own('cave_local_exists',`${path} is a file where a folder has to go.`,4);
 }
}
// A spot is a folder get writes in: root, the real path of a folder that was
// there when the command began and what it was then (device and inode), and
// names, the folders to go down from it.
const spotOf=(root,names=[])=>{const real=realpathSync(root);return {root:real,id:statSync(real,big),names};};
// within runs fn with the working directory moved into a spot: to root, then
// down names a folder at a time. A name is read where the walk stands, entered
// only when it is a folder and no link, and the folder entered has to be the
// one that was read. So whatever is swapped under LOCAL while a server holds
// its answer, fn works in a folder inside LOCAL or not at all; a path checked
// first and opened later gives no such thing. make creates the folders that
// are missing. Nothing is awaited in here, and the working directory is put
// back before within returns. target is the local path a failure names.
function within(spot,make,target,fn){
 const from=process.cwd();let path=spot.root;
 try{
  process.chdir(path);
  if(!same(statSync('.',big),spot.id))throw own('cave_local_unsafe',`${path} is not the folder it was when the download began. Nothing was written there.`,1);
  for(const name of spot.names){
   path=join(path,name);
   let st=stat(name);
   if(!st&&make){mkdirSync(name);st=stat(name);}
   if(!st)throw own('cave_local_write',`${path} was removed while the download ran.`,1);
   if(st.isSymbolicLink())throw own('cave_local_unsafe',`${path} is a symbolic link, and cvm drive get writes through none. Nothing was written there.`,1);
   if(!st.isDirectory())throw own('cave_local_exists',`${path} is a file where a folder has to go.`,4);
   process.chdir(name);
   if(!same(statSync('.',big),st))throw own('cave_local_unsafe',`${path} was replaced while the download ran. Nothing was written there.`,1);
  }
  return fn();
 }catch(error){throw error instanceof CloudError?error:own('cave_local_write',`Could not write ${target}.`,1);}
 finally{try{process.chdir(from);}catch{}}
}
const INTERRUPTS=['SIGINT','SIGTERM','SIGHUP'];
// save streams a file's bytes into a spot, as name. They go to a new file of
// a short name of its own there, and that file takes the name only when every
// byte arrived: by a link, which replaces nothing, or with overwrite by a
// rename, which replaces a file or a link and follows neither. The spot is
// walked to again for that step. A failure or an interrupt removes the file.
// The bytes come a range at a time (fetched), and the file is made when the
// first answer is in.
async function save(api,url,spot,name,{executable=false,overwrite=false,target}){
 const part=`.cvm-${randomBytes(6).toString('hex')}.part`;let made,out,failure;
 const drop=()=>{out?.destroy();if(!made)return;try{within(spot,false,target,()=>{if(same(lstatSync(part,big),made))unlinkSync(part);});}catch{}made=undefined;};
 const interrupted=signal=>{for(const each of INTERRUPTS)process.off(each,interrupted);drop();process.kill(process.pid,signal);};
 for(const each of INTERRUPTS)process.on(each,interrupted);
 const opened=()=>{
  if(out)return;
  const fd=within(spot,true,target,()=>{const fd=openSync(part,'wx',executable?0o777:0o666);made=fstatSync(fd,big);return fd;});
  out=createWriteStream('',{fd});out.on('error',error=>{failure??=error;});
 };
 const write=async chunk=>{
  opened();
  if(failure)throw failure;
  if(!out.write(chunk))await new Promise((done,fail)=>{const stop=()=>{out.off('drain',go);fail(failure);},go=()=>{out.off('error',stop);done();};out.once('drain',go);out.once('error',stop);});
 };
 let size,version;
 try{
  ({size,version}=await fetched(api,url,write));
  opened();
  out.end();await finished(out);
  if(failure)throw failure;
  within(spot,false,target,()=>{
   if(!same(lstatSync(part,big),made))throw own('cave_local_unsafe',`${target} was not written: the file its bytes went to was replaced while the download ran.`,1);
   if(overwrite)renameSync(part,name);
   else{
    try{linkSync(part,name);}
    catch(error){
     if(error.code==='EEXIST')throw own('cave_local_exists',`${target} was made here while it was being downloaded, and it was kept: pass --overwrite to replace it, or name another local file.`,4);
     if(['ENOTSUP','EOPNOTSUPP','ENOSYS','EPERM'].includes(error.code))throw own('cave_local_write',`${target} was not written: this disk makes no hard links, so a file could not be kept from being replaced. Pass --overwrite to write it here.`,1);
     throw error;
    }
    try{unlinkSync(part);}catch{}
   }
   made=undefined;
  });
 }catch(error){
  drop();
  if(error instanceof CloudError)throw error;
  throw ['ECONNRESET','ERR_STREAM_PREMATURE_CLOSE','EPIPE'].includes(error?.code)?network():own('cave_local_write',`Could not write ${target}.`,1);
 }finally{for(const each of INTERRUPTS)process.off(each,interrupted);}
 return {size,version};
}
async function get(c){
 const w=where(c.args[0],c.shared),[,local]=c.args;
 const version=c.values.version===undefined?undefined:whole(c.values.version,'--version');
 const content=path=>mount(w)+'/content'+query({path,version});
 if(local==='-'){
  if(c.values.recursive)throw usage('A folder does not fit on stdout: name a local folder for --recursive.');
  if(w.path==='/')throw usage(`Name a file. Use ${VERBS.get.usage}.`);
  c.state.content=true;
  if(process.stdout.isTTY&&!c.values.force)throw own('cave_terminal_output','A file\'s bytes are not written to a terminal as they are, where they could steer it: redirect stdout, name a local file, or use cvm drive cat for text (--force writes them here anyway).',2);
  try{await fetched(await c.api(),content(w.path),c.bytes);}catch(error){throw error instanceof CloudError?error:network();}
  return 0;
 }
 const api=await c.api();
 let files;
 if(c.values.recursive){
  if(version!==undefined)throw usage('--version is one file\'s: it does not go with --recursive.');
  files=await listing(api,w,w.path,true);
  const depth=segments(w.path).length;
  // The address was a file after all: its own listing is itself.
  if(files.length===1&&files[0].kind==='file'&&segments(files[0].path).length===depth)files=undefined;
 }
 const saved=[],skipped=[],overwrite=c.values.overwrite===true;
 // A protected name is not written unless asked for. Each one passed over is
 // said on stderr and counted in the answer, and the exit is then 4.
 const guarded=path=>c.values['include-protected']!==true&&protectedPath(path);
 const skip=(path,folder)=>{
  const reason='a name a tool runs or obeys from the folder it is in';
  skipped.push({path,reason});c.note(`skipped  ${shown(w,path)}${folder?'/':''}  ${reason}`);
 };
 const report=()=>{
  const total=saved.reduce((sum,f)=>sum+f.size_bytes,0),single=skipped.length===1;
  const hint=skipped.length?`${count(skipped.length,'path')} ${single?'was':'were'} not written: pass --include-protected to write ${single?'it':'them'}.`:undefined;
  if(c.format!=='table')c.print({schema_version:1,ok:!hint,status:hint?(saved.length?'incomplete':'skipped'):'downloaded',files:saved,bytes:total,...(hint?{skipped,hint}:{})});
  else if(saved.length>1)c.out(`${count(saved.length,'file')}, ${bytes(total)}\n`);
  if(hint)c.note(hint);
  return hint?4:0;
 };
 const row=f=>{saved.push(f);if(c.format==='table')c.out(`saved  ${show(f.local)}  ${bytes(f.size_bytes)}${f.version?`  v${num(f.version)}`:''}\n`);};
 if(!files){
  if(w.path==='/')throw usage(`Name a file, or add --recursive for everything in the drive. Use ${VERBS.get.usage}.`);
  if(guarded(w.path)){skip(w.path,false);return report();}
  let target=local??basename(w.path);
  if(stat(target)?.isDirectory())target=join(target,basename(w.path));
  const st=stat(target);
  if(st?.isSymbolicLink())throw own('cave_local_unsafe',`${target} is a symbolic link, and cvm drive get writes through none: name another local file.`,1);
  if(st&&!overwrite)throw own('cave_local_exists',`${target} already exists here: pass --overwrite to replace it, or name another local file.`,4);
  let spot;try{spot=spotOf(dirname(resolve(target)));}catch{throw own('cave_local_write',`Could not write ${target}: there is no folder to put it in.`,1);}
  let done;
  try{done=await save(api,content(w.path),spot,basename(resolve(target)),{overwrite,target});}
  catch(error){if(error?.code==='cave_code_drive_is_folder')throw own(error.code,`${shown(w)} is a folder: add --recursive to get everything in it.`,error.exitCode);throw error;}
  row({path:w.path,local:target,size_bytes:done.size,version:done.version});
  return report();
 }
 // Every local path below is built from names the server sent. Each is
 // checked before anything is written, and the folders again, from LOCAL
 // down, each time a file is opened and each time one takes its name.
 const base=local??(w.path==='/'?w.drive:basename(w.path));
 if(base===undefined)throw usage('Name the local folder to write the shared folder into: cvm drive get / LOCAL --recursive.');
 const rootStat=stat(base);
 if(rootStat&&!rootStat.isDirectory()&&!(rootStat.isSymbolicLink()&&stat(realpathSync(base))?.isDirectory()))throw own('cave_local_exists',`${base} is not a folder: name a local folder for --recursive.`,4);
 const root=rootStat?realpathSync(base):resolve(base),depth=segments(w.path).length,plan=[],taken=new Set(),exists=[],held=[];
 for(const file of files){
  const names=segments(file.path).slice(depth);
  const target=resolve(root,...names);
  if(!names.length||names.some(unsafeName)||!['file','folder'].includes(file.kind)||!target.startsWith(root+sep))
   throw own('cave_unsafe_listing','The listing names a path that would land outside the local folder, or that no drive can hold. Nothing was written.',1);
  const key=target.normalize('NFC').toLowerCase();
  if(taken.has(key))throw own('cave_unsafe_listing','The listing names the same local path twice. Nothing was written.',1);
  taken.add(key);
  // Protected by the path the listing gives it, or by the one it would have
  // under the folder asked for, which is where its names land.
  if(guarded(file.path)||guarded(`${w.path}/${names.join('/')}`)){held.push(file);continue;}
  if(rootStat)below(root,names.slice(0,-1));
  const st=rootStat?stat(target):undefined;
  if(st?.isSymbolicLink())throw own('cave_local_unsafe',`${target} is a symbolic link, and cvm drive get writes through none. Nothing was written.`,1);
  if(file.kind==='folder'){if(st&&!st.isDirectory())throw own('cave_local_exists',`${target} is a file where a folder has to go. Nothing was written.`,4);}
  else if(st?.isDirectory())throw own('cave_local_exists',`${target} is a folder where a file has to go. Nothing was written.`,4);
  else if(st)exists.push(join(base,...names));
  plan.push({file,names,local:join(base,...names)});
 }
 if(exists.length&&!overwrite)throw own('cave_local_exists',`${count(exists.length,'file')} already ${exists.length===1?'exists':'exist'} here (${exists.slice(0,3).join(', ')}${exists.length>3?', ...':''}): pass --overwrite to replace ${exists.length===1?'it':'them'}. Nothing was written.`,4);
 for(const file of held)skip(file.path,file.kind==='folder');
 // When every name was passed over, LOCAL is not made either.
 if(!plan.length&&held.length)return report();
 if(!rootStat)mkdirSync(root,{recursive:true});
 const spot=spotOf(root);
 for(const {file,names,local:at} of plan){
  if(file.kind==='folder'){within({...spot,names},true,at,()=>{});continue;}
  const done=await save(api,mount(w)+'/content'+query({path:file.path}),{...spot,names:names.slice(0,-1)},names.at(-1),{executable:file.executable===true&&process.platform!=='win32',overwrite,target:at});
  row({path:file.path,local:at,size_bytes:done.size,version:done.version});
 }
 if(c.format==='table'&&!saved.length&&!skipped.length)c.out(`${shown(w)} holds no files.\n`);
 return report();
}

// ---- put ----------------------------------------------------------------------
// The media type a file is sent as, by its extension. One this table does not
// know is sent with none, and the API labels it: plain text when it is UTF-8
// text, application/octet-stream when it is not.
const MEDIA={txt:'text/plain',text:'text/plain',log:'text/plain',md:'text/markdown',markdown:'text/markdown',json:'application/json',jsonl:'application/jsonl',ndjson:'application/x-ndjson',
 yaml:'application/yaml',yml:'application/yaml',toml:'application/toml',csv:'text/csv',tsv:'text/tab-separated-values',xml:'application/xml',html:'text/html',htm:'text/html',css:'text/css',
 js:'text/javascript',mjs:'text/javascript',cjs:'text/javascript',jsx:'text/jsx',ts:'text/typescript',tsx:'text/tsx',py:'text/x-python',go:'text/x-go',rs:'text/x-rust',rb:'text/x-ruby',java:'text/x-java',
 c:'text/x-c',h:'text/x-c',cc:'text/x-c++',cpp:'text/x-c++',hpp:'text/x-c++',cs:'text/x-csharp',swift:'text/x-swift',kt:'text/x-kotlin',php:'text/x-php',sh:'text/x-shellscript',bash:'text/x-shellscript',zsh:'text/x-shellscript',sql:'application/sql',
 png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',ico:'image/x-icon',bmp:'image/bmp',avif:'image/avif',
 pdf:'application/pdf',zip:'application/zip',gz:'application/gzip',tar:'application/x-tar',wasm:'application/wasm'};
export const mediaOf=path=>{const name=basename(String(path)),dot=name.lastIndexOf('.'),ext=name.slice(dot+1).toLowerCase();return dot>0&&Object.hasOwn(MEDIA,ext)?MEDIA[ext]:undefined;};
// sending reads a planned file for its upload: the file the plan saw, and the
// bytes the plan counted. It is opened without following a link at its name
// (and without waiting, were it swapped for a pipe), and what was opened has
// to be that same regular file (device and inode), so a file swapped for a
// link or for another file after the plan is not sent. One that grew is cut
// at the planned size, so no byte goes out past the declared length; one that
// shrank is not sent, and its request ends there.
const changedFile=(path,how)=>own('cave_local_changed',`${show(path)} ${how} after the put was planned, so it was not sent: run the put again.`,1);
async function opening(path,st){
 let handle;
 try{handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));}
 catch(error){throw ['ELOOP','EMLINK'].includes(error?.code)?changedFile(path,'became a symbolic link'):own('cave_local_unreadable','The file could not be read.',1);}
 try{
  const now=await handle.stat(big);
  if(!now.isFile()||!same(now,st))throw changedFile(path,'was replaced by another file');
  if(now.size<st.size)throw changedFile(path,'got shorter');
 }catch(error){await handle.close();throw error;}
 return handle;
}
async function* sending(path,st){
 const handle=await opening(path,st);
 try{
  for(let left=Number(st.size);left>0;){
   const want=Math.min(left,65536),{bytesRead,buffer}=await handle.read(Buffer.allocUnsafe(want),0,want,null);
   if(!bytesRead)throw changedFile(path,'got shorter');
   left-=bytesRead;yield buffer.subarray(0,bytesRead);
  }
 }finally{await handle.close();}
}
// pieces opens a planned file to be sent in parts, as sending opens it, and
// reads the part at a byte offset: exactly its planned bytes, so a file that
// grew is cut where the plan ended and one that shrank is refused.
async function pieces(path,st){
 const handle=await opening(path,st);
 return {close:()=>handle.close(),read:async(at,size)=>{
  const buffer=Buffer.allocUnsafe(size);
  for(let got=0;got<size;){const {bytesRead}=await handle.read(buffer,got,size-got,at+got);if(!bytesRead)throw changedFile(path,'got shorter');got+=bytesRead;}
  return buffer;
 }};
}
// A word for a command line: as it is when the shell leaves it alone, quoted when not.
const word=text=>/^[\w@%+=:,./-]+$/.test(text)?text:`'${String(text).replaceAll("'","'\\''")}'`;
const UPLOAD=up=>up&&typeof up==='object'&&typeof up.upload_id==='string'&&UUID.test(up.upload_id)&&up.part_bytes===PART&&[up.parts,up.next_part,up.size].every(Number.isSafeInteger)&&up.next_part>=0&&up.next_part<=up.parts;
// session sends one planned file of more than PART bytes as an upload in
// parts (the routes under uploads). The upload begins with the file's size and
// the write's condition, so whatever a PUT of the file would be refused before
// its bytes is refused before any part goes. Each part is sent, and tried
// again on the way (tried): a part the API took before its answer was lost is
// answered again. Completing answers as a PUT of the file would. With resume
// it goes on with an upload begun before, which must be of this file's size and
// address: the part before the next is sent again first, and the API refuses
// it if those bytes are not the ones it took. A part that fails for good says
// the upload and where it stopped, for --resume.
async function session(api,base,f,condition,resume,address){
 const handle=await pieces(f.local,f.st);
 let up;
 const send=async n=>{const bytes=await handle.read(n*PART,Math.min(PART,f.size-n*PART));return tried(()=>upload(api,`${base}/uploads/${enc(up.upload_id)}/parts/${n}`,{open:()=>Readable.from([bytes]),size:bytes.length}));};
 try{
  if(resume!==undefined){
   up=await tried(()=>api.request(`${base}/uploads/${enc(resume)}`));
   if(!UPLOAD(up))throw invalid();
   if(up.size!==f.size||up.path!==f.path)throw own('cave_resume_mismatch',`Upload ${resume} is of ${count(up.size,'byte')} to ${show(up.path)}, and this put is of ${count(f.size,'byte')} to ${show(f.path)}: resume it with the file and the address it began with.`,2);
   if(up.status==='open'&&up.next_part>0)await send(up.next_part-1);
  }else{
   up=await api.request(`${base}/uploads`,{body:{path:f.path,size:f.size,...condition,...(f.media?{media_type:f.media}:{}),...(f.executable?{executable:true}:{})}});
   if(!UPLOAD(up))throw invalid();
  }
  for(let n=up.next_part;n<up.parts;n++){
   try{const next=await send(n);if(!UPLOAD(next))throw invalid();up=next;}
   catch(error){
    if(error?.local||!(error instanceof CloudError))throw error;
    // Said as cvm says any failure, then where it stopped and how to go on.
    const said=failure(error,'The part');
    throw Object.assign(own(said.code,`${said.message} The upload stopped at part ${n} of ${up.parts}: cvm drive put ${word(f.local)} ${word(address)} --resume ${up.upload_id} goes on from there, until ${one(up.expires_at)}.`,said.exitCode),{resume:{upload_id:up.upload_id,next_part:n,parts:up.parts}});
   }
  }
  return await tried(()=>api.request(`${base}/uploads/${enc(up.upload_id)}/complete`,{body:{}}));
 }finally{await handle.close();}
}
// A code:run key is cave_live_...; any other signed-in credential is a person's.
const isKey=token=>/^cave_[a-z]+_/.test(String(token));
// What a put would send: regular files only, a folder's depth first and in
// name order, and everything it will not send with the reason.
function putPlan(local,w){
 const files=[],skipped=[];
 const file=(path,to,st)=>files.push({local:path,path:to,size:Number(st.size),st,media:mediaOf(to),executable:process.platform!=='win32'&&(st.mode&0o111n)!==0n,open:()=>Readable.from(sending(path,st),{objectMode:false})});
 const inside=name=>(w.path==='/'?'':w.path)+'/'+name;
 if(local==='-'){
  if(w.path==='/'||w.into)throw usage('From stdin, name the file to write: cvm drive put - DRIVE/PATH.');
  // stdin is read once: spent says a second try has nothing left to send.
  const piped={local:'-',path:w.path,size:undefined,media:mediaOf(w.path),executable:false,open:()=>{piped.spent=true;return process.stdin;}};
  files.push(piped);
  return {files,skipped};
 }
 let st;try{st=lstatSync(local,big);}catch{throw own('cave_local_not_found',`No file or folder at ${local}.`,2);}
 if(st.isSymbolicLink())throw usage(`${local} is a symbolic link, and cvm drive put follows none: name the file or folder it points to.`);
 if(st.isFile()){file(local,w.into?inside(basename(resolve(local))):w.path,st);return {files,skipped};}
 if(!st.isDirectory())throw usage(`${local} is not a regular file or a folder.`);
 const walk=(dir,to)=>{
  let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{skipped.push({local:dir,reason:'a folder that could not be read'});return;}
  if(!entries.length){skipped.push({local:dir,reason:'an empty folder: a drive keeps a folder for the files in it'});return;}
  for(const entry of entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
   const path=join(dir,entry.name),at=`${to}/${entry.name}`;
   if(entry.isSymbolicLink())skipped.push({local:path,reason:'a symbolic link, which is not followed'});
   else if(entry.isDirectory())walk(path,at);
   else if(!entry.isFile())skipped.push({local:path,reason:'not a regular file'});
   else{
    let s;try{s=lstatSync(path,big);}catch{skipped.push({local:path,reason:'a file that could not be read'});continue;}
    if(s.isFile())file(path,at,s);else skipped.push({local:path,reason:'not a regular file'});
   }
  }
 };
 walk(local,w.path==='/'?'':w.path);
 return {files,skipped,folder:true};
}
// A refusal about one file lets the rest go on; anything else (the sign-in, the
// drive, the network) would only repeat, so it ends the put.
const aboutOneFile=error=>error?.local?['cave_local_unreadable','cave_local_changed','cave_code_drive_exists','cave_code_drive_is_folder'].includes(error.code):[400,409,413].includes(error?.httpStatus)&&!['cave_code_drive_archived','cave_code_drive_full'].includes(error.code);
async function put(c){
 const [local,target]=c.args,w=where(target,c.shared),overwrite=c.values.overwrite===true,resume=c.values.resume;
 const plan=putPlan(local,w),to=mount(w)+'/content';
 if(resume!==undefined){
  if(!UUID.test(resume))throw usage('--resume takes the upload id a stopped put printed.');
  if(plan.folder||local==='-'||c.values['dry-run'])throw usage('--resume goes on with one file\'s upload: name the file and the address it was being put to, as the put that stopped did.');
 }
 const total=plan.files.reduce((sum,f)=>sum+(f.size??0),0);
 if(c.values['dry-run']){
  const condition=overwrite?'replaces what is there: overwrite=true when signed in as a person, else if_version from a listing made first (if_absent for a new file)':'if_absent=true: a file that is already there is refused';
  const would=plan.files.map(f=>({method:'PUT',path:to+query({path:f.path,if_absent:!overwrite,executable:f.executable}),local:f.local,bytes:f.size??null,media_type:f.media??null}));
  if(c.format!=='table')return c.print({schema_version:1,ok:true,status:'dry_run',...(w.drive===undefined?{}:{drive:w.drive}),condition,would_send:would,skipped:plan.skipped});
  c.out(`dry run  nothing sent. A put would send ${count(plan.files.length,'file')}${plan.files.some(f=>f.size===undefined)?'':` (${bytes(total)})`}:\n`
   +(plan.files.length?table(plan.files.map(f=>['  '+show(f.local),'->',show(f.path),f.size===undefined?'stdin':bytes(f.size),f.media??'labelled by the API'])):'')
   +plan.skipped.map(s=>`skipped  ${show(s.local)}: ${s.reason}\n`).join('')+`each     ${condition}\n`);
  return 0;
 }
 const api=await c.api(120000);
 // A person's overwrite is the API's switch. A key or a share token names
 // the version it replaces, read from a listing of the target made first.
 let keyed=c.shared||isKey(api.token),versions;
 const versionOf=async path=>{
  let files;try{files=await listing(api,w,path,false);}catch(error){if(error?.httpStatus===404)return undefined;throw error;}
  return files.length===1&&files[0].kind==='file'&&segments(files[0].path).length===segments(path).length&&Number.isSafeInteger(files[0].version)?files[0].version:undefined;
 };
 const readVersions=async()=>{
  versions=new Map();
  if(!plan.folder){for(const f of plan.files){const v=await versionOf(f.path);if(v!==undefined)versions.set(f.path,v);}return;}
  let files;try{files=await listing(api,w,w.path,true);}catch(error){if(error?.httpStatus===404)return;throw error;}
  for(const f of files)if(f.kind==='file'&&Number.isSafeInteger(f.version))versions.set(f.path,f.version);
 };
 if(overwrite&&keyed)await readVersions();
 const who=c.shared?'share token':'key';
 const address=f=>w.drive===undefined?f.path:w.drive+f.path;
 // A file over PART goes in parts; a Cloud older than uploads takes it in one PUT.
 const send=async(f,condition)=>{
  if(f.size!==undefined&&f.size>PART&&f.st){
   try{return await session(api,mount(w),f,condition,undefined,address(f));}
   catch(error){if(!([404,405].includes(error?.httpStatus)&&error?.code==='cave_request_failed'))throw error;}
  }
  return upload(api,to+query({path:f.path,...condition,executable:f.executable}),f);
 };
 const write=async f=>{
  if(resume!==undefined)return session(api,mount(w),f,undefined,resume,address(f));
  if(!overwrite)return send(f,{if_absent:true});
  if(!keyed){
   try{return await send(f,{overwrite:true});}
   catch(error){
    // The API says this credential is no person's: go on as a key does.
    if(error?.code!=='cave_code_drive_version_required'||f.spent)throw error;
    keyed=true;await readVersions();
   }
  }
  const known=versions.get(f.path);
  try{return await send(f,known===undefined?{if_absent:true}:{if_version:known});}
  catch(error){
   if(error?.code!=='cave_code_drive_exists'||known!==undefined)throw error;
   // It is there and the listing did not show it: read its version, or say why not.
   const now=await versionOf(f.path);
   if(now===undefined)throw own('cave_code_drive_exists',`${show(f.path)} already exists, and this ${who} may write here but not read: it cannot name the version it would replace, so it cannot overwrite. It can still add new files.`,4);
   if(f.spent)throw own('cave_code_drive_exists',`${show(f.path)} appeared while stdin was being sent: run the put again.`,4);
   return send(f,{if_version:now});
  }
 };
 const sent=[],refused=[];let stopped,exit=0;
 for(const f of plan.files){
  let done;
  try{done=await write(f);}
  catch(thrown){
   // One file aimed at a folder: say how to put it inside.
   const raw=thrown?.code==='cave_code_drive_is_folder'&&!plan.folder&&f.local!=='-'?own(thrown.code,`${shown(w)} is a folder: end the address with / to put ${basename(resolve(f.local))} inside it.`,thrown.exitCode):thrown;
   if(!aboutOneFile(raw)){
    stopped=Object.assign(c.failed(raw),{resume:raw?.resume});
    // Drives switched off is said on its own, as for every other verb.
    if(stopped.code==='cave_code_drives_off')throw raw;
    break;
   }
   const error=c.failed(raw);
   refused.push({path:f.path,local:f.local,code:error.code,message:error.message,...(raw?.resume??{})});exit||=error.exitCode;
   if(c.format==='table')c.out(`refused    ${show(f.path)}  ${show(error.code)}: ${show(error.message)}\n`);
   continue;
  }
  const file=done.file??{};
  sent.push({path:file.path??f.path,local:f.local,size_bytes:file.size_bytes??f.size??0,version:file.version,media_type:file.media_type,unchanged:done.unchanged===true});
  if(c.format==='table')c.out(`${done.unchanged?'unchanged':'sent     '}  ${show(file.path??f.path)}  ${bytes(file.size_bytes??f.size??0)}${file.version?`  v${num(file.version)}`:''}\n`);
 }
 const notSent=stopped?plan.files.slice(sent.length+refused.length).map(f=>f.local):[];
 const there=refused.filter(r=>r.code==='cave_code_drive_exists').length;
 const hint=there&&!overwrite?`${count(there,'file')} already ${there===1?'exists':'exist'} in the drive: repeat with --overwrite to replace ${there===1?'it':'them'}.`:undefined;
 if(c.format!=='table'){
  c.print({schema_version:1,ok:!stopped&&!refused.length,status:stopped?'failed':refused.length?(sent.length?'incomplete':'refused'):'uploaded',...(w.drive===undefined?{}:{drive:w.drive}),
   sent,refused,skipped:plan.skipped,...(stopped?{not_sent:notSent,error:{code:stopped.code,message:stopped.message,...(stopped.resume??{})}}:{}),...(hint?{hint}:{})});
  return stopped?stopped.exitCode:exit;
 }
 const changed=sent.filter(f=>!f.unchanged);
 c.out(plan.skipped.map(s=>`skipped    ${show(s.local)}  ${s.reason}\n`).join('')
  +[`${count(changed.length,'file')} sent (${bytes(changed.reduce((sum,f)=>sum+f.size_bytes,0))})`,sent.length-changed.length?`${sent.length-changed.length} unchanged`:'',refused.length?`${refused.length} refused`:'',plan.skipped.length?`${plan.skipped.length} skipped`:'',notSent.length?`${notSent.length} not sent`:''].filter(Boolean).join(', ')+'\n'
  +(hint?hint+'\n':''));
 if(stopped){c.out(`failed   ${show(stopped.code)}: ${show(stopped.message)}\n`);return stopped.exitCode;}
 return exit;
}

// ---- grep, mv, rm, restore ------------------------------------------------------
async function grep(c){
 const [pattern,target]=c.args,w=where(target,c.shared);
 if(pattern==='')throw usage('Give a pattern to search for.');
 const around=c.values.context===undefined?undefined:whole(c.values.context,'--context',0),limit=c.values.limit===undefined?undefined:whole(c.values.limit,'--limit',1,1000);
 const body={pattern,path:w.path,...(c.values.glob===undefined?{}:{glob:c.values.glob}),...(c.values['ignore-case']?{ignore_case:true}:{}),...(c.values.fixed?{literal:true}:{}),...(around?{before:around,after:around}:{}),...(limit===undefined?{}:{max_matches:limit})};
 const api=await c.api(60000);
 let found;
 // A busy answer names its own wait: three more tries, then it stands.
 for(let attempt=0;;attempt++){
  try{found=await api.request(mount(w)+'/grep',{body});break;}
  catch(error){
   if(error?.code!=='cave_code_drive_busy'||attempt>=3)throw error;
   await delay(Math.min(Math.max(Number(error.details?.retry_after_seconds)||2,1),5)*1000);
  }
 }
 if(!Array.isArray(found?.matches))throw invalid();
 if(c.format!=='table')return c.print(found);
 const {matches}=found,cover=found.coverage??{},lines=[];
 for(const [i,m] of matches.entries()){
  // A line keeps its indentation; what would break the screen is a space, what would steer it an escape.
  const path=show(m.path),before=m.before??[],after=m.after??[],at=Number.isSafeInteger(m.line)?m.line:NaN,line=text=>show(String(text??'').replace(/[\r\n]+/g,' '),'\t');
  if(i&&(before.length||after.length||(matches[i-1].after??[]).length))lines.push('--');
  before.forEach((text,j)=>lines.push(`${path}-${num(at-before.length+j)}- ${line(text)}`));
  lines.push(`${path}:${num(at)}: ${line(m.text)}`);
  after.forEach((text,j)=>lines.push(`${path}-${num(at+1+j)}- ${line(text)}`));
 }
 if(lines.length)c.out(lines.join('\n')+'\n');
 // What the search did not cover, so a search cut short never reads as a whole one.
 const searched=`${count(cover.files_searched??0,'file')} searched${typeof cover.bytes_scanned==='number'?` (${bytes(cover.bytes_scanned)})`:''}`;
 const cutShort=matches.filter(m=>m.cut).length,notes=[];
 if(cover.stopped==='matches')notes.push(`Stopped at ${count(matches.length,'match','matches')}, the limit: there may be more. Raise --limit (up to 1000), or narrow the path, --glob or the pattern.`);
 else if(cover.stopped==='bytes')notes.push(`Stopped at the most one search reads, with ${searched}: the files after the last match were not searched. Narrow the path or add --glob.`);
 else if(cover.stopped==='time')notes.push(`Stopped at the time one search gets, with ${searched}: the rest were not searched. Narrow the path, add --glob or simplify the pattern.`);
 else if(cover.stopped)notes.push(`Stopped early (${one(cover.stopped)}), with ${searched}: the rest were not searched.`);
 else if(!matches.length)notes.push(`No matches: ${searched}.`);
 if(cover.skipped_large>0)notes.push(`${count(cover.skipped_large,'file')} too large to search ${cover.skipped_large===1?'was':'were'} skipped.`);
 if(cover.long_lines>0)notes.push(`${count(cover.long_lines,'line')} too long to search ${cover.long_lines===1?'was':'were'} skipped.`);
 if(cutShort)notes.push(`${count(cutShort,'matching line')} ${cutShort===1?'is':'are'} shown cut to ${cutShort===1?'its':'their'} first bytes.`);
 if(notes.length&&cover.skipped_binary>0)notes.push(`${count(cover.skipped_binary,'file')} that ${cover.skipped_binary===1?'is':'are'} not text ${cover.skipped_binary===1?'was':'were'} not searched.`);
 for(const line of notes)c.note(line);
}
async function mv(c){
 const w=where(c.args[0],c.shared),to='/'+String(c.args[1]).replace(/^\/+|\/+$/g,'');
 if(w.path==='/'||to==='/'||/[\x00-\x1f\x7f]/.test(to))throw usage(`Name what moves and the path it moves to, in the same drive. Use ${VERBS.mv.usage}.`);
 const moved=await (await c.api()).request(mount(w)+'/move',{body:{from:w.path,to}});
 if(c.format!=='table')return c.print(moved);
 c.out(table([['moved',`${show(w.path)}  ->  ${show(moved.path)}${moved.kind==='folder'?'/':''}`]]));
}
async function rm(c){
 const w=where(c.args[0],c.shared);
 if(w.path==='/')throw usage(c.shared?'Name a file or a folder inside the shared folder.':'Name a file or a folder inside the drive. A whole drive is ended with cvm drive archive.');
 // Confirmed before anything is sent, a sign-in refresh included.
 if(!c.values.yes)throw own('cave_confirmation_required',`This deletes ${shown(w)}${c.values.recursive?' and everything in it':''} for everyone who reads the drive. Repeat with --yes to confirm.`,2);
 let gone;
 try{gone=await (await c.api()).request(mount(w)+'/delete',{body:{path:w.path,...(c.values.recursive?{recursive:true}:{})}});}
 catch(error){if(error?.code==='cave_code_drive_not_empty')throw own(error.code,`${shown(w)} is a folder with something in it: add --recursive to delete it and everything inside.`,error.exitCode);throw error;}
 if(c.format!=='table')return c.print(gone);
 c.out(table([['deleted',`${show(gone.path)}  ${count(gone.files??0,'file')}${gone.folders?`, ${count(gone.folders,'folder')}`:''}`]]));
}
async function restore(c){
 const w=where(c.args[0],c.shared),{version,to}=c.values;
 if((version===undefined)===(to===undefined))throw usage(`Name one of --version (a version of the file) or --to (a commit or a time to take the folder back to). Use ${VERBS.restore.usage}.`);
 let body;
 if(version!==undefined){
  if(w.path==='/')throw usage('--version restores one file: name it. A folder or the whole drive goes back with --to.');
  body={path:w.path,version:whole(version,'--version',0)};
 }else body=/^\d+$/.test(to)?{path:w.path,seq:whole(to,'--to',0)}:{path:w.path,at:time(to,'--to')};
 const back=await (await c.api(120000)).request(mount(w)+'/restore',{body});
 if(c.format!=='table')return c.print(back);
 if(version!==undefined)c.out(table([[back.unchanged?'unchanged':'restored',`${show(back.file?.path)}  ${back.unchanged?'already holds that content':`now v${num(back.file?.version)}, the content of ${Number(version)?`v${version}`:'its newest version'}`}`]]));
 else c.out(table([[back.unchanged?'unchanged':'restored',`${show(back.path)}  as it was after #${num(back.seq)}${back.unchanged?': nothing differed':`: ${count(back.restored??0,'file')} restored, ${num(back.removed??0)} removed, ${num(back.moved??0)} moved (now #${num(back.head_seq)})`}`]]));
}

// ---- share, grants, grant, revoke -----------------------------------------------
const span=text=>{
 const m=/^(\d{1,6})(s|m|h)$/.exec(String(text)),seconds=m?Number(m[1])*{s:1,m:60,h:3600}[m[2]]:0;
 if(seconds<300||seconds>43200)throw usage('--for is how long the share lasts, from 5m to 12h, such as 15m, 90m or 2h.');
 return seconds;
};
const gives=(values,what)=>{
 if(!values.read&&!values.write)throw usage(`Say what ${what} gives: --read, --write or both.`);
 return {read:values.read===true,write:values.write===true};
};
async function share(c){
 const w=where(c.args[0],false),give=gives(c.values,'the share');
 const ttl=c.values.for===undefined?undefined:span(c.values.for);
 const api=await c.api();
 const made=await api.request(mount(w)+'/shares',{body:{path:w.path,...give,...(ttl===undefined?{}:{ttl_seconds:ttl}),...(c.values.label===undefined?{}:{label:c.values.label})}});
 if(typeof made?.token!=='string'||!TOKEN.test(made.token))throw invalid();
 // The one place a share token is printed: the one this command just made.
 const use=`CAVEMAN_DRIVE_TOKEN=${made.token} cvm drive ls${api.baseURL===HOSTED?'':` --instance ${api.baseURL}`}`;
 const mcp=JSON.stringify({mcpServers:{'caveman-drive':{type:'http',url:`${api.baseURL}${SHARE}/mcp`,headers:{Authorization:`Bearer ${made.token}`}}}});
 if(c.format!=='table')return c.print({...made,use,mcp});
 const grant=made.grant??{};
 c.out(table([['token',made.token],['ends',one(grant.expires_at)],['gives',`${access(grant)} on ${shown(w,typeof grant.path==='string'?grant.path:w.path)}${grant.label?`  (${one(grant.label)})`:''}`],
  ['use',use],['mcp',mcp],['revoke',`cvm drive revoke ${w.drive} ${one(grant.id)}`]]));
}
const grantState=g=>g.revoked_at?'revoked':!g.live?'ended':g.path===null?'folder gone':'live';
async function grants(c){
 const w=onlyDrive(c.args[0]);
 const answer=await (await c.api()).request(mount(w)+'/grants');
 if(c.format!=='table')return c.print(answer);
 const all=answer.grants??[];
 c.out(all.length?table([['ID','FOR','GIVES','PATH','ENDS','STATE','LABEL'],...all.map(g=>[one(g.id),g.principal_type==='token'?'share token':`account ${one(g.service_account_id)}`,access(g),g.path===null?'-':show(g.path),g.expires_at?one(g.expires_at):'when revoked',grantState(g),one(g.label)])]):`No grants on ${w.drive}: only people of the organization, and the account that made it, reach it.\n`);
}
async function grant(c){
 const w=where(c.args[0],false),give=gives(c.values,'the grant');
 if(!UUID.test(c.values.to??''))throw usage('--to is the id of the service account to give access to.');
 const until=c.values.until===undefined?undefined:time(c.values.until,'--until');
 const made=await (await c.api()).request(mount(w)+'/grants',{body:{service_account_id:c.values.to,path:w.path,...give,...(until?{expires_at:until}:{})}});
 if(c.format!=='table')return c.print(made);
 c.out(table([['granted',`${access(made)} on ${shown(w,typeof made.path==='string'?made.path:w.path)} to account ${one(made.service_account_id)}, ${made.expires_at?`until ${one(made.expires_at)}`:'until revoked'}`],['revoke',`cvm drive revoke ${w.drive} ${one(made.id)}`]]));
}
async function revoke(c){
 const w=onlyDrive(c.args[0]),[,id]=c.args;
 if(!UUID.test(id))throw usage('Name the grant by its id: cvm drive grants DRIVE lists them.');
 const ended=await (await c.api()).request(`${mount(w)}/grants/${enc(id)}/revoke`,{body:{}});
 if(c.format!=='table')return c.print(ended);
 c.out(table([['revoked',`${one(ended.id)}  ${ended.principal_type==='token'?'share token':`account ${one(ended.service_account_id)}`}${ended.revoked_at?`  ${one(ended.revoked_at)}`:''}`]]));
}

// ---- fork, merge, diff, review, approve, reject, undo -----------------------------
const seqOf=(value,name)=>value===undefined?undefined:whole(value,name,0);
async function fork(c){
 const w=onlyDrive(c.args[0]),[,name]=c.args;
 if(!NAME.test(name??''))throw usage('A fork\'s name is a drive\'s name: 1 to 63 lowercase letters, digits or -, starting with a letter or digit.');
 const at=seqOf(c.values.at,'--at');
 const made=await (await c.api()).request(mount(w)+'/fork',{body:{name,...(at===undefined?{}:{seq:at})}});
 if(c.format!=='table')return c.print(made);
 c.out(table([['forked',`${one(made.name)}  ${one(made.id)}  from ${w.drive} as it was after #${num(made.parent_seq)}`],['merge',`cvm drive merge ${one(made.name)} --dry-run`]]));
}
const RESOLVED={parent_kept:'kept as it was',fork_copy_written:'kept, the other side written beside it',fork_restored:'brought back with the changes'};
const conflictRow=cf=>['  conflict',`${show(cf?.path)}  ${one(cf?.reason)}: ${Object.hasOwn(RESOLVED,cf?.resolution)?RESOLVED[cf.resolution]:one(cf?.resolution)}${cf?.copy_path?` (at ${show(cf.copy_path)})`:''}`];
// A merge with conflicts exits 4: what it wrote is in, and what it kept from
// the parent is listed for a person to settle.
async function merge(c){
 const w=onlyDrive(c.args[0]);
 const out=await (await c.api(120000)).request(mount(w)+'/merge',{body:c.values['dry-run']?{dry_run:true}:{}});
 if(!Array.isArray(out?.conflicts))throw invalid();
 const code=out.conflicts.length?4:0;
 if(c.format!=='table'){c.print(out);return code;}
 const head=out.unchanged?'nothing to bring in':out.dry_run?`would write one commit as ${one(out.origin)}`:`one commit as ${one(out.origin)}, the parent now at #${num(out.head_seq)}`;
 c.out(table([[out.dry_run?'dry run':out.unchanged?'unchanged':'merged',`${w.drive} into its parent from #${num(out.base_seq)} to #${num(out.fork_seq)}: ${head}`],
  ...(out.written??[]).map(p=>['  written',show(p)]),...(out.moved??[]).map(p=>['  moved',show(p)]),...(out.deleted??[]).map(p=>['  deleted',show(p)]),...out.conflicts.map(conflictRow)]));
 return code;
}
const version=v=>Number.isSafeInteger(v)?`v${v}`:'-';
// diffText prints a diff's files: a line for each, then its hunks as the API
// wrote them. show escapes what a terminal would act on; line ends stay.
function diffText(out){
 let text=`#${num(out.from)} -> #${num(out.to)}${out.path&&out.path!=='/'?`  under ${show(out.path)}`:''}\n`;
 if(!out.files.length)return text+'No changes.\n';
 for(const f of out.files){
  text+=`${one(f.op)}  ${show(f.path)}${f.kind==='folder'?'/':''}${f.from_path?`  from ${show(f.from_path)}`:''}  ${version(f.from_version)} -> ${version(f.to_version)}\n`;
  if(typeof f.diff==='string'&&f.diff)text+=f.diff;
  if(f.omitted)text+=`  (no line diff: ${one(f.omitted).replaceAll('_',' ')})\n`;
  if(f.truncated)text+='  (the diff is cut short)\n';
 }
 return text+(out.truncated?'The answer is cut short: diff a smaller folder or fewer commits.\n':'');
}
async function diff(c){
 const w=where(c.args[0],c.shared);
 const from=seqOf(c.values.from,'--from'),to=seqOf(c.values.to,'--to');
 const out=await (await c.api(120000)).request(mount(w)+'/diff'+query({from,to,path:w.path==='/'?undefined:w.path}));
 if(!Array.isArray(out?.files))throw invalid();
 if(c.format!=='table')return c.print(out);
 c.out(diffText(out));
}
const STATUS=['pending','approved','rejected'];
async function review(c){
 const w=onlyDrive(c.args[0]),[,id]=c.args;
 const api=await c.api(120000);
 if(id===undefined){
  const status=c.values.status??'pending';
  if(!STATUS.includes(status))throw usage('--status is pending, approved or rejected.');
  const {changesets}=await api.request(mount(w)+'/changesets'+query({status}));
  if(!Array.isArray(changesets))throw invalid();
  if(c.format!=='table')return c.print({changesets});
  c.out(changesets.length?table([['CHANGESET','SESSION','STATUS','COMMITS','HELD SINCE'],...changesets.map(cs=>[one(cs.id),one(cs.session_id),one(cs.status),num(cs.commits),one(cs.created_at)])])+`read    cvm drive review ${w.drive} CHANGESET\n`:`No ${status} changesets on ${w.drive}.\n`);
  return;
 }
 if(!UUID.test(id))throw usage('Name the changeset by its id: cvm drive review DRIVE lists them.');
 if(c.values.status!==undefined)throw usage('--status lists changesets: leave it out to read one.');
 const view=await api.request(`${mount(w)}/changesets/${enc(id)}`);
 if(!view?.changeset||!Array.isArray(view.diff?.files))throw invalid();
 if(c.format!=='table')return c.print(view);
 const cs=view.changeset;
 c.out(table([['changeset',`${one(cs.id)}  ${one(cs.status)}${cs.decided_at?` ${one(cs.decided_at)}`:''}`],['session',`${one(cs.session_id)}, ${count(cs.commits,'commit')}`],
  ...(cs.status==='pending'?[['approve',`cvm drive approve ${w.drive} ${one(cs.id)} --at ${num(view.diff.to)}`],['reject',`cvm drive reject ${w.drive} ${one(cs.id)} --yes`]]:[])])+diffText(view.diff));
}
// An approval goes in by the merge's rules and lists every conflict with
// what was done about it; --dry-run shows that and decides nothing. It
// approves the changeset's head the person read (--at, which review and
// --dry-run print), never what the session wrote after.
async function decide(c,verdict){
 const w=onlyDrive(c.args[0]),[,id]=c.args;
 if(!UUID.test(id??''))throw usage('Name the changeset by its id: cvm drive review DRIVE lists them.');
 // Confirmed before anything is sent, a sign-in refresh included.
 if(verdict==='reject'&&!c.values.yes)throw own('cave_confirmation_required',`Rejecting ends changeset ${id}: nothing of it reaches ${w.drive}, and its fork is archived. Repeat with --yes to confirm.`,2);
 const dry=c.values['dry-run']===true;
 let at=seqOf(c.values.at,'--at');
 if(verdict==='approve'&&at===undefined&&!dry)throw usage(`--at is the changeset's head you reviewed: cvm drive review ${w.drive} ${id} or --dry-run prints it.`);
 const api=await c.api(120000);
 if(verdict==='approve'&&at===undefined){
  const view=await api.request(`${mount(w)}/changesets/${enc(id)}`);
  if(!Number.isSafeInteger(view?.diff?.to))throw invalid();
  at=view.diff.to;
 }
 const body=verdict==='approve'?{fork_seq:at,...(dry?{dry_run:true}:{})}:{};
 const out=await api.request(`${mount(w)}/changesets/${enc(id)}/${verdict}`,{body});
 if(c.format!=='table')return c.print(out);
 const cs=out.changeset??{},m=out.merge;
 const did=m?.unchanged?'it changes nothing in the drive':`${count((m?.written??[]).length,'file')} written, ${num((m?.moved??[]).length)} moved, ${num((m?.deleted??[]).length)} deleted`;
 c.out(table([[dry?'dry run':one(cs.status),`changeset ${one(cs.id)} of session ${one(cs.session_id)}${dry?`: approving would write ${did}`:''}`],
  ...(m&&!dry?[['merged',`${did}${m.unchanged?'':`, the drive now at #${num(m.head_seq)}`}`]]:[]),...(m?.conflicts??[]).map(conflictRow),
  ...(dry?[['approve',`cvm drive approve ${w.drive} ${one(cs.id)} --at ${num(at)}`]]:[])]));
}
const approve=c=>decide(c,'approve'),reject=c=>decide(c,'reject');
async function undo(c){
 const w=onlyDrive(c.args[0]),session=c.values.session;
 if(!UUID.test(session??''))throw usage('--session is the id of the session whose writes to undo.');
 const out=await (await c.api(120000)).request(mount(w)+'/undo',{body:{session_id:session}});
 if(!Array.isArray(out?.skipped))throw invalid();
 if(c.format!=='table')return c.print(out);
 c.out(table([[out.unchanged?'unchanged':'undone',out.unchanged?`session ${one(session)} changed nothing that can go back`:`session ${one(session)} in one commit, ${w.drive} now at #${num(out.head_seq)}: ${num(out.restored)} restored, ${num(out.removed)} removed, ${num(out.moved)} moved back`],
  ...out.skipped.map(s=>['  left',`${show(s?.path)}  ${one(s?.reason).replaceAll('_',' ')}`])]));
}

// ---- mount (macOS / Windows / Linux zero-kext secure loopback WebDAV) ----------
function resolveMountBinary(){
 const envBin=process.env.CAVEMAN_DRIVE_MOUNT_BIN?.trim();
 if(envBin&&existsSync(envBin))return {cmd:envBin,prefix:[]};
 const ext=process.platform==='win32'?'.exe':'';
 // Never resolve from process.cwd() — a malicious repo could plant bin/caveman-drive-mount
 // and steal the token piped to stdin. Only trust the package-adjacent dist binary or PATH.
 const pkgBin=resolve(dirname(fileURLToPath(import.meta.url)),'../dist/caveman-drive-mount'+ext);
 if(existsSync(pkgBin))return {cmd:pkgBin,prefix:[]};
 return {cmd:'caveman-drive-mount'+ext,prefix:[]};
}

async function mountDrive(c){
 const w=where(c.args[0]??'',c.shared),[,mountpoint]=c.args;
 const api=await c.api();
 if(!api.token)throw new CloudError('cave_auth_required','',3);
 const {cmd,prefix}=resolveMountBinary();
 const args=[...prefix,'--token-stdin','--api-url',api.baseURL];
 if(w.drive!==undefined)args.push('--drive',w.drive);
 if(w.path&&w.path!=='/')args.push('--path',w.path);
 if(mountpoint)args.push('--mountpoint',mountpoint);
 if(c.values['read-write'])args.push('--read-write');
 if(c.values['include-protected'])args.push('--include-protected');
 if(c.values['webdav-only'])args.push('--webdav-only');
 if(c.values['volume-name'])args.push('--volume-name',c.values['volume-name']);
 if(c.format!=='table')args.push('--json');
 // Strip credential env vars from the child environment; pass token strictly on stdin.
 const env={...process.env};
 delete env.CAVE_TOKEN;
 delete env.CAVEMAN_DRIVE_TOKEN;
 const child=spawn(cmd,args,{env,stdio:['pipe','inherit','inherit'],shell:false});
 child.stdin.on('error',()=>{});
 child.stdin.end(api.token+'\n');
 const forward=sig=>{try{child.kill(sig);}catch{}};
 for(const sig of INTERRUPTS)process.on(sig,forward);
 try{
  return await new Promise((done,fail)=>{
   child.on('error',err=>{
    if(err?.code==='ENOENT')fail(own('cave_mount_binary_missing','caveman-drive-mount binary not found in PATH. Install it from a cloud-sdk checkout with: (cd drive-mount && go install ./cmd/caveman-drive-mount), or set CAVEMAN_DRIVE_MOUNT_BIN.',1));
    else fail(own('cave_mount_failed',`Could not start caveman-drive-mount: ${err.message}`,1));
   });
   child.on('exit',(code,signal)=>done(signal?130:(code??1)));
  });
 }finally{
  for(const sig of INTERRUPTS)process.off(sig,forward);
 }
}

// ---- the command ------------------------------------------------------------------
// flags: what a verb takes beyond --format, --help, --token and --instance.
// args: how many positionals, [least, most]; shared: the same with a share
// token, for the verbs one may use. cannot: what a token is told it cannot do.
const VERBS={
 list:{usage:'cvm drive [list]',summary:'The drives you can reach.',args:[0,0],run:list,cannot:'list drives'},
 create:{usage:'cvm drive create NAME [--description TEXT]',summary:'Make a drive. One of that name already there is answered as it is.',flags:['description'],args:[1,1],run:create,cannot:'create a drive'},
 ls:{usage:'cvm drive ls DRIVE[/PATH] [--recursive]',summary:'A folder\'s files and folders: size, estimated tokens, who wrote each, version, when it changed.',flags:['recursive'],args:[1,1],shared:[0,1],run:ls},
 cat:{usage:'cvm drive cat DRIVE/PATH [--version N] [--lines FROM:TO]',summary:'A text file to stdout, whole or some lines of it, now or at an earlier version.',flags:['version','lines'],args:[1,1],shared:[1,1],run:cat},
 get:{usage:'cvm drive get DRIVE/PATH [LOCAL] [--recursive] [--overwrite] [--version N] [--include-protected] [--force]',summary:'A file\'s bytes to a local file (- for stdout), or with --recursive a folder to a local folder. A file over 64 MiB comes in ranges of 64 MiB, all of the one version, each tried again when it fails on the way. An existing local file stays unless --overwrite. A name a tool runs or obeys from the folder it is in (.git, .envrc, .claude, .mcp.json, CLAUDE.md, AGENTS.md and the like) is skipped and listed on stderr, and the exit is 4, unless --include-protected. Symbolic links are never written through. To a terminal, - writes the bytes only with --force.',flags:['recursive','overwrite','version','include-protected','force'],args:[1,2],shared:[1,2],run:get},
 put:{usage:'cvm drive put LOCAL DRIVE/PATH [--overwrite] [--dry-run] [--resume UPLOAD_ID]',summary:'A local file (- for stdin) or a folder into a drive. A path that already holds a file is refused unless --overwrite. Symbolic links are never followed. A file over 8 MiB goes in parts of 8 MiB, each tried again when it fails on the way; a put that stops says its upload id, and --resume UPLOAD_ID with the same file and address goes on from there. --dry-run prints what would be sent and sends nothing.',flags:['overwrite','dry-run','resume'],args:[2,2],shared:[1,2],run:put},
 grep:{usage:'cvm drive grep PATTERN DRIVE[/PATH] [--glob G] [--ignore-case] [--fixed] [--context N] [--limit N]',summary:'Search the text files under a folder: path:line: text, and what the search did not cover.',flags:['glob','ignore-case','fixed','context','limit'],args:[2,2],shared:[1,2],run:grep},
 mv:{usage:'cvm drive mv DRIVE/FROM TO_PATH',summary:'Move or rename a file or a folder inside its drive.',args:[2,2],shared:[2,2],run:mv},
 rm:{usage:'cvm drive rm DRIVE/PATH [--recursive] --yes',summary:'Delete a file, or with --recursive a folder and everything in it. Needs --yes.',flags:['recursive','yes'],args:[1,1],shared:[1,1],run:rm},
 log:{usage:'cvm drive log DRIVE/PATH',summary:'A file\'s versions, newest first, and who wrote each.',args:[1,1],shared:[1,1],run:log},
 changes:{usage:'cvm drive changes DRIVE [--after SEQ] [--limit N]',summary:'The drive\'s commits after SEQ, oldest first: what each did to which path.',flags:['after','limit'],args:[1,1],run:changes,cannot:'read a drive\'s changes'},
 restore:{usage:'cvm drive restore DRIVE/PATH --version N | --to SEQ_OR_TIME',summary:'Give a file an earlier version\'s content again (--version), or take a folder back to how it was after a commit or at a time (--to). Either is one new commit.',flags:['version','to'],args:[1,1],run:restore,cannot:'restore'},
 share:{usage:'cvm drive share DRIVE[/PATH] --read | --write | --read --write [--for 15m] [--label TEXT]',summary:'Make a share token for a folder: read, write or both, for 5m to 12h (1h unless --for). Prints the token once, the cvm line that uses it and an MCP entry.',flags:['read','write','for','label'],args:[1,1],run:share,cannot:'make another share'},
 grants:{usage:'cvm drive grants DRIVE',summary:'Who was given what on the drive: share tokens and service accounts.',args:[1,1],run:grants,cannot:'list a drive\'s grants'},
 grant:{usage:'cvm drive grant DRIVE[/PATH] --to SERVICE_ACCOUNT_ID --read | --write [--until TIME]',summary:'Give a service account read, write or both on a folder, until a time or until revoked.',flags:['to','read','write','until'],args:[1,1],run:grant,cannot:'give a grant'},
 revoke:{usage:'cvm drive revoke DRIVE GRANT_ID',summary:'End a grant or a share token now.',args:[2,2],run:revoke,cannot:'revoke a grant'},
 verify:{usage:'cvm drive verify DRIVE',summary:'Recompute the drive\'s commit hashes and say whether its history is intact. Exit 1 when it is not.',args:[1,1],run:verify,cannot:'verify a drive'},
 archive:{usage:'cvm drive archive DRIVE --yes',summary:'End a drive: no more writes, and its name is freed. It is deleted for good once its retention window has passed; until then cvm drive unarchive brings it back. Needs --yes.',flags:['yes'],args:[1,1],run:archive,cannot:'archive a drive'},
 unarchive:{usage:'cvm drive unarchive DRIVE_ID',summary:'Bring an archived drive back, while its retention window lasts and its name is free.',args:[1,1],run:unarchive,cannot:'unarchive a drive'},
 set:{usage:'cvm drive set DRIVE [--keep 90d] [--description TEXT]',summary:'How long the drive keeps old versions and deleted files (and itself, once archived), 1d to 3650d; or its description.',flags:['keep','description'],args:[1,1],run:set,cannot:'change a drive'},
 usage:{usage:'cvm drive usage',summary:'What the organization\'s drives keep, every kept version counted, and this month\'s storage and charge.',args:[0,0],run:storage,cannot:'read drive storage'},
 fork:{usage:'cvm drive fork DRIVE NAME [--at SEQ]',summary:'Make a new drive that starts as DRIVE was after commit SEQ (its newest unless --at), sharing its content, to change apart and merge back.',flags:['at'],args:[2,2],run:fork,cannot:'fork a drive'},
 merge:{usage:'cvm drive merge FORK [--dry-run]',summary:'Bring what a fork changed into the drive it was made from, in one commit. Text both changed is merged line by line; what does not merge keeps the parent\'s side, writes the fork\'s beside it and is listed. Exit 4 when anything is listed. --dry-run writes nothing.',flags:['dry-run'],args:[1,1],run:merge,cannot:'merge a drive'},
 diff:{usage:'cvm drive diff DRIVE[/PATH] [--from SEQ] [--to SEQ]',summary:'What changed between two commits, file by file, with a unified diff for text. --from defaults to where a fork last agreed with its parent (0 for a drive that is not a fork), --to to the newest commit.',flags:['from','to'],args:[1,1],shared:[1,1],run:diff},
 review:{usage:'cvm drive review DRIVE [CHANGESET] [--status pending|approved|rejected]',summary:'Sessions\' writes held for review: the pending changesets, or one changeset as a diff.',flags:['status'],args:[1,2],run:review,cannot:'review changesets'},
 approve:{usage:'cvm drive approve DRIVE CHANGESET --at SEQ [--dry-run]',summary:'Put a changeset\'s writes into the drive as yours, by the merge\'s rules: where both changed a file the drive\'s side stays and the session\'s goes beside it, and a file you deleted that the session changed comes back. Every conflict is listed with what was done. --at is the changeset\'s head you reviewed, which review prints; a changeset the session wrote more to since is refused, to be reviewed again. --dry-run shows what approving does, at --at or the head now, and decides nothing.',flags:['dry-run','at'],args:[2,2],run:approve,cannot:'approve a changeset'},
 reject:{usage:'cvm drive reject DRIVE CHANGESET --yes',summary:'Drop a changeset: nothing of it reaches the drive. Needs --yes.',flags:['yes'],args:[2,2],run:reject,cannot:'reject a changeset'},
 undo:{usage:'cvm drive undo DRIVE --session ID',summary:'Take back what one session wrote to the drive, in one commit. What someone else changed since is left and listed.',flags:['session'],args:[1,1],run:undo,cannot:'undo a session'},
 mount:{usage:'cvm drive mount DRIVE[/PATH] [MOUNTPOINT] [--read-write] [--include-protected] [--webdav-only] [--volume-name NAME]',summary:'Mount a drive locally on macOS, Windows, or Linux over a hardened loopback WebDAV bridge (zero kexts, read-only and protected-path-hidden by default). On Linux, an explicit MOUNTPOINT requires mount.davfs/root; unprivileged GVFS assigns its own mount path.',flags:['read-write','include-protected','webdav-only','volume-name'],args:[1,2],shared:[0,2],run:mountDrive},
};
const text={type:'string'},flag={type:'boolean'};
const OPTIONS={resume:text,description:text,keep:text,recursive:{...flag,short:'r'},version:text,lines:text,overwrite:flag,'include-protected':flag,'read-write':flag,'webdav-only':flag,'volume-name':text,force:flag,'dry-run':flag,glob:text,'ignore-case':{...flag,short:'i'},fixed:{...flag,short:'F'},context:{...text,short:'C'},limit:text,
 yes:{...flag,short:'y'},after:text,to:text,read:flag,write:flag,for:text,label:text,until:text,at:text,from:text,status:text,session:text,token:text,instance:text,format:text,help:{...flag,short:'h'}};
const NOTES=[
 'An address is DRIVE[/PATH]: the drive\'s name or id, then a path inside it.',
 'With a share token (--token cdrv_..., or CAVEMAN_DRIVE_TOKEN) there is no drive and no sign-in: an address is a path in the shared folder, cvm drive alone says what the token opens, and ls, cat, get, put, grep, mv, rm, log and diff work. --instance URL, or CAVE_API_URL, names the Caveman Cloud when it is not the hosted one.',
 'Output is a table on a terminal and JSON when piped (--format json|table). cat --format table prints the text itself, and get PATH - writes the bytes to stdout: to a pipe or a file as they are, to a terminal only with --force.',
 'A table, a message and text printed to a terminal show a control or an invisible character as an escape (\\x1b), and a number that is not one as ?. JSON and piped text carry what the drive holds.',
];
function help(verb,format){
 if(verb)return inertJSON({usage:VERBS[verb].usage,summary:VERBS[verb].summary},format==='table'?2:undefined)+'\n';
 const usageLine='cvm drive [VERB] [ADDRESS] [flags] [--token cdrv_...] [--instance URL] [--format json|table]',summary='Drives: versioned file trees an organization shares with its agents.';
 if(format!=='table')return inertJSON({usage:usageLine,summary,commands:Object.entries(VERBS).map(([name,v])=>({verb:name,usage:v.usage,summary:v.summary})),notes:NOTES})+'\n';
 return `${summary}\n\n${Object.values(VERBS).map(v=>`  ${v.usage}\n      ${v.summary}`).join('\n')}\n\n${NOTES.join('\n')}\n`;
}

// OFF is what every drive route answers while an installation has drives
// switched off, and all cvm drive says then, on one line.
const OFF='Drives are off on this Caveman Cloud: an operator turns them on with the chart\'s code.drives.enabled.';
// failed is the one error cvm prints for anything thrown: the API's own
// refusal (code and message, terminal-inert), a fixed line otherwise, and
// never a share token, whoever put one in the message.
function failed(error,what,secret){
 let out=failure(error,what);
 // No error envelope on a 404: the routes are not there at all.
 if(!error?.local&&error?.httpStatus===404&&out.code==='cave_request_failed')out=new CloudError('cave_not_found','This Caveman Cloud serves no drives: they are switched off on this installation, or it is older than drives.',out.exitCode);
 // Drives switched off, as this release says it and as the one before said it.
 if(!error?.local&&error?.httpStatus===404&&(out.code==='cave_code_drives_off'||out.code==='cave_not_found'&&out.message==='Drives are not enabled on this installation.'))out=new CloudError('cave_code_drives_off',OFF,1);
 if(out.code==='cave_auth_required')out=new CloudError(out.code,'Run cvm login, or set CAVE_TOKEN. With a share token, set CAVEMAN_DRIVE_TOKEN.',out.exitCode);
 let message=out.message.replace(/cdrv_[A-Za-z0-9_-]+/g,'[share token]');
 if(secret)message=message.replaceAll(secret,'[share token]');
 return message===out.message?out:new CloudError(out.code,message,out.exitCode);
}

export async function drive(argv,{context,instance}){
 let format=process.stdout.isTTY?'table':'json';
 // content: stdout is the file itself, so a failure goes to stderr.
 const state={secret:undefined,content:false,what:'The drive request'};
 try{
  let parsed;
  try{parsed=parseArgs({args:argv,strict:true,allowPositionals:true,options:OPTIONS});}
  catch(error){throw usage(`${error.message} See cvm drive --help.`);}
  const {values}=parsed,[typed,...args]=parsed.positionals;
  format=formatOf(values);
  if(typed!==undefined&&!Object.hasOwn(VERBS,typed))throw usage(`Unknown drive command ${one(typed).slice(0,40)}. A drive's files are listed with cvm drive ls DRIVE. See cvm drive --help.`);
  if(values.help){process.stdout.write(help(typed,format));return 0;}
  const given=values.token??(process.env.CAVEMAN_DRIVE_TOKEN||undefined);
  if(given!==undefined){
   if(!TOKEN.test(given.trim()))throw usage('That is not a share token: one starts with cdrv_. Pass the one you were given with --token or CAVEMAN_DRIVE_TOKEN.');
   state.secret=given.trim();
  }
  const shared=state.secret!==undefined,verb=typed??'list',spec=VERBS[verb];
  state.what=`The drive ${typed??(shared?'request':'list')}`;
  for(const key of Object.keys(values))if(!['format','help','token','instance'].includes(key)&&!(spec.flags??[]).includes(key))throw usage(`--${key} is not for cvm drive ${verb}. Use ${spec.usage}.`);
  if(values.instance!==undefined&&!shared)throw usage('--instance goes with a share token. A signed-in cvm talks to the Caveman Cloud it signed in to: cvm login --instance URL.');
  const bare=shared&&typed===undefined;
  if(shared&&!bare&&!spec.shared)throw own('cave_share_token_scope',`A share token cannot ${spec.cannot}: that takes a signed-in cvm (cvm login, with CAVEMAN_DRIVE_TOKEN unset).`,2);
  const [least,most]=shared&&!bare?spec.shared:spec.args;
  if(args.length<least||args.length>most)throw usage(`Use ${spec.usage}${shared?' (with a share token, an address is a path in the shared folder)':''}.`);
  const api=async(timeout=30000)=>{
   if(!shared)return new CloudClient({...await context(),timeout});
   const baseURL=String(values.instance??instance()).replace(/\/+$/,'');
   try{new URL(baseURL);}catch{throw usage('--instance is the address of a Caveman Cloud, such as https://cloud.example.com.');}
   return new CloudClient({baseURL,token:state.secret,timeout});
  };
  const c={values,args,format,shared,state,api,
   // Every table and line goes out through show once more, whatever built it.
   out:chunk=>process.stdout.write(show(chunk,'\n\t')),
   print:value=>{process.stdout.write(inertJSON(value)+'\n');},
   note:line=>process.stderr.write(show(line)+'\n'),
   bytes:async chunk=>{if(!process.stdout.write(chunk))await once(process.stdout,'drain');},
   failed:error=>failed(error,state.what,state.secret)};
  return await (bare?info:spec.run)(c)??0;
 }catch(raw){
  const error=failed(raw,state.what,state.secret);
  (state.content?process.stderr:process.stdout).write(format!=='table'?inertJSON({schema_version:1,ok:false,status:'failed',error:{code:error.code,message:error.message}})+'\n':error.code==='cave_code_drives_off'?`${show(error.message)}\n`:`failed   ${show(error.code)}: ${show(error.message)}\n`);
  return error.exitCode;
 }
}
