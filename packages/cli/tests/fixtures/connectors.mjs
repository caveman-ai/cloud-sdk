// The connector API's answers as the tests serve them: what a connector reads
// as (5.1), each route's answer body (5.3) and the deploy plan (7.4) of the
// connectors design, with the data of the spec's screens (6.2 to 6.4). The
// list, get, add, connect, pause, resume, writes and remove answers follow the
// routes as built (no used_by or waiting until grants land, a paused connector
// says who paused it); the rest follow the design until their routes land.
export const ids={
 linear:'00000000-0000-4000-8000-0000000000e1',stripe:'00000000-0000-4000-8000-0000000000e2',notion:'00000000-0000-4000-8000-0000000000e3',
 connection:'00000000-0000-4000-8000-0000000000f1',dana:'00000000-0000-4000-8000-0000000000b1',lee:'00000000-0000-4000-8000-0000000000b2',
 deployment:'00000000-0000-4000-8000-0000000000d1',request:'00000000-0000-4000-8000-0000000000c9',hold:'00000000-0000-4000-8000-0000000000c8',
};
export const authorize='https://api.caveman.so/api/v1/code/connections/begin?state=org.conn.synthetic';

// A connection as a connector carries it. signed_in_at is when a person last
// completed the sign-in: a token refresh moves updated_at and never it.
export const connection=(over={})=>({connection_id:ids.connection,status:'connected',problem:null,identity:'person',signed_in_by:ids.dana,signed_in_by_name:'Dana',
 expires_at:null,updated_at:'2026-11-19T10:00:00Z',signed_in_at:'2026-11-19T10:00:00Z',writes_in:['production'],...over});
// The same connection as a Caveman Cloud older than signed_in_at sends it.
export const olderConnection=(over={})=>{const {signed_in_at,...rest}=connection(over);return rest;};
// What a connector reads as (5.1, the keys the records lane serves).
export const connector=(over={})=>({id:ids.linear,name:'linear',scope:'org',kind:'mcp',address:'https://mcp.linear.app/mcp',description:'Linear: issues, projects, cycles and comments.',
 template:'linear',origin:'added',state:'ok',paused:null,managers:[{user_id:ids.dana,name:'Dana'}],you_manage:true,
 connection:connection(),pin:{accepted:{version:2,accepted_at:'2026-11-12T09:30:00Z',tools:23},proposed:null},...over});
// The two keys grants add (5.1 as designed).
export const used=(over={})=>({used_by:[{deployment_id:ids.deployment,deployment:'triage',tools:3,ceiling:'write'}],waiting:1,...over});
// Another person's personal connector, as an admin reads it.
export const theirs={id:'00000000-0000-4000-8000-0000000000e9',name:'acme',scope:'personal',host:'tools.acme.dev',owner_user_id:ids.lee,owner_name:'Lee'};

export const catalog={templates:[
 {name:'linear',kind:'mcp',address:'https://mcp.linear.app/mcp',description:'Linear: issues, projects, cycles and comments.',sign_in:[{method:'dynamic'}],personal_data:false},
 {name:'stripe',kind:'mcp',address:'https://mcp.stripe.com',description:'Stripe: payments, customers and refunds.',sign_in:[{method:'registered'}],personal_data:false},
 {name:'notion',kind:'mcp',address:'https://mcp.notion.com/mcp',description:'Notion: pages and databases.',sign_in:[{method:'dynamic'}],personal_data:false},
]};

// A tool of a read, as its card line shows it.
const tool=(name,effect,change,line,changed)=>({name,effect,change,...(changed?{changed}:{}),line});
// POST .../read when the server changed: one tool added, one changed, one removed, one left off.
export const readChanged={connector:'linear',protocol:'2025-06-18',same:false,
 accepted:{version:2,accepted_at:'2026-11-12T09:30:00Z',tools:23},
 proposed:{version:3,read_at:'2026-11-19T10:05:00Z',
  tools:[
   tool('list_issues','read','changed','linear.list_issues({team?: string, state?: string}) -> {issues: [{…}], next}  read  List issues, 50 a page.',['description','arguments']),
   tool('get_issue','read','same','linear.get_issue({id: string}) -> {issue}  read  One issue.'),
   tool('create_comment','write','same','linear.create_comment({issue_id: string, body: string}) -> {comment}  write  Comment on an issue.'),
   tool('create_label','write','added','linear.create_label({name: string, color?: string}) -> {label}  write  Make a label.'),
   tool('notify_slack','external','same','linear.notify_slack({channel: string, text: string}) -> {}  external  Post to Slack.'),
  ],
  removed:['archive_cycle'],
  problems:[{tool:'a b',kind:'needs_review',line:'a b: a name with a space is left off every card until the server renames it.'}]}};
// POST .../read for a connector never accepted: every tool is new.
export const readFresh={connector:'linear',protocol:'2025-06-18',same:false,accepted:null,
 proposed:{version:1,read_at:'2026-11-19T10:05:00Z',tools:readChanged.proposed.tools.map(({changed,...t})=>({...t,change:'added'})),removed:[],problems:[]}};
// POST .../read when nothing changed.
export const readSame={connector:'linear',protocol:'2025-06-18',same:true,accepted:{version:2,accepted_at:'2026-11-12T09:30:00Z',tools:23},proposed:null};
// POST .../accept.
export const accepted=(version=3,tools=5)=>({connector:'linear',pin:{version,accepted_at:'2026-11-19T10:06:00Z',tools},effects:{read:2,write:2,external:1}});
// POST .../test.
export const testOk={connector:'linear',ok:true,protocol:'2025-06-18',milliseconds:412,tools:23,matches_pin:true,problem:null};
export const testFailed={connector:'linear',ok:false,protocol:null,milliseconds:30000,tools:0,matches_pin:false,problem:'linear did not answer in 30 seconds.'};

// Grants and requests.
export const grant=(over={})=>({deployment_id:ids.deployment,deployment:'triage',tools:[],ceiling:'write',args:{},unpinned:[],granted_by_name:'Dana',granted_at:'2026-11-19T10:10:00Z',...over});
export const R=(over={})=>({id:ids.request,connector:'stripe',deployment:'triage',state:'pending',want:{tools:['get_charge','create_refund'],ceiling:'external',args:{},unpinned:[]},
 hold:{id:ids.hold,agent_version:5},requested_by_name:'Sam',created_at:'2026-11-19T09:58:00Z',you_decide:true,decided_by_name:null,reason:null,...over});
export const H=(state,revision=5)=>({id:ids.hold,state,deployment:state==='live'?{id:ids.deployment,name:'triage',revision}:{id:ids.deployment,name:'triage',revision:4}});

// The plan (7.4) with the data of SPEC 6.3: linear covered, stripe and notion
// added and granted by a manager deploying, and linear changed upstream.
export const plan63={
 connectors:[
  {name:'linear',added:false,state:'connected',connection:{identity:'service',signed_in_by_name:'Caveman Bot',writes_in:['production','preview','development']},tools:3,effects:['read','write'],grant:'covered',asked:[]},
  {name:'stripe',added:true,state:'connected',connection:{identity:'person',signed_in_by_name:'Dana',writes_in:['production']},tools:2,effects:['read','external'],grant:'granted',asked:[]},
  {name:'notion',added:true,state:'connected',connection:{identity:'person',signed_in_by_name:'Lee',writes_in:[]},tools:4,effects:['read'],grant:'granted',asked:[]},
 ],
 tools:12,tokens:800,budget:6000,fits:true,
 checks:[{connector:'linear',kind:'pin_changed',line:'linear changed upstream: 1 tool. This deploy uses the list accepted on 2026-11-12.',fix:'cvm connect diff linear'},
  {connector:'notion',kind:'reads_only',line:'notion\'s shared sign-in is Lee\'s own, marked read only.',fix:'cvm connect allow-writes notion'}],
 card:'linear.list_issues(...)  read  List issues.\n...'};
// The plan of a deploy that asks: stripe is granted by nobody here.
export const planAsks={
 connectors:[{name:'stripe',added:true,state:'connected',connection:{identity:'person',signed_in_by_name:'Dana',writes_in:['production']},tools:2,effects:['read','external'],grant:'asks',asked:[{user_id:ids.dana,name:'Dana'},{user_id:ids.lee,name:'Lee'}]}],
 tools:2,tokens:210,budget:6000,fits:true,checks:[],card:'stripe.get_charge(...)  read  One charge.'};

// A refusal as the API sends it, with details.fix.
export const refusal=(status,code,message,details)=>[status,{error:{type:'cave_gateway_error',code,message,...(details?{details}:{}),request_id:'00000000-0000-4000-8000-000000000999'}}];
