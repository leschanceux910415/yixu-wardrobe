'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const core = require('./core');
const {getConfig} = require('./config');
const llm = require('./llm');
const weatherTools = require('./weather');
const {weatherReason,verifiedAdvice} = require('./weather-advice');
const DATA = require('../data/wardrobe.json');
const VERSION = '0.2.1';
class InputError extends Error {}
const unique = xs => [...new Set(xs)];
const cleanArray = (value, name) => {
  if (!Array.isArray(value) || value.length > 100 || value.some(x=>typeof x!=='string'||x.length>100)) throw new InputError(`${name}格式无效。`);
  return unique(value);
};
function validateWardrobe(input) {
  if (input === undefined) return DATA.items;
  if (!Array.isArray(input) || input.length>40) throw new InputError('衣橱最多支持40件单品。');
  const ids = new Set();
  const subtypes = {top:['shirt','knit','tee'],bottom:['trousers','skirt'],outer:['coat','blazer'],shoes:['sneakers','loafers','boots'],accessory:['scarf']};
  return input.map(item=>{
    if (!item || typeof item!=='object' || !/^[A-Za-z0-9_-]{1,40}$/.test(item.id) || ids.has(item.id)) throw new InputError('单品ID无效或重复。');
    ids.add(item.id);
    if (typeof item.name!=='string' || !item.name.trim() || item.name.length>40 || typeof item.color!=='string' || item.color.length>12 || !Object.hasOwn(subtypes,item.category) || !subtypes[item.category].includes(item.subtype)) throw new InputError('单品名称、颜色或类别无效。');
    if (![item.warmth,item.formality].every(x=>Number.isInteger(x)&&x>=1&&x<=5) || !['neutral','warm','cool'].includes(item.colorFamily)) throw new InputError('厚薄、正式度或色系属性无效。');
    return {id:item.id,name:item.name.trim(),category:item.category,subtype:item.subtype,color:item.color,colorHex:/^#[0-9a-f]{6}$/i.test(item.colorHex)?item.colorHex:'#d8d4c7',colorFamily:item.colorFamily,warmth:item.warmth,formality:item.formality,tags:Array.isArray(item.tags)?item.tags.filter(x=>typeof x==='string').map(x=>x.slice(0,20)).slice(0,8):[],source:item.source==='示例数据'?'示例数据':'本机手动录入',confirmed:item.confirmed===true};
  });
}
function applyOverrides(request, body, items) {
  const patch = body.overrides || {};
  if (!patch || typeof patch!=='object' || Array.isArray(patch)) throw new InputError('条件覆盖格式无效。');
  const merged = {...request};
  if (Object.hasOwn(patch,'scene') && !Object.hasOwn(core.SCENES,patch.scene)) throw new InputError('场合选项无效。');
  if (Object.hasOwn(patch,'bottomType') && !['any','trousers','skirt'].includes(patch.bottomType)) throw new InputError('下装条件无效。');
  if (Object.hasOwn(patch,'avoidRecent') && typeof patch.avoidRecent!=='boolean') throw new InputError('近期偏好必须为布尔值。');
  if (Object.hasOwn(patch,'temperature') && patch.temperature!==null && (!Number.isFinite(patch.temperature)||patch.temperature < -30||patch.temperature > 50)) throw new InputError('气温必须为-30至50之间的数字或null。');
  for (const key of ['scene','temperature','bottomType','avoidRecent']) if (Object.hasOwn(patch,key)) merged[key]=patch[key];
  for (const key of ['requiredIds','excludedIds','excludedColors','preferences','clarifications']) if (Object.hasOwn(patch,key)) merged[key]=cleanArray(patch[key],key);
  if (Object.hasOwn(body,'recentIds')) merged.recentIds=cleanArray(body.recentIds,'recentIds');
  if (Object.hasOwn(body,'requiredIds')) merged.requiredIds=cleanArray(body.requiredIds,'requiredIds');
  if (Object.hasOwn(body,'excludeIds')) merged.excludedIds=unique([...merged.excludedIds,...cleanArray(body.excludeIds,'excludeIds')]);
  return core.normalizeRequest(merged,items);
}
function mergeModelRequest(rule, model, query, items, context={}) {
  const merged={...rule};
  const evidence=model.evidence&&typeof model.evidence==='object'?model.evidence:{};
  const supportedEvidence=key=>typeof evidence[key]==='string'&&evidence[key].trim().length>0&&query.includes(evidence[key].trim());
  // Model output may add interpretation only when grounded in the current
  // utterance. Missing/default fields must never erase previous-turn state.
  const explicit={
    scene:/通勤|上班|办公室|正式|见客户|商务|面试|休闲|周末|闲逛|运动|健身|跑步|约会/.test(query),
    temperature:/-?\d+\s*(?:℃|°|度)|温度不限|气温不限|清除温度|不考虑温度/.test(query),
    bottomType:/裙|裤|下装不限|清除下装/.test(query),
    avoidRecent:/重复|最近|昨天/.test(query)
  };
  for(const key of ['scene','temperature','bottomType','avoidRecent']) if(supportedEvidence(key)&&!explicit[key]) merged[key]=model[key];
  for(const key of ['requiredIds','excludedIds','excludedColors']) if(supportedEvidence(key)&&Array.isArray(model[key])) merged[key]=unique([...rule[key],...model[key]]);
  if(supportedEvidence('preferences')&&Array.isArray(model.preferences)) merged.preferences=unique([...rule.preferences,...model.preferences]);
  // A parser's unsolicited wardrobe/suitability advice must not turn a known
  // missing-item conflict or a soft quality tradeoff into a blocking question.
  // Preserve existing user-intent clarification, and admit new model questions
  // only when a current-query quotation independently resolves to an actually
  // unsupported/ambiguous intent. Quoting "4度，正式场合" alone is insufficient.
  if(supportedEvidence('clarifications')&&Array.isArray(model.clarifications)) {
    const quotedIntent=core.parseQuery(evidence.clarifications.trim(),items,{},context);
    if(quotedIntent.clarifications.length) merged.clarifications=unique([...rule.clarifications,...model.clarifications.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.slice(0,500))]);
  }
  return core.normalizeRequest(merged,items);
}
function combineUsage(parts,config) {
  if (!parts.length) return null;
  const sum = parts.reduce((a,u)=>({prompt_tokens:a.prompt_tokens+(u?.prompt_tokens||0),completion_tokens:a.completion_tokens+(u?.completion_tokens||0),total_tokens:a.total_tokens+(u?.total_tokens||0)}),{prompt_tokens:0,completion_tokens:0,total_tokens:0});
  sum.estimatedCostRmb = Number.isFinite(config.inputPrice) && config.inputPrice>=0 && Number.isFinite(config.outputPrice) && config.outputPrice>=0 ? (sum.prompt_tokens*config.inputPrice+sum.completion_tokens*config.outputPrice)/1e6 : null;
  return sum;
}
function recordMetrics(config,result) {
  if (!config.logging) return;
  const record = {at:new Date().toISOString(),requestId:result.meta.requestId,requestedVersion:result.requestedVersion,mode:result.mode,status:result.status,elapsedMs:result.meta.elapsedMs,fallback:result.fallback?.code||null,usage:result.meta.usage,modelStages:result.meta.modelStages,modelAttempts:result.meta.modelCalls};
  // Do not persist request text, personal wardrobe names, IP addresses or keys.
  try {const dir=path.join(config.root,'logs');fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,'requests.jsonl'),JSON.stringify(record)+'\n');} catch {}
}
async function handleOutfit(body, context={}, options={}) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new InputError('请提交JSON对象。');
  const query = body.query === undefined ? '' : body.query;
  if (typeof query!=='string' || query.length>2000) throw new InputError('需求最多支持2000字。');
  const requestedVersion=body.version||'rule';
  if (!['rule','hybrid','direct','weather'].includes(requestedVersion)) throw new InputError('搭配方式无效。');
  if (body.previous !== undefined && (!body.previous || typeof body.previous!=='object' || Array.isArray(body.previous))) throw new InputError('上一轮条件格式无效。');
  const items=validateWardrobe(body.wardrobe);
  const config=options.config||getConfig();
  const providers=options.providers||llm;
  const started=performance.now();
  const usage=[],trace=[],modelStages={parse:false,rank:false,direct:false};
  let modelCalls=0,weather=null;
  const effectivePrevious=/重新开始|清空条件|重置条件|全部重置/.test(query)?{}:{...(body.previous||{})};
  if(effectivePrevious.temperatureSource==='weather') effectivePrevious.temperature=null;
  const weatherEnabled=body.weather!==undefined&&body.weather!==null&&body.weather!==false;
  if(weatherEnabled&&Array.isArray(effectivePrevious.clarifications)) effectivePrevious.clarifications=effectivePrevious.clarifications.filter(x=>x!=='请开启自动天气查询，以核对目标城市和时段的降雨、风速；尚不能凭天气文字确认衣物防水防风。');
  let selection;
  if(weatherEnabled) {
    try {selection=weatherTools.normalizeSelection(body.weather,query);}
    catch(error) {throw new InputError(error.message||'天气选项无效。');}
    try {weather=await (options.weatherProvider||weatherTools.getWeather)(selection);}
    catch(error) {weather={status:'unavailable',code:typeof error.code==='string'?error.code:'weather_unavailable',message:'天气服务暂不可用。可填写气温继续搭配，稍后再查询。'};}
    trace.push({step:'weather',label:weather.status==='ok'?'已查询天气':'天气查询暂不可用',detail:weather.status==='ok'?`${weather.city.name} ${weather.date} ${weather.periodLabel} · Open-Meteo · ${weather.cacheStatus==='hit'?'复用缓存':'已更新'}。`:'未编造天气；有手动气温时继续使用，没有则不作天气适配。'});
  }
  let request=applyOverrides(core.parseQuery(query,items,effectivePrevious,{weatherEnabled}),body,items);
  const temperatureMentioned=/-?\d+(?:\.\d+)?\s*(?:℃|°|度|[CcＣｃ](?![a-z]))/.test(query);
  const manualOverride=Object.hasOwn(body.overrides||{},'temperature');
  let weatherTemperatureDisabled=effectivePrevious.weatherTemperatureDisabled===true;
  if(/温度不限|气温不限|清除温度|不考虑温度/.test(query)) weatherTemperatureDisabled=true;
  if(temperatureMentioned||manualOverride) weatherTemperatureDisabled=false;
  let temperatureSource=request.temperature!==null?'manual':'none';
  if(weather?.status==='ok'&&request.temperature===null&&!weatherTemperatureDisabled) {
    const value=weather.summary.minApparent;
    if(Number.isFinite(value)&&value>=-30&&value<=50) {request=core.normalizeRequest({...request,temperature:value},items);temperatureSource='weather';}
    else request.warnings.push('预报体感超出示例厚薄排序范围，本次不自动套用温度偏好。');
  }
  const weatherInfluence={temperatureSource,effectiveTemperature:request.temperature,note:temperatureSource==='weather'?'参考所选时段最低体感温度，厚薄排序仅为相对偏好。':temperatureSource==='manual'?'采用手动气温，自动天气不会覆盖它。':'未按温度调整厚薄偏好。'};
  if(weather?.status==='unavailable') request.warnings.push(weather.message);
  const baselineRequest=request;
  let result=core.solve(items,request),mode='rule',fallback=null,modelDrafts=[];
  trace.push({step:'understand',label:'理解需求',detail:'提取明确限制和软偏好；条件可以由你修正。'});
  if (requestedVersion!=='rule') {
    if (!config.configured) fallback={code:'not_configured',message:'尚未配置模型服务，当前使用规则方案。'};
    else if (config.publicDeployment&&!config.sharedLimitConfigured) fallback={code:'public_limit_required',message:'公开环境模型额度尚未配置，当前使用规则方案。'};
    else try {
      if (requestedVersion==='weather') {
        if(result.status==='ok') {
          modelCalls++;
          const ranked=await providers.rankWeatherWithModel(config,{...request,temperatureSource},result.candidates,weather,{ip:context.ip||'local'});
          if(ranked.usage) usage.push(ranked.usage);
          const ids=ranked.selection;
          if(!Array.isArray(ids)||!ids.length||ids.length>3||new Set(ids).size!==ids.length||!ids.every(id=>result.candidates.some(x=>x.id===id))) throw new llm.ModelError('invalid_selection','模型选择无效，使用规则方案。');
          const selected=ids.map(id=>result.candidates.find(x=>x.id===id));
          if(selected.some(x=>!Object.values(core.checkOutfit(x.itemIds,items,request)).every(Boolean))) throw new llm.ModelError('constraint_violation','模型候选未通过约束检查，使用规则方案。');
          result={...result,outfits:selected.map(outfit=>({...outfit,pickedBy:'model',aiAdvice:verifiedAdvice(outfit,ranked.advice?.find(x=>x.outfitId===outfit.id)?.codes,weather,request)}))};
          modelStages.rank=true;mode='weather';
        }
      } else if (requestedVersion==='hybrid') {
        modelCalls++;
        const parsed=await providers.parseWithModel(config,query,items,effectivePrevious,{ip:context.ip||'local'});
        if (parsed.usage) usage.push(parsed.usage);
        modelStages.parse=true;
        const m=parsed.value;
        request=mergeModelRequest(request,m,query,items,{weatherEnabled});
        request=applyOverrides(request,body,items);
        result=core.solve(items,request);
        if (result.status==='ok') {
          modelCalls++;
          const ranked=await providers.rerankWithModel(config,request,result.candidates,{ip:context.ip||'local'});
          if (ranked.usage) usage.push(ranked.usage);
          modelStages.rank=true;
          const selected=ranked.selection.map(id=>result.candidates.find(x=>x.id===id));
          if (selected.some(x=>!x)||!selected.length) throw new llm.ModelError('invalid_selection','模型选择无效，使用规则方案。');
          modelDrafts=ranked.explanations||[];
          result={...result,outfits:selected.map(outfit=>({...outfit,pickedBy:'model'}))};
        }
        mode='hybrid';
      } else {
        modelCalls++;
        const direct=await providers.directWithModel(config,request,items,{ip:context.ip||'local'});
        if (direct.usage) usage.push(direct.usage);
        modelStages.direct=true;
        const raw=direct.value.outfits;
        if (!Array.isArray(raw)||raw.length>3) throw new llm.ModelError('invalid_selection','模型没有返回有效搭配。');
        if (result.status==='ok'&&!raw.length) throw new llm.ModelError('false_conflict','模型未找到已有可行方案，使用规则结果。');
        if (result.status!=='ok'&&raw.length) throw new llm.ModelError('invalid_selection','模型输出与约束状态不一致。');
        const selected=raw.map((outfit,i)=>{
          if (!outfit||!Array.isArray(outfit.itemIds)) throw new llm.ModelError('invalid_selection','模型搭配缺少单品ID。');
          const checks=core.checkOutfit(outfit.itemIds,items,request);
          if (!Object.values(checks).every(Boolean)) throw new llm.ModelError('constraint_violation','模型方案未通过显式条件校验，使用规则结果。');
          const chosen=outfit.itemIds.map(id=>items.find(x=>x.id===id));
          return {id:`direct-${i}`,itemIds:outfit.itemIds,items:chosen,score:null,reason:`${chosen.map(x=>x.name).join('＋')}。已通过单品存在、完整性、锁定、排除、颜色和裙裤条件检查；审美与体感仍由你判断。`,checks,pass:true,tradeoffs:[],pickedBy:'model'};
        });
        modelDrafts=raw.filter(x=>typeof x.reason==='string').map((x,i)=>({outfitId:`direct-${i}`,reason:x.reason.slice(0,500)}));
        result={...result,outfits:selected};mode='direct';
      }
    } catch(error) {
      if (error.usage) usage.push(error.usage);
      fallback={code:typeof error.code==='string'?error.code:'model_error',message:error.message&&error.code?error.message:'模型服务暂不可用，使用规则方案。'};
      // A partial model stage is never passed off as a completed model version.
      request=baselineRequest;result=core.solve(items,request);mode='rule';
    }
  }
  trace.push({step:'retrieve',label:'检索衣物',detail:`检查${items.length}件衣物及显式单品限制。`});
  trace.push({step:'validate',label:'检查组合',detail:`完整检查${result.stats.totalCombinations}个组合，${result.stats.feasibleCombinations}个符合条件。`});
  trace.push({step:'rank',label:'排列候选',detail:mode==='rule'?'使用可解释的规则偏好排序。':'模型参与决策；返回方案仍经过确定性约束检查。'});
  result={...result,request:{...result.request,temperatureSource,weatherTemperatureDisabled},outfits:result.outfits.map(outfit=>({...outfit,weatherReason:weatherReason(weather,weatherInfluence)}))};
  const response={...result,mode,requestedVersion,model:mode==='rule'?null:config.model,fallback,trace,weather,weatherInfluence,meta:{requestId:randomUUID(),elapsedMs:Math.round(performance.now()-started),usage:combineUsage(usage,config),version:VERSION,dataVersion:body.wardrobe?'local-custom':DATA.version,modelStages,modelDrafts,modelCalls}};
  recordMetrics(config,response);
  return response;
}
function health(config=getConfig()) {return {ok:true,version:VERSION,modelConfigured:config.configured,modelName:config.configured?config.model:null,mode:config.configured?'available':'rule',publicDeploymentReady:config.configured&&config.sharedLimitConfigured,visionConfigured:!!(config.configured&&config.visionModel)};}
module.exports={handleOutfit,health,validateWardrobe,InputError,DATA,VERSION};
