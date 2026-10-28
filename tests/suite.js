// keepMoney hybrid sync test-suite. Usage: node suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const { Harness, until } = require('./harness');

const T = [];
const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };

async function setup(h, email='a@test.com'){
  const uid = h.server.addUser(email, 'password1', email.split('@')[0]);
  return uid;
}
async function loggedIn(h, email, uid){
  const D = await h.device(email.split('@')[0]); await D.goto(); await D.login(email, 'password1');
  return D;
}
const settle = (D) => D.wait(1600);

// ── 1. Local write while Firestore unavailable ───────────────────────────
test('R1', 'كتابة محلية ناجحة والسحابة غير متاحة', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.offline(true);
  const id = await A.addTx({ amount: 77 });
  await A.wait(1200);
  const local = await A.localTxIds(uid);
  assert(local && local.includes(id), 'الحركة غير موجودة في التخزين المحلي');
  assert(!(h.cloudTxIds(uid)||[]).includes(id), 'وصلت السحابة رغم الانقطاع؟');
  const b = await A.badge();
  assert(b !== 'synced', 'الشارة تقول "محفوظ سحابياً" والجهاز أوفلاين بتعديل غير مرفوع: ' + b);
});

// ── 2/3. Retry after reconnection clears pending ─────────────────────────
test('R2', 'إعادة الرفع بعد عودة الاتصال ومسح حالة التعليق بعد التأكيد', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.offline(true);
  const id = await A.addTx({ amount: 88 });
  await A.wait(900);
  assert(await A.pending() === true, 'لا توجد حالة تعليق أثناء الانقطاع');
  await A.offline(false);
  const ok = await until(() => (h.cloudTxIds(uid)||[]).includes(id), 8000);
  assert(ok, 'لم تُرفع الحركة بعد عودة الاتصال');
  await A.wait(500);
  assert(await A.pending() === false, 'حالة التعليق لم تُمسح بعد تأكيد السيرفر');
  assert(await A.badge() === 'synced', 'الشارة ليست synced بعد التأكيد: ' + await A.badge());
});

// ── 4. Failed cloud write keeps pending ──────────────────────────────────
test('R4', 'فشل الكتابة السحابية لا يمسح حالة التعليق', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const dev = h.server.dev(A.id);
  dev.failNext.push({ op: '*', code: 'unavailable' }, { op: '*', code: 'unavailable' }, { op: '*', code: 'unavailable' });
  const id = await A.addTx({ amount: 99 });
  await A.wait(2000);
  assert(!(h.cloudTxIds(uid)||[]).includes(id), 'الحركة وصلت رغم حقن الفشل');
  assert(await A.pending() === true, 'التعليق مُسح رغم فشل الكتابة');
  dev.failNext.length = 0;
  await A.sync();
  const ok = await until(() => (h.cloudTxIds(uid)||[]).includes(id), 8000);
  assert(ok, 'إعادة المحاولة لم ترفع الحركة');
});

// ── E. Pending survives reload/close while offline ───────────────────────
test('E', 'تعديل أوفلاين ثم إغلاق الصفحة ثم عودة الاتصال', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.offline(true);
  const id = await A.addTx({ amount: 123 });
  await A.wait(300);
  await A.reload(); await A.waitApp();                 // يُغلق ويُفتح وهو أوفلاين
  assert((await A.txIds()).includes(id), 'الحركة اختفت بعد إعادة التحميل أوفلاين');
  await A.offline(false);
  const ok = await until(() => (h.cloudTxIds(uid)||[]).includes(id), 9000);
  assert(ok, 'التعديل الأوفلاين لم يُرفع بعد العودة (ضاعت حالة التعليق مع إغلاق الصفحة)');
});

// ── Refresh before debounce fires ────────────────────────────────────────
test('E2', 'إعادة تحميل قبل انقضاء مهلة الرفع (700ms)', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  h.server.dev(A.id).delayMs = 0;
  const id = await A.addTx({ amount: 5 });
  await A.reload(); await A.waitApp();
  const ok = await until(() => (h.cloudTxIds(uid)||[]).includes(id), 8000);
  assert(ok, 'الحركة لم تُرفع بعد إعادة التحميل السريعة');
});

// ── 5. Guest never uploads ───────────────────────────────────────────────
test('R5', 'وضع الضيف لا يرفع أي بيانات', async h => {
  const G = await h.device('guest'); await G.goto();
  await G.ev(() => guestLogin()); await G.waitApp();
  await G.addTx({ amount: 42 });
  await G.wait(1500);
  const userDocs = [...h.server.docs.keys()].filter(k => k.startsWith('users/'));
  assert(userDocs.length === 0, 'ضيف رفع مستندات: ' + userDocs.join(','));
  assert(['guest','local'].includes(await G.badge()), 'شارة الضيف: ' + await G.badge());
});

// ── 6. Account isolation (logout → other account) + backups ─────────────
test('G/H', 'عزل الحسابات على نفس الجهاز (بيانات ونسخ احتياطية)', async h => {
  const uidA = await setup(h, 'a@test.com'); const uidB = await setup(h, 'b@test.com');
  const D = await loggedIn(h, 'a@test.com'); await settle(D);
  const secret = await D.addTx({ amount: 31337, category: 'سر-أ' });
  await D.ev(() => backupNow('manual'));
  await settle(D);
  await D.ev(async () => { const a=storageAdapter(); if(a.flush) await a.flush(); await auth.signOut(); });
  await D.wait(500);
  await D.login('b@test.com', 'password1'); await settle(D);
  const leak = await D.ev(s => JSON.stringify(data).includes('31337') , secret);
  assert(!leak, 'بيانات الحساب أ ظاهرة في جلسة الحساب ب');
  const bkLeak = await D.ev(() => readBackups().some(b => (b.payload||'').includes('31337')));
  assert(!bkLeak, 'نسخ الحساب أ الاحتياطية ظاهرة للحساب ب ويمكن استعادتها');
  const cloudB = JSON.stringify(h.server.cloudData(uidB) || {});
  assert(!cloudB.includes('31337'), 'بيانات أ رُفعت لمستند ب');
});

// ── G2. Direct account switch without signOut ────────────────────────────
test('G2', 'تبديل مباشر بين حسابين دون خروج', async h => {
  const uidA = await setup(h, 'a@test.com'); const uidB = await setup(h, 'b@test.com');
  const D = await loggedIn(h, 'a@test.com'); await settle(D);
  await D.addTx({ amount: 4242, category: 'سر-أ' });
  await D.ev(() => auth.signInWithEmailAndPassword('b@test.com','password1'));
  await D.wait(2500);
  const leak = await D.ev(() => JSON.stringify(data).includes('4242'));
  assert(!leak, 'بيانات أ ما زالت في الذاكرة بعد التبديل لـ ب');
  assert(!JSON.stringify(h.server.cloudData(uidB)||{}).includes('4242'), 'بيانات أ وصلت مستند ب');
  // بعد تبديل الهوية لا يمكن (ولا يجوز) الرفع لمستند أ؛ المطلوب ألا يضيع: إمّا رُفع، أو بقي معلّقاً في مساحة أ
  const inCloudA = JSON.stringify(h.server.cloudData(uidA)||{}).includes('4242');
  const keptA = await D.ev(u=>{ try{ const o=JSON.parse(localStorage.getItem('km_local_data__'+u)); return JSON.stringify(o.transactions).includes('4242') && (!!o._pending || true); }catch(e){ return false; } }, uidA);
  assert(inCloudA || keptA, 'تعديل أ المعلّق ضاع (لا في السحابة ولا في مساحة أ المحلية)');
  // ويُرفع عند عودة أ
  if(!inCloudA){
    await D.ev(()=>auth.signInWithEmailAndPassword('a@test.com','password1')); await D.wait(3000);
    assert(JSON.stringify(h.server.cloudData(uidA)||{}).includes('4242'), 'تعديل أ لم يُرفع عند عودته');
  }
});

// ── F/J. Two devices, concurrent edits ───────────────────────────────────
test('F', 'تعديلات متزامنة من جهازين (جهاز قديم مفتوح)', async h => {
  const uid = await setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  const ta = await A.addTx({ amount: 1001, category: 'من-أ' }); await settle(A);
  const tb = await B.addTx({ amount: 2002, category: 'من-ب' }); await settle(B);
  await until(async () => { const c=h.cloudTxIds(uid)||[]; return c.includes(tb); }, 6000);
  const cloud = h.cloudTxIds(uid) || [];
  assert(cloud.includes(ta), 'حركة الجهاز أ ضاعت من السحابة بعد حفظ الجهاز ب');
  assert(cloud.includes(tb), 'حركة الجهاز ب غير موجودة في السحابة');
  const bMem = await B.txIds();
  assert(bMem.includes(ta), 'ذاكرة الجهاز ب لم تستقبل حركة أ بعد الدمج');
  // A pulls later
  await A.sync(); await A.wait(800);
  const aMem = await A.txIds();
  assert(aMem.includes(tb), 'الجهاز أ لم يستقبل حركة ب عند المزامنة');
});

test('J', 'جهاز قديم أوفلاين يعود بعد تعديلات جهاز آخر', async h => {
  const uid = await setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  await A.offline(true);
  const ta = await A.addTx({ amount: 3003, category: 'أوفلاين-أ' }); await A.wait(900);
  const tb = await B.addTx({ amount: 4004, category: 'أونلاين-ب' }); await settle(B);
  await A.offline(false);
  await until(() => (h.cloudTxIds(uid)||[]).includes(ta), 9000);
  const cloud = h.cloudTxIds(uid) || [];
  assert(cloud.includes(ta), 'تعديل أ الأوفلاين لم يصل');
  assert(cloud.includes(tb), 'تعديل ب ضاع بعد عودة الجهاز القديم أ');
});

test('C/D', 'إعادة فتح جهاز بتعديل أوفلاين بعد أن صارت السحابة أحدث', async h => {
  const uid = await setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  await A.offline(true);
  const ta = await A.addTx({ amount: 5005 }); await A.wait(600);
  const tb = await B.addTx({ amount: 6006 }); await settle(B);   // السحابة أحدث الآن
  await A.offline(false); await A.ctx.setOffline(false);
  // A closes before 'online' handler and reopens: hydrate sees cloud newer while local has unsynced edit
  h.server.setOffline(A.id, true); await A.reload(); await A.waitApp(); await A.wait(300);
  h.server.setOffline(A.id, false); await A.reload(); await A.waitApp();
  await until(() => (h.cloudTxIds(uid)||[]).includes(ta), 9000);
  const mem = await A.txIds();
  assert(mem.includes(ta), 'التعديل الأوفلاين اختفى من البيانات الحية (استُبدل بالسحابة)');
  assert(mem.includes(tb), 'تعديل الجهاز الآخر غير موجود');
  const cloud = h.cloudTxIds(uid)||[];
  assert(cloud.includes(ta) && cloud.includes(tb), 'السحابة لا تحتوي الطرفين');
});

// ── A/B. First login cases ───────────────────────────────────────────────
test('A', 'أول دخول: لا بيانات محلية والسحابة فيها بيانات', async h => {
  const uid = await setup(h);
  h.server.seedDoc('users/'+uid, { schemaVersion: 16, transactions: [
    { id:'real-1', date:'2026-10-01', type:'Income', category:'راتب', amount:9000, accountId:'acc_cash', updatedAt:'2026-10-01T00:00:00Z', version:1 } ],
    accounts:[{id:'acc_cash',name:'نقدي',type:'cash',openingBalance:0}], updatedAt:{__serverTimestamp:true} });
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const ids = await A.txIds();
  assert(ids.length === 1 && ids[0] === 'real-1', 'البيانات المحملة لا تطابق السحابة: ' + ids.join(','));
});

test('B', 'أول دخول: بيانات محلية والسحابة فارغة', async h => {
  const uid = await setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 11 }); await settle(A);
  h.server.docs.delete('users/'+uid);                      // السحابة فارغة
  await A.reload(); await A.waitApp(); await settle(A);
  assert((h.cloudTxIds(uid)||[]).includes(id), 'البيانات المحلية لم تُرفع لسحابة فارغة');
});

// ── Hydrate failure must not push demo data over real cloud data ─────────
test('HYD', 'فشل جلب السحابة عند الدخول لا يكتب بيانات تجريبية فوق الحقيقية', async h => {
  const uid = await setup(h);
  const real = Array.from({length:4},(_,i)=>({ id:'real-'+i, date:'2026-10-0'+(i+1), type:'Income', category:'راتب', amount:1000+i, accountId:'acc_cash', updatedAt:'2026-10-01T00:00:00Z', version:1 }));
  h.server.seedDoc('users/'+uid, { schemaVersion:16, transactions:real, accounts:[{id:'acc_cash',name:'نقدي',type:'cash',openingBalance:0}], updatedAt:{__serverTimestamp:true} });
  const A = await h.device('a'); await A.goto();
  h.server.dev(A.id).failNext.push({ op:'get', code:'unavailable' });
  await A.login('a@test.com','password1');
  await A.wait(800);
  await A.addTx({ amount: 1 });                             // أي تعديل يطلق الرفع
  await A.wait(800); await A.sync(); await A.wait(1500);
  const cloud = h.cloudTxIds(uid)||[];
  const lost = real.filter(r=>!cloud.includes(r.id)).length;
  assert(lost === 0, `ضاعت ${lost} حركة حقيقية من السحابة`);
  const demo = (h.server.cloudData(uid).transactions||[]).filter(t=>t.description==='سوبرماركت' || t.description==='راتب شهري').length;
  assert(demo === 0, 'بيانات تجريبية (demo) رُفعت إلى حساب حقيقي');
});

// ── 7/8. Stale cloud vs newer local — covered by J & C/D ────────────────
// ── 9. Rapid writes ──────────────────────────────────────────────────────
test('R9', 'كتابات سريعة متتالية لا تفقد آخر تعديل', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  h.server.dev(A.id).delayMs = 250;
  const ids = [];
  for (let i=0;i<8;i++){ ids.push(await A.addTx({ amount: 100+i })); await A.wait(120 + (i%3)*300); }
  await A.wait(3500);
  const cloud = h.cloudTxIds(uid)||[];
  const missing = ids.filter(i=>!cloud.includes(i));
  assert(missing.length===0, 'حركات لم تصل السحابة: '+missing.length);
  const local = await A.localTxIds(uid);
  assert(JSON.stringify(local)===JSON.stringify(cloud), 'المحلي والسحابي غير متطابقين بعد الاستقرار');
});

// ── 10. Duplicate retries ────────────────────────────────────────────────
test('K', 'إعادة المحاولة المتكررة لا تُنشئ تكراراً', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.offline(true);
  for (let i=0;i<3;i++) await A.addTx({ amount: 7+i });
  await A.offline(false);
  await A.ev(async()=>{ const a=storageAdapter(); const f=a.syncNow||a.retry||a.flush; await Promise.all([f.call(a),f.call(a),f.call(a)]); window.dispatchEvent(new Event('online')); });
  await A.wait(2500);
  const cloud = h.cloudTxIds(uid)||[];
  assert(new Set(cloud).size === cloud.length, 'معرّفات مكرّرة في السحابة');
  const local = await A.txIds();
  assert(cloud.length === local.length, `عدد السحابة ${cloud.length} ≠ المحلي ${local.length}`);
});

// ── L / 11. Corrupted cloud payload ──────────────────────────────────────
test('L', 'حمولة سحابية تالفة لا تدمّر البيانات المحلية الصالحة', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 555 }); await settle(A);
  const before = await A.txIds();
  h.server.seedDoc('users/'+uid, { transactions: 'garbage', accounts: 7, schemaVersion:'x', updatedAt:{__serverTimestamp:true} });
  await A.reload(); await A.waitApp(); await settle(A);
  const after = await A.txIds();
  assert(after.includes(id) && after.length >= before.length, 'البيانات المحلية الصالحة ضاعت بسبب سحابة تالفة');
});

// ── Badge honesty ────────────────────────────────────────────────────────
test('UI1', 'الشارة لا تقول "محفوظ" قبل تأكيد السيرفر', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  h.server.dev(A.id).delayMs = 2500;
  await A.addTx({ amount: 3 });
  await A.wait(200);
  const b1 = await A.badge();
  assert(b1 !== 'synced', 'الشارة "محفوظ" فور التعديل قبل أي رفع');
  await A.wait(1200);
  const b2 = await A.badge();
  assert(b2 !== 'synced', 'الشارة "محفوظ" أثناء انتظار رد السيرفر');
});

test('UI2', 'خطأ صلاحيات يظهر كخطأ لا كـ"أوفلاين"', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const d = h.server.dev(A.id);
  for(let i=0;i<6;i++) d.failNext.push({ op:'*', code:'permission-denied' });
  await A.addTx({ amount: 3 }); await A.wait(2000);
  const b = await A.badge();
  assert(b === 'error', 'حالة الشارة: ' + b);
});

test('UI3', 'تجاوز حد 1MB يظهر خطأ واضحاً ولا يُدّعى الحفظ', async h => {
  // الحركات بقت مقسّمة بالشهر؛ الحد لسه ممكن يتعدّى لو المستند الرئيسي نفسه (إعدادات/أهداف) ضخم
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev(()=>{ data.bigNote = 'ملاحظة طويلة جداً '.repeat(40000); save(); });
  await A.wait(2500);
  const b = await A.badge();
  assert(b === 'error' || b === 'too-large', 'الشارة: ' + b);
  assert(await A.pending() === true, 'التعليق مُسح رغم رفض السيرفر');
});

// ── Local save failure must not show success ─────────────────────────────
test('LS', 'فشل الحفظ المحلي لا يُعرض كنجاح', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const msg = await A.ev(async ()=>{
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k,v){ if(String(k).startsWith('km_local_data')){ const e=new Error('quota'); e.name='QuotaExceededError'; throw e; } return orig.call(this,k,v); };
    openQadd('Expense');
    document.getElementById('qaddAmt').value='50'; document.getElementById('qaddCat').value='طعام';
    submitQadd();
    const t = document.getElementById('toast').textContent;
    Storage.prototype.setItem = orig;
    return t;
  });
  assert(!/^✅/.test(msg.trim()), 'رسالة نجاح رغم فشل الحفظ: ' + msg);
});

// ── Encryption must not silently stop sync ───────────────────────────────
test('ENC', 'تفعيل التشفير لا يوقف المزامنة بصمت', async h => {
  const uid = await setup(h);
  const A = await h.device('a', { dialogAnswer: d => d.type()==='prompt' ? '1234' : true });
  await A.goto(); await A.login('a@test.com','password1'); await settle(A);
  await A.ev(async()=>{ await setPin('1234'); await enableEncryption(); });
  await A.wait(800);
  const id = await A.addTx({ amount: 777 }); await A.wait(2000);
  const synced = (h.cloudTxIds(uid)||[]).includes(id);
  await A.reload(); await A.waitApp(); await A.wait(500);
  const visible = (await A.txIds()).includes(id);
  assert(visible, 'الحركة اختفت بعد إعادة التحميل مع التشفير');
  assert(synced, 'المزامنة توقفت بصمت بعد تفعيل التشفير');
});

// ── Legacy local-only data ───────────────────────────────────────────────
test('LEG', 'بيانات النسخة المحلية القديمة تُتبنّى بموافقة المستخدم', async h => {
  const uid = await setup(h);
  const A = await h.device('a'); await A.goto();
  await A.ev(()=>{ localStorage.setItem('km_local_data', JSON.stringify({ schemaVersion:16,
    transactions:[{id:'old-1',date:'2026-09-01',type:'Income',category:'راتب',amount:12345,accountId:'acc_cash'}],
    accounts:[{id:'acc_cash',name:'نقدي',type:'cash',openingBalance:0}] })); });
  await A.reload();
  await A.login('a@test.com','password1'); await settle(A);
  assert((await A.txIds()).includes('old-1'), 'بيانات النسخة القديمة غير مرئية بعد الدخول');
  assert(await A.ev(()=>localStorage.getItem('km_local_data')!==null), 'المفتاح القديم حُذف');
  await A.wait(1200);
  assert((h.cloudTxIds(uid)||[]).includes('old-1'), 'البيانات المتبنّاة لم تُرفع');
});

// ── Offline cold start without Firebase SDK ─────────────────────────────
test('OFF', 'فتح التطبيق أوفلاين ومكتبة Firebase غير متاحة', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 909 }); await settle(A);
  A.state.firebaseAvailable = false; await A.offline(true);
  await A.reload(); await A.wait(2000);
  // H-01: تذكّر المستخدم لا يفتح بياناته — مطلوب فتح صريح بكلمة مرور الحساب
  assert(!(await A.appVisible()), 'البيانات فُتحت بدون أي تحقق');
  await A.page.fill('#offlinePassword','wrong-pass'); await A.ev(()=>offlineUnlock()); await A.wait(1200);
  assert(!(await A.appVisible()), 'فُتح بكلمة مرور خاطئة');
  await A.page.fill('#offlinePassword','password1'); await A.ev(()=>offlineUnlock()); await A.waitApp();
  assert((await A.txIds()).includes(id), 'بيانات آخر جلسة غير ظاهرة بعد الفتح الصحيح');
  const id2 = await A.addTx({ amount: 910 });
  assert((await A.localTxIds(uid)||[]).includes(id2), 'الحفظ المحلي لا يعمل في الجلسة الاحتياطية');
  A.state.firebaseAvailable = true; await A.offline(false);
  await A.reload(); await A.waitApp();
  await until(()=> (h.cloudTxIds(uid)||[]).includes(id2), 9000);
  assert((h.cloudTxIds(uid)||[]).includes(id2), 'تعديل الجلسة الاحتياطية لم يُرفع بعد عودة Firebase');
});

// ── Logout with pending writes ───────────────────────────────────────────
test('LO', 'الخروج مع تعديلات معلّقة يحفظها ويحذّر', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.offline(true);
  const id = await A.addTx({ amount: 66 }); await A.wait(300);
  A.dialogs.length = 0;
  await A.ev(()=>doLogout()); await A.wait(1500);
  const warned = A.dialogs.some(d=>/لم ت|معلّق|غير مرفوع|لم يُرفع/.test(d.msg)) ;
  await A.offline(false);
  await A.login('a@test.com','password1');
  await until(()=> (h.cloudTxIds(uid)||[]).includes(id), 9000);
  assert((h.cloudTxIds(uid)||[]).includes(id), 'التعديل المعلّق ضاع بعد الخروج والدخول');
  assert(warned, 'لم يُحذّر المستخدم من وجود تعديلات غير مرفوعة عند الخروج');
});

// ── Deletions do not resurrect ───────────────────────────────────────────
test('DEL', 'الحذف على جهاز لا تُعيده جهة أخرى', async h => {
  const uid = await setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const victim = await A.addTx({ amount: 1212, category: 'سيُحذف' }); await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  await A.ev(id=>{ deleteTransaction(id); }, victim); await settle(A);
  await B.addTx({ amount: 3434 }); await settle(B); await B.wait(800);
  assert(!(h.cloudTxIds(uid)||[]).includes(victim), 'الحركة المحذوفة عادت للسحابة');
  assert(!(await B.txIds()).includes(victim), 'الحركة المحذوفة ما زالت في الجهاز ب');
  await h.server.dev(B.id);
  await A.ev(()=>{ data.catBudgets={'طعام':500}; save(); }); await settle(A);
  await B.sync(); await B.wait(800);
  await B.ev(()=>deleteCatBudget('طعام')); await settle(B);
  await A.addTx({ amount: 1 }); await settle(A); await A.wait(500);
  const cb = (h.server.cloudData(uid).catBudgets)||{};
  assert(!('طعام' in cb), 'ميزانية الفئة المحذوفة عادت بعد الدمج');
});

// ── Recurring duplicates across devices ─────────────────────────────────
test('REC', 'المتكررة لا تتكرر عند تسجيلها من جهازين', async h => {
  const uid = await setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev(()=>RecurRepo.add({title:'إيجار',category:'إيجار',type:'Expense',amount:5000,freq:'monthly',interval:1,startDate:today_str(),endDate:'',autoAdd:true,paused:false,skipNext:false,lastRun:''}));
  await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  // both devices posted the occurrence independently (B posted on open). A posts again offline-free:
  await A.offline(true); await B.offline(true);
  await A.ev(()=>runRecurring({silent:true, force:true}));
  await B.ev(()=>runRecurring({silent:true, force:true}));
  await A.offline(false); await A.wait(2000); await B.offline(false); await B.wait(2500);
  const occ = (h.server.cloudData(uid).transactions||[]).filter(t=>t.recurId);
  const keys = occ.map(t=>t.occId);
  assert(new Set(keys).size === keys.length, `تكرار مناسبة متكررة: ${keys.length} حركة لـ ${new Set(keys).size} مناسبة`);
});

// ── 12. Export / import / backup / restore ───────────────────────────────
test('IO', 'التصدير والاستيراد والنسخ الاحتياطي والاستعادة', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 4321 });
  const r = await A.ev(async ()=>{
    const out = {};
    const text = JSON.stringify({ ...data, schemaVersion: SCHEMA_VERSION });
    const res = await importPipeline(text);
    out.importOk = res.ok; out.importN = res.ok && res.data.transactions.length;
    out.backup = backupNow('manual');
    out.slots = readBackups().length;
    const before = data.transactions.length;
    data.transactions = []; save();
    const ok = await restoreBackup(readBackups()[0].id);
    out.restored = ok; out.after = data.transactions.length; out.before = before;
    return out;
  });
  assert(r.importOk && r.importN > 0, 'خط الاستيراد فشل');
  assert(r.backup && r.slots >= 1, 'النسخة الاحتياطية لم تُنشأ');
  assert(r.restored && r.after === r.before, `الاستعادة: ${r.after}/${r.before}`);
  await settle(A); await A.wait(800);
  assert((h.cloudTxIds(uid)||[]).includes(id), 'البيانات المستعادة لم تُرفع للسحابة');
});

test('RS', 'استعادة نسخة أقدم على جهاز لا يعيدها الدمج لاحقاً للحالة الخاطئة', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev(()=>{ data.transactions=[]; save(); }); await settle(A);
  await A.ev(()=>backupNow('manual'));
  const extra = await A.addTx({ amount: 999 }); await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  await A.ev(async()=>{ await restoreBackup(readBackups()[0].id); }); await settle(A); await A.wait(500);
  await B.addTx({ amount: 1 }); await settle(B); await B.wait(800);
  const cloud = h.cloudTxIds(uid)||[];
  assert(!cloud.includes(extra), 'الحركة التي ألغتها الاستعادة عادت عبر الجهاز الآخر');
});

// ── Financial integrity across devices ───────────────────────────────────
test('FIN', 'سلامة الأرقام المالية بعد المزامنة بين جهازين', async h => {
  const uid = await setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.ev(()=>{
    AccountRepo.add({ name:'بنك', type:'bank', openingBalance:10000, archived:false });
    const bank = data.accounts.find(a=>a.name==='بنك').id;
    addTransaction({type:'Income',category:'راتب',amount:20000,accountId:bank});
    addTransaction({type:'Expense',category:'إيجار',amount:6000,accountId:bank});
    addTransaction({type:'Saving',category:'طوارئ',amount:2500});
    addTransaction({type:'Charity',category:'صدقة',amount:300});
    createTransfer({fromId:bank,toId:'acc_cash',amount:1500});
    DebtRepo.add({kind:'i_owe',party:'بنك',principal:12000,interestRate:0,installments:12,startDate:today_str(),dueDate:'',note:'',settled:false});
    AssetRepo.add({kind:'gold',name:'ذهب',qty:10,buyPrice:3000,currentPrice:3500,buyDate:today_str(),note:'',archived:false});
  });
  await settle(A);
  const snap = () => ({ nw: Math.round(FE.netWorth().net*100), tot: Q.allTimeTotals(), n: data.transactions.length,
                        bal: FE.accountRows().map(r=>[r.name,Math.round(r.balance*100)]).sort() });
  const a = await A.ev(snap);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  const b = await B.ev(snap);
  assert(JSON.stringify(a) === JSON.stringify(b), 'الأرقام تختلف بين الجهازين:\n'+JSON.stringify(a)+'\n'+JSON.stringify(b));
  await A.reload(); await A.waitApp(); await settle(A);
  const a2 = await A.ev(snap);
  assert(JSON.stringify(a) === JSON.stringify(a2), 'الأرقام تغيّرت بعد إعادة التحميل');
});

// ── auth flows ───────────────────────────────────────────────────────────
test('AUTH', 'التسجيل، بيانات خاطئة، إعادة تعيين كلمة المرور', async h => {
  const D = await h.device('n'); await D.goto();
  await D.ev(()=>{ document.getElementById('regName').value='سارة'; document.getElementById('regEmail').value='new@test.com';
                   document.getElementById('regPassword').value='password9'; document.getElementById('regPassword2').value='password9'; return doRegister(); });
  await D.waitApp(); await D.wait(1000);
  await D.ev(async()=>{ await storageAdapter().flush?.(); await auth.signOut(); }); await D.wait(500);
  await D.page.fill('#loginEmail','new@test.com'); await D.page.fill('#loginPassword','wrong');
  await D.ev(()=>doLogin()); await D.wait(500);
  assert(!(await D.appVisible()), 'دخل ببيانات خاطئة');
  const t = await D.ev(()=>document.getElementById('toast').textContent);
  assert(/غير صحيحة/.test(t), 'رسالة الخطأ: '+t);
  await D.ev(()=>resetPassword()); await D.wait(300);
  const t2 = await D.ev(()=>document.getElementById('toast').textContent);
  assert(/إعادة التعيين/.test(t2), 'رسالة إعادة التعيين: '+t2);
  await D.login('new@test.com','password9');
  assert(await D.appVisible(), 'لم يدخل بعد التسجيل');
});


// ── Unit: merge properties ───────────────────────────────────────────────
test('U1', 'دالة الدمج: حتمية، لا تكرار، احترام الحذف والأحدث', async h => {
  const D = await h.device('u'); await D.goto(); await D.page.waitForFunction(()=>typeof KMSync!=='undefined' || typeof doLogin==='function');
  const r = await D.ev(()=>{
    if(typeof KMSync==='undefined') return { skip:true };
    const t=(id,amt,at,extra)=>Object.assign({id,date:'2026-10-01',type:'Expense',category:'x',amount:amt,accountId:'acc_cash',updatedAt:at,version:1},extra||{});
    const L={ transactions:[t('a',1,'2026-10-01T10:00Z'), t('b',2,'2026-10-02T10:00Z'), t('o1',9,'2026-10-01T00:00Z',{occId:'rec:r1@2026-10-01',createdAt:'2026-10-01T01:00Z'})],
              tombstones:[], monthlyGoal:100, _fieldAt:{monthlyGoal:'2026-10-01T00:00Z'} };
    const R={ transactions:[t('a',5,'2026-10-03T10:00Z'), t('c',3,'2026-10-01T10:00Z'), t('o2',9,'2026-10-01T00:00Z',{occId:'rec:r1@2026-10-01',createdAt:'2026-10-01T02:00Z'})],
              tombstones:[{collection:'transactions',id:'b',deletedAt:'2026-10-05T00:00Z'}], monthlyGoal:300, _fieldAt:{monthlyGoal:'2026-10-04T00:00Z'} };
    const m1=KMSync.merge(L,R), m2=KMSync.merge(KMSync.merge(L,R),R);
    const ids=m1.transactions.map(x=>x.id).sort();
    const a=m1.transactions.find(x=>x.id==='a');
    const r2=KMSync.merge(R,L);
    return { ids, aAmt:a.amount, goal:m1.monthlyGoal,
             idem: JSON.stringify(m1.transactions.map(x=>x.id).sort())===JSON.stringify(m2.transactions.map(x=>x.id).sort()),
             sym: JSON.stringify(ids)===JSON.stringify(r2.transactions.map(x=>x.id).sort()) };
  });
  if(r.skip) throw new Error('KMSync غير موجود (النسخة الأصلية لا تملك دالة دمج)');
  assert(JSON.stringify(r.ids)===JSON.stringify(['a','c','o1']), 'المعرّفات بعد الدمج: '+r.ids);
  assert(r.aAmt===5, 'لم يفز التعديل الأحدث');
  assert(r.goal===300, 'الحقل العام الأحدث لم يفز');
  assert(r.idem && r.sym, 'الدمج غير مستقر (idempotent/متماثل)');
});

// ── Property: random interleaved edits on two devices converge ──────────
test('P1', 'اختبار عشوائي: جهازان يعدّلان ويحذفان أونلاين وأوفلاين ثم يتقاربان', async h => {
  const uid = await setup(h);
  const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const B = await loggedIn(h, 'a@test.com'); await settle(B);
  let seed = Number(process.env.SEED)||7; const rnd = () => (seed = (seed*16807) % 2147483647) / 2147483647;
  const created = new Set(), deleted = new Set();
  for (let step=0; step<40; step++){
    const D = rnd()<0.5 ? A : B;
    const r = rnd();
    if (r < 0.12) { await D.offline(true); }
    else if (r < 0.25) { await D.offline(false); }
    else if (r < 0.75) { const id = await D.addTx({ amount: Math.round(rnd()*1000)+1 }); created.add(id); }
    else {
      const ids = (await D.txIds()).filter(i=>created.has(i) && !deleted.has(i));
      if (ids.length){ const v = ids[Math.floor(rnd()*ids.length)]; await D.ev(id=>deleteTransaction(id), v); deleted.add(v); }
    }
    await D.wait(80 + Math.round(rnd()*500));
  }
  await A.offline(false); await B.offline(false);
  for (let i=0;i<3;i++){ await A.sync(); await A.wait(700); await B.sync(); await B.wait(700); }
  const cloud = h.cloudTxIds(uid)||[]; const a = await A.txIds(); const b = await B.txIds();
  const missing = [...created].filter(id=>!deleted.has(id) && !cloud.includes(id));
  const zombies = [...deleted].filter(id=>cloud.includes(id));
  assert(missing.length===0, `حركات ضاعت: ${missing.length} من ${created.size}`);
  assert(zombies.length===0, `محذوفات عادت: ${zombies.length}`);
  assert(new Set(cloud).size===cloud.length, 'تكرار في السحابة');
  assert(JSON.stringify(a)===JSON.stringify(cloud) && JSON.stringify(b)===JSON.stringify(cloud), `عدم تقارب: A=${a.length} B=${b.length} cloud=${cloud.length}`);
});

// ── runner ───────────────────────────────────────────────────────────────
(async () => {
  const file = process.argv[2]; const filter = process.argv[3];
  const h = new Harness(file); await h.start();
  const results = [];
  for (const t of T) {
    if (filter && !filter.split(',').includes(t.id)) continue;
    h.server.reset();
    const t0 = Date.now(); let err = null;
    try { await Promise.race([ t.fn(h), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 60s')),60000)) ]); }
    catch (e) { err = e; }
    const logs = h.devices.flatMap(d => d.logs.filter(l=>/pageerror/.test(l)).map(l=>d.name+': '+l));
    await h.closeDevices();
    results.push({ id: t.id, name: t.name, pass: !err, error: err && err.message.split('\n').slice(0,3).join(' | '), ms: Date.now()-t0, pageErrors: logs.slice(0,3) });
    console.log(`${err?'FAIL':'PASS'}  ${t.id.padEnd(5)} ${t.name}${err?'\n        → '+err.message.split('\n')[0]:''}${logs.length?'\n        ! '+logs[0]:''}`);
  }
  await h.stop();
  const p = results.filter(r=>r.pass).length;
  console.log(`\n${p}/${results.length} passed`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
})();
