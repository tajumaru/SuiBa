// Offline investigation: execute unchanged methods extracted from main 78b1703.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const base = new URL('../', import.meta.url);
const source = readFileSync(new URL('packages/sui-client/src/index.ts', base), 'utf8');
const method = source.slice(source.indexOf('  async health(force'), source.indexOf('  close()'));
const budgetScope = new AsyncLocalStorage();
const currentReadBudget = () => budgetScope.getStore();
const budgetText = readFileSync(new URL('packages/shared/src/read-budget.ts', base), 'utf8');
const abortText = stripTypeScriptTypes(budgetText.slice(budgetText.indexOf('export function abortable')).replace('export ', ''));
const abortable = new Function(abortText + ';return abortable')();
const Health = new Function('currentReadBudget', 'abortable', 'randomUUID', 'SUI', 'USDC',
  stripTypeScriptTypes('class Health {' + method + '}') + ';return Health')(currentReadBudget, abortable, randomUUID, 'SUI', 'USDC');
const c = new Health();
Object.assign(c, { epoch: 0, status: { healthy: false, checkedAt: 0, failures: 0 }, scope: new AsyncLocalStorage(), assertEvidence() {}, emit() {} });
let release;
const held = new Promise(resolve => { release = resolve; });
let reads = 0;
// Isolate pending-cohort orchestration; deliberately bypass metadata/read transport.
c.metadata = async () => { reads++; await held; return {}; };
const old = c.health();
for (let i = 0; i < 2; i++) {
  const controller = new AbortController();
  const fresh = budgetScope.run({ signal: controller.signal, fresh: true }, () => c.health(true));
  controller.abort(Error('MARKET_DATA_STALLED'));
  await assert.rejects(fresh, /MARKET_DATA_STALLED/);
  assert.equal(reads, 2);
  assert.ok(c.pendingHealth);
}
release();
await old;
assert.equal(c.pendingHealth, undefined);
console.log('pending orchestration: two fresh callers aborted; old cohort remained pending until released; reads=2');
const text = readFileSync(new URL('packages/market-data/src/validation.ts', base), 'utf8');
const validateCandles = new Function(stripTypeScriptTypes(text.slice(text.indexOf('export function')).replace('export ', '')) + ';return validateCandles')();
const boundary = 1800000000;
const rows = Array.from({ length: 61 }, (_, i) => ({ timestamp: boundary - (62-i)*300, timeframe: 300, source: 'fixture', open: 1, close: 1, high: 1, low: 1, volume: 0 }));
validateCandles(rows, 300, (boundary + 60)*1000);
assert.throws(() => validateCandles(rows, 300, (boundary + 60.001)*1000), /STALE_CANDLES/);
console.log('actual validateCandles: previous closed candle accepted at boundary+60s; rejected at +60.001s');
