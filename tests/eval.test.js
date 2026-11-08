'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {inspectOutfit,evaluateResponse,summarize} = require('../eval/evaluator');
const {loadDataset,recordsCsv,parseArgs,summaryMarkdown} = require('../eval/run');
const wardrobe = require('../eval/fixtures.json').items;
const valid = {itemIds:['T01','B01','S01'],checks:{everything:true},pass:true};
const baselineCase = {expected:{status:'ok',feasible:true}};

test('independent evaluator rejects fabricated IDs even when product reports all checks passed',()=>{
  const result=inspectOutfit({...valid,itemIds:['FAKE','B01','S01']},wardrobe,{});
  assert.equal(result.pass,false);
  assert.equal(result.checks.inWardrobe,false);
  assert.equal(result.checks.complete,false);
});

test('independent evaluator rejects incomplete or duplicate-slot outfits',()=>{
  assert.equal(inspectOutfit({itemIds:['T01','B01']},wardrobe).pass,false);
  assert.equal(inspectOutfit({itemIds:['T01','T02','B01','S01']},wardrobe).pass,false);
  assert.equal(inspectOutfit({itemIds:['T01','B01','S01','S01']},wardrobe).pass,false);
});

test('prelabelled user intent catches a parser that silently drops a ban',()=>{
  const testCase={expected:{status:'ok',feasible:true,request:{excludedColors:['黑']},constraints:{excludedColors:['黑']}}};
  const result=evaluateResponse(testCase,{status:'ok',request:{excludedColors:[]},outfits:[valid]},wardrobe);
  assert.equal(result.checks.expectedParsing,false);
  assert.equal(result.checks.independentConstraints,false);
  assert.equal(result.pass,false);
});

test('soft temperature and recent preferences never manufacture infeasibility',()=>{
  const outfit={itemIds:['T02','B03','S02']};
  assert.equal(inspectOutfit(outfit,wardrobe,{temperature:4,scene:'formal',avoidRecent:true,recentIds:outfit.itemIds}).pass,true);
});

test('system-reported conflict remains in the fixed feasible denominator',()=>{
  const response={status:'conflict',outfits:[],diagnosis:{message:'模型说无解'}};
  const evaluation=evaluateResponse(baselineCase,response,wardrobe);
  assert.equal(evaluation.falseConflict,true);
  assert.equal(evaluation.pass,false);
  const summary=summarize([{expected:baselineCase.expected,stratum:'test',evaluation,response,elapsedMs:1}], 'rule');
  assert.equal(summary.denominator,1);
  assert.equal(summary.feasibleLabels,1);
  assert.equal(summary.falseConflicts,1);
});

test('fallback output is never counted as actual model execution',()=>{
  const response={status:'ok',mode:'rule',requestedVersion:'hybrid',model:null,
    fallback:{code:'MODEL_NOT_CONFIGURED',message:'规则回退'},outfits:[valid],request:{}};
  const evaluation=evaluateResponse(baselineCase,response,wardrobe,'hybrid');
  assert.equal(evaluation.pass,true);
  assert.equal(evaluation.modelExecuted,false);
  const summary=summarize([{expected:baselineCase.expected,stratum:'test',evaluation,response,elapsedMs:1}], 'hybrid');
  assert.equal(summary.outcomePassed,1);
  assert.equal(summary.modelPassed,0);
  assert.equal(summary.modelExecuted,0);
  assert.equal(summary.modelNotExecuted,1);
  assert.equal(evaluateResponse(baselineCase,{...response,mode:'hybrid',model:'test-only-model',
    meta:{modelStages:{parse:{success:true},rerank:{success:false}}}},wardrobe,'hybrid').modelExecuted,false);
});

test('unsupported constraints require a concrete limitation notice',()=>{
  const testCase={expected:{status:['ok','clarify'],feasible:null,requiresNotice:true}};
  assert.equal(evaluateResponse(testCase,{status:'ok',outfits:[valid],request:{}},wardrobe).pass,false);
  assert.equal(evaluateResponse(testCase,{status:'ok',outfits:[valid],request:{warnings:['未提供气温，可补充气温。']}},wardrobe).pass,false);
  assert.equal(evaluateResponse(testCase,{status:'clarify',outfits:[],request:{clarifications:['材质未知，无法确认']}},wardrobe).pass,true);
});

test('dataset provenance and prelabels are explicit and unique',()=>{
  const dataset=loadDataset();
  assert.ok(dataset.cases.length>=30);
  assert.equal(new Set(dataset.cases.map(item=>item.id)).size,dataset.cases.length);
  for(const item of dataset.cases){
    assert.equal(item.source,'manually_constructed');
    assert.equal(item.split,'development_regression');
    assert.ok([true,false,null].includes(item.expected.feasible));
  }
  assert.equal(dataset.cases.find(item=>item.id==='D05').expected.feasible,true);
});

test('CLI rejects unknown modes and preserves model reporting limitations',()=>{
  assert.throws(()=>parseArgs(['--version','fictional']));
  assert.equal(parseArgs(['--version','direct','--base-url','http://localhost:9000/']).baseUrl,'http://localhost:9000');
  const record={id:'Q,1',query:'测试',stratum:'test',source:'manually_constructed',split:'development_regression',expected:{status:'ok',feasible:true},requestedVersion:'direct',executionError:'x,"y"'};
  assert.ok(recordsCsv([record]).includes('"Q,1"'));
  assert.ok(recordsCsv([record]).includes('"x,""y"""'));
  const summary=summarize([record],'direct');
  const text=summaryMarkdown({startedAt:'test',fixtureVersion:'test',hashes:{cases:'a',fixtures:'b'}},summary,[record]);
  assert.ok(text.includes('0/0'));
  assert.ok(text.includes('不报告 Recall 或 NDCG'));
});
