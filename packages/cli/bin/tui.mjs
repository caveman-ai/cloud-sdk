// The `cvm setup` screen: the mark as a sprite beside a row per step, redrawn
// in place as one live region that stays in the scrollback when it ends. Raw
// ANSI and node:readline, nothing else.
import {emitKeypressEvents} from 'node:readline';
import {setTimeout as pause} from 'node:timers/promises';

// docs/brand/assets/caveman-mark.svg, a pixel per cell; rows 0-2 are the tips.
const MARK=['   ##   ','  ####  ','  ####  ',' ##  ## ',' ##  ## ','##    ##',' ##  ## ','  ####  '];
// [truecolor, 256-colour]
const ORANGE=['#f36716',202],TIPS=[['#ff8a2a',208],['#ffb347',214],['#ffd27a',222]],FLARE=['#fff0c8',230],EMBER=['#4a1f08',52],ASH=[['#5a5a5a',240],['#7c7c7c',243],['#a0a0a0',247]];
const LABEL=13,WIDE=60;
const visible=line=>line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
export const clip=(text,width)=>text.length>width?`${text.slice(0,Math.max(0,width-1))}…`:text;

// What this terminal can show. CI, TERM=dumb or a pipe get no animation and
// no live region; NO_COLOR gets no colour (and the sprite in #).
export function capabilities(out=process.stdout,env=process.env){
 const ci=Boolean(env.CI)&&env.CI!=='0'&&env.CI.toLowerCase()!=='false',dumb=env.TERM==='dumb',color=Boolean(out.isTTY)&&!dumb&&!env.NO_COLOR;
 return {
  animate:Boolean(out.isTTY)&&!ci&&!dumb,
  depth:!color?0:/^(truecolor|24bit)$/i.test(env.COLORTERM??'')?24:8,
  // A legacy Windows console (conhost on a raster font) has none of these glyphs.
  ascii:dumb||process.platform==='win32'&&!env.WT_SESSION&&env.TERM_PROGRAM!=='vscode',
 };
}
const ink=(depth,[hex,n])=>text=>depth===24?`\x1b[38;2;${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(';')}m${text}\x1b[0m`:depth?`\x1b[38;5;${n}m${text}\x1b[0m`:text;
export function colors({depth}){
 const sgr=code=>text=>depth?`\x1b[${code}m${text}\x1b[0m`:text;
 return {bold:sgr('1'),dim:sgr('2'),green:sgr('32'),red:sgr('31'),yellow:sgr('33'),accent:ink(depth,ORANGE)};
}
export const glyphs=({ascii})=>ascii
 ?{pending:'[ ]',running:'>',done:'+',failed:'x',blocked:'!',on:'[x]',off:'[ ]',pointer:'>',pixel:'#',width:3}
 :{pending:'◻',running:'▸',done:'✓',failed:'✗',blocked:'!',on:'◼',off:'◻',pointer:'›',pixel:'■',width:1};

// 8 rows of 16 columns. ignite lights the rows bottom to top over ticks 0-8,
// idle flickers the tips, flare is one bright frame, ash is a failure.
export function sprite(state,tick,k){
 const pixel=!k.depth||k.ascii?'#':'■';
 return MARK.map((row,r)=>[...row].map((cell,c)=>{
  if(cell===' ')return '  ';
  if(state==='ignite'&&r<8-tick)return k.depth?ink(k.depth,EMBER)(pixel)+' ':'  ';
  const tone=state==='ash'?ASH[(r+c)%3]:state==='flare'?FLARE:r>2?ORANGE:state==='idle'?TIPS[(r*5+c*3+tick+(tick>>1)*c)%3]:TIPS[0];
  return ink(k.depth,tone)(pixel)+' ';
 }).join(''));
}

// The screen at a width: the sprite and the rows beside it, or from 60 columns
// down a one-row wordmark over the rows. Every row is clipped, never wrapped.
export function frame({rows,version,art,hint},width,k){
 const c=colors(k),g=glyphs(k),tone={pending:c.dim,running:c.accent,done:c.green,failed:c.red,blocked:c.yellow};
 const count=`${rows.filter(r=>r.status==='done').length}/${rows.length}`;
 const line=(row,room)=>{
  const right=row.status==='running'&&hint?hint:row===rows.at(-1)?count:'';
  const head=`${g[row.status].padEnd(g.width)} ${row.label.padEnd(LABEL)}`;
  if(head.length>=room)return tone[row.status](clip(head,room));
  const detail=clip(row.detail,room-head.length-(right?right.length+2:0)),gap=room-head.length-detail.length-right.length;
  return `${tone[row.status](g[row.status].padEnd(g.width))} ${row.status==='pending'?c.dim(row.label.padEnd(LABEL)):row.label.padEnd(LABEL)}${c.dim(detail)}${right&&gap>=2?' '.repeat(gap)+c.dim(right):''}`;
 };
 const tag=`cvm ${version}`;
 if(width<WIDE){
  const title=`${g.pixel} Caveman Cloud`;
  return [`${c.accent(g.pixel)} ${c.bold('Caveman Cloud')}${title.length+2+tag.length<=width?`  ${c.dim(tag)}`:''}`,...rows.map(row=>`  ${line(row,width-2)}`)];
 }
 const room=width-18,pad=room-'Caveman Cloud'.length-tag.length;
 return [`${art[0]}  ${c.bold('Caveman Cloud')}${pad>=2?' '.repeat(pad)+c.dim(tag):''}`,art[1],...rows.map((row,i)=>`${art[i+2]??' '.repeat(16)}  ${line(row,room)}`)];
}

// A frame drawn in place: back to its first row, clear down, draw. A terminal
// made narrower since the last draw has wrapped those rows; the rewind counts them.
export function region(out,write){
 let shown=[];
 const height=()=>shown.reduce((n,line)=>n+Math.max(1,Math.ceil(visible(line).length/(out.columns||80))),0);
 return {
  draw(lines){const up=shown.length?height()-1:0;write(`${up?`\x1b[${up}A`:''}\r\x1b[J${lines.join('\n')}`);shown=lines;},
  close(){if(shown.length)write('\n');shown=[];},
 };
}

// Keys typed or pasted before a prompt drew are not an answer to it: what is
// still buffered arrives in the first moments and is dropped, and an Enter in
// the first 400 ms is the tail of a double tap. Ctrl-C always counts.
export function keys(input,onKey){
 emitKeypressEvents(input);
 while(input.read()!==null);
 input.setRawMode?.(true);input.resume();
 const shown=Date.now();
 const handler=(_,key={})=>{
  const age=Date.now()-shown;
  if(key.ctrl&&key.name==='c'||age>=150&&!(age<400&&['return','enter'].includes(key.name)))onKey(key);
 };
 input.on('keypress',handler);
 return ()=>{input.off('keypress',handler);input.setRawMode?.(false);input.pause();};
}

// The setup screen over `rows` ({label,status,detail}, changed by the caller,
// then update()). Without animation it prints notes as they come and the
// final frame once.
export function screen({rows,version,out=process.stdout,input=process.stdin,k=capabilities(out)}){
 // Bound now: cvm's call() swaps process.stdout.write while a command runs.
 const write=out.write.bind(out),c=colors(k),g=glyphs(k),area=region(out,write);
 let state='ignite',tick=0,timer,extra=()=>[],hint='',open=false;
 const width=()=>Math.max(20,(out.columns||80)-1);
 const paint=()=>{if(open)area.draw([...frame({rows,version,art:sprite(state,tick,k),hint},width(),k),...extra(width())]);};
 const every=(fps,step)=>{clearInterval(timer);timer=setInterval(()=>{step();paint();},1000/fps);timer.unref();};
 const restore=()=>write('\x1b[?25h');
 const ui={
  c,g,
  start(){
   if(!k.animate)return;
   open=true;write('\x1b[?25l');process.once('exit',restore);out.on('resize',paint);
   every(25,()=>{if(++tick>8){state='steady';clearInterval(timer);}});paint();
  },
  update:paint,
  // The tips flicker while the screen waits on the browser or a key.
  waiting(on){if(!open)return;if(on){state='idle';every(8,()=>tick++);}else{clearInterval(timer);state='steady';paint();}},
  // Lines under the frame (the sign-in code); a function of the width.
  note(make){
   if(!open){for(const line of make?.(width())??[])write(line+'\n');return;}
   extra=make?w=>['',...make(w)]:()=>[];paint();
  },
  bell:()=>write('\x07'),
  // A question under the frame: render(width) draws it, onKey(key,done)
  // answers it. Esc or Ctrl-C resolves null.
  ask(render,onKey,keyHint=''){
   return new Promise(resolve=>{
    hint=keyHint;ui.note(render);ui.bell();ui.waiting(true);
    const stop=keys(input,key=>{
     if(key.name==='escape'||key.ctrl&&key.name==='c')return done(null);
     onKey(key,done);paint();
    });
    function done(value){stop();hint='';ui.note();ui.waiting(false);resolve(value);}
   });
  },
  confirm(question){
   let yes=true;
   return ui.ask(()=>[`${question} ${c.dim(g.pointer)} ${yes?c.accent(c.bold('Yes')):c.dim('Yes')} ${c.dim('/')} ${yes?c.dim('No'):c.accent(c.bold('No'))}`],(key,done)=>{
    if(key.name==='y')done(true);else if(key.name==='n')done(false);
    else if(['return','enter'].includes(key.name))done(yes);
    else if(['left','right','tab','h','l','up','down'].includes(key.name))yes=!yes;
   });
  },
  // The last frame: a flare on Ready, ash on a failure; it stays in the scrollback.
  async end(final){
   clearInterval(timer);
   if(!open){if(!k.animate)write(frame({rows,version,art:sprite(final==='ash'?'ash':'steady',0,k)},width(),k).join('\n')+'\n');return;}
   extra=()=>[];hint='';state=final;paint();
   if(final==='flare'){await pause(160);state='steady';paint();}
   area.close();open=false;out.off('resize',paint);restore();process.off('exit',restore);
  },
 };
 return ui;
}

// A yes/no question on its own line in the scrollback.
export function confirm(question,{out=process.stdout,input=process.stdin,k=capabilities(out)}={}){
 const write=out.write.bind(out),c=colors(k),g=glyphs(k),area=region(out,write);
 let yes=true;
 const draw=active=>area.draw([active?`${question} ${c.dim(g.pointer)} ${yes?c.accent(c.bold('Yes')):c.dim('Yes')} ${c.dim('/')} ${yes?c.dim('No'):c.accent(c.bold('No'))}`:`${question} ${c.dim(g.pointer)} ${yes?'Yes':'No'}`]);
 return new Promise(resolve=>{
  draw(true);write('\x07');
  const stop=keys(input,key=>{
   if(key.name==='escape'||key.ctrl&&key.name==='c'||key.name==='n')yes=false;
   else if(key.name==='y')yes=true;
   else if(!['return','enter'].includes(key.name)){if(['left','right','tab','h','l','up','down'].includes(key.name))yes=!yes;return draw(true);}
   stop();draw(false);area.close();resolve(yes);
  });
 });
}
