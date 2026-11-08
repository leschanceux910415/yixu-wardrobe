'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {CITIES,WeatherError,normalizeSelection,getWeather,clearWeatherCache}=require('../lib/weather');
const stamp=local=>Date.parse(local+'+08:00');
function fixture(today='2026-11-08') {
  const next=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const hourly={time:[],temperature_2m:[],apparent_temperature:[],precipitation_probability:[],wind_speed_10m:[]};
  for(let index=0;index<48;index++) {
    const hour=index%24;
    hourly.time.push((index<24?today:next)+'T'+String(hour).padStart(2,'0')+':00');
    hourly.temperature_2m.push(hour);hourly.apparent_temperature.push(hour-2);
    hourly.precipitation_probability.push(hour*4);hourly.wind_speed_10m.push(hour+1);
  }
  return {timezone:'Asia/Shanghai',utc_offset_seconds:28800,hourly_units:{time:'iso8601',temperature_2m:'°C',apparent_temperature:'°C',precipitation_probability:'%',wind_speed_10m:'km/h'},hourly};
}
const reply=body=>({ok:true,json:async()=>structuredClone(body)});
const code=expected=>error=>error instanceof WeatherError&&error.code===expected;

test('fixed city catalog is complete and normalization supports IDs, Chinese aliases and canonical objects',()=>{
  assert.equal(CITIES.length,15);
  assert.equal(new Set(CITIES.map(city=>city.id)).size,15);
  assert.ok(CITIES.every(city=>city.timezone==='Asia/Shanghai'&&Number.isFinite(city.latitude)&&Number.isFinite(city.longitude)));
  assert.equal(normalizeSelection({city:'上海市'}).city.id,'shanghai');
  assert.equal(normalizeSelection({city:CITIES[0],day:'tomorrow',period:'all'}).city.id,'shanghai');
  assert.equal(normalizeSelection('BEIJING').city.id,'beijing');
  assert.deepEqual(normalizeSelection({},'明晚杭州').day,'tomorrow');
  assert.equal(normalizeSelection({},'明晚杭州').period,'evening');
});

test('unsupported inputs and query-selection conflicts produce explicit input codes',()=>{
  assert.throws(()=>normalizeSelection({city:'巴黎'}),code('weather_input_city'));
  assert.throws(()=>normalizeSelection({}),code('weather_input_city'));
  assert.throws(()=>normalizeSelection(null),code('weather_input_selection'));
  assert.throws(()=>normalizeSelection({city:'shanghai',day:'yesterday'}),code('weather_input_day'));
  assert.throws(()=>normalizeSelection({city:'shanghai',period:'night'}),code('weather_input_period'));
  assert.throws(()=>normalizeSelection({city:'shanghai'},'明天北京通勤'),code('weather_input_city_conflict'));
  assert.throws(()=>normalizeSelection({city:'shanghai',day:'today'},'明天通勤'),code('weather_input_day_conflict'));
  assert.throws(()=>normalizeSelection({},'上海和北京今天'),code('weather_input_city_ambiguous'));
  assert.throws(()=>normalizeSelection({city:'shanghai'},'今天或明天'),code('weather_input_day_ambiguous'));
  assert.throws(()=>normalizeSelection({city:'shanghai'},'后天通勤'),code('weather_input_day'));
});

test('past wearing history does not become a historical weather request while past weather and later travel remain unsupported',()=>{
  for(const query of ['今天通勤，避开昨天穿过的单品','今天通勤，不要前天穿了的衣服','今天通勤，昨天穿的那件外套不要重复','今天通勤，参考昨天的穿着记录']) {
    const selection=normalizeSelection({city:'shanghai',day:'today',period:'commute'},query);
    assert.equal(selection.day,'today');
  }
  for(const query of ['查询昨天天气','前天天气如何','昨天穿什么合适','后天去杭州旅行','大后天天气','昨天穿过黑色T恤，想查昨天天气']) {
    assert.throws(()=>normalizeSelection({city:query.includes('杭州')?'hangzhou':'shanghai'},query),code('weather_input_day'));
  }
});

test('today commute uses only upcoming selected hours and constructs fixed HTTPS unit-aware endpoint',async()=>{
  let requested;
  const fetchImpl=async(url,options)=>{requested={url:new URL(url),options};return reply(fixture());};
  const result=await getWeather({city:'shanghai',period:'commute'},{fetchImpl,now:stamp('2026-11-08T08:30:00')});
  assert.equal(requested.url.origin,'https://api.open-meteo.com');
  assert.equal(requested.url.pathname,'/v1/forecast');
  assert.equal(requested.url.searchParams.get('timezone'),'Asia/Shanghai');
  assert.equal(requested.url.searchParams.get('forecast_days'),'2');
  assert.equal(requested.url.searchParams.get('temperature_unit'),'celsius');
  assert.equal(requested.url.searchParams.get('wind_speed_unit'),'kmh');
  assert.equal(requested.options.method,'GET');assert.ok(requested.options.signal instanceof AbortSignal);
  assert.equal(result.date,'2026-11-08');assert.equal(result.cacheStatus,'fresh');
  assert.deepEqual(result.hours.map(row=>row.time.slice(11,13)),['09','17','18','19']);
  assert.deepEqual(result.summary,{minTemperature:9,maxTemperature:19,minApparent:7,maxApparent:17,maxPrecipitationProbability:76,maxWindSpeed:20});
  assert.equal(result.remainingHours,true);assert.equal(result.source.name,'Open-Meteo');
});

test('daytime, evening and all periods honor inclusive hours and tomorrow is not filtered as today',async()=>{
  const fetchImpl=async()=>reply(fixture());
  const now=stamp('2026-11-08T23:30:00');
  for(const [period,count,start,end] of [['daytime',9,'09','17'],['evening',5,'18','22'],['all',24,'00','23'],['commute',6,'07','19']]) {
    const result=await getWeather({city:'shanghai',day:'tomorrow',period},{fetchImpl,now});
    assert.equal(result.date,'2026-11-09');assert.equal(result.hours.length,count);
    assert.equal(result.hours[0].time.slice(11,13),start);assert.equal(result.hours.at(-1).time.slice(11,13),end);
    assert.equal(result.remainingHours,true);
  }
});

test('ended today period is returned with remainingHours false rather than quietly becoming tomorrow',async()=>{
  const fetchImpl=async()=>reply(fixture());
  const result=await getWeather({city:'shanghai',period:'commute'},{fetchImpl,now:stamp('2026-11-08T20:00:00')});
  assert.equal(result.remainingHours,false);assert.equal(result.date,'2026-11-08');
  assert.deepEqual(result.hours.map(row=>row.time.slice(11,13)),['07','08','09','17','18','19']);
});

test('midnight validation rejects stale provider dates and tomorrow handles December rollover',async()=>{
  await assert.rejects(getWeather({city:'beijing'},{fetchImpl:async()=>reply(fixture('2026-12-31')),now:Date.parse('2026-12-31T16:00:00Z')}),code('weather_invalid_response'));
  const result=await getWeather({city:'beijing',day:'tomorrow',period:'all'},{fetchImpl:async()=>reply(fixture('2026-12-31')),now:Date.parse('2026-12-31T15:59:00Z')});
  assert.equal(result.date,'2027-01-01');assert.equal(result.hours[0].time,'2027-01-01T00:00');
  const after=await getWeather({city:'beijing',period:'all'},{fetchImpl:async()=>reply(fixture('2027-01-01')),now:Date.parse('2026-12-31T16:00:00Z')});
  assert.equal(after.date,'2027-01-01');assert.equal(after.hours[0].time,'2027-01-01T00:00');
});

test('30 minute cache recomputes remaining hours, isolates fetch providers, expires and resists result mutation',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return reply(fixture());};
  const first=await getWeather({city:'shanghai',period:'all'},{fetchImpl,now:stamp('2026-11-08T08:50:00')});
  first.hours[0].temperature=999;
  const second=await getWeather({city:'shanghai',period:'all'},{fetchImpl,now:stamp('2026-11-08T09:10:00')});
  assert.equal(calls,1);assert.equal(second.cacheStatus,'hit');assert.equal(second.hours[0].time,'2026-11-08T10:00');
  assert.notEqual(second.hours[0].temperature,999);
  assert.equal(Date.parse(second.expiresAt)-Date.parse(second.retrievedAt),1800000);
  await getWeather({city:'shanghai'},{fetchImpl,now:stamp('2026-11-08T09:20:00')});assert.equal(calls,2);
  let otherCalls=0;const other=async()=>{otherCalls++;return reply(fixture());};
  await getWeather({city:'shanghai'},{fetchImpl:other,now:stamp('2026-11-08T09:20:00')});assert.equal(otherCalls,1);
  clearWeatherCache(fetchImpl);
  await getWeather({city:'shanghai'},{fetchImpl,now:stamp('2026-11-08T09:21:00')});assert.equal(calls,3);
});

test('concurrent same-city requests coalesce across both target dates and periods',async()=>{
  let release,calls=0;
  const fetchImpl=async()=>{calls++;await new Promise(resolve=>{release=resolve;});return reply(fixture());};
  const options={fetchImpl,now:stamp('2026-11-08T06:00:00')};
  const first=getWeather({city:'shanghai',period:'daytime'},options);
  const second=getWeather({city:'shanghai',day:'tomorrow',period:'evening'},options);
  release();const [a,b]=await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(a.date,'2026-11-08');assert.equal(b.date,'2026-11-09');
});

test('timeout aborts at five seconds even when injected fetch ignores its AbortSignal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let signal;
  const pending=getWeather({city:'shanghai'},{fetchImpl:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});},now:stamp('2026-11-08T06:00:00')});
  const assertion=assert.rejects(pending,code('weather_timeout'));
  t.mock.timers.tick(5000);await assertion;assert.equal(signal.aborted,true);
});

test('network, HTTP, provider and JSON failures are explicit, never a fabricated default forecast',async()=>{
  const now=stamp('2026-11-08T06:00:00');
  for(const [fetchImpl,expected] of [
    [async()=>{throw Error('offline');},'weather_network'],
    [async()=>({ok:false,json:async()=>({})}),'weather_http'],
    [async()=>reply({error:true,reason:'invalid coordinates'}),'weather_provider_error'],
    [async()=>({ok:true,json:async()=>{throw Error('bad JSON');}}),'weather_invalid_response'],
    [async()=>reply(null),'weather_invalid_response'],
    [async()=>null,'weather_invalid_response']
  ]) await assert.rejects(getWeather({city:'shanghai'},{fetchImpl,now}),code(expected));
});

test('strict response validation rejects nulls, mismatched arrays, units, timezone and impossible numeric values',async()=>{
  const mutations=[
    body=>{body.timezone='UTC';},body=>{body.utc_offset_seconds=0;},
    body=>{body.hourly_units.temperature_2m='°F';},body=>{body.hourly.time.pop();},
    body=>{body.hourly.temperature_2m[0]=null;},body=>{body.hourly.apparent_temperature[0]='8';},
    body=>{body.hourly.precipitation_probability[0]=101;},body=>{body.hourly.wind_speed_10m[0]=-1;},
    body=>{body.hourly.temperature_2m[0]=99;},body=>{body.hourly.time[1]=body.hourly.time[0];}
  ];
  for(const mutate of mutations) {
    const body=fixture();mutate(body);
    await assert.rejects(getWeather({city:'shanghai'},{fetchImpl:async()=>reply(body),now:stamp('2026-11-08T06:00:00')}),error=>error instanceof WeatherError&&!error.code.startsWith('weather_input_'));
  }
});

test('failed requests are not cached and default clock is evaluated per invocation',async t=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;if(calls===1)throw Error('offline');return reply(fixture());};
  const now=stamp('2026-11-08T06:00:00');
  await assert.rejects(getWeather({city:'shanghai'},{fetchImpl,now}));
  assert.equal((await getWeather({city:'shanghai'},{fetchImpl,now})).status,'ok');assert.equal(calls,2);
  let clock=stamp('2026-11-08T06:00:00');
  t.mock.method(Date,'now',()=>clock);
  const isolated=async()=>reply(fixture());
  const a=await getWeather({city:'shanghai',period:'all'},{fetchImpl:isolated});
  clock=stamp('2026-11-08T06:10:00');
  const b=await getWeather({city:'shanghai',period:'all'},{fetchImpl:isolated});
  assert.equal(a.hours[0].time,'2026-11-08T06:00');assert.equal(b.hours[0].time,'2026-11-08T07:00');
});
