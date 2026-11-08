'use strict';

// Fixed city coordinates keep requests deterministic and avoid a paid geocoder.
// This module reads no environment variables and never fabricates weather data.
const TIMEZONE = 'Asia/Shanghai';
const OFFSET_MS = 8 * 60 * 60 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_CACHE_KEYS = 64;
const CITIES = Object.freeze([
  ['shanghai','上海',31.2304,121.4737],
  ['beijing','北京',39.9042,116.4074],
  ['shenzhen','深圳',22.5431,114.0579],
  ['guangzhou','广州',23.1291,113.2644],
  ['hangzhou','杭州',30.2741,120.1551],
  ['nanjing','南京',32.0603,118.7969],
  ['chengdu','成都',30.5728,104.0668],
  ['wuhan','武汉',30.5928,114.3055],
  ['xian','西安',34.3416,108.9398],
  ['chongqing','重庆',29.5630,106.5516],
  ['suzhou','苏州',31.2989,120.5853],
  ['jinan','济南',36.6512,117.1201],
  ['qingdao','青岛',36.0671,120.3826],
  ['tianjin','天津',39.3434,117.3616],
  ['changsha','长沙',28.2282,112.9388]
].map(([id,name,latitude,longitude]) => Object.freeze({
  id,name,latitude,longitude,timezone:TIMEZONE,
  aliases:Object.freeze([name + '市', ...(id === 'xian' ? ["xi'an"] : [])])
})));
const PERIODS = Object.freeze({
  commute:{label:'通勤（07–09时、17–19时）',includes:hour=>(hour>=7&&hour<=9)||(hour>=17&&hour<=19)},
  daytime:{label:'白天（09–17时）',includes:hour=>hour>=9&&hour<=17},
  evening:{label:'晚间（18–22时）',includes:hour=>hour>=18&&hour<=22},
  all:{label:'全天（00–23时）',includes:()=>true}
});
class WeatherError extends Error {
  constructor(code,message) {super(message);this.name='WeatherError';this.code=code;}
}
const inputError = (code,message) => new WeatherError('weather_input_' + code,message);
const hasOwn = (object,key) => Object.hasOwn(object,key) && object[key] !== undefined && object[key] !== null && object[key] !== '';

function findCity(value) {
  const identity = typeof value === 'string' ? value : value && typeof value === 'object' ? value.id : null;
  if (typeof identity !== 'string') return null;
  const normalized = identity.trim().toLowerCase();
  return CITIES.find(city=>[city.id,city.name,...city.aliases].some(alias=>alias.toLowerCase()===normalized)) || null;
}

function mentionedCities(query) {
  const lower = query.toLowerCase();
  return CITIES.filter(city=>[city.name,...city.aliases].some(alias=>lower.includes(alias.toLowerCase())) ||
    new RegExp(`(?:^|[^a-z])${city.id}(?:[^a-z]|$)`).test(lower));
}

function normalizeSelection(raw={},query='') {
  if (typeof raw === 'string') raw={city:raw};
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw inputError('selection','请选择天气城市、日期和时段。');
  if (typeof query!=='string' || query.length>2000) throw inputError('query','天气需求文本格式无效或过长。');
  const mentioned=mentionedCities(query);
  if (mentioned.length>1) throw inputError('city_ambiguous','需求中有多个天气城市，请只选择一个城市。');
  const city=hasOwn(raw,'city')?findCity(raw.city):mentioned[0];
  if (!city) throw inputError('city','请选择支持的天气城市，暂不支持自动定位或其他城市。');
  if (mentioned.length && mentioned[0].id!==city.id) throw inputError('city_conflict',`需求中指定${mentioned[0].name}，请将天气城市切换为${mentioned[0].name}。`);
  // A past wearing reference is not a request for historical weather. Remove
  // only explicit wearing-history references; keep past weather/date requests
  // and every future date outside the supported two-day horizon rejectable.
  const weatherDateQuery=query.replace(/(?:昨天|前天)(?=(?:曾经|已经|已)?穿(?:过|了|的)|的穿着(?:记录|历史))/g,'');
  if (/后天|大后天|昨天|前天/.test(weatherDateQuery)) throw inputError('day','天气仅支持今天或明天，请调整日期需求。');
  const queryToday=/今天|今日|今晚/.test(query),queryTomorrow=/明天|明日|明晚/.test(query);
  if (queryToday && queryTomorrow) throw inputError('day_ambiguous','需求中同时提到今天和明天，请选择一个天气日期。');
  const queryDay=queryTomorrow?'tomorrow':queryToday?'today':null;
  const day=hasOwn(raw,'day')?raw.day:queryDay||'today';
  if (!['today','tomorrow'].includes(day)) throw inputError('day','天气日期仅支持今天或明天。');
  if (queryDay && day!==queryDay) throw inputError('day_conflict',`需求中指定${queryDay==='today'?'今天':'明天'}，请同步切换天气日期。`);
  const queryPeriods=[];
  if (/通勤|上下班|早晚/.test(query)) queryPeriods.push('commute');
  if (/白天|日间/.test(query)) queryPeriods.push('daytime');
  if (/晚上|晚间|今晚|明晚/.test(query)) queryPeriods.push('evening');
  if (/全天|一整天/.test(query)) queryPeriods.push('all');
  // A selected period remains explicit; conversational scene words must not
  // silently change it. Multiple hints without a selection require correction.
  if (!hasOwn(raw,'period') && queryPeriods.length>1) throw inputError('period_ambiguous','需求涉及多个天气时段，请明确选择通勤、白天、晚间或全天。');
  const period=hasOwn(raw,'period')?raw.period:queryPeriods[0]||'commute';
  if (!Object.hasOwn(PERIODS,period)) throw inputError('period','天气时段仅支持通勤、白天、晚间或全天。');
  return {city,day,period};
}

function clockValue(now) {
  if (typeof now!=='number' || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw inputError('time','当前时间无效，无法确定天气日期。');
  return now;
}
const chinaDate = timestamp => new Date(timestamp + OFFSET_MS).toISOString().slice(0,10);
const nextDate = date => new Date(Date.parse(date + 'T00:00:00Z') + 24*60*60*1000).toISOString().slice(0,10);
const hourEpoch = localTime => Date.parse(localTime + ':00+08:00');

function validateForecast(body,today) {
  const invalid=()=>new WeatherError('weather_invalid_response','天气服务返回的数据不完整或格式异常，请稍后重试或手动填写气温。');
  if (!body || typeof body!=='object' || Array.isArray(body)) throw invalid();
  if (body.error===true) throw new WeatherError('weather_provider_error','天气服务无法处理本次查询，请稍后重试或手动填写气温。');
  if (body.timezone!==TIMEZONE || body.utc_offset_seconds!==28800) throw new WeatherError('weather_timezone','天气服务时区不匹配，已停止使用该预报。');
  const units=body.hourly_units;
  if (!units || units.time!=='iso8601' || units.temperature_2m!=='°C' || units.apparent_temperature!=='°C' ||
    units.precipitation_probability!=='%' || units.wind_speed_10m!=='km/h') throw new WeatherError('weather_units','天气服务单位不匹配，已停止使用该预报。');
  const hourly=body.hourly;
  const fields=['time','temperature_2m','apparent_temperature','precipitation_probability','wind_speed_10m'];
  if (!hourly || !fields.every(field=>Array.isArray(hourly[field])&&hourly[field].length===48)) throw invalid();
  const dates=[today,nextDate(today)];
  const grouped=new Map(dates.map(date=>[date,[]]));
  for (let index=0;index<48;index++) {
    const date=dates[Math.floor(index/24)],hour=index%24;
    const expectedTime=date+'T'+String(hour).padStart(2,'0')+':00';
    if (hourly.time[index]!==expectedTime || !Number.isFinite(hourEpoch(expectedTime))) throw invalid();
    const temperature=hourly.temperature_2m[index],apparent=hourly.apparent_temperature[index],
      precipitation=hourly.precipitation_probability[index],wind=hourly.wind_speed_10m[index];
    if (![temperature,apparent,precipitation,wind].every(value=>typeof value==='number'&&Number.isFinite(value)) ||
      temperature < -100 || temperature > 70 || apparent < -120 || apparent > 90 ||
      precipitation < 0 || precipitation > 100 || wind < 0 || wind > 400) throw invalid();
    grouped.get(date).push(Object.freeze({time:expectedTime,temperature,apparentTemperature:apparent,precipitationProbability:precipitation,windSpeed:wind}));
  }
  return grouped;
}

// Different injected fetch functions receive separate caches. A production
// instance's stable global fetch shares its cache; tests never pollute it.
let caches = new WeakMap();
function stateFor(fetchImpl) {
  let state=caches.get(fetchImpl);
  if (!state) {state={entries:new Map(),pending:new Map()};caches.set(fetchImpl,state);}
  return state;
}
function clearWeatherCache(fetchImpl) {
  if (fetchImpl) caches.delete(fetchImpl);
  else caches=new WeakMap();
}
function putEntry(state,key,entry,now) {
  for (const [existing,value] of state.entries) if (value.expiresAt<=now) state.entries.delete(existing);
  state.entries.delete(key);state.entries.set(key,entry);
  while (state.entries.size>MAX_CACHE_KEYS) state.entries.delete(state.entries.keys().next().value);
}

async function loadForecast(city,today,{fetchImpl,now,state}) {
  const url=new URL('https://api.open-meteo.com/v1/forecast');
  url.search=new URLSearchParams({latitude:String(city.latitude),longitude:String(city.longitude),
    hourly:'temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m',
    timezone:TIMEZONE,forecast_days:'2',temperature_unit:'celsius',wind_speed_unit:'kmh'}).toString();
  const controller=new AbortController();
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
    const error=new WeatherError('weather_timeout','天气服务响应超时，请稍后重试或手动填写气温。');
    reject(error);controller.abort(error);
  },REQUEST_TIMEOUT_MS);});
  const operation=(async()=>{
    let response;
    try {response=await fetchImpl(url.toString(),{method:'GET',headers:{accept:'application/json'},signal:controller.signal});}
    catch {throw new WeatherError('weather_network','暂时无法连接天气服务，请稍后重试或手动填写气温。');}
    if (!response || typeof response.ok!=='boolean' || typeof response.json!=='function') throw new WeatherError('weather_invalid_response','天气服务返回格式异常，请稍后重试。');
    if (!response.ok) throw new WeatherError('weather_http','天气服务暂时不可用，请稍后重试或手动填写气温。');
    let body;
    try {body=await response.json();}
    catch {throw new WeatherError('weather_invalid_response','天气服务返回的JSON无效，请稍后重试。');}
    return validateForecast(body,today);
  })();
  try {
    const grouped=await Promise.race([operation,timeout]);
    for (const [date,hours] of grouped) putEntry(state,city.id+'|'+date,{hours,retrievedAt:now,expiresAt:now+CACHE_TTL_MS},now);
  } finally {clearTimeout(timer);}
}

async function getWeather(rawSelection,{fetchImpl=globalThis.fetch,now=Date.now()}={}) {
  const selection=normalizeSelection(rawSelection),timestamp=clockValue(now);
  if (typeof fetchImpl!=='function') throw new WeatherError('weather_network','当前环境无法连接天气服务，请手动填写气温。');
  const today=chinaDate(timestamp),date=selection.day==='tomorrow'?nextDate(today):today;
  const state=stateFor(fetchImpl),key=selection.city.id+'|'+date;
  let entry=state.entries.get(key),cacheStatus='hit';
  if (!entry || entry.expiresAt<=timestamp || entry.retrievedAt>timestamp) {
    cacheStatus='fresh';
    const requestKey=selection.city.id+'|'+today;
    let pending=state.pending.get(requestKey);
    if (!pending) {
      pending=loadForecast(selection.city,today,{fetchImpl,now:timestamp,state});
      state.pending.set(requestKey,pending);
      pending.finally(()=>{if(state.pending.get(requestKey)===pending)state.pending.delete(requestKey);}).catch(()=>{});
    }
    await pending;
    entry=state.entries.get(key);
  } else {state.entries.delete(key);state.entries.set(key,entry);}
  if (!entry) throw new WeatherError('weather_missing_date','天气服务缺少目标日期预报，请手动填写气温。');
  const relevant=entry.hours.filter(row=>PERIODS[selection.period].includes(Number(row.time.slice(11,13))));
  const future=relevant.filter(row=>hourEpoch(row.time)>=timestamp);
  const remainingHours=future.length>0;
  // When the period is over, show its archived forecast with an explicit flag;
  // do not silently switch to tomorrow or present past hours as future data.
  const hours=(remainingHours?future:relevant).map(row=>({...row}));
  const values=field=>hours.map(row=>row[field]);
  return {
    status:'ok',city:{id:selection.city.id,name:selection.city.name},date,timezone:TIMEZONE,
    retrievedAt:new Date(entry.retrievedAt).toISOString(),expiresAt:new Date(entry.expiresAt).toISOString(),
    cacheStatus,period:selection.period,periodLabel:PERIODS[selection.period].label,remainingHours,
    source:{name:'Open-Meteo',url:'https://open-meteo.com/'},
    summary:{minTemperature:Math.min(...values('temperature')),maxTemperature:Math.max(...values('temperature')),
      minApparent:Math.min(...values('apparentTemperature')),maxApparent:Math.max(...values('apparentTemperature')),
      maxPrecipitationProbability:Math.max(...values('precipitationProbability')),maxWindSpeed:Math.max(...values('windSpeed'))},
    hours
  };
}

module.exports={CITIES,WeatherError,normalizeSelection,getWeather,clearWeatherCache};
