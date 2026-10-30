import {readFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS} from '../extension/core.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFile(join(root,path),'utf8');
const manifest=JSON.parse(await read('extension/manifest.json'));
const pkg=JSON.parse(await read('package.json'));
assert.equal(manifest.manifest_version,3);
assert.equal(manifest.version,pkg.version);
for(const path of [manifest.background.service_worker,manifest.side_panel.default_path,'content.js','sidepanel.js','sidepanel.css','core.mjs','bank.mjs','LICENSE','THIRD_PARTY_NOTICES.md'])await read(`extension/${path}`);
assert.equal(await read('LICENSE'),await read('extension/LICENSE'));
assert.equal(await read('THIRD_PARTY_NOTICES.md'),await read('extension/THIRD_PARTY_NOTICES.md'));
assert.match(await read('LICENSE'),/MIT License/u);
assert.equal(DEFAULT_SETTINGS.baseUrl,'');assert.equal(DEFAULT_SETTINGS.model,'');assert.equal(DEFAULT_SETTINGS.apiKey,'');
const html=await read('extension/sidepanel.html'),panel=await read('extension/sidepanel.js');
const ids=[...html.matchAll(/\bid="([^"]+)"/gu)].map(m=>m[1]);
assert.equal(new Set(ids).size,ids.length,'Duplicate HTML IDs');
for(const match of panel.matchAll(/\$\('([^']+)'\)/gu))assert.ok(ids.includes(match[1]),`Missing control ${match[1]}`);
assert.ok(panel.includes(`version:'${pkg.version}'`));assert.ok(html.includes(`题伴 ${pkg.version}`));
let checked=0;
async function scan(directory){
  for(const e of await readdir(join(root,directory),{withFileTypes:true})){
    if(['.git','node_modules','dist'].includes(e.name))continue;
    const relative=join(directory,e.name);
    if(e.isDirectory()){await scan(relative);continue}
    const content=await read(relative);checked++;
    assert.ok(!/https:\/\/ws-[a-z0-9]+\.[a-z0-9-]+\.maas\.aliyuncs\.com/u.test(content),`Personal workspace endpoint in ${relative}`);
    assert.ok(!/\b[CD]:[\\/](?:Users|CodeSoftware)[\\/]/u.test(content),`Local personal path in ${relative}`);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content),`Private-key marker in ${relative}`);
    assert.ok(!/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/u.test(content),`Credential-like token in ${relative}`);
  }
}
await scan('');
console.log(`Checked ${checked} public files, ${ids.length} HTML IDs, version ${pkg.version}; no matching personal paths or recognized token patterns.`);
