// Mock of the Firebase compat SDK (app/auth/firestore) used by keepMoney.
// All server state lives in Node and is reached through window.__fs (Playwright exposeFunction),
// so several browser contexts (= several devices) share one fake backend.
(function(){
  const call = (op, args) => window.__fs(op, JSON.stringify(args||{})).then(r => {
    const o = JSON.parse(r);
    if (o.error) { const e = new Error(o.error.message || o.error.code); e.code = o.error.code; throw e; }
    return o.result;
  });

  class Timestamp {
    constructor(ms){ this._ms = ms; }
    toDate(){ return new Date(this._ms); }
    toMillis(){ return this._ms; }
    isEqual(o){ return o && o._ms === this._ms; }
  }
  const SENTINEL = { __serverTimestamp: true };
  const revive = (v) => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      if (typeof v.__ts === 'number') return new Timestamp(v.__ts);
      const o = {}; for (const k in v) o[k] = revive(v[k]); return o;
    }
    return v;
  };
  const encode = (v) => {
    if (v === SENTINEL) return { __serverTimestamp: true };
    if (v instanceof Timestamp) return { __ts: v._ms };
    if (Array.isArray(v)) {
      return v.map(x => { if (Array.isArray(x)) { const e=new Error('Nested arrays are not supported'); e.code='invalid-argument'; throw e; } return encode(x); });
    }
    if (v === undefined) { const e = new Error('Unsupported field value: undefined'); e.code = 'invalid-argument'; throw e; }
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = encode(v[k]); return o; }
    return v;
  };
  const snapOf = (path, r) => ({
    exists: !!r.exists, id: path.split('/').pop(),
    data(){ return r.exists ? revive(JSON.parse(JSON.stringify(r.data))) : undefined; },
    get(f){ const d = this.data(); return d ? d[f] : undefined; }
  });

  class DocRef {
    constructor(path){ this.path = path; this.id = path.split('/').pop(); }
    get(opts){ return call('get', { path: this.path }).then(r => snapOf(this.path, r)); }
    set(data, opts){ return call('set', { path: this.path, data: encode(data), merge: !!(opts && opts.merge) }); }
    delete(){ return call('set', { path: this.path, del: true }); }
    collection(n){ return new ColRef(this.path + '/' + n); }
  }
  class ColRef {
    constructor(path){ this.path = path; }
    doc(id){ return new DocRef(this.path + '/' + id); }
  }

  const db = {
    collection(n){ return new ColRef(n); },
    async runTransaction(fn){
      for (let attempt = 0; attempt < 5; attempt++) {
        const reads = {}, writes = [];
        const tx = {
          async get(ref){
            const r = await call('get', { path: ref.path, tx: true });
            reads[ref.path] = r.ver || 0;
            return snapOf(ref.path, r);
          },
          set(ref, data, opts){ writes.push({ path: ref.path, data: encode(data), merge: !!(opts && opts.merge) }); return tx; },
          delete(ref){ writes.push({ path: ref.path, del: true }); return tx; }
        };
        const out = await fn(tx);
        const res = await call('commit', { reads, writes });
        if (res === 'ok') return out;
      }
      const e = new Error('Transaction failed all retries'); e.code = 'aborted'; throw e;
    }
  };

  // ── auth ──
  const AUTH_LS = '__mockAuthUser';
  const listeners = [];
  let currentUser = null;
  const mkUser = (u) => u && ({
    uid: u.uid, email: u.email || null, displayName: u.displayName || null, isAnonymous: !!u.isAnonymous,
    updateProfile(p){ this.displayName = p.displayName; persist(this); return call('updateProfile', { uid: this.uid, displayName: p.displayName }); }
  });
  function persist(u){
    try { u ? localStorage.setItem(AUTH_LS, JSON.stringify({ uid:u.uid, email:u.email, displayName:u.displayName, isAnonymous:u.isAnonymous }))
            : localStorage.removeItem(AUTH_LS); } catch(e) {}
  }
  function setUser(u){ currentUser = u; persist(u); listeners.forEach(cb => { try { cb(u); } catch(e) { console.error(e); } }); }
  try { const s = JSON.parse(localStorage.getItem(AUTH_LS) || 'null'); if (s) { currentUser = mkUser(s); call('whoami',{uid:s.uid,anon:!!s.isAnonymous}).catch(()=>{}); } } catch(e) {}

  const auth = {
    get currentUser(){ return currentUser; },
    setPersistence(){ return Promise.resolve(); },
    onAuthStateChanged(cb){ listeners.push(cb); setTimeout(() => cb(currentUser), 0); return () => {}; },
    async signInWithEmailAndPassword(email, pw){ const u = await call('signIn', { email, pw }); setUser(mkUser(u)); return { user: currentUser }; },
    async createUserWithEmailAndPassword(email, pw){ const u = await call('signUp', { email, pw }); setUser(mkUser(u)); return { user: currentUser }; },
    async signInAnonymously(){ const u = await call('anon', {}); setUser(mkUser(u)); return { user: currentUser }; },
    async sendPasswordResetEmail(email){ return call('reset', { email }); },
    async signOut(){ await call('whoami',{uid:null}).catch(()=>{}); setUser(null); }
  };

  window.firebase = {
    initializeApp(cfg){ return { name: '[DEFAULT]', options: cfg }; },
    auth: Object.assign(() => auth, { Auth: { Persistence: { LOCAL: 'local' } } }),
    firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => SENTINEL }, Timestamp })
  };
})();
