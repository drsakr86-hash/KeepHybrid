// Income sources & clinics tests. Usage: node tests/income-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const path = require('path');
const { Harness, until } = require('./harness');

const T = []; const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const near = (a, b, e=0.01) => Math.abs(a - b) < e;
async function dev(h, name='i'){
  if (!h.server.users.has('i@test.com')) h.server.addUser('i@test.com', 'password1', 'i');
  const D = await h.device(name); await D.goto(); await D.login('i@test.com', 'password1'); await D.wait(1200); return D;
}
const ym = (k) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); };
const PAST = '2020-01-01T00:00:00.000Z';
const tx = (id, type, amount, date, extra) => Object.assign({ id, type, amount, date, accountId:'bank', category:'ف', createdAt:PAST, updatedAt:PAST, version:1 }, extra||{});
const PLAN = { v:1, answers:{}, emergencyMonths:6, savingsRatePct:20, allocation:{ cert:50, gold:20, equity:30 }, createdAt:'2021-01-01T00:00:00.000Z' };
// 6 شهور: مركز دمنهور 10000 · عيادة الرحمانية 8000 بمصاريف 3000 · مياه بيضاء: آخر 3 شهور 2 حالة × 4500، قبلها حالة × 4500
// مصروف شخصي 9000 شهرياً
const FX = () => ({ schemaVersion:16, accounts:[ { id:'bank', name:'بنك', type:'bank', openingBalance:0 } ], plan:PLAN,
  transactions:[1,2,3,4,5,6].flatMap(k=>[
    tx('s'+k,'Income',10000, ym(k)+'-01', { category:'مركز دمنهور للعيون', sourceId:'sal_dmn' }),
    tx('c'+k,'Income', 8000, ym(k)+'-10', { category:'عيادة الرحمانية', sourceId:'cl_rah' }),
    tx('ce'+k,'Expense',3000, ym(k)+'-11', { category:'إيجار عيادة', bizId:'cl_rah' }),
    tx('o'+k,'Income', k<=3 ? 9000 : 4500, ym(k)+'-15', { category:'عمليات المياه البيضاء', sourceId:'op_cat', cases: k<=3 ? 2 : 1 }),
    tx('e'+k,'Expense',9000, ym(k)+'-20', { category:'أكل' }) ]) });
const load = (D, fx) => D.ev((fx)=>{ data = migrateData(fx); bumpDataVersion(); save(); refreshUI(); return true; }, fx);

test('IN1', 'الإضافة: اختيار مصدر بعدد حالات ⇒ الحركة مربوطة بالمصدر والعدد', async h => {
  const D = await dev(h);
  await D.ev(()=>{ openQadd('Income'); }); await D.wait(300);
  const chips = await D.ev(()=>[...document.querySelectorAll('#qaddSrcRow .acc-chip')].map(b=>b.textContent.trim()));
  assert(chips.length === 9 && chips.some(c=>/المياه البيضاء/.test(c)), 'المصادر: ' + chips);
  await D.ev(()=>pickQaddSrc('op_cat'));
  assert(await D.ev(()=>getComputedStyle(document.getElementById('qaddCasesWrap')).display!=='none'), 'خانة الحالات مخفية');
  await D.ev(()=>{ document.getElementById('qaddAmt').value='13500'; document.getElementById('qaddCases').value='3'; submitQadd(); });
  const t = await D.ev(()=>data.transactions.find(x=>x.type==='Income'));
  assert(t.sourceId === 'op_cat' && t.cases === 3 && t.category === 'عمليات المياه البيضاء', JSON.stringify(t));
  await D.ev(()=>{ closeSplit && closeSplit(); openQadd('Income'); pickQaddSrc('sal_dmn'); });
  assert(await D.ev(()=>getComputedStyle(document.getElementById('qaddCasesWrap')).display==='none'), 'الحالات ظاهرة لراتب');
});

test('IN2', 'مصروف على العيادة ⇒ bizId، ولا يدخل في المصروف الشخصي ولا الطوارئ', async h => {
  const D = await dev(h);
  await D.ev(()=>{ openQadd('Expense'); }); await D.wait(200);
  const biz = await D.ev(()=>[...document.querySelectorAll('#qaddBizRow .acc-chip')].map(b=>b.textContent.trim()));
  assert(biz.length === 3 && /شخصي/.test(biz[0]), 'خيارات: ' + biz);
  await D.ev(()=>{ pickQaddBiz('cl_dmn'); document.getElementById('qaddAmt').value='2500'; document.getElementById('qaddCat').value='مستلزمات'; submitQadd(); });
  const r = await D.ev(()=>({ t:data.transactions[0], p:SRC.personal(cur_month()), g:Q.monthTotals(cur_month()) }));
  assert(r.t.bizId === 'cl_dmn' && r.g.exp === 2500 && r.p.exp === 0 && r.p.biz === 2500, JSON.stringify(r));
});

test('IN3', 'إحصاءات المصادر: المتوسط والاتجاه وعدد الحالات ودخلك المضمون', async h => {
  const D = await dev(h); await load(D, FX());
  const r = await D.ev(()=>({ cat:SRC.stats('op_cat'), sal:SRC.stats('sal_dmn'), g:SRC.guaranteed(), pm:SRC.month(MR.prevMonth()), net:SRC.clinicNet(MR.prevMonth(),'cl_rah'), avgExp:HE.avgMonthlyExpense(cur_month(),6) }));
  assert(near(r.cat.avg6, (9000*3+4500*3)/6) && near(r.cat.trend, 1), 'مياه بيضاء ' + JSON.stringify(r.cat));
  assert(near(r.sal.avg6, 10000) && near(r.sal.trend, 0), 'راتب ' + JSON.stringify(r.sal));
  assert(r.pm.op_cat.cases === 2 && r.pm.op_cat.amount === 9000, JSON.stringify(r.pm));
  // الشخصي = 10000 + 8000 + (9000 أو 4500) − 3000 ⇒ أقل شهر 19500
  assert(r.g.ready && near(r.g.min, 19500) && near(r.g.max, 24000), JSON.stringify(r.g));
  assert(near(r.net.net, 5000), JSON.stringify(r.net));
  assert(near(r.avgExp, 9000), 'متوسط المصروف الشخصي ' + r.avgExp);       // 12000 إجمالي − 3000 عيادة
});

test('IN4', 'تقسيم دخل العيادة يحجز مصاريفها، والدخل فوق المضمون يُدّخر منه 50%', async h => {
  const D = await dev(h); await load(D, FX());
  const r = await D.ev(()=>{
    const a=addTransaction({ type:'Income', amount:8000, category:'عيادة الرحمانية', sourceId:'cl_rah', accountId:'bank' });
    const pa=IE.propose(a);
    // دخل كبير بعده يعدّي المضمون (19500): الشهر فيه 8000 ⇒ 30000 جديدة: 11500 أساس + 18500 زيادة
    const b=addTransaction({ type:'Income', amount:30000, category:'مركز دمنهور للعيون', sourceId:'sal_dmn', accountId:'bank' });
    const pb=IE.propose(b);
    return { a:{ obl:pa.obl, items:pa.oblItems.map(i=>i.title), save:pa.saveTarget }, b:{ save:pb.saveTarget, why:pb.why } };
  });
  assert(r.a.items.some(t=>/مصاريف عيادة الرحمانية/.test(t)) && near(r.a.obl, 3000), JSON.stringify(r.a));
  assert(r.b.save === Math.round(11500*0.2 + 18500*0.5), 'ادخار ' + JSON.stringify(r.b));
});

test('IN5', 'المساعد: مصدر وعدد حالات للدخل، وعيادة للمصروف', async h => {
  const D = await dev(h);
  const r = await D.ev(()=>{ _ai.turnKeys=new Map();
    const a=aiExec('add_transaction', { type:'Income', amount:13500, category:'مياه بيضاء', source:'عمليات المياه البيضاء', cases:3 });
    const b=aiExec('add_transaction', { type:'Income', amount:2000, category:'حقن انترافيتريال' });
    const c=aiExec('add_transaction', { type:'Expense', amount:1500, category:'مستلزمات', clinic:'عيادة دمنهور' });
    const d=aiExec('add_transaction', { type:'Income', amount:5000, category:'عيادة دمنهور' });
    const T=(id)=>data.transactions.find(t=>t.id===id);
    return [T(a.id), T(b.id), T(c.id), T(d.id)].map(t=>({ s:t.sourceId, c:t.cases, b:t.bizId, cat:t.category })); });
  assert(r[0].s==='op_cat' && r[0].c===3 && r[0].cat==='عمليات المياه البيضاء', JSON.stringify(r[0]));
  assert(r[1].s==='op_inj' && !r[1].c, JSON.stringify(r[1]));
  assert(r[2].b==='cl_dmn', JSON.stringify(r[2]));
  assert(r[3].s==='cl_dmn', 'عيادة دمنهور اتعرفت ' + JSON.stringify(r[3]));
});

test('IN6', 'تعديل المصادر: إعادة التسمية لا تفقد الربط، الإيقاف يخفي من الإضافة، التكرار مرفوض', async h => {
  const D = await dev(h); await load(D, FX());
  await D.ev(()=>{ switchTab('chart'); switchAnalysis('wealth'); _srcEdit=true; renderIncomeCard(); }); await D.wait(300);
  await D.page.fill('#seN0', 'مركز دمنهور'); await D.page.uncheck('#seA2');
  assert((await D.ev(()=>saveSources())) === true, 'لم يحفظ');
  const r = await D.ev(()=>({ prev:SRC.month(MR.prevMonth()).sal_dmn, name:SRC.byId('sal_dmn').name, chips:(openQadd('Income'), [...document.querySelectorAll('#qaddSrcRow .acc-chip')].map(b=>b.textContent.trim())) }));
  assert(r.name === 'مركز دمنهور' && r.prev && r.prev.amount === 10000, JSON.stringify(r));
  assert(r.chips.length === 8 && !r.chips.some(c=>/مستشفى/.test(c)), 'الموقوف ظاهر: ' + r.chips);
  await D.ev(()=>{ closeQadd(); switchTab('chart'); switchAnalysis('wealth'); _srcEdit=true; renderIncomeCard(); }); await D.wait(200);
  await D.page.fill('#seN1', 'مركز دمنهور');
  assert((await D.ev(()=>saveSources())) === false, 'قُبل اسم مكرر');
});

test('IN7', 'تنبيه: مصدر نزل لأقل من نص متوسطه الشهر اللي فات', async h => {
  const D = await dev(h);
  const fx = FX(); fx.transactions = fx.transactions.filter(t=>t.id!=='s1');      // راتب مركز دمنهور غاب الشهر اللي فات
  await load(D, fx);
  const al = await D.ev(()=>smartAlerts().map(a=>a.id));
  assert(al.some(id=>id.startsWith('srcdrop:sal_dmn')), JSON.stringify(al));
});

test('IN8', 'كارت مصادر الدخل على موبايل 360 + المساعد يستلم الأرقام', async h => {
  const D = await dev(h); await D.page.setViewportSize({ width:360, height:780 });
  await load(D, FX());
  await D.ev(()=>{ _incMonth=MR.prevMonth(); switchTab('chart'); switchAnalysis('wealth'); }); await D.wait(500);
  const r = await D.ev(()=>({ sw:document.documentElement.scrollWidth, iw:innerWidth, txt:document.getElementById('incomeCard').textContent, ai:aiExec('get_overview',{}).income_sources }));
  assert(r.sw <= r.iw + 1, `تمرير أفقي ${r.sw}>${r.iw}`);
  assert(/دخلك المضمون/.test(r.txt) && /2 حالة/.test(r.txt) && /صافي العيادات/.test(r.txt), r.txt.slice(0,300));
  assert(r.ai.guaranteed_income.min === 19500 && r.ai.clinics.find(c=>c.name==='عيادة الرحمانية').last_month.net === 5000, JSON.stringify(r.ai).slice(0,300));
  await D.page.evaluate(()=>document.getElementById('incomeCard').scrollIntoView());
  await D.page.screenshot({ path: path.join(__dirname, 'shot-income.png') });
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
