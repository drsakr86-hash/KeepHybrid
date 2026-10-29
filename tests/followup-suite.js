// Phase 4 — monthly review, zakat, decision log. Usage: node tests/followup-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const path = require('path');
const { Harness, until } = require('./harness');

const T = []; const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const near = (a, b, e=0.01) => Math.abs(a - b) < e;
const FAIL_INIT = `(() => { const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v){ if (window.__failKeys && window.__failKeys.test(k)) throw new DOMException('quota','QuotaExceededError'); return orig.call(this, k, v); }; })();`;
async function dev(h, name='f'){
  if (!h.server.users.has('f@test.com')) h.server.addUser('f@test.com', 'password1', 'f');
  const D = await h.device(name, { initScript: FAIL_INIT }); await D.goto(); await D.login('f@test.com', 'password1'); await D.wait(1200); return D;
}
const PAST = '2020-01-01T00:00:00.000Z';
const ymd = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const tx = (id, type, amount, date, extra) => Object.assign({ id, type, amount, date, accountId:'bank', category:'ف', createdAt:PAST, updatedAt:PAST, version:1 }, extra||{});
// سيولة 100000 · شهادات 50000 · ذهب 10جم×4000 = 40000 · ليك 10000 · عليك 20000
const ZFX = (zakat, extraTx) => ({ schemaVersion:16,
  accounts:[ { id:'bank', name:'بنك', type:'bank', openingBalance:100000 } ],
  investments:[ { id:'c', kind:'cert', name:'شهادة', qty:1, buyPrice:50000, currentPrice:50000, priceUpdatedAt:new Date().toISOString() },
                { id:'g', kind:'gold', name:'ذهب', qty:10, buyPrice:3000, currentPrice:4000, priceUpdatedAt:new Date().toISOString() } ],
  debts:[ { id:'d1', kind:'owed_to_me', party:'أحمد', principal:10000, startDate:'2025-01-01' },
          { id:'d2', kind:'i_owe', party:'بنك', principal:20000, startDate:'2025-01-01' } ],
  transactions: extraTx || [],
  zakat
});
const load = (D, fx) => D.ev((fx)=>{ data = migrateData(fx); bumpDataVersion(); save(); refreshUI(); return true; }, fx);

test('Z1', 'الزكاة: المال الزكوي والنصاب و2.5% وخيارات الذهب والديون', async h => {
  const D = await dev(h);
  await load(D, ZFX({ hawlDate:ymd(100), gold24:1500, includeGold:true, includeReceivables:true, deductDebts:true }));
  const a = await D.ev(()=>ZE.status());
  assert(near(a.total, 180000) && near(a.nisab, 127500) && a.above && a.amount === 4500, JSON.stringify({ t:a.total, n:a.nisab, amt:a.amount, parts:a.parts }));
  await D.ev(()=>{ data.zakat.includeGold=false; data.zakat.deductDebts=false; data.zakat.includeReceivables=false; bumpDataVersion(); });
  const b = await D.ev(()=>ZE.status());
  assert(near(b.total, 150000) && b.amount === 3750, JSON.stringify({ t:b.total, amt:b.amount }));
  await D.ev(()=>{ data.zakat.gold24=4500; bumpDataVersion(); });                // نصاب 382500
  const c = await D.ev(()=>ZE.status());
  assert(!c.above && c.amount === 0, 'تحت النصاب: ' + JSON.stringify({ t:c.total, n:c.nisab, amt:c.amount }));
});

test('Z2', 'مواعيد الحول (354 يوم) والمستحق بعد خصم المدفوع — زكاة الفطر لا تُخصم', async h => {
  const D = await dev(h);
  const hawl = ymd(-359);                         // آخر حول من 5 أيام
  await load(D, ZFX({ hawlDate:hawl, gold24:1500, includeGold:true, includeReceivables:true, deductDebts:true }, [
    tx('z1','Charity',2000, ymd(-2), { category:'زكاة مال' }),
    tx('z2','Charity',300,  ymd(-1), { category:'زكاة فطر' }),
    tx('z0','Charity',999,  ymd(-30), { category:'زكاة مال' }) ]));         // قبل الحول — لا تُخصم
  const z = await D.ev(()=>ZE.status());
  assert(z.last === ymd(-5) && z.next === ymd(349), JSON.stringify({ last:z.last, next:z.next }));
  // السيولة نقصت بالصدقات: 100000 − 3299 ⇒ المال الزكوي 176701 ⇒ 4418 تقريباً
  assert(z.dueNow && z.paidSinceLast === 2000 && z.remaining === z.amount - 2000, JSON.stringify({ due:z.dueNow, paid:z.paidSinceLast, amt:z.amount, rem:z.remaining }));
  const al = await D.ev(()=>smartAlerts().find(a=>a.id.startsWith('zakat-due:')));
  assert(al && al.sev === 2, 'لا تنبيه زكاة مستحقة');
});

test('Z3', 'إعدادات الزكاة من الواجهة: تحقق + حفظ + رفع + زر الدفع يجهّز صدقة "زكاة مال"', async h => {
  const uid = h.server.addUser('f@test.com', 'password1', 'f');
  const D = await dev(h);
  await load(D, ZFX(undefined));
  await D.ev(()=>{ switchTab('chart'); switchAnalysis('wealth'); }); await D.wait(300);
  await D.page.fill('#zkGold', '1500');
  assert((await D.ev(()=>saveZakat())) === false, 'قبل بلا تاريخ');
  await D.page.fill('#zkHawl', ymd(-357));
  assert((await D.ev(()=>saveZakat())) === true, 'لم يحفظ');
  assert(await until(()=> { const c=h.server.cloudData(uid); return c && c.zakat && c.zakat.gold24===1500; }, 8000), 'لم يُرفع');
  const txt = await D.ev(()=>document.getElementById('zakatCard').textContent);
  assert(/مستحقة الآن/.test(txt), 'الكارت: ' + txt.slice(0,120));
  await D.page.click('#zakatCard button.btn-primary'); await D.wait(400);
  const q = await D.ev(()=>({ open:document.getElementById('qaddOverlay').classList.contains('open'), cat:document.getElementById('qaddCat').value, amt:Number(document.getElementById('qaddAmt').value), type:_qaddType }));
  assert(q.open && q.cat === 'زكاة مال' && q.type === 'Charity' && q.amt > 0, JSON.stringify(q));
  await D.ev(()=>submitQadd()); await D.wait(300);
  const z = await D.ev(()=>ZE.status());
  assert(!z.dueNow && z.remaining === 0, 'بعد الدفع ما زالت مستحقة: ' + JSON.stringify({ rem:z.remaining, paid:z.paidSinceLast, amt:z.amount }));
});

test('Z4', 'فشل الحفظ في إعدادات الزكاة ⇒ لا تغيير', async h => {
  const D = await dev(h); await load(D, ZFX(undefined));
  await D.ev(()=>{ switchTab('chart'); switchAnalysis('wealth'); }); await D.wait(300);
  await D.page.fill('#zkGold', '1500'); await D.page.fill('#zkHawl', ymd(-10));
  await D.ev(()=>{ window.__failKeys=/^km_local_data__/; });
  const ok = await D.ev(()=>saveZakat());
  await D.ev(()=>{ window.__failKeys=null; });
  assert(ok === false && !(await D.ev(()=>data.zakat)), 'اتغيّر');
});

test('M1', 'مراجعة الشهر: تغيّر الثروة من اللقطات، الادخار، والتقسيم', async h => {
  const D = await dev(h);
  const r = await D.ev(()=>{
    const pm=MR.prevMonth(), ppm=Q.lastMonths(3)[2];
    data = migrateData({ schemaVersion:16, accounts:[{id:'bank',name:'بنك',type:'bank',openingBalance:0}],
      plan:{ v:1, answers:{}, emergencyMonths:6, savingsRatePct:20, allocation:{cert:50,gold:20,equity:30}, createdAt:'2020-01-01T00:00:00Z' },
      wealthHistory:[ { month:ppm, date:ppm+'-28', net:10000, assets:10000, liabilities:0, buckets:{} }, { month:pm, date:pm+'-28', net:16000, assets:16000, liabilities:0, buckets:{} } ],
      transactions:[ { id:'i1', type:'Income', amount:10000, date:pm+'-01', accountId:'bank', category:'راتب', createdAt:'2020-01-01T00:00:00Z' },
                     { id:'i2', type:'Income', amount:5000,  date:pm+'-15', accountId:'bank', category:'عيادة', createdAt:'2020-01-01T00:00:00Z' },
                     { id:'s1', type:'Saving', amount:2000,  date:pm+'-02', accountId:'bank', category:'ذهب', createdAt:'2020-01-01T00:00:00Z' },
                     { id:'e1', type:'Expense', amount:7000, date:pm+'-03', accountId:'bank', category:'أكل', createdAt:'2020-01-01T00:00:00Z' } ],
      splitLog:[ { id:'L1', txId:'i1', at:pm+'-01T10:00:00Z', amount:10000, lines:[{ type:'Saving', category:'ذهب', amount:2000, txId:'s1' }] },
                 { id:'L2', txId:'i2', at:pm+'-15T10:00:00Z', skipped:true } ] });
    bumpDataVersion();
    return MR.review(pm);
  });
  assert(r.netChange === 6000 && near(r.rate, 2000/15000) && r.target === 20, JSON.stringify(r));
  assert(r.incomes === 2 && r.splitDone === 1 && r.splitSkipped === 1 && r.splitNone === 0, JSON.stringify(r));
});

test('L1', 'سجل القرارات: تقسيم/تخطّي/تعديل خطة، والمجاميع تتجاهل الحركات المحذوفة', async h => {
  const D = await dev(h);
  const r = await D.ev(()=>{
    data = migrateData({ schemaVersion:16, accounts:[{id:'bank',name:'بنك',type:'bank',openingBalance:0},{id:'sv',name:'توفير',type:'savings',openingBalance:0}],
      goals:[{ id:'g1', name:'عربية', target:10000 }],
      transactions:[ { id:'i1', type:'Income', amount:10000, date:'2026-01-01', accountId:'bank', category:'راتب' },
                     { id:'t1', type:'Transfer', amount:1000, date:'2026-01-01', accountId:'bank', toAccountId:'sv', category:'تحويل' },
                     { id:'s1', type:'Saving', amount:500, date:'2026-01-01', accountId:'bank', category:'عربية', goalId:'g1' },
                     { id:'s2', type:'Saving', amount:700, date:'2026-01-01', accountId:'bank', category:'ذهب' } ],
      splitLog:[ { id:'L1', txId:'i1', at:'2026-01-01T10:00:00Z', amount:10000, lines:[
                   { type:'Transfer', category:'تحويل', amount:1000, txId:'t1' }, { type:'Saving', category:'عربية', amount:500, txId:'s1' },
                   { type:'Saving', category:'ذهب', amount:700, txId:'s2' }, { type:'Saving', category:'أسهم', amount:300, txId:'gone' } ] },
                 { id:'L2', txId:'iX', at:'2026-01-05T10:00:00Z', skipped:true } ],
      planLog:[ { at:'2025-12-31T10:00:00Z', first:true, emergencyMonths:6, savingsRatePct:20, allocation:{cert:50,gold:20,equity:30} } ] });
    bumpDataVersion();
    return { t:DL.totals(), e:DL.entries().map(x=>x.kind) };
  });
  assert(r.t.emergency === 1000 && r.t.goals === 500 && r.t.invest === 700 && r.t.splits === 1 && r.t.skipped === 1, JSON.stringify(r.t));
  assert(JSON.stringify(r.e) === JSON.stringify(['skip','split','plan']), JSON.stringify(r.e));
});

test('L2', 'حفظ الخطة يسجّل في سجل القرارات (أول مرة ثم تعديل)', async h => {
  const D = await dev(h);
  await D.ev(()=>{ switchTab('chart'); switchAnalysis('wealth'); startPlanWizard(); ['income','dependents','horizon','risk'].forEach((k,i)=>planAnswer(k, ['stable',false,'medium','medium'][i])); savePlan(); });
  await D.ev(()=>{ startPlanWizard(true); });
  await D.page.fill('#plSr', '25');
  await D.ev(()=>savePlan());
  const log = await D.ev(()=>data.planLog);
  assert(log.length === 2 && log[0].first === true && !log[1].first && log[1].savingsRatePct === 25, JSON.stringify(log));
  const txt = await D.ev(()=>document.getElementById('decisionCard').textContent);
  assert(/عدّلت خطتك/.test(txt) && /عملت خطتك/.test(txt), txt.slice(0,200));
});

test('U1', 'الشاشة كاملة على 360 + المساعد يستلم المراجعة والزكاة والسجل', async h => {
  const D = await dev(h);
  await D.page.setViewportSize({ width:360, height:780 });
  await load(D, Object.assign(ZFX({ hawlDate:ymd(-357), gold24:1500, includeGold:true, includeReceivables:true, deductDebts:true }),
    { plan:{ v:1, answers:{}, emergencyMonths:6, savingsRatePct:20, allocation:{cert:50,gold:20,equity:30}, createdAt:PAST } }));
  await D.ev(()=>{ switchTab('chart'); switchAnalysis('wealth'); }); await D.wait(500);
  const r = await D.ev(()=>({ sw:document.documentElement.scrollWidth, iw:innerWidth, w:aiExec('get_overview',{}).wealth_plan }));
  assert(r.sw <= r.iw + 1, `تمرير أفقي ${r.sw}>${r.iw}`);
  assert(r.w.zakat && r.w.zakat.due_now === true && r.w.monthly_review && r.w.decisions_since_plan, JSON.stringify(r.w).slice(0,300));
  await D.page.screenshot({ path: path.join(__dirname, 'shot-followup.png'), fullPage: true });
});

(async () => {
  const file = process.argv[2]; const filter = process.argv[3];
  const h = new Harness(file); await h.start();
  const results = [];
  for (const t of T) {
    if (filter && !filter.split(',').includes(t.id)) continue;
    h.server.reset(); const t0 = Date.now(); let err = null;
    try { await Promise.race([ t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 90s')),90000)) ]); } catch (e) { err = e; }
    const logs = h.devices.flatMap(d => d.logs.filter(l=>/pageerror/.test(l)).map(l=>d.name+': '+l));
    await h.closeDevices();
    results.push({ id: t.id, name: t.name, pass: !err, error: err && err.message, ms: Date.now()-t0 });
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(5)} ${t.name}${err?'\n        → '+err.message.split('\n')[0]:''}${logs.length?'\n        ! '+logs[0]:''}`);
  }
  await h.stop();
  console.log(`\n${results.filter(r=>r.pass).length}/${results.length} passed`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
})();
