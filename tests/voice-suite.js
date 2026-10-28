// Voice tests. Usage: KM_FAKE_MEDIA=1 node voice-suite.js <app.html>
'use strict';
const { Harness } = require('./harness');
const T=[]; const test=(id,n,f)=>T.push({id,n,f}); const assert=(c,m)=>{ if(!c) throw new Error(m); };
const SPEAK_STUB=`window.__spoken=[]; if(window.speechSynthesis){ speechSynthesis.speak=u=>window.__spoken.push({text:u.text,lang:u.lang}); speechSynthesis.cancel=()=>{}; }`;
const SR_STUB=(phrase,err)=>`${SPEAK_STUB}
  window.webkitSpeechRecognition=class{ start(){ setTimeout(()=>{ ${err?`this.onerror&&this.onerror({error:'${err}'});`:`this.onresult&&this.onresult({results:[[{transcript:'${phrase}'}]]});`} setTimeout(()=>this.onend&&this.onend(),30); },80); } stop(){} };
  window.SpeechRecognition=undefined;`;
const NO_SR=`${SPEAK_STUB} window.webkitSpeechRecognition=undefined; window.SpeechRecognition=undefined;`;
async function user(h,opts){ h.server.addUser('a@test.com','password1'); const D=await h.device('a',opts); await D.goto(); await D.login('a@test.com','password1'); await D.wait(1000); await D.ev(()=>openAssistant()); return D; }
const lastTx=(D)=>D.ev(()=>data.transactions.filter(t=>(t.tags||[]).includes('ai')).map(t=>t.category+':'+t.amount));

test('V1','التعرّف الصوتي المباشر يسجّل الحركة ويرد بالصوت',async h=>{
  const D=await user(h,{initScript:SR_STUB('صرفت 60 فول')});
  await D.ev(()=>aiMic()); await D.wait(1500);
  assert(JSON.stringify(await lastTx(D))==='["فول:60"]','الحركات: '+JSON.stringify(await lastTx(D)));
  const m=await D.ev(()=>aiMsgs().find(x=>x.r==='user'));
  assert(m && m.voice,'رسالة المستخدم غير معلَّمة كصوتية');
  const sp=await D.ev(()=>window.__spoken);
  assert(sp.length===1 && sp[0].lang==='ar-EG','لم يُقرأ الرد بالعربي: '+JSON.stringify(sp));
});
test('V2','بدون تعرّف مباشر: تسجيل المقطع وتفريغه بـ Gemini',async h=>{
  const D=await user(h,{initScript:NO_SR, permissions:['microphone']});
  await D.ev(()=>aiMic()); await D.wait(1800);
  assert(await D.ev(()=>_voice.mode==='rec'),'لم يبدأ التسجيل');
  await D.ev(()=>aiMicStop()); await D.wait(2500);
  const tr=(await D.ev(()=>window.__aiLog||[])).find(x=>x.ev==='transcribe');
  assert(tr && tr.bytes>500 && /audio\//.test(tr.mime),'لم يُرسل الصوت للتفريغ: '+JSON.stringify(tr));
  assert(JSON.stringify(await lastTx(D))==='["طعمية:40"]','الحركات: '+JSON.stringify(await lastTx(D)));
  assert((await D.ev(()=>document.getElementById('aiMic').textContent))==='🎤','زر الميكروفون لم يرجع لحالته');
});
test('V3','الرسالة المكتوبة لا تُقرأ بالصوت افتراضياً، و"دايماً" تقرأها',async h=>{
  const D=await user(h,{initScript:NO_SR});
  await D.ev(async()=>{ await aiSend('صرفت 5 شاي'); });
  assert((await D.ev(()=>window.__spoken)).length===0,'قُرئ رد رسالة مكتوبة');
  await D.ev(async()=>{ aiSaveCfg({speak:'always'}); await aiSend('صرفت 6 شاي'); });
  assert((await D.ev(()=>window.__spoken)).length===1,'وضع "دايماً" لم يقرأ الرد');
});
test('V4','رفض إذن الميكروفون: رسالة واضحة ولا إرسال',async h=>{
  const D=await user(h,{initScript:SR_STUB('',`not-allowed`)});
  await D.ev(()=>aiMic()); await D.wait(800);
  const t=await D.ev(()=>document.getElementById('toast').textContent);
  assert(/الميكروفون/.test(t),'الرسالة: '+t);
  assert((await D.ev(()=>aiMsgs().length))===0,'أُرسل شيء رغم الرفض');
});
test('V5','زر 🔊 يعيد قراءة أي رد',async h=>{
  const D=await user(h,{initScript:NO_SR});
  await D.ev(async()=>{ await aiSend('أهلاً'); });
  const n=await D.ev(()=>document.querySelectorAll('#aiMsgs .ai-say').length);
  assert(n>=1,'لا يوجد زر 🔊');
  await D.ev(()=>document.querySelector('#aiMsgs .ai-say').click());
  assert((await D.ev(()=>window.__spoken)).length===1,'الزر لم يقرأ');
  await D.page.screenshot({path:__dirname+'/shot-voice.png'});
});
(async()=>{
  const h=new Harness(process.argv[2]); await h.start(); let p=0;
  for(const t of T){ h.server.reset(); let err=null; try{ await t.f(h); }catch(e){ err=e; }
    const pe=h.devices.flatMap(d=>d.logs.filter(l=>/pageerror/.test(l))); await h.closeDevices(); if(!err) p++;
    console.log(`${err?'FAIL':'PASS'}  ${t.id} ${t.n}${err?'\n        → '+err.message:''}${pe.length?'\n        ! '+pe[0]:''}`); }
  await h.stop(); console.log(`\n${p}/${T.length} passed`);
})();
