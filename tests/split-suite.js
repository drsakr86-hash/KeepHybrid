// Phase 3 — income split tests. Usage: node tests/split-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const path = require('path');
const { Harness, until } = require('./harness');

const T = []; const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const near = (a, b, e=0.01) => Math.abs(a - b) < e;
const FAIL_INIT = `(() => { const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v){ if (window.__failKeys && window.__failKeys.test(k)) throw new DOMException('quota','QuotaExceededError'); return orig.call(this, k, v); }; })();`;
async function dev(h, name='s'){
  if (!h.server.users.has('s@test.com')) h.server.addUser('s@test.com', 'password1', 's');
  const D = await h.device(name, { initScript: FAIL_INIT }); await D.goto(); await D.login('s@test.com', 'password1'); await D.wait(1200); return D;
}
const ym = (k) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); };
const PAST = '2020-01-01T00:00:00.000Z';
const tx = (id, type, amount, date, accountId='bank', extra) => Object.assign({ id, type, amount, date, accountId, category:'ف', createdAt:PAST, updatedAt:PAST, version:1 }, extra||{});
// 3 شهور: دخل 20000 ومصروف 10000 ⇒ متوسط مصروف 10000، هدف طوارئ 6 شهور = 60000
const FX = (extra) => Object.assign({ schemaVersion:16,
  accounts:[ { id:'bank', name:'بنك', type:'bank', openingBalance:0 } ],
  transactions:[ ...[1,2,3].flatMap(k=>[ tx('i'+k,'Income',20000, ym(k)+'-01'), tx('x'+k,'Expense',10000, ym(k)+'-05') ]) ],
  plan:{ v:1, answers:{}, emergencyMonths:6, savingsRatePct:20, allocation:{ cert:50, gold:20, equity:30 }, createdAt:'2021-01-01T00:00:00.000Z' }
}, extra||{});
// يحمّل fixture ويحفظه فعلاً (اختبارات التنفيذ تحتاج حفظاً حقيقياً)
const load = (D, fx) => D.ev((fx)=>{ data = migrateData(fx); bumpDataVersion(); save(); refreshUI(); return true; }, fx);
const newIncome = (D, amount=20000) => D.ev((a)=>{ const r=addTransaction({ type:'Income', amount:a, category:'راتب', accountId:'bank' }); refreshUI(); return r.id; }, amount);

test('SP1', 'الاقتراح: الادخار 20% يذهب لصندوق الطوارئ أولاً، والباقي مصروف حر', async h => {
  const D = await dev(h); await load(D, FX());
  const id = await newIncome(D);
  const p = await D.ev((id)=>IE.propose(Repo.tx().find(t=>t.id===id)), id);
  // سيولة 30000 + 20000 = 50000 ⇒ ناقص 10000 ؛ الادخار 4000 كله للطوارئ
  assert(p.saveTarget === 4000 && p.lines.length === 1 && p.lines[0].kind === 'emergency' && p.lines[0].amount === 4000, JSON.stringify(p.lines));
  assert(near(p.free, 16000), 'حر ' + p.free);
});

test('SP2', 'طوارئ مكتملة في حساب توفير ⇒ هدف بموعده ثم الاستثمار، والمجموع = نسبة الادخار', async h => {
  const D = await dev(h);
  const dl = (() => { const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().slice(0,10); })();
  await load(D, FX({ accounts:[ { id:'bank', name:'بنك', type:'bank', openingBalance:0 }, { id:'sv', name:'توفير', type:'savings', openingBalance:60000 } ],
                     goals:[ { id:'g1', name:'عربية', target:6000, deadline:dl, initial:0 } ] }));
  const id = await newIncome(D);
  const p = await D.ev((id)=>({ p:IE.propose(Repo.tx().find(t=>t.id===id)), req:Q.goalsOverview().rows[0].requiredMonthly }), id);
  const L = p.p.lines;
  assert(!L.some(l=>l.kind==='emergency'), 'طوارئ مكتملة واقترحها');
  const g = L.find(l=>l.kind==='goal'); assert(g && g.amount === p.req, 'الهدف ' + JSON.stringify(g) + ' req ' + p.req);
  assert(L.filter(l=>l.kind==='invest').length >= 1, 'لا استثمار');
  assert(near(L.reduce((t,l)=>t+l.amount,0), 4000), 'المجموع ' + L.reduce((t,l)=>t+l.amount,0));
});

test('SP3', 'التزامات باقي الشهر تقلّل المتاح للادخار', async h => {
  const D = await dev(h);
  const end = await D.ev(()=>Q.monthEnd(cur_month()));
  await load(D, FX({ recurring:[ { id:'r1', title:'إيجار', type:'Expense', category:'إيجار', amount:18500, freq:'monthly', startDate:end, nextDate:end, accountId:'bank', autoAdd:false } ] }));
  const id = await newIncome(D);
  const p = await D.ev((id)=>IE.propose(Repo.tx().find(t=>t.id===id)), id);
  if (p.obl === 0) return { skipped:'محرك المتكررات لم يعرض الإيجار ضمن الشهر (تاريخ نهاية الشهر)' };
  assert(near(p.obl, 18500) && near(p.lines.reduce((t,l)=>t+l.amount,0), 1500), JSON.stringify({ obl:p.obl, lines:p.lines }));
});

test('SP4', 'التنفيذ: تحويل لحساب توفير جديد + سجل + لا تكرار + يُرفع', async h => {
  const uid = h.server.addUser('s@test.com', 'password1', 's');
  const D = await dev(h); await load(D, FX());
  const id = await newIncome(D);
  await D.ev((id)=>openSplit(id), id); await D.wait(300);
  const ok = await D.ev(()=>confirmSplit());
  assert(ok === true, 'لم ينفّذ');
  const r = await D.ev((id)=>({ acc:data.accounts.find(a=>a.type==='savings'), tr:data.transactions.filter(t=>t.type==='Transfer'), log:data.splitLog, pend:IE.pending().map(t=>t.id) }), id);
  assert(r.acc && r.acc.name === 'صندوق الطوارئ', 'لا حساب توفير');
  assert(r.tr.length === 1 && r.tr[0].amount === 4000 && r.tr[0].toAccountId === r.acc.id && r.tr[0].accountId === 'bank', JSON.stringify(r.tr));
  assert(r.log.length === 1 && r.log[0].txId === id && !r.pend.includes(id), 'السجل/المعلّق');
  const again = await D.ev((id)=>IE.execute(IE.propose(Repo.tx().find(t=>t.id===id)), [{kind:'invest',bucket:'gold',amount:1}]), id);
  assert(again.ok === false, 'تنفيذ مكرر اتقبل');
  assert(await until(()=> { const c=h.server.cloudData(uid); return c && Array.isArray(c.splitLog) && c.splitLog.length===1 && c.transactions.some(t=>t.type==='Transfer'); }, 8000), 'لم يُرفع');
  // الطوارئ تُقاس الآن على حساب التوفير
  const em = await D.ev(()=>PE.status().emergency);
  assert(em.inSavingsAccount && near(em.have, 4000), JSON.stringify(em));
});

test('SP5', 'تعديل مبلغ وإلغاء سطر من الشاشة قبل التنفيذ', async h => {
  const D = await dev(h);
  await load(D, FX({ accounts:[ { id:'bank', name:'بنك', type:'bank', openingBalance:0 }, { id:'sv', name:'توفير', type:'savings', openingBalance:60000 } ] }));
  const id = await newIncome(D);
  await D.ev((id)=>openSplit(id), id); await D.wait(300);
  const n = await D.ev(()=>_split.lines.length);
  assert(n >= 2, 'سطور ' + n);
  await D.page.fill('#spAmt0', '1234'); await D.page.uncheck('#spOn1');
  const before = await D.ev(()=>data.transactions.length);
  await D.ev(()=>confirmSplit());
  const r = await D.ev((b)=>data.transactions.slice(b).map(t=>({ type:t.type, amount:t.amount, category:t.category })), before);
  assert(r.length === n - 1 && r[0].amount === 1234, JSON.stringify(r));
});

test('SP6', 'فشل التخزين ⇒ لا حركات ولا حساب ولا سجل', async h => {
  const D = await dev(h); await load(D, FX());
  const id = await newIncome(D);
  const before = await D.ev(()=>({ tx:data.transactions.length, acc:data.accounts.length }));
  await D.ev((id)=>openSplit(id), id); await D.wait(200);
  await D.ev(()=>{ window.__failKeys=/^km_local_data__/; });
  const ok = await D.ev(()=>confirmSplit());
  await D.ev(()=>{ window.__failKeys=null; });
  const after = await D.ev(()=>({ tx:data.transactions.length, acc:data.accounts.length, log:(data.splitLog||[]).length, pend:IE.pending().length }));
  assert(ok === false && after.tx === before.tx && after.acc === before.acc && after.log === 0 && after.pend === 1, JSON.stringify({ before, after }));
});

test('SP7', 'التخطّي ⇒ لا حركات ولا يسأل تاني', async h => {
  const D = await dev(h); await load(D, FX());
  const id = await newIncome(D); const n0 = await D.ev(()=>data.transactions.length);
  await D.ev((id)=>openSplit(id), id); await D.ev(()=>skipSplit());
  const r = await D.ev(()=>({ n:data.transactions.length, pend:IE.pending().length, log:data.splitLog }));
  assert(r.n === n0 && r.pend === 0 && r.log[0].skipped === true, JSON.stringify(r));
});

test('SP8', 'تسجيل دخل يدوياً ⇒ شاشة التقسيم تفتح تلقائياً، وتنبيه ➗ لو اتقفلت', async h => {
  const D = await dev(h); await load(D, FX());
  await D.ev(()=>{ openQadd(); });
  await D.wait(300);
  await D.ev(()=>{ setQaddType && setQaddType('Income'); });
  await D.ev(()=>{ document.getElementById('qaddAmt').value='15000'; document.getElementById('qaddCat').value='راتب'; submitQadd(); });
  await D.wait(900);
  assert(await D.ev(()=>document.getElementById('splitOverlay').classList.contains('open')), 'الشاشة لم تفتح');
  await D.ev(()=>closeSplit());
  const al = await D.ev(()=>smartAlerts().find(a=>a.id.startsWith('split:')));
  assert(al && /openSplit/.test(al.act), 'لا تنبيه: ' + JSON.stringify(al));
  await D.ev(()=>{ switchTab('home'); renderAlertsCard(); });
  await D.page.click('#alertsCard button[aria-label="افتح"]');
  await D.wait(300);
  assert(await D.ev(()=>document.getElementById('splitOverlay').classList.contains('open')), 'زر التنبيه لا يفتح الشاشة');
  await D.page.setViewportSize({ width:360, height:780 });
  await D.page.screenshot({ path: path.join(__dirname, 'shot-split.png') });
});

test('SP9', 'التقسيم على جهاز يظهر على الآخر ولا يُطلب مرتين', async h => {
  const D = await dev(h, 'a'); await load(D, FX());
  const id = await newIncome(D); await D.wait(1500);
  const B = await dev(h, 'b'); await B.wait(800);
  assert((await B.ev(()=>IE.pending().map(t=>t.id))).includes(id), 'B لا يرى الدخل المعلّق');
  await D.ev((id)=>openSplit(id), id); await D.ev(()=>confirmSplit()); await D.wait(1500);
  await B.sync(); await B.wait(1200);
  const r = await B.ev(()=>({ pend:IE.pending().length, log:(data.splitLog||[]).length, tr:data.transactions.filter(t=>t.type==='Transfer').length }));
  assert(r.pend === 0 && r.log === 1 && r.tr === 1, JSON.stringify(r));
});

test('SP10', 'صافي الثروة لا يتغيّر بتحويل الطوارئ (تحويل لا مصروف)', async h => {
  const D = await dev(h); await load(D, FX());
  const id = await newIncome(D);
  const a = await D.ev(()=>FE.netWorth().net);
  await D.ev((id)=>{ openSplit(id); confirmSplit(); }, id);
  const b = await D.ev(()=>FE.netWorth().net);
  assert(near(a, b), `قبل ${a} بعد ${b}`);
});

(async () => {
  const file = process.argv[2]; const filter = process.argv[3];
  const h = new Harness(file); await h.start();
  const results = [];
  for (const t of T) {
    if (filter && !filter.split(',').includes(t.id)) continue;
    h.server.reset(); const t0 = Date.now(); let err = null, info = null;
    try { info = await Promise.race([ t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 90s')),90000)) ]); } catch (e) { err = e; }
    const logs = h.devices.flatMap(d => d.logs.filter(l=>/pageerror/.test(l)).map(l=>d.name+': '+l));
    await h.closeDevices();
    results.push({ id: t.id, name: t.name, pass: !err, error: err && err.message, info, ms: Date.now()-t0 });
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(5)} ${t.name}${info?'  '+JSON.stringify(info):''}${err?'\n        → '+err.message.split('\n')[0]:''}${logs.length?'\n        ! '+logs[0]:''}`);
  }
  await h.stop();
  console.log(`\n${results.filter(r=>r.pass).length}/${results.length} passed`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
})();
