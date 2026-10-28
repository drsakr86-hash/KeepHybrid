// Monthly-chunk cloud format tests. Usage: node chunk-suite.js <app.html> <old-app.html> [filter]
'use strict';
const fs = require('fs');
const { Harness, until } = require('./harness');

const T = [];
const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const OLD = process.argv[3];

const setup = (h, email='a@test.com') => h.server.addUser(email, 'password1', email.split('@')[0]);
async function loggedIn(h, email, opts){
  const D = await h.device(email.split('@')[0], opts); await D.goto(); await D.login(email, 'password1');
  return D;
}
const settle = (D, ms=1600) => D.wait(ms);
const ACC = [{id:'acc_cash',name:'نقدي',type:'cash',openingBalance:0}];
const mkTx = (n, months, pad=0) => Array.from({length:n}, (_,i)=>{
  const m = String(1 + (i % months)).padStart(2,'0');
  return { id:'t'+i, date:`2025-${m}-1${i%9}`, type: i%5? 'Expense':'Income', category:'فئة '+(i%7), amount: 10+i,
           accountId:'acc_cash', description: 'وصف '.repeat(pad), tags:[], createdAt:'2025-01-01T00:00:00.000Z',
           updatedAt:'2025-01-01T00:00:00.000Z', version:1 };
});
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const backups = (D) => D.ev(()=>{ const k=Object.keys(localStorage).find(k=>k.startsWith('km_local_backups__')); try{ return JSON.parse(localStorage.getItem(k)||'[]').map(b=>b.reason); }catch(e){ return []; } });

test('CH1', 'السحابة بالشكل القديم ⇒ أول تعديل يقسّمها بالشهر بدون فقد + نسخة احتياطية', async h => {
  const uid = setup(h);
  const tx = mkTx(40, 4);
  h.server.seedDoc('users/'+uid, { schemaVersion:16, transactions:tx, accounts:ACC, savingsGoal:777, updatedAt:{__serverTimestamp:true} });
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  assert((await A.txIds()).length === 40, 'التحميل من الشكل القديم: ' + (await A.txIds()).length);
  const id = await A.addTx({ amount: 5, date:'2025-02-05' });
  await until(async () => (h.cloudTxIds(uid)||[]).includes(id), 8000);
  const main = h.server.rawMain(uid);
  assert(main._fmt === 4, '_fmt = ' + main._fmt);
  assert(!('transactions' in main), 'الحركات لسه في المستند الرئيسي');
  assert(main.savingsGoal === 777, 'حقل عام ضاع: ' + main.savingsGoal);
  assert(same(h.server.chunkPaths(uid), ['2025-01','2025-02','2025-03','2025-04'].map(k=>'users/'+uid+'/tx/'+k)), 'الأجزاء: ' + h.server.chunkPaths(uid));
  assert(same(h.cloudTxIds(uid), await A.txIds()), 'السحابة ≠ الجهاز');
  assert((h.cloudTxIds(uid)||[]).length === 41, 'العدد في السحابة: ' + (h.cloudTxIds(uid)||[]).length);
  assert((await backups(A)).includes('pre-monthly-split'), 'لا توجد نسخة احتياطية قبل التقسيم: ' + await backups(A));
  assert(await A.badge() === 'synced', 'الشارة: ' + await A.badge());
});

test('CH2', 'بيانات أكبر من 1MB (6000 حركة) ⇒ تترفع وجهاز جديد يستلمها كاملة', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev((tx)=>{ data.transactions.push(...tx); save(); }, mkTx(6000, 12, 12));
  const total = await A.ev(()=>data.transactions.length);
  const size = Buffer.byteLength(JSON.stringify(mkTx(6000,12,12)));
  assert(size > 1100000, 'الحجم مش كبير كفاية للاختبار: ' + size);
  const ok = await until(async () => (h.cloudTxIds(uid)||[]).length === total, 20000);
  assert(ok, 'لم ترفع كل الحركات: ' + (h.cloudTxIds(uid)||[]).length + '/' + total);
  await A.wait(400);
  assert(await A.badge() === 'synced', 'الشارة: ' + await A.badge());
  const mainSize = Buffer.byteLength(JSON.stringify(h.server.rawMain(uid)));
  assert(mainSize < 200000, 'المستند الرئيسي كبير: ' + mainSize);
  const B = await loggedIn(h, 'a@test.com'); await settle(B, 2500);
  assert(same(await B.txIds(), await A.txIds()), 'الجهاز الجديد لم يستلم الكل: ' + (await B.txIds()).length);
  return { size, total };
});

test('CH3', 'إضافة حركة ⇒ يُكتب المستند الرئيسي + شهر واحد فقط', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev((tx)=>{ data.transactions.push(...tx); save(); }, mkTx(600, 12));
  await until(async () => (h.cloudTxIds(uid)||[]).length >= 600, 10000); await A.wait(500);
  const w0 = h.server.writes.length;
  const id = await A.addTx({ amount: 3, date:'2025-07-02' });
  await until(async () => (h.cloudTxIds(uid)||[]).includes(id), 8000); await A.wait(300);
  const w = h.server.writes.slice(w0).map(x=>x.path).sort();
  assert(same(w, ['users/'+uid, 'users/'+uid+'/tx/2025-07']), 'الكتابات: ' + w.join(', '));
});

test('CH4', 'جهاز تاني يسحب الشهر اللي اتغيّر بس', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev((tx)=>{ data.transactions.push(...tx); save(); }, mkTx(600, 12));
  await until(async () => (h.cloudTxIds(uid)||[]).length >= 600, 10000);
  const B = await loggedIn(h, 'a@test.com'); await settle(B, 2000);
  assert((await B.txIds()).length === (await A.txIds()).length, 'B لم يكتمل');
  const id = await A.addTx({ amount: 3, date:'2025-03-02' });
  await until(async () => (h.cloudTxIds(uid)||[]).includes(id), 8000); await A.wait(300);
  const r0 = h.server.reads.length;
  await B.sync(); await B.wait(300);
  const r = h.server.reads.slice(r0).filter(x=>x.dev===B.id).map(x=>x.path);
  assert((await B.txIds()).includes(id), 'B لم يستلم الحركة');
  const chunkReads = r.filter(p=>p.includes('/tx/'));
  assert(same(chunkReads, ['users/'+uid+'/tx/2025-03']), 'قراءات الأجزاء: ' + chunkReads.join(', '));
});

test('CH5', 'جهازان يعدّلان شهوراً مختلفة + حذف + نقل حركة لشهر آخر ⇒ يتقاربان', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev((tx)=>{ data.transactions.push(...tx); save(); }, mkTx(120, 6));
  await until(async () => (h.cloudTxIds(uid)||[]).length >= 120, 10000);
  const B = await loggedIn(h, 'a@test.com'); await settle(B, 2000);
  await A.offline(true); await B.offline(true);
  const a1 = await A.addTx({ amount: 1, date:'2025-01-03' });
  const b1 = await B.addTx({ amount: 2, date:'2025-05-03' });
  await B.ev(()=>{ const t=data.transactions.find(x=>x.id==='t6'); t.date='2025-06-20'; save(); });   // t6 كان في يناير
  await A.ev(()=>{ deleteTransaction ? deleteTransaction('t13') : null; });
  await A.wait(800); await B.wait(800);
  await A.offline(false); await A.sync(); await A.wait(800);
  await B.offline(false); await B.sync(); await B.wait(800);
  await A.sync(); await A.wait(800);
  const cloud = h.cloudTxIds(uid), a = await A.txIds(), b = await B.txIds();
  assert(cloud.includes(a1) && cloud.includes(b1), 'إضافة ضاعت');
  assert(!cloud.includes('t13'), 'المحذوف رجع');
  assert(same(a, cloud) && same(b, cloud), `عدم تقارب A=${a.length} B=${b.length} C=${cloud.length}`);
  const t6 = h.server.cloudData(uid).transactions.filter(t=>t.id==='t6');
  assert(t6.length===1 && t6[0].date==='2025-06-20', 'نقل الشهر: ' + JSON.stringify(t6.map(t=>t.date)));
  const jan = h.server.docs.get('users/'+uid+'/tx/2025-01').data.transactions.map(t=>t.id);
  assert(!jan.includes('t6'), 't6 لسه في جزء يناير');
});

test('CH6', 'شهر ضخم (> 700KB) يتقسّم لأجزاء ويرجع كامل', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev((tx)=>{ data.transactions.push(...tx); save(); }, mkTx(4000, 1, 12));
  const ok = await until(async () => (h.cloudTxIds(uid)||[]).length >= 4000, 20000);
  assert(ok, 'لم ترفع: ' + (h.cloudTxIds(uid)||[]).length);
  const parts = h.server.chunkPaths(uid).map(p=>p.split('/').pop());
  assert(parts.length >= 2 && parts.includes('2025-01_2'), 'الأجزاء: ' + parts);
  const B = await loggedIn(h, 'a@test.com'); await settle(B, 2500);
  assert(same(await B.txIds(), await A.txIds()), 'B ناقص');
});

test('CH7', 'نسخة قديمة من التطبيق بعد التقسيم ⇒ لا تكتب فوق السحابة ولا تمسح بياناتها المحلية', async h => {
  assert(OLD && fs.existsSync(OLD), 'ملف النسخة القديمة غير موجود');
  const uid = setup(h); if(process.env.NEG) h.server.legacyRules = true;
  h.server.seedDoc('users/'+uid, { schemaVersion:16, transactions:mkTx(30,3), accounts:ACC, updatedAt:{__serverTimestamp:true} });
  const O = await loggedIn(h, 'a@test.com', { appFile: OLD }); await settle(O);
  assert((await O.txIds()).length === 30, 'القديمة لم تحمل');
  const N = await loggedIn(h, 'a@test.com'); await settle(N);
  const n1 = await N.addTx({ amount: 9, date:'2025-02-09' });
  await until(async () => (h.cloudTxIds(uid)||[]).includes(n1), 8000);
  const before = JSON.stringify(h.server.cloudData(uid));
  const o1 = await O.addTx({ amount: 8, date:'2025-03-09' });
  await O.wait(2500); await O.sync().catch(()=>{}); await O.wait(800);
  const after = JSON.stringify(h.server.cloudData(uid));
  assert(before === after, 'النسخة القديمة غيّرت السحابة');
  const ol = await O.txIds();
  assert(ol.length >= 31 && ol.includes(o1), 'النسخة القديمة فقدت بياناتها المحلية: ' + ol.length);
  assert(await O.badge() !== 'synced', 'النسخة القديمة تقول متزامن: ' + await O.badge());
});

test('CH8', 'قواعد Firestore لسه قديمة (tx مقفول) ⇒ خطأ واضح، السحابة القديمة سليمة، المحلي معلّق', async h => {
  const uid = setup(h);
  h.server.seedDoc('users/'+uid, { schemaVersion:16, transactions:mkTx(20,2), accounts:ACC, updatedAt:{__serverTimestamp:true} });
  h.server.denyChunks = true;
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const before = JSON.stringify(h.server.rawMain(uid));
  const id = await A.addTx({ amount: 4 });
  await A.wait(2500);
  assert(JSON.stringify(h.server.rawMain(uid)) === before, 'المستند الرئيسي اتغيّر رغم رفض الأجزاء (العملية مش ذرّية)');
  assert(await A.badge() === 'error', 'الشارة: ' + await A.badge());
  assert(await A.pending() === true, 'التعليق اتمسح');
  h.server.denyChunks = false;
  await A.sync();
  assert(await until(async () => (h.cloudTxIds(uid)||[]).includes(id), 8000), 'لم يرفع بعد نشر القواعد');
  assert((h.cloudTxIds(uid)||[]).length === 21, 'العدد: ' + (h.cloudTxIds(uid)||[]).length);
});

test('CH9', 'شكل سحابي أحدث (_fmt 5) ⇒ "حدّث التطبيق" ولا كتابة', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.addTx({ amount: 4 }); await A.wait(1500);
  h.server.seedDoc('users/'+uid, { _fmt:5, _chunks:{}, accounts:ACC, updatedAt:{__serverTimestamp:true} });
  const before = JSON.stringify(h.server.rawMain(uid));
  const n = (await A.txIds()).length;
  await A.addTx({ amount: 6 }); await A.wait(2000);
  assert(JSON.stringify(h.server.rawMain(uid)) === before, 'كتب فوق شكل أحدث');
  assert(await A.badge() === 'outdated', 'الشارة: ' + await A.badge());
  assert((await A.txIds()).length === n+1, 'المحلي اتأثر');
});

test('CH10', 'مسح كل الحركات ⇒ أجزاء الشهور تتحذف', async h => {
  const uid = setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev((tx)=>{ data.transactions.push(...tx); save(); }, mkTx(60, 3));
  await until(async () => h.server.chunkPaths(uid).length >= 3, 8000); await A.wait(400);
  await A.ev(()=>{ data.transactions.slice().forEach(t=>deleteTransaction(t.id)); save(); });
  await until(async () => (h.cloudTxIds(uid)||[1]).length === 0, 8000); await A.wait(400);
  assert(h.server.chunkPaths(uid).length === 0, 'أجزاء باقية: ' + h.server.chunkPaths(uid));
  assert(await A.badge() === 'synced', 'الشارة: ' + await A.badge());
});

(async () => {
  const file = process.argv[2]; const filter = process.argv[4];
  const h = new Harness(file); await h.start();
  const results = [];
  for (const t of T) {
    if (filter && !filter.split(',').includes(t.id)) continue;
    h.server.reset();
    const t0 = Date.now(); let err = null, info = null;
    try { info = await Promise.race([ t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 90s')),90000)) ]); }
    catch (e) { err = e; }
    const logs = h.devices.flatMap(d => d.logs.filter(l=>/pageerror/.test(l)).map(l=>d.name+': '+l));
    await h.closeDevices();
    results.push({ id: t.id, name: t.name, pass: !err, error: err && err.message, info, ms: Date.now()-t0 });
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(5)} ${t.name}${info?'  '+JSON.stringify(info):''}${err?'\n        → '+err.message.split('\n')[0]:''}${logs.length?'\n        ! '+logs[0]:''}`);
  }
  await h.stop();
  console.log(`\n${results.filter(r=>r.pass).length}/${results.length} passed`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
})();
