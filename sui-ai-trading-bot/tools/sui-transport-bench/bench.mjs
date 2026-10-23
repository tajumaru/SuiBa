import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { validatePlan, measure, summary, countRpcCalls } from './core.mjs';

// No Bot imports, environment loading, DB access, HTTP listener or scheduler.
const root = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--worker') {
  let transport;
  process.once('message', async ({ mode, plan }) => {
    try {
      validatePlan(plan);
      const { SuiGrpcClient, GrpcWebFetchTransport } = await import('@mysten/sui/grpc');
      if (mode === 'native') {
        const { GrpcTransport } = await import('@protobuf-ts/grpc-transport');
        const { credentials } = await import('@grpc/grpc-js');
        transport = new GrpcTransport({ host: new URL(plan.endpoint).host,
          channelCredentials: credentials.createSsl(), timeout: plan.timeoutMs,
          clientOptions: { 'grpc.enable_retries': 0 } });
      } else {
        transport = new GrpcWebFetchTransport({ baseUrl: plan.endpoint.replace(/\/$/, ''), format: 'text', timeout: plan.timeoutMs });
      }
      const rpcCalls = countRpcCalls(transport);
      const client = new SuiGrpcClient({ network: 'mainnet', transport });
      process.on('message', async msg => {
        if (msg === 'close') { transport.close?.(); process.exit(0); }
        if (msg !== 'read') return;
        const before = rpcCalls();
        let responseHash = null;
        const result = await measure(async signal => {
          if (plan.operation === 'metadata') {
            const { coinMetadata: m } = await client.getCoinMetadata({ coinType: plan.coinType, signal });
            if (!m || !Number.isInteger(m.decimals)) throw Error('INVALID_METADATA');
            if (plan.coinType === '0x2::sui::SUI' && (m.decimals !== 9 || m.symbol !== 'SUI')) throw Error('INVALID_SUI_METADATA');
            responseHash = createHash('sha256').update(JSON.stringify(m)).digest('hex');
          } else if (plan.operation === 'balance') {
            const { balance: b } = await client.getBalance({ owner: plan.owner, coinType: plan.coinType, signal });
            if (!b || !/^\d+$/.test(b.balance)) throw Error('INVALID_BALANCE');
          } else {
            const r = await client.getTransaction({ digest: plan.digest, include: { effects: true }, signal });
            if ((r.Transaction ?? r.FailedTransaction)?.digest !== plan.digest) throw Error('INVALID_TRANSACTION');
          }
        }, plan.timeoutMs);
        process.send({ result: { ...result, rpcCalls: rpcCalls() - before, responseHash } });
      });
      process.send({ ready: true });
    } catch { process.send({ error: 'DEPENDENCY_OR_SETUP_FAILED' }); process.exitCode = 1; process.disconnect(); }
  });
} else {
  const plan = validatePlan(JSON.parse(await readFile(resolve(args[1] ?? join(root, 'plan.example.json')), 'utf8')));
  if (args[0] !== '--approved-live') {
    console.log(JSON.stringify({ dryRun: true, plan, maxRequests: plan.pairs * 2, networkRequests: 0 }, null, 2));
  } else {
    const out = join(root, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
    await writeFile(join(out, 'environment.json'), JSON.stringify({
      node: process.version, undici: process.versions.undici,
      platform: process.platform, arch: process.arch,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dependencies: JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages,
      startedAt: new Date().toISOString(),
    }, null, 2));
    const children = new Map(), rows = [];
    const receive = child => new Promise((res, rej) => {
      const timer = setTimeout(() => { cleanup(); rej(Error('WORKER_WATCHDOG')); }, 15000);
      const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); };
      const message = m => { cleanup(); m.error ? rej(Error(m.error)) : res(m); };
      const exited = () => { cleanup(); rej(Error('WORKER_EXIT')); };
      child.once('message', message); child.once('exit', exited);
    });
    try {
      for (const mode of ['web', 'native']) {
        const child = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.set(mode, child);
        const ready = receive(child); child.send({ mode, plan }); await ready;
      }
      let failures = 0;
      for (let pair = 0; pair < plan.pairs; pair++) {
        for (const mode of pair % 2 ? ['native', 'web'] : ['web', 'native']) {
          const child = children.get(mode), pending = receive(child);
          child.send('read'); const { result } = await pending;
          rows.push({ pair, mode, operation: plan.operation, at: Date.now(), ...result });
          console.log(JSON.stringify({ pair, mode, success: result.success, latencyMs: Math.round(result.latencyMs), failure: result.failure, rpcCalls: result.rpcCalls }));
          await writeFile(join(out, 'attempts.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
          failures = result.success ? 0 : failures + 1;
          // A deadline may leave a faulty adapter working: stop rather than overlap requests.
          if (result.rpcCalls !== 1) throw Error('UNEXPECTED_RPC_COUNT');
          if (failures >= 3 || ['DEADLINE', 'DEADLINE_PHASE_UNKNOWN', 'RATE_LIMIT_OR_RESOURCE_EXHAUSTED'].includes(result.failure)) throw Error('STOPPED_UPSTREAM_FAILURE');
          await pause(plan.intervalMs);
        }
      }
    } finally {
      for (const child of children.values()) {
        if (child.connected) child.send('close');
        const timer = setTimeout(() => child.kill(), 1000);
        timer.unref();
        child.once('exit', () => clearTimeout(timer));
      }
      await writeFile(join(out, 'summary.json'), JSON.stringify(summary(rows), null, 2));
    }
  }
}
