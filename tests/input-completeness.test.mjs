import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAnswer,requestAnswer,DEFAULT_SETTINGS} from '../extension/core.mjs';
test('missing input is preserved without an answer, including a contradictory guessed letter',()=>{
 for(const extra of [{},{answer:'B'},{blankAnswers:['17/6']},{answer:'B',uncertain:false}]) {
  const result=parseAnswer(JSON.stringify({inputComplete:false,missingInformation:'缺少题干所引用的树图。',...extra}));
  assert.equal(result.inputComplete,false);assert.equal(result.answer,'');assert.match(result.missingInformation,/树图/);
 }
});
test('answer confidence remains independent of input completeness',()=>{
 const result=parseAnswer('{"answer":"B","inputComplete":true,"uncertain":true}');
 assert.equal(result.inputComplete,true);assert.equal(result.answer,'B');assert.equal(result.uncertain,true);
 for(const flag of [undefined,'false',0,null]){const value=parseAnswer(JSON.stringify({answer:'B',inputComplete:flag}));assert.equal(value.answer,'B');assert.notEqual(value.inputComplete,false)}
});
test('single-question prompts ask for missing source information without asking for an answer recheck',async()=>{
 let payload;
 const result=await requestAnswer({settings:{...DEFAULT_SETTINGS,baseUrl:'https://fixture.test/v1',model:'fixture',apiKey:'fixture-only'},question:'根据下图判断。',directFill:true,fetchImpl:async(_u,o)=>{payload=JSON.parse(o.body);return new Response(JSON.stringify({choices:[{message:{content:'{"inputComplete":false,"missingInformation":"缺图"}'},finish_reason:'stop'}]}))}});
 assert.equal(result.inputComplete,false);assert.match(payload.messages[0].content,/inputComplete/);assert.match(payload.messages[0].content,/不能仅因这些情况/);assert.equal(payload.stream,false);
});
