// H-01 session/offline-access tests. Usage: node tests/security-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const { Harness, until } = require('./harness');

const T = [];
const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const setup = (h, email='a@test.com') => h.server.addUser(email, 'password1', email.split('@')[0]);
async function loggedIn(h, email){ const D = await h.device(email.split('@')[0]); await D.goto(); await D.login(email, 'password1'); return D; }
const settle = (D, ms=1600) => D.wait(ms);
const memTx = (D) => D.ev(()=> (data && data.transactions || []).map(t=>t.id));
const gate = (D) => D.ev(()=>({ offline: getComputedStyle(document.getElementById('authOffline')).display!=='none',
                                form: getComputedStyle(document.getElementById('offlineForm')).display!=='none',
                                msg: document.getElementById('offlineMsg').textContent }));
async function goOfflineNoSdk(D){ D.state.firebaseAvailable = false; await D.offline(true); await D.reload(); await D.wait(1500); }

test('S1', 'Firebase متاح ومستخدم صحيح ⇒ يفتح بياناته', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 11 });
  assert(await A.appVisible(), 'لم يفتح'); assert((await memTx(A)).includes(id), 'الحركة غير ظاهرة');
});

test('S2', 'Firebase غير متاح + مستخدم متذكَّر ⇒ لا فتح بدون كلمة المرور، وقفل متصاعد', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 22 }); await settle(A);
  await goOfflineNoSdk(A);
  assert(!(await A.appVisible()), 'البيانات فُتحت تلقائياً');
  assert((await memTx(A)).length === 0, 'بيانات الحساب محمّلة في الذاكرة قبل الفتح');
  const g = await gate(A); assert(g.offline && g.form, 'شاشة الفتح غير ظاهرة: ' + JSON.stringify(g));
  for (let i = 0; i < 3; i++) { await A.page.fill('#offlinePassword', 'bad'+i); await A.ev(()=>offlineUnlock()); await A.wait(700); }
  assert(!(await A.appVisible()), 'فُتح بكلمة خاطئة');
  // بعد 3 محاولات خاطئة: انتظار 5 ث — حتى الكلمة الصحيحة تُرفض خلاله
  await A.page.fill('#offlinePassword', 'password1'); await A.ev(()=>offlineUnlock()); await A.wait(700);
  assert(!(await A.appVisible()), 'القفل المؤقت لم يمنع المحاولة');
  await A.wait(5200);
  await A.page.fill('#offlinePassword', 'password1'); await A.ev(()=>offlineUnlock()); await A.waitApp();
  assert((await memTx(A)).includes(id), 'البيانات غير ظاهرة بعد الفتح الصحيح');
  assert(await A.badge() === 'local', 'الشارة: ' + await A.badge());
});

test('S2b', 'كلمة المرور لا تُخزَّن نصاً على الجهاز', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const dump = await A.ev(()=>JSON.stringify(Object.assign({}, localStorage)));
  assert(!dump.includes('password1'), 'كلمة المرور مخزّنة نصاً');
  assert(dump.includes('km_offline_unlock'), 'لم يُجهَّز مُتحقِّق الفتح');
});

test('S3', 'Firebase غير متاح + مستخدم متذكَّر بلا فتح مجهَّز ⇒ لا فتح ولا نموذج', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.addTx({ amount: 33 }); await settle(A);
  await A.ev(()=>localStorage.removeItem('km_offline_unlock'));       // جلسة مستعادة بلا إدخال كلمة مرور
  await goOfflineNoSdk(A);
  assert(!(await A.appVisible()), 'فُتح بلا تحقق');
  const g = await gate(A); assert(g.offline && !g.form, 'الحالة: ' + JSON.stringify(g));
  await A.ev(()=>offlineUnlock()); await A.wait(500);
  assert(!(await A.appVisible()), 'offlineUnlock فتح بلا مُتحقِّق');
});

test('S4', 'Firebase غير متاح بلا مستخدم متذكَّر ⇒ شاشة ضيف فقط', async h => {
  const A = await h.device('fresh', { firebase:false }); await A.goto(); await A.wait(1200);
  assert(!(await A.appVisible()), 'فتح شيئاً');
  const g = await gate(A); assert(g.offline && !g.form, 'الحالة: ' + JSON.stringify(g));
});

test('S5', 'الضيف اختيار صريح ومنفصل عن بيانات الحساب', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 55 }); await settle(A);
  await goOfflineNoSdk(A);
  await A.ev(()=>guestLogin()); await A.waitApp();
  assert(!(await memTx(A)).includes(id), 'الضيف يرى بيانات الحساب');
  assert(['guest','local'].includes(await A.badge()), 'شارة: ' + await A.badge());
});

test('S6', 'التبديل بين حسابين لا يخلط البيانات', async h => {
  setup(h); const uidB = setup(h, 'b@test.com');
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const idA = await A.addTx({ amount: 4242 }); await settle(A);
  await A.ev(()=>auth.signOut()); await A.wait(500);
  await A.login('b@test.com', 'password1'); await settle(A);
  assert(!(await memTx(A)).includes(idA), 'بيانات أ ظاهرة في ب');
  await A.addTx({ amount: 1 }); await settle(A);
  assert(!JSON.stringify(h.server.cloudData(uidB)||{}).includes(idA), 'بيانات أ رُفعت لمستند ب');
});

test('S7', 'رفع جلسة سابقة يكتمل بعد بدء جلسة أحدث ⇒ لا يكتب في ذاكرة/سحابة الجلسة الجديدة', async h => {
  const uidA = setup(h); const uidB = setup(h, 'b@test.com');
  const A  = await loggedIn(h, 'a@test.com'); await settle(A);
  const X  = await loggedIn(h, 'a@test.com'); await settle(X);              // جهاز آخر لنفس الحساب
  const fromX = await X.addTx({ amount: 777 }); await settle(X);             // السحابة تغيّرت ⇒ رفع A سيدمج
  await A.offline(true);
  const idA = await A.addTx({ amount: 4343 }); await A.wait(900);
  h.server.dev(A.id).delayOp = { commit: 3000 };
  await A.offline(false);
  A.ev(()=>storageAdapter().flush()).catch(()=>{});                          // يبدأ ولا ننتظره
  await A.wait(600);
  await A.ev(()=>auth.signInWithEmailAndPassword('b@test.com','password1')); // جلسة أحدث أثناء الرفع
  await A.waitApp(); await A.wait(4000);                                       // الرفع القديم اكتمل الآن
  h.server.dev(A.id).delayOp = null;
  const mem = await memTx(A);
  assert(!mem.includes(idA) && !mem.includes(fromX), 'بيانات الجلسة القديمة دخلت ذاكرة الجلسة الجديدة');
  await A.addTx({ amount: 2 }); await settle(A, 2000);
  const cb = JSON.stringify(h.server.cloudData(uidB)||{});
  assert(!cb.includes(idA) && !cb.includes(fromX), 'بيانات أ وصلت مستند ب');
  assert((h.cloudTxIds(uidA)||[]).includes(idA), 'رفع أ نفسه ضاع');
});

test('S8', 'الخروج مع رفع معلّق: تحذير، والبيانات تبقى وتُرفع لاحقاً لنفس الحساب', async h => {
  const uid = setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.offline(true);
  const id = await A.addTx({ amount: 66 }); await A.wait(300);
  A.dialogs.length = 0;
  await A.ev(()=>doLogout()); await A.wait(1500);
  assert(A.dialogs.some(d=>/لم تُرفع|لم يُرفع/.test(d.msg)), 'لا تحذير: ' + JSON.stringify(A.dialogs.map(d=>d.msg)));
  await A.offline(false);
  await A.login('a@test.com','password1');
  assert(await until(()=> (h.cloudTxIds(uid)||[]).includes(id), 9000), 'لم تُرفع بعد العودة');
});

test('S9', 'الخروج الصريح يلغي الفتح بدون اتصال لهذا الحساب', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev(()=>doLogout()); await A.wait(1000);
  const has = await A.ev(()=>{ try{ return Object.keys(JSON.parse(localStorage.getItem('km_offline_unlock')||'{}')).length; }catch(e){ return -1; } });
  assert(has === 0, 'المُتحقِّق باقٍ بعد الخروج: ' + has);
});

(async () => {
  const file = process.argv[2]; const filter = process.argv[3];
  const h = new Harness(file); await h.start();
  const results = [];
  for (const t of T) {
    if (filter && !filter.split(',').includes(t.id)) continue;
    h.server.reset();
    const t0 = Date.now(); let err = null;
    try { await Promise.race([ t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 90s')),90000)) ]); }
    catch (e) { err = e; }
    const logs = h.devices.flatMap(d => d.logs.filter(l=>/pageerror/.test(l)).map(l=>d.name+': '+l));
    await h.closeDevices();
    results.push({ id: t.id, name: t.name, pass: !err, error: err && err.message, ms: Date.now()-t0 });
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(5)} ${t.name}${err?'\n        → '+err.message.split('\n')[0]:''}${logs.length?'\n        ! '+logs[0]:''}`);
  }
  await h.stop();
  console.log(`\n${results.filter(r=>r.pass).length}/${results.length} passed`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
})();
