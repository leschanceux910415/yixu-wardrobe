'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {evaluateResponse, summarize} = require('./evaluator');
const PROJECT = path.resolve(__dirname, '..');
const hash = input => crypto.createHash('sha256').update(input).digest('hex');

function parseArgs(args) {
  const options = {version: 'rule', baseUrl: 'http://127.0.0.1:5173', outDir: path.join(__dirname, 'results'), maxCases: Infinity};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    const value = args[++index];
    if (!value) throw new Error(`参数 ${key} 缺少值`);
    if (key === '--version') options.version = value;
    else if (key === '--base-url') options.baseUrl = value.replace(/\/$/, '');
    else if (key === '--out-dir') options.outDir = path.resolve(value);
    else if (key === '--max-cases') options.maxCases = Number(value);
    else if (key === '--case-ids') options.caseIds = value.split(',').map(id=>id.trim()).filter(Boolean);
    else throw new Error(`未知参数 ${key}`);
  }
  if (!['rule','hybrid','direct'].includes(options.version)) throw new Error('version 必须是 rule、hybrid 或 direct');
  if (!(options.maxCases > 0)) throw new Error('max-cases 必须大于0');
  return options;
}

function loadDataset() {
  const caseBytes = fs.readFileSync(path.join(__dirname, 'cases.jsonl'));
  const fixtureBytes = fs.readFileSync(path.join(__dirname, 'fixtures.json'));
  return {
    cases: caseBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)),
    fixture: JSON.parse(fixtureBytes),
    hashes: {cases: hash(caseBytes), fixtures: hash(fixtureBytes)}
  };
}

const csvCell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
function recordsCsv(records) {
  const headers = ['id','stratum','source','split','requested_version','actual_mode','model_executed','expected_status','expected_feasible','actual_status','passed','failed_checks','false_conflict','false_success','fallback_code','transport_elapsed_ms','api_elapsed_ms','usage_json','output_ids','execution_error'];
  const rows = records.map(record => [record.id, record.stratum, record.source, record.split,
    record.requestedVersion, record.evaluation?.actualMode, record.evaluation?.modelExecuted || false,
    JSON.stringify(record.expected.status), record.expected.feasible,
    record.response?.status, record.evaluation?.pass || false,
    record.evaluation ? Object.entries(record.evaluation.checks).filter(([,pass])=>!pass).map(([key])=>key).join('|') : 'executionError',
    record.evaluation?.falseConflict || false, record.evaluation?.falseSuccess || false,
    record.response?.fallback?.code || '', record.elapsedMs, record.apiElapsedMs,
    JSON.stringify(record.response?.meta?.usage || null),
    JSON.stringify((record.response?.outfits || []).map(outfit=>outfit.itemIds)), record.executionError || ''
  ]);
  return '\uFEFF' + [headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function summaryMarkdown(manifest, summary, records) {
  const failed = records.filter(record=>!record.evaluation?.pass);
  return `# 衣序开发与回归评测记录\n\n运行时间：${manifest.startedAt}。请求版本：${summary.requestedVersion}。\n\n` +
    `样本来源：人工构造的开发与工程回归用例。可满足性逐题预标，采用固定分母统计，冲突用例保留在对应分组。\n\n` +
    `| 项目 | 本次记录 |\n|---|---:|\n| 固定用例分母 | ${summary.denominator} |\n| 路径输出符合预标期待 | ${summary.outcomePassed}/${summary.denominator} |\n| 预标可满足 / 不可满足 | ${summary.feasibleLabels} / ${summary.infeasibleLabels} |\n| 错误报告冲突 / 错误报告成功 | ${summary.falseConflicts} / ${summary.falseSuccesses} |\n| 执行错误 | ${summary.executionErrors} |\n| 实际模型执行 | ${summary.modelExecuted} |\n| 模型未执行 | ${summary.modelNotExecuted} |\n| 明确降级 | ${summary.fallbackCount} |\n| 观察时延中位数 / P95 ms | ${summary.latencyMedianMs ?? '无'} / ${summary.latencyP95Ms ?? '无'} |\n\n` +
    (summary.requestedVersion !== 'rule' ? `模型执行组：${summary.modelPassed}/${summary.modelExecuted}，按实际执行模型且完成请求的样本统计；分母为0时保留原始计数。路径输出统计覆盖全部请求，规则回退单列。\n\n` : `规则排序采用启发式分数，评测依据预标结果与显式约束。近期少重复为软偏好，明确排除单品为硬条件。\n\n`) +
    `| 分层 | 符合期待 / 固定分母 |\n|---|---:|\n${Object.entries(summary.strata).map(([name,stats])=>`| ${name} | ${stats.passed}/${stats.total} |`).join('\n')}\n\n` +
    `## 未通过用例\n\n${failed.length ? failed.map(record=>`- ${record.id}：${record.executionError || Object.entries(record.evaluation.checks).filter(([,pass])=>!pass).map(([key])=>key).join('、')}`).join('\n') : '本次开发回归用例全部符合预标期待。'}\n\n` +
    `## 数据与统计口径\n\n本报告统计预标匹配、显式约束、执行模式、降级与时延，各题按场景分组。API usage 保存服务端原始返回，费用按实际价格配置换算。\n\n` +
    `时延采用runner端完整请求墙钟时间，API的meta.elapsedMs在逐题JSON/CSV中单列。原始meta.modelStages记录解析、重排等阶段，模型执行样本按实际模式与降级标记分组。\n\n` +
    `数据版本：${manifest.fixtureVersion}。题库 SHA256：${manifest.hashes.cases}。衣橱 SHA256：${manifest.hashes.fixtures}。核心 SHA256：${manifest.hashes.core || '未读取'}。\n`;
}

async function run(options = parseArgs(process.argv.slice(2))) {
  const dataset = loadDataset();
  if (options.caseIds?.some(id=>!dataset.cases.some(item=>item.id===id))) throw new Error('case-ids 包含不存在的题号');
  const cases = dataset.cases.filter(item=>!options.caseIds || options.caseIds.includes(item.id)).slice(0, options.maxCases);
  const manifest = {
    startedAt: new Date().toISOString(), runtime: process.version, requestedVersion: options.version,
    baseUrl: options.version === 'rule' ? null : options.baseUrl,
    fixtureVersion: dataset.fixture.version, datasetKind: 'manually_constructed_development_regression',
    selectedCaseIds: cases.map(item=>item.id),
    hashes: {...dataset.hashes,evaluator:hash(fs.readFileSync(path.join(__dirname,'evaluator.js'))),
      runner:hash(fs.readFileSync(__filename))}, health: null
  };
  const coreFile = path.join(PROJECT, 'lib/core.js');
  if (fs.existsSync(coreFile)) manifest.hashes.core = hash(fs.readFileSync(coreFile));
  for (const name of ['service','llm','config']) manifest.hashes[name] = hash(fs.readFileSync(path.join(PROJECT, 'lib', name + '.js')));
  let core;
  if (options.version === 'rule') core = require(coreFile);
  else {
    try {
      const healthResponse = await fetch(options.baseUrl + '/api/health', {signal: AbortSignal.timeout(10000)});
      const health = await healthResponse.json();
      manifest.health = {httpStatus:healthResponse.status, ok:health.ok, version:health.version, modelConfigured:health.modelConfigured, mode:health.mode};
    } catch (error) {manifest.health = {error:error.message};}
  }
  const records = [];
  for (const testCase of cases) {
    const wardrobe = testCase.wardrobeIds ? dataset.fixture.items.filter(item=>testCase.wardrobeIds.includes(item.id)) : dataset.fixture.items;
    const record = {id:testCase.id, query:testCase.query, stratum:testCase.stratum, source:testCase.source,
      split:testCase.split, requestedVersion:options.version, expected:testCase.expected, note:testCase.note || '',
      wardrobeIds:wardrobe.map(item=>item.id), response:null, executionError:null};
    const start = performance.now();
    try {
      if (options.version === 'rule') {
        const parsed = core.parseQuery(testCase.query, wardrobe, testCase.previous || {});
        const request = core.normalizeRequest({...parsed,...testCase.overrides}, wardrobe);
        record.response = {...core.solve(wardrobe, request, {limit:3,candidateLimit:12}),
          mode:'rule',requestedVersion:'rule',model:null,fallback:null};
      } else {
        const apiResponse = await fetch(options.baseUrl + '/api/outfit', {
          method:'POST', headers:{'content-type':'application/json'}, signal:AbortSignal.timeout(60000),
          body:JSON.stringify({query:testCase.query, version:options.version, previous:testCase.previous,
            overrides:testCase.overrides, wardrobe})
        });
        record.response = await apiResponse.json();
        record.httpStatus = apiResponse.status;
        if (!apiResponse.ok) throw new Error(`HTTP ${apiResponse.status}: ${record.response.error || '调用失败'}`);
      }
      record.apiElapsedMs = Number.isFinite(record.response?.meta?.elapsedMs) ? record.response.meta.elapsedMs : null;
      record.evaluation = evaluateResponse(testCase, record.response, wardrobe, options.version);
    } catch (error) {record.executionError = error.message;}
    record.elapsedMs = Math.round((performance.now()-start)*100)/100;
    records.push(record);
  }
  const summary = summarize(records, options.version);
  manifest.completedAt = new Date().toISOString();
  fs.mkdirSync(options.outDir, {recursive:true});
  const fileBase = path.join(options.outDir, options.version);
  const publicSummary = {...summary,generatedAt:manifest.completedAt,datasetKind:manifest.datasetKind,
    fixtureVersion:manifest.fixtureVersion,hashes:manifest.hashes,
    limitations:['样本来源：人工构造的开发回归用例','评分依据：预标状态与显式约束','统计分组：按场景、实际执行模式和降级状态','计时方式：runner端完整请求墙钟时间']};
  fs.writeFileSync(fileBase + '-results.json', JSON.stringify({manifest,summary,records},null,2)+'\n');
  fs.writeFileSync(fileBase + '-results.csv', recordsCsv(records));
  fs.writeFileSync(fileBase + '-summary.json', JSON.stringify(publicSummary,null,2)+'\n');
  fs.writeFileSync(fileBase + '-report.md', summaryMarkdown(manifest,summary,records));
  console.log(JSON.stringify({summary,files:[fileBase+'-results.json',fileBase+'-results.csv',fileBase+'-summary.json',fileBase+'-report.md']},null,2));
  return {manifest,summary,records};
}

if (require.main === module) run().then(result=>{if(result.summary.outcomePassed!==result.summary.denominator)process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={parseArgs,loadDataset,recordsCsv,summaryMarkdown,run};
