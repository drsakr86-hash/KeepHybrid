// Receipt + proactive tests. Usage: node pro-suite.js <app.html>
'use strict';
const { Harness } = require('./harness');
const T=[]; const test=(id,n,f)=>T.push({id,n,f}); const assert=(c,m)=>{ if(!c) throw new Error(m); };
async function user(h,opts){ if(!h.server.users.has('a@test.com')) h.server.addUser('a@test.com','password1'); const D=await h.device('a',opts); await D.goto(); await D.login('a@test.com','password1'); await D.wait(800); return D; }

test('RC1','صورة إيصال ← مصروف مسجّل، والصورة مصغّرة قبل الإرسال',async h=>{
  const D=await user(h);
  await D.ev(()=>{ aiSaveCfg({consent:true}); openAssistant(); });
  await D.page.setInputFiles('#aiReceipt', __dirname+'/receipt-big.png');
  await D.wait(2500);
  const tx=await D.ev(()=>data.transactions.find(t=>(t.tags||[]).includes('ai')));
  assert(tx && tx.amount===185 && tx.category==='سوبرماركت' && tx.description==='كارفور','الحركة: '+JSON.stringify(tx));
  const im=(await D.ev(()=>window.__aiLog)).find(x=>x.ev==='image');
  assert(im && im.mime==='image/jpeg' && im.bytes < 400000,'الصورة لم تُصغَّر: '+JSON.stringify(im));
  const m=await D.ev(()=>aiMsgs().map(x=>x.t).join('|'));
  assert(m.includes('📷 صورة إيصال') && !/base64|data:image/.test(m),'المحادثة تحفظ الصورة: '+m.slice(0,200));
  await D.page.screenshot({path:__dirname+'/shot-receipt.png'});
});
test('RC2','إيصال غير واضح: يسأل ولا يسجّل',async h=>{
  const D=await user(h,{initScript:'window.__receiptBad=true'});
  await D.ev(()=>{ aiSaveCfg({consent:true}); openAssistant(); });
  await D.page.setInputFiles('#aiReceipt', __dirname+'/receipt-big.png'); await D.wait(2500);
  assert(!(await D.ev(()=>data.transactions.some(t=>(t.tags||[]).includes('ai')))),'سُجّلت حركة من صورة غير واضحة');
  assert(/المبلغ كام/.test(await D.ev(()=>aiMsgs().filter(m=>m.r==='bot').pop().t)),'لم يسأل');
});
test('AL1','تنبيهات: ميزانية قربت + مستحق بكرة، والإخفاء يستمر بعد التحديث',async h=>{
  const D=await user(h);
  await D.ev(()=>{
    data.catBudgets={'طعام':1000}; save();
    addTransaction({type:'Expense',category:'طعام',amount:850});
    const tm=_localYMD(new Date(Date.now()+86400000));
    RecurRepo.add({title:'إيجار',category:'إيجار',type:'Expense',amount:5000,freq:'monthly',interval:1,startDate:tm,endDate:'',autoAdd:false,paused:false,skipNext:false,lastRun:''});
    refreshUI();
  });
  await D.wait(400);
  const txt=await D.ev(()=>document.getElementById('alertsCard').innerText);
  assert(/طعام/.test(txt) && /بكرة: إيجار/.test(txt),'التنبيهات: '+txt);
  await D.page.screenshot({path:__dirname+'/shot-alerts.png'});
  await D.ev(()=>{ const id=smartAlerts().find(a=>/إيجار/.test(a.text)).id; dismissAlert(id); });
  await D.reload(); await D.waitApp(); await D.wait(300);
  const txt2=await D.ev(()=>document.getElementById('alertsCard').innerText);
  assert(!/إيجار/.test(txt2) && /طعام/.test(txt2),'بعد الإخفاء: '+txt2);
});
test('AL2','زر 🤖 في التنبيه يفتح المساعد ويسأله',async h=>{
  const D=await user(h);
  await D.ev(()=>{ aiSaveCfg({consent:true}); data.catBudgets={'طعام':100}; save(); addTransaction({type:'Expense',category:'طعام',amount:150}); refreshUI(); });
  await D.wait(300);
  await D.ev(()=>document.querySelector('#alertsCard .al-btn').click()); await D.wait(800);
  const u=await D.ev(()=>aiMsgs().filter(m=>m.r==='user').map(m=>m.t));
  assert(u.some(t=>/طعام/.test(t)),'لم يُرسل سؤال التنبيه: '+u);
});
test('WK1','التقرير الأسبوعي: يُكتب مرة واحدة بأرقام حقيقية ويظهر في الرئيسية',async h=>{
  const D=await user(h);
  await D.ev(()=>{ aiSaveCfg({consent:true}); addTransaction({type:'Expense',category:'أكل',amount:420}); refreshUI(); });
  await D.reload(); await D.waitApp(); await D.wait(4000);
  const rep=await D.ev(()=>aiMsgs().filter(m=>m.report).map(m=>m.t));
  const exp=await D.ev(()=>weekStats().this_week.expense);
  assert(rep.length===1 && rep[0].includes(String(exp)),'التقرير: '+JSON.stringify(rep)+' exp='+exp);
  assert(await D.ev(()=>document.getElementById('weeklyCard').style.display!=='none'),'كارت التقرير غير ظاهر');
  await D.page.screenshot({path:__dirname+'/shot-weekly.png'});
  await D.reload(); await D.waitApp(); await D.wait(4000);
  assert((await D.ev(()=>aiMsgs().filter(m=>m.report).length))===1,'اتكتب تقرير تاني قبل 7 أيام');
});
test('WK2','بدون موافقة أو بدون نت: تقرير محلي بنفس الأرقام',async h=>{
  const D=await user(h);
  await D.ev(()=>{ addTransaction({type:'Expense',category:'مواصلات',amount:90}); addTransaction({type:'Income',category:'راتب',amount:5000}); refreshUI(); });
  const r=await D.ev(async()=>{ const x=await aiMaybeWeekly(true); return x; });
  assert(!r.byAI && /صرفت ٩٠٫٠٠|صرفت 90/.test(r.text) && /مواصلات/.test(r.text),'التقرير المحلي: '+r.text);
  const gen=(await D.ev(()=>window.__aiLog||[])).filter(x=>x.ev==='generate');
  assert(gen.length===0,'أُرسلت بيانات لـ Gemini بدون موافقة');
});
test('WK3','كتابة "تقرير الأسبوع" في المساعد تولّد التقرير فوراً',async h=>{
  const D=await user(h);
  await D.ev(()=>{ aiSaveCfg({consent:true}); addTransaction({type:'Expense',category:'قهوة',amount:33}); openAssistant(); });
  await D.ev(async()=>{ await aiSend('تقرير الأسبوع'); });
  const last=await D.ev(()=>aiMsgs().filter(m=>m.r==='bot').pop());
  assert(last && last.report && /تقرير الأسبوع/.test(last.t),'الرد: '+JSON.stringify(last));
});
test('ADV','المستشار مربوط بالمساعد: زر عام + زر لكل محور ضعيف + بيانات المحاور كاملة',async h=>{
  const D=await user(h);
  await D.ev(()=>{ aiSaveCfg({consent:true}); addTransaction({type:'Expense',category:'أكل',amount:500}); data.catBudgets={'أكل':2000}; save(); switchTab('chart'); switchAnalysis('advisor'); });
  await D.wait(400);
  const btns=await D.ev(()=>document.querySelectorAll('#scoreParts .al-btn').length);
  assert(btns>=3,'أزرار المحاور: '+btns);
  await D.page.screenshot({path:__dirname+'/shot-advisor.png'});
  await D.ev(()=>askAdvisor()); await D.wait(1500);
  const u=await D.ev(()=>aiMsgs().filter(m=>m.r==='user').pop().t);
  const sc=await D.ev(()=>HE.score(cur_month()).score);
  assert(u.includes(String(sc)),'السؤال لا يحمل الدرجة: '+u);
  const ov=(await D.ev(()=>window.__aiLog)).filter(x=>x.ev==='toolResults').flatMap(x=>x.results).find(r=>r.name==='get_overview');
  assert(ov && ov.response.health.axes.length===6 && ov.response.health.how_computed,'بيانات المستشار ناقصة للنموذج');
  await D.ev(()=>{ switchTab('chart'); switchAnalysis('advisor'); }); await D.wait(300);
  await D.ev(()=>document.querySelector('#scoreParts .al-btn').click()); await D.wait(1200);
  const u2=await D.ev(()=>aiMsgs().filter(m=>m.r==='user').pop().t);
  assert(/محور/.test(u2),'سؤال المحور: '+u2);
});
(async()=>{
  const h=new Harness(process.argv[2]); await h.start(); let p=0;
  for(const t of T){ h.server.reset(); let err=null; try{ await t.f(h); }catch(e){ err=e; }
    const pe=h.devices.flatMap(d=>d.logs.filter(l=>/pageerror/.test(l))); await h.closeDevices(); if(!err) p++;
    console.log(`${err?'FAIL':'PASS'}  ${t.id} ${t.n}${err?'\n        → '+err.message:''}${pe.length?'\n        ! '+pe[0]:''}`); }
  await h.stop(); console.log(`\n${p}/${T.length} passed`);
})();
