#!/usr/bin/env node
// F257 falsifiers (terminal-contract-v1.md §4, F-1~F-8). Read-only against Redis + API.
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { snapshotDerivedKeys } from './checks/derived-keys.mjs';
import { checkF1, checkF3Observed } from './checks/f1-f3-obs.mjs';
import { checkF2, checkF3 } from './checks/f2-f3.mjs';
import { checkF6 } from './checks/f6.mjs';
import { checkF4, checkF7 } from './checks/f7-f4.mjs';
import { checkF8 } from './checks/f8.mjs';
import { checkUnbound } from './checks/unbound.mjs';
import { createApiClient } from './lib/api.mjs';
import { HELP, parseArgs } from './lib/args.mjs';
import { openRedis } from './lib/redis.mjs';
import { combine, exitCode, renderTable, summarize } from './lib/report.mjs';

const API_CHECKS = new Set(['F-5', 'F-6']);

async function runBaseline(options, redis) {
  const baseline = await snapshotDerivedKeys(redis, options.keyPrefix);
  writeFileSync(options.baselinePath, JSON.stringify(baseline, null, 2));
  const counts = Object.fromEntries(Object.entries(baseline.keys).map(([name, keys]) => [name, keys.length]));
  console.log(
    JSON.stringify(
      { mode: 'baseline', baselinePath: options.baselinePath, capturedAt: baseline.capturedAt, counts },
      null,
      2,
    ),
  );
}

export async function runCheck(id, context) {
  switch (id) {
    case 'F-1':
      return checkF1(context);
    case 'F-2':
      return checkF2(context);
    case 'F-3': {
      const residue = await checkF3(context);
      const observed = await checkF3Observed(context);
      return combine('F-3', [residue, observed]);
    }
    case 'F-4':
      return checkF4(context);
    case 'F-6':
      return checkF6(context);
    case 'F-7':
      return checkF7(context);
    case 'F-8':
      return checkF8(context);
    default:
      return checkUnbound(id);
  }
}

async function runVerify(options, redis) {
  const baseline = JSON.parse(readFileSync(options.baselinePath, 'utf8'));
  const api = options.checks.some((id) => API_CHECKS.has(id)) ? await createApiClient(options.apiUrl) : null;
  const context = { ...options, redis, api, baseline };
  const results = [];
  for (const id of options.checks) results.push(await runCheck(id, context));
  console.log(renderTable(results));
  console.log(JSON.stringify({ mode: 'verify', summary: summarize(results) }));
  if (options.jsonOutPath) {
    const redacted = { ...options, redisUrl: '<redacted>' };
    writeFileSync(options.jsonOutPath, JSON.stringify({ capturedAt: Date.now(), options: redacted, results }, null, 2));
  }
  process.exitCode = exitCode(results);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const redis = await openRedis(options.redisUrl);
  try {
    if (options.mode === 'baseline') await runBaseline(options, redis);
    else await runVerify(options, redis);
  } finally {
    await redis.quit();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
