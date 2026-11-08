'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {ROOT, getConfig} = require('../lib/config');

test('Vercel KV REST aliases configure shared quotas and explicit Upstash variables keep precedence', t => {
  const keys = ['VERCEL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalExists = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => file === path.join(ROOT, '.env') ? false : originalExists(file));
  try {
    process.env.VERCEL = '1';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = 'https://kv-alias.invalid';
    process.env.KV_REST_API_TOKEN = 'fake-kv-token';
    let config = getConfig();
    assert.equal(config.publicDeployment, true);
    assert.equal(config.redisUrl, 'https://kv-alias.invalid');
    assert.equal(config.redisToken, 'fake-kv-token');
    assert.equal(config.sharedLimitConfigured, true);
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash-explicit.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-upstash-token';
    config = getConfig();
    assert.equal(config.redisUrl, 'https://upstash-explicit.invalid');
    assert.equal(config.redisToken, 'fake-upstash-token');
    assert.equal(config.sharedLimitConfigured, true);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
