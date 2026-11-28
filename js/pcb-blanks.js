'use strict';

const PcbBlanks = (() => {
  const $ = id => document.getElementById(id);
  const presets = {
    small:[30,24], compact:[40,30], medium:[50,35], large:[70,45],
    ic:[80,55,40,26], wide:[95,45,32,20]
  };
  const libraryKey = 'cp.pcbBlanks.v1';
  const gap = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const headerPins = c => +(/^PinHeader_1x([1-4])$/.exec(c.footprint)?.[1] || 0);
  const activeParts = () => Model.S.components.filter(c=>Pcb.onActivePcb(c));

  function template(size,usb) {
    const [w,h,cw,ch] = presets[size];
    const clear = cw ? {x:(w-cw)/2,y:(h-ch)/2,w:cw,h:ch} : null;
    const blank = geometry(w,h,1.6,3,3,3,usb);
    blank.sites = gridSites(blank,5,clear);
    return {...blank,preset:size,clear,id:'PB-'+w+'x'+h+(cw?'-IC':'')+(usb?'-USB4':'')+'-R1'};
  }

  function geometry(w,h,thickness,ix,iy,diameter,usb) {
    const holes = [{x:ix,y:h-iy,d:diameter},{x:w-ix,y:h-iy,d:diameter}];
    const port = usb ? {x:w-4,y:h/2,rot:0} : null;
    const header = usb ? Lib.footprint('PinHeader_1x4').pads.map(p=>({
      pin:String(p.num), x:port.x+p.x, y:+(port.y+p.y).toFixed(3), d:p.w, drill:p.drill
    })) : [];
    return {version:1,w,h,thickness,copperInset:.35,header,port,holes};
  }

  function gridSites(blank,pitch,clear) {
    const {w,h,holes,header}=blank, sites=[];
    for(let j=0;4+j*pitch<=h-4;j++) for(let i=0;4+i*pitch<=w-4;i++) {
      const x=+(4+i*pitch).toFixed(3), y=+(4+j*pitch).toFixed(3), large=(i+j)%2===1;
      const p={x,y,d:large?1.3:.9,drill:large?.65:.4};
      if (holes.some(q=>gap(q,p)<q.d/2+p.d/2+.65) || header.some(q=>gap(q,p)<q.d/2+p.d/2+.8)) continue;
      if (clear && Math.hypot(Math.max(0,clear.x-x,x-clear.x-clear.w),Math.max(0,clear.y-y,y-clear.y-clear.h))<p.d/2+.5) continue;
      sites.push(p);
    }
    return sites;
  }

  function blankInputs(input) {
    const read=(value,min,max,label)=>{
      const n=+value;
      if (!Number.isFinite(n) || n<min || n>max) throw new Error(label+' must be '+min+'–'+max+' mm.');
      return +n.toFixed(3);
    };
    const w=read(input.w,18,100,'Width'), h=read(input.h,18,80,'Height');
    const t=read(input.thickness,.6,3.2,'Thickness'), d=read(input.hole,1.5,4,'Registration hole diameter');
    const x=read(input.insetX,d/2+.8,w/2-d/2-.8,'Registration inset from left and right');
    const y=read(input.insetY,d/2+.8,h-d/2-.8,'Registration inset from bottom');
    const blank=geometry(w,h,t,x,y,d,input.usb);
    if (blank.header.some(p=>blank.holes.some(q=>gap(p,q)<(p.d+q.d)/2+.8))) throw new Error('Move the registration holes away from the USB-C header.');
    return blank;
  }

  function customTemplate(input) {
    const name=String(input.name||'').trim().slice(0,48);
    if (!name) throw new Error('Enter a template name.');
    const blank=blankInputs(input);
    const lines=String(input.sites||'').trim().split(/\r?\n/).filter(line=>line.trim());
    if (!lines.length || lines.length>500) throw new Error('Enter between 1 and 500 plated via sites.');
    const sites=[];
    for (const [i,line] of lines.entries()) {
      const numbers=line.trim().split(/[\s,]+/).map(Number);
      if (numbers.length!==4 || numbers.some(n=>!Number.isFinite(n))) throw new Error('Via row '+(i+1)+' needs X, Y, pad diameter and drill diameter.');
      const [x,y,d,drill]=numbers.map(n=>+n.toFixed(3));
      if (drill<.4 || drill>1.25 || d<.9 || d>2.5 || (d-drill)/2<.17-1e-6) throw new Error('Via row '+(i+1)+' needs a 0.40–1.25 mm drill, a 0.90–2.50 mm pad and at least 0.17 mm of copper around the drill.');
      if (Math.min(x,y,blank.w-x,blank.h-y)<d/2+.7) throw new Error('Via row '+(i+1)+' is outside the board or too close to the edge.');
      const p={x,y,d,drill};
      if ([...blank.holes,...blank.header,...sites].some(q=>gap(p,q)<(p.d+q.d)/2+.45-1e-6)) throw new Error('Via row '+(i+1)+' is too close to another hole.');
      sites.push(p);
    }
    const design={...blank,sites};
    let hash=2166136261;
    for (const ch of JSON.stringify(design)) hash=Math.imul(hash^ch.charCodeAt(0),16777619);
    return {...design,name,id:'PB-CUSTOM-'+(hash>>>0).toString(16).toUpperCase()};
  }

  function fabFiles(b) {
    const xy=p=>'X'+Math.round(p.x*1e6)+'Y'+Math.round((b.h-p.y)*1e6);
    const rectangle=(e=0)=>[{x:e,y:e},{x:b.w-e,y:e},{x:b.w-e,y:b.h-e},{x:e,y:b.h-e},{x:e,y:e}];
    const line=ps=>ps.map((p,i)=>xy(p)+(i?'D01*':'D02*'));
    const gerber=(fn,body,apertures=[])=>['G04 CircuitPilot PCB Blank '+b.id+'*','%TF.FileFunction,'+fn+'*%',
      '%FSLAX46Y46*%','%MOMM*%','%LPD*%','%ADD10C,0.100000*%',...apertures,'G01*','D10*',...body,'M02*'].join('\n')+'\n';
    const region=e=>['G36*',...line(rectangle(e)),'G37*'];
    const copper=fn=>{
      const aps=b.holes.map((p,i)=>'%ADD'+(11+i)+'C,'+(p.d+2*b.copperInset).toFixed(6)+'*%');
      const remove=b.holes.flatMap((p,i)=>['D'+(11+i)+'*',xy(p)+'D03*']);
      return gerber(fn,[...region(b.copperInset),'%LPC*%',...remove,'%LPD*%'],aps);
    };
    const drills=(holes,kind)=>{
      const d=[...new Set(holes.map(h=>h.drill||h.d))].sort((a,b)=>a-b);
      const tools=d.map((n,i)=>'T'+(i+1)+'C'+n.toFixed(3));
      const hits=d.flatMap((n,i)=>['T'+(i+1),...holes.filter(p=>(p.drill||p.d)===n).map(p=>'X'+p.x.toFixed(3)+'Y'+(b.h-p.y).toFixed(3))]);
      return ['M48',';TYPE='+kind,'METRIC,TZ',...tools,'%','G90','G05',...hits,'M30',''].join('\n');
    };
    return {
      'board-F_Cu.gtl':copper('Copper,L1,Top'), 'board-B_Cu.gbl':copper('Copper,L2,Bot'),
      'board-F_Mask.gts':gerber('Soldermask,Top',region(0)), 'board-B_Mask.gbs':gerber('Soldermask,Bot',region(0)),
      'board-Edge_Cuts.gm1':gerber('Profile,NP',line(rectangle())),
      'board-PTH.drl':drills([...b.sites,...b.header],'PLATED'),
      'board-NPTH.drl':drills(b.holes,'NON_PLATED')
    };
  }

  function apply(blank,ref) {
    return Model.mutate(()=>{
      const S=Model.S, parts=activeParts();
      if (!parts.length) throw new Error('Add the circuit to its schematic before mapping it to a blank.');
      const headers=parts.filter(headerPins);
      const header=ref ? headers.find(c=>c.ref===ref) : blank.port && headers.length===1 ? headers[0] : null;
      if (ref && (!blank.port || !header)) throw new Error('Choose a 1 × 1 to 1 × 4, 2.54 mm header from the open board.');
      const unsupported=parts.find(c=>c!==header && Lib.footprint(c.footprint)?.pads.some(p=>p.drill));
      if (unsupported) {
        if (headerPins(unsupported) && !blank.port) throw new Error('Enable USB-C breakout header to map '+unsupported.ref+' to its plated holes.');
        if (headerPins(unsupported)) throw new Error('This blank has one plated header position. Assign one header and use SMD footprints for the others.');
        throw new Error(unsupported.ref+' has a through-hole footprint this blank does not support. Choose an SMD footprint.');
      }
      S.board = {w:blank.w,h:blank.h,stock:blank};
      S.rules = {...S.rules,preset:'cnc3018',layers:2,cnc:true,traceWidth:.55,powerTraceWidth:.7,
        minTraceWidth:.36,clearance:.45,edgeClearance:.7,minEdgeClearance:.5,noViaInPad:true,viaInPad:false,
        minHoleSize:.4,minViaDrill:.4,viaDrill:.65,minViaDiameter:.9,viaDiameter:1.3,minAnnularRing:.17,
        minPthRing:.25,minHoleToHole:.4,neckDown:true,maskExpansion:0};
      S.pcb = {traces:[],vias:[],routed:{},holes:blank.holes.map(h=>({...h,locked:true}))};
      if (header) {
        delete header.pcbEdge;
        // Align pin 1 with the first factory hole, including for shorter headers.
        const last=blank.header[headerPins(header)-1];
        header.pcb={...blank.port,y:+((blank.header[0].y+last.y)/2).toFixed(3),side:'F',locked:true};
      }
      const result = Pcb.autoPlace({w:blank.w,h:blank.h});
      if (result?.fits === false || Pcb.pendingFootprints().length) throw new Error('The parts do not fit this blank. Choose a larger size.');
      Pcb.stockCheck();
      return Pcb.status();
    });
  }

  function init() {
    const dialog=$('pcbBlanksDialog'), select=$('blankSize'), option=$('blankUsb'), ref=$('blankHeader');
    const editor=$('blankCustom'), details=$('blankDetails');
    const showEditor=on=>{editor.hidden=!on; details.hidden=on;};
    let saved=[];
    try { saved=JSON.parse(localStorage.getItem(libraryKey)||'[]'); } catch (e) { }
    if (!Array.isArray(saved)) saved=[];
    saved=saved.filter(b=>b?.id?.startsWith('PB-CUSTOM-') && Array.isArray(b.sites));
    const custom=()=>select.value==='current' ? Model.S.board.stock : saved.find(b=>b.id===select.value);
    const chosen=()=>custom()||template(select.value,option.checked);
    const updateOptions=()=>{
      [...select.options].filter(opt=>opt.hasAttribute('data-saved')).forEach(opt=>opt.remove());
      const stock=Model.S.board.stock;
      const items=saved.map(b=>[b.id,b.name+' · '+b.w+' × '+b.h+' mm']);
      if (stock && !presets[stock.preset] && !Object.values(presets).some(p=>!p[2] && p[0]===stock.w && p[1]===stock.h && /^PB-\d/.test(stock.id)) && !saved.some(b=>b.id===stock.id)) {
        items.push(['current',(stock.name||stock.id)+' · From this project']);
      }
      for (const [id,label] of items) {
        const opt=new Option(label,id); opt.setAttribute('data-saved',''); select.add(opt);
      }
    };
    const readCustom=()=>{
      const fields={name:'Name',w:'W',h:'H',thickness:'Thick',hole:'Hole',insetX:'InsetX',insetY:'InsetY',sites:'Sites'};
      return {...Object.fromEntries(Object.entries(fields).map(([key,id])=>[key,$('blank'+id).value])),usb:$('blankCustomUsb').checked};
    };
    const render=()=>{
      const b=chosen(), svg=$('blankMap');
      $('blankUsbRow').hidden=!!custom();
      svg.setAttribute('viewBox',[-1,-1,b.w+2,b.h+2].join(' '));
      svg.innerHTML='<rect x="0" y="0" rx=".4" width="'+b.w+'" height="'+b.h+'" fill="#16464a" stroke="#64bcaf" stroke-width=".2"/>'+
        (b.clear ? '<rect x="'+b.clear.x+'" y="'+b.clear.y+'" width="'+b.clear.w+'" height="'+b.clear.h+'" fill="#29595b" stroke="#7dd6c3" stroke-width=".2" stroke-dasharray="1 .6"/><text x="'+b.w/2+'" y="'+b.h/2+'" dominant-baseline="middle" text-anchor="middle" fill="#d8f7ef" font-size="2">IC workspace</text>' : '')+
        [...b.sites,...b.header,...b.holes].map(p=>{
          const ring=p.drill ? '<circle cx="'+p.x+'" cy="'+p.y+'" r="'+p.d/2+'" fill="'+(p.pin?'#ffc87a':'#7dd6c3')+'"/>' : '';
          return ring+'<circle cx="'+p.x+'" cy="'+p.y+'" r="'+(p.drill||p.d)/2+'" fill="#142434"/>';
        }).join('');
      $('blankSummary').textContent=b.id+' · '+b.sites.length+' plated via sites · two '+b.holes[0].d+' mm registration holes'+
        (b.clear?' · '+b.clear.w+' × '+b.clear.h+' mm clear center':'')+(b.port?' · USB-C breakout header':'');
      const options=activeParts().filter(headerPins);
      const current=ref.value;
      ref.replaceChildren(new Option('Leave factory header unused',''),...options.map(c=>new Option(c.ref+' · '+c.value,c.ref)));
      if (options.some(c=>c.ref===current)) ref.value=current;
      else if (b.port && options.length===1) ref.value=options[0].ref;
      $('blankHeaderRow').hidden=!b.port;
      $('blankStatus').textContent=Model.S.board.stock ? 'Current board uses '+Model.S.board.stock.id+'.' : '';
      $('blankMapApply').disabled=!activeParts().length;
      return b;
    };
    $('btnPcbBlanks').onclick=()=>{
      const stock=Model.S.board.stock;
      const previous=select.value;
      updateOptions();
      if (stock) {
        const legacy=/^PB-\d/.test(stock.id) && Object.keys(presets).find(s=>presets[s][0]===stock.w && presets[s][1]===stock.h);
        select.value=saved.some(b=>b.id===stock.id)?stock.id:stock.preset||legacy||'current';
        option.checked=!!stock.port;
      } else {
        if ([...select.options].some(opt=>opt.value===previous)) select.value=previous;
        option.checked=activeParts().some(headerPins);
      }
      if (!select.value) select.value='small';
      showEditor(false);
      render();
      dialog.showModal();
    };
    $('blankClose').onclick=()=>dialog.close();
    select.onchange=option.onchange=render;
    $('blankNew').onclick=()=>{ showEditor(true); $('blankCustomStatus').textContent=''; $('blankName').focus(); };
    $('blankCancel').onclick=()=>{ showEditor(false); $('blankNew').focus(); };
    $('blankGrid').onclick=()=>{
      try {
        const sites=gridSites(blankInputs(readCustom()),5);
        $('blankSites').value=sites.map(p=>[p.x,p.y,p.d,p.drill].join(', ')).join('\n');
        $('blankCustomStatus').textContent='Filled '+sites.length+' via sites. Edit the list to match your blank.';
      } catch (e) { $('blankCustomStatus').textContent=e.message; }
    };
    $('blankSave').onclick=()=>{
      try {
        const b=customTemplate(readCustom());
        const next=[...saved.filter(p=>p.id!==b.id),b];
        localStorage.setItem(libraryKey,JSON.stringify(next));
        saved=next;
        updateOptions(); select.value=b.id; showEditor(false); render();
        $('blankStatus').textContent=b.name+' saved in this browser.';
      } catch (e) { $('blankCustomStatus').textContent=e.message; }
    };
    $('blankFab').onclick=()=>{
      const b=chosen();
      const files=fabFiles(b);
      files['README-fabricator.txt']=[
        'Reusable plated PCB Blank '+b.id,
        b.w+' x '+b.h+' mm, two-layer, '+b.thickness+' mm FR-4. Both copper faces must be exposed for isolation milling.',
        'Order with plated vias open, no via filling or tenting, no solder mask on either face, and no silkscreen.',
        'Use the separate plated drill and non-plated registration drill files. Confirm both faces have continuous copper and review the drill count in the fabricator preview.',
        b.port ? 'The four plated holes are a position for a separate standard-pitch USB-C breakout or a wired header. Do not assemble a USB-C receptacle onto this blank.' : 'No connector footprint is included.',
        'The raw blank has a continuous copper sheet on each face and the plated via holes join them. Finish both faces before applying power.',
      ].join('\n');
      App.download(b.id+'-factory.zip',makeZip(files),'application/zip');
      $('blankStatus').textContent='Factory files saved for '+b.id+'.';
    };
    $('blankMapApply').onclick=()=>{
      const b=chosen();
      try {
        apply(b,b.port?ref.value:undefined);
        App.showView('pcb'); Pcb.fit();
        dialog.close();
        App.toast('Mapped to '+b.id+'. Click Route, then CNC to export both sides.',8500);
      } catch (e) { $('blankStatus').textContent=e.message; }
    };
  }

  window.addEventListener('DOMContentLoaded',init);
  return {template,customTemplate,fabFiles,apply};
})();
