// Wealth manager (phase 1+2) tests. Usage: node tests/wealth-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const path = require('path');
const { Harness, until } = require('./harness');

const T = []; const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const near = (a, b, e=0.01) => Math.abs(a - b) < e;
const FAIL_INIT = `(() => { const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v){ if (window.__failKeys && window.__failKeys.test(k)) throw new DOMException('quota','QuotaExceededError'); return orig.call(this, k, v); }; })();`;
async function loggedIn(h, email='w@test.com'){
  if (!h.server.users.has(email)) h.server.addUser(email, 'password1', 'w');
  const D = await h.device('w', { initScript: FAIL_INIT }); await D.goto(); await D.login(email, 'password1'); await D.wait(1200); return D;
}
// fixture في الذاكرة فقط
const run = (D, fx, fn) => D.ev(([fx, src]) => { data = migrateData(JSON.parse(JSON.stringify(fx))); bumpDataVersion(); return (new Function('return ' + src))()()(); }, [fx, fn.toString()]);
const ym = (k) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); };
const tx = (id, type, amount, date, accountId='bank') => ({ id, type, amount, date, accountId, category:'ف', createdAt:'2025-01-01T00:00:00Z', updatedAt:'2025-01-01T00:00:00Z', version:1 });
const old = new Date(Date.now() - 60*86400000).toISOString();
const now = new Date().toISOString();
const FX = () => ({ schemaVersion:16,
  accounts:[ { id:'bank', name:'بنك', type:'bank', openingBalance:100000 }, { id:'card', name:'بطاقة', type:'card', openingBalance:0 } ],
  investments:[
    { id:'g', kind:'gold', name:'ذهب 21', qty:10, buyPrice:3000, currentPrice:4000, priceUpdatedAt:now },
    { id:'c', kind:'cert', name:'شهادة', qty:2, buyPrice:50000, currentPrice:50000, priceUpdatedAt:now },
    { id:'f', kind:'fund', name:'صندوق', qty:100, buyPrice:100, currentPrice:150, priceUpdatedAt:old },
    { id:'e', kind:'estate', name:'أرض', qty:1, buyPrice:200000, currentPrice:300000, priceUpdatedAt:now } ],
  transactions:[ tx('e0','Expense',2000, ym(0)+'-02','card'),
    ...[1,2,3].flatMap(k=>[ tx('i'+k,'Income',20000, ym(k)+'-01'), tx('x'+k,'Expense',10000, ym(k)+'-05'), tx('s'+k,'Saving',2000, ym(k)+'-06') ]) ]
});
const PLAN = { v:1, answers:{ income:'variable', dependents:true, horizon:'medium', risk:'medium' }, emergencyMonths:6, savingsRatePct:20, allocation:{ cert:50, gold:20, equity:30 } };

test('W1', 'صورة الثروة: الأوعية وصافي الثروة محسوبة يدوياً', async h => {
  const D = await loggedIn(h);
  const r = await run(D, FX(), () => () => WE.snapshot());
  // bank: 100000 + 3×20000 − 3×10000 − 3×2000 = 124000 ; card −2000
  assert(near(r.buckets.liquid, 124000), 'سيولة ' + r.buckets.liquid);
  assert(r.buckets.gold === 40000 && r.buckets.cert === 100000 && r.buckets.equity === 15000 && r.buckets.other === 300000, JSON.stringify(r.buckets));
  assert(near(r.liabilities, 2000) && near(r.net, 124000 + 40000 + 100000 + 15000 + 300000 - 2000), 'صافي ' + r.net);
});

test('W2', 'قواعد الاقتراح: طوارئ/ادخار/توزيع حسب الإجابات', async h => {
  const D = await loggedIn(h);
  const r = await run(D, FX(), () => () => [
    PE.recommend({ income:'variable', dependents:true,  horizon:'short',  risk:'low' }),
    PE.recommend({ income:'stable',   dependents:false, horizon:'long',   risk:'high' }),
    PE.recommend({ income:'stable',   dependents:true,  horizon:'medium', risk:'medium' }),
    PE.savingsRateActual() ]);
  const [a,b,c,sr] = r;
  assert(a.emergencyMonths === 10 && JSON.stringify(a.allocation) === JSON.stringify({cert:80,gold:20,equity:0}), JSON.stringify(a));
  assert(b.emergencyMonths === 4 && JSON.stringify(b.allocation) === JSON.stringify({cert:20,gold:20,equity:60}), JSON.stringify(b));
  assert(c.emergencyMonths === 5 && JSON.stringify(c.allocation) === JSON.stringify({cert:50,gold:20,equity:30}), JSON.stringify(c));
  assert(near(sr.rate, 0.1) && sr.months === 3, JSON.stringify(sr));
  assert(a.savingsRatePct === 20, 'ادخار ' + a.savingsRatePct);   // max(20, 10+5)
  for (const x of [a,b,c]) assert(x.allocation.cert + x.allocation.gold + x.allocation.equity === 100, 'المجموع ≠ 100');
});

test('W3', 'حالة الخطة: الطوارئ والسيولة الزيادة وتوزيعها يسدّ العجز ومجموعه = الزيادة', async h => {
  const D = await loggedIn(h);
  const fx = FX(); fx.plan = PLAN;
  const r = await run(D, fx, () => () => { const s = PE.status(); return { s, avg: PE.avgExpense() }; });
  const st = r.s;
  // متوسط المصروف = (2000 + 3×10000)/4 = 8000 ⇒ هدف الطوارئ 48000
  assert(near(r.avg, 8000), 'متوسط ' + r.avg);
  assert(near(st.emergency.target, 48000) && st.emergency.done, JSON.stringify(st.emergency));
  assert(near(st.excessLiquid, 124000 - 48000), 'زيادة ' + st.excessLiquid);
  const step = st.steps.find(x => /زيادة عن صندوق الطوارئ/.test(x.text));
  assert(step, 'لا خطوة توزيع: ' + JSON.stringify(st.steps.map(x=>x.text)));
  const nums = [...step.text.matchAll(/(شهادات وودائع|ذهب|أسهم وصناديق) ([\d٠-٩٬,٫.]+)/g)].map(m => Number(m[2].replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[٬,]/g,'').replace('٫','.').replace(/\.$/,'')));
  // long total = 100000+40000+15000+76000 = 231000 ; أهداف: شهادات 115500 (عجز 15500)، ذهب 46200 (6200)، أسهم 69300 (54300)
  assert(nums.length === 3 && near(nums.reduce((a,b)=>a+b,0), 76000, 2), 'التوزيع ' + JSON.stringify(nums) + ' ' + step.text);
  assert(st.steps.some(x => /حدّث سعر "صندوق"/.test(x.text)), 'لا تنبيه سعر قديم');
  assert(!st.steps.some(x => /حدّث سعر "ذهب 21"/.test(x.text)), 'سعر حديث اتعلّم قديم');
});

test('W4', 'طوارئ ناقصة ⇒ أول خطوة تكملتها بالرقم، ولا توزيع للسيولة', async h => {
  const D = await loggedIn(h);
  const fx = FX(); fx.plan = { ...PLAN, emergencyMonths:20 };   // هدف 160000 > سيولة 124000
  const st = await run(D, fx, () => () => PE.status());
  assert(!st.emergency.done && near(st.emergency.gap, 36000), JSON.stringify(st.emergency));
  assert(/كمّل صندوق الطوارئ/.test(st.steps[0].text), 'الأولى: ' + st.steps[0].text);
  assert(!st.steps.some(x => /زيادة عن صندوق الطوارئ/.test(x.text)), 'وزّع سيولة والطوارئ ناقصة');
});

test('W5', 'التحقق من الخطة: مجموع ≠ 100 أو قيم خارج النطاق مرفوضة', async h => {
  const D = await loggedIn(h);
  const r = await run(D, FX(), () => () => [
    PE.validate({ emergencyMonths:6, savingsRatePct:20, allocation:{cert:50,gold:20,equity:20} }),
    PE.validate({ emergencyMonths:0, savingsRatePct:20, allocation:{cert:50,gold:20,equity:30} }),
    PE.validate({ emergencyMonths:6, savingsRatePct:-1, allocation:{cert:50,gold:20,equity:30} }),
    PE.validate({ emergencyMonths:6, savingsRatePct:20, allocation:{cert:'x',gold:20,equity:30} }),
    PE.validate({ emergencyMonths:6, savingsRatePct:20, allocation:{cert:50,gold:20,equity:30} }) ]);
  assert(r.slice(0,4).every(Boolean) && r[4] === null, JSON.stringify(r));
});

test('W6', 'المقابلة من الواجهة ⇒ حفظ الخطة محلياً وفي السحابة، ثم ظهورها على جهاز آخر', async h => {
  const uid = h.server.addUser('w@test.com', 'password1', 'w');
  const D = await loggedIn(h);
  await D.addTx({ type:'Income', amount:20000 }); await D.addTx({ amount:5000 });
  await D.ev(()=>{ switchTab('chart'); switchAnalysis('wealth'); }); await D.wait(300);
  await D.page.click('#planCard button.btn-primary');
  for (const [k, v] of [['income','variable'],['dependents',true],['horizon','long'],['risk','medium']])
    await D.ev(([k,v])=>planAnswer(k,v), [k, v]);
  await D.page.fill('#plGold', '25'); await D.page.fill('#plEq', '35');   // 40+25+35 = 100
  const ok = await D.ev(()=>savePlan());
  assert(ok === true, 'لم تُحفظ');
  const p = await D.ev(()=>data.plan);
  assert(p.emergencyMonths === 10 && p.allocation.cert === 40 && p.allocation.gold === 25 && p.allocation.equity === 35, JSON.stringify(p));
  assert(await until(()=> { const c = h.server.cloudData(uid); return c && c.plan && c.plan.allocation.equity === 35; }, 8000), 'الخطة لم تصل السحابة');
  const html = await D.ev(()=>document.getElementById('planCard').textContent);
  assert(/الخطوة الجاية/.test(html) && /المستهدف 35%/.test(html), 'الشاشة: ' + html.slice(0,200));
  const B = await h.device('w2'); await B.goto(); await B.login('w@test.com','password1'); await B.wait(1500);
  assert((await B.ev(()=>data.plan && data.plan.allocation.equity)) === 35, 'لم تظهر على الجهاز الآخر');
});

test('W7', 'مجموع توزيع خاطئ من الواجهة ⇒ رفض بلا حفظ', async h => {
  const D = await loggedIn(h);
  await D.ev(()=>{ switchTab('chart'); switchAnalysis('wealth'); startPlanWizard(); ['income','dependents','horizon','risk'].forEach((k,i)=>planAnswer(k, ['stable',false,'medium','medium'][i])); });
  await D.page.fill('#plGold', '60');
  const ok = await D.ev(()=>savePlan());
  assert(ok === false && !(await D.ev(()=>data.plan)), 'اتحفظت');
});

test('W8', 'فشل التخزين عند حفظ الخطة ⇒ لا خطة في الذاكرة', async h => {
  const D = await loggedIn(h);
  await D.ev(()=>{ startPlanWizard(); ['income','dependents','horizon','risk'].forEach((k,i)=>planAnswer(k, ['stable',false,'medium','medium'][i])); });
  await D.ev(()=>{ window.__failKeys=/^km_local_data__/; });
  const ok = await D.ev(()=>savePlan());
  await D.ev(()=>{ window.__failKeys=null; });
  assert(ok === false && !(await D.ev(()=>data.plan)), 'الخطة في الذاكرة رغم الفشل');
});

test('W9', 'لقطة الثروة الشهرية: مرة في اليوم، تُرفع، ولا تتكرر', async h => {
  const uid = h.server.addUser('w@test.com', 'password1', 'w');
  const D = await loggedIn(h);
  await D.addTx({ type:'Income', amount:7000 }); await D.wait(3500);
  const r1 = await D.ev(()=>{ data.wealthHistory=[]; return WE.recordSnapshot(); });
  const r2 = await D.ev(()=>WE.recordSnapshot());
  const hist = await D.ev(()=>({ h:data.wealthHistory, m:cur_month() }));
  assert(r1 === true && r2 === false && hist.h.length === 1 && hist.h[0].month === hist.m && hist.h[0].net === 7000, 'السجل ' + JSON.stringify(hist));
  assert(await until(()=> { const c=h.server.cloudData(uid); return c && Array.isArray(c.wealthHistory) && c.wealthHistory.length===1; }, 8000), 'لم يُرفع');
});

test('W12', 'فتح التطبيق وحده لا يكتب في السحابة (اللقطة تُحفظ مع أول تعديل)', async h => {
  const uid = h.server.addUser('w@test.com', 'password1', 'w');
  const D = await loggedIn(h);
  await D.addTx({ type:'Income', amount:5000 }); await D.wait(2000);
  await D.reload(); await D.waitApp(); await D.wait(5000);
  const w0 = h.server.writes.length;
  await D.wait(2000);
  assert(h.server.writes.length === w0, 'كتابات بلا تعديل: ' + (h.server.writes.length - w0));
  await D.addTx({ amount:10 });
  assert(await until(()=> { const c=h.server.cloudData(uid); return c && Array.isArray(c.wealthHistory) && c.wealthHistory.length===1; }, 8000), 'اللقطة لم تُحفظ مع أول تعديل');
});

test('W10', 'المساعد يستلم نفس أرقام الشاشة (wealth_plan) بدون تأليف', async h => {
  const D = await loggedIn(h);
  const fx = FX(); fx.plan = PLAN;
  const r = await run(D, fx, () => () => { const o = aiExec('get_overview', {}); const st = PE.status(); return { w:o.wealth_plan, st }; });
  assert(r.w && r.w.plan && r.w.plan.emergency_months === 6, JSON.stringify(r.w).slice(0,200));
  assert(r.w.net_worth === Math.round(r.st.snapshot.net) && r.w.excess_liquid === Math.round(r.st.excessLiquid), 'أرقام مختلفة');
  assert(JSON.stringify(r.w.next_steps) === JSON.stringify(r.st.steps.map(x=>x.text)), 'الخطوات مختلفة');
});

test('W11', 'شاشة ثروتي على موبايل 360: بلا تمرير أفقي + صورة', async h => {
  const D = await loggedIn(h);
  await D.page.setViewportSize({ width:360, height:780 });
  await D.ev((fx)=>{ data = migrateData(fx); bumpDataVersion(); switchTab('chart'); switchAnalysis('wealth'); }, Object.assign(FX(), { plan: PLAN }));
  await D.wait(500);
  const r = await D.ev(()=>({ sw:document.documentElement.scrollWidth, iw:innerWidth, txt:document.getElementById('aview-wealth').textContent }));
  assert(r.sw <= r.iw + 1, `تمرير أفقي ${r.sw}>${r.iw}`);
  assert(/صافي ثروتك/.test(r.txt) && /خطتك/.test(r.txt), 'المحتوى ناقص');
  await D.page.screenshot({ path: path.join(__dirname, 'shot-wealth.png'), fullPage: true });
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
