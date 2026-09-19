#!/usr/bin/env node
/**
 * Read-only forensic scan behind docs/bug-report/ghost-thread-cross-thread-session-routing/.
 *
 * Reproduces the four judgements in §3.1 that falsified the "server binds continuation to the
 * wrong thread" hypothesis, plus the two quantified fences in §3.2/R-2 that rule out a naive
 * content-side guard.
 *
 *   node scan-cross-thread-routing.mjs --redis redis://127.0.0.1:6379 [--prefix cat-cafe:]
 *
 * ONLY read commands (SCAN / HMGET / GET) are issued. It never writes, deletes or expires.
 * Point it at whichever instance you want to audit; it does not assume a specific deployment.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const REDIS_URL = argOf('--redis', process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const PREFIX = argOf('--prefix', 'cat-cafe:');

const Redis = require('ioredis');
const redis = new Redis(REDIS_URL);

const NON_MESSAGE_KEY = new RegExp(`^${PREFIX}msg:(timeline|user:|mentions:|thread:|visibility|idem)`);

async function scanKeys(pattern, onBatch, batchSize = 1500) {
  let cursor = '0';
  let batch = [];
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 3000);
    cursor = next;
    for (const key of keys) {
      if (pattern.endsWith('msg:*') && NON_MESSAGE_KEY.test(key)) continue;
      batch.push(key);
      if (batch.length >= batchSize) {
        await onBatch(batch);
        batch = [];
      }
    }
  } while (cursor !== '0');
  if (batch.length) await onBatch(batch);
}

const messages = new Map(); // id -> { threadId, catId, ts, extra }
await scanKeys(`${PREFIX}msg:*`, async (batch) => {
  const pipeline = redis.pipeline();
  for (const key of batch) pipeline.hmget(key, 'threadId', 'catId', 'timestamp', 'extra');
  const results = await pipeline.exec();
  results.forEach(([err, values], i) => {
    if (err || !values?.[0]) return;
    let extra = null;
    if (values[3]) {
      try {
        extra = JSON.parse(values[3]);
      } catch {
        /* unparsable extra is treated as absent */
      }
    }
    messages.set(batch[i].slice(`${PREFIX}msg:`.length), {
      threadId: values[0],
      catId: values[1] || 'USER',
      ts: Number(values[2]),
      extra,
    });
  });
});

// Judgement 1 — continuation binding: does any reply land in a thread its trigger is not in,
// WITHOUT the caller having declared a cross-post? That is the ghost-thread signature.
let causalEdges = 0;
let crossThreadReplies = 0;
let undeclared = 0;
for (const [, m] of messages) {
  const trigger = m.extra?.causal?.triggerMessageId;
  if (!trigger) continue;
  causalEdges++;
  const parent = messages.get(trigger);
  if (!parent || parent.threadId === m.threadId) continue;
  crossThreadReplies++;
  if (!m.extra?.crossPost?.sourceThreadId) undeclared++;
}

// Judgement 2 — wake binding: is a woken session ever bound to a thread other than the one
// its A2A trigger message lives in?
let sessions = 0;
let withTrigger = 0;
let wakeMismatch = 0;
let capsuleDrift = 0;
const activeByCatThread = new Map();
const byCliSession = new Map();
await scanKeys(
  `${PREFIX}session:*`,
  async (batch) => {
    const pipeline = redis.pipeline();
    for (const key of batch)
      pipeline.hmget(key, 'id', 'catId', 'threadId', 'cliSessionId', 'status', 'continuityCapsule');
    const results = await pipeline.exec();
    for (const [err, values] of results) {
      if (err || !values?.[0]) continue;
      sessions++;
      const [, catId, threadId, cliSessionId, status, capsuleRaw] = values;
      if (status === 'active') {
        const key = `${catId}|${threadId}`;
        activeByCatThread.set(key, (activeByCatThread.get(key) ?? 0) + 1);
      }
      if (cliSessionId) {
        if (!byCliSession.has(cliSessionId)) byCliSession.set(cliSessionId, new Set());
        byCliSession.get(cliSessionId).add(threadId);
      }
      if (!capsuleRaw) continue;
      let capsule;
      try {
        capsule = JSON.parse(capsuleRaw);
      } catch {
        continue;
      }
      if (capsule?.threadId && capsule.threadId !== threadId) capsuleDrift++;
      const trigger = capsule?.a2aTriggerMessageId;
      if (!trigger) continue;
      withTrigger++;
      const parent = messages.get(trigger);
      if (parent && parent.threadId !== threadId) wakeMismatch++;
    }
  },
  400,
);

// Judgement 3/4 — the two candidate content-side fences, quantified against real traffic.
const crossPosts = [...messages.entries()]
  .filter(([, m]) => m.extra?.crossPost?.sourceThreadId)
  .map(([id, m]) => ({ id, ...m }))
  .sort((a, b) => a.ts - b.ts);

const firstPostByCatThread = new Map();
for (const [, m] of messages) {
  const key = `${m.threadId}|${m.catId}`;
  const prev = firstPostByCatThread.get(key);
  if (prev === undefined || m.ts < prev) firstPostByCatThread.set(key, m.ts);
}
const subjectSeenIn = new Map();
for (const [, m] of messages) {
  const subject = m.extra?.coordination?.subjectRef;
  if (!subject) continue;
  if (!subjectSeenIn.has(subject)) subjectSeenIn.set(subject, []);
  subjectSeenIn.get(subject).push({ threadId: m.threadId, ts: m.ts });
}

let warm = 0;
let withSubject = 0;
let subjectAlreadyPresent = 0;
for (const cp of crossPosts) {
  const first = firstPostByCatThread.get(`${cp.threadId}|${cp.catId}`);
  if (first !== undefined && first < cp.ts) warm++;
  const subject = cp.extra.coordination?.subjectRef;
  if (!subject) continue;
  withSubject++;
  if ((subjectSeenIn.get(subject) ?? []).some((o) => o.threadId === cp.threadId && o.ts < cp.ts)) {
    subjectAlreadyPresent++;
  }
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
console.log(`corpus: ${messages.size} messages, ${sessions} sessions, ${crossPosts.length} cross-posts\n`);
console.log('— §3.1 falsification —');
console.log(`  causal reply edges                         : ${causalEdges}`);
console.log(`  replies landing outside the trigger thread : ${crossThreadReplies}`);
console.log(`  ... of which UNDECLARED (ghost signature)  : ${undeclared}   <- expect 0`);
console.log(`  sessions with an A2A trigger               : ${withTrigger}`);
console.log(`  ... wake bound to the wrong thread         : ${wakeMismatch}  <- expect 0`);
console.log(`  continuityCapsule / session thread drift    : ${capsuleDrift}  <- expect 0`);
console.log(
  `  cliSessionId shared across threads          : ${[...byCliSession.values()].filter((s) => s.size > 1).length}`,
);
console.log(
  `  duplicate active sessions per (cat,thread)  : ${[...activeByCatThread.values()].filter((c) => c > 1).length}`,
);
console.log('\n— §3.2 R-2: the two candidate fences —');
console.log(
  `  sender had prior participation in target   : ${warm}/${crossPosts.length} (${pct(warm, crossPosts.length)} would NOT be caught by a cold-open fence)`,
);
console.log(`  cross-posts carrying a subjectRef          : ${withSubject}/${crossPosts.length}`);
console.log(
  `  ... subject already present in target      : ${subjectAlreadyPresent} (${pct(withSubject - subjectAlreadyPresent, withSubject)} of subject-bearing cross-posts open a NEW subject = false-positive rate of a subject fence)`,
);

await redis.quit();
