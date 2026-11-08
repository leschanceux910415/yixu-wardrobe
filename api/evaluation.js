'use strict';
// Vercel may populate req.query in addition to req.url. Preserve the documented
// version selector in either runtime; the shared handler enforces its allowlist.
module.exports=(req,res)=>{
  if(req.query&&typeof req.query.version==='string') {
    const url=new URL(req.url||'/api/evaluation','http://local');
    if(!url.searchParams.has('version')){url.searchParams.set('version',req.query.version);req.url=url.pathname+url.search;}
  }
  return require('../lib/http').api(req,res,'evaluation');
};
