// Scripted fake of Firebase AI Logic used only by the test-suite.
const log=(o)=>(window.__aiLog=window.__aiLog||[]).push(o);
export class GoogleAIBackend{}
export function getAI(app,opts){ return {app,backend:opts&&opts.backend}; }
const sch=(type)=>(p={})=>Object.assign({type},p);
export const Schema={ object:sch('object'), string:sch('string'), number:sch('number'), integer:sch('integer'), enumString:sch('string') };
const digits=(s)=>s.replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const resp=(text,calls)=>({response:{ text:()=>text||'', functionCalls:()=>calls&&calls.length?calls:undefined }});
function plan(text){
  const t=digits(text);
  if(/ERR_APPCHECK/.test(t)){ const e=new Error('FirebaseError: AppCheck: ReCAPTCHA error (appCheck/recaptcha-error).'); throw e; }
  if(/ERR_429|ERRQUOTA/.test(t)){ throw new Error('[429 ] RESOURCE_EXHAUSTED: quota exceeded'); }
  if(/ERR_DISABLED/.test(t)){ throw new Error('[403] Firebase AI Logic API has not been used in project … SERVICE_DISABLED'); }
  const calls=[];
  if(/صرفت|دفعت/.test(t)){
    t.replace(/صرفت|دفعت/,'').split(/\s+و\s*(?=\d)|،|,/).forEach(seg=>{ const m=seg.trim().match(/^(\d+(?:\.\d+)?)\s+(.+)$/); if(m) calls.push({name:'add_transaction',args:{type:'Expense',amount:Number(m[1]),category:m[2].trim()}}); });
  }
  else if(/قبضت/.test(t)){ const m=t.match(/(\d+)/); calls.push({name:'add_transaction',args:{type:'Income',amount:Number(m[1]),category:'راتب'}}); }
  else if(/اتصدقت/.test(t)){ const m=t.match(/(\d+)/); calls.push({name:'add_transaction',args:{type:'Charity',amount:Number(m[1]),category:'صدقة عامة'}}); }
  else if(/ميزانية/.test(t)){ const m=t.match(/(\d+)\s*لل?(\S+)/); calls.push({name:'set_budget',args:{category:m[2],monthly_limit:Number(m[1])}}); }
  else if(/امسح آخر/.test(t)){ calls.push({name:'find_transactions',args:{limit:1,type:'Expense'}}); }
  else if(/QMAIN/.test(t)){ calls.push({name:'add_transaction',args:{type:'Expense',amount:70,category:'مكرونة'}}); }
  else if(/مصاريفي|عاملة|فين بصرف|صحتي|المستشار|محور/.test(t)){ calls.push({name:'get_overview',args:{}}); }
  else if(/فلوس السحر/.test(t)){ calls.push({name:'add_transaction',args:{type:'Expense',amount:-5,category:'سحر'}}); }
  return calls.length ? resp('',calls) : resp('أهلاً! قولّي صرفت إيه.');
}
function follow(parts, state){
  const rs=parts.map(p=>p.functionResponse);
  log({ev:'toolResults',results:rs});
  const f=rs.find(r=>r.name==='find_transactions');
  if(f && state.wantDelete && f.response.items && f.response.items[0]){ state.wantDelete=false; return resp('',[{name:'delete_transaction',args:{id:f.response.items[0].id}}]); }
  const o=rs.find(r=>r.name==='get_overview');
  if(o) return resp(`مصروفك الشهر ده ${o.response.totals.expense} ودخلك ${o.response.totals.income}.`);
  const bad=rs.find(r=>r.response && r.response.ok===false);
  if(bad) return resp('معلش، ما قدرتش: '+bad.response.error);
  return resp('تمام، اتسجّل ✅ ('+rs.map(r=>r.name).join(',')+')');
}
export function getGenerativeModel(ai,{model}){
  return {
    model,
    async generateContent(q){ if(Array.isArray(q) && q.some(p=>p.inlineData)){ const a=q.find(p=>p.inlineData).inlineData; log({ev:'transcribe',mime:a.mimeType,bytes:a.data.length}); return resp(window.__fakeTranscript||'صرفت 40 طعمية'); } log({ev:'generate',model,q});
      if(typeof q==='string' && q.includes('تقرير أسبوعي')){ const j=JSON.parse(q.slice(q.indexOf('{'))); return resp('📊 تقرير الأسبوع\nصرفت '+j.this_week.expense+' الأسبوع ده.\nنصيحة: قلّل الأكل برّه.'); }
      return resp('تمام'); },
    startChat(params){
      const state={wantDelete:false};
      log({ev:'startChat',model,history:params.history,system:params.systemInstruction,
           tools:(params.tools||[]).flatMap(t=>t.functionDeclarations.map(d=>d.name))});
      return {
        async sendMessage(req){
          await new Promise(r=>setTimeout(r,60));
          if(Array.isArray(req) && req.some(p=>p.inlineData)){
            const im=req.find(p=>p.inlineData).inlineData; log({ev:'image',mime:im.mimeType,bytes:im.data.length});
            if(window.__receiptBad) return resp('الصورة مش واضحة، المبلغ كام؟');
            return resp('',[{name:'add_transaction',args:{type:'Expense',amount:185,category:'سوبرماركت',description:'كارفور'}}]);
          }
          if(typeof req==='string' && (window.__quotaAll || (/QMAIN/.test(req) && model!=='gemini-3.5-flash-lite'))){ log({ev:'quota',model}); throw new Error('[429 ] RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_free_tier_requests'); }
          if(typeof req==='string'){ log({ev:'send',text:req,model}); if(/امسح آخر/.test(req)) state.wantDelete=true; return plan(req); }
          return follow(req,state);
        }
      };
    }
  };
}
