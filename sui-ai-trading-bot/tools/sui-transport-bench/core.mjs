import { performance } from 'node:perf_hooks';

// Install before SDK construction: the SDK binds transport methods at construction.
export function countRpcCalls(transport) {
  let count = 0;
  const unary = transport.unary.bind(transport);
  transport.unary = (...args) => { count++; return unary(...args); };
  return () => count;
}

export function validatePlan(p) {
  const u = new URL(p.endpoint);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('INVALID_ENDPOINT');
  if (p.timeoutMs !== 10000 || !Number.isInteger(p.pairs) || p.pairs < 1 || p.pairs > 30 || !Number.isInteger(p.intervalMs) || p.intervalMs < 5000) throw Error('INVALID_BUDGET');
  if (!['metadata', 'balance', 'transaction'].includes(p.operation)) throw Error('READ_ONLY_OPERATION_REQUIRED');
  if (p.operation !== 'transaction' && !/^0x[a-fA-F0-9]+::\w+::\w+(?:<.*>)?$/.test(p.coinType ?? '')) throw Error('INVALID_COIN_TYPE');
  if (p.operation === 'balance' && !/^0x[a-fA-F0-9]{64}$/.test(p.owner ?? '')) throw Error('INVALID_OWNER');
  if (p.operation === 'transaction' && !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(p.digest ?? '')) throw Error('INVALID_DIGEST');
  return p;
}

export function classify(error, signal) {
  const codes = [];
  for (let e = error, i = 0; e && i < 5; e = e.cause, i++) codes.push(e.code);
  if (signal.aborted) return 'DEADLINE';
  if (codes.some(c => ['ENOTFOUND', 'EAI_AGAIN'].includes(c))) return 'DNS';
  if (codes.includes('UND_ERR_CONNECT_TIMEOUT')) return 'CONNECT_TIMEOUT';
  if (codes.includes('UND_ERR_HEADERS_TIMEOUT')) return 'HEADERS_TIMEOUT';
  if (codes.includes('UND_ERR_BODY_TIMEOUT')) return 'BODY_TIMEOUT';
  if (codes.includes('RESOURCE_EXHAUSTED') || codes.includes(8)) return 'RATE_LIMIT_OR_RESOURCE_EXHAUSTED';
  if (codes.includes('DEADLINE_EXCEEDED') || codes.includes(4)) return 'DEADLINE_PHASE_UNKNOWN';
  return 'RPC_OR_NETWORK_PHASE_UNKNOWN';
}

export async function measure(call, timeoutMs = 10000) {
  const start = performance.now(), cpu = process.cpuUsage();
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Deadline', 'TimeoutError'));
      reject(controller.signal.reason);
    }, timeoutMs);
  });
  let success = false, failure = null;
  try {
    await Promise.race([Promise.resolve().then(() => call(controller.signal)), deadline]);
    controller.signal.throwIfAborted();
    success = true;
  } catch (e) { failure = classify(e, controller.signal); }
  finally { clearTimeout(timer); }
  const usage = process.cpuUsage(cpu), memory = process.memoryUsage();
  return { success, failure, latencyMs: performance.now() - start,
    cpuUserUs: usage.user, cpuSystemUs: usage.system,
    rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external };
}

export function summary(rows) {
  const quantiles = xs => {
    xs.sort((a,b) => a-b);
    return Object.fromEntries([50,95,99].map(p => [`p${p}`, xs.length ? xs[Math.ceil(p / 100 * xs.length) - 1] : null]));
  };
  return Object.fromEntries(['web', 'native'].map(mode => {
    const r = rows.filter(x => x.mode === mode), ok = r.filter(x => x.success);
    return [mode, { count: r.length, success: ok.length, successRate: r.length ? ok.length/r.length : null,
      successfulLatencyMs: quantiles(ok.map(x => x.latencyMs)), allLatencyMs: quantiles(r.map(x => x.latencyMs)),
      p99IsExploratory: true, recoveryTimeMs: null }];
  }));
}
