// Review round (Nov 2026): app PIN lock, edit sheet fields, zakat persistence, personal figures.
// Usage: node tests/review-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const { Harness } = require('./harness');

const T = []; const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const FAIL_INIT = `(() => { const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v){ if (window.__failKeys && window.__failKeys.test(k)) throw new DOMException('quota','QuotaExceededError'); return orig.call(this, k, v); }; })();`;
async function dev(h){
  if (!h.server.users.has('v@test.com')) h.server.addUser('v@test.com', 'password1', 'v');
  const D = await h.device('v', { initScript: FAIL_INIT }); await D.goto(); await D.login('v@test.com', 'password1'); await D.wait(1000); return D;
}
const ymd = (o) => { const d = new Date(); d.setDate(d.getDate()+o); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const setPinAndLock = (D, min=1) => D.ev(async (min)=>{ await setPin('1234'); clearFails(); setAutoLock(min); }, min);
const locked = (D) => D.ev(()=>({ locked:_appLocked, shell:getComputedStyle(document.getElementById('appShell')).display, pin:getComputedStyle(document.getElementById('authPin')).display,
                                  login:getComputedStyle(document.getElementById('authLogin')).display }));
const typePin = async (D, pin) => { for (const c of pin) { await D.ev((c)=>pinPress(c), c); } await D.wait(700); };
const idle = (D) => D.ev(()=>{ _lastActivity = Date.now() - 10*60000; document.dispatchEvent(new Event('visibilitychange')); });
const pageErrors = (D) => D.logs.filter(l=>/pageerror/.test(l));

test('LK1', 'العودة للتطبيق بعد خمول بلا رقم سري: لا خطأ ولا قفل', async h => {
  const D = await dev(h);
  await idle(D); await D.wait(300);
  assert(pageErrors(D).length === 0, 'خطأ: ' + pageErrors(D)[0]);
  assert((await locked(D)).locked === false, 'اتقفل بلا رقم سري');
});

test('LK2', 'رقم سري + مدة قفل ⇒ يقفل بعد الخمول، رقم خاطئ يُرفض، الصحيح يفتح', async h => {
  const D = await dev(h);
  const id = await D.addTx({ amount: 77 });
  await setPinAndLock(D);
  await idle(D); await D.wait(300);
  const L = await locked(D);
  assert(L.locked && L.shell === 'none' && L.pin === 'block' && L.login === 'none', JSON.stringify(L));
  await typePin(D, '9999');
  assert((await locked(D)).locked, 'فتح برقم خاطئ');
  await typePin(D, '1234');
  const U = await locked(D);
  assert(!U.locked && U.shell === 'block', JSON.stringify(U));
  assert((await D.txIds()).includes(id), 'البيانات اختفت بعد الفتح');
  assert(pageErrors(D).length === 0, 'خطأ: ' + pageErrors(D)[0]);
});

test('LK3', 'جلسة مستعادة تُفتح بالرقم السري؛ دخول جديد بكلمة المرور لا يُقفل', async h => {
  const D = await dev(h);
  await setPinAndLock(D, 5);
  assert((await locked(D)).locked === false, 'اتقفل فور التفعيل');
  await D.reload(); await D.wait(2000);
  assert((await locked(D)).locked === true, 'الجلسة المستعادة لم تُقفل');
  await typePin(D, '1234');
  assert((await locked(D)).locked === false, 'لم يفتح');
});

test('LK4', 'بلا رقم سري: اختيار مدة قفل يُرفض برسالة', async h => {
  const D = await dev(h);
  await D.ev(()=>setAutoLock(1));
  const r = await D.ev(()=>({ en:lockEnabled(), toast:document.getElementById('toast').textContent, pref:secPrefs() }));
  assert(!r.en && /رقم سري/.test(r.toast) && !r.pref.enabled, JSON.stringify(r));
});

test('LK5', '3 محاولات خاطئة ⇒ انتظار، حتى الرقم الصحيح يُرفض خلاله', async h => {
  const D = await dev(h);
  await setPinAndLock(D); await idle(D); await D.wait(200);
  for (const p of ['0000','1111','2222']) await typePin(D, p);
  await typePin(D, '1234');
  assert((await locked(D)).locked, 'فتح أثناء الانتظار');
  assert(/انتظر/.test(await D.ev(()=>document.getElementById('pinError').textContent)), 'لا رسالة انتظار');
  await D.wait(5300); await typePin(D, '1234');
  assert(!(await locked(D)).locked, 'لم يفتح بعد الانتظار');
});

test('LK6', 'نسيت الرقم: خروج ⇒ دخول بكلمة المرور ⇒ تعيين رقم جديد بلا القديم', async h => {
  const D = await dev(h);
  await setPinAndLock(D); await idle(D); await D.wait(200);
  await D.ev(()=>forgotPin()); await D.wait(1200);
  assert(!(await D.appVisible()), 'ما خرجش');
  assert(await D.ev(()=>getComputedStyle(document.getElementById('authLogin')).display !== 'none' && getComputedStyle(document.getElementById('authTabs')).display !== 'none'), 'شاشة الدخول غير ظاهرة');
  await D.login('v@test.com', 'password1'); await D.wait(800);
  assert(!(await locked(D)).locked, 'اتقفل بعد دخول بكلمة المرور');
  await D.ev(()=>{ switchTab('settings'); document.getElementById('newPinInput').value='4321'; document.getElementById('confirmPinInput').value='4321'; return changePIN(); });
  await D.wait(600);
  assert(await D.ev(()=>verifyPin('4321')), 'الرقم الجديد لم يُعيَّن');
  // بعدها تغيير الرقم يتطلب القديم من جديد
  await D.ev(()=>{ document.getElementById('currentPinInput').value='0000'; document.getElementById('newPinInput').value='5555'; document.getElementById('confirmPinInput').value='5555'; return changePIN(); });
  await D.wait(600);
  assert(await D.ev(()=>verifyPin('4321')), 'اتغيّر بلا الرقم الحالي');
});

test('ED1', 'تعديل دخل: ربطه بمصدر وعدد حالات', async h => {
  const D = await dev(h);
  const id = await D.addTx({ type:'Income', amount:9000, category:'عمليات' });
  await D.ev((id)=>openEditModal(id), id);
  await D.ev(()=>pickEditSrc('op_lasik'));
  assert(await D.ev(()=>getComputedStyle(document.getElementById('editCasesWrap')).display !== 'none'), 'خانة الحالات مخفية');
  await D.ev(()=>{ document.getElementById('editCases').value='2'; saveEdit(); });
  const t = await D.ev((id)=>data.transactions.find(x=>x.id===id), id);
  assert(t.sourceId === 'op_lasik' && t.cases === 2 && t.category === 'عمليات الليزك', JSON.stringify(t));
});

test('ED2', 'تعديل مصروف قديم لعيادة ⇒ يخرج من المصروف الشخصي، ويظهر في السجل', async h => {
  const D = await dev(h);
  const id = await D.addTx({ amount:3000, category:'إيجار' });
  const before = await D.ev(()=>SRC.personal(cur_month()).exp);
  await D.ev((id)=>{ openEditModal(id); pickEditBiz('cl_rah'); saveEdit(); }, id);
  const r = await D.ev((id)=>({ t:data.transactions.find(x=>x.id===id), p:SRC.personal(cur_month()).exp, row:(switchTab('list'), document.getElementById('sw-'+id).textContent) }), id);
  assert(before === 3000 && r.t.bizId === 'cl_rah' && r.p === 0, JSON.stringify({ before, biz:r.t.bizId, p:r.p }));
  assert(/عيادة الرحمانية/.test(r.row), 'السجل: ' + r.row.replace(/\s+/g,' '));
  // تغيير النوع لدخل يفكّ ربط العيادة
  await D.ev((id)=>{ openEditModal(id); setEditType('Income'); saveEdit(); }, id);
  assert(!(await D.ev((id)=>data.transactions.find(x=>x.id===id).bizId, id)), 'bizId باقٍ بعد تغيير النوع');
});

test('ED3', 'فشل الحفظ في التعديل ⇒ الحركة كما كانت ولا "تم التعديل"', async h => {
  const D = await dev(h);
  const id = await D.addTx({ amount:500, category:'أكل' });
  await D.ev((id)=>{ openEditModal(id); document.getElementById('editAmtInput').value='999'; window.__failKeys=/^km_local_data__/; saveEdit(); window.__failKeys=null; }, id);
  const r = await D.ev((id)=>({ amt:data.transactions.find(x=>x.id===id).amount, toast:document.getElementById('toast').textContent }), id);
  assert(r.amt === 500 && !/تم التعديل/.test(r.toast), JSON.stringify(r));
});

test('ZK1', 'الزكاة تفضل مستحقة بعد 60 يوم لحد ما تتدفع أو تتعلّم مدفوعة', async h => {
  const D = await dev(h);
  await D.ev((hawl)=>{ data.accounts[0].openingBalance=500000; data.zakat={ hawlDate:hawl, gold24:1500, includeGold:true, includeReceivables:true, deductDebts:true }; bumpDataVersion(); save(); }, ymd(-354-120));
  const a = await D.ev(()=>ZE.status());
  assert(a.dueNow && a.remaining > 0, 'اختفت بعد 60 يوم: ' + JSON.stringify({ due:a.dueNow, last:a.last }));
  assert(await D.ev(()=>settleZakat()) === true, 'settle');
  const b = await D.ev(()=>({ z:ZE.status(), al:smartAlerts().some(x=>x.id.startsWith('zakat-due')) }));
  assert(!b.z.dueNow && b.z.settled && !b.al, JSON.stringify({ due:b.z.dueNow, al:b.al }));
  assert(await D.ev(()=>data.transactions.filter(t=>t.type==='Charity').length) === 0, 'سجّل حركة');
});

test('PF1', 'المستشار والمساعد يستخدمان الأرقام الشخصية بعد مصاريف العيادات', async h => {
  const D = await dev(h);
  const r = await D.ev(()=>{
    addTransaction({ type:'Income', amount:20000, category:'عيادة الرحمانية', sourceId:'cl_rah' });
    addTransaction({ type:'Expense', amount:8000, category:'إيجار عيادة', bizId:'cl_rah' });
    addTransaction({ type:'Expense', amount:6000, category:'أكل' });
    addTransaction({ type:'Saving', amount:3000, category:'ذهب' });
    const o=aiExec('get_overview', {});
    return { personal:o.personal, gross:o.totals };
  });
  assert(r.gross.expense === 14000 && r.personal.personal_expense === 6000 && r.personal.income_after_clinic_expenses === 12000 && r.personal.savings_rate_pct === 25, JSON.stringify(r));
});

(async () => {
  const file = process.argv[2]; const filter = process.argv[3];
  const h = new Harness(file); await h.start();
  const results = [];
  for (const t of T) {
    if (filter && !filter.split(',').includes(t.id)) continue;
    h.server.reset(); const t0 = Date.now(); let err = null;
    try { await Promise.race([ t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 90s')),90000)) ]); } catch (e) { err = e; }
    await h.closeDevices();
    results.push({ id: t.id, name: t.name, pass: !err, error: err && err.message, ms: Date.now()-t0 });
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(5)} ${t.name}${err?'\n        → '+err.message.split('\n')[0]:''}`);
  }
  await h.stop();
  console.log(`\n${results.filter(r=>r.pass).length}/${results.length} passed`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
})();
