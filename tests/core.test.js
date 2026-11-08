'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseQuery,normalizeRequest,solve,checkOutfit,rankItems}=require('../lib/core');
const {items}=require('../data/wardrobe.json');

test('synthetic wardrobe has 24 confirmed items and core slots',()=>{
  assert.equal(items.length,24);assert.equal(new Set(items.map(x=>x.id)).size,24);
  assert.ok(items.every(x=>x.source==='示例数据'&&x.confirmed));
});
test('feasible request enumerates full space and returns checked results',()=>{
  const r=solve(items,parseQuery('18度通勤，不要白色，不穿裙子',items));
  assert.equal(r.status,'ok');assert.equal(r.outfits.length,3);
  assert.equal(r.stats.totalCombinations,3600);
  assert.ok(r.stats.feasibleCombinations>3);
  assert.ok(r.outfits.every(o=>r.candidates.some(c=>c.id===o.id)));
  for(const o of r.outfits){assert.ok(Object.values(o.checks).every(Boolean));assert.ok(o.items.every(x=>!x.color.includes('白')));assert.equal(o.items.find(x=>x.category==='bottom').subtype,'trousers');}
});
test('multi-turn updates retain temperature, bans, locks and prior scene until changed',()=>{
  const one=parseQuery('15°C通勤，不要白色，锁定灰色西裤，优先最近没穿的',items);
  const two=parseQuery('改为约会',items,one);
  assert.equal(two.scene,'date');assert.equal(two.temperature,15);assert.deepEqual(two.excludedColors,['白']);assert.deepEqual(two.requiredIds,['B01']);assert.equal(two.avoidRecent,true);
  const three=parseQuery('20度，允许重复，取消颜色限制，解锁灰色西裤',items,two);
  assert.equal(three.temperature,20);assert.equal(three.avoidRecent,false);assert.deepEqual(three.excludedColors,[]);assert.deepEqual(three.requiredIds,[]);
  const reset=parseQuery('重新开始，周末',items,three);assert.equal(reset.temperature,null);assert.equal(reset.scene,'casual');
});
test('exact item exclusion and lock are enforced',()=>{
  const r=solve(items,parseQuery('通勤，锁定蓝衬衫，不穿白衬衫',items));
  assert.equal(r.status,'ok');assert.ok(r.outfits.every(x=>x.itemIds.includes('T02')&&!x.itemIds.includes('T01')));
});
test('color adjective variants still identify a named item',()=>{
  const req=parseQuery('锁定白色衬衫，不穿黑运动裤',items);
  assert.deepEqual(req.requiredIds,['T01']);assert.deepEqual(req.excludedIds,['B03']);assert.equal(req.clarifications.length,0);
});
test('generic colored category resolves a unique lock without dropping it',()=>{
  const req=parseQuery('保留黑色外套',items);assert.deepEqual(req.requiredIds,['O01']);assert.equal(req.clarifications.length,0);
  const r=solve(items,req);assert.equal(r.status,'ok');assert.ok(r.outfits.every(x=>x.itemIds.includes('O01')));
});
test('ambiguous or unknown forced garments require clarification',()=>{
  for(const q of ['锁定外套','必须穿白色','保留防晒衣','必须穿正装皮鞋']) assert.equal(solve(items,parseQuery(q,items)).status,'clarify',q);
});
test('color scoped to shoes only excludes matching shoes',()=>{
  const req=parseQuery('不要白色鞋',items);assert.deepEqual(req.excludedColors,[]);assert.deepEqual(req.excludedIds,['S01']);assert.equal(req.clarifications.length,0);
  const s=rankItems(items,req);assert.equal(s.find(x=>x.id==='T01').eligible,true);assert.equal(s.find(x=>x.id==='S01').eligible,false);
});
test('natural garment type requests and prohibition variants do not become ambiguous locks',()=>{
  for(const q of ['必须穿裙子','想穿裙子','只穿裙子']) {const r=solve(items,parseQuery(q,items));assert.equal(r.status,'ok',q);assert.ok(r.outfits.every(x=>x.items.find(y=>y.category==='bottom').subtype==='skirt'));}
  const req=parseQuery('不要穿裙子，禁止穿白色鞋',items);assert.equal(req.bottomType,'trousers');assert.deepEqual(req.excludedIds,['S01']);assert.equal(req.clarifications.length,0);
});
test('an unresolved strong condition persists until explicitly discarded',()=>{
  const req=parseQuery('不要蕾丝',items);const next=parseQuery('改成通勤',items,req);assert.equal(solve(items,next).status,'clarify');
  assert.equal(solve(items,parseQuery('忽略刚才不支持的条件',items,next)).status,'ok');
});
test('a recognized color does not mask an unknown prohibition',()=>{
  assert.equal(solve(items,parseQuery('不要白色和蕾丝',items)).status,'clarify');
});
test('negative wear clauses do not accidentally trigger the positive wear action',()=>{
  for(const q of ['不穿上装，也不要鞋子。','不穿上装也不要鞋子','不想穿上装，同时不要鞋子']) {
    const req=parseQuery(q,items);assert.deepEqual(req.requiredIds,[],q);assert.equal(req.clarifications.length,0,q);
    assert.ok(items.filter(x=>x.category==='top'||x.category==='shoes').every(x=>req.excludedIds.includes(x.id)),q);
    assert.equal(solve(items,req).status,'conflict',q);
  }
});
test('a subjective desire is a soft preference rather than an invented lock',()=>{
  const req=parseQuery('想穿得简洁一点',items);assert.deepEqual(req.requiredIds,[]);assert.equal(req.clarifications.length,0);assert.ok(req.preferences.includes('简洁一点'));assert.ok(req.warnings.some(x=>x.includes('主观')));assert.equal(solve(items,req).status,'ok');
});
test('locks absent, contradictory and same-category give explicit conflicts',()=>{
  assert.match(solve(items,{requiredIds:['M99']}).diagnosis.message,/不存在/);
  assert.match(solve(items,{requiredIds:['T01','T02']}).diagnosis.message,/同一品类/);
  assert.match(solve(items,{requiredIds:['T01'],excludedColors:['白']}).diagnosis.message,/冲突/);
});
test('a true hard infeasible set is conflict and never auto-relaxed',()=>{
  const tops=items.filter(x=>x.category==='top').map(x=>x.id);
  const r=solve(items,{excludedIds:tops});assert.equal(r.status,'conflict');assert.equal(r.stats.totalCombinations,3600);assert.equal(r.stats.feasibleCombinations,0);assert.equal(r.outfits.length,0);
  assert.equal(solve(items.filter(x=>x.category!=='shoes'),{}).diagnosis.kind,'missing');
});
test('cold temperature is a soft preference, not a false infeasibility trigger',()=>{
  const r=solve(items,{temperature:4,scene:'formal'});assert.equal(r.status,'ok');assert.ok(r.stats.feasibleCombinations>0);
});
test('outerwear remains available at 16 degrees and can be locked',()=>{
  const r=solve(items,{temperature:16,requiredIds:['O01']});assert.equal(r.status,'ok');assert.ok(r.outfits.every(x=>x.itemIds.includes('O01')));
});
test('adding a thin outer improves the layering warmth proxy in a cold setting',()=>{
  const subset=items.filter(x=>['T01','B03','S01','O03'].includes(x.id));
  const r=solve(subset,{temperature:4},{candidateLimit:12});
  const layered=r.candidates.find(x=>x.itemIds.includes('O03'));const bare=r.candidates.find(x=>!x.itemIds.includes('O03'));
  assert.ok(layered.score>bare.score);
});
test('prefer no recent is soft even when all items were recent',()=>{
  const r=solve(items,{avoidRecent:true,recentIds:items.map(x=>x.id)});assert.equal(r.status,'ok');assert.ok(r.outfits.every(x=>x.pass&&x.tradeoffs.some(t=>t.includes('近期'))));
});
test('unknown prohibitions and unsupported physical attributes require clarification',()=>{
  for(const q of ['不要羽绒服','不要蕾丝','小雨天需要防水','想要显瘦的风格']) {
    const r=solve(items,parseQuery(q,items));assert.equal(r.status,'clarify',q);assert.equal(r.diagnosis.kind,'unsupported');
  }
});
test('checks reject invented IDs, duplicate slots and explicit skirt ban',()=>{
  const req={bottomType:'trousers'};
  assert.equal(checkOutfit(['T01','B05','S01'],items,req).bottomType,false);
  assert.equal(checkOutfit(['T01','B01','S01','X01'],items,req).inWardrobe,false);
  assert.equal(checkOutfit(['T01','T02','B01','S01'],items,req).complete,false);
});
test('only one feasible combination still succeeds after exhaustive filtering',()=>{
  const requiredIds=['T06','B03','O02','S05','A03'];
  const r=solve(items,{requiredIds});assert.equal(r.status,'ok');assert.equal(r.stats.feasibleCombinations,1);assert.equal(r.outfits.length,1);assert.deepEqual(new Set(r.outfits[0].itemIds),new Set(requiredIds));
});
test('search records expose eligible flags and actual constraint reasons',()=>{
  const s=rankItems(items,{excludedColors:['白'],bottomType:'trousers',avoidRecent:true,recentIds:['B01']});
  assert.equal(s.find(x=>x.id==='T01').eligible,false);assert.match(s.find(x=>x.id==='B05').reasons.join(' '),/裤子/);assert.match(s.find(x=>x.id==='B01').reasons.join(' '),/软偏好/);
});
test('invalid temperature and unknown prohibited colors are not silently accepted',()=>{
  assert.equal(solve(items,normalizeRequest({temperature:100})).status,'clarify');
  assert.equal(solve(items,{excludedColors:['银']}).status,'clarify');
});
