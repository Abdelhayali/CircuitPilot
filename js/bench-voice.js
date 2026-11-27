'use strict';

const BenchVoice = (() => {
  const $ = id => document.getElementById(id);
  const numbers={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,
    thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};
  let recognition, wantsVoice=false, recognizing=false, speaking=false, restart, step=0, project;
  const status=s=>$('benchVoiceStatus').textContent=s;
  const notes=()=>Model.S.notes?.values||{};
  const steps=()=>Array.isArray(notes().bringup_steps)?notes().bringup_steps.filter(x=>typeof x==='string'&&x.trim()):[];
  const voltages=()=>notes().expected_voltages||{};
  const countWord=word=>Object.hasOwn(numbers,word.toLowerCase())?String(numbers[word.toLowerCase()]):word;
  function normalize(text) {
    return text.replace(/[’‘]/g,"'").replace(/\btest point\b/gi,'TP').replace(/\byou\s+(?=\d|[a-z]+\b)/gi,'U ')
      .replace(/\b(U|TP|R|C|D|J|Q|L)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,(_,ref,n)=>ref+countWord(n));
  }

  function read(question) {
    const measurement = BenchBringup.answer(question);
    if (measurement) return measurement;
    const q=normalize(question).trim();
    const next=/\b(?:next(?:\s+(?:bring[- ]?up|checklist))?\s+step|next|step\s+of\s+bring[- ]?up)\b/i.test(q);
    if (next && !/\bpin\b/i.test(q)) {
      const checklist = BenchBringup.next();
      if (checklist) return checklist;
      const list=steps();
      if (!list.length) return 'This project has no bring-up checklist. Add its steps in Bench notes.';
      if (step>=list.length) return 'All '+list.length+' bring-up steps have been read.';
      return 'Step '+(step+1)+' of '+list.length+'. '+list[step++];
    }
    const re=/\b[A-Z][A-Z_-]*\d+[A-Z]?\b/gi;
    const refs=[...q.matchAll(re)];
    const ref=refs.map(m=>Model.comp(m[0])).find(Boolean);
    if (!ref) return refs.length?'I could not find '+refs[0][0].toUpperCase()+' in the open project.':'Ask for a reference and pin, a test point voltage, or the next bring-up step.';
    const match=/(?:\bpin\s+([A-Za-z]\d+|\d+|[a-z]+)\b|\b[A-Z][A-Z0-9_-]*\.(\w+)\b)/i.exec(q);
    const wanted=match && countWord(match[1]||match[2]);
    const pins=Model.pinsWorld(ref);
    const pin=wanted?pins.find(p=>String(p.num).toUpperCase()===wanted.toUpperCase()):pins.length===1?pins[0]:null;
    const net=pin&&Model.netOf(pin.key);
    if (wanted&&!pin) return ref.ref+' has no pin '+wanted+' in this project.';
    if (/\b(?:voltage|volts?|measure|reading|show)\b/i.test(q)) {
      const range=BenchBringup.expected(pin?.key);
      if (range) return range;
      const expected=Object.entries(voltages()).find(([key])=>[pin?.key,ref.ref,net].some(k=>typeof k==='string'&&k.toUpperCase()===key.toUpperCase()));
      if (expected) return 'The project notes specify '+String(expected[1])+' at '+expected[0]+'. That is the expected value.';
      if (!pin) return ref.ref+' has multiple pins. Specify the pin to check its net and expected voltage.';
      if (!net) return pin.key+' has no assigned net or expected voltage.';
      if (Model.isGround(net)) return pin.key+' is on '+net+'. Its nominal reference is 0 volts relative to board ground.';
      const rail=/^([+-]?\d+)(?:[Vv](\d+)|(?:\.(\d+))?[Vv])$/.exec(net);
      if (rail) return pin.key+' is on '+net+'. The net name suggests '+rail[1]+((rail[2]||rail[3])?'.'+(rail[2]||rail[3]):'')+' volts nominal. No measured voltage is recorded.';
      return pin.key+' is on '+net+'. The project does not specify its expected voltage.';
    }
    if (!pin) return ref.ref+' is '+ref.value+'. Specify a pin number to check a connection.';
    return pin.key+' is '+(pin.name&&pin.name!==String(pin.num)?pin.name+', ':'')+(net?'connected to '+net+'.':'unconnected in the schematic.');
  }

  function syncProject() {
    if (project===Model.S) return;
    project=Model.S; step=0;
    $('benchSteps').value=steps().join('\n');
    $('benchVoltages').value=Object.entries(voltages()).map(([k,v])=>k+' = '+v).join('\n');
  }

  function renderListening() {
    $('benchListen').textContent=wantsVoice?'Stop listening':'Start listening';
    $('benchListen').setAttribute('aria-pressed',String(wantsVoice));
  }
  function schedule() {
    clearTimeout(restart);
    if (wantsVoice&&!recognizing&&!speaking) restart=setTimeout(()=>{
      if(!wantsVoice||recognizing||speaking) return;
      try { recognition.start(); } catch(e) { stop(); status('Microphone could not restart. Use Start listening or type a question.'); }
    },300);
  }
  function stop() {
    BenchBringup.clearPending();
    wantsVoice=false; clearTimeout(restart);
    if (recognizing) recognition.abort();
    if (speaking) speechSynthesis.cancel();
    speaking=false; renderListening();
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) { status('This browser cannot read answers aloud.'); schedule(); return; }
    if (speaking) speechSynthesis.cancel();
    const utterance=new SpeechSynthesisUtterance(text);
    speaking=true;
    if (recognizing) recognition.stop();
    utterance.onend=utterance.onerror=()=>{
      speaking=false; status(wantsVoice?'Listening for the next question…':''); schedule();
    };
    speechSynthesis.speak(utterance);
  }

  function answer(q) {
    syncProject();
    let result;
    try { result=read(q); } catch(e) { result=e.message; }
    $('benchVoiceAnswer').textContent=result;
    speak(result);
  }

  function init() {
    const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
    if (Speech) {
      recognition=new Speech();
      recognition.lang='en-US';
      recognition.continuous=false;
      recognition.interimResults=false;
      recognition.onstart=()=>{recognizing=true;status('Listening…');};
      recognition.onend=()=>{recognizing=false;schedule();};
      recognition.onresult=e=>{
        if(!wantsVoice) return;
        const q=e.results[e.resultIndex]?.[0]?.transcript;
        if(q) { $('benchQuestion').value=q; answer(q); }
      };
      recognition.onerror=e=>{
        if(e.error==='no-speech'||e.error==='aborted') return;
        stop(); status('Microphone unavailable ('+e.error+'). You can type a question.');
      };
    } else {
      $('benchListen').disabled=true;
      status('Speech recognition is unavailable in this browser. Type a question below.');
    }
    $('benchListen').onclick=()=>{
      if(wantsVoice) { stop(); status('Listening stopped.'); return; }
      wantsVoice=true;renderListening();schedule();
    };
    $('benchSpeak').onclick=()=>{
      const text=$('benchVoiceAnswer').textContent;
      if(text) speak(text);
    };
    $('benchQuestionForm').onsubmit=e=>{e.preventDefault();answer($('benchQuestion').value);};
    $('benchSaveNotes').onclick=()=>{
      syncProject();
      const entries=$('benchVoltages').value.split(/\r?\n/).filter(s=>s.trim());
      const out=Object.create(null);
      for (const line of entries) {
        const m=/^\s*([A-Za-z0-9_.+-]+)\s*=\s*([+-]?\d+(?:\.\d+)?\s*(?:mV|V)?)\s*$/i.exec(line);
        if(!m) { status('Use a line like TP4 = 1.8 V.');return; }
        out[m[1]]=m[2];
      }
      try {
        Model.mutate(()=>{
          Model.S.notes={...Model.S.notes,values:{...notes(),expected_voltages:out,
            bringup_steps:$('benchSteps').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)}};
        });
        step=0;status('Bench notes saved to this project.');
      } catch(e) { status(e.message); }
    };
    $('benchResetSteps').onclick=()=>{step=0;status('Bring-up checklist restarted.');};
    $('benchDialog').addEventListener('bench-tab',e=>{if(e.detail==='voice') syncProject();else stop();});
    $('benchDialog').addEventListener('close',stop);
  }

  window.addEventListener('DOMContentLoaded',init);
  return {read};
})();
