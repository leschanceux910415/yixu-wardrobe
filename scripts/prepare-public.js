'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const DOCS=['PRD.md','evaluation-method.md','research-plan.md'];
const REPORTS=['rule-report.md','hybrid-report.md'];
const SOURCE_FILES=['index.html','styles.css','app.js','case-study.html','case-study.js','assets/favicon.svg'];
const PUBLIC_FILES=[...SOURCE_FILES,...DOCS.map(x=>`docs/${x}`),...REPORTS.map(x=>`reports/${x}`)];

function walk(directory,relative='') {
  const files=[];
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const rel=relative?`${relative}/${entry.name}`:entry.name;
    const target=path.join(directory,entry.name);
    if(fs.lstatSync(target).isSymbolicLink())throw new Error(`公开目录不接受符号链接：${rel}`);
    if(entry.isDirectory())files.push(...walk(target,rel));else if(entry.isFile())files.push(rel);else throw new Error(`不支持的公开文件：${rel}`);
  }
  return files;
}
function preparePublic() {
  const publicRoot=path.join(root,'public');
  // Fail on unexpected static files instead of deleting a user's files or
  // accidentally publishing a raw result, private document, or local config.
  for(const rel of walk(publicRoot))if(!PUBLIC_FILES.includes(rel))throw new Error(`非白名单公开文件，请先移出public：${rel}`);
  for(const [source,relative] of [...DOCS.map(x=>[`docs/${x}`,`docs/${x}`]),...REPORTS.map(x=>[`eval/results/${x}`,`reports/${x}`])]) {
    const from=path.join(root,source),to=path.join(publicRoot,relative);
    if(!fs.existsSync(from)||fs.lstatSync(from).isSymbolicLink())throw new Error(`缺少可公开的源文件：${source}`);
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
  }
  for(const rel of PUBLIC_FILES)if(!fs.statSync(path.join(publicRoot,rel)).isFile())throw new Error(`缺少公开文件：${rel}`);
  console.log(`已准备${PUBLIC_FILES.length}个白名单公开文件，包含规则与增强版报告，不含密钥或逐题日志。`);
  return PUBLIC_FILES;
}
if(require.main===module)preparePublic();
module.exports={preparePublic,PUBLIC_FILES};
