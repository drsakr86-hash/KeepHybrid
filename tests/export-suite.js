// Backup export (share/download/copy) + import from file/paste. Usage: node tests/export-suite.js <app.html> [filter]
'use strict';
const fs = require('fs');
const path = require('path');
const { Harness } = require('./harness');

const T = []; const test = (id, name, fn) => T.push({ id, name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const SHARE_MOCK = `(() => { window.__shared = null;
  navigator.canShare = (d) => !!(d && d.files && d.files.length);
  navigator.share = async (d) => { const f = d.files[0]; window.__shared = { name: f.name, type: f.type, text: await f.text() }; }; })();`;
async function dev(h, opts={}){
  if (!h.server.users.has('x@test.com')) h.server.addUser('x@test.com', 'password1', 'x');
  const D = await h.device('x', opts); await D.goto(); await D.login('x@test.com', 'password1'); await D.wait(1000);
  await D.ev(()=>{ for(let i=0;i<5;i++) addTransaction({ type:'Expense', amount:10+i, category:'اختبار'+i }); });
  return D;
}
const ids = (D) => D.ev(()=>data.transactions.map(t=>t.id).sort());
const lastToast = (D) => D.ev(()=>document.getElementById('toast').textContent);

test('EX1', 'بدون دعم مشاركة الملفات (WebView): زر المشاركة مخفي ولا ادّعاء نجاح', async h => {
  const D = await dev(h);
  await D.ev(()=>exportData()); await D.wait(200);
  const r = await D.ev(()=>({ open:document.getElementById('expOverlay').classList.contains('open'),
                              share:getComputedStyle(document.getElementById('expShareBtn')).display, info:document.getElementById('expInfo').textContent }));
  assert(r.open && r.share === 'none' && /5 حركة/.test(r.info), JSON.stringify(r));
  assert(!/تم التصدير/.test(await lastToast(D)), 'ادّعى التصدير بمجرد فتح النافذة');
});

test('EX2', 'المشاركة: ملف JSON صالح فيه كل الحركات', async h => {
  const D = await dev(h, { initScript: SHARE_MOCK });
  await D.ev(()=>exportData()); await D.wait(200);
  assert(await D.ev(()=>getComputedStyle(document.getElementById('expShareBtn')).display!=='none'), 'زر المشاركة مخفي');
  const ok = await D.ev(()=>exportShare());
  const sh = await D.ev(()=>window.__shared);
  const parsed = JSON.parse(sh.text);
  assert(ok === true && /^keepMoney_\d{4}-\d{2}-\d{2}\.json$/.test(sh.name) && sh.type === 'application/json', JSON.stringify({ ok, name:sh.name, type:sh.type }));
  assert(JSON.stringify(parsed.transactions.map(t=>t.id).sort()) === JSON.stringify(await ids(D)), 'المحتوى ناقص');
});

test('EX3', 'التنزيل: ملف فعلي بالاسم والمحتوى، والرسالة "بدأ" لا "تم"', async h => {
  const D = await dev(h);
  await D.ev(()=>exportData());
  const [dl] = await Promise.all([ D.page.waitForEvent('download', { timeout: 8000 }), D.ev(()=>exportDownload()) ]);
  const p = await dl.path(); const txt = fs.readFileSync(p, 'utf8');
  assert(/^keepMoney_.*\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  assert(JSON.parse(txt).transactions.length === 5, 'المحتوى');
  assert(/بدأ التنزيل/.test(await lastToast(D)), await lastToast(D));
});

test('EX4', 'النسخ ثم الاستيراد من نص ملصوق يرجّع البيانات', async h => {
  const D = await dev(h, { permissions: ['clipboard-read', 'clipboard-write'] });
  const before = await ids(D);
  await D.ev(()=>exportData());
  assert((await D.ev(()=>exportCopy())) === true, 'النسخ فشل');
  const clip = await D.ev(()=>navigator.clipboard.readText());
  assert(JSON.parse(clip).transactions.length === 5, 'الحافظة');
  await D.ev(()=>{ closeExport(); data.transactions=[]; save(); });
  await D.ev(()=>{ switchTab('settings'); toggleImportPaste(); });
  await D.ev((t)=>{ document.getElementById('importPaste').value=t; }, clip);
  const ok = await D.ev(()=>importFromPaste());
  assert(ok === true && JSON.stringify(await ids(D)) === JSON.stringify(before), 'الاستيراد');
  const bad = await D.ev(()=>{ document.getElementById('importPasteWrap').style.display='block'; document.getElementById('importPaste').value='كلام مش JSON'; return importFromPaste(); });
  assert(bad === false && (await ids(D)).length === 5, 'نص غلط غيّر البيانات');
});

test('EX5', 'الاستيراد من ملف ما زال يعمل', async h => {
  const D = await dev(h);
  const before = await ids(D);
  const json = await D.ev(()=>exportPayload().json);
  const f = path.join(require('os').tmpdir(), 'km-import-test.json'); fs.writeFileSync(f, json);
  await D.ev(()=>{ data.transactions=[]; save(); });
  await D.page.setInputFiles('#importFile', f); await D.wait(1500);
  assert(JSON.stringify(await ids(D)) === JSON.stringify(before), 'الاستيراد من ملف');
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
