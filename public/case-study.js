'use strict';
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=String(text);if(className)el.className=className;return el;};
const count=value=>Number.isInteger(value)&&value>=0?value:null;
const display=value=>value===null?'—':String(value);
function metric(value,label,detail){const card=node('div',undefined,'metric-card');card.append(node('strong',value),node('span',label));if(detail)card.append(node('small',detail));return card;}
function renderSummary(target,data,version){
  target.replaceChildren();
  if(!data||data.status==='pending'||data.requestedVersion!==version||count(data.denominator)===null){target.append(node('p',version==='rule'?'尚无可读取的规则评测结果。':'尚无可读取的增强版评测结果；不会用规则结果代替。','summary-pending'));return;}
  const total=count(data.denominator),passed=count(data.outcomePassed),modelExecuted=count(data.modelExecuted),modelPassed=count(data.modelPassed),fallbacks=count(data.fallbackCount);
  const cards=node('div',undefined,'metric-cards');
  if(version==='rule'){
    cards.append(metric(`${display(passed)}/${total}`,'开发回归行为通过','固定题目分母'),metric(display(count(data.falseConflicts)),'可满足任务误报无解','仅限本批构造题'),metric(Number.isFinite(data.latencyP95Ms)?`${data.latencyP95Ms} ms`:'—','本次执行 P95','非网页端到端耗时'));
  }else{
    cards.append(metric(`${display(modelExecuted)}/${total}`,'模型完整执行','降级单独统计'),metric(modelExecuted===0?'待验证':`${display(modelPassed)}/${display(modelExecuted)}`,'模型执行且行为通过','不代表偏好质量'),metric(display(fallbacks),'降级次数','降级不算模型执行'));
  }
  target.append(cards);
  if(version==='hybrid'&&modelExecuted===0)target.append(node('p','本次没有完整执行模型流程，因此不能据此报告模型效果或AI提升。','summary-note'));
  if(version==='hybrid')target.append(node('p',`增强版请求的整体预期行为通过：${display(passed)}/${total}。这一计数可能包含规则降级，必须与模型完整执行数区分。`,'summary-note'));
  const generated=new Date(data.generatedAt);const timestamp=Number.isNaN(generated.getTime())?'未提供':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(generated);
  target.append(node('p',`生成时间：${timestamp}；题库：${data.fixtureVersion||'版本未提供'}；执行错误：${display(count(data.executionErrors))}。`,'summary-note'));
  if(Array.isArray(data.limitations)&&data.limitations.length){const list=node('ul',undefined,'summary-limitations');for(const limitation of data.limitations.slice(0,6))list.append(node('li',limitation));target.append(list);}
}
async function loadSummary(version){
  const target=document.getElementById(`${version}-evaluation`);
  try{const response=await fetch(version==='rule'?'/api/evaluation':'/api/evaluation?version=hybrid',{cache:'no-store'});if(!response.ok)throw Error();renderSummary(target,await response.json(),version);}
  catch{target.replaceChildren(node('p','当前无法读取该版本摘要，请查看项目目录中的实际评测报告。','summary-pending'));}
}
fetch('/api/health').then(response=>{if(!response.ok)throw Error();return response.json();}).then(health=>{document.getElementById('case-model-status').textContent=health.modelConfigured?'模型接口已配置':'当前为规则基线';document.getElementById('runtime-status').textContent=health.modelConfigured?'当前服务已配置模型接口。每次请求仍需记录真实执行模式、成功与降级，配置状态本身不代表效果验证通过。':'当前没有配置模型，产品以规则基线运行。真实模型版测评、用户研究和公网部署状态需要分别验证。';}).catch(()=>{document.getElementById('case-model-status').textContent='运行状态待检查';document.getElementById('runtime-status').textContent='暂时无法读取服务状态，请确认本地服务正在运行。';});
Promise.allSettled([loadSummary('rule'),loadSummary('hybrid')]);
