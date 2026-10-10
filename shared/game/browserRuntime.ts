/** Optional browser utilities. Gameplay, rendering and art remain author code. */
export const BROWSER_RUNTIME_FILE = "arcane.runtime.js";
export const BROWSER_GAME_RUNTIME_JS = String.raw`(function(global){
'use strict';
function createGame(options){
  if(!options || !options.canvas || typeof options.render !== 'function') throw new Error('canvas and render are required');
  var canvas=options.canvas, ctx=canvas.getContext('2d');
  if(!ctx) throw new Error('Canvas2D is unavailable');
  var state='ready', data=null, destroyed=false, previous=null, raf=0, observer=null;
  var size={width:1,height:1,dpr:1};
  var input={keys:new Set(),pressed:new Set(),pointer:{x:0,y:0,down:false,pressed:false}};
  var cleanups=[];
  var allowedKeys=new Set(options.keys || ['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD','Enter','Escape']);
  function listen(target,type,fn){ target.addEventListener(type,fn); cleanups.push(function(){ target.removeEventListener(type,fn); }); }
  function clearInput(){ input.keys.clear(); input.pressed.clear(); input.pointer.down=false; input.pointer.pressed=false; }
  function change(next){ if(destroyed || state===next) return; state=next; clearInput(); previous=null; if(options.onState) options.onState(next,data); }
  function resize(){
    if(destroyed) return;
    var rect=canvas.getBoundingClientRect();
    size.width=Math.max(1,Math.round(rect.width || options.width || 960));
    size.height=Math.max(1,Math.round(rect.height || options.height || 540));
    size.dpr=Math.max(1,Math.min(Number(global.devicePixelRatio)||1,2));
    canvas.width=Math.round(size.width*size.dpr); canvas.height=Math.round(size.height*size.dpr);
    ctx.setTransform(size.dpr,0,0,size.dpr,0,0);
    if(options.onResize) options.onResize(size,data);
  }
  function editable(event){ var target=event.target; return !!(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))); }
  function keydown(event){
    if(destroyed || state!=='running' || editable(event) || !allowedKeys.has(event.code)) return;
    if(event.preventDefault) event.preventDefault();
    if(!input.keys.has(event.code)) input.pressed.add(event.code);
    input.keys.add(event.code);
    if(options.onInput) options.onInput(event,input,data);
  }
  function keyup(event){ input.keys.delete(event.code); }
  function pointer(event){
    var rect=canvas.getBoundingClientRect();
    input.pointer.x=(event.clientX-rect.left)*size.width/Math.max(1,rect.width);
    input.pointer.y=(event.clientY-rect.top)*size.height/Math.max(1,rect.height);
  }
  function pointerdown(event){
    if(destroyed) return;
    if(canvas.focus) canvas.focus({preventScroll:true});
    pointer(event); input.pointer.down=true; input.pointer.pressed=true;
    if(canvas.setPointerCapture && event.pointerId!==undefined) { try{canvas.setPointerCapture(event.pointerId);}catch(error){} }
    if(options.onInput) options.onInput(event,input,data);
  }
  function pointerup(event){ pointer(event); input.pointer.down=false; }
  function frame(time){
    if(destroyed) return;
    var dt=previous===null?0:Math.max(0,Math.min((time-previous)/1000,1/15)); previous=time;
    if(state==='running' && options.update) options.update(dt,input,data);
    if(destroyed) return;
    ctx.setTransform(size.dpr,0,0,size.dpr,0,0);
    options.render(ctx,size,data,state);
    if(destroyed) return;
    input.pressed.clear(); input.pointer.pressed=false;
    raf=global.requestAnimationFrame(frame);
  }
  function start(){ if(destroyed || state!=='ready') return; data=options.reset?options.reset():{}; change('running'); }
  function restart(){ if(destroyed) return; clearInput(); data=options.reset?options.reset():{}; state='ready'; change('running'); }
  function pause(){ if(state==='running') change('paused'); }
  function resume(){ if(state==='paused') change('running'); }
  function win(){ if(state==='running') change('won'); }
  function lose(){ if(state==='running') change('lost'); }
  function destroy(){
    if(destroyed) return; destroyed=true; global.cancelAnimationFrame(raf); clearInput();
    cleanups.forEach(function(cleanup){cleanup();}); if(observer) observer.disconnect(); state='destroyed';
  }
  if(canvas.tabIndex<0 || canvas.tabIndex===undefined) canvas.tabIndex=0;
  listen(global,'keydown',keydown); listen(global,'keyup',keyup);
  listen(canvas,'pointerdown',pointerdown); listen(canvas,'pointermove',pointer); listen(canvas,'pointerup',pointerup); listen(canvas,'pointercancel',function(){clearInput();});
  listen(global,'pointerup',pointerup); listen(global,'blur',function(){clearInput();pause();}); listen(global,'resize',resize);
  if(typeof global.ResizeObserver==='function'){observer=new global.ResizeObserver(resize);observer.observe(canvas);}
  resize(); raf=global.requestAnimationFrame(frame);
  return {start:start,restart:restart,pause:pause,resume:resume,win:win,lose:lose,destroy:destroy,resize:resize,input:input,size:size,state:function(){return state;},data:function(){return data;}};
}
function createHud(container,options){
  if(!container) throw new Error('HUD container is required');
  options=options || {}; var document=container.ownerDocument || global.document, destroyed=false;
  var root=document.createElement('div'), metrics=document.createElement('div'), message=document.createElement('p'), restart=document.createElement('button');
  root.setAttribute('role','status'); root.setAttribute('aria-live','polite');
  restart.type='button'; restart.textContent=options.restartLabel || '重新开始';
  function reset(){if(options.restart) options.restart();}
  restart.addEventListener('click',reset); root.appendChild(metrics);root.appendChild(message);root.appendChild(restart);container.appendChild(root);
  function set(values){if(destroyed)return;metrics.textContent=Object.keys(values).map(function(key){return key+': '+String(values[key]);}).join(' · ');}
  function show(text){if(!destroyed) message.textContent=String(text);}
  function destroy(){if(destroyed)return;destroyed=true;restart.removeEventListener('click',reset);root.remove();}
  return {set:set,show:show,destroy:destroy,element:root};
}
global.ArcaneRuntime={createGame:createGame,createHud:createHud};
})(window);`;

export const BROWSER_RUNTIME_GUIDANCE = `Optional stable local utilities are available as arcane.runtime.js. To use them, reference <script src="arcane.runtime.js"></script> before your own script; DO NOT output this managed file.
ArcaneRuntime.createGame({canvas, reset:()=>initialGameData, update:(dt,input,data)=>{...}, render:(ctx,size,data,state)=>{...}, onState:(state,data)=>{...}, onResize:(size,data)=>{...}, onInput:(event,input,data)=>{...}}) returns {start,restart,pause,resume,win,lose,destroy,resize,input,size,state(),data()}. Call start() after the player clicks your start button. States: ready,running,paused,won,lost,destroyed. restart resets game data. input.keys/pressed are Sets of event.code; pointer={x,y,down,pressed}. Size uses CSS pixel coordinates with DPR handled automatically; render every frame, update only while running. Runtime handles keyboard/pointer, resize, blur/pause and cleanup; author all game-specific logic and visuals yourself.
ArcaneRuntime.createHud(container,{restart:()=>game.restart()}) returns {set({label:value}),show(message),destroy(),element}; it updates text safely. Using these utilities is optional and must not change the user's gameplay.`;
