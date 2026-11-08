'use strict';

// Independent evaluation: this file intentionally never imports lib/core.js.
// Expected intent and feasibility labels live in cases.jsonl, not the product's
// self-reported checks, heuristic scores, or conflict classification.
const stripColor = value => String(value ?? '').replace(/颜色|色/g, '').trim();
const sameSet = (actual, expected) => Array.isArray(actual) &&
  JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort());

function inspectOutfit(outfit, wardrobe, constraints = {}) {
  const ids = Array.isArray(outfit.itemIds) ? outfit.itemIds :
    Array.isArray(outfit.items) ? outfit.items.map(item => item.id) : [];
  const byId = new Map(wardrobe.map(item => [item.id, item]));
  const selected = ids.map(id => byId.get(id)).filter(Boolean);
  const count = category => selected.filter(item => item.category === category).length;
  const checks = {
    nonempty: ids.length > 0,
    inWardrobe: ids.every(id => byId.has(id)),
    unique: new Set(ids).size === ids.length,
    complete: count('top') === 1 && count('bottom') === 1 && count('shoes') === 1 &&
      count('outer') <= 1 && count('accessory') <= 1,
    required: (constraints.requiredIds || []).every(id => ids.includes(id)),
    excluded: !(constraints.excludedIds || []).some(id => ids.includes(id)),
    colors: !selected.some(item => (constraints.excludedColors || []).some(color =>
      stripColor(color) && stripColor(item.color).includes(stripColor(color)))),
    bottomType: !constraints.bottomType || constraints.bottomType === 'any' ||
      selected.filter(item => item.category === 'bottom').every(item => item.subtype === constraints.bottomType)
  };
  return {itemIds: ids, checks, pass: Object.values(checks).every(Boolean)};
}

function evaluateResponse(testCase, response, wardrobe, requestedVersion = 'rule') {
  const expected = testCase.expected;
  const allowedStatuses = Array.isArray(expected.status) ? expected.status : [expected.status];
  const parsing = {};
  for (const [field, value] of Object.entries(expected.request || {})) {
    parsing[field] = Array.isArray(value) ? sameSet(response.request?.[field], value) :
      response.request?.[field] === value;
  }
  const outputs = Array.isArray(response.outfits) ? response.outfits : [];
  const inspections = outputs.map(outfit => ({
    expectedIntent: inspectOutfit(outfit, wardrobe, expected.constraints || {}),
    emittedIntent: inspectOutfit(outfit, wardrobe, response.request || {})
  }));
  const notice = [...(response.request?.warnings || []), ...(response.request?.clarifications || []),
    response.diagnosis?.message || ''].some(value => /不能|无法|不支持|尚不能|未知/.test(value));
  const checks = {
    expectedStatus: allowedStatuses.includes(response.status),
    expectedParsing: Object.values(parsing).every(Boolean),
    independentConstraints: inspections.every(item => item.expectedIntent.pass && item.emittedIntent.pass),
    returnedResult: response.status !== 'ok' || outputs.length > 0,
    conflictDiagnosis: response.status !== 'conflict' ||
      (typeof response.diagnosis?.message === 'string' && response.diagnosis.message.trim().length > 0),
    noUnqualifiedOutputOnConflict: response.status !== 'conflict' || outputs.length === 0,
    unsupportedNotice: !expected.requiresNotice || notice
  };
  const actualMode = response.mode || (requestedVersion === 'rule' ? 'rule' : 'unknown');
  const modelExecuted = requestedVersion !== 'rule' && actualMode === requestedVersion &&
    !response.fallback && typeof response.model === 'string' && response.model.length > 0;
  return {
    pass: Object.values(checks).every(Boolean), checks, parsing, inspections,
    actualMode, modelExecuted, expectedFeasible: expected.feasible,
    falseConflict: expected.feasible === true && response.status === 'conflict',
    falseSuccess: expected.feasible === false && response.status === 'ok',
    fallback: response.fallback || null
  };
}

function summarize(records, requestedVersion) {
  const count = predicate => records.filter(predicate).length;
  const modelRecords = records.filter(record => record.evaluation?.modelExecuted);
  const latency = records.filter(record => Number.isFinite(record.elapsedMs)).map(record => record.elapsedMs).sort((a,b)=>a-b);
  return {
    requestedVersion, denominator: records.length,
    outcomePassed: count(record => record.evaluation?.pass),
    executionErrors: count(record => !!record.executionError),
    feasibleLabels: count(record => record.expected.feasible === true),
    infeasibleLabels: count(record => record.expected.feasible === false),
    falseConflicts: count(record => record.evaluation?.falseConflict),
    falseSuccesses: count(record => record.evaluation?.falseSuccess),
    modelExecuted: modelRecords.length,
    modelPassed: modelRecords.filter(record => record.evaluation.pass).length,
    modelNotExecuted: requestedVersion === 'rule' ? 0 : records.length - modelRecords.length,
    fallbackCount: count(record => !!record.response?.fallback),
    latencyMedianMs: latency.length ? latency[Math.floor((latency.length - 1) / 2)] : null,
    latencyP95Ms: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null,
    strata: Object.fromEntries([...new Set(records.map(record => record.stratum))].map(stratum => {
      const group = records.filter(record => record.stratum === stratum);
      return [stratum, {total: group.length, passed: group.filter(record => record.evaluation?.pass).length}];
    }))
  };
}

module.exports = {inspectOutfit, evaluateResponse, summarize};
