// Extra sync scenarios: ambiguous result, timeout, clear vs pending. Usage: node tests/sync-extra.js <app.html> [filter]
'use strict';
const fs = require('fs');
const { Harness, until } = require('./harness');
const T = []; const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const setup = (h, email='a@test.com') => h.server.addUser(email, 'password1', email.split('@')[0]);
async function loggedIn(h, email){ const D = await h.device(email.split('@')[0]); await D.goto(); await D.login(email, 'password1'); return D; }
const settle = (D, ms=1600) => D.wait(ms);
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const bal = (D) => D.ev(()=>FE.netWorth().net);

test('X1', 'نتيجة شبكة غامضة (نُفّذ لكن الرد ضاع) ⇒ إعادة المحاولة بلا تكرار والحالة صحيحة', async h => {
  const uid = setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  h.server.dev(A.id).ambiguousNext = 1;
  const id = await A.addTx({ amount: 123 }); await A.wait(1500);
  assert(await A.pending() === true, 'التعليق مُسح رغم عدم تأكيد الرد');
  await A.sync(); await A.wait(800);
  const cloud = h.cloudTxIds(uid);
  assert(cloud.filter(x=>x===id).length === 1, 'تكرار/فقد: ' + cloud.filter(x=>x===id).length);
  assert(same(cloud, await A.txIds()) && await A.badge()==='synced', 'لم يتقارب: ' + await A.badge());
});

test('X2', 'انتهاء مهلة العملية ثم اكتمالها متأخراً على السيرفر ⇒ لا كتابة فوق أحدث ولا تكرار', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  h.server.dev(A.id).delayOp = { commit: 27000 };            // أطول من مهلة العميل (25 ث)
  const a1 = await A.addTx({ amount: 1 });
  await A.wait(1200);
  const b1 = await B.addTx({ amount: 2 }); await settle(B);   // جهاز آخر يكتب أثناء الانتظار
  await A.wait(27000);
  h.server.dev(A.id).delayOp = null;
  await A.sync(); await A.wait(1500); await B.sync(); await B.wait(1000);
  const cloud = h.cloudTxIds(uid);
  assert(cloud.includes(a1) && cloud.includes(b1), 'حركة ضاعت: ' + cloud.join(','));
  assert(new Set(cloud).size === cloud.length, 'تكرار');
  assert(same(cloud, await A.txIds()) && same(cloud, await B.txIds()), 'عدم تقارب');
  assert(await bal(A) === await bal(B), 'أرصدة مختلفة');
});

test('X3', 'مسح على جهاز مقابل تعديلات معلّقة أقدم على جهاز آخر ⇒ لا تعود', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.addTx({ amount: 5 }); await A.addTx({ amount: 6 }); await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  await B.offline(true);
  const old = await B.addTx({ amount: 7 }); await B.wait(600);     // تعديل قبل المسح
  await A.ev(()=>clearAll()); await settle(A);
  await B.offline(false); await B.sync(); await B.wait(1200); await A.sync(); await A.wait(800);
  const cloud = h.cloudTxIds(uid);
  assert(!cloud.includes(old), 'تعديل أقدم من المسح عاد');
  assert(same(cloud, await A.txIds()) && same(cloud, await B.txIds()), 'عدم تقارب');
  const after = await B.addTx({ amount: 8 }); await settle(B); await A.sync(); await A.wait(800);
  assert(h.cloudTxIds(uid).includes(after) && (await A.txIds()).includes(after), 'تعديل بعد المسح ضاع');
});

(async () => {
  const file = process.argv[2]; const filter = process.argv[3];
  const h = new Harness(file); await h.start();
  const results = [];
  for (const t of T) {
    if (filter && !filter.split(',').includes(t.id)) continue;
    h.server.reset(); const t0 = Date.now(); let err = null;
    try { await Promise.race([ t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 120s')),120000)) ]); } catch (e) { err = e; }
    const logs = h.devices.flatMap(d => d.logs.filter(l=>/pageerror/.test(l)).map(l=>d.name+': '+l));
    await h.closeDevices();
    results.push({ id: t.id, name: t.name, pass: !err, error: err && err.message, ms: Date.now()-t0 });
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(5)} ${t.name}${err?'\n        → '+err.message.split('\n')[0]:''}${logs.length?'\n        ! '+logs[0]:''}`);
  }
  await h.stop();
  console.log(`\n${results.filter(r=>r.pass).length}/${results.length} passed`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
})();
