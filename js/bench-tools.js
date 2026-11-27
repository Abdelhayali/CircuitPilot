'use strict';

// Camera alignment and assembly rendering share PCB millimetre coordinates.
const BenchTools = (() => {
  const $ = id => document.getElementById(id);
  const colors = ['#f02040', '#36c52c', '#2459ff', '#bd24ef'];
  const hueCenters = [351, 116, 225, 284];
  const inset = 9, markerSize = 7, kind = 'circuitpilot-assembly-v1';
  let guide, guideSource, side = 'F', stream, cameraRequest = 0, frame, lastFrame = 0;
  let cursor = { F: 0, B: 0 };
  const viewSide = () => $('benchSide').value;
  const entries = () => guide?.parts.filter(p => p.side === side) || [];
  const selected = () => entries()[cursor[side]];
  const status = text => $('benchAssemblyStatus').textContent = text;

  function fromPCB() {
    const { w, h } = Model.S.board;
    const parts = Pcb.placed().map(c => {
      const pins = new Map(Model.pinsWorld(c).map(p => [String(p.num), p.name]));
      return { ref: c.ref, value: String(c.value ?? ''), side: Pcb.isBottom(c) ? 'B' : 'F', rot: c.pcb.rot || 0,
        x: c.pcb.x, y: c.pcb.y, box: Pcb.fpBox(c), pads: Pcb.padsOf(c).map(p => ({
          num: String(p.num), name: pins.get(String(p.num)) || '', x: p.x, y: p.y,
          w: p.w, h: p.h, shape: p.shape, drill: p.drill || 0
        })).filter(p => !p.back) };
    }).sort((a, b) => (a.pads.some(p => p.drill) - b.pads.some(p => p.drill)) ||
      String(a.value).localeCompare(String(b.value), undefined, { numeric: true }) ||
      a.ref.localeCompare(b.ref, undefined, { numeric: true }));
    return validateGuide({ kind, name: Model.S.name, w, h, outline: Pcb.boardPoly(), parts });
  }

  function validateGuide(data) {
    const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
    const size = n => Number.isFinite(n) && n > 0 && n < 10000;
    if (data?.kind !== kind || !size(data.w) || !size(data.h) || typeof data.name !== 'string' ||
        !Array.isArray(data.outline) || data.outline.length < 3 || data.outline.length > 2000 || !data.outline.every(point) ||
        !Array.isArray(data.parts) || !data.parts.length || data.parts.length > 5000) {
      throw new Error('Open a PCB with placed parts or select a CircuitPilot assembly file.');
    }
    for (const p of data.parts) {
      if (!p || typeof p.ref !== 'string' || typeof p.value !== 'string' || !['F', 'B'].includes(p.side) ||
          ![p.x, p.y, p.rot].every(Number.isFinite) || !Array.isArray(p.box) || p.box.length !== 4 || !p.box.every(Number.isFinite) ||
          !Array.isArray(p.pads) || p.pads.length > 500 || !p.pads.every(q => q && typeof q.num === 'string' &&
            typeof q.name === 'string' && [q.x,q.y].every(Number.isFinite) && size(q.w) && size(q.h))) {
        throw new Error('An assembly file footprint has invalid coordinates or pads.');
      }
    }
    return data;
  }

  const localPoint = ([x, y]) => [side === 'B' ? guide.w - x : x, y];
  const markerPoints = (w, h) => [[-inset,-inset],[w+inset,-inset],[w+inset,h+inset],[-inset,h+inset]];
  const xml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

  function alignmentSheet() {
    const b = 18, { w, h, name, outline } = guide;
    const markers = markerPoints(w,h).map(([x, y], i) =>
      '<rect fill="' + colors[i] + '" x="' + (x-markerSize/2) + '" y="' + (y-markerSize/2) +
      '" width="' + markerSize + '" height="' + markerSize + '"/>').join('');
    const poly = outline.map(localPoint).map(p => p.join(',')).join(' ');
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (w+2*b) + 'mm" height="' + (h+2*b) +
      'mm" viewBox="' + [-b,-b,w+2*b,h+2*b].join(' ') + '">' +
      '<rect x="' + -b + '" y="' + -b + '" width="' + (w+2*b) + '" height="' + (h+2*b) + '" fill="white"/>' + markers +
      '<polygon points="' + poly + '" fill="none" stroke="black" stroke-width=".25"/>' +
      '<text x="0" y="-3" font-size="2.4" font-family="sans-serif">' + xml(name.slice(0,40)) + ' · ' + (side === 'F' ? 'Top' : 'Bottom') +
      ' · align board top edge here</text><path d="M0 ' + (h+5) + 'h10" stroke="black" stroke-width=".3"/>' +
      '<text x="0" y="' + (h+8) + '" font-size="2.1" font-family="sans-serif">10 mm · print at 100%</text></svg>';
  }

  // Solve a planar projective transform in homogeneous coordinates.
  function homography(source, destination) {
    const system = source.flatMap(([x,y], i) => {
      const [u,v] = destination[i];
      return [[x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]];
    });
    for (let i=0; i<8; i++) {
      let pivot = i;
      for (let j=i+1; j<8; j++) if (Math.abs(system[j][i]) > Math.abs(system[pivot][i])) pivot=j;
      if (Math.abs(system[pivot][i]) < 1e-8) return null;
      [system[pivot],system[i]] = [system[i],system[pivot]];
      const row = system[i], scale = row[i];
      for (let k=i; k<9; k++) row[k] /= scale;
      for (let j=0; j<8; j++) {
        if (j === i) continue;
        const weight = system[j][i];
        for (let k=i; k<9; k++) system[j][k] -= weight*row[k];
      }
    }
    const [a,b,c,d,e,f,g,h] = system.map(r => r[8]);
    return ([x,y]) => [(a*x+b*y+c)/(g*x+h*y+1),(d*x+e*y+f)/(g*x+h*y+1)];
  }

  function detectMarkers({ data, width, height }) {
    const blobs = colors.map(() => ({ n:0,x:0,y:0,left:width,top:height,right:0,bottom:0 }));
    for (let i=0; i<data.length; i+=4) {
      const [r,g,b] = [data[i],data[i+1],data[i+2]], max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max-min;
      if (delta < 63 || max < 100) continue;
      const h = (360+60*(max===r ? (g-b)/delta : max===g ? 2+(b-r)/delta : 4+(r-g)/delta))%360;
      const label = hueCenters.findIndex(k => Math.min(Math.abs(h-k),360-Math.abs(h-k)) < 23);
      if (label < 0) continue;
      const z = blobs[label], p = i/4, x = p%width, y = Math.floor(p/width);
      z.n++; z.x+=x; z.y+=y;
      z.left=Math.min(z.left,x); z.right=Math.max(z.right,x); z.top=Math.min(z.top,y); z.bottom=Math.max(z.bottom,y);
    }
    if (blobs.some(z => {
      const w=z.right-z.left+1, h=z.bottom-z.top+1;
      return z.n<24 || z.n>width*height*.12 || z.n<w*h*.35 || w/h<.35 || w/h>2.85;
    })) return null;
    const marks = blobs.map(z => [z.x/z.n,z.y/z.n]);
    const turns = marks.map((a,i) => {
      const b=marks[(i+1)%4], c=marks[(i+2)%4];
      return (b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
    });
    return turns.every(n => n>width*height*.014) ? marks : null;
  }

  function draw(canvas, project, faint = false) {
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const map = p => project(localPoint(p));
    const trace = pts => {
      ctx.beginPath();
      pts.map(map).forEach(([x,y],i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
      ctx.closePath();
    };
    const box = ([x0,y0,x1,y1]) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
    trace(guide.outline);
    ctx.strokeStyle=faint?'#cbd5e1':'#64809d'; ctx.lineWidth=2; ctx.stroke();
    const part=selected();
    if (!part) return;
    if (!faint) for (const p of entries()) {
      trace(box(p.box)); ctx.strokeStyle='#50647a'; ctx.lineWidth=1; ctx.stroke();
    }
    trace(box(part.box)); ctx.fillStyle='#38dafe44'; ctx.fill(); ctx.strokeStyle='#38dafe'; ctx.lineWidth=3; ctx.stroke();
    const labels = pad => /^(?:K|A|\+|-)$/.test(pad.name) || pad.num === '1';
    for (const p of part.pads) {
      if (!labels(p)) continue;
      const [x,y]=map([p.x,p.y]);
      ctx.beginPath(); ctx.arc(x,y,5,0,2*Math.PI); ctx.fillStyle='#ffcf58'; ctx.fill();
      ctx.font='bold 13px system-ui'; ctx.lineWidth=3; ctx.strokeStyle='#162032'; ctx.fillStyle='#ffdc82';
      const label = p.name==='K'?'K':p.name==='A'?'A':p.name==='+'||p.name==='-'?p.name:p.num;
      ctx.strokeText(label,x+8,y-4); ctx.fillText(label,x+8,y-4);
    }
  }

  function renderAssembly() {
    $('benchMat').disabled=$('benchCamera').disabled=$('benchExportGuide').disabled=!guide;
    const parts=entries(), p=selected(), ix=cursor[side];
    $('benchBack').disabled=ix===0;
    $('benchPlaced').disabled=$('benchSkip').disabled=!p;
    $('benchPart').textContent=p ? p.ref+' · '+p.value+' · '+(side==='F'?'Top':'Bottom')+' · '+p.rot+'° in PCB view · '+(ix+1)+' / '+parts.length
      : parts.length ? 'End of '+(side==='F'?'top':'bottom')+' checklist' : 'No placed parts on this side';
    const c=$('benchMap');
    if (!guide) { c.getContext('2d').clearRect(0,0,c.width,c.height); return; }
    const k=Math.min((c.width-32)/guide.w,(c.height-32)/guide.h);
    draw(c,([x,y])=>[(c.width-k*guide.w)/2+k*x,(c.height-k*guide.h)/2+k*y]);
  }

  function setGuide(data, source) {
    validateGuide(data);
    if (source === guideSource && JSON.stringify(data) === JSON.stringify(guide)) return;
    stopCamera();
    guide=data;
    guideSource=source;
    cursor={F:0,B:0};
    side=guide.parts.some(p=>p.side==='F')?'F':'B';
    $('benchSide').value=side;
    status(guide.name+' · '+guide.w+' × '+guide.h+' mm');
    renderAssembly();
  }

  function stopCamera() {
    cameraRequest++;
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach(t=>t.stop());
    stream=null;
    $('benchVideo').srcObject=null;
    $('benchCameraView').hidden=true;
    $('benchMap').hidden=false;
    $('benchCamera').textContent='Start camera';
  }

  async function startCamera() {
    if (stream) { stopCamera(); status(guide.name); return; }
    if (!navigator.mediaDevices?.getUserMedia) { status('Camera access requires a secure page. Open your assembly file on pcbgo.site or use the 2D map.'); return; }
    const request=++cameraRequest, video=$('benchVideo'), canvas=$('benchOverlay');
    try {
      const local=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      if (request!==cameraRequest) { local.getTracks().forEach(t=>t.stop()); return; }
      stream=local; video.srcObject=local;
      await video.play();
      if (request!==cameraRequest) return;
      $('benchCameraView').hidden=false; $('benchMap').hidden=true; $('benchCamera').textContent='Stop camera';
      const sample=document.createElement('canvas'), ctx=sample.getContext('2d',{willReadFrequently:true});
      function tick(now) {
        if (!stream) return;
        frame=requestAnimationFrame(tick);
        if (now-lastFrame<85 || !video.videoWidth) return;
        lastFrame=now;
        canvas.width=sample.width=420;
        canvas.height=sample.height=Math.round(canvas.width*video.videoHeight/video.videoWidth);
        ctx.drawImage(video,0,0,sample.width,sample.height);
        const markers=detectMarkers(ctx.getImageData(0,0,sample.width,sample.height));
        const project=markers && homography(markerPoints(guide.w,guide.h),markers);
        if (project && guide.outline.every(p=>project(localPoint(p)).every(Number.isFinite))) {
          draw(canvas,project,true); status('Aligned · '+(side==='F'?'top':'bottom')+' side');
        } else {
          canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
          status('Alignment lost. Keep all four markers visible.');
        }
      }
      frame=requestAnimationFrame(tick);
    } catch (e) {
      if (request!==cameraRequest) return;
      stopCamera(); status('Could not start the camera. Check camera permission or use the 2D map.');
    }
  }

  function init() {
    const dlg=$('benchDialog');
    $('btnBench').onclick=()=>{
      if (guideSource !== 'file') {
        if (Pcb.placed().length) {
          try { setGuide(fromPCB(),'current'); } catch (e) { status(e.message); }
        } else {
          guide=null; cursor={F:0,B:0}; renderAssembly(); status('Use a PCB with placed parts or open an assembly file.');
        }
      }
      dlg.showModal();
      dlg.dispatchEvent(new Event('bench-open'));
    };
    $('benchClose').onclick=()=>dlg.close();
    dlg.addEventListener('close',stopCamera);
    dlg.querySelectorAll('[data-bench]').forEach(b=>b.onclick=()=>{
      stopCamera();
      dlg.querySelectorAll('[data-bench]').forEach(q=>q.setAttribute('aria-pressed',q===b?'true':'false'));
      for (const s of dlg.querySelectorAll('.bench-section')) s.hidden=s.id!=='bench-'+b.dataset.bench;
      dlg.dispatchEvent(new CustomEvent('bench-tab',{detail:b.dataset.bench}));
    });
    $('benchUseBoard').onclick=()=>{ try{setGuide(fromPCB(),'current');}catch(e){status(e.message);} };
    $('benchLoadGuide').onclick=()=>$('benchGuideFile').click();
    $('benchGuideFile').onchange=async e=>{
      const file=e.target.files[0]; e.target.value='';
      if (!file) return;
      try {
        if (file.size>20_000_000) throw new Error('This assembly file is too large.');
        setGuide(JSON.parse(await file.text()),'file');
      } catch(e) { status(e.message); }
    };
    $('benchExportGuide').onclick=()=>{if(guide) App.download(Exports.slug(guide.name)+'.assembly.json',JSON.stringify(guide),'application/json');};
    $('benchMat').onclick=()=>{if(guide) App.download(Exports.slug(guide.name)+'-'+(side==='F'?'top':'bottom')+'-alignment.svg',alignmentSheet(),'image/svg+xml');};
    $('benchCamera').onclick=startCamera;
    $('benchSide').onchange=()=>{
      stopCamera(); side=viewSide(); renderAssembly();
      if(guide) status('Selected '+(side==='F'?'top':'bottom')+' side. Align the physical board to that side’s sheet.');
    };
    for (const [id,d] of [['benchBack',-1],['benchPlaced',1],['benchSkip',1]]) $(id).onclick=()=>{
      cursor[side]=Math.max(0,Math.min(entries().length,cursor[side]+d)); renderAssembly();
    };
    status('Use the current PCB or open an assembly file.');
    renderAssembly();
  }
  window.addEventListener('DOMContentLoaded',init);
  return { homography, detectMarkers, fromPCB, validateGuide };
})();
