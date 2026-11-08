'use strict';
// Explicit smoke check using a synthetic request. --model consumes at most one
// configured model attempt. This is connectivity evidence, not a quality eval.
const fs=require('node:fs');
const path=require('node:path');
const {handleOutfit}=require('../lib/service');
async function main(){
  const version=process.argv.includes('--model')?'weather':'rule';
  const result=await handleOutfit({query:'通勤，晚上约会，怕冷，不穿裙子',version,weather:{city:'shanghai',day:'today',period:'commute'}},{ip:'synthetic-weather-smoke'});
  const record={at:new Date().toISOString(),kind:'synthetic_single_live_smoke',note:'Single connectivity observation; not held-out evaluation or a latency distribution.',result};
  const dir=path.resolve(__dirname,'../eval/results/weather-live-smoke');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,record.at.replace(/[:.]/g,'-')+'.json');fs.writeFileSync(file,JSON.stringify(record,null,2));
  console.log(JSON.stringify({file,mode:result.mode,status:result.status,weatherStatus:result.weather?.status,modelAttempts:result.meta.modelCalls,modelStages:result.meta.modelStages,fallback:result.fallback,outfits:result.outfits.length,usage:result.meta.usage,elapsedMs:result.meta.elapsedMs}));
  if(result.status!=='ok'||result.weather?.status!=='ok'||result.mode!==version)process.exitCode=1;
}
main().catch(()=>{console.error('Live weather smoke failed; no credentials are printed.');process.exitCode=1;});
