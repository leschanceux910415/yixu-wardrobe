'use strict';

// All aesthetic scores below are explicit demo heuristics, never ground truth.
const SCENES = Object.freeze({commute:'通勤',formal:'正式场合',casual:'休闲',sport:'运动',date:'约会'});
const CATEGORIES = ['top','bottom','outer','shoes','accessory'];
const LABELS = {top:'上装',bottom:'下装',outer:'外套',shoes:'鞋履',accessory:'配饰'};
const FORMALITY = {commute:3.3,formal:4.7,casual:2,sport:1.3,date:3.4};
const COLORS = ['米白','深灰','浅灰','浅蓝','牛仔蓝','卡其','黑','白','灰','米','棕','蓝','绿','红','粉','紫','黄','橙'];
const unique = xs => [...new Set(xs)];
const strings = xs => Array.isArray(xs) ? unique(xs.filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean)).slice(0,100) : [];
const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
const round = x => Math.round(x*1000)/1000;
const colorKey = s => String(s).replace(/颜色|色/g,'').trim();
const hasColor = (item,color) => colorKey(item.color).includes(colorKey(color));
const escaped = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const namePattern = item => escaped(item.name.replace(/([黑白灰米棕蓝绿红粉紫黄橙])色/g,'$1')).replace(/^([黑白灰米棕蓝绿红粉紫黄橙])/,'$1(?:色)?');

// Resolve a user-visible garment phrase against recorded attributes. A scoped
// prohibition such as "白色鞋" excludes shoes, never all white wardrobe items.
function resolveGarmentPhrase(raw,items) {
  const phrase=String(raw).trim().replace(/^(?:这件|那件|一件|所有|全部|任何)/,'').replace(/[了吧呢]$/,'');
  const simple=s=>s.replace(/色|的|\s/g,'');
  const direct=items.filter(x=>simple(x.name)===simple(phrase)||x.id.toLowerCase()===phrase.toLowerCase());
  if(direct.length) return {known:true,items:direct,color:null,colorOnly:false};
  if(/^[A-Za-z]\d+$/.test(phrase)) return {known:true,items:[],id:phrase.toUpperCase(),color:null,colorOnly:false};
  let rest=phrase;
  const color=COLORS.find(c=>rest.includes(c))||null;
  if(color) rest=rest.replace(new RegExp(`${escaped(color)}色?`),'');
  const types=[
    {re:/西装外套|西装|西服/,category:'outer',subtype:'blazer'},
    {re:/针织衫|毛衣/,category:'top',subtype:'knit'},
    {re:/衬衫/,category:'top',subtype:'shirt'},
    {re:/T恤|t恤|短袖T恤/,category:'top',subtype:'tee'},
    {re:/运动裤/,category:'bottom',subtype:'trousers',name:'运动裤'},
    {re:/牛仔裤/,category:'bottom',subtype:'trousers',name:'牛仔裤'},
    {re:/西裤/,category:'bottom',subtype:'trousers',name:'西裤'},
    {re:/长裤|裤子|裤装|裤/,category:'bottom',subtype:'trousers'},
    {re:/半身裙|长裙|裙子|裙装|裙/,category:'bottom',subtype:'skirt'},
    {re:/运动鞋/,category:'shoes',subtype:'sneakers'},
    {re:/乐福鞋/,category:'shoes',subtype:'loafers'},
    {re:/短靴|靴子|靴/,category:'shoes',subtype:'boots'},
    {re:/围巾/,category:'accessory',subtype:'scarf'},
    {re:/外套/,category:'outer'},
    {re:/鞋履|鞋子|鞋/,category:'shoes'},
    {re:/上装|上衣/,category:'top'},
    {re:/下装/,category:'bottom'},
    {re:/配饰/,category:'accessory'}
  ];
  const type=types.find(x=>x.re.test(rest));
  if(type) rest=rest.replace(type.re,'');
  rest=rest.replace(/的|衣服|单品|所有|全部|任何|一件|这件|那件|\s/g,'');
  if(rest||(!color&&!type)) return {known:false,items:[],color,colorOnly:false};
  const matches=items.filter(x=>(!color||hasColor(x,color))&&(!type||x.category===type.category&&(!type.subtype||x.subtype===type.subtype)&&(!type.name||x.name.includes(type.name))));
  return {known:true,items:matches,color,colorOnly:!!color&&!type};
}

function normalizeRequest(raw={},items=[]) {
  raw = raw && typeof raw==='object' ? raw : {};
  const warnings=strings(raw.warnings), clarifications=strings(raw.clarifications);
  let temperature=null;
  if(raw.temperature!==undefined && raw.temperature!==null && raw.temperature!=='') {
    const n=Number(raw.temperature);
    if(Number.isFinite(n)&&n>=-30&&n<=50) temperature=n;
    else {warnings.push('温度超出示例支持范围（-30至50°C）。');clarifications.push('请提供-30至50°C之间的气温。');}
  }
  const excludedColors=strings(raw.excludedColors).map(colorKey);
  for(const c of excludedColors) if(!COLORS.includes(c)) clarifications.push(`暂不能可靠识别禁止颜色“${c}”，请明确颜色。`);
  if(temperature===null&&!warnings.some(x=>x.includes('未提供气温'))) warnings.push('未提供气温，暂不进行厚薄偏好排序，可补充气温。');
  const result={query:typeof raw.query==='string'?raw.query.slice(0,2000):'',scene:Object.hasOwn(SCENES,raw.scene)?raw.scene:'commute',temperature,requiredIds:strings(raw.requiredIds),excludedIds:strings(raw.excludedIds),excludedColors:unique(excludedColors),bottomType:['any','trousers','skirt'].includes(raw.bottomType)?raw.bottomType:'any',avoidRecent:raw.avoidRecent===true,recentIds:strings(raw.recentIds),preferences:strings(raw.preferences),warnings:unique(warnings),clarifications:unique(clarifications)};
  if(temperature!==null) result.warnings=result.warnings.filter(x=>!x.includes('未提供气温'));
  return result;
}

function parseQuery(query,items=[],previous={},context={}) {
  const text=String(query??'').trim().slice(0,2000);
  const commandText=text.replace(/(?:也|并且|同时)(?=(?:不要|不穿|不想穿|禁止|排除|避开|锁定|保留|必须穿))/g,'，');
  const reset=/重新开始|清空条件|重置条件|全部重置/.test(text);
  const old=normalizeRequest(reset?{}:previous,items);
  const clearUnsupported=/忽略(?:刚才|不支持)|取消不支持|删除不支持|清除不支持|不考虑刚才/.test(text);
  const next={...old,query:text,requiredIds:[...old.requiredIds],excludedIds:[...old.excludedIds],excludedColors:[...old.excludedColors],preferences:[...old.preferences],warnings:[],clarifications:clearUnsupported?[]:[...old.clarifications]};
  const sceneMatches=[];
  for(const [scene,pattern] of Object.entries({commute:/通勤|上班|办公室/g,formal:/正式|见客户|商务|面试/g,casual:/休闲|周末|闲逛/g,sport:/运动|健身|跑步/g,date:/约会/g})) {
    for(const m of text.matchAll(pattern)) sceneMatches.push({scene,index:m.index});
  }
  if(sceneMatches.length) next.scene=sceneMatches.sort((a,b)=>a.index-b.index).at(-1).scene;
  const temps=[...text.matchAll(/(-?\d{1,2}(?:\.\d+)?)\s*(?:°\s*[CcＣｃ]?|[℃度]|[CcＣｃ](?![a-z]))/g)];
  if(temps.length) next.temperature=Number(temps.at(-1)[1]);
  if(/温度不限|气温不限|清除温度|不考虑温度/.test(text)) next.temperature=null;
  if(/不重复|没穿过|没穿的|少重复|避开最近|最近没穿/.test(text)) next.avoidRecent=true;
  if(/允许重复|可以重复|不介意重复|不用避开最近|不考虑重复/.test(text)) next.avoidRecent=false;
  if(/不(?:想)?穿裙|不要(?:穿)?裙|禁止(?:穿)?裙|排除裙|只穿裤|必须穿裤|换成裤|要裤子|想穿裤|穿长裤/.test(text)) next.bottomType='trousers';
  if(/不(?:想)?穿裤|不要(?:穿)?裤|禁止(?:穿)?裤|排除裤|只穿裙|必须穿裙|换成裙|要裙子|想穿裙/.test(text)) next.bottomType='skirt';
  if(/裙子也可以|裤子也可以|下装不限|裙裤不限|清除下装/.test(text)) next.bottomType='any';
  if(/取消颜色限制|颜色不限|清除颜色/.test(text)) next.excludedColors=[];
  const unknown=[];
  // Read only the clause following each explicit prohibition; do not interpret an
  // unrelated later garment as excluded because an earlier clause said "不要".
  for(const match of commandText.matchAll(/(?:不要穿|不要|不想穿|不穿|禁止穿|禁止|排除|避开)\s*([^，,。；;！!？?\n]{1,35})/g)) {
    const clause=match[1].split(/(?:但是|然后|并且|同时|优先|尽量|必须|锁定|保留)/)[0];
    for(const part of clause.split(/(?:、|和|及|与|或者|或)/).map(x=>x.trim()).filter(Boolean)) {
      if(/最近|重复/.test(part)) continue;
      if(/^(?:裙子?|裙装|裤子?|裤装|长裤)$/.test(part)) continue; // bottomType above
      const resolved=resolveGarmentPhrase(part,items);
      if(!resolved.known) {unknown.push(part);continue;}
      if(resolved.colorOnly) next.excludedColors.push(resolved.color);
      else if(resolved.items.length) next.excludedIds.push(...resolved.items.map(x=>x.id));
      else unknown.push(part);
    }
  }
  // Explicitly removing an existing exclusion is an update, not another ban.
  for(const color of COLORS) if(new RegExp(`(?:允许|可以穿|不再排除|取消禁止|恢复)${escaped(color)}(?:色)?`).test(text)) next.excludedColors=next.excludedColors.filter(x=>x!==color);
  for(const match of commandText.matchAll(/(取消锁定|不再锁定|解锁|取消排除|恢复|可以穿|锁定|必须穿|一定要穿|一定穿|保留|指定|穿上|只穿|想穿|要穿)\s*([^，,。；;！!？?\n]{1,45})/g)) {
    const action=match[1];
    if(/想穿|要穿|穿上/.test(action)&&/(?:不|不要|禁止)$/.test(commandText.slice(0,match.index))) continue;
    const clause=match[2].split(/(?:但是|然后|并且|同时|优先|尽量|必须|锁定|保留)/)[0];
    if(/想穿|要穿/.test(action)&&/^(?:得)?(?:简洁|简单|清爽|轻松|舒适)(?:一点|一些|点|些)?$/.test(clause.trim())) {
      next.preferences.push(clause.trim().replace(/^得/,''));
      next.warnings.push('已记录主观穿着偏好；当前规则不会将它转成单品锁定或专业风格判断。');
      continue;
    }
    for(const part of clause.split(/(?:、|和|及|与)/).map(x=>x.trim()).filter(Boolean)) {
      // A request for a bottom type is already represented by bottomType. It
      // should not become an ambiguous lock on one particular skirt/trouser.
      if(/^(?:裙子?|裙装|裤子?|裤装|长裤)$/.test(part)&&!/锁定|保留|指定/.test(action)) continue;
      const resolved=resolveGarmentPhrase(part,items);
      if(!resolved.known) {next.clarifications.push(`暂不能可靠执行“${action}${part}”，请从衣橱中选择具体单品。`);continue;}
      const ids=resolved.items.map(x=>x.id);
      if(/取消锁定|不再锁定|解锁/.test(action)) next.requiredIds=next.requiredIds.filter(id=>!ids.includes(id));
      else if(/取消排除|恢复|可以穿/.test(action)) next.excludedIds=next.excludedIds.filter(id=>!ids.includes(id));
      else if(resolved.id) next.requiredIds.push(resolved.id);
      else if(ids.length===1) next.requiredIds.push(ids[0]);
      else next.clarifications.push(ids.length?`“${part}”匹配${ids.length}件单品，请明确要锁定哪一件。`:`衣橱中未找到“${part}”，请重新选择锁定单品。`);
    }
  }
  if(/不要裙|不穿裙/.test(text)&&/不要裤|不穿裤/.test(text)) next.clarifications.push('同时禁止裙子和裤子将无法组成当前示例中的下装，请确认下装条件。');
  for(const condition of unknown) next.clarifications.push(`暂不能可靠执行“不要${condition}”，请指定衣物、颜色或裙裤条件。`);
  if(/防水|防风|羽绒|羊毛|真丝|显瘦|显高|品牌|预算|价格|购买|购物|连衣裙|无袖|过敏|身材|肤色|风格/.test(text)) next.clarifications.push('衣橱未记录可核验的材质、防水防风、身材适配或购买属性；请删除相关要求，或改为选择具体单品。');
  if(/小雨|下雨|雨天|大风/.test(text)&&!context.weatherEnabled) next.clarifications.push('请开启自动天气查询，以核对目标城市和时段的降雨、风速；尚不能凭天气文字确认衣物防水防风。');
  if(/温暖|保暖|厚一点|怕冷/.test(text)) next.preferences=next.preferences.filter(x=>x!=='轻薄').concat('更保暖');
  if(/凉快|轻薄|薄一点|轻一点|怕热/.test(text)) next.preferences=next.preferences.filter(x=>x!=='更保暖').concat('轻薄');
  if(!text && !previous.query) next.warnings.push('可直接使用当前场合，也可以输入具体需求。');
  return normalizeRequest(next,items);
}

function checkOutfit(itemsOrIds,wardrobe,rawRequest) {
  const request=normalizeRequest(rawRequest,wardrobe);
  const ids=(Array.isArray(itemsOrIds)?itemsOrIds:[]).map(x=>typeof x==='string'?x:x?.id);
  const selected=ids.map(id=>wardrobe.find(x=>x.id===id)).filter(Boolean);
  const counts=Object.fromEntries(CATEGORIES.map(c=>[c,selected.filter(x=>x.category===c).length]));
  return {inWardrobe:ids.length===selected.length&&unique(ids).length===ids.length,complete:counts.top===1&&counts.bottom===1&&counts.shoes===1&&counts.outer<=1&&counts.accessory<=1,required:request.requiredIds.every(id=>ids.includes(id)),excluded:!ids.some(id=>request.excludedIds.includes(id)),color:!selected.some(x=>request.excludedColors.some(c=>hasColor(x,c))),bottomType:request.bottomType==='any'||selected.filter(x=>x.category==='bottom').every(x=>x.subtype===request.bottomType)};
}

function warmthTarget(t) {return t>=28?1.2:t>=24?1.6:t>=20?2.1:t>=15?2.7:t>=10?3.3:t>=5?4:4.7;}
function itemEligibility(item,request) {
  const reasons=[];
  if(request.excludedIds.includes(item.id)) reasons.push('被明确排除');
  if(request.excludedColors.some(c=>hasColor(item,c))) reasons.push(`命中禁止颜色：${item.color}`);
  if(item.category==='bottom'&&request.bottomType!=='any'&&item.subtype!==request.bottomType) reasons.push(request.bottomType==='trousers'?'仅允许裤子':'仅允许裙子');
  const otherLock=request.requiredIds.find(id=>id!==item.id&&request._items?.some(x=>x.id===id&&x.category===item.category));
  if(otherLock) reasons.push('同品类已有锁定单品');
  return reasons;
}
function rankItems(items,rawRequest) {
  const request={...normalizeRequest(rawRequest,items),_items:items};
  return items.map(item=>{
    const blocked=itemEligibility(item,request), reasons=[...blocked];
    let score=1-Math.min(1,Math.abs(item.formality-FORMALITY[request.scene])/4);
    reasons.push(`正式度示例属性 ${item.formality}/5；用于${SCENES[request.scene]}偏好排序`);
    if(request.temperature!==null) {score=.6*score+.4*(1-Math.min(1,Math.abs(item.warmth-warmthTarget(request.temperature))/4));reasons.push(`厚薄示例属性 ${item.warmth}/5；气温 ${request.temperature}°C`);}
    if(request.requiredIds.includes(item.id)) {score+=.3;reasons.push('用户锁定，必须包含');}
    if(request.avoidRecent&&request.recentIds.includes(item.id)) {score-=.2;reasons.push('近期穿过，软偏好降权，仍可选');}
    if(request.query.includes(item.name)) {score+=.1;reasons.push('命中查询中的单品名称');}
    if(!blocked.length) reasons.unshift('符合显式单品约束');
    return {id:item.id,score:round(clamp(score,0,1)),eligible:blocked.length===0,reasons};
  }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score||a.id.localeCompare(b.id));
}

function scoreCombination(selected,request) {
  const body=selected.filter(x=>['top','bottom','outer'].includes(x.category));
  const inner=body.filter(x=>x.category!=='outer');
  const outer=body.find(x=>x.category==='outer');
  // Deliberately simple layering proxy: adding an outer cannot reduce warmth.
  // It is a soft ranking feature, not a physiological temperature guarantee.
  const warmth=clamp(inner.reduce((s,x)=>s+x.warmth,0)/inner.length+(outer?.warmth||0)*.35,1,5);
  const formal=selected.filter(x=>x.category!=='accessory');
  const formality=formal.reduce((s,x)=>s+x.formality,0)/formal.length;
  let target=request.temperature===null?null:warmthTarget(request.temperature);
  if(target!==null&&request.preferences.includes('更保暖')) target=Math.min(5,target+.5);
  if(target!==null&&request.preferences.includes('轻薄')) target=Math.max(1,target-.5);
  const warmFit=target===null?1:1-Math.min(1,Math.abs(warmth-target)/3);
  const formFit=1-Math.min(1,Math.abs(formality-FORMALITY[request.scene])/4);
  const families=unique(body.filter(x=>x.colorFamily!=='neutral').map(x=>x.colorFamily));
  const colorFit=families.length<=1?1:.6;
  const recent=selected.filter(x=>request.recentIds.includes(x.id)).length;
  const novelty=request.avoidRecent?1-recent/selected.length:1;
  const extra=selected.filter(x=>['outer','accessory'].includes(x.category)).length;
  const score=.32*warmFit+.4*formFit+.12*colorFit+.16*novelty-.008*extra;
  const tradeoffs=[];
  if(request.avoidRecent&&recent) tradeoffs.push(`包含${recent}件近期穿过的单品；优先不重复是软偏好，未放宽任何禁止条件。`);
  if(target!==null&&Math.abs(warmth-target)>1) tradeoffs.push('示例厚薄属性与气温偏好存在距离，请结合真实衣物和体感判断。');
  if(Math.abs(formality-FORMALITY[request.scene])>1.2) tradeoffs.push('正式度示例属性与场合偏好存在距离，仍满足全部显式约束。');
  return {score:round(clamp(score,0,1)),tradeoffs};
}

function solve(items,rawRequest,options={}) {
  const request=normalizeRequest(rawRequest,items);
  const search=rankItems(items,request);
  const base={request,outfits:[],candidates:[],diagnosis:null,search,stats:{totalCombinations:0,feasibleCombinations:0}};
  const fail=(kind,message,suggestions=[])=>({...base,status:kind==='unsupported'?'clarify':'conflict',diagnosis:{kind,message,suggestions}});
  if(request.clarifications.length) return fail('unsupported',request.clarifications.join(' '),['修改或删除暂不支持的条件后重试。']);
  const unknown=request.requiredIds.filter(id=>!items.some(x=>x.id===id));
  if(unknown.length) return fail('constraint',`锁定单品不存在：${unknown.join('、')}。`,['重新选择当前衣橱中存在的单品。']);
  for(const cat of CATEGORIES) if(items.filter(x=>request.requiredIds.includes(x.id)&&x.category===cat).length>1) return fail('constraint',`同一品类${LABELS[cat]}锁定了多件；当前一套只支持该品类一件。`,['取消多余锁定，系统不会自行替换。']);
  const lockConflict=items.filter(x=>request.requiredIds.includes(x.id)&&itemEligibility(x,request).length);
  if(lockConflict.length) return fail('constraint',`锁定单品与禁止条件冲突：${lockConflict.map(x=>x.name).join('、')}。`,['取消相应锁定或禁止条件，系统不会自动放宽。']);
  const pools=Object.fromEntries(CATEGORIES.map(cat=>[cat,items.filter(x=>x.category===cat)]));
  const missing=['top','bottom','shoes'].filter(cat=>!pools[cat].length);
  if(missing.length) return fail('missing',`衣橱缺少${missing.map(x=>LABELS[x]).join('、')}，无法组成上装、下装与鞋履。`,['添加缺少的单品，或切换至完整示例衣橱。']);
  const space=pools.top.length*pools.bottom.length*pools.shoes.length*(pools.outer.length+1)*(pools.accessory.length+1);
  if(space>200000) return fail('unsupported',`当前衣橱形成${space}种组合，超过演示版完整枚举的20万组合上限。`,['减少示例衣物数量后重试；本次未抽样，也未宣称无解。']);
  const feasible=[];
  // Enumerate all allowed slot combinations, including optional outerwear at any
  // temperature. Validate every combination before applying any top-k cutoff.
  for(const top of pools.top) for(const bottom of pools.bottom) for(const shoes of pools.shoes) for(const outer of [null,...pools.outer]) for(const accessory of [null,...pools.accessory]) {
    base.stats.totalCombinations++;
    const selected=[top,bottom,outer,shoes,accessory].filter(Boolean);
    const checks=checkOutfit(selected,items,request);
    if(!Object.values(checks).every(Boolean)) continue;
    const itemIds=selected.map(x=>x.id);
    const score=scoreCombination(selected,request);
    const reason=`${selected.map(x=>x.name).join('＋')}。符合锁定、排除、颜色和裙裤条件；按${SCENES[request.scene]}${request.temperature===null?'':`、${request.temperature}°C`}的示例属性进行偏好排序。评分是启发式比较，不是穿着适宜性的保证。`;
    feasible.push({id:itemIds.join('-'),itemIds,items:selected,...score,reason,checks,pass:true});
  }
  base.stats.feasibleCombinations=feasible.length;
  if(!feasible.length) {
    const blocked=['top','bottom','shoes'].filter(cat=>pools[cat].every(x=>!search.find(y=>y.id===x.id).eligible));
    return fail('constraint',blocked.length?`显式条件排除了所有可用${blocked.map(x=>LABELS[x]).join('、')}，当前无合格组合。`:'完整检查全部组合后，没有同时满足所有显式条件的方案。',['检查禁止颜色、裙裤选择、锁定与排除项；系统未自动放宽硬约束。']);
  }
  feasible.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const limit=clamp(Number.isInteger(options.limit)?options.limit:3,1,3);
  const candidateLimit=clamp(Number.isInteger(options.candidateLimit)?options.candidateLimit:12,limit,12);
  const outfits=[];
  const keys=new Set();
  for(const outfit of feasible) {
    const key=outfit.items.filter(x=>['top','bottom'].includes(x.category)).map(x=>x.id).join('|');
    if(keys.has(key)) continue;
    outfits.push(outfit);keys.add(key);
    if(outfits.length===limit) break;
  }
  // Include every diverse displayed result in the model pool, then fill with
  // remaining top-scored combinations. Never overwrite a previously added one.
  const displayIds=new Set(outfits.map(x=>x.id));
  const candidates=[...outfits,...feasible.filter(x=>!displayIds.has(x.id)).slice(0,candidateLimit-outfits.length)].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  return {...base,status:'ok',outfits,candidates};
}

module.exports={parseQuery,normalizeRequest,solve,checkOutfit,rankItems,SCENES};
