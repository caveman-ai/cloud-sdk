import {createHash} from 'node:crypto';
import {CloudError} from './index.mjs';

export const OUTPUT_BYTES=12000;
export const outputSchema={type:'object',additionalProperties:false,properties:{
 pointer:{type:'string',maxLength:512,description:'JSON Pointer within data; empty selects all data.'},
 offset:{type:'integer',minimum:0},max_chars:{type:'integer',minimum:256,maximum:8000},
 sha256:{type:'string',pattern:'^[a-f0-9]{64}$',description:'Require the same selected data on subsequent pages.'},
}};
const digest=text=>createHash('sha256').update(text).digest('hex');
// What a missing pointer could have named instead: the keys (names only, never
// values) or the length where it stopped, so the next call can be right.
function shape(value){
 if(Array.isArray(value))return `an array of ${value.length} item${value.length===1?'':'s'} (/0 to /${Math.max(0,value.length-1)})`;
 if(value!==null&&typeof value==='object'){const keys=Object.keys(value);return keys.length?`keys ${keys.slice(0,16).map(key=>key.replaceAll('~','~0').replaceAll('/','~1')).join(', ')}${keys.length>16?`, and ${keys.length-16} more`:''}`:'no keys';}
 return `a ${value===null?'null':typeof value}, not an object or array`;
}
function select(value,pointer){
 if(pointer==='')return value;
 if(!pointer.startsWith('/')||/~(?![01])/u.test(pointer))throw new CloudError('cave_output_pointer_invalid','Use an RFC 6901 JSON Pointer within result data.',2);
 let at='';
 for(const part of pointer.slice(1).split('/')){
  const key=part.replaceAll('~1','/').replaceAll('~0','~');
  if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw new CloudError('cave_output_pointer_missing',`JSON Pointer does not exist in this result: ${at||'the result data'} has ${shape(value)}.`.slice(0,600),2);
  value=value[key];at+='/'+part;
 }
 return value;
}
export function boundedResult(result,output){
 const text=JSON.stringify(result);
 if(!output&&Buffer.byteLength(text)<=OUTPUT_BYTES)return result;
 const hasData=Object.hasOwn(result,'data');
 const pointer=output?.pointer??'';
 const selected=JSON.stringify(select(hasData?result.data:result,pointer));
 const sha256=digest(selected),offset=output?.offset??0;
 if(output?.sha256&&output.sha256!==sha256)throw new CloudError('cave_result_changed','Result changed between pages. Restart at offset 0; do not combine different snapshots.',4);
 if(offset>selected.length)throw new CloudError('cave_output_offset_invalid','Offset exceeds selected JSON length.',2);
 const envelope=hasData?Object.fromEntries(Object.entries(result).filter(([key])=>key!=='data')):{};
 let count=Math.min(output?.max_chars??4000,selected.length-offset);
 // Bound serialized bytes, including escaping; character counts are not tokens.
 while(true){
  const end=offset+count;
  const page={...envelope,page:{format:'json_fragment',pointer,sha256,offset,total_chars:selected.length,next_offset:end<selected.length?end:null,text:selected.slice(offset,end)}};
  if(Buffer.byteLength(JSON.stringify(page))<=OUTPUT_BYTES)return page;
  if(count===0)throw new CloudError('cave_result_too_large','Result metadata exceeds the MCP output limit.',6);
  count=Math.floor(count/2);
 }
}
// sql.query is never paged: each page would run the query again, scan again
// and maybe read newer rows. Rows past the output budget are dropped instead.
export function sqlResult(result){
 if(Buffer.byteLength(JSON.stringify(result))<=OUTPUT_BYTES)return result;
 const rows=result.data?.rows??[],n=rows.length;
 const fit=k=>{
  const out={...result,data:{...result.data,rows:rows.slice(0,k),truncated:true,notices:[...(result.data?.notices??[]),`${k} of ${n} rows shown; aggregate or select fewer columns.`]}};
  return Buffer.byteLength(JSON.stringify(out))<=OUTPUT_BYTES?out:null;
 };
 let best=fit(0),lo=0,hi=n-1;
 if(!best)throw new CloudError('cave_result_too_large','The SQL result has more columns and notices than one MCP output holds; select fewer columns.',6);
 while(lo<hi){const mid=(lo+hi+1)>>1,out=fit(mid);if(out){best=out;lo=mid;}else hi=mid-1;}
 return best;
}
// Text-only JSON is standard MCP content. No outputSchema is advertised, so
// duplicating every payload in structuredContent only increases client context.
export function completeToolResult(value){return {content:[{type:'text',text:JSON.stringify(value)}]};}
export function toolResult(value,output){return completeToolResult(value?.operation==='sql.query'?sqlResult(value):boundedResult(value,output));}
