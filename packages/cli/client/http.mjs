import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {CloudClient,CloudError} from './index.mjs';
import {createCloudMCP} from './mcp.mjs';
import {discoveryGrants,grantDiscovery} from './mcp-catalog.mjs';

const maxBody=1024*1024;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
function error(status,code,message,extra={}){return Response.json({error:{code,message}},{status,headers:{...headers,...extra}});}

function privateControlService(baseURL){
 const url=new URL(baseURL);
 // Only the service names emitted by Compose and the shared Helm chart.
 // This is server configuration; no request field can choose an upstream.
 return url.protocol==='http:'&&url.port==='8080'&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash&&
  (url.hostname==='control-api'||/^caveman-control-api\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.svc$/.test(url.hostname));
}

// One SDK server per HTTP request: no session affinity, token cache, filesystem
// context, or cross-tenant mutable transport. Control API remains RBAC authority.
export function createCloudHTTPHandler({baseURL,publicURL,fetch:transport=globalThis.fetch}){
 const origin=new URL(publicURL);
 if(origin.pathname!=='/mcp'||origin.search||origin.hash||origin.username||origin.password||origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new Error('MCP publicURL must be an HTTPS /mcp URL or loopback HTTP.');
 const allowPlainHTTP=privateControlService(baseURL);
 new CloudClient({baseURL,token:'configuration-validation',allowPlainHTTP});
 const challenge=`Bearer resource_metadata="${origin.origin}/.well-known/oauth-protected-resource/mcp", scope="org:read trace:read_metadata settings:read artifact:read_metadata payload:read trace:read_payload eval:write scenario:read scenario:write experiment:run opportunity:write dashboard:write setup:write inbox:read prompt:read"`;
 return async function handle(request){
  const url=new URL(request.url);
  if(url.pathname!=='/mcp'||url.search)return error(400,'cave_mcp_url_invalid','Use /mcp without query parameters. Credentials belong in Authorization.');
  // Origin is validated against deployment configuration, never forwarded Host.
  const requestOrigin=request.headers.get('origin');
  if(requestOrigin&&requestOrigin!==origin.origin)return error(403,'cave_mcp_origin_forbidden','Origin is not allowed.');
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,allow:'POST, OPTIONS','access-control-allow-origin':origin.origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'authorization, content-type, mcp-protocol-version','access-control-expose-headers':'www-authenticate'}});
  if(request.method!=='POST')return error(405,'cave_mcp_method_not_allowed','Use Streamable HTTP POST; this endpoint has no persistent SSE session.',{allow:'POST, OPTIONS'});
  const authorization=request.headers.get('authorization')??'';
  if(!/^Bearer cmcp_[A-Za-z0-9_-]+$/i.test(authorization)||authorization.length>8192)return error(401,'cave_auth_required','Authorize this MCP resource with a registered client. Connect instructions: /mcp/connect.',{'www-authenticate':challenge});
  if(request.headers.has('mcp-session-id'))return error(400,'cave_mcp_session_unsupported','This endpoint is stateless; omit MCP-Session-Id.');
  if(!(request.headers.get('content-type')??'').toLowerCase().startsWith('application/json'))return error(415,'cave_mcp_content_type','Content-Type must be application/json.');
  if(Number(request.headers.get('content-length'))>maxBody)return error(413,'cave_mcp_input_too_large','MCP request exceeds 1 MiB.');
  let server;
  try{
   const chunks=[];let bytes=0;const reader=request.body?.getReader();
   if(reader){try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBody){await reader.cancel();return error(413,'cave_mcp_input_too_large','MCP request exceeds 1 MiB.');}chunks.push(value);}}finally{reader.releaseLock();}}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return error(400,'cave_mcp_invalid_json','Expected one JSON-RPC object.');}
   if(!body||typeof body!=='object'||Array.isArray(body))return error(400,'cave_mcp_invalid_json','Expected one JSON-RPC object.');
   const token=authorization.slice(7);
   const client=new CloudClient({baseURL,token,fetch:transport,allowPlainHTTP});
   // Live discovery intersects current role, explicit scopes and reviewed access.
   // It runs beside whoami, not after it; whoami's refusal still answers first.
   const discovery=client.request(grantDiscovery,{signal:request.signal});
   discovery.catch(()=>{});
   const who=await client.execute('context.whoami',{}, {signal:request.signal});
   const user=who.data.user;
   if(!uuid.test(user.project_id??'')||!Array.isArray(user.scopes)||!user.scopes.includes('org:read'))return error(403,'cave_mcp_scoped_connection_required','Create a project-scoped agent connection; browser sessions and unscoped credentials cannot use hosted MCP.');
   const grants=discoveryGrants(await discovery);
   const cfg={baseURL,token,projectId:user.project_id,fetch:transport,allowPlainHTTP};
   server=createCloudMCP({resolveContext:async()=>cfg,grantedOperations:grants,identity:who.data});
   const wire=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
   await server.connect(wire);
   const response=await wire.handleRequest(request,{parsedBody:body});
   // JSON mode completes the response before close; no SSE stream is retained.
   for(const [key,value]of Object.entries(headers))response.headers.set(key,value);
   return response;
  }catch(e){
   if(e instanceof CloudError){const status=e.httpStatus===403?403:e.httpStatus===429?429:e.exitCode===3?401:e.exitCode===2?400:e.exitCode===4?409:502;const retry=e.details?.retry_after_seconds;return error(status,e.code,e.message.slice(0,500),status===401?{'www-authenticate':challenge}:status===429&&retry>0?{'retry-after':String(retry)}:{});}
   return error(500,'cave_mcp_failed','MCP request failed. Inspect resource state before retrying a mutation.');
  }finally{await server?.close();}
 };
}
