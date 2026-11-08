'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const source=fs.readFileSync(path.join(root,'public/app.js'),'utf8').replace(/\ninit\(\);\s*$/,'');
const item={id:'T01',name:'测试衬衫',category:'top',subtype:'shirt',color:'白色',colorHex:'#ffffff'};
const snapshot=(city='shanghai')=>({status:'ok',city:{id:city,name:city==='shanghai'?'上海':'北京'},date:'2026-11-08',timezone:'Asia/Shanghai',retrievedAt:'2026-11-08T04:00:00Z',expiresAt:'2026-11-08T05:00:00Z',cacheStatus:'hit',period:'commute',periodLabel:'早晚通勤',remainingHours:false,source:{name:'天气来源',url:'https://example.invalid/weather'},summary:{minTemperature:10,maxTemperature:14,minApparent:8,maxApparent:12,maxPrecipitationProbability:60,maxWindSpeed:20},hours:[]});
const response=value=>({ok:true,status:200,json:async()=>value});
const result=(payload,weather=snapshot())=>({status:'ok',mode:payload.version,request:{scene:'commute',temperature:payload.overrides.temperature??10,requiredIds:payload.previous?.requiredIds||[],excludedIds:[],excludedColors:payload.previous?.excludedColors||[]},outfits:[],weather:payload.weather?weather:undefined,weatherInfluence:{temperatureSource:payload.overrides.temperature!==undefined?'manual':payload.weather?'weather':'none',effectiveTemperature:payload.overrides.temperature??10},trace:[{step:'filter',label:'检查衣橱',detail:'已完成条件检查'}],meta:{modelCalls:payload.version==='rule'?0:1}});
function harness(fetcher,stored={}){
  const nodes=new Map();
  function node(id){if(nodes.has(id))return nodes.get(id);const handlers={};const n={id,value:'',checked:false,disabled:false,hidden:false,textContent:'',options:[],dataset:{},classList:{toggle(){}},addEventListener(type,fn){(handlers[type]??=[]).push(fn);},setAttribute(){},focus(){},querySelector(){return null;},trigger(type,event={}){return Promise.all((handlers[type]||[]).map(fn=>fn({preventDefault(){},...event})));}};let markup='';Object.defineProperty(n,'innerHTML',{get:()=>markup,set:value=>{markup=value;if(['weather-city','weather-day','weather-period'].includes(id)){n.options=[...value.matchAll(/<option value="([^"]+)"/g)].map(x=>({value:x[1]}));}}});nodes.set(id,n);return n;}
  for(const match of html.matchAll(/id="([^"]+)"/g))node(match[1]);
  node('query').value='通勤，不穿裙子。';node('weather-enabled').checked=true;node('weather-city').value='shanghai';node('weather-city').options=[{value:'shanghai'}];node('weather-day').value='today';node('weather-day').options=[{value:'today'},{value:'tomorrow'}];node('weather-period').value='commute';node('weather-period').options=[{value:'commute'}];
  const versions=['rule','weather','hybrid','direct'].map(value=>({...node(`radio-${value}`),value}));
  const document={getElementById:node,querySelectorAll(selector){if(selector==='input[name="version"]'||selector==='input[name=version]')return versions;if(selector.includes(','))return [...new Set([...selector.matchAll(/#([a-z-]+)/g)].map(x=>node(x[1])))];return [];}};
  let saved=JSON.stringify(stored);const calls=[];
  const context=vm.createContext({document,localStorage:{getItem:()=>saved,setItem:(_key,value)=>{saved=value;}},fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);},Intl,Date,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,structuredClone,Blob,confirm:()=>true});
  vm.runInContext(`${source}\nthis.api={state,init,generate,loadWeather,renderWeather,renderResults,renderTrace,invalidateResult,clearWeatherTemperature};`,context);
  return {...context.api,node,calls,saved:()=>JSON.parse(saved)};
}
function defaultFetcher(url,options){if(url==='/api/wardrobe')return response({items:[item],version:'test'});if(url==='/api/health')return response({modelConfigured:true});if(url.includes('catalog=1'))return response({cities:[{id:'shanghai',name:'上海'},{id:'beijing',name:'北京'}],periods:[{id:'commute',name:'早晚通勤'},{id:'daytime',name:'白天'}]});if(url.startsWith('/api/weather?'))return response(snapshot(new URL(url,'http://local').searchParams.get('city')));return response(result(JSON.parse(options.body)));}
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};

test('page initialization queries real weather once and automatically requests only the rule version',async()=>{
  const h=harness(defaultFetcher);await h.init();
  const outfits=h.calls.filter(x=>x.url==='/api/outfit').map(x=>JSON.parse(x.options.body));
  assert.equal(outfits.length,1);assert.equal(outfits[0].version,'rule');assert.equal(outfits[0].weather.city,'shanghai');assert.equal(outfits[0].overrides.temperature,undefined);
  assert.equal(h.calls.filter(x=>x.url.startsWith('/api/weather?')&&!x.url.includes('catalog=1')).length,1);
  assert.match(h.node('weather-card').innerHTML,/该时段预报/);assert.doesNotMatch(h.node('weather-card').innerHTML,/接下来/);assert.match(h.node('trace-meta').textContent,/0 次/);
});

test('AI requires an explicit action, manual temperature is sent, and weather-off omits the weather tool input',async()=>{
  const h=harness(defaultFetcher);h.state.items=[item];h.node('temperature').value='12';
  await h.node('weather-ai-button').trigger('click');
  let payload=JSON.parse(h.calls.at(-1).options.body);assert.equal(payload.version,'weather');assert.equal(payload.overrides.temperature,12);assert.match(h.node('weather-override').textContent,/优先于天气/);
  h.node('weather-enabled').checked=false;await h.generate({version:'weather'});payload=JSON.parse(h.calls.at(-1).options.body);
  assert.equal(payload.version,'weather');assert.equal('weather' in payload,false);assert.equal(h.node('weather-ai-label').textContent,'生成 AI 建议');
});

test('city changes keep hard constraints, clear the previous weather temperature, persist selection, and never auto-call AI',async()=>{
  const h=harness(defaultFetcher);h.state.items=[item];h.state.previous={temperature:10,requiredIds:['T01'],excludedColors:['黑']};h.state.required.add('T01');h.state.weatherTemperature=true;h.state.version='weather';h.node('weather-city').value='beijing';
  await h.node('weather-city').trigger('change');await flush();
  const posts=h.calls.filter(x=>x.url==='/api/outfit');assert.equal(posts.length,1);const payload=JSON.parse(posts[0].options.body);
  assert.equal(payload.version,'rule');assert.equal(payload.previous.temperature,null);assert.deepEqual(payload.previous.requiredIds,['T01']);assert.deepEqual(payload.previous.excludedColors,['黑']);assert.equal(payload.weather.city,'beijing');assert.equal(h.saved().weather.city,'beijing');
});

test('removing a weather temperature disables automatic temperature and other chip changes never resubmit it as manual',async()=>{
  const h=harness(defaultFetcher);h.state.items=[item];h.state.previous={temperature:10,temperatureSource:'weather',weatherTemperatureDisabled:false,requiredIds:['T01'],excludedColors:['黑']};
  await h.node('condition-tags').trigger('click',{target:{closest:()=>({dataset:{key:'excludedColors',value:'黑'}})}});await flush();
  let payload=JSON.parse(h.calls.filter(x=>x.url==='/api/outfit').at(-1).options.body);
  assert.equal('temperature' in payload.overrides,false);assert.equal(payload.previous.temperature,10);assert.deepEqual(payload.previous.requiredIds,['T01']);
  h.state.previous={...h.state.previous,temperature:10,temperatureSource:'weather',weatherTemperatureDisabled:false};
  await h.node('condition-tags').trigger('click',{target:{closest:()=>({dataset:{key:'temperature',value:''}})}});await flush();
  payload=JSON.parse(h.calls.filter(x=>x.url==='/api/outfit').at(-1).options.body);
  assert.match(payload.query,/气温不限/);assert.equal('temperature' in payload.overrides,false);assert.equal(payload.previous.temperature,null);assert.equal(payload.previous.weatherTemperatureDisabled,true);assert.equal(payload.version,'rule');
  const initial=html.match(/<textarea[^>]*>([^<]*)<\/textarea>/)[1];assert.doesNotMatch(initial,/今天|明天|℃|度/);
});

test('out-of-order weather responses cannot overwrite a newer city snapshot',async()=>{
  const pending=[];const h=harness(()=>new Promise(resolve=>pending.push(resolve)));
  const first=h.loadWeather();h.node('weather-city').value='beijing';h.invalidateResult();const second=h.loadWeather();
  pending[1](response(snapshot('beijing')));await second;pending[0](response(snapshot('shanghai')));await first;
  assert.equal(h.state.weatherSnapshot.city.id,'beijing');assert.match(h.node('weather-card').innerHTML,/北京/);assert.equal(h.state.weatherLoading,false);
});

test('failed weather keeps the manual entry usable and returned advice and tool details are escaped',async()=>{
  const h=harness(()=>({ok:false,status:503,json:async()=>({error:'天气暂不可用',code:'upstream_error'})}));await h.loadWeather();
  assert.equal(h.node('temperature').disabled,false);assert.equal(h.state.weatherSnapshot,null);assert.match(h.node('weather-card').innerHTML,/手动填写气温/);assert.doesNotMatch(h.node('weather-card').innerHTML,/上海|60%/);
  h.renderResults({outfits:[{items:[item],weatherReason:'<script>bad</script>',aiAdvice:'<img onerror=bad>'}]});h.renderTrace({trace:[{label:'<script>',detail:'<img>'}],meta:{modelCalls:1}});
  assert.doesNotMatch(h.node('results').innerHTML,/<script>|<img/);assert.match(h.node('results').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.node('trace-steps').innerHTML,/<script>|<img/);
});
