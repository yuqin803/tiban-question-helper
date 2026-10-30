import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export function demoAnswer(payload){
  if(payload?.model!=='demo')throw new Error('模型 ID 请使用 demo。');
  const message=payload.messages?.findLast(m=>m.role==='user')?.content;
  const text=typeof message==='string'?message:Array.isArray(message)?message.filter(p=>p.type==='text').map(p=>p.text).join('\n'):'';
  const common={inputComplete:true,uncertain:false,explanation:'本地预设答复，仅验证读取与填写流程。'};
  if(text.includes('演示一：2 + 2 等于多少'))return {...common,answer:'B'};
  if(text.includes('演示二：请选择所有偶数'))return {...common,answer:'A、C'};
  if(text.includes('演示三：按顺序填写两个空'))return {...common,blankAnswers:['5','6']};
  throw new Error('仅支持演示页的三个合成题目，不转发其他题目。');
}

export function createDemoServer(){
  return createServer(async(req,res)=>{
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'POST, GET, OPTIONS'};
    const json=(status,value)=>{res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value))};
    try{
      if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return}
      if(req.method==='GET' && req.url==='/'){
        const html=await readFile(new URL('../docs/demo.html',import.meta.url));
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;
      }
      if(req.method==='POST' && req.url==='/v1/chat/completions'){
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1024*1024){json(413,{error:{message:'演示请求过大。'}});return}}
        const result=demoAnswer(JSON.parse(body));
        json(200,{choices:[{message:{role:'assistant',content:JSON.stringify(result)},finish_reason:'stop'}]});return;
      }
      json(404,{error:{message:'演示服务没有这个路径。'}});
    }catch(error){json(400,{error:{message:error instanceof SyntaxError?'请求不是有效 JSON。':error.message}})}
  });
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.TIBAN_DEMO_PORT || 8765),server=createDemoServer();
  server.on('error',error=>{console.error(error.message);process.exitCode=1});
  server.listen(port,'127.0.0.1',()=>console.log(`题伴本地演示：http://127.0.0.1:${port}/\nAPI：http://127.0.0.1:${port}/v1；模型：demo；密钥留空。仅返回预设答案，不调用外部模型。`));
}
