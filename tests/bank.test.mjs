import test from 'node:test';
import assert from 'node:assert/strict';
import * as bank from '../extension/bank.mjs';

const Q='【单选题】以下关于进程调度的说法正确的是？\nA. 时间片轮转一定更优\nB. 优先级调度可能造成饥饿\nC. 调度没有开销';
const reordered='【单选题】以下关于进程调度的说法正确的是？\nA. 优先级调度可能造成饥饿\nB. 调度没有开销\nC. 时间片轮转一定更优';
const result=answer=>({answer,explanation:'测试解析',uncertain:false});
function recorded(answer='B',extra={}){const map=new Map();const entry=bank.recordModel(map,{text:Q,result:result(answer),...extra});return {map,entry};}

test('model certainty and repeated generation never confirm a candidate',()=>{
  const {map,entry}=recorded();assert.equal(entry.status,'pending');
  for(let i=0;i<3;i++) bank.recordModel(map,{text:Q,result:result('B')});
  assert.equal(bank.lookupVerified(map,Q),null);assert.equal(map.get(entry.key).status,'pending');
});
test('manual confirmation permits reuse and remaps all reordered choices',()=>{
  const {map,entry}=recorded();bank.confirm(map,entry.key,{answer:'B',note:'对照教材'});
  const hit=bank.lookupVerified(map,reordered);assert.equal(hit.answer,'A');assert.equal(hit.provenance,'verified');
  assert.equal(hit.entry.history.length,1);
});
test('full option set must match even when the chosen option is unchanged',()=>{
  const {map,entry}=recorded();bank.confirm(map,entry.key,{answer:'B'});
  assert.equal(bank.lookupVerified(map,Q.replace('调度没有开销','调度确实有开销')),null);
});
test('operators, decimals, letter case, negations and long stems retain meaning',()=>{
  for(const [left,right] of [['x+y','x-y'],['1.5','15'],['A','a'],['正确','不正确']]){
    const q=`以下表达式中${left}的具体含义是什么？\nA. 第一种\nB. 第二种`;
    assert.notEqual(bank.parseQuestion(q).signature,bank.parseQuestion(q.replace(left,right)).signature);
  }
  const prefix='材料内容'.repeat(150);assert.notEqual(bank.parseQuestion(prefix+'甲？\nA. 一\nB. 二').key,bank.parseQuestion(prefix+'乙？\nA. 一\nB. 二').key);
});
test('ambiguous duplicate options and malformed letters cannot become bank entries',()=>{
  assert.equal(bank.parseQuestion('以下答案中哪个正确？\nA. 完全 相同\nB. 完全相同'),null);
  const map=new Map();assert.equal(bank.recordModel(map,{text:Q,result:result('A、D')}),null);
  assert.equal(bank.recordModel(map,{text:Q,result:result('A、A')}),null);
  assert.equal(bank.recordModel(map,{text:Q,result:result('A、B')}),null);
});
test('a different model answer disables a confirmed answer and keeps its history',()=>{
  const {map,entry}=recorded();bank.confirm(map,entry.key,{answer:'B'});
  const conflict=bank.recordModel(map,{text:Q,result:result('A')});assert.equal(conflict.status,'conflict');
  assert.equal(bank.lookupVerified(map,Q),null);assert.ok(conflict.history.some(h=>h.status==='verified' && h.answerTexts[0].includes('饥饿')));
  bank.confirm(map,entry.key,{answer:'B'});assert.equal(bank.lookupVerified(map,Q).answer,'B');
});
test('rejecting an answer prevents later model output from restoring verification',()=>{
  const {map,entry}=recorded();bank.confirm(map,entry.key,{answer:'B'});bank.reject(map,entry.key,'页面批改为错误');
  assert.equal(bank.lookupVerified(map,Q),null);
  bank.recordModel(map,{text:Q,result:result('B')});assert.equal(map.get(entry.key).status,'conflict');
});
test('a pending answer disagreement is visible as a conflict',()=>{
  const {map}=recorded();assert.equal(bank.recordModel(map,{text:Q,result:result('A')}).status,'conflict');
});
test('old v1 verified flags are migrated to pending instead of trusting clicked answers',()=>{
  const migrated=bank.deserialize({v:1,items:[{question:Q,answer:'B',letters:['B'],verified:true}]});
  assert.equal(migrated.size,1);assert.equal([...migrated.values()][0].status,'pending');assert.equal(bank.lookupVerified(migrated,Q),null);
});
test('v2 local storage preserves manual verification, external imports never inherit it',()=>{
  const {map,entry}=recorded();bank.confirm(map,entry.key,{answer:'B'});
  assert.equal(bank.lookupVerified(bank.deserialize(bank.serialize(map)),Q).answer,'B');
  const imported=bank.deserialize(bank.serialize(map),{imported:true});assert.equal(bank.lookupVerified(imported,Q),null);
  assert.equal([...imported.values()][0].source,'import');
});
test('a conflicting import quarantines the existing entry and preserves both sources',()=>{
  const {map,entry}=recorded();bank.confirm(map,entry.key,{answer:'B'});
  const other=recorded('A');const merged=bank.mergeImport(map,bank.serialize(other.map));assert.equal(merged.conflicts,1);
  assert.equal(map.get(entry.key).status,'conflict');assert.equal(bank.lookupVerified(map,Q),null);
});
test('image records stay separate from textual questions and never auto-reuse',()=>{
  const {map,entry}=recorded('B',{hasVisual:true});bank.confirm(map,entry.key,{answer:'B'});
  assert.equal(bank.lookupVerified(map,Q),null);assert.equal(bank.lookupVerified(map,Q,{hasVisual:true}),null);
  const restored=bank.deserialize(bank.serialize(map));assert.equal(restored.get(entry.key).hasVisual,true);
});
test('bank parsing ignores forged signatures and tolerates corrupt records',()=>{
  assert.equal(bank.deserialize('bad json').size,0);assert.equal(bank.deserialize({items:'bad'}).size,0);
  const {map}=recorded();const payload=JSON.parse(bank.serialize(map));payload.items[0].key='forged';payload.items[0].signature='forged';
  assert.equal([...bank.deserialize(payload).values()][0].key,bank.parseQuestion(Q).key);
});
test('answer parser supports compact multi-select without accepting explanatory prose as letters',()=>{
  assert.deepEqual(bank.lettersOf('答案：ABD'),['A','B','D']);assert.deepEqual(bank.lettersOf('Apple is an option'),[]);
});

test('trusted import directly confirms pending, invalid and conflicting file records',()=>{
  const source=new Map();
  for(const status of ['pending','invalid','conflict','verified']) {
    const entry=bank.recordModel(source,{text:Q.replace('进程调度',status+'进程调度'),result:result('B')});entry.status=status;
  }
  const target=new Map();const summary=bank.mergeImport(target,bank.serialize(source),{trust:true});
  assert.equal(summary.confirmed,4);assert.equal(summary.added,4);
  for(const entry of target.values()){assert.equal(entry.status,'verified');assert.equal(entry.source,'import-trusted');assert.equal(bank.lookupVerified(target,entry.question).answer,'B');}
});

test('trusted import replaces an existing different answer and retains the replaced answer in history',()=>{
  const {map,entry}=recorded();bank.confirm(map,entry.key,{answer:'B'});
  const file=recorded('A');const summary=bank.mergeImport(map,bank.serialize(file.map),{trust:true});
  assert.equal(summary.updated,1);assert.equal(summary.conflicts,1);assert.equal(bank.lookupVerified(map,Q).answer,'A');
  const saved=map.get(entry.key);assert.equal(saved.source,'import-trusted');assert.ok(saved.history.some(h=>h.answerTexts.includes('优先级调度可能造成饥饿')));
});

test('explicit trusted import can re-enable a rejected record, while ordinary import cannot',()=>{
  const {map,entry}=recorded();bank.reject(map,entry.key);const file=bank.serialize(recorded().map);
  bank.mergeImport(map,file);assert.equal(map.get(entry.key).status,'invalid');
  bank.mergeImport(map,file,{trust:true});assert.equal(bank.lookupVerified(map,Q).answer,'B');
});

test('trusted import and batch sources and histories survive export and local reload',()=>{
  const {map,entry}=recorded();bank.confirm(map,entry.key,{answer:'B',note:'第一台电脑核对'});
  const target=new Map();bank.mergeImport(target,bank.serialize(map),{trust:true});
  assert.ok(target.get(entry.key).history.some(h=>h.note.includes('第一台电脑')));
  const restored=bank.deserialize(bank.serialize(target));assert.equal(restored.get(entry.key).source,'import-trusted');assert.equal(bank.lookupVerified(restored,Q).answer,'B');
  bank.reject(restored,entry.key);bank.confirmMany(restored,[entry.key]);
  assert.equal(bank.deserialize(bank.serialize(restored)).get(entry.key).source,'batch');
});

test('batch confirmation only modifies supplied keys and deduplicates them',()=>{
  const {map,entry}=recorded();const other=bank.recordModel(map,{text:Q.replace('进程调度','线程调度'),result:result('B')});
  const summary=bank.confirmMany(map,[entry.key,entry.key,'missing']);
  assert.deepEqual(summary,{confirmed:1,unchanged:0,skipped:1});assert.equal(map.get(entry.key).source,'batch');assert.equal(map.get(other.key).status,'pending');
});

test('batch confirmation explicitly trusts saved conflicting and rejected answers and skips bad records',()=>{
  const {map,entry}=recorded();bank.reject(map,entry.key);
  const conflict=bank.recordModel(map,{text:Q.replace('进程调度','线程调度'),result:result('A')});conflict.status='conflict';
  const verified=bank.recordModel(map,{text:Q.replace('进程调度','内存分配'),result:result('B')});bank.confirm(map,verified.key,{answer:'B'});
  const bad=bank.recordModel(map,{text:Q.replace('进程调度','设备管理'),result:result('B')});bad.answer='Z';
  const summary=bank.confirmMany(map,[...map.keys()]);assert.deepEqual(summary,{confirmed:2,unchanged:1,skipped:1});
  assert.equal(bank.lookupVerified(map,Q).answer,'B');assert.equal(map.get(conflict.key).answer,'A');assert.equal(map.get(bad.key).status,'pending');
  assert.ok(map.get(entry.key).history.some(h=>h.status==='invalid'));
});

test('trust does not bypass question, option or single-choice answer validation',()=>{
  const source=JSON.parse(bank.serialize(recorded().map));source.items[0].answerTexts=['时间片轮转一定更优','优先级调度可能造成饥饿'];
  const target=new Map();const summary=bank.mergeImport(target,source,{trust:true});assert.equal(summary.confirmed,0);assert.equal(summary.skipped,1);assert.equal(target.size,0);
});

test('a file cannot enable trusted import through its own fields',()=>{
  const source=JSON.parse(bank.serialize(recorded().map));source.trust=true;source.items[0].status='verified';
  const target=new Map();bank.mergeImport(target,source);assert.equal(bank.lookupVerified(target,Q),null);
});

test('trusted import adopts the last duplicate answer and preserves the earlier answer in history',()=>{
  const source={v:2,items:[...recorded('A').map.values(),...recorded('B').map.values()]};const target=new Map();
  bank.mergeImport(target,source,{trust:true});assert.equal(bank.lookupVerified(target,Q).answer,'B');
  assert.ok([...target.values()][0].history.some(h=>h.answerTexts.includes('时间片轮转一定更优')));
});
