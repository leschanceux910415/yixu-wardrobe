'use strict';
// Exercise the real Node HTTP handler with in-memory request/response streams.
// No listening port or network access is required. Outfit requests use rule
// mode exclusively, even if this machine has a real model key configured.
const test=require('node:test');
const assert=require('node:assert/strict');
const {Readable,Writable}=require('node:stream');
const oldMetrics=process.env.REQUEST_METRICS;
process.env.REQUEST_METRICS='false';
const {createServer}=require('../server');
const {DATA}=require('../lib/service');
test.after(()=>{if(oldMetrics===undefined)delete process.env.REQUEST_METRICS;else process.env.REQUEST_METRICS=oldMetrics;});
let requestNumber=0;
function request(url,{method='GET',headers={},body,raw}={}){
  return new Promise((resolve,reject)=>{
    const text=raw!==undefined?raw:body!==undefined?JSON.stringify(body):'';
    const req=Readable.from(text?[Buffer.from(text)]:[]);
    req.method=method;req.url=url;req.headers={host:'localhost:5173',...(body!==undefined||raw!==undefined?{'content-type':'application/json'}:{}),...headers};
    req.socket={remoteAddress:`http-test-${++requestNumber}`};
    const collected=[];const outputHeaders={};
    const res=new Writable({write(chunk,_encoding,callback){collected.push(Buffer.from(chunk));callback();}});
    res.statusCode=200;res.setHeader=(key,value)=>{outputHeaders[key.toLowerCase()]=value;return res;};res.getHeader=key=>outputHeaders[key.toLowerCase()];
    const timer=setTimeout(()=>reject(Error('HTTP handler did not finish')),5000);
    res.on('error',error=>{clearTimeout(timer);reject(error);});
    res.on('finish',()=>{clearTimeout(timer);resolve({status:res.statusCode,headers:outputHeaders,text:Buffer.concat(collected).toString('utf8')});});
    createServer().emit('request',req,res);
  });
}

test('health and wardrobe endpoints return JSON without secrets',async()=>{
  const health=await request('/api/health');assert.equal(health.status,200);assert.match(health.headers['content-type'],/^application\/json/);
  const data=JSON.parse(health.text);assert.equal(data.ok,true);assert.equal(Object.hasOwn(data,'key'),false);assert.equal(Object.hasOwn(data,'apiKey'),false);
  const wardrobe=await request('/api/wardrobe');assert.equal(wardrobe.status,200);assert.equal(JSON.parse(wardrobe.text).items.length,24);
});

test('weather catalog is public cacheable data, while invalid cities fail without network requests',async()=>{
  const catalog=await request('/api/weather?catalog=1');
  assert.equal(catalog.status,200);assert.equal(JSON.parse(catalog.text).cities.length,15);assert.match(catalog.headers['cache-control'],/public/);
  const invalid=await request('/api/weather?city=unknown-city&day=today&period=commute');
  assert.equal(invalid.status,400);assert.equal(JSON.parse(invalid.text).code,'weather_input_city');assert.equal(invalid.headers['cache-control'],'no-store');
  const method=await request('/api/weather?catalog=1',{method:'POST',body:{}});assert.equal(method.status,405);
});

test('rule HTTP endpoint returns three validated outfits with JSON security headers',async()=>{
  const response=await request('/api/outfit',{method:'POST',body:{query:'18度通勤，不穿裙子',version:'rule'}});
  assert.equal(response.status,200);const result=JSON.parse(response.text);assert.equal(result.mode,'rule');assert.equal(result.outfits.length,3);
  assert.equal(response.headers['x-content-type-options'],'nosniff');assert.match(response.headers['content-security-policy'],/script-src 'self'/);
  assert.ok(!response.headers['content-security-policy'].includes("script-src 'self' 'unsafe-inline'"));assert.equal(response.headers['cache-control'],'no-store');
});

test('JSON parsing and content type failures have explicit status codes',async()=>{
  const malformed=await request('/api/outfit',{method:'POST',raw:'{"query":'});assert.equal(malformed.status,400);assert.ok(JSON.parse(malformed.text).error);
  const wrongType=await request('/api/outfit',{method:'POST',headers:{'content-type':'text/plain'},raw:'{}'});assert.equal(wrongType.status,415);
  const oversized=await request('/api/outfit',{method:'POST',headers:{'content-length':'160001'},raw:'{}'});assert.equal(oversized.status,413);
  const streamed=await request('/api/outfit',{method:'POST',raw:JSON.stringify({query:'x'.repeat(160001),version:'rule'})});assert.equal(streamed.status,413);
});

test('HTTP methods are enforced for APIs and static files',async()=>{
  const outfit=await request('/api/outfit');assert.equal(outfit.status,405);assert.equal(outfit.headers.allow,'POST');
  const health=await request('/api/health',{method:'POST',body:{}});assert.equal(health.status,405);assert.equal(health.headers.allow,'GET');
  const page=await request('/',{method:'POST',body:{}});assert.equal(page.status,405);
});

test('cross-origin or malformed-origin outfit requests are rejected',async()=>{
  const body={query:'通勤',version:'rule'};
  const foreign=await request('/api/outfit',{method:'POST',headers:{origin:'https://attacker.invalid'},body});assert.equal(foreign.status,403);
  const invalid=await request('/api/outfit',{method:'POST',headers:{origin:'not a URL'},body});assert.equal(invalid.status,403);
  const same=await request('/api/outfit',{method:'POST',headers:{origin:'http://localhost:5173'},body});assert.equal(same.status,200);
});

test('invalid service data becomes 400 at the HTTP boundary',async()=>{
  for(const body of [{query:'通勤',version:'rule',wardrobe:[DATA.items[0],DATA.items[0]]},{query:'x'.repeat(2001),version:'rule'},{query:'通勤',version:'rule',wardrobe:Array.from({length:41},(_,i)=>({...DATA.items[0],id:`X${i}`}))}]){
    const response=await request('/api/outfit',{method:'POST',body});assert.equal(response.status,400);assert.ok(JSON.parse(response.text).error);
  }
});

test('untrusted wardrobe text is JSON data, never an HTML response',async()=>{
  const name='<img src=x onerror=alert(1)>';
  const wardrobe=DATA.items.map(x=>x.id==='T01'?{...x,name}:x);
  const response=await request('/api/outfit',{method:'POST',body:{query:'通勤',version:'rule',wardrobe,requiredIds:['T01']}});
  assert.equal(response.status,200);assert.match(response.headers['content-type'],/^application\/json/);assert.equal(response.headers['x-content-type-options'],'nosniff');
  const data=JSON.parse(response.text);assert.equal(data.outfits[0].items.find(x=>x.id==='T01').name,name);
});

test('private configuration, source, data and logs are not static resources',async()=>{
  for(const url of ['/.env','/.env.example','/lib/core.js','/lib/config.js','/data/wardrobe.json','/logs/requests.jsonl','/CONTRACT.md','/package.json','/..%2flib/core.js','/docs/..%2f.env','/docs/resume-draft.md','/%2eenv']){
    const response=await request(url);assert.equal(response.status,404,url);assert.ok(!response.text.includes('MODEL_API_KEY='),url);
  }
});

test('public product and case pages are served, with safe HEAD behavior',async()=>{
  const page=await request('/');assert.equal(page.status,200);assert.match(page.headers['content-type'],/^text\/html/);assert.ok(page.text.includes('今天，想怎么穿'));
  const detail=await request('/case-study.html');assert.equal(detail.status,200);assert.ok(detail.text.includes('评测'));
  const head=await request('/styles.css',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.text,'');assert.match(head.headers['content-type'],/^text\/css/);
});

test('unknown API and invalid encoded paths are explicit errors',async()=>{
  const unknown=await request('/api/not-found');assert.equal(unknown.status,404);
  const bad=await request('/%E0%A4%A');assert.equal(bad.status,400);
});
