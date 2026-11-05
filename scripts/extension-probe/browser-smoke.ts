import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const html=await readFile(resolve('dist/extension-probe/extension-probe/probe.html'),'utf8');
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();
  page.on('pageerror',error=>console.error(error.message));
  await page.route('https://probe.test/probe',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.route('https://probe.test/',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><script>
window.calls=[];
window.addEventListener('message',e=>{const m=e.data;if(!m||m.jsonrpc!=='2.0')return;window.calls.push(m.method);
const send=result=>e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
if(m.method==='ui/initialize')send({protocolVersion:'2026-01-26',hostInfo:{name:'mock-host',version:'1'},hostCapabilities:{serverTools:{},serverResources:{},updateModelContext:{},experimental:{'openai/resource':{},'openai/modelContext':{}}},hostContext:{displayMode:'fullscreen'}});
else if(m.method==='ui/notifications/initialized')e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],_meta:{'placekeeper/probe':{nonce:'mock-nonce',invocation:'mock-invocation',file:{name:'fixture.pdf',resourceUri:'opaque:test'}}}}},'*');
else if(m.method==='resources/read')send({contents:[{uri:'opaque:test',mimeType:'application/pdf',blob:btoa('%PDF-1.7 test'),_meta:{'openai/resource':{writable:false,etag:'test'}}}]});
else if(m.method==='tools/call')send({content:[],_meta:{'placekeeper/probe-observed':true}});
else if(m.method==='ui/update-model-context')send({_meta:{'openai/modelContext':{updateId:'test-update'}}});
else if(m.id!==undefined)send({});
});</script><iframe src="/probe"></iframe>`}));
  await page.goto('https://probe.test/');
  const frame=page.frameLocator('iframe');
  await frame.locator('#report').filter({hasText:'"pdf": true'}).waitFor({timeout:5000}).catch(async error=>{console.error(await frame.locator('#report').textContent(),await page.evaluate(()=>(window as unknown as {calls:string[]}).calls));throw error;});
  await frame.getByRole('button',{name:'Attach test context marker'}).click();
  await frame.locator('#report').filter({hasText:'Marker published'}).waitFor();
  for(const width of [375,1440]){
    await page.setViewportSize({width,height:900});
    const overflow=await frame.locator('body').evaluate(e=>e.scrollWidth>window.innerWidth);
    if(overflow)throw new Error(`Horizontal overflow at ${width}`);
    await page.screenshot({path:resolve(`dist/extension-probe/preview-${width}.png`)});
  }
  const calls=await page.evaluate(()=>(window as unknown as {calls:string[]}).calls);
  if(calls.some(m=>m==='ui/message'||m==='openai/resources/write'))throw new Error('Unexpected message or PDF write');
  await writeFile(resolve('dist/extension-probe/browser-smoke.json'),JSON.stringify({actualHost:false,resourceRead:true,contextMarker:true,widths:[375,1440],calls},null,2));
  console.log('Mock-host browser smoke passed: resource read, context marker, 375/1440px layout, no PDF writes or messages.');
}finally{await browser.close();}
