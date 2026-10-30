import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createDemoServer} from '../scripts/demo-server.mjs';

test('local demonstration uses the compatible protocol and rejects unrelated prompts',async()=>{
  const server=createDemoServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/题伴 · 本地流程演示/u);
    for(const [prompt,expected]of [['演示一：2 + 2 等于多少','B'],['演示二：请选择所有偶数','A、C'],['演示三：按顺序填写两个空',['5','6']]]){
      const response=await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'demo',messages:[{role:'user',content:prompt}]})});
      assert.equal(response.status,200);const result=JSON.parse((await response.json()).choices[0].message.content);
      assert.deepEqual(result.blankAnswers || result.answer,expected);assert.equal(result.inputComplete,true);
    }
    const unknown=await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'demo',messages:[{role:'user',content:'其他题目'}]})});assert.equal(unknown.status,400);
    const malformed=await fetch(base+'/v1/chat/completions',{method:'POST',body:'{invalid'});assert.equal(malformed.status,400);
  }finally{await new Promise(resolve=>server.close(resolve))}
});
