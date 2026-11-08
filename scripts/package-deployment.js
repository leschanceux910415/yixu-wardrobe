'use strict';
// A dependency-free deployment ZIP with a precise source allowlist. The ZIP
// starts directly at project root and never includes .env, raw evaluations,
// personal materials, logs, tests, node_modules, or an enclosing folder.
// Vercel dashboard: project yixu-wardrobe, Framework Preset "Other". Keep the
// buildCommand/outputDirectory in vercel.json; do not select a Node framework.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {preparePublic,PUBLIC_FILES}=require('./prepare-public');
const root=path.resolve(__dirname,'..');
const SOURCE_FILES=[
  'package.json','vercel.json','.vercelignore','server.js',
  ...['outfit','health','wardrobe','evaluation','recognize','weather'].map(x=>`api/${x}.js`),
  ...['config','core','http','limits','llm','service','weather','weather-advice'].map(x=>`lib/${x}.js`),
  'data/wardrobe.json',
  ...['PRD.md','evaluation-method.md','research-plan.md','deployment-guide.md'].map(x=>`docs/${x}`),
  ...['rule-summary.json','hybrid-summary.json','rule-report.md','hybrid-report.md'].map(x=>`eval/results/${x}`),
  'scripts/prepare-public.js','scripts/package-deployment.js',
  ...PUBLIC_FILES.map(x=>`public/${x}`)
];
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(data){let crc=0xffffffff;for(const byte of data)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function zipStore(entries){
  const local=[],central=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.path,'utf8'),data=entry.data,crc=crc32(data);
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(0,8);h.writeUInt16LE(0,10);h.writeUInt16LE(0x21,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(0,10);c.writeUInt16LE(0,12);c.writeUInt16LE(0x21,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
    local.push(h,name,data);central.push(c,name);offset+=h.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
function validateSummary(relative,version){
  const summary=JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));
  if(summary.requestedVersion!==version||!Number.isInteger(summary.denominator)||summary.denominator<1||!Number.isInteger(summary.outcomePassed)||summary.outcomePassed>summary.denominator)throw new Error(`评测摘要不可验证：${relative}`);
  if(summary.datasetKind!=='manually_constructed_development_regression')throw new Error(`需要人工审查新的题库类型：${relative}`);
  if(!Array.isArray(summary.limitations)||!summary.limitations.length)throw new Error(`评测摘要缺少限制说明：${relative}`);
  if(version==='hybrid'&&(!Number.isInteger(summary.modelExecuted)||!Number.isInteger(summary.fallbackCount)))throw new Error('增强版摘要必须分开统计真实执行与降级。');
}
function readEntries(){
  preparePublic();
  validateSummary('eval/results/rule-summary.json','rule');validateSummary('eval/results/hybrid-summary.json','hybrid');
  const seen=new Set();return SOURCE_FILES.map(relative=>{
    if(seen.has(relative))throw new Error(`重复白名单：${relative}`);seen.add(relative);
    if(relative.startsWith('/')||relative.split('/').some(x=>x==='..'||x==='.env'||x.startsWith('.env.')||x==='logs'||x==='node_modules')||/results\.(?:json|csv)$/.test(relative))throw new Error(`禁止打包：${relative}`);
    const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`必须是普通文件：${relative}`);
    const data=fs.readFileSync(absolute);
    // Reject literal provider tokens. Configuration variable names are fine.
    if(/\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/.test(data.toString('utf8')))throw new Error(`疑似密钥，请在本地检查：${relative}`);
    return {path:relative,data,bytes:data.length,sha256:sha256(data)};
  });
}
function packageDeployment({checkOnly=false}={}){
  const entries=readEntries();
  console.log('Vercel导入设置：项目yixu-wardrobe；Framework Preset选择Other；使用vercel.json中的构建命令与public输出目录。');
  const metadata={format:'yixu-exact-allowlist-v1',createdAt:new Date().toISOString(),fileCount:entries.length,uncompressedBytes:entries.reduce((n,x)=>n+x.bytes,0),excluded:['.env*','logs/','raw per-case evaluation results','personal resumes and interview records','node_modules/','.vercel/','tests/'],files:entries.map(({path,bytes,sha256})=>({path,bytes,sha256}))};
  if(checkOnly){console.log(`部署白名单校验通过：${entries.length}个文件，${metadata.uncompressedBytes}字节。未生成ZIP。`);return metadata;}
  const outputDirectory=path.resolve(root,'..','releases');fs.mkdirSync(outputDirectory,{recursive:true});
  const archive=zipStore(entries),zipPath=path.join(outputDirectory,'yixu-vercel-source.zip'),manifestPath=path.join(outputDirectory,'yixu-vercel-source.manifest.json');
  metadata.zipSha256=sha256(archive);metadata.zipBytes=archive.length;
  fs.writeFileSync(zipPath,archive);fs.writeFileSync(manifestPath,JSON.stringify(metadata,null,2)+'\n');
  console.log(`部署包：${zipPath}\n清单：${manifestPath}\n文件数：${entries.length}；ZIP SHA256：${metadata.zipSha256}`);
  return {zipPath,manifestPath,...metadata};
}
if(require.main===module)packageDeployment({checkOnly:process.argv.includes('--check')});
module.exports={packageDeployment,SOURCE_FILES,zipStore};
