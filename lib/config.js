'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

function readEnv(file = path.join(ROOT, '.env')) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}
function number(value, fallback, min, max) {
  const parsed = Number(value);
  return value !== '' && value !== undefined && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function getConfig(overrides = {}) {
  const env = {...readEnv(), ...process.env};
  const config = {
    root: ROOT,
    key: env.MODEL_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: (env.MODEL_BASE_URL || env.OPENAI_BASE_URL || '').replace(/\/+$/, ''),
    model: env.TEXT_MODEL || '',
    visionModel: env.VISION_MODEL || '',
    port: number(env.PORT, 5173, 1, 65535),
    host: env.HOST || '127.0.0.1',
    timeoutMs: number(env.MODEL_TIMEOUT_MS, 12000, 100, 30000),
    dailyLimit: number(env.MODEL_MAX_CALLS_PER_DAY, 100, 0, 10000),
    jsonMode: env.MODEL_JSON_MODE !== 'false',
    maxTokens: number(env.MODEL_MAX_TOKENS, 1600, 200, 8000),
    thinking: ['enabled','disabled'].includes(env.MODEL_THINKING) ? env.MODEL_THINKING : null,
    publicDeployment: env.PUBLIC_DEPLOYMENT === 'true' || !!env.VERCEL,
    redisUrl: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '',
    redisToken: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '',
    inputPrice: env.INPUT_PRICE_PER_MILLION ? Number(env.INPUT_PRICE_PER_MILLION) : null,
    outputPrice: env.OUTPUT_PRICE_PER_MILLION ? Number(env.OUTPUT_PRICE_PER_MILLION) : null,
    logging: env.REQUEST_METRICS !== 'false',
    ...overrides
  };
  config.configured = !!(config.key && config.baseUrl && config.model);
  config.sharedLimitConfigured = !!(config.redisUrl && config.redisToken);
  return config;
}
module.exports = {ROOT, readEnv, getConfig};
