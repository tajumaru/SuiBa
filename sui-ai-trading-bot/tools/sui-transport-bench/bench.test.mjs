import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, classify, measure, summary, countRpcCalls } from './core.mjs';
test('counts calls retained by an SDK binding without changing transport context', () => {
  const transport = { value: 3, unary(n) { return this.value + n; } };
  const count = countRpcCalls(transport), sdkUnary = transport.unary.bind(transport);
  assert.equal(sdkUnary(4), 7); assert.equal(count(), 1);
});
const plan = { endpoint: 'https://example.invalid:443', operation: 'metadata', coinType: '0x2::sui::SUI', pairs: 30, intervalMs: 5000, timeoutMs: 10000 };
test('rejects writes, credential URLs and excessive request budgets', () => {
  for (const change of [{operation:'executeTransaction'}, {endpoint:'https://u:p@example.invalid'}, {pairs:31}, {intervalMs:0}, {timeoutMs:20000}]) assert.throws(() => validatePlan({...plan,...change}));
  assert.equal(validatePlan(plan), plan);
});
test('deadline cancels pending work and never accepts a late success', async () => {
  let cancelled = false;
  const r = await measure(signal => new Promise(resolve => {
    signal.addEventListener('abort', () => { cancelled = true; resolve(); }, {once:true});
  }), 15);
  assert.equal(cancelled, true); assert.equal(r.success, false); assert.equal(r.failure, 'DEADLINE');
});
test('deadline bounds even an uncooperative adapter', async () => {
  const r = await measure(() => new Promise(() => {}), 15);
  assert.equal(r.failure, 'DEADLINE');
});
test('preserves known DNS/connect evidence without guessing generic RPC phases', () => {
  const signal = new AbortController().signal;
  assert.equal(classify({cause:{code:'EAI_AGAIN'}},signal),'DNS');
  assert.equal(classify({cause:{code:'UND_ERR_CONNECT_TIMEOUT'}},signal),'CONNECT_TIMEOUT');
  assert.equal(classify({code:'UNAVAILABLE'},signal),'RPC_OR_NETWORK_PHASE_UNKNOWN');
});
test('reports successful and all-attempt quantiles separately', () => {
  const r = summary([{mode:'web',success:true,latencyMs:5},{mode:'web',success:false,latencyMs:10000}]);
  assert.equal(r.web.successRate,.5); assert.equal(r.web.successfulLatencyMs.p95,5);
  assert.equal(r.web.allLatencyMs.p95,10000); assert.equal(r.native.successRate,null);
});
