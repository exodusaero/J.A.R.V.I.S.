/* Interactive, original vector HUD. No camera, microphone or GPU permissions required. */
(function () {
  'use strict';
  function mount({canvas, stage, getState, local, submitChat, setMode}) {
    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const $ = id => document.getElementById(id);
    const TAU = 2 * Math.PI;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const dots = Array.from({length:620}, (_,i) => {
      const y = 1-2*(i+.5)/620, a = i*Math.PI*(3-Math.sqrt(5)), r = Math.sqrt(1-y*y);
      return [r*Math.cos(a),y,r*Math.sin(a)];
    });
    const v = {yaw:.25,pitch:-.25,zoom:1,focus:false,drag:false,px:0,py:0,time:0,interaction:0};
    let gestureDistance = 0, frameId=0, last=0;
    function setZoom(next) { v.zoom = clamp(next,.68,1.65); $('hud-scale').textContent = 'OPTIC SCALE '+Math.round(v.zoom*100)+'%'; v.interaction = performance.now(); }
    function reset() { v.yaw=.25;v.pitch=-.25;v.focus=false; $('hud-focus').setAttribute('aria-pressed','false');$('hud-focus').textContent='ANALYSE';setZoom(1); }
    function rotate(x,y,z) {
      let px=x*Math.cos(v.yaw)+z*Math.sin(v.yaw), pz=z*Math.cos(v.yaw)-x*Math.sin(v.yaw);
      return [px, y*Math.cos(v.pitch)-pz*Math.sin(v.pitch), y*Math.sin(v.pitch)+pz*Math.cos(v.pitch)];
    }
    function project(p,cx,cy,r) {
      const q=rotate(p[0],p[1],p[2]), perspective=2.6/(2.6-q[2]*.28);
      return [cx+q[0]*r*perspective,cy+q[1]*r*perspective,q[2]];
    }
    function path3(points,cx,cy,r,rgba,width=1) {
      if (!points.length) return;
      ctx.strokeStyle=rgba;ctx.lineWidth=width;ctx.beginPath();
      const initial=project(points[0],cx,cy,r);ctx.moveTo(initial[0],initial[1]);
      for(let j=1;j<points.length;j++){const p=project(points[j],cx,cy,r);ctx.lineTo(p[0],p[1]);}
      ctx.stroke();
    }
    function arc(cx,cy,r,start,end,color,width=1,dashes=[]) {
      ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dashes);ctx.beginPath();ctx.arc(cx,cy,r,start,end);ctx.stroke();ctx.setLineDash([]);
    }
    function print(value,x,y,color='#6ab7cd',align='left',size=9){
      ctx.fillStyle=color;ctx.textAlign=align;ctx.font=size+'px ui-monospace,SFMono-Regular,monospace';ctx.fillText(value,x,y);
    }
    function render(time) {
      frameId=requestAnimationFrame(render);
      const fps = reduced.matches ? 3 : (document.visibilityState === 'hidden' ? 1 : 35);
      if (time-last<1000/fps) return;
      const dt = Math.min((time-last)/1000,.08);last=time;
      const state=getState();
      if (!reduced.matches && !v.drag && time-v.interaction>3500 && state.mode!=='standby') v.yaw+=dt*.085;
      if (!reduced.matches) v.time+=dt;
      const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(window.devicePixelRatio||1,2);
      if(!w||!h)return;
      if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      const cx=w/2,cy=h/2,r=Math.min(w*.285,h*.34)*v.zoom*(v.focus?1.05:1);
      const active = state.speaking ? 'SPEAKING' : state.busy ? 'PROCESSING' : state.connected ? 'ONLINE' : local ? 'OFFLINE' : 'PREVIEW';
      $('hud-engine').textContent=active;
      const hue=state.busy?'255,187,109':state.speaking?'188,246,255':'70,214,255';
      const glow=ctx.createRadialGradient(cx,cy,8,cx,cy,r*2.15);
      glow.addColorStop(0,'rgba('+hue+',.21)');glow.addColorStop(.52,'rgba(33,129,181,.055)');glow.addColorStop(1,'rgba(10,80,135,0)');
      ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
      // Polar reticles, mechanical gimbal arcs and angular scale markings.
      for (let i=0;i<5;i++) {
        const radius=r*(1.08+i*.17),speed=[.07,-.105,.044,-.062,.095][i];
        const start=(reduced.matches?0:v.time*speed)+i*.94;
        arc(cx,cy,radius,start,start+Math.PI*(i===1?1.45:.76),'rgba('+hue+','+(.24-i*.023)+')',i===0?1.8:1);
        arc(cx,cy,radius,start+Math.PI*1.04,start+Math.PI*1.19,'rgba(180,238,255,.65)',i===2?2:1);
      }
      for(let i=0;i<96;i++){
        const a=i*TAU/96, major=i%8===0, inner=r*1.83;
        const outside=inner+(major?13:5);
        ctx.lineWidth=major?1.35:.6;ctx.strokeStyle=major?'rgba(130,230,255,.65)':'rgba(60,149,194,.30)';
        ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*inner,cy+Math.sin(a)*inner);
        ctx.lineTo(cx+Math.cos(a)*outside,cy+Math.sin(a)*outside);ctx.stroke();
      }
      // Three projected great-circle lattices. Orientation follows actual pointer input.
      for(let axis=0;axis<3;axis++){
        for(let index=0;index<7;index++){
          const offset=(index-3)*.23, rr=Math.sqrt(1-offset*offset);
          const p=[];
          for(let j=0;j<=96;j++){
            const a=j*TAU/96;
            if(axis===0)p.push([offset,rr*Math.cos(a),rr*Math.sin(a)]);
            if(axis===1)p.push([rr*Math.cos(a),offset,rr*Math.sin(a)]);
            if(axis===2)p.push([rr*Math.cos(a),rr*Math.sin(a),offset]);
          }
          path3(p,cx,cy,r,'rgba(49,171,222,'+(index===3?.35:.09)+')',.8);
        }
      }
      for(let i=0;i<dots.length;i++){
        const p=project(dots[i],cx,cy,r),alpha=.23+(p[2]+1)*.25;
        ctx.fillStyle='rgba('+hue+','+alpha+')';ctx.beginPath();ctx.arc(p[0],p[1],p[2]>.3?1.15:.68,0,TAU);ctx.fill();
      }
      // Nested mechanical reactor: rings with cut-away sectors around an active core.
      for(let i=0;i<3;i++){
        const rad=r*(.52-i*.11), phase=(reduced.matches?0:v.time*.11)*(i%2?-1:1);
        for(let j=0;j<9;j++){
          const a=phase+j*TAU/9,seg=TAU/9*.72;
          arc(cx,cy,rad,a,a+seg,'rgba('+hue+','+(i===0?.52:.68)+')',i===2?2.2:1.5);
        }
      }
      const pulse = reduced.matches ? 1 : (1+.035*Math.sin(v.time*(state.speaking?9:state.busy?5:1.9)));
      const cr=r*.205*pulse;
      const center=ctx.createRadialGradient(cx,cy,0,cx,cy,cr*2.3);
      center.addColorStop(0,'rgba(225,251,255,.95)');center.addColorStop(.12,'rgba('+hue+',.85)');center.addColorStop(.39,'rgba(33,143,206,.17)');center.addColorStop(1,'rgba(23,124,180,0)');
      ctx.fillStyle=center;ctx.beginPath();ctx.arc(cx,cy,cr*2.3,0,TAU);ctx.fill();
      arc(cx,cy,cr,0,TAU,'rgba(205,246,255,.7)',1.2);
      ctx.strokeStyle='rgba(110,220,255,.5)';ctx.lineWidth=.8;
      for(let j=0;j<6;j++){
        const a=j*TAU/6+(reduced.matches?0:v.time*.05);
        ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*cr*.45,cy+Math.sin(a)*cr*.45);
        ctx.lineTo(cx+Math.cos(a)*cr*.95,cy+Math.sin(a)*cr*.95);ctx.stroke();
      }
      print('J.A.R.V.I.S.',cx,cy+4,'#e6fbff','center',clamp(r*.095,8,15));
      // Functional state annotation; not invented sensor readings.
      const y=cy+r*1.76;
      print('X '+v.yaw.toFixed(2),cx-r*1.3,y,'#4b9bb5');
      print('Y '+v.pitch.toFixed(2),cx-r*.5,y,'#4b9bb5');
      print(active,cx+r*1.28,y,state.busy?'#ffbf69':'#8ddff8','right');
      if(v.focus){print('GEOMETRY / INTERACTIVE MODEL',cx,cy-r*1.63,'#a5ebfe','center',10);}
    }
    const pointers=new Map();
    canvas.addEventListener('pointerdown',e=>{
      canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,[e.clientX,e.clientY]);v.drag=true;v.px=e.clientX;v.py=e.clientY;v.interaction=performance.now();
      if(pointers.size===2){const p=[...pointers.values()];gestureDistance=Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]);}
    });
    canvas.addEventListener('pointermove',e=>{
      if(!pointers.has(e.pointerId))return;
      pointers.set(e.pointerId,[e.clientX,e.clientY]);v.interaction=performance.now();
      if(pointers.size===2){const p=[...pointers.values()],distance=Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]);
        if(gestureDistance>0)setZoom(v.zoom*distance/gestureDistance);gestureDistance=distance;return;
      }
      v.yaw+=(e.clientX-v.px)*.009;v.pitch=clamp(v.pitch+(e.clientY-v.py)*.009,-1.5,1.5);v.px=e.clientX;v.py=e.clientY;
    });
    function release(e){pointers.delete(e.pointerId);v.drag=pointers.size>0;gestureDistance=0;}
    canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);canvas.addEventListener('lostpointercapture',release);
    canvas.addEventListener('wheel',e=>{e.preventDefault();setZoom(v.zoom*Math.exp(-e.deltaY*.001));},{passive:false});
    canvas.addEventListener('keydown',e=>{
      if(e.key==='ArrowLeft'||e.key==='ArrowRight'){v.yaw+=(e.key==='ArrowLeft'?-1:1)*.13;v.interaction=performance.now();e.preventDefault();}
      if(e.key==='ArrowUp'||e.key==='ArrowDown'){v.pitch=clamp(v.pitch+(e.key==='ArrowUp'?-1:1)*.13,-1.5,1.5);v.interaction=performance.now();e.preventDefault();}
      if(e.key==='+'||e.key==='='){setZoom(v.zoom*1.1);e.preventDefault();}
      if(e.key==='-'){setZoom(v.zoom/1.1);e.preventDefault();}
      if(e.key==='Home'){reset();e.preventDefault();}
    });
    $('hud-zoom-in').addEventListener('click',()=>setZoom(v.zoom*1.12));
    $('hud-zoom-out').addEventListener('click',()=>setZoom(v.zoom/1.12));
    $('hud-reset').addEventListener('click',reset);
    $('hud-focus').addEventListener('click',()=>{v.focus=!v.focus;$('hud-focus').setAttribute('aria-pressed',String(v.focus));$('hud-focus').textContent=v.focus?'OVERVIEW':'ANALYSE';v.interaction=performance.now();});
    const clock=()=>{$('hud-clock').textContent='LOCAL · '+new Date().toLocaleTimeString([], {hour12:false});};
    clock();const timer=setInterval(clock,1000);
    window.addEventListener('pagehide',()=>{cancelAnimationFrame(frameId);clearInterval(timer);});
    // Command palette: real view changes, focus, and user-initiated conversation prompts.
    const commands=[
      {name:'System report',description:'Request live system diagnostics from Jarvis',run:()=>submitChat('Give me a concise status report using current system metrics.')},
      {name:'Mission planning',description:'Plan the next engineering task',run:()=>submitChat('Help me plan my next engineering task step by step.')},
      {name:'Capabilities',description:'List available tools and limitations',run:()=>submitChat('What can you help me with on this computer right now?')},
      {name:'Hologram · analyse',description:'Inspect the interactive geometry',run:()=>{$('hud-focus').click();canvas.focus();}},
      {name:'Hologram · reset',description:'Restore orientation and scale',run:()=>{reset();canvas.focus();}},
      {name:'Display · workspace',description:'Show workspace and telemetry',run:()=>setMode('workspace')},
      {name:'Display · awake',description:'Enlarge the hologram',run:()=>setMode('awake')},
      {name:'Display · standby',description:'Dim the interface',run:()=>setMode('standby')},
    ];
    const overlay=$('command-overlay'),filter=$('command-filter'),results=$('command-results');
    function closePalette(){overlay.hidden=true;filter.value='';$('command-open').focus();}
    function renderCommands(){results.replaceChildren();const query=filter.value.trim().toLowerCase();
      for(const command of commands.filter(item=>(item.name+' '+item.description).toLowerCase().includes(query))){
        const button=document.createElement('button');button.type='button';button.textContent=command.name;
        const desc=document.createElement('small');desc.textContent=command.description;button.append(desc);
        button.addEventListener('click',()=>{closePalette();command.run();});results.append(button);
      }
      if(!results.children.length){const empty=document.createElement('p');empty.textContent='No matching commands.';results.append(empty);}
    }
    function openPalette(){overlay.hidden=false;filter.value='';renderCommands();filter.focus();}
    $('command-open').addEventListener('click',openPalette);$('command-close').addEventListener('click',closePalette);
    overlay.addEventListener('click',e=>{if(e.target===overlay)closePalette();});
    filter.addEventListener('input',renderCommands);filter.addEventListener('keydown',e=>{
      if(e.key==='Enter'){const first=results.querySelector('button');if(first)first.click();}
    });
    document.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();overlay.hidden?openPalette():closePalette();}
      if(e.key==='Escape'&&!overlay.hidden){e.preventDefault();closePalette();}
    });
    document.querySelectorAll('#quick-actions [data-command]').forEach(button=>button.addEventListener('click',()=>{
      if(!local)return;submitChat(button.dataset.command);
    }));
    if(!local)document.querySelectorAll('#quick-actions [data-command]').forEach(button=>{button.disabled=true;button.title='Start Jarvis locally to use this command.';});
    frameId=requestAnimationFrame(render);
    return {reset,setZoom};
  }
  window.JarvisHUD={mount};
})();
