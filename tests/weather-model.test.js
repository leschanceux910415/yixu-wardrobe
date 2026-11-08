'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {rankWeatherWithModel}=require('../lib/llm');
const {DATA}=require('../lib/service');
const core=require('../lib/core');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'yixu-weather-model-'));
const config={root,configured:true,key:'fake-test-key',baseUrl:'https://model.invalid',model:'test-only',publicDeployment:false,dailyLimit:100,timeoutMs:1000,jsonMode:true,maxTokens:1600};
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const request=core.parseQuery('通勤，不穿裙子',DATA.items);
const candidates=core.solve(DATA.items,request).candidates;
test('one model request uses short candidate references and maps choices back to verified IDs',async()=>{
  let calls=0,input;
  const fetchImpl=async(_url,init)=>{calls++;input=JSON.parse(JSON.parse(init.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({outfitIds:['C2','C1'],advice:[{outfitId:'C2',codes:['scene']}]})}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})};};
  const result=await rankWeatherWithModel(config,request,candidates,null,{fetchImpl});
  assert.equal(calls,1);assert.equal(input.candidates[0].ref,'C1');assert.equal(Object.hasOwn(input.candidates[0],'id'),false);
  assert.deepEqual(result.selection,[candidates[1].id,candidates[0].id]);assert.equal(result.advice[0].outfitId,candidates[1].id);
});
test('unknown, repeated, or concatenated model references are rejected without another billable retry',async()=>{
  for(const ids of [['C999'],['C1','C1'],[candidates[0].id]]) {
    let calls=0;
    const fetchImpl=async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({outfitIds:ids})}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})};};
    await assert.rejects(()=>rankWeatherWithModel(config,request,candidates,null,{fetchImpl}),error=>error.code==='invalid_selection'&&error.usage.total_tokens===15);
    assert.equal(calls,1);
  }
});
