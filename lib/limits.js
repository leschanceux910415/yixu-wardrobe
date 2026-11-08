'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const buckets = new Map();
class LimitError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function requestAllowed(ip, max = 60) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${minute}`;
  const count = (buckets.get(key) || 0) + 1;
  buckets.set(key, count);
  if (buckets.size > 2000) for (const k of buckets.keys()) if (!k.endsWith(`:${minute}`)) buckets.delete(k);
  return count <= max;
}
async function reserveModelCall(config, ip) {
  if (config.dailyLimit === 0) throw new LimitError('budget_exhausted', '模型调用预算已用完，使用规则方案。');
  const date = new Date().toISOString().slice(0, 10);
  if (config.publicDeployment) {
    if (!config.sharedLimitConfigured) throw new LimitError('public_limit_required', '公开环境尚未配置共享调用额度，使用规则方案。');
    const hash = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 24);
    const minute = Math.floor(Date.now() / 60000);
    const script = "local a=redis.call('INCR',KEYS[1]); if a==1 then redis.call('EXPIRE',KEYS[1],172800) end; local b=redis.call('INCR',KEYS[2]); if b==1 then redis.call('EXPIRE',KEYS[2],120) end; if a>tonumber(ARGV[1]) or b>10 then return 0 else return 1 end";
    let response;
    try {
      response = await fetch(config.redisUrl, {method:'POST', headers:{Authorization:`Bearer ${config.redisToken}`,'Content-Type':'application/json'}, body:JSON.stringify(['EVAL',script,'2',`yixu:day:${date}`,`yixu:minute:${hash}:${minute}`,String(config.dailyLimit)]),signal:AbortSignal.timeout(4000)});
      const data = await response.json();
      if (!response.ok || data.error) throw new Error('limit unavailable');
      if (Number(data.result) !== 1) throw new LimitError('rate_limit', '当前模型调用额度已达上限，使用规则方案。');
    } catch (error) {
      if (error instanceof LimitError) throw error;
      throw new LimitError('limit_unavailable', '模型额度服务暂不可用，使用规则方案。');
    }
    return;
  }
  // This durable local counter is only for one local Node process. Public
  // deployments must use the shared counter above; do not claim Map is shared.
  const dir = path.join(config.root, 'logs');
  const filename = path.join(dir, 'model-budget.json');
  fs.mkdirSync(dir, {recursive:true});
  let state = {date, calls:0};
  try { const saved = JSON.parse(fs.readFileSync(filename, 'utf8')); if (saved.date === date) state = saved; } catch {}
  if (state.calls >= config.dailyLimit) throw new LimitError('budget_exhausted', '今日模型调用预算已用完，使用规则方案。');
  state.calls += 1;
  fs.writeFileSync(filename, JSON.stringify(state));
}
module.exports = {requestAllowed, reserveModelCall, LimitError};
