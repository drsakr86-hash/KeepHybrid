// Financial-engine invariants with deterministic fixtures + mobile smoke.
// Usage: node tests/finance-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const path = require('path');
const { Harness } = require('./harness');

const T = [];
const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

let shared = null;   // جهاز واحد لكل اختبارات المحرّك (بيانات تُستبدل في الذاكرة فقط، بلا حفظ)
async function dev(h){
  if (shared) return shared;
  h.server.addUser('f@test.com', 'password1', 'f');
  const D = await h.device('fin'); await D.goto(); await D.login('f@test.com', 'password1'); await D.wait(1200);
  shared = D; return D;
}
// يحمّل fixture في الذاكرة فقط ويعيد قياسات المحرّك — لا save()، فلا شيء يُرفع
const run = (D, fixture, fn) => D.ev(([fx, src]) => {
  data = migrateData(JSON.parse(JSON.stringify(fx))); bumpDataVersion();
  return (new Function('return ' + src))()()();
}, [fixture, fn.toString()]);
const ACC = [ { id:'cash', name:'نقدي', type:'cash', openingBalance:1000 },
              { id:'bank', name:'بنك', type:'bank', openingBalance:5000 },
              { id:'card', name:'بطاقة', type:'card', openingBalance:0 } ];
const tx = (id, type, amount, date, accountId, extra) => Object.assign({ id, type, amount, date, accountId, category:'ف', createdAt:'2025-01-01T00:00:00Z', updatedAt:'2025-01-01T00:00:00Z', version:1 }, extra||{});
const base = () => ({ schemaVersion:16, accounts: ACC, transactions: [
  tx('i1','Income', 9000, '2025-03-01','bank'),
  tx('e1','Expense', 1200.5, '2025-03-05','cash'),
  tx('e2','Expense', 800, '2025-03-31','card'),
  tx('s1','Saving', 1000, '2025-03-10','bank'),
  tx('c1','Charity', 150, '2025-03-12','cash'),
  tx('e3','Expense', 300, '2025-04-01','cash'),
]});

test('F1', 'التحويل بين حسابين لا يغيّر صافي الثروة', async h => {
  const D = await dev(h);
  const a = await run(D, base(), () => () => FE.netWorth().net);
  const fx = base(); fx.transactions.push(tx('t1','Transfer', 2500, '2025-03-15','bank', { toAccountId:'cash' }));
  const b = await run(D, fx, () => () => FE.netWorth().net);
  assert(near(a, b), `قبل ${a} بعد ${b}`);
});
test('F2', 'التحويل لا يدخل الدخل ولا المصروف', async h => {
  const D = await dev(h);
  const fx = base(); fx.transactions.push(tx('t1','Transfer', 2500, '2025-03-15','bank', { toAccountId:'cash' }));
  const r = await run(D, fx, () => () => Q.monthTotals('2025-03'));
  assert(r.inc === 9000 && near(r.exp, 2000.5) && r.sav === 1000 && r.chr === 150, JSON.stringify(r));
});
test('F3', 'الأرصدة = الافتتاحي + الحركات (محسوبة يدوياً)', async h => {
  const D = await dev(h);
  const fx = base(); fx.transactions.push(tx('t1','Transfer', 2500, '2025-03-15','bank', { toAccountId:'cash' }));
  const r = await run(D, fx, () => () => ({ cash:FE.accountBalance('cash'), bank:FE.accountBalance('bank'), card:FE.accountBalance('card') }));
  // cash: 1000 −1200.5 −150 −300 +2500 = 1849.5 · bank: 5000 +9000 −1000 −2500 = 10500 · card: 0 −800 = −800
  assert(near(r.cash, 1849.5) && near(r.bank, 10500) && near(r.card, -800), JSON.stringify(r));
});
test('F4', 'رصيد البطاقة السالب التزام لا أصل', async h => {
  const D = await dev(h);
  const r = await run(D, base(), () => () => { const n=FE.netWorth(); return { assets:n.accountAssets, liab:n.accountLiabilities, net:n.net }; });
  // assets: cash 1000−1200.5−150−300 = −650.5 (حساب أصل سالب يبقى في الأصول بقيمته) + bank 13000 = 12349.5 ; liab: 800
  assert(near(r.liab, 800), 'الالتزامات ' + r.liab);
  assert(near(r.assets, 12349.5), 'الأصول ' + r.assets);
  assert(near(r.net, 11549.5), 'الصافي ' + r.net);
});
test('F5', 'حذف/تعديل حركة يحدّث كل المجاميع المعتمدة', async h => {
  const D = await dev(h);
  const r = await run(D, base(), () => () => {
    const before={ exp:Q.monthTotals('2025-03').exp, cash:FE.accountBalance('cash'), nw:FE.netWorth().net };
    data.transactions = data.transactions.filter(t=>t.id!=='e1'); bumpDataVersion();
    const del={ exp:Q.monthTotals('2025-03').exp, cash:FE.accountBalance('cash'), nw:FE.netWorth().net };
    data.transactions.find(t=>t.id==='e2').amount = 500; bumpDataVersion();
    const ed={ exp:Q.monthTotals('2025-03').exp, card:FE.accountBalance('card') };
    return { before, del, ed };
  });
  assert(near(r.del.exp, r.before.exp - 1200.5) && near(r.del.cash, r.before.cash + 1200.5) && near(r.del.nw, r.before.nw + 1200.5), JSON.stringify(r));
  assert(near(r.ed.exp, 500) && near(r.ed.card, -500), JSON.stringify(r.ed));
});
test('F6', 'حدود الشهور: 31 مارس في مارس و1 أبريل في أبريل', async h => {
  const D = await dev(h);
  const r = await run(D, base(), () => () => ({ mar:Q.monthTotals('2025-03').exp, apr:Q.monthTotals('2025-04').exp }));
  assert(near(r.mar, 2000.5) && near(r.apr, 300), JSON.stringify(r));
});
test('F7', 'معدل الادخار المعلن = ادخار ÷ دخل', async h => {
  const D = await dev(h);
  const r = await run(D, base(), () => () => aiExec('get_overview', { month:'2025-03' }).savings_rate_pct);
  assert(r === Math.round(1000/9000*100), 'savings_rate ' + r);
});
test('F8', 'الدقة العشرية: 0.1 + 0.2 تُعرض 0.3', async h => {
  const D = await dev(h);
  const fx = { schemaVersion:16, accounts:ACC, transactions:[ tx('a','Expense',0.1,'2025-05-01','cash'), tx('b','Expense',0.2,'2025-05-02','cash') ] };
  const r = await run(D, fx, () => () => ({ raw:Q.monthTotals('2025-05').exp, shown:fmt(Q.monthTotals('2025-05').exp) }));
  assert(near(r.raw, 0.3), 'raw ' + r.raw);
  const shown = String(r.shown).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace('٫','.').replace(/[^\d.]/g,'');
  assert(Number(shown) === 0.3, 'العرض ' + r.shown);
});
test('F9', 'مبالغ غير صالحة/غير منتهية تُرفض', async h => {
  const D = await dev(h);
  const r = await run(D, base(), () => () => [NaN, Infinity, -5, 0, '1e400', 'abc', null].map(a => !!(addTransaction({ type:'Expense', amount:a, category:'x' })||{}).error));
  assert(r.every(Boolean), JSON.stringify(r));
});
test('F10', 'حركة بمبلغ تالف داخل البيانات لا تفسد المجاميع', async h => {
  const D = await dev(h);
  const fx = base(); fx.transactions.push(tx('bad','Expense','abc','2025-03-20','cash'));
  const r = await run(D, fx, () => () => ({ exp:Q.monthTotals('2025-03').exp, nw:FE.netWorth().net }));
  assert(near(r.exp, 2000.5) && isFinite(r.nw), JSON.stringify(r));
});
test('F11', 'ملاحظة موثّقة: الادخار يخصم من رصيد الحساب وصافي الثروة (قاعدة عمل مطلوب حسمها)', async h => {
  const D = await dev(h);
  const r = await run(D, { schemaVersion:16, accounts:[ACC[1]], transactions:[ tx('i','Income',1000,'2025-06-01','bank') ] }, () => () => FE.netWorth().net);
  const r2 = await run(D, { schemaVersion:16, accounts:[ACC[1]], transactions:[ tx('i','Income',1000,'2025-06-01','bank'), tx('s','Saving',300,'2025-06-02','bank') ] }, () => () => FE.netWorth().net);
  // يسجّل السلوك الحالي كما هو (لا يغيّر المعادلة): الادخار ينقص الصافي بقيمته
  assert(near(r - r2, 300), `فرق ${r - r2}`);
  return { netBefore:r, netAfterSaving:r2 };
});

// ── Mobile smoke ─────────────────────────────────────────────
test('M1', 'موبايل: RTL، بلا تمرير أفقي في التبويبات، رأسي وأفقي', async h => {
  h.server.addUser('m@test.com', 'password1', 'm');
  const out = {};
  for (const [w, hgt] of [[360, 740], [740, 360]]) {
    const D = await h.device('m' + w); await D.page.setViewportSize({ width: w, height: hgt });
    await D.goto(); await D.login('m@test.com', 'password1'); await D.wait(1200);
    await D.addTx({ amount: 1234567.89, category: 'فئة باسم طويل جداً لاختبار الالتفاف في الشاشات الصغيرة' });
    for (const tab of ['home', 'list', 'chart', 'settings']) {
      await D.ev((t)=>switchTab(t), tab); await D.wait(400);
      const r = await D.ev(()=>({ dir: document.documentElement.dir || getComputedStyle(document.body).direction,
                                  sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      assert(/rtl/.test(r.dir), 'الاتجاه ' + r.dir);
      assert(r.sw <= r.iw + 1, `${w}x${hgt} ${tab}: تمرير أفقي ${r.sw} > ${r.iw}`);
      if (tab === 'home') await D.page.screenshot({ path: path.join(__dirname, `shot-mobile-${w}x${hgt}.png`) });
    }
    out[w+'x'+hgt] = 'ok';
  }
  return out;
});

(async () => {
  const file = process.argv[2]; const filter = process.argv[3];
  const h = new Harness(file); await h.start();
  const results = [];
  for (const t of T) {
    if (filter && !filter.split(',').includes(t.id)) continue;
    const t0 = Date.now(); let err = null, info = null;
    try { info = await Promise.race([ t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 90s')),90000)) ]); }
    catch (e) { err = e; }
    results.push({ id: t.id, name: t.name, pass: !err, error: err && err.message, info, ms: Date.now()-t0 });
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(5)} ${t.name}${info?'  '+JSON.stringify(info):''}${err?'\n        → '+err.message.split('\n')[0]:''}`);
  }
  const logs = h.devices.flatMap(d => d.logs.filter(l=>/pageerror/.test(l)).map(l=>d.name+': '+l));
  if (logs.length) console.log('page errors:', logs.slice(0,5));
  await h.closeDevices(); await h.stop();
  console.log(`\n${results.filter(r=>r.pass).length}/${results.length} passed`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
})();
