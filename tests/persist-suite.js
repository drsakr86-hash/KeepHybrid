// H-02/H-03/H-04 + CSV + encryption-primitive tests. Usage: node tests/persist-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const { Harness, until } = require('./harness');

const T = [];
const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const setup = (h, email='a@test.com') => h.server.addUser(email, 'password1', email.split('@')[0]);
// يحقن فشل التخزين لمفاتيح تطابق نمطاً — يحاكي امتلاء التخزين
const FAIL_INIT = `(() => { const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v){
    if (window.__failKeys && window.__failKeys.test(k)) { const e = new DOMException('quota', 'QuotaExceededError'); throw e; }
    return orig.call(this, k, v); }; })();`;
async function loggedIn(h, email){ const D = await h.device(email.split('@')[0], { initScript: FAIL_INIT }); await D.goto(); await D.login(email, 'password1'); return D; }
const settle = (D, ms=1500) => D.wait(ms);
const failKeys = (D, re) => D.ev((src)=>{ window.__failKeys = src ? new RegExp(src) : null; }, re ? re.source : null);
const stored = (D) => D.ev(()=>{ const k=Object.keys(localStorage).find(k=>/^km_local_data__/.test(k)); try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } });
const backups = (D) => D.ev(()=> readBackups().map(b=>({ id:b.id, reason:b.reason })));
const mkData = (n, extra) => JSON.stringify(Object.assign({ schemaVersion: 16,
  accounts:[{ id:'acc_cash', name:'نقدي', type:'cash', openingBalance:0 }],
  transactions: Array.from({length:n}, (_,i)=>({ id:'imp'+i, date:'2026-0'+(1+i%9)+'-1'+(i%9), type:i%4?'Expense':'Income',
    category:'فئة'+(i%5), amount:10+i, accountId:'acc_cash' })) }, extra||{}));
async function withTx(D, n){ await D.ev((n)=>{ for(let i=0;i<n;i++) addTransaction({ type:'Expense', amount:5+i, category:'أساس', date:today_str() }); }, n); await settle(D); }
async function importText(D, text){ return D.ev(async (t)=>{ const r = await importPipeline(t); if(!r.ok) return { ok:false, failedAt:r.failedAt }; return { ok: commitImport(r), stats:r.stats, future:r.futureSchema }; }, text); }

// ── H-03 import ───────────────────────────────────────────────
test('I1', 'استيراد JSON صالح ⇒ نسخة احتياطية + استبدال + حفظ محلي ثم رفع', async h => {
  const uid = setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 3);
  const r = await importText(A, mkData(20));
  assert(r.ok, 'فشل: ' + JSON.stringify(r));
  assert((await backups(A)).some(b=>b.reason==='pre-import'), 'لا نسخة قبل الاستيراد');
  assert((await stored(A)).transactions.length === 20, 'المحفوظ محلياً ≠ 20');
  assert(await until(()=> (h.cloudTxIds(uid)||[]).length === 20, 8000), 'السحابة: ' + (h.cloudTxIds(uid)||[]).length);
});
test('I2', 'JSON غير صالح ⇒ لا تغيير ولا نسخة مستهلكة', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 2);
  const b0 = (await backups(A)).length;
  const r = await importText(A, '{ not json');
  assert(!r.ok && r.failedAt==='parse', JSON.stringify(r));
  assert((await stored(A)).transactions.length === 2 && (await backups(A)).length === b0, 'تغيّر شيء');
});
test('I3', 'نسخة مستقبلية تُعلَّم، وإلغاء الاستيراد لا يغيّر شيئاً ولا يستهلك خانة نسخ', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 2);
  const b0 = (await backups(A)).length;
  const r = await A.ev(async (t)=>{ const r=await importPipeline(t); return { ok:r.ok, future:r.futureSchema }; }, mkData(3, { schemaVersion: 999 }));
  assert(r.ok && r.future === true, JSON.stringify(r));
  // المستخدم ألغى عند التأكيد ⇒ commitImport لا يُستدعى
  assert((await stored(A)).transactions.length === 2 && (await backups(A)).length === b0, 'الإلغاء غيّر شيئاً');
});
test('I4', 'معرّفات مكرّرة تُعاد ترقيمها ولا تُفقد', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const d = JSON.parse(mkData(4)); d.transactions[1].id = d.transactions[0].id; d.transactions[2].id = d.transactions[0].id;
  const r = await importText(A, JSON.stringify(d));
  assert(r.ok && r.stats.reided === 2, JSON.stringify(r));
  const ids = (await stored(A)).transactions.map(t=>t.id);
  assert(ids.length === 4 && new Set(ids).size === 4, 'معرّفات: ' + ids);
});
test('I5', 'ملف فارغ {} ⇒ مرفوض، البيانات كما هي', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 2);
  const r = await importText(A, '{}');
  assert(!r.ok, 'قُبل ملف فارغ'); assert((await stored(A)).transactions.length === 2, 'تغيّر');
});
test('I6', 'استيراد كبير (5000 حركة) ينجح ويُرفع كاملاً', async h => {
  const uid = setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const r = await importText(A, mkData(5000));
  assert(r.ok, JSON.stringify(r));
  assert(await until(()=> (h.cloudTxIds(uid)||[]).length === 5000, 20000), 'السحابة: ' + (h.cloudTxIds(uid)||[]).length);
});
test('I7', 'فشل الحفظ بعد الاستيراد ⇒ الذاكرة والتخزين كما كانا، والنسخة باقية', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 3);
  await failKeys(A, /^km_local_data__/);
  const r = await importText(A, mkData(10));
  await failKeys(A, null);
  assert(r.ok === false, 'ادّعى النجاح');
  assert((await A.ev(()=>data.transactions.length)) === 3, 'الذاكرة تغيّرت');
  assert((await stored(A)).transactions.length === 3, 'التخزين تغيّر');
  assert((await backups(A)).some(b=>b.reason==='pre-import'), 'النسخة ضاعت');
});
test('I8', 'فشل إنشاء النسخة الاحتياطية ⇒ الاستيراد يُلغى', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 3);
  await failKeys(A, /^km_local_backups__/);
  const r = await importText(A, mkData(10));
  await failKeys(A, null);
  assert(r.ok === false && (await stored(A)).transactions.length === 3, 'استُبدلت بلا نسخة');
});
test('I9', 'استيراد أوفلاين ثم عودة الاتصال ⇒ السحابة = المستورد، والقديم لا يعود', async h => {
  const uid = setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 4); await settle(A);
  const old = h.cloudTxIds(uid);
  await A.offline(true);
  const r = await importText(A, mkData(6)); assert(r.ok, 'فشل الاستيراد أوفلاين');
  await A.wait(800); await A.offline(false); await A.sync();
  assert(await until(()=> (h.cloudTxIds(uid)||[]).length === 6, 9000), 'السحابة: ' + (h.cloudTxIds(uid)||[]).length);
  assert(!old.some(id => (h.cloudTxIds(uid)||[]).includes(id)), 'سجلات قديمة عادت');
});

// ── H-03 restore / clear ─────────────────────────────────────
test('R1', 'فشل الحفظ أثناء الاستعادة ⇒ لا تغيير والنسخة المصدر باقية', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 2);
  await A.ev(()=>backupNow('manual')); await withTx(A, 3);
  const src = (await backups(A))[0].id;
  await failKeys(A, /^km_local_data__/);
  const ok = await A.ev((id)=>restoreBackup(id), src);
  await failKeys(A, null);
  assert(ok === false, 'ادّعى النجاح');
  assert((await A.ev(()=>data.transactions.length)) === 5 && (await stored(A)).transactions.length === 5, 'تغيّرت البيانات');
  assert((await backups(A)).some(b=>b.id===src), 'النسخة المصدر حُذفت');
});
test('R2', 'استعادة أقدم خانة لا تُزيحها من الخانات', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 1);
  await A.ev(()=>{ backupNow('manual'); }); await withTx(A, 1);
  await A.ev(()=>{ backupNow('manual'); }); await withTx(A, 1);
  await A.ev(()=>{ backupNow('manual'); });
  const list = await backups(A); assert(list.length === 3, 'خانات: ' + list.length);
  const oldest = list[2].id;
  const ok = await A.ev((id)=>restoreBackup(id), oldest);
  assert(ok === true, 'الاستعادة فشلت');
  assert((await backups(A)).some(b=>b.id===oldest), 'النسخة المستعادة أُزيحت');
  assert((await stored(A)).transactions.length === 1, 'المستعاد: ' + (await stored(A)).transactions.length);
});
test('R3', 'مسح ثم استعادة ⇒ البيانات ترجع وتُرفع، والمسح لا يُعيدها الدمج', async h => {
  const uid = setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 4); await settle(A);
  const ok1 = await A.ev(()=>clearAll()); await settle(A);
  assert(ok1 === true && (await stored(A)).transactions.length === 0, 'المسح');
  assert(await until(()=> (h.cloudTxIds(uid)||[1]).length === 0, 8000), 'السحابة بعد المسح: ' + h.cloudTxIds(uid));
  const pre = (await backups(A)).find(b=>b.reason==='pre-clear'); assert(pre, 'لا نسخة قبل المسح');
  const ok2 = await A.ev((id)=>restoreBackup(id), pre.id); await settle(A);
  assert(ok2 === true && (await stored(A)).transactions.length === 4, 'الاستعادة');
  assert(await until(()=> (h.cloudTxIds(uid)||[]).length === 4, 8000), 'السحابة بعد الاستعادة: ' + (h.cloudTxIds(uid)||[]).length);
});
test('R4', 'فشل نسخة ما قبل المسح ⇒ المسح يُلغى', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 3);
  await failKeys(A, /^km_local_backups__/);
  const ok = await A.ev(()=>clearAll());
  await failKeys(A, null);
  assert(ok === false && (await stored(A)).transactions.length === 3, 'مُسحت بلا نسخة');
});
test('R5', 'فشل حفظ المسح ⇒ الذاكرة كما هي', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 3);
  await failKeys(A, /^km_local_data__/);
  const ok = await A.ev(()=>clearAll());
  await failKeys(A, null);
  assert(ok === false && (await A.ev(()=>data.transactions.length)) === 3, 'الذاكرة صُفّرت رغم الفشل');
});
test('R6', 'إلغاء الاستعادة عند التأكيد لا يغيّر شيئاً', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 2);
  await A.ev(()=>backupNow('manual')); await withTx(A, 2);
  const b0 = (await backups(A)).length;
  A.dialogAnswer = () => false;
  const ok = await A.ev(()=>restoreBackup());
  A.dialogAnswer = undefined;
  assert(ok === false && (await stored(A)).transactions.length === 4 && (await backups(A)).length === b0, 'تغيّر شيء');
});
test('R7', 'نسخة مشفّرة بلا مفتاح ⇒ ترفض بأمان', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A); await withTx(A, 2);
  const ok = await A.ev(()=>{ const l=readBackups(); l.unshift({ id:'bk_enc', savedAt:new Date().toISOString(), reason:'manual', meta:{encrypted:true},
      payload: JSON.stringify({ enc:1, v:1, alg:'AES-GCM-256', iv:'AAAAAAAAAAAAAAAA', ct:'AAAA' }) }); writeBackups(l); return restoreBackup('bk_enc'); });
  assert(ok === false && (await stored(A)).transactions.length === 2, 'تغيّر شيء');
});

// ── H-04 AI write tools ───────────────────────────────────────
const ai = (D, name, args, turn) => D.ev(([n,a,t])=>{ if(t){ _ai.turnKeys=new Map(); _ai.turnDelete=undefined; _ai.turnImage=!!t.image; } return aiExec(n,a); }, [name, args, turn]);
test('A1', 'set_budget: نجاح يُحفظ فعلاً + حالة السحابة صادقة', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const r = await ai(A, 'set_budget', { category:'بنزين', monthly_limit:1500 }, {});
  assert(r.ok && r.saved_on_device && ['pending_upload','synced'].includes(r.cloud), JSON.stringify(r));
  assert((await stored(A)).catBudgets['بنزين'] === 1500, 'غير محفوظ');
});
test('A2', 'set_budget: قيم غير صالحة مرفوضة ولا تغيّر شيئاً', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await ai(A, 'set_budget', { category:'بنزين', monthly_limit:1000 }, {});
  for (const bad of [ { category:'بنزين', monthly_limit:-5 }, { category:'بنزين', monthly_limit:'abc' }, { category:'بنزين', monthly_limit:'' },
                      { category:'', monthly_limit:100 }, { category:'بنزين', monthly_limit:1e12 }, { category:'بنزين' } ]) {
    const r = await ai(A, 'set_budget', bad, {});
    assert(r.ok === false, 'قُبل: ' + JSON.stringify(bad));
  }
  assert((await stored(A)).catBudgets['بنزين'] === 1000, 'تغيّرت');
});
test('A3', 'set_budget: فشل التخزين ⇒ ok:false والميزانية السابقة كما هي', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await ai(A, 'set_budget', { category:'بنزين', monthly_limit:1000 }, {});
  await failKeys(A, /^km_local_data__/);
  const r = await ai(A, 'set_budget', { category:'بنزين', monthly_limit:3000 }, {});
  await failKeys(A, null);
  assert(r.ok === false, 'ادّعى النجاح: ' + JSON.stringify(r));
  assert((await A.ev(()=>data.catBudgets['بنزين'])) === 1000, 'الذاكرة تغيّرت');
  assert((await stored(A)).catBudgets['بنزين'] === 1000, 'التخزين تغيّر');
});
test('A4', 'set_budget: تكرار نفس الطلب لا يعيد الكتابة', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await ai(A, 'set_budget', { category:'أكل', monthly_limit:2000 }, {});
  const r = await ai(A, 'set_budget', { category:'أكل', monthly_limit:2000 }, {});
  assert(r.ok && r.unchanged, JSON.stringify(r));
});
test('A5', 'add_transaction: مبلغ/تاريخ/نوع غير صالح ⇒ خطأ صريح بلا تسجيل', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const n0 = await A.ev(()=>data.transactions.length);
  for (const bad of [ { amount:'كتير', category:'أكل' }, { amount:0, category:'أكل' }, { amount:Infinity, category:'أكل' },
                      { amount:50, category:'أكل', date:'امبارح' }, { amount:50, category:'أكل', date:'1990-01-01' },
                      { amount:50, category:'أكل', date:'2099-01-01' }, { amount:50, category:'أكل', type:'Transfer' } ]) {
    const r = await ai(A, 'add_transaction', bad, {});
    assert(r.ok === false, 'قُبل: ' + JSON.stringify(bad));
  }
  assert((await A.ev(()=>data.transactions.length)) === n0, 'اتسجّل شيء');
});
test('A6', 'add_transaction: فشل التخزين ⇒ ok:false والحركة ليست في الذاكرة', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const n0 = await A.ev(()=>data.transactions.length);
  await failKeys(A, /^km_local_data__/);
  const r = await ai(A, 'add_transaction', { amount:300, category:'بنزين', type:'Charity' }, {});
  await failKeys(A, null);
  assert(r.ok === false, JSON.stringify(r));
  assert((await A.ev(()=>data.transactions.length)) === n0 && (await A.ev(()=>(data.charities||[]).length)) === 0, 'بقي في الذاكرة');
});
test('A7', 'add_transaction: إعادة النموذج لنفس الاستدعاء في نفس الرسالة ⇒ حركة واحدة', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const r1 = await ai(A, 'add_transaction', { amount:300, category:'بنزين' }, {});
  const r2 = await ai(A, 'add_transaction', { amount:300, category:'بنزين' });
  assert(r1.ok && r2.ok && r2.duplicate && r2.id === r1.id, JSON.stringify([r1, r2]));
  assert((await A.ev(()=>data.transactions.filter(t=>t.category==='بنزين').length)) === 1, 'اتكرّرت');
  const r3 = await ai(A, 'add_transaction', { amount:300, category:'بنزين' }, {});    // رسالة جديدة ⇒ مسموح
  assert(r3.ok && !r3.duplicate, 'رسالة جديدة اتمنعت');
});
test('A8', 'delete_transaction: رفض المستخدم ⇒ لا حذف ولا محاولة ثانية', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 99 });
  A.dialogAnswer = () => false;
  const r1 = await ai(A, 'delete_transaction', { id }, {});
  const r2 = await ai(A, 'delete_transaction', { id });
  A.dialogAnswer = undefined;
  assert(!r1.ok && !r2.ok && (await A.txIds()).includes(id), 'اتحذف');
  assert(A.dialogs.filter(d=>/يحذف/.test(d.msg)).length === 1, 'سأل أكثر من مرة');
});
test('A9', 'delete_transaction: فشل التخزين ⇒ الحركة ترجع وok:false', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 99 });
  await failKeys(A, /^km_local_data__/);
  const r = await ai(A, 'delete_transaction', { id }, {});
  await failKeys(A, null);
  assert(r.ok === false && (await A.txIds()).includes(id), JSON.stringify(r));
  assert(!(await A.ev((id)=>(data.tombstones||[]).some(t=>t.id===id), id)), 'شاهد حذف باقٍ');
});
test('A10', 'صورة إيصال لا تملك حذفاً ولا تعديل ميزانية', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const id = await A.addTx({ amount: 99 });
  const r1 = await ai(A, 'delete_transaction', { id }, { image:true });
  const r2 = await ai(A, 'set_budget', { category:'أكل', monthly_limit:1 });
  assert(!r1.ok && !r2.ok && (await A.txIds()).includes(id), JSON.stringify([r1,r2]));
  assert(A.dialogs.length === 0, 'ظهر تأكيد حذف من صورة');
});
test('A11', 'أوفلاين: التسجيل يقول "على الجهاز" لا "متزامن"', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  await A.offline(true);
  const r = await ai(A, 'add_transaction', { amount:40, category:'قهوة' }, {});
  assert(r.ok && r.cloud !== 'synced', JSON.stringify(r));
});

// ── CSV ───────────────────────────────────────────────────────
test('C1', 'CSV: منع حقن الصيغ مع بقاء الأرقام السالبة والعربية', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const r = await A.ev(()=>[ csvCell('=HYPERLINK("x")'), csvCell('+1+1'), csvCell('-2+3'), csvCell('@SUM(A1)'), csvCell('\tcmd'),
                              csvCell(-500), csvCell('-500'), csvCell('طعام, ومشروبات'), csvCell(NaN) ]);
  const exp = ['"\'=HYPERLINK(""x"")"', "'+1+1", "'-2+3", "'@SUM(A1)", "'\tcmd", '-500', '-500', '"طعام, ومشروبات"', ''];
  assert(JSON.stringify(r) === JSON.stringify(exp), JSON.stringify(r));
  // تصدير فعلي بفئة خبيثة
  await A.addTx({ amount: 50, category: '=cmd|calc' });
  const csv = await A.ev(async ()=>{ let blob=null; const o=URL.createObjectURL; URL.createObjectURL=(b)=>{ blob=b; return 'blob:x'; };
    try{ exportReportCSV(); } finally { URL.createObjectURL=o; } return blob ? await blob.text() : null; });
  assert(csv && csv.includes("'=cmd|calc") && !/(^|,)=cmd/m.test(csv), 'التصدير: ' + (csv||'').slice(0,300));
});

// ── تشفير (البدائيات) ─────────────────────────────────────────
test('E1', 'AES-GCM: صحيح/مفتاح خاطئ/نص معدّل/IV غير صالح/IV فريد/غلاف بسرّ خاطئ', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const r = await A.ev(async ()=>{
    const out={}; const saved=_dek;
    try{
      _dek = await importDek(randBytes(32));
      const blob = await encryptString('{"x":"بيانات"}');
      out.round = await decryptString(blob);
      const ivs=new Set(); for(let i=0;i<300;i++) ivs.add(JSON.parse(await encryptString('a')).iv); out.uniqueIV = ivs.size;
      const o=JSON.parse(blob);
      const ct=unb64(o.ct); ct[0]^=1;
      try{ await decryptString(JSON.stringify({...o, ct:b64(ct)})); out.tamper='decrypted'; }catch(e){ out.tamper='rejected'; }
      try{ await decryptString(JSON.stringify({...o, iv:'AAAA'})); out.badIv='decrypted'; }catch(e){ out.badIv='rejected'; }
      const good=_dek; _dek = await importDek(randBytes(32));
      try{ await decryptString(blob); out.wrongKey='decrypted'; }catch(e){ out.wrongKey='rejected'; }
      _dek=null;
      try{ await decryptString(blob); out.noKey='decrypted'; }catch(e){ out.noKey='rejected'; }
      const raw=randBytes(32), w=await wrapDek(raw,'pin:1234');
      try{ await unwrapDek(w,'pin:9999'); out.wrongSecret='unwrapped'; }catch(e){ out.wrongSecret='rejected'; }
      out.rightSecret = b64(await unwrapDek(w,'pin:1234'))===b64(raw);
      try{ await unwrapDek({...w, salt:'@@'},'pin:1234'); out.badSalt='unwrapped'; }catch(e){ out.badSalt='rejected'; }
    } finally { _dek=saved; }
    return out;
  });
  assert(r.round === '{"x":"بيانات"}', 'round ' + r.round);
  assert(r.uniqueIV === 300, 'IV مكرّر');
  for (const k of ['tamper','badIv','wrongKey','noKey','wrongSecret','badSalt']) assert(r[k] === 'rejected', k + ': ' + r[k]);
  assert(r.rightSecret === true, 'فكّ الغلاف بالسرّ الصحيح');
});
test('E2', 'فشل فكّ تشفير البيانات المحلية ⇒ لا كتابة فوق الأصل (fail closed)', async h => {
  setup(h); const A = await loggedIn(h, 'a@test.com'); await settle(A);
  const r = await A.ev(async ()=>{
    const saved=_dek;
    const bad=JSON.stringify({ enc:1, v:1, alg:'AES-GCM-256', iv:b64(randBytes(12)), ct:b64(randBytes(40)) });
    Storage_.set(DATA_ENC_KEY, bad); writeJSON(KEYS_KEY, { v:1, byPin:{} });
    _dek = await importDek(randBytes(32));
    await loadDataUnlocked();
    const blocked=_blockWrites;
    addTransaction({ type:'Expense', amount:5, category:'x' }); await flushSecureNow();
    const same = Storage_.get(DATA_ENC_KEY)===bad;
    const quarantined = Object.keys(localStorage).some(k=>k.indexOf('corrupt')>-1 && localStorage.getItem(k)===bad);
    Storage_.remove(KEYS_KEY); Storage_.remove(DATA_ENC_KEY); _dek=saved; _blockWrites=false;
    return { blocked, same, quarantined };
  });
  assert(r.blocked && r.same && r.quarantined, JSON.stringify(r));
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
