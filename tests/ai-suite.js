// Assistant test-suite (mocked Firebase AI Logic). Usage: node ai-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const { Harness, until } = require('./harness');
const T = []; const test=(id,name,fn)=>T.push({id,name,fn});
const assert=(c,m)=>{ if(!c) throw new Error(m); };

async function user(h, email='a@test.com', opts){
  const uid=h.server.users.has(email) ? h.server.users.get(email).uid : h.server.addUser(email,'password1');
  const D=await h.device(email.split('@')[0], opts); await D.goto(); await D.login(email,'password1'); await D.wait(1200);
  return { D, uid };
}
const send=(D,t)=>D.ev(async t=>{ await aiSend(t); }, t);
const msgs=(D)=>D.ev(()=>aiMsgs().map(m=>({r:m.r,t:m.t,undone:!!m.undone,txId:m.txId||null})));
const log=(D)=>D.ev(()=>window.__aiLog||[]);
const lastBot=async(D)=>{ const m=await msgs(D); const b=m.filter(x=>x.r==='bot'||x.r==='err'); return b.length?b[b.length-1]:null; };

test('A1','تسجيل مصروف من الكلام يحفظ ويزامن ويعرض إيصال',async h=>{
  const {D,uid}=await user(h);
  await D.ev(()=>openAssistant());
  await send(D,'صرفت ٣٠٠ بنزين');
  const tx=await D.ev(()=>data.transactions.find(t=>t.category==='بنزين'));
  assert(tx && tx.amount===300 && tx.type==='Expense' && tx.tags.includes('ai'),'الحركة لم تُسجَّل صحيحة: '+JSON.stringify(tx));
  const m=await msgs(D);
  assert(m.some(x=>x.r==='act' && /سُجّل مصروف/.test(x.t)),'لا يوجد إيصال تسجيل');
  assert(/تمام/.test((await lastBot(D)).t),'لا رد من المساعد');
  await D.wait(1500);
  assert((h.cloudTxIds(uid)||[]).includes(tx.id),'حركة المساعد لم تتزامن للسحابة');
  const visible=await D.ev(()=>document.getElementById('aiBar').classList.contains('show') && document.querySelectorAll('#aiMsgs .ai-act').length>0);
  assert(visible,'الواجهة لا تعرض الإيصال أو شريط الكتابة');
});

test('A2','عدة مبالغ في رسالة واحدة = عدة حركات',async h=>{
  const {D}=await user(h);
  await send(D,'صرفت 50 قهوة و 120 أكل');
  const n=await D.ev(()=>data.transactions.filter(t=>(t.tags||[]).includes('ai')).map(t=>t.category+':'+t.amount).sort());
  assert(JSON.stringify(n)===JSON.stringify(['أكل:120','قهوة:50']),'الحركات: '+n);
});

test('A3','التراجع يحذف الحركة محلياً وسحابياً بلا عودة',async h=>{
  const {D,uid}=await user(h);
  await send(D,'صرفت 77 مواصلات'); await D.wait(1500);
  const id=await D.ev(()=>data.transactions.find(t=>t.category==='مواصلات').id);
  assert((h.cloudTxIds(uid)||[]).includes(id),'لم تتزامن قبل التراجع');
  await D.ev(()=>{ const i=aiMsgs().findIndex(m=>m.r==='act'); aiUndo(i); });
  await D.wait(1600);
  assert(!(await D.txIds()).includes(id),'الحركة باقية محلياً');
  assert(!(h.cloudTxIds(uid)||[]).includes(id),'الحركة باقية في السحابة');
  const B=await h.device('b'); await B.goto(); await B.login('a@test.com','password1'); await B.wait(1200);
  assert(!(await B.txIds()).includes(id),'الحركة الملغاة ظهرت على جهاز آخر');
  assert((await msgs(D)).some(m=>m.r==='act'&&m.undone),'الإيصال لم يُعلَّم كملغى');
});

test('A4','الإجابات من أرقام حقيقية والنموذج لا يرى البيانات كاملة',async h=>{
  const {D}=await user(h);
  await D.ev(()=>{ addTransaction({type:'Income',category:'راتب',amount:15000}); addTransaction({type:'Expense',category:'إيجار',amount:4000}); refreshUI(); });
  await send(D,'مصاريفي الشهر ده عاملة إزاي؟');
  const exp=await D.ev(()=>Q.monthTotals(cur_month()).exp);
  const b=await lastBot(D);
  assert(b && b.t.includes(String(exp)),`الرد لا يحمل المصروف الحقيقي ${exp}: ${b&&b.t}`);
  const lg=await log(D);
  const r=lg.filter(x=>x.ev==='toolResults').flatMap(x=>x.results).find(x=>x.name==='get_overview');
  assert(r && !('transactions' in r.response) && !JSON.stringify(r.response).includes('"tags"'),'ملخص الأداة يسرّب الحركات الخام');
  const sc=lg.find(x=>x.ev==='startChat');
  assert(sc.tools.join()==='add_transaction,find_transactions,get_overview,set_budget,delete_transaction','الأدوات: '+sc.tools);
  assert(sc.system.includes(await D.ev(()=>today_str())) && sc.system.includes('إيجار'),'تعليمات النظام بلا تاريخ اليوم أو الفئات');
});

test('A5','ضبط ميزانية من الكلام',async h=>{
  const {D}=await user(h);
  await send(D,'حط ميزانية 2000 للأكل');
  const v=await D.ev(()=>data.catBudgets['أكل']);
  assert(v===2000,'الميزانية: '+v);
});

test('A6','حذف آخر مصروف عبر البحث ثم الحذف',async h=>{
  const {D}=await user(h);
  const id=await D.addTx({amount:999,category:'غلطة',date:'2099-01-01'});
  await send(D,'امسح آخر مصروف');
  assert(!(await D.txIds()).includes(id),'لم تُحذف الحركة');
  assert((await msgs(D)).some(m=>m.r==='act'&&/حُذف/.test(m.t)),'لا إيصال حذف');
});

test('A6b','الحذف يطلب موافقة ويحفظ نسخة، والرفض يمنعه',async h=>{
  const {D}=await user(h,'a@test.com',{ dialogAnswer:d=>/يحذف حركات/.test(d.message())?false:true });
  const id=await D.addTx({amount:888,category:'مهم',date:'2099-01-01'});
  await send(D,'امسح آخر مصروف');
  assert((await D.txIds()).includes(id),'حُذفت الحركة رغم رفض المستخدم');
  assert(D.dialogs.some(d=>/يحذف حركات/.test(d.msg)),'لم تُطلب موافقة');
  const D2=(await user(h,'b@test.com')).D;
  const id2=await D2.addTx({amount:777,category:'غلط',date:'2099-01-01'});
  await send(D2,'امسح آخر مصروف');
  assert(!(await D2.txIds()).includes(id2),'لم تُحذف بعد الموافقة');
  assert(await D2.ev(()=>readBackups().some(b=>b.reason==='pre-ai-delete')),'لا نسخة احتياطية قبل الحذف');
});

test('A7','مبلغ غير صالح من النموذج لا يُسجَّل',async h=>{
  const {D}=await user(h);
  const before=(await D.txIds()).length;
  await send(D,'فلوس السحر');
  assert((await D.txIds()).length===before,'سُجّلت حركة بمبلغ سالب');
  assert(/ما قدرتش/.test((await lastBot(D)).t),'لم يُبلَّغ بالرفض');
});

test('A8','رفض الموافقة لا يرسل شيئاً لـ Gemini',async h=>{
  const {D}=await user(h,'a@test.com',{ dialogAnswer:d=>/Gemini/.test(d.message())?false:true });
  await send(D,'صرفت 10 شاي');
  const lg=await log(D);
  assert(!lg.some(x=>x.ev==='startChat'||x.ev==='send'),'أُرسلت رسالة رغم الرفض');
  assert(!(await D.ev(()=>data.transactions.some(t=>t.category==='شاي'))),'سُجّلت حركة رغم الرفض');
});

test('A9','بدون إنترنت: رسالة واضحة ولا انهيار',async h=>{
  const {D}=await user(h);
  await D.offline(true);
  await send(D,'صرفت 20 عيش');
  assert(await D.ev(()=>data.transactions.some(t=>t.category==='عيش'&&t.amount===20)),'التسجيل البسيط لم يعمل أوفلاين');
  assert(/مفيش نت/.test((await lastBot(D)).t),'لم يوضّح إنه سجّل محلياً');
  await send(D,'مصاريفي الشهر ده عاملة إزاي؟');
  assert(/محتاج إنترنت/.test((await lastBot(D)).t),'الرسالة: '+JSON.stringify(await lastBot(D)));
  assert(await D.appVisible(),'التطبيق اختفى');
});

test('A10','App Check يُهيّأ بمفتاح reCAPTCHA المحفوظ',async h=>{
  const {D}=await user(h);
  await D.ev(()=>{ aiSaveCfg({siteKey:'6LcTESTKEYabcdefghijklmnopqrstu'}); });
  await send(D,'صرفت 5 مياه');
  const ac=(await log(D)).find(x=>x.ev==='appCheck');
  assert(ac && ac.key==='6LcTESTKEYabcdefghijklmnopqrstu' && ac.enterprise,'App Check لم يُهيّأ بمزوّد Enterprise والمفتاح');
});

test('A11','الأخطاء تظهر برسائل مفهومة',async h=>{
  const {D}=await user(h);
  const out={};
  for(const k of ['ERRQUOTA','ERR_APPCHECK','ERR_DISABLED']){ await send(D,k); out[k]=(await lastBot(D)).t; }
  assert(/حد الاستخدام/.test(out.ERRQUOTA),'429: '+out.ERRQUOTA);
  assert(/App Check/.test(out.ERR_APPCHECK),'AppCheck: '+out.ERR_APPCHECK);
  assert(/AI Logic/.test(out.ERR_DISABLED),'Disabled: '+out.ERR_DISABLED);
});

test('A12','المحادثة محفوظة لكل حساب ومُمرَّرة كسياق',async h=>{
  const {D}=await user(h);
  await send(D,'صرفت 33 جرايد');
  await D.reload(); await D.waitApp();
  const m=await msgs(D);
  assert(m.some(x=>x.r==='user'&&/جرايد/.test(x.t)),'المحادثة ضاعت بعد إعادة التحميل');
  await send(D,'أهلاً');
  const sc=(await log(D)).filter(x=>x.ev==='startChat').pop();
  assert(sc.history.length>=2 && sc.history[0].role==='user' && /جرايد/.test(sc.history[0].parts[0].text),'السياق السابق لم يُمرَّر');
  await D.ev(async()=>{ await storageAdapter().flush?.(); await auth.signOut(); }); await D.wait(500);
  h.server.addUser('b@test.com','password1'); await D.login('b@test.com','password1'); await D.wait(800);
  const mb=await msgs(D);
  assert(!mb.some(x=>/جرايد/.test(x.t)),'محادثة الحساب أ ظاهرة للحساب ب');
});

test('A13','تعذّر تحميل مكتبة AI لا يكسر التطبيق',async h=>{
  const {D}=await user(h);
  D.state.aiAvailable=false;
  await send(D,'فين بصرف أكتر؟');
  assert(/تعذّر تحميل مكتبة المساعد/.test((await lastBot(D)).t),'الرسالة: '+(await lastBot(D)).t);
  await send(D,'صرفت 12 مياه');
  assert(await D.ev(()=>data.transactions.some(t=>t.category==='مياه')),'التسجيل البسيط لم يعمل مع فشل المكتبة');
  assert(await D.appVisible() && (await D.addTx({amount:1})),'التطبيق تعطّل بعد فشل المكتبة');
  D.state.aiAvailable=true;
  await D.reload(); await D.waitApp();
  await send(D,'صرفت 15 عصير');
  assert(await D.ev(()=>data.transactions.some(t=>t.category==='عصير')),'لم يتعافَ بعد عودة المكتبة');
});

test('A14','المحادثة لا تُرفع للسحابة',async h=>{
  const {D,uid}=await user(h);
  await send(D,'صرفت 44 كلمة-سرية-للمحادثة'); await D.wait(1500);
  const cloud=JSON.stringify(h.server.cloudData(uid));
  assert(!cloud.includes('km_ai_chat') && !cloud.includes('"r":"user"'),'المحادثة رُفعت للسحابة');
});

test('A15','صدقة من الكلام تُسجَّل في سجل الصدقات',async h=>{
  const {D}=await user(h);
  await send(D,'اتصدقت 250');
  const r=await D.ev(()=>{ const t=data.transactions.find(x=>x.type==='Charity'&&x.amount===250); return { t:!!t, mirror: !!t && data.charities.some(c=>c.txId===t.id) }; });
  assert(r.t && r.mirror,'الصدقة: '+JSON.stringify(r));
});

test('Q1','الحد المجاني للنموذج الأساسي ⇒ يكمل بالنموذج الأخف',async h=>{
  const {D}=await user(h);
  await send(D,'QMAIN');
  assert(await D.ev(()=>data.transactions.some(t=>t.category==='مكرونة')),'لم يُسجَّل عبر النموذج البديل');
  const lg=await log(D);
  assert(lg.some(x=>x.ev==='quota') && lg.some(x=>x.ev==='send'&&x.model==='gemini-3.5-flash-lite'),'لم يُجرَّب النموذج البديل');
});
test('Q2','الحد خلص للكل: التسجيل البسيط يشتغل محلياً بزر تراجع',async h=>{
  const {D}=await user(h,'a@test.com',{initScript:'window.__quotaAll=true'});
  await send(D,'300 فاكهه');
  const tx=await D.ev(()=>data.transactions.find(t=>t.category==='فاكهه'));
  assert(tx && tx.amount===300 && tx.type==='Expense','الحركة: '+JSON.stringify(tx));
  assert(/Gemini مش متاح/.test((await lastBot(D)).t),'لم يوضّح');
  assert((await msgs(D)).some(m=>m.r==='act'),'لا إيصال/تراجع');
  await send(D,'اخبار الميزانيه');
  assert(/حد الاستخدام/.test((await lastBot(D)).t),'السؤال المعقد لازم يرجع رسالة الحد');
});
test('Q3','التسجيل يستهلك طلب واحد لـ Gemini بدل اتنين',async h=>{
  const {D}=await user(h);
  await send(D,'صرفت 45 عيش');
  const lg=await log(D);
  assert(lg.filter(x=>x.ev==='send').length===1 && !lg.some(x=>x.ev==='toolResults'),'اتعمل طلب متابعة غير لازم');
  assert(/سجّلت مصروف/.test((await lastBot(D)).t),'التأكيد المحلي: '+(await lastBot(D)).t);
});
test('Q4','محلّل التسجيل البسيط',async h=>{
  const {D}=await user(h);
  const r=await D.ev(()=>['300 فاكهه','اكلت ب 500 جنيه','صرفت ٥٠ قهوة','قبضت 9000','اخبار الميزانيه','صرفت 50 قهوة و 20 عيش','حوشت 1000'].map(x=>{ const p=aiParseSimple(x); return p?p.type+':'+p.amount+':'+p.category:null; }));
  const want=['Expense:300:فاكهه','Expense:500:طعام ومشروبات','Expense:50:قهوة','Income:9000:دخل',null,null,'Saving:1000:ادخار عام'];
  assert(JSON.stringify(r)===JSON.stringify(want),'المحلّل: '+JSON.stringify(r));
});

test('UI','لقطة الشاشة على موبايل',async h=>{
  const {D}=await user(h);
  await D.ev(()=>openAssistant()); await D.wait(300);
  await D.page.screenshot({ path: __dirname+'/shot-assistant-empty.png' });
  await send(D,'صرفت ٣٠٠ بنزين'); await send(D,'مصاريفي الشهر ده عاملة إزاي؟');
  await D.wait(300);
  await D.page.screenshot({ path: __dirname+'/shot-assistant-chat.png' });
  await D.ev(()=>switchTab('home')); await D.wait(300);
  assert(!(await D.ev(()=>document.getElementById('aiBar').classList.contains('show'))),'شريط الكتابة ظاهر خارج المساعد');
  await D.page.screenshot({ path: __dirname+'/shot-home.png' });
});

(async()=>{
  const file=process.argv[2], filter=process.argv[3];
  const h=new Harness(file); await h.start();
  let pass=0, n=0;
  for(const t of T){
    if(filter && !filter.split(',').includes(t.id)) continue;
    h.server.reset(); n++; let err=null;
    try{ await Promise.race([t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),60000))]); }catch(e){ err=e; }
    const pe=h.devices.flatMap(d=>d.logs.filter(l=>/pageerror/.test(l)));
    await h.closeDevices();
    if(!err) pass++;
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(4)} ${t.name}${err?'\n        → '+err.message.split('\n')[0]:''}${pe.length?'\n        ! '+pe[0]:''}`);
  }
  await h.stop(); console.log(`\n${pass}/${n} passed`);
})();
