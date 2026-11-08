'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const categoryNames = {top:'上装',bottom:'下装',outer:'外套',shoes:'鞋履',accessory:'配饰'};
const scenes = {commute:'日常通勤',formal:'正式场合',casual:'周末休闲',date:'约会',sport:'运动'};
const subtypes = {top:{shirt:'衬衫',knit:'针织衫',tee:'T恤'},bottom:{trousers:'裤装',skirt:'裙装'},outer:{coat:'大衣',blazer:'西装外套'},shoes:{sneakers:'运动鞋',loafers:'乐福鞋',boots:'短靴'},accessory:{scarf:'围巾'}};
const storeKey = 'yixu.search.v1';
const dateKey = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const loadStore = () => {try {const value=JSON.parse(localStorage.getItem(storeKey) || '{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};} catch {return {};}};
const stored = loadStore();
const versionNames = {rule:'规则基线',weather:'AI 穿搭建议',hybrid:'AI 增强',direct:'全量模型对照'};
const canonicalIds = ids => [...new Set((Array.isArray(ids)?ids:[]).filter(x=>typeof x==='string'))].sort();
const itemSetKey = ids => canonicalIds(ids).join('|');
function uniqueRecords(records){const seen=new Set();return (Array.isArray(records)?records:[]).filter(x=>x&&typeof x.date==='string'&&Array.isArray(x.itemIds)).map(x=>({...x,itemIds:canonicalIds(x.itemIds)})).filter(x=>{const key=`${x.date}:${itemSetKey(x.itemIds)}`;if(seen.has(key))return false;seen.add(key);return true;});}
const state = {items:[],initial:[],filter:'all',required:new Set(),excluded:new Set(),constraintsDirty:false,previous:null,result:null,resultRevision:null,busy:false,revision:0,requestSerial:0,activeRequestId:0,controller:null,version:'rule',lastQuery:'',plan:null,planRevision:null,dataVersion:'',weatherSnapshot:null,weatherError:'',weatherLoading:false,weatherSerial:0,weatherController:null,weatherTemperature:false,records:{plans:uniqueRecords(stored.plans),worn:uniqueRecords(stored.worn),events:Array.isArray(stored.events)?stored.events:[]},savedItems:Array.isArray(stored.items)?stored.items:null,archivedItems:Array.isArray(stored.archivedItems)?stored.archivedItems:[]};
let toastTimer;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4000);}
function persist(){try{localStorage.setItem(storeKey,JSON.stringify({items:state.items,archivedItems:state.archivedItems,weather:weatherSelection(),...state.records}));}catch{toast('浏览器暂时无法保存，本次操作仍然可用。');}}
function event(type,detail={}){state.records.events.push({type,at:new Date().toISOString(),...detail});state.records.events=state.records.events.slice(-300);persist();}
function recentIds(){const cutoff=Date.now()-3*24*60*60*1000;return [...new Set(state.records.worn.filter(x=>new Date(x.at).getTime()>=cutoff).flatMap(x=>x.itemIds||[]))];}
function colorOf(item){return /^#[0-9a-f]{6}$/i.test(item.colorHex||'')?item.colorHex:'#acb39b';}
function clearResultReferences(){state.result=null;state.resultRevision=null;state.plan=null;state.planRevision=null;$('plan-panel').hidden=true;$('confirm-worn').disabled=true;$('trace-panel').hidden=true;}
function invalidateResult(message='条件已更新，请重新生成搭配。'){
  state.revision+=1;state.activeRequestId=++state.requestSerial;
  if(state.controller){state.controller.abort();state.controller=null;}
  clearResultReferences();setBusy(false);
  $('results').innerHTML=`<div class="empty-results"><span class="empty-mark">衣</span><h3>让更新后的衣橱，重新搭配。</h3><p>${esc(message)} 已保存的历史记录仍然保留。</p></div>`;
  $('result-meta').textContent='待重新生成';$('mode-badge').innerHTML='<i></i>待生成';setNotice(message,'info');
}
function allowMutation(){if(!state.busy&&!state.weatherLoading)return true;toast('正在更新，请稍后再修改衣橱或条件。');return false;}

function weatherSelection(){return {enabled:$('weather-enabled').checked,city:$('weather-city').value||'shanghai',day:$('weather-day').value,period:$('weather-period').value||'commute'};}
function selectVersion(version){state.version=version;document.querySelectorAll('input[name="version"]').forEach(input=>input.checked=input.value===version);$('version-summary').textContent=versionNames[version]||version;}
function weatherValue(value,suffix=''){return typeof value==='number'&&Number.isFinite(value)?`${Math.round(value*10)/10}${suffix}`:'未提供';}
function weatherTime(value,timezone='Asia/Shanghai'){const date=new Date(value);if(!Number.isFinite(date.getTime()))return '时间未提供';try{return new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);}catch{return '时间未提供';}}
function safeSourceUrl(value){try{const url=new URL(value);return url.protocol==='https:'||url.protocol==='http:'?url.href:'';}catch{return '';}}
function updateWeatherHint(influence){
  const manual=$('temperature').value!=='';
  $('weather-ai-label').textContent=$('weather-enabled').checked?'根据天气生成 AI 建议':'生成 AI 建议';
  if(manual)$('weather-override').textContent=`已手动填写 ${$('temperature').value}℃，将优先于天气气温；清空后按描述或天气判断。`;
  else if(influence?.temperatureSource==='manual')$('weather-override').textContent=`本次采用描述中的手动气温 ${weatherValue(influence.effectiveTemperature,'℃')}，优先于天气。`;
  else if(influence?.temperatureSource==='weather')$('weather-override').textContent=influence.note||`本次根据所选时段天气，以 ${weatherValue(influence.effectiveTemperature,'℃')} 作为搭配参考。`;
  else $('weather-override').textContent=$('weather-enabled').checked?'天气只作为穿搭参考；也可以手动填写气温。':'已关闭天气参考，可以在下方手动填写气温。';
}
function renderWeather(){
  const card=$('weather-card');card.classList.toggle('weather-error',!!state.weatherError);
  updateWeatherHint(state.result?.weatherInfluence);
  if(!$('weather-enabled').checked){card.innerHTML='<p class="weather-state">本次不查询天气。将按你的描述和手动条件搭配。</p>';return;}
  if(state.weatherLoading){card.innerHTML='<p class="weather-state">正在查询所选城市和时段的天气…</p>';return;}
  if(state.weatherError){card.innerHTML=`<p class="weather-state">${esc(state.weatherError)}</p><p class="micro-copy">可以重新查询，或手动填写气温后继续搭配。</p>`;return;}
  const w=state.weatherSnapshot;if(!w){card.innerHTML='<p class="weather-state">尚未查询天气，可以重新查询或手动填写气温。</p>';return;}
  const summary=w.summary||{};const source=safeSourceUrl(w.source?.url);const sourceName=w.source?.name||'天气数据来源';
  card.innerHTML=`<div class="weather-place"><strong>${esc(w.city?.name||'所选城市')}</strong><span>${esc(w.date||'')} · ${esc(w.periodLabel||'所选时段')} · ${w.remainingHours===true?'剩余时段预报':'该时段预报'}</span></div><div class="weather-metrics"><div><span>气温</span><strong>${esc(weatherValue(summary.minTemperature))}–${esc(weatherValue(summary.maxTemperature,'℃'))}</strong></div><div><span>体感</span><strong>${esc(weatherValue(summary.minApparent))}–${esc(weatherValue(summary.maxApparent,'℃'))}</strong></div><div><span>最高降水概率</span><strong>${esc(weatherValue(summary.maxPrecipitationProbability,'%'))}</strong></div><div><span>最大风速</span><strong>${esc(weatherValue(summary.maxWindSpeed,' km/h'))}</strong></div></div><p class="weather-source">${source?`<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(sourceName)} ↗</a>`:esc(sourceName)} <span>查询于 ${esc(weatherTime(w.retrievedAt,w.timezone))}${w.cacheStatus==='hit'?' · 缓存内预报':''}</span></p>`;
}
function clearWeatherTemperature(){if(state.weatherTemperature&&$('temperature').value===''&&state.previous)state.previous={...state.previous,temperature:null};state.weatherTemperature=false;}
async function loadWeather({autoGenerate=false}={}){
  const selection=weatherSelection();const serial=++state.weatherSerial;const revision=state.revision;
  if(state.weatherController)state.weatherController.abort();
  state.weatherSnapshot=null;state.weatherError='';
  if(!selection.enabled){state.weatherLoading=false;state.weatherController=null;renderWeather();setBusy(false);if(autoGenerate&&state.items.length)await generate({version:'rule'});return;}
  const controller=new AbortController();state.weatherController=controller;state.weatherLoading=true;setBusy(state.busy);renderWeather();
  const timer=setTimeout(()=>controller.abort(),18000);
  try{
    const params=new URLSearchParams({city:selection.city,day:selection.day,period:selection.period});
    const response=await fetch(`/api/weather?${params}`,{signal:controller.signal});
    const data=await response.json().catch(()=>({error:'天气服务暂时未返回可读结果。'}));
    if(serial!==state.weatherSerial||revision!==state.revision)return;
    if(!response.ok||data.status!=='ok')throw Error(data.error||data.message||'暂时无法查询天气。');
    state.weatherSnapshot=data;
  }catch(error){if(serial!==state.weatherSerial||revision!==state.revision)return;state.weatherError=error.name==='AbortError'?'天气查询超时。':error.message;}
  finally{clearTimeout(timer);if(serial===state.weatherSerial){state.weatherController=null;state.weatherLoading=false;setBusy(state.busy);renderWeather();}}
  if(serial===state.weatherSerial&&revision===state.revision&&autoGenerate&&state.items.length)await generate({version:'rule'});
}
function renderTrace(result){
  const steps=Array.isArray(result.trace)?result.trace.filter(x=>typeof x==='string'||x&&typeof x==='object'):[];
  $('trace-panel').hidden=!steps.length;
  $('trace-meta').textContent=typeof result.meta?.modelCalls==='number'?`模型请求尝试 ${result.meta.modelCalls} 次`:'';
  $('trace-steps').innerHTML=steps.map(step=>typeof step==='string'?`<li>${esc(step)}</li>`:`<li><strong>${esc(step.label||step.step||'已完成步骤')}</strong>${step.detail?`<span>${esc(step.detail)}</span>`:''}</li>`).join('');
}

function drawing(item){
  const c=colorOf(item);const stroke='#7b806e';const common=`fill="${c}" stroke="${stroke}" stroke-width="1.1" stroke-linejoin="round"`;let shape='';
  switch(item.subtype){
    case 'trousers':shape=`<path d="M30 12h50l6 98H62l-8-64-7 64H23z" ${common}/><path d="M30 22h49M54 23v21M34 25l-2 77M74 25l4 77M25 103h21m16 0h22" stroke="${stroke}" fill="none" opacity=".55"/><circle cx="56" cy="17" r="1.4" fill="${stroke}"/>`;break;
    case 'skirt':shape=`<path d="M37 16h37l18 91H18z" ${common}/><path d="M36 25h40M42 27l-7 72m19-72-1 72m12-72 6 72" stroke="${stroke}" fill="none" opacity=".45"/>`;break;
    case 'coat':case 'blazer':shape=`<path d="m36 12-17 11-12 57 15 5 10-37-7 62h60l-7-62 10 37 15-5-12-57-17-11-19 9z" ${common}/><path d="m37 13 18 19-9 11 9 9m18-39L55 32l9 11-9 9v58M32 72h16m14 0h17" stroke="${stroke}" fill="none" opacity=".65"/><circle cx="60" cy="67" r="1.6" fill="${stroke}"/><circle cx="60" cy="86" r="1.6" fill="${stroke}"/>`;break;
    case 'sneakers':case 'loafers':shape=`<g transform="translate(3 2) rotate(-9 52 52)"><path d="m16 28 17 4 10 15 35 9q12 4 11 14H7l3-27z" ${common}/><path d="M7 65h82v8H7z" fill="#e1dfd1" stroke="${stroke}"/><path d="m34 39 12-3m-7 10 13-3m-7 10 14-3" stroke="${stroke}" opacity=".5"/></g><g transform="translate(4 42) rotate(-9 52 52)"><path d="m16 28 17 4 10 15 35 9q12 4 11 14H7l3-27z" ${common}/><path d="M7 65h82v8H7z" fill="#e1dfd1" stroke="${stroke}"/><path d="m34 39 12-3m-7 10 13-3m-7 10 14-3" stroke="${stroke}" opacity=".5"/></g>`;break;
    case 'boots':shape=`<path d="M21 17h30l-1 47 34 15q11 4 10 17H17l3-26z" ${common}/><path d="M17 92h77v9H17zM48 25v36" stroke="${stroke}" fill="#686c5b"/><path d="M12 39h24l-1 40 29 15q7 3 8 15H9z" ${common}/>`;break;
    case 'scarf':shape=`<path d="M36 14q20-9 39 0l-8 24 12 65-21 5-9-60-8 62-21-4 15-69z" ${common}/><path d="m36 17 28 16m-6 7 10 62M30 42l9 5m-12 10 10 4m-14 9 12 4m-15 9 13 4" stroke="${stroke}" opacity=".4" fill="none"/>`;break;
    case 'knit':shape=`<path d="m36 16-15 9L8 70l17 6 9-30-5 61h52l-5-61 9 30 17-6-13-45-15-9q-18 24-38 0Z" ${common}/><path d="M37 17q18 25 36 0M30 98h50M12 62l16 6M82 68l16-6" stroke="${stroke}" opacity=".5" fill="none"/><path d="M40 37v57m8-57v57m8-57v57m8-57v57m8-57v57" stroke="#fff" opacity=".15"/>`;break;
    case 'tee':shape=`<path d="m36 16-18 9L5 48l20 11 9-15-5 63h52l-5-63 9 15 20-11-13-23-18-9q-19 20-38 0Z" ${common}/><path d="M37 17q18 23 36 0M31 99h48" fill="none" stroke="${stroke}" opacity=".4"/>`;break;
    default:shape=`<path d="m36 15-17 10L6 52l18 8 9-16-5 63h54l-5-63 9 16 18-8-13-27-17-10-8 6H44z" ${common}/><path d="m36 16 10 15 9-10 9 10 10-15M55 22v85M65 43h12v12H65" fill="none" stroke="${stroke}" opacity=".5"/><g fill="${stroke}" opacity=".65"><circle cx="57" cy="44" r="1"/><circle cx="57" cy="61" r="1"/><circle cx="57" cy="78" r="1"/><circle cx="57" cy="95" r="1"/></g>`;
  }
  return `<svg viewBox="0 0 110 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${shape}</svg>`;
}

function renderCloset(){
  $('item-count').textContent=`${state.items.length} 件`;
  const visible=state.items.filter(x=>state.filter==='all'||x.category===state.filter);
  $('closet-grid').innerHTML=visible.map(item=>`<article class="item-card${state.required.has(item.id)?' locked':''}${state.excluded.has(item.id)?' excluded':''}">${state.required.has(item.id)?'<span class="item-state">已锁定</span>':state.excluded.has(item.id)?'<span class="item-state">暂不考虑</span>':''}<button type="button" class="item-illustration" data-action="edit" data-id="${esc(item.id)}" aria-label="编辑${esc(item.name)}">${drawing(item)}</button><div class="item-info"><h3 title="${esc(item.name)}">${esc(item.name)}</h3><p>${esc(categoryNames[item.category]||'单品')} · ${esc(item.color)}</p><div class="item-controls"><button type="button" data-action="lock" data-id="${esc(item.id)}" class="${state.required.has(item.id)?'active':''}" aria-pressed="${state.required.has(item.id)}">${state.required.has(item.id)?'解锁':'锁定'}</button><button type="button" data-action="exclude" data-id="${esc(item.id)}" class="${state.excluded.has(item.id)?'active':''}" aria-pressed="${state.excluded.has(item.id)}">${state.excluded.has(item.id)?'恢复':'排除'}</button><button type="button" data-action="edit" data-id="${esc(item.id)}" aria-label="编辑${esc(item.name)}">编辑</button></div></div></article>`).join('')||'<p class="micro-copy">这个品类还没有单品，试着添加一件。</p>';
  if(state.busy)document.querySelectorAll('#closet-grid button').forEach(x=>x.disabled=true);
}

function renderConditions(request=state.previous){
  const r=request||{};const chips=[];
  if(r.scene)chips.push({label:scenes[r.scene]||r.scene,key:'scene'});
  if(r.temperature!==null&&r.temperature!==undefined)chips.push({label:`${r.temperature}℃`,key:'temperature'});
  if(r.bottomType&&r.bottomType!=='any')chips.push({label:r.bottomType==='trousers'?'只穿裤装':'只穿裙装',key:'bottomType'});
  (r.excludedColors||[]).forEach(v=>chips.push({label:`不要${v}`,key:'excludedColors',value:v}));
  state.required.forEach(id=>chips.push({label:`保留${state.items.find(x=>x.id===id)?.name||id}`,key:'requiredIds',value:id}));
  state.excluded.forEach(id=>chips.push({label:`排除${state.items.find(x=>x.id===id)?.name||id}`,key:'excludedIds',value:id}));
  if(r.avoidRecent)chips.push({label:'优先近期不重复',key:'avoidRecent',soft:true});
  $('condition-tags').innerHTML=chips.length?chips.map(c=>`<span class="condition-tag${c.soft?' soft':''}">${esc(c.label)}<button type="button" data-key="${esc(c.key)}" data-value="${esc(c.value||'')}" aria-label="移除${esc(c.label)}">×</button></span>`).join(''):'<span class="empty-condition">暂无限制，可以自由搭配。</span>';
  $('preference-list').textContent=(r.preferences||[]).length?`偏好：${r.preferences.join('、')}`:'';
  const notes=[...(r.warnings||[]),...(r.clarifications||[])];$('clarifications').hidden=!notes.length;$('clarifications').textContent=notes.join('\n');$('clear-unsupported').hidden=!(r.clarifications||[]).length;
}

function renderResults(result){
  const outfits=Array.isArray(result.outfits)?result.outfits:[];
  if(!outfits.length){$('results').innerHTML=`<div class="empty-results"><span class="empty-mark">${result.status==='clarify'?'?':'◇'}</span><h3>${result.status==='clarify'?'再确认一点，搭配会更合适。':'这次，先不将就。'}</h3><p>${esc(result.diagnosis?.message||'当前条件下没有可返回的方案，请修改条件再试。')}</p></div>`;return;}
  const checkLabels={inWardrobe:'衣橱内',complete:'组合完整',required:'保留指定单品',excluded:'排除项',color:'颜色限制',bottomType:'款式限制'};
  $('results').innerHTML=outfits.map((o,i)=>{const items=(o.items||o.itemIds?.map(id=>state.items.find(x=>x.id===id))||[]).filter(Boolean);return `<article class="outfit-card"><div class="outfit-top"><span class="outfit-badge">${i===0?'今天的推荐':`另一种选择`}</span><span class="outfit-number">0${i+1}</span></div><div class="outfit-art">${items.map(item=>`<div class="outfit-piece" title="${esc(item.name)}">${drawing(item)}<span class="piece-name">${esc(item.name)}</span></div>`).join('')}</div><div class="outfit-content"><h3>${i===0?'从这一套开始':i===1?'换一种日常':'给今天一点变化'}</h3><p class="outfit-reason">${esc(o.reason||'依据已确认属性与当前条件选择。')}</p>${o.weatherReason?`<p class="outfit-weather"><span>天气参考</span>${esc(o.weatherReason)}</p>`:''}${o.aiAdvice?`<p class="outfit-ai"><span>AI 建议</span>${esc(o.aiAdvice)}</p>`:''}<div class="outfit-checks">${Object.entries(o.checks||{}).filter(([key])=>checkLabels[key]).map(([key,v])=>`<span class="${v?'':'fail'}">${v?'✓':'×'} ${esc(checkLabels[key])}</span>`).join('')}</div><div class="outfit-actions"><button type="button" class="button ${i===0?'primary':'secondary'}" data-action="plan" data-index="${i}">就计划穿这套 <span aria-hidden="true">＋</span></button><div class="swap-control"><select aria-label="选择第${i+1}套要替换的单品" data-swap="${i}">${items.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select><button type="button" data-action="swap" data-index="${i}">换这一件 ↻</button></div></div>${(o.tradeoffs||[]).length?`<p class="tradeoff">${esc(o.tradeoffs.join('；'))}</p>`:''}</div></article>`;}).join('');
}

function setNotice(message,type=''){const box=$('status-message');box.hidden=!message;box.textContent=message;box.className=`notice ${type}`;}
function setBusy(value){
  state.busy=value;const locked=value||state.weatherLoading;$('generate-button').disabled=locked;$('weather-ai-button').disabled=locked;$('generate-label').textContent=value?'正在挑选…':'只用规则搭配';$('results').setAttribute('aria-busy',String(value));
  document.querySelectorAll('#query,#scene,#temperature,input[name="version"],#advanced-generate,#weather-enabled,#weather-city,#weather-day,#weather-period,#refresh-weather,.example,#add-item,#reset-demo,#clear-conditions,#closet-grid button,#condition-tags button,#clear-unsupported,#results button,#results select,#item-form input,#item-form select,#item-form button[type="submit"],#delete-item').forEach(x=>x.disabled=locked);
  if(!$('weather-enabled').checked)for(const id of ['weather-city','weather-day','weather-period','refresh-weather'])$(id).disabled=true;
  $('confirm-worn').disabled=locked||!state.plan||state.planRevision!==state.revision||state.records.worn.some(x=>x.date===dateKey()&&itemSetKey(x.itemIds)===itemSetKey(state.plan?.itemIds));
}

async function generate(options={}){
  if(state.busy||state.weatherLoading)return;
  const query=options.query??$('query').value.trim();if(!query){toast('先说说今天的安排，或选一个示例。');$('query').focus();return;}
  const requestId=++state.requestSerial;const requestRevision=state.revision;const requestedVersion=options.version||'rule';selectVersion(requestedVersion);
  state.activeRequestId=requestId;state.lastQuery=query;const overrides={...options.overrides};
  if($('scene').value)overrides.scene=$('scene').value;
  if($('temperature').value!=='')overrides.temperature=Number($('temperature').value);
  if(options.keepControls===false){delete overrides.scene;delete overrides.temperature;}
  if(state.constraintsDirty){overrides.requiredIds=[...state.required];overrides.excludedIds=[...state.excluded];}
  const payload={query,version:requestedVersion,wardrobe:state.items,previous:options.previous??state.previous??undefined,overrides,recentIds:recentIds()};
  const weather=weatherSelection();if(weather.enabled)payload.weather={city:weather.city,day:weather.day,period:weather.period};
  clearResultReferences();setBusy(true);setNotice('');$('mode-badge').innerHTML='<i></i>正在生成';$('results').innerHTML='<div class="empty-results loading-shimmer"><span class="empty-mark">衣</span><h3>正在衣橱里，找一点灵感。</h3><p>先检查条件，再比较可用的组合。</p></div>';
  const controller=new AbortController();state.controller=controller;const timer=setTimeout(()=>controller.abort(),35000);
  try{
    const response=await fetch('/api/outfit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
    const data=await response.json().catch(()=>({error:'服务暂时未返回可读结果。'}));
    if(state.activeRequestId!==requestId||state.revision!==requestRevision)return;
    if(!response.ok)throw new Error(data.error||`请求未完成（${response.status}）`);
    state.result=data;state.resultRevision=requestRevision;state.previous=data.request||state.previous;state.required=new Set(data.request?.requiredIds||[]);state.excluded=new Set(data.request?.excludedIds||[]);state.constraintsDirty=false;
    state.weatherTemperature=data.weatherInfluence?.temperatureSource==='weather';
    if(data.weather?.status==='ok'){state.weatherSnapshot=data.weather;state.weatherError='';}else if(data.weather?.status==='unavailable'){state.weatherSnapshot=null;state.weatherError=data.weather.message||'本次天气不可用。';}
    renderResults(data);renderConditions();renderCloset();renderWeather();renderTrace(data);updateWeatherHint(data.weatherInfluence);
    const mode=versionNames[data.mode]||'规则基线';$('mode-badge').innerHTML=`<i></i>${esc(mode)}`;
    $('result-meta').textContent=`${data.outfits?.length||0} 套候选${typeof data.meta?.elapsedMs==='number'?` · ${(data.meta.elapsedMs/1000).toFixed(2)}s`:''}`;
    const notes=[];
    if(data.fallback)notes.push(`本次使用规则基线：${data.fallback.message||'模型暂不可用。'}`);
    if(data.weather?.status==='unavailable')notes.push('本次未采用天气，可手动填写气温继续搭配。');
    if(data.diagnosis?.message)notes.push(data.diagnosis.message);
    if(data.status==='conflict'&&(data.diagnosis?.suggestions||[]).length)notes.push(`可以尝试：${data.diagnosis.suggestions.join('；')}`);
    setNotice(notes.join('\n'),data.status==='ok'?'info':'');
    event('generate',{query,requestedVersion,actualMode:data.mode,status:data.status,requestId:data.meta?.requestId,elapsedMs:data.meta?.elapsedMs,itemIds:data.outfits?.[0]?.itemIds||[],fallback:data.fallback?.code||null});
  }catch(error){if(state.activeRequestId!==requestId||state.revision!==requestRevision)return;$('mode-badge').innerHTML='<i></i>待重试';setNotice(error.name==='AbortError'?'这次等待有些久，请稍后重试或只用规则搭配。':`${error.message} 可以稍后重试。`,'error');$('results').innerHTML='<div class="empty-results"><span class="empty-mark">◇</span><h3>暂时没能打开这次搭配。</h3><p>你的衣橱仍然保留，可以稍后重新生成。</p></div>';}
  finally{clearTimeout(timer);if(state.activeRequestId===requestId){state.controller=null;setBusy(false);}}
}

function renderRecords(){
  $('worn-days').textContent=new Set(state.records.worn.map(x=>x.date)).size;$('planned-count').textContent=state.records.plans.length;
  $('recent-note').textContent=recentIds().length?`最近三天已确认穿过 ${recentIds().length} 件单品，生成时可优先避开。`:'确认实际穿过后，才会用于近期重复偏好。';
}
function savePlan(index){
  if(!allowMutation())return;const outfit=state.result?.outfits?.[index];if(!outfit||state.resultRevision!==state.revision){toast('衣橱或条件已变化，请先重新生成。');return;}
  const ids=canonicalIds(outfit.itemIds||outfit.items.map(x=>x.id));if(ids.some(id=>!state.items.some(x=>x.id===id))){invalidateResult('结果中有已移除的衣物，请重新生成。');return;}
  const plan={id:`P${Date.now().toString(36)}`,date:dateKey(),itemIds:ids,names:ids.map(id=>state.items.find(x=>x.id===id)?.name||id),createdAt:new Date().toISOString()};
  state.plan=plan;state.planRevision=state.revision;const existing=state.records.plans.find(x=>x.date===plan.date&&itemSetKey(x.itemIds)===itemSetKey(ids));if(!existing)state.records.plans.push(plan);else state.plan=existing;
  const alreadyWorn=state.records.worn.some(x=>x.date===plan.date&&itemSetKey(x.itemIds)===itemSetKey(ids));
  $('plan-panel').hidden=false;$('plan-title').textContent=alreadyWorn?'这套今天已记录穿着':'已保存为今天的计划';$('plan-description').textContent=plan.names.join('、');$('confirm-worn').disabled=alreadyWorn;$('confirm-worn').textContent=alreadyWorn?'今天已记录 ✓':'确认今天已穿 ✓';event('plan',{itemIds:ids});renderRecords();toast(alreadyWorn?'这套今天已经确认穿过，不会重复计入。':'已保存计划。实际穿过后，再确认记录。');
}
function confirmWorn(){
  if(!allowMutation())return;if(!state.plan||state.planRevision!==state.revision||state.plan.itemIds.some(id=>!state.items.some(x=>x.id===id))){clearResultReferences();toast('衣橱或条件已变化，请先重新生成并选择计划。');return;}
  const today=dateKey();const existing=state.records.worn.find(x=>x.date===today&&itemSetKey(x.itemIds)===itemSetKey(state.plan.itemIds));
  if(!existing){state.records.worn.push({date:today,itemIds:canonicalIds(state.plan.itemIds),at:new Date().toISOString(),planId:state.plan.id});event('confirm_worn',{itemIds:canonicalIds(state.plan.itemIds)});}
  $('plan-title').textContent='今天的实际穿着，记下了';$('confirm-worn').disabled=true;$('confirm-worn').textContent='今天已记录 ✓';renderRecords();toast('已确认实际穿着，同一套不会重复计入。');
}

function updateSubtypes(selected){const category=$('item-category').value;$('item-subtype').innerHTML=Object.entries(subtypes[category]||{}).map(([value,label])=>`<option value="${value}">${label}</option>`).join('');if(selected&&subtypes[category]?.[selected])$('item-subtype').value=selected;}
function openEditor(id){if(!allowMutation())return;const item=state.items.find(x=>x.id===id);$('item-form').reset();$('edit-id').value=item?.id||'';$('item-dialog-title').textContent=item?'编辑这件单品':'添加一件单品';$('item-category').value=item?.category||'top';updateSubtypes(item?.subtype);$('item-name').value=item?.name||'';$('item-color').value=item?.color||'';$('item-hex').value=item?colorOf(item):'#657150';$('item-family').value=item?.colorFamily||'neutral';$('item-warmth').value=item?.warmth||3;$('item-formality').value=item?.formality||3;$('item-tags').value=(item?.tags||[]).join('、');$('delete-item').hidden=!item;$('item-dialog').showModal();}
function saveItem(e){e.preventDefault();if(!allowMutation())return;const id=$('edit-id').value||`U${Date.now().toString(36).toUpperCase()}`;const old=state.items.find(x=>x.id===id);const item={id,name:$('item-name').value.trim(),category:$('item-category').value,subtype:$('item-subtype').value,color:$('item-color').value.trim(),colorHex:$('item-hex').value,colorFamily:$('item-family').value,warmth:Number($('item-warmth').value),formality:Number($('item-formality').value),tags:$('item-tags').value.split(/[、,，\s]+/).map(x=>x.trim()).filter(Boolean).slice(0,8),source:'手动录入',confirmed:true};
  if(!item.name||!item.color)return;if(state.items.length>=40&&!old){toast('当前原型最多保存40件单品。');return;}if(old)state.items[state.items.indexOf(old)]=item;else state.items.push(item);invalidateResult('衣物属性已保存，请重新生成搭配。');persist();renderCloset();renderConditions();$('item-dialog').close();toast('已保存，旧搭配已失效，请重新生成。');}

$('query-form').addEventListener('submit',e=>{e.preventDefault();generate({version:'rule'});});
$('weather-ai-button').addEventListener('click',()=>generate({version:'weather'}));
$('advanced-generate').addEventListener('click',()=>generate({version:state.version}));
for(const id of ['weather-enabled','weather-city','weather-day','weather-period'])$(id).addEventListener('change',()=>{
  if(!allowMutation())return;clearWeatherTemperature();invalidateResult('天气条件已更新，正在按规则重新搭配。');selectVersion('rule');persist();loadWeather({autoGenerate:true});
});
$('refresh-weather').addEventListener('click',()=>{if(!allowMutation())return;clearWeatherTemperature();invalidateResult('正在重新查询天气，并按规则更新搭配。');selectVersion('rule');loadWeather({autoGenerate:true});});
document.querySelectorAll('.example').forEach(button=>button.addEventListener('click',()=>{if(!allowMutation())return;invalidateResult('已切换场景，正在重新搭配。');state.previous=null;state.required.clear();state.excluded.clear();state.constraintsDirty=false;$('scene').value='';$('temperature').value='';$('query').value=button.dataset.query;renderConditions();renderCloset();generate();}));
document.querySelectorAll('input[name=version]').forEach(input=>input.addEventListener('change',()=>{if(!allowMutation())return;selectVersion(input.value);invalidateResult('搭配方式已切换，点击“按所选方式生成”开始对比。');}));
document.querySelectorAll('[data-category]').forEach(button=>button.addEventListener('click',()=>{state.filter=button.dataset.category;document.querySelectorAll('[data-category]').forEach(x=>{x.classList.toggle('active',x===button);x.setAttribute('aria-pressed',String(x===button));});renderCloset();}));
$('closet-grid').addEventListener('click',e=>{const button=e.target.closest('button[data-action]');if(!button||!allowMutation())return;const {action,id}=button.dataset;if(action==='edit'){openEditor(id);return;}if(action==='lock'){if(state.required.has(id))state.required.delete(id);else{state.required.add(id);state.excluded.delete(id);}}if(action==='exclude'){if(state.excluded.has(id))state.excluded.delete(id);else{state.excluded.add(id);state.required.delete(id);}}state.constraintsDirty=true;invalidateResult('单品条件已更新，请重新生成。');renderCloset();renderConditions();toast('条件已更新，旧搭配已失效。');});
$('results').addEventListener('click',e=>{const button=e.target.closest('button[data-action]');if(!button||!allowMutation())return;const index=Number(button.dataset.index);if(button.dataset.action==='plan')savePlan(index);if(button.dataset.action==='swap'){const outfit=state.result?.outfits?.[index];const id=$('results').querySelector(`select[data-swap="${index}"]`)?.value;if(!id||!outfit||state.resultRevision!==state.revision)return;const ids=outfit.itemIds||outfit.items.map(x=>x.id);ids.filter(x=>x!==id).forEach(x=>{state.required.add(x);state.excluded.delete(x);});state.required.delete(id);state.excluded.add(id);state.constraintsDirty=true;invalidateResult('换件条件已更新，正在重新搭配。');renderCloset();renderConditions();generate({query:'按更新后的条件再搭配。'});}});
$('condition-tags').addEventListener('click',e=>{const button=e.target.closest('button[data-key]');if(!button||!allowMutation())return;const {key,value}=button.dataset;const next={...(state.previous||{})};if(key==='requiredIds'){state.required.delete(value);next.requiredIds=[...state.required];}else if(key==='excludedIds'){state.excluded.delete(value);next.excludedIds=[...state.excluded];}else if(key==='excludedColors')next.excludedColors=(next.excludedColors||[]).filter(x=>x!==value);else if(key==='bottomType')next.bottomType='any';else if(key==='avoidRecent')next.avoidRecent=false;else if(key==='temperature'){next.temperature=null;next.weatherTemperatureDisabled=true;$('temperature').value='';}else if(key==='scene'){next.scene='casual';$('scene').value='';}state.previous=next;state.constraintsDirty=true;const overrides={...next};if(next.temperatureSource==='weather'||key==='temperature')delete overrides.temperature;invalidateResult('条件已移除，正在重新搭配。');renderConditions();renderCloset();generate({query:key==='temperature'?'气温不限，按更新后的条件再搭配。':'按更新后的条件再搭配。',overrides});});
$('clear-conditions').addEventListener('click',()=>{if(!allowMutation())return;invalidateResult('条件已清空，请描述新的安排。');state.previous=null;state.required.clear();state.excluded.clear();state.constraintsDirty=false;$('scene').value='';$('temperature').value='';$('query').value='';renderConditions();renderCloset();toast('已清空条件，旧搭配已失效。');$('query').focus();});
$('clear-unsupported').addEventListener('click',()=>{if(!allowMutation())return;state.previous={...(state.previous||{}),clarifications:[]};invalidateResult('已移除暂不支持的条件，正在重新搭配。');renderConditions();generate({query:'忽略刚才不支持的条件，按其余条件搭配。',overrides:{clarifications:[]}});});
for(const id of ['query','scene','temperature'])$(id).addEventListener(id==='query'?'input':'change',()=>{if(state.busy||state.weatherLoading)return;if(id==='temperature'&&$('temperature').value===''&&state.previous)state.previous={...state.previous,temperature:null};if(state.result||state.plan)invalidateResult('需求已修改，请重新生成搭配。');else state.revision+=1;updateWeatherHint();});
$('confirm-worn').addEventListener('click',confirmWorn);
$('add-item').addEventListener('click',()=>openEditor());$('close-dialog').addEventListener('click',()=>$('item-dialog').close());$('item-category').addEventListener('change',()=>updateSubtypes());$('item-form').addEventListener('submit',saveItem);
$('delete-item').addEventListener('click',()=>{if(!allowMutation())return;const id=$('edit-id').value;state.items=state.items.filter(x=>x.id!==id);state.required.delete(id);state.excluded.delete(id);if(state.previous)state.previous={...state.previous,requiredIds:[...state.required],excludedIds:[...state.excluded]};invalidateResult('衣物已移除，请重新生成搭配。');persist();renderCloset();renderConditions();$('item-dialog').close();toast('已移除，旧搭配已失效。历史穿着记录保留。');});
$('reset-demo').addEventListener('click',()=>{if(!allowMutation())return;if(!confirm('恢复示例衣橱将替换本机新增和修改的单品，穿着记录会保留。确定恢复吗？'))return;state.items=structuredClone(state.initial);state.previous=null;state.required.clear();state.excluded.clear();state.constraintsDirty=false;state.filter='all';document.querySelectorAll('[data-category]').forEach(x=>{x.classList.toggle('active',x.dataset.category==='all');x.setAttribute('aria-pressed',String(x.dataset.category==='all'));});invalidateResult('已恢复示例衣橱，请重新生成搭配。');persist();renderCloset();renderConditions();toast('已恢复示例，旧搭配失效，历史记录仍保留。');});
$('export-records').addEventListener('click',()=>{const contents={exportedAt:new Date().toISOString(),dataVersion:state.dataVersion,notice:'当前浏览器本机记录；不可据此推断独立用户数或总体采纳率。衣橱为示例或本人手动录入。',wardrobe:state.items,archivedItems:state.archivedItems,...state.records};const blob=new Blob([JSON.stringify(contents,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`衣序本机试用记录-${dateKey()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出本机记录，不会上传后台。');});

async function init(){
  renderRecords();setBusy(true);
  const results=await Promise.allSettled([fetch('/api/wardrobe').then(r=>{if(!r.ok)throw Error('衣橱加载失败');return r.json();}),fetch('/api/health').then(r=>r.json()),fetch('/api/weather?catalog=1').then(r=>{if(!r.ok)throw Error('城市列表加载失败');return r.json();})]);
  if(results[0].status==='fulfilled'){const data=results[0].value;state.initial=Array.isArray(data.items)?data.items:[];state.dataVersion=data.version||'demo';const valid=state.savedItems?.filter(x=>x&&typeof x.id==='string'&&typeof x.name==='string'&&categoryNames[x.category]);if(valid&&valid.length>40){state.archivedItems.push(...valid.slice(40));toast('当前最多使用40件，超出部分保留在导出记录中。');}state.items=valid?valid.slice(0,40):structuredClone(state.initial);$('data-description').textContent='示例衣橱 · 人工构造的属性数据，可编辑或添加自己的单品';renderCloset();renderConditions();}
  else{$('closet-grid').innerHTML='<p class="micro-copy">暂时无法加载衣橱，请确认服务运行后刷新。</p>';setNotice('衣橱服务暂不可用，请确认本地服务已经启动。','error');}
  if(results[1].status==='fulfilled'){const health=results[1].value;$('mode-badge').innerHTML='<i></i>规则基线';$('model-hint').textContent=health.modelConfigured?'点击 AI 建议才会调用模型；页面刷新和天气切换只用规则。':'AI 服务暂不可用时，会明确显示实际采用的规则方案。';}
  else{$('mode-badge').innerHTML='<i></i>连接待恢复';$('model-hint').textContent='暂时无法检查模型配置。';}
  const catalog=results[2].status==='fulfilled'?results[2].value:{};
  const cities=(Array.isArray(catalog.cities)?catalog.cities:[]).filter(x=>x&&typeof x.id==='string'&&typeof x.name==='string');
  const periods=(Array.isArray(catalog.periods)?catalog.periods:[]).filter(x=>x&&typeof x.id==='string'&&typeof x.name==='string');
  if(cities.length)$('weather-city').innerHTML=cities.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  if(periods.length)$('weather-period').innerHTML=periods.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  const preferences=stored.weather&&typeof stored.weather==='object'?stored.weather:{};
  $('weather-enabled').checked=preferences.enabled!==false;
  $('weather-city').value=[...$('weather-city').options].some(x=>x.value===preferences.city)?preferences.city:'shanghai';
  $('weather-day').value=preferences.day==='tomorrow'?'tomorrow':'today';
  $('weather-period').value=[...$('weather-period').options].some(x=>x.value===preferences.period)?preferences.period:'commute';
  selectVersion('rule');setBusy(false);await loadWeather({autoGenerate:state.items.length>0});
}
init();
