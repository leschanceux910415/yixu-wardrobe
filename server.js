'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {ROOT,getConfig}=require('./lib/config');
const {api,json}=require('./lib/http');
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.md':'text/plain; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.csv':'text/csv; charset=utf-8'};
function createServer() {
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    let pathname;
    try{pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);}catch{return json(res,400,{error:'地址格式无效。'});}
    if(pathname.startsWith('/api/')) return api(req,res,pathname.slice(5));
    if(!['GET','HEAD'].includes(req.method)) {res.setHeader('Allow','GET, HEAD');return json(res,405,{error:'请使用GET。'});}
    let root=path.join(ROOT,'public'),relative=pathname==='/'?'index.html':pathname.slice(1);
    if(pathname.startsWith('/docs/')) {relative=pathname.slice(6);if(!['PRD.md','evaluation-method.md','research-plan.md'].includes(relative))return json(res,404,{error:'文件不存在。'});root=path.join(ROOT,'docs');}
    if(/^\/reports\/(rule|hybrid|direct)-report\.md$/.test(pathname)) {root=path.join(ROOT,'eval','results');relative=pathname.slice(9);}
    const target=path.resolve(root,relative);
    if(!target.startsWith(root+path.sep)||relative.split(/[\\/]/).some(x=>x.startsWith('.'))) return json(res,404,{error:'文件不存在。'});
    try{
      const stat=await fs.promises.stat(target);
      if(!stat.isFile())return json(res,404,{error:'文件不存在。'});
      res.setHeader('Content-Type',MIME[path.extname(target)]||'application/octet-stream');
      res.setHeader('Cache-Control','no-cache');
      if(req.method==='HEAD')return res.end();
      fs.createReadStream(target).pipe(res);
    }catch{return json(res,404,{error:'文件不存在。'});}
  });
}
if(require.main===module){const config=getConfig();createServer().listen(config.port,config.host,()=>{console.log(`衣序已启动：http://${config.host}:${config.port}`);console.log(config.configured?'模型配置已就绪；请求时验证实际连通性。':'规则模式可用；在本机.env填写模型配置即可启用增强版。');});}
module.exports={createServer};
