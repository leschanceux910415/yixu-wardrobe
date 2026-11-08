'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {ROOT}=require('./config');
const {requestAllowed}=require('./limits');
const service=require('./service');
const weatherTools=require('./weather');
function json(res,status,payload,cacheControl='no-store') {
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control',cacheControl);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.end(JSON.stringify(payload));
}
async function readBody(req) {
  const contentType=req.headers['content-type']||'';
  if (!contentType.toLowerCase().includes('application/json')) throw Object.assign(new Error('请使用application/json提交。'),{status:415});
  if (Number(req.headers['content-length'])>160000) throw Object.assign(new Error('请求内容过大。'),{status:413});
  if (req.body!==undefined) {
    if (typeof req.body==='string') {try {return JSON.parse(req.body);} catch {throw Object.assign(new Error('JSON格式无效。'),{status:400});}}
    return req.body;
  }
  const chunks=[];let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>160000) throw Object.assign(new Error('请求内容过大。'),{status:413});chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw Object.assign(new Error('JSON格式无效。'),{status:400});}
}
async function api(req,res,route) {
  const expected=route==='outfit'||route==='recognize'?'POST':'GET';
  if(req.method!==expected) {res.setHeader('Allow',expected);return json(res,405,{error:`请使用${expected}。`});}
  try {
    if(route==='health') return json(res,200,service.health());
    if(route==='wardrobe') return json(res,200,service.DATA);
    if(route==='weather') {
      const params=new URL(req.url,'http://local').searchParams;
      if(params.get('catalog')==='1') return json(res,200,{cities:weatherTools.CITIES.map(({id,name})=>({id,name})),periods:[{id:'commute',name:'早晚通勤'},{id:'daytime',name:'白天'},{id:'evening',name:'晚上'},{id:'all',name:'全天'}]},'public, max-age=3600, s-maxage=86400');
      if(!requestAllowed(String(req.socket?.remoteAddress||'serverless'))) return json(res,429,{error:'查询过于频繁，请稍后重试。'});
      try {
        const snapshot=await weatherTools.getWeather({city:params.get('city'),day:params.get('day')||'today',period:params.get('period')||'commute'});
        // Cache only public city forecasts, never personalized outfit responses.
        // End edge caching before the next hour, including local midnight.
        const ttl=Math.max(1,Math.min(300,Math.floor((3600000-Date.now()%3600000)/1000)));
        return json(res,200,snapshot,`public, max-age=0, s-maxage=${ttl}`);
      } catch(error) {return json(res,String(error.code).startsWith('weather_input_')?400:502,{error:error.message||'天气服务暂不可用。',code:error.code||'weather_unavailable'});}
    }
    if(route==='evaluation') {
      const requested=new URL(req.url,'http://local').searchParams.get('version')||'rule';
      if(!['rule','hybrid','direct'].includes(requested)) return json(res,400,{error:'评测版本无效。'});
      const file=path.join(ROOT,'eval','results',`${requested}-summary.json`);
      if(!fs.existsSync(file)) return json(res,200,{status:'pending',note:'尚无已运行的评测摘要。'});
      return json(res,200,JSON.parse(fs.readFileSync(file,'utf8')));
    }
    if(route==='recognize') return json(res,501,{error:'本阶段先使用手动确认属性，图片识别尚未启用。',mode:'manual',item:null});
    if(route!=='outfit') return json(res,404,{error:'接口不存在。'});
    const ip=String(req.socket?.remoteAddress||'serverless');
    if(!requestAllowed(ip)) return json(res,429,{error:'请求过于频繁，请稍后重试。'});
    const origin=req.headers.origin;
    if(origin) {let host;try{host=new URL(origin).host;}catch{return json(res,403,{error:'请求来源无效。'});}if(host!==req.headers.host)return json(res,403,{error:'请从本应用页面提交请求。'});}
    const result=await service.handleOutfit(await readBody(req),{ip});
    return json(res,200,result);
  } catch(error) {
    return json(res,error instanceof service.InputError?400:error.status||500,{error:error instanceof service.InputError||error.status?error.message:'服务暂不可用，请稍后重试。'});
  }
}
module.exports={api,json,readBody};
