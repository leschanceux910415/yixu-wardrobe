'use strict';
// Only observed weather and recorded wardrobe fields may become displayed facts.
// The model chooses from these eligible statements; free-form model prose is not
// presented as a verified weather or garment property.
function adviceOptions(outfit, weather, request) {
  const options = {};
  const outer = outfit.items.find(x=>x.category==='outer');
  const s = weather?.status==='ok' ? weather.summary : null;
  const label = weather?.periodLabel || '所选时段';
  if (s && s.maxApparent-s.minApparent>=6 && outer) options.layering=`${label}预报体感温差为${Math.round((s.maxApparent-s.minApparent)*10)/10}℃；这套包含${outer.name}，可按实际体感增减外层。`;
  if (s && s.maxPrecipitationProbability>=40) options.rain=`${label}最高降水概率为${s.maxPrecipitationProbability}%，可考虑带伞；衣橱未确认防水属性，不能保证这套防雨。`;
  if (s && s.maxWindSpeed>=20) options.wind=`${label}预报最高风速${s.maxWindSpeed}km/h；衣物防风性能未知，出门前请结合实际情况确认。`;
  if (request.preferences.includes('更保暖')) options.warmth=`已考虑你怕冷、偏保暖的要求；厚薄是衣橱记录的相对属性，仍需结合真实体感。`;
  if (request.preferences.includes('轻薄')) options.light=`已考虑轻薄偏好；可按当天体感确认是否需要增减衣物。`;
  options.scene=`从符合你锁定、排除和裙裤要求的候选中，综合已记录的厚薄与正式度选择。`;
  return options;
}
function weatherReason(weather, influence) {
  if (weather?.status!=='ok') return weather?.status==='unavailable'?'天气暂不可用，本次没有使用实时天气作依据。':'';
  const s=weather.summary;
  return `${weather.city.name} ${weather.date} ${weather.periodLabel}，预报气温${s.minTemperature}–${s.maxTemperature}℃、体感${s.minApparent}–${s.maxApparent}℃。${influence.temperatureSource==='weather'?`厚薄偏好参考所选时段最低体感${influence.effectiveTemperature}℃。`:influence.temperatureSource==='manual'?`厚薄偏好采用你填写的${influence.effectiveTemperature}℃，未被天气覆盖。`:'本次未按气温调整厚薄偏好。'}${weather.remainingHours===false?'该时段已结束，以上为该时段预报，非接下来的天气。':''}`;
}
function verifiedAdvice(outfit, codes, weather, request) {
  const options=adviceOptions(outfit,weather,request);
  return [...new Set(Array.isArray(codes)?codes:[])].filter(x=>Object.hasOwn(options,x)).slice(0,3).map(x=>options[x]).join(' ');
}
module.exports={adviceOptions,weatherReason,verifiedAdvice};
