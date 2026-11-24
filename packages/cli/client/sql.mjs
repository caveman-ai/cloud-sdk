import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {CloudError,inertJSON as json} from './index.mjs';

// cvm sql: one SELECT through sql.query, or --schema [table] through
// sql.schema. Output is the data, never the envelope; notices go to stderr.
export const sqlUsage='cvm sql "<SQL>" | -f FILE.sql | --stdin [--window 7d | --from T [--to T]] [--param name=value ...] [--format table|csv|json|jsonl] [--schema [TABLE]] [--project UUID]';

async function stdinText(){const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>64*1024)throw new CloudError('cave_input_too_large','SQL exceeds 64 KiB.',2);chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}

// A --param value takes the type of its {name:Type} placeholder in the SQL:
// integers stay decimal text so 64-bit values survive JSON, Float64 is a number,
// Array(String) is a JSON array, and every other type is the literal text.
// A name with no placeholder is JSON when it parses as a number, string or
// array, otherwise the literal text.
export function sqlParams(pairs=[],sql=''){
 const types=Object.fromEntries([...sql.matchAll(/\{\s*(\w+)\s*:\s*([^}]+?)\s*\}/g)].map(m=>[m[1],m[2].replace(/\s+/g,'')]));
 const params={};
 for(const pair of pairs){
  const at=pair.indexOf('=');const name=pair.slice(0,at);
  if(at<1)throw new CloudError('cave_usage','Use --param name=value.',2);
  if(Object.hasOwn(params,name))throw new CloudError('cave_usage',`Parameter ${name} is given twice.`,2);
  const raw=pair.slice(at+1),type=types[name];let value=raw;
  if(type==='Float64'){if(raw.trim()!==''&&Number.isFinite(Number(raw)))value=Number(raw);}
  else if(type==='Array(String)'||type===undefined){
   try{
    const parsed=JSON.parse(raw),exact=typeof parsed==='number'&&(Number.isSafeInteger(parsed)||!/^-?\d+$/.test(raw.trim()));
    if(Array.isArray(parsed)||(type===undefined&&(typeof parsed==='string'||exact)))value=parsed;
   }catch{}
  }
  params[name]=value;
 }
 return params;
}

const cell=v=>v===null||v===undefined?null:typeof v==='string'?v:JSON.stringify(v);
const numeric=type=>/^(Nullable\()?(U?Int|Float|Decimal)/.test(type??'');

// Cells and headers are untrusted text: control and format characters (escape
// sequences, bidi overrides) would reach the terminal, so tab, newlines and
// line separators become spaces and the rest U+FFFD.
const flat=v=>(v??'NULL').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu,c=>'\t\n\r\u2028\u2029'.includes(c)?' ':'\ufffd');
// Display columns per code point: combining marks take none, East Asian wide
// and emoji take two. ponytail: a range table, not full wcwidth.
const columns=c=>/\p{Mn}/u.test(c)?0:/[\u1100-\u115f\u2e80-\u303e\u3041-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(c)?2:1;
const width=s=>{let w=0;for(const c of s)w+=columns(c);return w;};
const clip=s=>{if(width(s)<=80)return s;let out='',w=0;for(const c of s){if(w+columns(c)>79)break;out+=c;w+=columns(c);}return out+'…';};

// grid renders an aligned table; numbers align right and long cells end in '…'.
export function grid(headers,rows,rightAligned=[]){
 const head=headers.map(flat),text=rows.map(row=>row.map(v=>clip(flat(v))));
 const widths=head.map((h,i)=>Math.max(width(h),...text.map(r=>width(r[i]))));
 const line=cells=>cells.map((c,i)=>{const pad=' '.repeat(widths[i]-width(c));return rightAligned[i]?pad+c:c+pad;}).join(' | ').trimEnd();
 return [line(head),widths.map(w=>'-'.repeat(w)).join('-+-'),...text.map(line)].join('\n')+'\n';
}


// A text cell starting with = + - @ tab or CR gets a leading ' so a spreadsheet
// reads it as text, not a formula; numeric columns stay as they are. Terminal
// controls and bidi overrides become U+FFFD; tab and newlines stay, quoted.
const csvField=(v,number)=>{if(v===null)return '';v=v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'\ufffd');if(!number&&/^[=+\-@\t\r]/.test(v))v="'"+v;return /[",\r\n]/.test(v)?'"'+v.replaceAll('"','""')+'"':v;};
export const csv=(headers,rows,numbers=[])=>[headers.map(h=>csvField(h,false)),...rows.map(r=>r.map((v,i)=>csvField(v,numbers[i])))].map(r=>r.join(',')).join('\r\n')+'\r\n';

// Money columns show their basis in the table header: spend (telemetry_list_price).
const header=c=>c.basis?.length?`${c.name} (${[...new Set(c.basis)].join(', ')})`:c.name;

export function renderQuery(data,format){
 const names=data.columns.map(c=>c.name),rows=data.rows.map(r=>r.map(cell));
 if(format==='json')return json(data)+'\n';
 if(format==='jsonl')return data.rows.map(r=>json(Object.fromEntries(names.map((n,i)=>[n,r[i]])))+'\n').join('');
 const numbers=data.columns.map(c=>numeric(c.type));
 if(format==='csv')return csv(names,rows,numbers);
 return grid(data.columns.map(header),rows,numbers);
}

export function renderSchema(data,format){
 if(format==='json')return json(data)+'\n';
 const table=data.columns!==undefined;
 const headers=table?['column','type','class','basis','description']:['table','grain','time_column','join_keys'];
 const rows=table?data.columns.map(c=>[c.name,c.type,c.class,c.basis??'',(c.untrusted?'[untrusted] ':'')+c.description]):data.tables.map(t=>[t.name,t.grain,t.time_column,t.join_keys.join(', ')]);
 if(format==='jsonl')return rows.map(r=>json(Object.fromEntries(headers.map((h,i)=>[h,r[i]])))+'\n').join('');
 if(format==='csv')return csv(headers,rows);
 let out=grid(headers,rows);
 if(table&&data.hidden.length)out+='\nhidden: '+data.hidden.map(h=>`${h.name} (needs ${h.requires})`).join(', ')+'\n';
 if(!table){
  const {window:w,limits:l,notes,unsupported}=data.rules;
  out+=`\nwindow: ${w.form} (default ${w.default}, max ${w.max})\nlimits: ${l.default_rows} rows by default, at most ${l.max_rows} rows and ${l.max_result_bytes} bytes\n`;
  out+='\nrules:\n'+notes.map(n=>'  '+n).join('\n')+'\n\n'+unsupported.split('\n').map(n=>'  '+n).join('\n')+'\n\nexamples:\n'+data.examples.map(e=>'  '+e).join('\n')+'\n';
 }
 return out;
}

export async function sqlCommand(args,{connect,format:defaultFormat}){
 const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{file:{type:'string',short:'f'},stdin:{type:'boolean'},window:{type:'string'},from:{type:'string'},to:{type:'string'},param:{type:'string',multiple:true},format:{type:'string'},schema:{type:'boolean'},project:{type:'string'},timeout:{type:'string'},help:{type:'boolean',short:'h'}}});
 if(values.help){process.stdout.write(sqlUsage+'\n');return 0;}
 const format=values.format??defaultFormat;
 if(!['table','csv','json','jsonl'].includes(format))throw new CloudError('cave_usage','Format must be table, csv, json or jsonl.',2);
 const client=await connect({projectId:values.project,timeout:Number(values.timeout??60000)});
 if(values.schema){
  if(positionals.length>1||values.file||values.stdin||values.param||values.window||values.from||values.to)throw new CloudError('cave_usage','Use --schema [TABLE] alone.',2);
  const result=await client.execute('sql.schema',positionals.length?{table:positionals[0]}:{});
  process.stdout.write(renderSchema(result.data,format));
  return 0;
 }
 if([positionals.length>0,!!values.file,!!values.stdin].filter(Boolean).length!==1||positionals.length>1)throw new CloudError('cave_usage',`Give the SQL once: ${sqlUsage}`,2);
 const sql=positionals[0]??(values.file?await readFile(values.file,'utf8'):await stdinText());
 const input={sql};
 if(values.param)input.params=sqlParams(values.param,sql);
 for(const key of ['window','from','to'])if(values[key]!==undefined)input[key]=values[key];
 const {data}=await client.execute('sql.query',input);
 process.stdout.write(renderQuery(data,format));
 if(format!=='json'){
  process.stderr.write(`${data.row_count} row${data.row_count===1?'':'s'} · ${data.window.from} to ${data.window.to} · ${data.elapsed_ms} ms · digest ${data.query_digest.slice(0,12)}\n`);
  for(const notice of data.notices)process.stderr.write(`note: ${notice}\n`);
 }
 return 0;
}
