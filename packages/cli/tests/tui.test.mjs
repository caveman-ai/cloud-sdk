import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as pause} from 'node:timers/promises';
import {capabilities,frame,sprite,keys} from '../bin/tui.mjs';

const visible=line=>line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
const rows=[['Install cvm','done','cvm is on your PATH'],['Sign in','done','someone.with.a.long.address@example.com · api.caveman.so'],['Project','done','A project whose name runs on and on past any terminal'],
 ['Agents','running','Claude Code · Codex · Cursor · VS Code · Windsurf · Gemini CLI · OpenCode'],['Skills','pending',''],['MCP','pending',''],['Ready','pending','']].map(([label,status,detail])=>({label,status,detail}));

test('capabilities: a pipe, CI and TERM=dumb get no animation; NO_COLOR no colour; COLORTERM truecolor 24-bit',()=>{
 const tty={isTTY:true};
 assert.deepEqual(capabilities(tty,{}),{animate:true,depth:8,ascii:process.platform==='win32'});
 assert.equal(capabilities(tty,{COLORTERM:'truecolor'}).depth,24);
 assert.deepEqual([capabilities(tty,{NO_COLOR:'1'}).animate,capabilities(tty,{NO_COLOR:'1'}).depth],[true,0]);
 assert.equal(capabilities(tty,{CI:'true'}).animate,false);
 assert.equal(capabilities(tty,{CI:'0'}).animate,true);
 assert.deepEqual(capabilities(tty,{TERM:'dumb'}),{animate:false,depth:0,ascii:true});
 assert.deepEqual(capabilities({isTTY:false},{}),{animate:false,depth:0,ascii:process.platform==='win32'});
});

test('the sprite is the 8×8 mark in #f36716, 256 colours, then plain #',()=>{
 const truecolor=sprite('steady',0,{depth:24,ascii:false}),indexed=sprite('steady',0,{depth:8,ascii:false}),bare=sprite('steady',0,{depth:0,ascii:false});
 assert.ok(truecolor.join('').includes('\x1b[38;2;243;103;22m■'));
 assert.ok(indexed.join('').includes('\x1b[38;5;202m■'));
 assert.deepEqual(bare,['      # #       ','    # # # #     ','    # # # #     ','  # #     # #   ','  # #     # #   ','# #         # # ','  # #     # #   ','    # # # #     ']);
 for(const lines of [truecolor,indexed])assert.deepEqual(lines.map(line=>visible(line).length),Array(8).fill(16));
 // Ignite lights from the bottom row; ash is grey.
 assert.deepEqual(sprite('ignite',1,{depth:0}).map(line=>line.includes('#')),[false,false,false,false,false,false,false,true]);
 assert.ok(sprite('ash',0,{depth:8}).join('').match(/38;5;(240|243|247)m/g).length===30);
 assert.notDeepEqual(sprite('idle',1,{depth:24}),sprite('idle',2,{depth:24}),'the tips flicker');
});

test('the frame clamps every row to the width, and under 60 columns drops the sprite for a one-row wordmark',()=>{
 for(const k of [{depth:24,ascii:false},{depth:0,ascii:false},{depth:0,ascii:true}]){
  for(const width of [140,80,60,59,40,24]){
   const lines=frame({rows,version:'0.1.0-rc.29',art:sprite('steady',0,k),hint:'↑↓ space enter'},width,k);
   for(const line of lines)assert.ok(visible(line).length<=width,`${width} ${JSON.stringify(visible(line))}`);
   assert.equal(lines.length,width>=60?9:8);
   if(!k.depth)assert.ok(!lines.join('').includes('\x1b'),'NO_COLOR: no escape codes');
  }
 }
 const wide=frame({rows,version:'0.1.0',art:sprite('steady',0,{depth:0}),hint:'↑↓ space enter'},100,{depth:0}).map(visible);
 assert.match(wide[0],/^ {6}# # {7}  Caveman Cloud +cvm 0\.1\.0$/);
 assert.match(wide[2],/^ {4}# # # # {5}  ✓ Install cvm  cvm is on your PATH$/);
 assert.match(wide[5],/^# # .*▸ Agents {7}Claude Code · .*… +↑↓ space enter$/);
 assert.match(wide[8],/^ {18}◻ Ready +3\/7$/);
 const narrow=frame({rows,version:'0.1.0',art:[]},40,{depth:0,ascii:true}).map(visible);
 assert.deepEqual([narrow[0],narrow[1]],['# Caveman Cloud  cvm 0.1.0','  +   Install cvm  cvm is on your PATH']);
});

test('keys drop what was typed or pasted before the prompt drew, and an Enter in its first moments',async()=>{
 const input=new PassThrough(),seen=[];
 input.write('y\r');
 const stop=keys(input,key=>seen.push(key.name));
 input.write('\r');
 await pause(200);
 input.write('\r');
 await pause(250);
 input.write('n\r');
 await pause(20);
 stop();
 assert.deepEqual(seen,['n','return']);
});
