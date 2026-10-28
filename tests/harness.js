// Playwright harness: fake Firebase backend in Node, each browser context = one device.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = (()=>{ try{ return require('playwright'); }catch(e){ return require('/opt/npm-tools/node_modules/playwright'); } })();

const MOCK = fs.readFileSync(path.join(__dirname, 'mock-firebase.js'), 'utf8');
const CHART_STUB = 'window.Chart=function(){return{destroy(){},update(){}}};';
const DOC_LIMIT = 1048576;

class FakeServer {
  constructor(){ this.reset(); }
  reset(){
    this.docs = new Map();          // path -> {data, ver}
    this.users = new Map();         // email -> {uid,pw,displayName}
    this.devices = new Map();       // id -> {offline, failNext:[], delayMs, authUid, anon, queue:[]}
    this.lastTs = 0; this.writes = []; this.reads = []; this.anonN = 0; this.denyChunks=false; this.legacyRules=false;
  }
  now(){ this.lastTs = Math.max(Date.now(), this.lastTs + 1); return this.lastTs; }
  dev(id){ if(!this.devices.has(id)) this.devices.set(id,{offline:false,failNext:[],delayMs:0,authUid:null,anon:false,queue:[]}); return this.devices.get(id); }
  setOffline(id, off){
    const d=this.dev(id); d.offline=off;
    if(!off){ const q=d.queue.splice(0); q.forEach(fn=>fn()); }
  }
  addUser(email, pw, displayName){
    const uid='uid_'+email.split('@')[0];
    this.users.set(email,{uid,pw,displayName:displayName||email.split('@')[0]});
    return uid;
  }
  seedDoc(p, data){ this.docs.set(p,{data:this.stamp(data),ver:(this.docs.get(p)||{ver:0}).ver+1}); }
  stamp(v){
    if(Array.isArray(v)) return v.map(x=>this.stamp(x));
    if(v && typeof v==='object'){
      if(v.__serverTimestamp) return {__ts:this.now()};
      const o={}; for(const k in v) o[k]=this.stamp(v[k]); return o;
    }
    return v;
  }
  deepMerge(a,b){
    const out=Object.assign({},a||{});
    for(const k in b){
      const bv=b[k];
      if(bv && typeof bv==='object' && !Array.isArray(bv) && !('__ts' in bv) && out[k] && typeof out[k]==='object' && !Array.isArray(out[k]))
        out[k]=this.deepMerge(out[k],bv);
      else out[k]=bv;
    }
    return out;
  }
  // Emulates the recommended Firestore rules: users/{uid} owned by a signed-in, non-anonymous uid.
  allowed(d, p){
    const m=/^users\/([^/]+)(\/tx\/[^/]+)?$/.exec(p);
    if(m && m[2] && this.denyChunks) return false;          // قواعد قديمة لا تسمح بفولدر tx
    return !!(m && d.authUid && !d.anon && d.authUid===m[1]);
  }
  // قاعدة الحماية: بعد التحويل للشكل الشهري لا يكتب المستند الرئيسي إلا عميل بنفس الشكل
  writeAllowed(d, w){
    if(!this.allowed(d, w.path)) return false;
    if(this.legacyRules || !/^users\/[^/]+$/.test(w.path)) return true;
    const cur=this.docs.get(w.path);
    if(!cur || !((cur.data._fmt||0)>=4)) return true;
    return !w.del && !!w.data && (w.data._fmt||0)>=4;
  }
  apply(w){
    const cur=this.docs.get(w.path);
    if(w.del){ this.docs.delete(w.path); this.writes.push({path:w.path,at:Date.now(),del:true}); return; }
    const stamped=this.stamp(w.data);
    const next=w.merge && cur ? this.deepMerge(cur.data, stamped) : stamped;
    if(Buffer.byteLength(JSON.stringify(next))>DOC_LIMIT){ const e=new Error('Document exceeds 1 MiB'); e.code='invalid-argument'; throw e; }
    this.docs.set(w.path,{data:next,ver:(cur?cur.ver:0)+1});
    this.writes.push({path:w.path,at:Date.now()});
  }
  async handle(devId, op, args){
    const live=this.dev(devId);
    // صلاحيات Firestore تُقيَّم بهوية الطلب لحظة إرساله، لا لحظة معالجته
    const d=Object.assign(Object.create(live), { authUid:live.authUid, anon:live.anon });
    const fail=(code,msg)=>{ const e=new Error(msg||code); e.code=code; throw e; };
    if(live.delayMs) await new Promise(r=>setTimeout(r,live.delayMs));
    if(live.delayOp && live.delayOp[op]) await new Promise(r=>setTimeout(r,live.delayOp[op]));
    const injected = () => { const i=live.failNext.findIndex(f=>f.op===op||f.op==='*'); if(i>=0){ const f=live.failNext.splice(i,1)[0]; fail(f.code); } };
    switch(op){
      case 'signIn': {
        if(d.offline) fail('auth/network-request-failed');
        const u=this.users.get(args.email);
        if(!u || u.pw!==args.pw) fail('auth/invalid-credential');
        live.authUid=u.uid; live.anon=false;
        return {uid:u.uid,email:args.email,displayName:u.displayName,isAnonymous:false};
      }
      case 'signUp': {
        if(d.offline) fail('auth/network-request-failed');
        if(this.users.has(args.email)) fail('auth/email-already-in-use');
        const uid=this.addUser(args.email,args.pw); live.authUid=uid; live.anon=false;
        return {uid,email:args.email,displayName:null,isAnonymous:false};
      }
      case 'anon': {
        if(d.offline) fail('auth/network-request-failed');
        const uid='anon_'+(++this.anonN); live.authUid=uid; live.anon=true;
        return {uid,isAnonymous:true};
      }
      case 'updateProfile': return true;
      case 'reset': { if(!this.users.has(args.email)) fail('auth/user-not-found'); return true; }
      case 'whoami': { live.authUid=args.uid||null; live.anon=!!args.anon; return true; }
      case 'get': {
        if(d.offline) fail('unavailable','Failed to get document because the client is offline.');
        injected();
        if(!this.allowed(d,args.path)) fail('permission-denied','Missing or insufficient permissions.');
        this.reads.push({dev:devId,path:args.path});
        const cur=this.docs.get(args.path);
        return cur ? {exists:true,data:cur.data,ver:cur.ver} : {exists:false,ver:0};
      }
      case 'set': {
        // Real SDK without persistence: an offline set() does not reject, it waits for the network.
        if(live.offline) await new Promise(res=>live.queue.push(res));
        injected();
        if(!this.writeAllowed(d,args)) fail('permission-denied','Missing or insufficient permissions.');
        this.apply(args); return true;
      }
      case 'commit': {
        if(d.offline) fail('unavailable','Transaction failed: client is offline.');
        injected();
        for(const p in args.reads){ const cur=this.docs.get(p); if((cur?cur.ver:0)!==args.reads[p]) return 'aborted'; }
        for(const w of args.writes){ if(!this.writeAllowed(d,w)) fail('permission-denied','Missing or insufficient permissions.'); }
        for(const w of args.writes) this.apply(w);
        // نتيجة غامضة: السيرفر نفّذ لكن الرد ضاع في الشبكة
        if(live.ambiguousNext){ live.ambiguousNext--; fail('unavailable','connection lost after commit'); }
        return 'ok';
      }
    }
    fail('unimplemented', 'op '+op);
  }
  /** البيانات كما يراها المستخدم: المستند الرئيسي + أجزاء الشهور (إن وُجدت) */
  cloudData(uid){
    const cur=this.docs.get('users/'+uid); if(!cur) return null;
    const d=JSON.parse(JSON.stringify(cur.data));
    if((d._fmt||0)>=4){
      const keys=Object.keys(d._chunks||{}).sort(); const tx=[];
      for(const k of keys){ const c=this.docs.get('users/'+uid+'/tx/'+k); if(c) tx.push(...c.data.transactions); }
      d.transactions=tx;
    }
    return d;
  }
  rawMain(uid){ const c=this.docs.get('users/'+uid); return c ? JSON.parse(JSON.stringify(c.data)) : null; }
  chunkPaths(uid){ return [...this.docs.keys()].filter(k=>k.startsWith('users/'+uid+'/tx/')).sort(); }
}

class Harness {
  constructor(appFile){ this.appFile=appFile; this.server=new FakeServer(); this.devices=[]; this.n=0; }
  async start(){ this.browser=await chromium.launch({ args: process.env.KM_FAKE_MEDIA ? ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] : [] }); }
  async stop(){ await this.browser.close(); }
  async closeDevices(){ for(const d of this.devices) await d.ctx.close().catch(()=>{}); this.devices=[]; }

  async device(name, opts={}){
    const id=name+'#'+(++this.n);
    const ctx=await this.browser.newContext({ viewport:{width:420,height:860}, permissions: opts.permissions||[] });
    if(opts.initScript) await ctx.addInitScript(opts.initScript);
    const html=fs.readFileSync(opts.appFile||this.appFile,'utf8');
    const state={ firebaseAvailable: opts.firebase!==false };
    await ctx.route('**/*', async route=>{
      const u=route.request().url();
      if(u.startsWith('https://km.test/')) return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
      if(u.includes('gstatic.com/firebasejs')){
        if(!state.firebaseAvailable) return route.abort('internetdisconnected');
        const m=/firebasejs\/13\.1\.0\/(firebase-app|firebase-ai|firebase-app-check)\.js$/.exec(u);
        if(m){
          if(state.aiAvailable===false) return route.abort('internetdisconnected');
          return route.fulfill({status:200,contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},
                                body:fs.readFileSync(path.join(__dirname,'ai-mock',m[1]+'.js'),'utf8')});
        }
        return route.fulfill({status:200,contentType:'application/javascript',body:u.includes('firebase-app-compat')?MOCK:''});
      }
      if(u.includes('chart.js')) return route.fulfill({status:200,contentType:'application/javascript',body:CHART_STUB});
      return route.abort();
    });
    const server=this.server;
    await ctx.exposeFunction('__fs', async (op, argsJson)=>{
      try{ return JSON.stringify({result: await server.handle(id, op, JSON.parse(argsJson))}); }
      catch(e){ return JSON.stringify({error:{code:e.code||'internal',message:e.message}}); }
    });
    const page=await ctx.newPage();
    const dev={ id, name, ctx, page, state, logs:[], dialogs:[], dialogAnswer: opts.dialogAnswer, h:this };
    page.on('console', m=>{ if(m.type()==='error'||m.type()==='warning') dev.logs.push(m.type()+': '+m.text()); });
    page.on('pageerror', e=>dev.logs.push('pageerror: '+e.message));
    page.on('dialog', async dlg=>{
      dev.dialogs.push({type:dlg.type(), msg:dlg.message()});
      const ans = typeof dev.dialogAnswer==='function' ? dev.dialogAnswer(dlg) : undefined;
      if(ans===false) return dlg.dismiss();
      if(dlg.type()==='prompt') return dlg.accept(typeof ans==='string'?ans:'');
      return dlg.accept();
    });
    Object.assign(dev, {
      goto: ()=>page.goto('https://km.test/app.html',{waitUntil:'load'}),
      reload: async ()=>{ await page.reload({waitUntil:'load'}); },
      offline: async (off)=>{ server.setOffline(id, off); await ctx.setOffline(off); },
      ev: (fn, arg)=>page.evaluate(fn, arg),
      wait: (ms)=>page.waitForTimeout(ms),
      appVisible: ()=>page.evaluate(()=>{ const e=document.getElementById('appShell'); return !!e && getComputedStyle(e).display!=='none'; }),
      waitApp: async (t=8000)=>{ await page.waitForFunction(()=>{ const e=document.getElementById('appShell'); return e && getComputedStyle(e).display!=='none'; },null,{timeout:t}); await page.waitForTimeout(150); },
      login: async (email,pw)=>{
        await page.waitForFunction(()=>typeof doLogin==='function');
        await page.fill('#loginEmail',email); await page.fill('#loginPassword',pw);
        await page.evaluate(()=>doLogin());
        await dev.waitApp();
      },
      badge: ()=>page.evaluate(()=>{
        const el=document.getElementById('syncBadge'); if(!el) return null;
        if(el.dataset && el.dataset.state) return el.dataset.state;
        const t=el.textContent;
        const map={'☁️ محفوظ':'synced','⏳ مزامنة…':'syncing','📴 محلي':'offline','💾 محلي':'local','⚠️ لم يُحفظ':'error','👤 ضيف':'guest'};
        return map[t]||t;
      }),
      addTx: (tx)=>page.evaluate(t=>{
        const r=addTransaction(Object.assign({date:today_str(),type:'Expense',category:'اختبار',amount:10},t));
        if(typeof refreshUI==='function') refreshUI();
        return r && r.id;
      }, tx||{}),
      txIds: ()=>page.evaluate(()=>data.transactions.map(t=>t.id).sort()),
      localTxIds: (uid)=>page.evaluate((uid)=>{
        const keys=Object.keys(localStorage).filter(k=>k.startsWith('km_local_data__'+uid));
        const k=keys.find(k=>k==='km_local_data__'+uid);
        if(!k) return null;
        try{ return JSON.parse(localStorage.getItem(k)).transactions.map(t=>t.id).sort(); }catch(e){ return 'invalid'; }
      }, uid),
      pending: ()=>page.evaluate(()=>{ const a=storageAdapter(); return a.hasPendingWrites ? a.hasPendingWrites() : null; }),
      sync: ()=>page.evaluate(async()=>{ const a=storageAdapter(); if(a.syncNow) return a.syncNow(); if(a.retry) return a.retry(); if(a.flush) return a.flush(); })
    });
    this.devices.push(dev);
    return dev;
  }
  cloudTxIds(uid){ const d=this.server.cloudData(uid); return d && Array.isArray(d.transactions) ? d.transactions.map(t=>t.id).sort() : null; }
}

async function until(fn, timeout=6000, step=100){
  const t0=Date.now(); let last;
  while(Date.now()-t0<timeout){ last=await fn(); if(last) return last; await new Promise(r=>setTimeout(r,step)); }
  return last;
}

module.exports = { Harness, FakeServer, until };
