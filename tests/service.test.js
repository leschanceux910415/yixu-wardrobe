'use strict';
// All model providers in this file are in-process test doubles. No HTTP model
// request is performed, and no local .env credentials are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const {handleOutfit, validateWardrobe, InputError, DATA} = require('../lib/service');
const {ModelError} = require('../lib/llm');
const items = DATA.items;
const baseConfig = Object.freeze({configured:false,key:'',baseUrl:'',model:'test-model-only',publicDeployment:false,sharedLimitConfigured:false,logging:false,inputPrice:null,outputPrice:null});
const mockConfig = Object.freeze({...baseConfig,configured:true,key:'fake-key-for-tests',baseUrl:'https://model.invalid'});
const usage = {prompt_tokens:10,completion_tokens:5,total_tokens:15};
const parsedRequest = extra => ({scene:'commute',temperature:18,requiredIds:[],excludedIds:[],excludedColors:[],bottomType:'any',avoidRecent:false,preferences:[],clarifications:[],...extra});
function providers(overrides={}) {
  return {
    parseWithModel:async()=>({value:parsedRequest(),usage}),
    rerankWithModel:async(_config,_request,candidates)=>({selection:[candidates[0].id],explanations:[],usage}),
    directWithModel:async()=>{throw new Error('Unexpected direct test call');},
    ...overrides
  };
}
const rule = body => handleOutfit({query:'18度通勤',version:'rule',...body},{},{config:baseConfig});

test('rule API returns real candidates and never invokes configured model providers',async()=>{
  let calls=0;
  const blocked=new Proxy({}, {get(){calls++;throw Error('Model provider must not be used by rule version');}});
  const result=await handleOutfit({query:'18度通勤，不穿裙子',version:'rule'},{},{config:mockConfig,providers:blocked});
  assert.equal(calls,0);assert.equal(result.mode,'rule');assert.equal(result.model,null);assert.equal(result.fallback,null);
  assert.equal(result.status,'ok');assert.equal(result.outfits.length,3);
  assert.ok(result.outfits.every(x=>x.items.some(i=>i.category==='bottom'&&i.subtype==='trousers')));
  assert.ok(result.meta.requestId);assert.ok(result.meta.elapsedMs>=0);
});

test('unconfigured hybrid explicitly falls back without invoking any provider',async()=>{
  const blocked=new Proxy({}, {get(){throw Error('No model is configured');}});
  const result=await handleOutfit({query:'18度通勤',version:'hybrid'},{},{config:baseConfig,providers:blocked});
  assert.equal(result.requestedVersion,'hybrid');assert.equal(result.mode,'rule');assert.equal(result.model,null);
  assert.equal(result.fallback.code,'not_configured');assert.deepEqual(result.meta.modelStages,{parse:false,rank:false,direct:false});
});

test('public deployment cannot call a model before shared quotas are configured',async()=>{
  const result=await handleOutfit({query:'通勤',version:'hybrid'},{},{config:{...mockConfig,publicDeployment:true},providers:new Proxy({}, {get(){throw Error('must not call');}})});
  assert.equal(result.mode,'rule');assert.equal(result.fallback.code,'public_limit_required');
});

test('wardrobe validation rejects duplicate, malformed, and oversized IDs or item lists',()=>{
  assert.throws(()=>validateWardrobe([items[0],items[0]]),InputError);
  assert.throws(()=>validateWardrobe([{...items[0],id:'../secret'}]),InputError);
  assert.throws(()=>validateWardrobe(Array.from({length:41},(_,i)=>({...items[0],id:`X${i}`}))),InputError);
  assert.throws(()=>validateWardrobe({items}),InputError);
  assert.throws(()=>validateWardrobe([{...items[0],category:'top',subtype:'boots'}]),InputError);
  assert.throws(()=>validateWardrobe([{...items[0],warmth:99}]),InputError);
});

test('empty wardrobe is a real missing-items conflict rather than a fabricated result',async()=>{
  const result=await rule({wardrobe:[]});
  assert.equal(result.status,'conflict');assert.equal(result.outfits.length,0);assert.equal(result.stats.feasibleCombinations,0);
  assert.ok(result.diagnosis?.message);
});

test('unknown required ID is surfaced as conflict and never synthesized',async()=>{
  const result=await rule({requiredIds:['NOT_PRESENT']});
  assert.equal(result.status,'conflict');assert.equal(result.outfits.length,0);
  assert.ok(result.request.requiredIds.includes('NOT_PRESENT'));
});

test('invalid payload shapes, overlong query and invalid override arrays fail at service boundary',async()=>{
  for(const body of [null,[],{query:42},{query:'x'.repeat(2001)},{query:'通勤',version:'fake'},{query:'通勤',previous:[]},{query:'通勤',overrides:[]},{query:'通勤',requiredIds:'T01'},{query:'通勤',overrides:{excludedColors:[null]}}]) {
    await assert.rejects(()=>handleOutfit(body,{},{config:baseConfig}),InputError);
  }
});

test('manual overrides replace a parsed lock while explicit exclusions stay enforced',async()=>{
  const result=await rule({query:'18度通勤，保留白衬衫，不穿裙子，不要红色',overrides:{requiredIds:['T02'],excludedColors:['黑']},excludeIds:['S01']});
  assert.equal(result.status,'ok');assert.deepEqual(result.request.requiredIds,['T02']);assert.deepEqual(result.request.excludedColors,['黑']);
  for(const outfit of result.outfits){assert.ok(outfit.itemIds.includes('T02'));assert.ok(!outfit.itemIds.includes('S01'));assert.ok(outfit.items.every(x=>!x.color.includes('黑')));assert.equal(outfit.items.find(x=>x.category==='bottom').subtype,'trousers');}
});

test('multi-turn service request preserves bans, locks and temperature',async()=>{
  const first=await rule({query:'15度通勤，不要白色，保留灰色西裤'});
  const second=await rule({query:'改为约会',previous:first.request});
  assert.equal(second.request.scene,'date');assert.equal(second.request.temperature,15);
  assert.deepEqual(second.request.excludedColors,['白']);assert.deepEqual(second.request.requiredIds,['B01']);
  assert.ok(second.outfits.every(x=>x.itemIds.includes('B01')&&x.items.every(i=>!i.color.includes('白'))));
});

test('untrusted names are preserved as JSON data with no generated executable field',async()=>{
  const payload='<img src=x onerror=alert(1)>';
  const wardrobe=items.map(x=>x.id==='T01'?{...x,name:payload}:x);
  const result=await rule({wardrobe,requiredIds:['T01']});
  assert.equal(result.status,'ok');assert.equal(result.outfits[0].items.find(x=>x.id==='T01').name,payload);
  const copy=JSON.parse(JSON.stringify(result));assert.equal(copy.outfits[0].items.find(x=>x.id==='T01').name,payload);
  assert.equal(Object.hasOwn(copy,'html'),false);assert.equal(Object.hasOwn(copy,'script'),false);
});

test('successful injected hybrid records both stages and nonzero test usage',async()=>{
  const result=await handleOutfit({query:'18度通勤',version:'hybrid'},{},{config:mockConfig,providers:providers()});
  assert.equal(result.mode,'hybrid');assert.equal(result.model,'test-model-only');assert.equal(result.fallback,null);
  assert.deepEqual(result.meta.modelStages,{parse:true,rank:true,direct:false});assert.equal(result.meta.usage.total_tokens,30);
  assert.ok(result.outfits.every(x=>x.pickedBy==='model'&&x.pass));
});

test('model parsing cannot erase explicit baseline locks, bans or bottom type',async()=>{
  const result=await handleOutfit({query:'18度通勤，保留白衬衫，不要红色，不穿裙子',version:'hybrid'},{},{config:mockConfig,providers:providers({parseWithModel:async()=>({value:parsedRequest({bottomType:'skirt'}),usage})})});
  assert.equal(result.status,'ok');assert.equal(result.mode,'hybrid');assert.deepEqual(result.request.requiredIds,['T01']);assert.deepEqual(result.request.excludedColors,['红']);assert.equal(result.request.bottomType,'trousers');
  assert.ok(result.outfits.every(x=>x.itemIds.includes('T01')&&x.items.every(i=>!i.color.includes('红'))&&x.items.find(i=>i.category==='bottom').subtype==='trousers'));
});

test('invalid selected candidate falls back to a full rule result',async()=>{
  const result=await handleOutfit({query:'18度通勤',version:'hybrid'},{},{config:mockConfig,providers:providers({rerankWithModel:async()=>({selection:['NONEXISTENT'],explanations:[],usage})})});
  assert.equal(result.mode,'rule');assert.equal(result.model,null);assert.equal(result.fallback.code,'invalid_selection');
  assert.ok(result.outfits.every(x=>x.itemIds.every(id=>items.some(i=>i.id===id))));
});

test('a partial model success is never reported as completed hybrid',async()=>{
  const result=await handleOutfit({query:'18度通勤，不要白色',version:'hybrid'},{},{config:mockConfig,providers:providers({parseWithModel:async()=>({value:parsedRequest({scene:'sport'}),usage}),rerankWithModel:async()=>{throw new ModelError('timeout','测试超时');}})});
  assert.equal(result.mode,'rule');assert.equal(result.model,null);assert.equal(result.fallback.code,'timeout');
  assert.deepEqual(result.meta.modelStages,{parse:true,rank:false,direct:false});assert.equal(result.request.scene,'commute');
  assert.deepEqual(result.request.excludedColors,['白']);assert.equal(result.meta.usage.total_tokens,15);
});

test('model parse failure returns rule output and no false successful stage',async()=>{
  const result=await handleOutfit({query:'通勤',version:'hybrid'},{},{config:mockConfig,providers:providers({parseWithModel:async()=>{throw new ModelError('invalid_json','测试格式错误');}})});
  assert.equal(result.mode,'rule');assert.equal(result.fallback.code,'invalid_json');assert.deepEqual(result.meta.modelStages,{parse:false,rank:false,direct:false});
});

test('direct model unknown or duplicate item IDs fail deterministic validation',async()=>{
  for(const ids of [['NOT_PRESENT','B01','S01'],['T01','T01','B01','S01']]){
    const result=await handleOutfit({query:'通勤',version:'direct'},{},{config:mockConfig,providers:providers({directWithModel:async()=>({value:{outfits:[{itemIds:ids,reason:'test-only draft'}]},usage})})});
    assert.equal(result.mode,'rule');assert.equal(result.fallback.code,'constraint_violation');assert.ok(result.outfits.every(x=>x.pass));
  }
});

test('direct model false no-result is tracked rather than passed off as a true conflict',async()=>{
  const result=await handleOutfit({query:'通勤',version:'direct'},{},{config:mockConfig,providers:providers({directWithModel:async()=>({value:{outfits:[]},usage})})});
  assert.equal(result.mode,'rule');assert.equal(result.status,'ok');assert.equal(result.fallback.code,'false_conflict');
});

test('model defaults cannot erase unchanged scene and temperature',async()=>{
  const result=await handleOutfit({query:'不要白色',previous:{scene:'formal',temperature:12},version:'hybrid'},{},{config:mockConfig,providers:providers({parseWithModel:async()=>({value:parsedRequest({scene:'commute',temperature:null}),usage})})});
  assert.equal(result.mode,'hybrid');assert.equal(result.request.scene,'formal');assert.equal(result.request.temperature,12);
  assert.deepEqual(result.request.excludedColors,['白']);
});

test('reset passes empty context to model and cannot resurrect ungrounded prior constraints',async()=>{
  let received;
  const result=await handleOutfit({query:'清空条件，周末',previous:{scene:'formal',temperature:12,requiredIds:['O01'],excludedColors:['白'],bottomType:'trousers'},version:'hybrid'},{},{config:mockConfig,providers:providers({parseWithModel:async(_c,_q,_i,p)=>{received=p;return {value:parsedRequest({requiredIds:['O01'],excludedColors:['白'],bottomType:'trousers'}),usage};}})});
  assert.deepEqual(received,{});assert.equal(result.request.scene,'casual');assert.equal(result.request.temperature,null);
  assert.deepEqual(result.request.requiredIds,[]);assert.deepEqual(result.request.excludedColors,[]);assert.equal(result.request.bottomType,'any');
});

test('model semantic update requires an exact current-query evidence span',async()=>{
  const q='明天参加毕业典礼';
  const result=await handleOutfit({query:q,previous:{scene:'casual',temperature:20},version:'hybrid'},{},{config:mockConfig,providers:providers({parseWithModel:async()=>({value:parsedRequest({scene:'formal',evidence:{scene:'参加毕业典礼'}}),usage})})});
  assert.equal(result.request.scene,'formal');assert.equal(result.request.temperature,20);
});

test('invalid manual enum overrides are rejected rather than silently relaxed',async()=>{
  for(const overrides of [{scene:'nonsense'},{bottomType:'nonsense'},{avoidRecent:'true'},{temperature:Infinity},{temperature:'18'}]) await assert.rejects(()=>rule({overrides}),InputError);
});

test('hybrid parser cannot replace a missing-bottom conflict with a blocking wardrobe question (D25)',async()=>{
  const wardrobe=items.filter(x=>['T01','S01'].includes(x.id));
  const result=await handleOutfit({query:'帮我搭配',wardrobe,version:'hybrid'},{},{config:mockConfig,providers:providers({
    parseWithModel:async()=>({value:parsedRequest({temperature:null,clarifications:['衣橱中暂无下装，请补充裤子或裙子。'],evidence:{clarifications:'帮我搭配'}}),usage}),
    rerankWithModel:async()=>{throw new Error('A missing wardrobe must never reach reranking');}
  })});
  assert.equal(result.mode,'hybrid');assert.equal(result.fallback,null);assert.equal(result.status,'conflict');assert.equal(result.diagnosis.kind,'missing');
  assert.deepEqual(result.request.clarifications,[]);assert.equal(result.outfits.length,0);assert.deepEqual(result.meta.modelStages,{parse:true,rank:false,direct:false});
});

test('hybrid parser cannot turn an empty wardrobe into unsupported user intent (D27)',async()=>{
  const result=await handleOutfit({query:'帮我搭配',wardrobe:[],version:'hybrid'},{},{config:mockConfig,providers:providers({
    parseWithModel:async()=>({value:parsedRequest({temperature:null,clarifications:['衣橱中暂无衣物，请先添加衣物清单。']}),usage}),
    rerankWithModel:async()=>{throw new Error('An empty wardrobe must never reach reranking');}
  })});
  assert.equal(result.mode,'hybrid');assert.equal(result.fallback,null);assert.equal(result.status,'conflict');assert.equal(result.diagnosis.kind,'missing');
  assert.deepEqual(result.request.clarifications,[]);assert.equal(result.stats.feasibleCombinations,0);assert.equal(result.outfits.length,0);
});

test('hybrid parser cannot upgrade cold/formal soft preferences into a blocking condition (D28)',async()=>{
  const wardrobe=items.filter(x=>['T02','B03','S02'].includes(x.id));
  const result=await handleOutfit({query:'4度，正式场合',wardrobe,version:'hybrid'},{},{config:mockConfig,providers:providers({
    parseWithModel:async()=>({value:parsedRequest({scene:'formal',temperature:4,clarifications:['衣橱中缺少适合4度正式场合的衣物，请补充或确认替代方案。'],evidence:{clarifications:'4度，正式场合'}}),usage})
  })});
  assert.equal(result.mode,'hybrid');assert.equal(result.fallback,null);assert.equal(result.status,'ok');assert.equal(result.request.scene,'formal');assert.equal(result.request.temperature,4);
  assert.deepEqual(result.request.clarifications,[]);assert.equal(result.stats.feasibleCombinations,1);assert.equal(result.outfits.length,1);
  assert.ok(result.outfits[0].pass);assert.ok(result.outfits[0].tradeoffs.length>0);assert.equal(result.meta.modelStages.rank,true);
});

test('genuine unsupported user constraints stay blocking even when the model asks nothing',async()=>{
  const result=await handleOutfit({query:'不要羊毛的衣服',version:'hybrid'},{},{config:mockConfig,providers:providers()});
  assert.equal(result.status,'clarify');assert.equal(result.diagnosis.kind,'unsupported');assert.ok(result.request.clarifications.length>0);assert.equal(result.outfits.length,0);
});

test('a grounded model clarification may refine an independently verified unsupported intent',async()=>{
  const message='衣物未记录羊毛材质，请指定具体要排除的单品。';
  const result=await handleOutfit({query:'不要羊毛的衣服',version:'hybrid'},{},{config:mockConfig,providers:providers({parseWithModel:async()=>({value:parsedRequest({clarifications:[message],evidence:{clarifications:'不要羊毛的衣服'}}),usage})})});
  assert.equal(result.status,'clarify');assert.ok(result.request.clarifications.includes(message));assert.equal(result.diagnosis.kind,'unsupported');
});

test('prior unresolved user intent is preserved without requiring a fresh model quotation',async()=>{
  const previous={clarifications:['尚不能确认这件衣物的材质，请选择具体单品。'],scene:'commute',temperature:18};
  const result=await handleOutfit({query:'改为约会',previous,version:'hybrid'},{},{config:mockConfig,providers:providers()});
  assert.equal(result.status,'clarify');assert.ok(result.request.clarifications.includes(previous.clarifications[0]));assert.equal(result.request.scene,'date');
});
