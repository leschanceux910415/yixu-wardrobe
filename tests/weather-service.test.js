'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {handleOutfit,DATA,InputError}=require('../lib/service');
const {verifiedAdvice}=require('../lib/weather-advice');
const config={configured:true,model:'mock-only',publicDeployment:false,sharedLimitConfigured:false,logging:false,inputPrice:null,outputPrice:null};
const snapshot={status:'ok',city:{id:'shanghai',name:'上海'},date:'2026-11-08',timezone:'Asia/Shanghai',period:'commute',periodLabel:'早晚通勤',retrievedAt:'2026-11-08T00:00:00.000Z',expiresAt:'2026-11-08T00:30:00.000Z',cacheStatus:'fresh',remainingHours:true,source:{name:'Open-Meteo',url:'https://open-meteo.com/'},summary:{minTemperature:12,maxTemperature:21,minApparent:10,maxApparent:20,maxPrecipitationProbability:70,maxWindSpeed:22},hours:[]};
const selection={city:'shanghai',day:'today',period:'commute'};
const options={config,weatherProvider:async()=>structuredClone(snapshot)};
const noModel=new Proxy({}, {get(){throw Error('Automatic rule flow must never invoke a model');}});

test('automatic weather rule uses fetched temperature with zero model calls and preserves bans',async()=>{
  const r=await handleOutfit({query:'今天通勤，怕冷，不穿裙子',weather:selection,version:'rule'},{},{...options,providers:noModel});
  assert.equal(r.mode,'rule');assert.equal(r.meta.modelCalls,0);assert.equal(r.weatherInfluence.temperatureSource,'weather');assert.equal(r.request.temperature,10);
  assert.equal(r.status,'ok');assert.ok(r.outfits.every(x=>x.items.find(i=>i.category==='bottom').subtype==='trousers'));
  assert.ok(r.outfits[0].weatherReason.includes('上海'));assert.equal(r.trace[0].step,'weather');
});
test('weather mode makes exactly one ranking call and displays only supported model advice',async()=>{
  let calls=0;
  const r=await handleOutfit({query:'通勤，怕冷，不穿裙子',weather:selection,version:'weather'},{},{...options,providers:{rankWeatherWithModel:async(_c,request,candidates,w)=>{
    calls++;assert.equal(request.temperatureSource,'weather');assert.equal(w.summary.maxPrecipitationProbability,70);
    return {selection:[candidates[0].id],advice:[{outfitId:candidates[0].id,codes:['rain','invented_waterproof','warmth']}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
  }}});
  assert.equal(calls,1);assert.equal(r.meta.modelCalls,1);assert.equal(r.mode,'weather');assert.deepEqual(r.meta.modelStages,{parse:false,rank:true,direct:false});
  assert.ok(r.outfits[0].aiAdvice.includes('70%'));assert.ok(r.outfits[0].aiAdvice.includes('不能保证'));assert.ok(!r.outfits[0].aiAdvice.includes('invented_waterproof'));
});
test('manual temperature wins over forecast and carries across city changes',async()=>{
  const first=await handleOutfit({query:'8度通勤，不要红色',weather:selection,version:'rule'},{},options);
  const second=await handleOutfit({query:'晚上约会',previous:first.request,weather:{...selection,city:'beijing'},version:'rule'},{},{...options,weatherProvider:async()=>({...snapshot,city:{id:'beijing',name:'北京'},summary:{...snapshot.summary,minApparent:-2}})});
  assert.equal(second.request.temperature,8);assert.equal(second.weatherInfluence.temperatureSource,'manual');assert.deepEqual(second.request.excludedColors,['红']);
});
test('old forecast is never inherited as manual temperature when city changes or weather fails',async()=>{
  const first=await handleOutfit({query:'通勤，不穿裙子',weather:selection,version:'rule'},{},options);
  const second=await handleOutfit({query:'约会',previous:first.request,weather:{...selection,city:'beijing'},version:'rule'},{},{...options,weatherProvider:async()=>({...snapshot,city:{id:'beijing',name:'北京'},summary:{...snapshot.summary,minApparent:-2}})});
  assert.equal(second.request.temperature,-2);assert.equal(second.request.bottomType,'trousers');
  const failed=await handleOutfit({query:'继续',previous:second.request,weather:selection,version:'rule'},{},{...options,weatherProvider:async()=>{throw Error('timeout');}});
  assert.equal(failed.weather.status,'unavailable');assert.equal(failed.request.temperature,null);assert.equal(failed.weatherInfluence.temperatureSource,'none');
  assert.ok(!failed.outfits[0].weatherReason.includes('晴'));assert.equal(failed.meta.modelCalls,0);
});
test('turning weather off drops old automatic temperature but keeps explicit exclusions',async()=>{
  const r=await handleOutfit({query:'继续',previous:{temperature:12,temperatureSource:'weather',excludedColors:['红']},version:'rule'},{},{config,providers:noModel});
  assert.equal(r.weather,null);assert.equal(r.request.temperature,null);assert.deepEqual(r.request.excludedColors,['红']);
});
test('ignore temperature remains effective on the next weather turn until manual reset',async()=>{
  const a=await handleOutfit({query:'不考虑温度，通勤',weather:selection,version:'rule'},{},options);
  const b=await handleOutfit({query:'改为约会',previous:a.request,weather:selection,version:'rule'},{},options);
  assert.equal(a.request.temperature,null);assert.equal(b.request.temperature,null);
  const c=await handleOutfit({query:'继续',previous:b.request,weather:selection,overrides:{temperature:16},version:'rule'},{},options);
  assert.equal(c.request.temperature,16);assert.equal(c.weatherInfluence.temperatureSource,'manual');
});
test('rain context can be used but unrecorded waterproof requirement still requires clarification',async()=>{
  const rain=await handleOutfit({query:'雨天通勤',weather:selection,version:'rule'},{},options);
  assert.equal(rain.status,'ok');
  const waterproof=await handleOutfit({query:'雨天必须防水',weather:selection,version:'weather'},{},{...options,providers:noModel});
  assert.equal(waterproof.status,'clarify');assert.equal(waterproof.meta.modelCalls,0);assert.equal(waterproof.mode,'rule');
});
test('missing wardrobe and invalid model candidate never become fake successful AI results',async()=>{
  const missing=await handleOutfit({query:'通勤',wardrobe:[],weather:selection,version:'weather'},{},{...options,providers:noModel});
  assert.equal(missing.status,'conflict');assert.equal(missing.meta.modelCalls,0);
  const bad=await handleOutfit({query:'通勤',weather:selection,version:'weather'},{},{...options,providers:{rankWeatherWithModel:async()=>({selection:['MADE_UP'],advice:[]})}});
  assert.equal(bad.mode,'rule');assert.equal(bad.fallback.code,'invalid_selection');assert.equal(bad.weather.status,'ok');assert.ok(bad.outfits.every(x=>x.pass));
});
test('unavailable model uses fetched weather in explicit rule fallback without model invocation',async()=>{
  const r=await handleOutfit({query:'通勤',weather:selection,version:'weather'},{},{...options,config:{...config,configured:false},providers:noModel});
  assert.equal(r.mode,'rule');assert.equal(r.fallback.code,'not_configured');assert.equal(r.meta.modelCalls,0);assert.equal(r.request.temperature,10);
});
test('unrecognized weather city is an input error and client cannot supply weather facts',async()=>{
  await assert.rejects(()=>handleOutfit({query:'通勤',weather:{city:'not-a-city'}},{},options),InputError);
  const r=await handleOutfit({query:'通勤',weather:{...selection,summary:{minApparent:45}},version:'rule'},{},options);
  assert.equal(r.request.temperature,10);
});
test('advice cannot invent rain, wind, layers or warmth preference from codes',()=>{
  const outfit={items:DATA.items.filter(x=>['T01','B01','S01'].includes(x.id))};
  const text=verifiedAdvice(outfit,['rain','wind','layering','warmth'],{...snapshot,summary:{...snapshot.summary,maxPrecipitationProbability:0,maxWindSpeed:3}},{preferences:[]});
  assert.equal(text,'');
});
test('enabling weather resolves only the obsolete weather-off question and retains material uncertainty',async()=>{
  const off=await handleOutfit({query:'雨天通勤',version:'rule'},{},{config});
  assert.equal(off.status,'clarify');
  const on=await handleOutfit({query:'继续',previous:off.request,weather:selection,version:'rule'},{},options);
  assert.equal(on.status,'ok');
  const unsupported=await handleOutfit({query:'继续',previous:{...off.request,clarifications:[...off.request.clarifications,'羊毛材质尚未确认']},weather:selection,version:'rule'},{},options);
  assert.equal(unsupported.status,'clarify');assert.deepEqual(unsupported.request.clarifications,['羊毛材质尚未确认']);
});
