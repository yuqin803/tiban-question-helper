/** Local answer ledger. Verification also records explicit user trust decisions, not objective proof. */
export const BANK_LIMIT = 1500;
const MAX_TEXT = 12000;
const trim = value => String(value ?? '').trim();
const half = value => trim(value).replace(/[\uff01-\uff5e]/gu, ch => String.fromCharCode(ch.charCodeAt(0)-0xfee0)).replace(/\u3000/gu,' ');
// Preserve operators, decimal points, case and negations: x+y must never match x-y.
export const compact = value => half(value).replace(/\s+/gu,'');
export function lettersOf(value) {
  const text=half(value).replace(/^(?:(?:参考|正确)?答案(?:是|为)?\s*[:：]?\s*|选项\s*)/u,'');
  const match=/^([A-H](?:\s*[、,，和及与+/]?\s*[A-H])*)(?=$|[\s（(。.．、，；;：:])/iu.exec(text);
  return match ? [...match[1].toUpperCase().matchAll(/[A-H]/gu)].map(item=>item[0]) : [];
}
export function parseQuestion(text) {
  if(typeof text!=='string' || text.length>MAX_TEXT) return null;
  const stem=[];const options=[];let active=null;
  for(const line of text.split(/\r?\n/u).map(trim).filter(Boolean)) {
    const match=/^([A-H])[.．、)）:：\s]\s*(\S.*)$/iu.exec(line);
    if(match){active=[match[1].toUpperCase(),match[2]];options.push(active);}
    else if(active) active[1]+='\n'+line;
    else stem.push(line);
  }
  const rawStem=stem.join('\n').replace(/^\s*(?:第\s*\d+\s*题|[（(]\d+[)）]|\d+\s*[.、)）])\s*/u,'');
  const normalized=compact(rawStem);
  if(normalized.length<6 || options.length<2 || options.length>8 || new Set(options.map(([l])=>l)).size!==options.length) return null;
  const all=options.map(([,v])=>compact(v));
  if(all.some(v=>!v) || new Set(all).size!==all.length) return null;
  const signature=JSON.stringify([normalized,[...all].sort()]);
  let h=2166136261;
  for(const ch of signature){h^=ch.codePointAt(0);h=Math.imul(h,16777619);}
  return {key:(h>>>0).toString(36),signature,question:text,stem:rawStem,options};
}
function sameAnswers(a,b){return JSON.stringify([...a].map(compact).sort())===JSON.stringify([...b].map(compact).sort());}
function resolve(question,letters) {
  if(!Array.isArray(letters) || !letters.length || new Set(letters).size!==letters.length) return null;
  if(/单选|判断/u.test(question.stem) && !/多选/u.test(question.stem) && letters.length!==1) return null;
  const options=new Map(question.options);
  if(letters.some(letter=>!options.has(letter))) return null;
  return letters.map(letter=>options.get(letter));
}
function event(entry,note=''){return {at:entry.updatedAt,status:entry.status,source:entry.source,answerTexts:entry.answerTexts,model:entry.model || '',note:String(note).slice(0,400)};}
export function prune(bank) {
  const entries=[...bank.values()].sort((a,b)=>a.updatedAt-b.updatedAt);
  let bytes=entries.reduce((sum,entry)=>sum+JSON.stringify(entry).length*3,0);
  while(entries.length && (bank.size>BANK_LIMIT || bytes>3500000)) {
    const entry=entries.shift();bytes-=JSON.stringify(entry).length*3;bank.delete(entry.key);
  }
}
export function recordModel(bank,{text,result,model='',hasVisual=false,now=Date.now()}) {
  const q=parseQuestion(text);if(!q) return null;
  if(hasVisual) q.key+=':visual';
  const answerTexts=resolve(q,lettersOf(result?.answer));if(!answerTexts) return null;
  const previous=bank.get(q.key);
  if(previous && previous.signature!==q.signature) return null; // hash collision: never replace
  if(!hasVisual && previous?.status==='verified' && sameAnswers(previous.answerTexts,answerTexts)) return previous;
  const differs=previous && !sameAnswers(previous.answerTexts,answerTexts);
  const status=previous && (previous.status==='invalid' || previous.status==='conflict' || differs) ? 'conflict' : 'pending';
  const entry={...q,answer:lettersOf(result.answer).join('、'),answerTexts,explanation:trim(result.explanation).slice(0,1200),
    status,source:'model',model:trim(model).slice(0,256),hasVisual:hasVisual===true,uncertain:result.uncertain!==false,
    createdAt:previous?.createdAt || now,updatedAt:now,hits:previous?.hits || 0,
    history:[...(previous?.history || []),...(previous ? [event(previous,differs?'模型给出不同答案':'再次生成，仍待核验')] : [])].slice(-20)};
  bank.set(entry.key,entry);prune(bank);return entry;
}
export function lookupVerified(bank,text,{hasVisual=false}={}) {
  if(hasVisual) return null;
  const q=parseQuestion(text);if(!q) return null;
  const entry=bank.get(q.key);
  if(!entry || entry.hasVisual || entry.status!=='verified' || entry.signature!==q.signature) return null;
  const mapped=[];
  for(const wanted of entry.answerTexts){const matches=q.options.filter(([,v])=>compact(v)===compact(wanted));if(matches.length!==1) return null;mapped.push(matches[0][0]);}
  if(!mapped.length || new Set(mapped).size!==mapped.length) return null;
  return {entry,answer:mapped.join('、'),explanation:entry.explanation,uncertain:false,recognizedQuestion:text,bankKey:entry.key,provenance:'verified'};
}
export function confirm(bank,key,{answer,explanation,note='',source='manual',now=Date.now()}={}) {
  const previous=bank.get(key);if(!previous) throw new Error('记录已不存在，请重新选择。');
  const q=parseQuestion(previous.question);
  const answerTexts=q && resolve(q,lettersOf(answer));
  if(!answerTexts || !/^[A-H](?:[\s、,，+/]*[A-H])*$/iu.test(trim(answer))) throw new Error('请输入本题存在的选项字母，例如 A 或 A、C。');
  const entry={...previous,answer:lettersOf(answer).join('、'),answerTexts,explanation:trim(explanation ?? previous.explanation).slice(0,1200),
    status:'verified',source:source==='page'?'page-confirmed':['manual','batch','import-trusted'].includes(source)?source:'manual',uncertain:false,updatedAt:now,
    history:[...previous.history,event(previous,note || '用户核对并确认正确')].slice(-20)};
  bank.set(key,entry);return entry;
}
/** Confirm exactly the supplied saved records; never silently include other filters. */
export function confirmMany(bank,keys,{now=Date.now()}={}) {
  let confirmed=0;let unchanged=0;let skipped=0;
  for(const key of new Set(Array.isArray(keys)?keys:[])) {
    const entry=bank.get(key);
    if(!entry){skipped++;continue;}
    if(entry.status==='verified'){unchanged++;continue;}
    try {
      confirm(bank,key,{answer:entry.answer,source:'batch',now,note:'用户批量信任此记录并设为已确认；不代表程序验证了正确性'});
      confirmed++;
    } catch {skipped++;}
  }
  prune(bank);return {confirmed,unchanged,skipped};
}
export function reject(bank,key,note='用户标记错误',now=Date.now()) {
  const entry=bank.get(key);if(!entry) return null;
  const next={...entry,status:'invalid',updatedAt:now,history:[...entry.history,event(entry,note)].slice(-20)};
  bank.set(key,next);return next;
}
export function serialize(bank){return JSON.stringify({v:2,items:[...bank.values()]});}
export function deserialize(raw,{imported=false}={}) {
  const bank=new Map();
  try {
    const data=typeof raw==='string'?JSON.parse(raw):raw;
    if(!Array.isArray(data?.items)) return bank;
    for(const item of data.items.slice(-BANK_LIMIT)) {
      if(!item || typeof item.question!=='string') continue;
      const q=parseQuestion(item.question);if(!q) continue;
      if(item.hasVisual===true) q.key+=':visual';
      const values=Array.isArray(item.answerTexts)?item.answerTexts:item.answerText;
      // v1 verification meant “clicked successfully”, not “correct”; migrate all to pending.
      const answerTexts=Array.isArray(values) && values.length ? values : resolve(q,lettersOf(item.answer));
      if(!answerTexts?.length || !answerTexts.every(v=>typeof v==='string' && q.options.some(([,o])=>compact(o)===compact(v))) || new Set(answerTexts.map(compact)).size!==answerTexts.length) continue;
      const mapped=q.options.filter(([,o])=>answerTexts.some(v=>compact(o)===compact(v))).map(([letter])=>letter);
      if(!resolve(q,mapped)) continue;
      const status=!imported && data.v===2 && ['verified','pending','conflict','invalid'].includes(item.status)?item.status:'pending';
      const prior=bank.get(q.key);if(prior && prior.signature!==q.signature) continue;
      const entry={...q,answerTexts,answer:q.options.filter(([,o])=>answerTexts.some(v=>compact(o)===compact(v))).map(([l])=>l).join('、'),
        explanation:trim(item.explanation).slice(0,1200),status,source:imported?'import':data.v===2?(['model','manual','page-confirmed','import','legacy','batch','import-trusted'].includes(item.source)?item.source:'legacy'):'legacy',
        model:trim(item.model).slice(0,256),hasVisual:item.hasVisual===true,uncertain:item.uncertain!==false,createdAt:Number(item.createdAt)||Date.now(),updatedAt:Number(item.updatedAt)||Date.now(),hits:Number(item.hits)||0,
        history:Array.isArray(item.history)?item.history.filter(h=>h && typeof h==='object').slice(-20).map(h=>({at:Number(h.at)||0,status:trim(h.status).slice(0,20),source:trim(h.source).slice(0,30),model:trim(h.model).slice(0,256),answerTexts:Array.isArray(h.answerTexts)?h.answerTexts.filter(v=>typeof v==='string').map(v=>v.slice(0,1500)).slice(0,8):[],note:trim(h.note).slice(0,400)})):[]};
      if(prior && !sameAnswers(prior.answerTexts,entry.answerTexts)) {
        entry.status='conflict';entry.history=[...entry.history,event(prior,'文件中重复题的前一条答案；采用最后一条记录')].slice(-20);
      }
      bank.set(q.key,entry);
    }
  } catch {bank.clear();}
  prune(bank);return bank;
}
export function mergeImport(bank,raw,{trust=false,now=Date.now()}={}) {
  const imported=deserialize(raw,{imported:true});let added=0;let updated=0;let confirmed=0;let conflicts=0;
  let total=0;try {const data=typeof raw==='string'?JSON.parse(raw):raw;total=Array.isArray(data?.items)?data.items.length:0;} catch {}
  for(const [key,entry] of imported) {
    const old=bank.get(key);
    if(old && old.signature!==entry.signature) continue;
    if(trust===true) {
      const next={...entry,status:'verified',source:'import-trusted',uncertain:false,updatedAt:now,
        createdAt:old?.createdAt || entry.createdAt,hits:old?.hits ?? entry.hits,
        history:[...entry.history,...(old?.history || []),...(old?[event(old,'用户信任导入文件，以文件中的答案覆盖此记录')]:[]),
          event(entry,'用户选择可信导入，直接设为已确认；不代表程序验证了正确性')].slice(-20)};
      bank.set(key,next);if(old)updated++;else added++;confirmed++;
      if(old && !sameAnswers(old.answerTexts,next.answerTexts)) conflicts++;
      continue;
    }
    if(!old){bank.set(key,entry);added++;}
    else if(old.signature===entry.signature && !sameAnswers(old.answerTexts,entry.answerTexts)) {
      bank.set(key,{...old,status:'conflict',updatedAt:Date.now(),history:[...old.history,event(entry,'导入答案与已有答案冲突')].slice(-20)});conflicts++;
    }
  }
  prune(bank);return {added,updated,confirmed,conflicts,skipped:Math.max(0,total-imported.size)};
}
