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
 *
 * MEASUREMENT SEMANTICS — read this before quoting any percentage below.
 * The corpus is UNLABELLED: no past cross-post carries a verdict saying whether it was a
 * correct delivery. Therefore every fence number this script prints is a REJECTION SHARE
 * ("what fraction of real past traffic would this fence refuse"), never a false-positive
 * rate / precision ("what fraction of those refusals would be wrong"). Computing precision
 * needs labels this store does not have. Treat a high rejection share as a cost signal, not
 * as proof the refused deliveries were legitimate.
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

// Snapshot boundary. A bare scan of a live store is NOT reproducible: SCAN is not a
// snapshot and new traffic lands mid-run (observed drift 960 -> 965 -> 966 across
// consecutive reads). Pin a cutoff so a stated number can be re-derived later.
//   --before-ts <unix_ms>          exclude messages with ts > cutoff
//   --through-message-id <msgId>   same, using the message's own ts as the cutoff
const BEFORE_TS_ARG = argOf('--before-ts', null);
const THROUGH_MESSAGE_ID = argOf('--through-message-id', null);

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

// Resolve the snapshot boundary. --through-message-id wins; it is the more honest form
// because the cutoff is then a real, citable message rather than a bare epoch number.
let cutoffTs = BEFORE_TS_ARG === null ? null : Number(BEFORE_TS_ARG);
let cutoffMessageId = null;
if (THROUGH_MESSAGE_ID) {
  const cutoffMessage = messages.get(THROUGH_MESSAGE_ID);
  if (!cutoffMessage) {
    console.error(`--through-message-id ${THROUGH_MESSAGE_ID} not found in the scanned corpus`);
    process.exit(2);
  }
  cutoffTs = cutoffMessage.ts;
  cutoffMessageId = THROUGH_MESSAGE_ID;
}
if (cutoffTs !== null && !Number.isFinite(cutoffTs)) {
  console.error(`--before-ts must be a unix-ms number, got: ${BEFORE_TS_ARG}`);
  process.exit(2);
}
// Truncate on the (timestamp, messageId) tuple, not timestamp alone: several messages
// can share a millisecond, and `ts <= cutoff` would include siblings that sort after the
// named cutoff message. Message ids are zero-padded `<ts>-<seq>-<hash>`, so lexicographic
// comparison is a total order consistent with arrival.
const withinCutoff = (m, id) => {
  if (cutoffTs === null) return true;
  if (m.ts !== cutoffTs) return m.ts < cutoffTs;
  // Same millisecond as the boundary: only meaningful when the boundary names a message.
  return cutoffMessageId === null ? true : id <= cutoffMessageId;
};

// Judgement 3/4 — the two candidate content-side fences, quantified against real traffic.
const crossPosts = [...messages.entries()]
  .filter(([id, m]) => m.extra?.crossPost?.sourceThreadId && withinCutoff(m, id))
  .map(([id, m]) => ({ id, ...m }))
  .sort((a, b) => a.ts - b.ts);

// Participation-density input: how many historical cross-posts carry ANY coordination
// metadata. Note this is metadata presence, NOT membership truth -- it is an upper bound
// on what a participation backfill could recover from history, nothing stronger.
const crossPostsWithCoordination = crossPosts.filter((cp) => cp.extra?.coordination).length;

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

// Judgement 5 — the STRUCTURAL standing fence (§3.2 R-2b).
// Judgements 3/4 test two CONTENT heuristics and rule them out. That does not license the
// broader claim "no fence is available": thread lineage is a declared server-side fact, not an
// inference about what a message is "about". RedisThreadStore persists parentThreadId and keeps
// a children index, so source→target family membership is decidable without guessing.
// This measures the COST (rejection share) of a FAIL-CLOSED structural fence against real traffic.
//
// Two limits are structural, not tuning knobs:
//   (a) parentThreadId is an OPEN world. It proves a relation exists; its absence proves
//       nothing. "Target is outside the source's family" is therefore NOT equivalent to
//       "the delivery had no standing" — lineage is not an allowlist of legitimate targets.
//   (b) "Source declares a parent" is the NARROW scope. A source thread can also be the
//       PARENT of other threads (the children index), which is just as much recorded lineage.
//       Both scopes are reported below; neither is a complete measure of standing.
const threadParent = new Map();
const threadDetailKey = new RegExp(`^${PREFIX}thread:[^:]+$`);
await scanKeys(
  `${PREFIX}thread:*`,
  async (batch) => {
    const detailKeys = batch.filter((k) => threadDetailKey.test(k));
    if (!detailKeys.length) return;
    const pipeline = redis.pipeline();
    for (const key of detailKeys) pipeline.hget(key, 'parentThreadId');
    const results = await pipeline.exec();
    results.forEach(([err, parentThreadId], i) => {
      if (err) return;
      threadParent.set(detailKeys[i].slice(`${PREFIX}thread:`.length), parentThreadId ?? null);
    });
  },
  800,
);

/** Parent, child or sibling — the relationships propose_thread actually records. */
const familyLinked = (source, target) => {
  if (!source || !target) return false;
  const parentOfSource = threadParent.get(source) ?? null;
  const parentOfTarget = threadParent.get(target) ?? null;
  if (parentOfTarget === source || parentOfSource === target) return true;
  return Boolean(parentOfSource && parentOfTarget && parentOfSource === parentOfTarget);
};

/** Threads that some other thread points at as its parent — the children index, inverted. */
const declaredAsParent = new Set([...threadParent.values()].filter(Boolean));
/** Any recorded lineage at all: the thread declares a parent, or is itself declared a parent. */
const hasAnyLineage = (threadId) => Boolean(threadParent.get(threadId)) || declaredAsParent.has(threadId);

let knownBothEnds = 0;
let structurallyLinked = 0;
// Scoped variant: only fence cross-posts whose SOURCE thread has recorded lineage.
// Those are the cases where the store demonstrably holds a better answer than a guess
// (incident I-3: the source's own parentThreadId WAS the operator-confirmed correct target).
// NARROW = source declares a parentThreadId. BROAD = source declares one OR is one.
let sourceDeclaresFamily = 0;
let sourceDeclaresFamilyButLeaves = 0;
let sourceHasLineage = 0;
let sourceHasLineageButLeaves = 0;
for (const cp of crossPosts) {
  const source = cp.extra.crossPost.sourceThreadId;
  if (!threadParent.has(source) || !threadParent.has(cp.threadId)) continue;
  knownBothEnds++;
  const linked = familyLinked(source, cp.threadId);
  if (linked) structurallyLinked++;
  if (threadParent.get(source)) {
    sourceDeclaresFamily++;
    if (!linked) sourceDeclaresFamilyButLeaves++;
  }
  if (hasAnyLineage(source)) {
    sourceHasLineage++;
    if (!linked) sourceHasLineageButLeaves++;
  }
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
console.log(`loaded live corpus: ${messages.size} messages, ${sessions} sessions`);
console.log('  (the boundary below bounds ONLY the cross-post metrics; the 3.1 counters above');
console.log('   are computed over the whole live corpus and are not snapshot-pinned)');
if (cutoffTs === null) {
  console.log(
    '  cross-post analysis boundary               : NONE (live scan -- NOT reproducible; pass --through-message-id or --before-ts before citing any number)',
  );
} else {
  console.log(`  cross-post analysis boundary (ts)          : ${cutoffTs}`);
  if (cutoffMessageId) console.log(`  cross-post analysis boundary (message)     : ${cutoffMessageId}`);
}
console.log(`  cross-posts within boundary                : ${crossPosts.length}`);
console.log(
  `  cross-posts carrying coordination metadata : ${crossPostsWithCoordination}/${crossPosts.length} (${pct(crossPostsWithCoordination, crossPosts.length)}) <- upper bound for participation backfill, not membership truth`,
);
console.log('');
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
  `  ... subject already present in target      : ${subjectAlreadyPresent} (${pct(withSubject - subjectAlreadyPresent, withSubject)} of subject-bearing cross-posts open a NEW subject = rejection share of a subject fence)`,
);
console.log('\n— §3.2 R-2b: the structural standing fence —');
console.log(`  threads with a detail record               : ${threadParent.size}`);
console.log(`  ... of which declare a parentThreadId      : ${[...threadParent.values()].filter(Boolean).length}`);
console.log(`  cross-posts with both endpoints resolvable : ${knownBothEnds}/${crossPosts.length}`);
console.log(
  `  ... source/target in the same thread family: ${structurallyLinked} (${pct(structurallyLinked, knownBothEnds)})`,
);
console.log(
  `  ... NOT family-linked                      : ${knownBothEnds - structurallyLinked} (${pct(knownBothEnds - structurallyLinked, knownBothEnds)} = share of REAL traffic a fail-closed structural fence would refuse)`,
);
console.log(
  `  SCOPED/narrow: source declares a parentThreadId : ${sourceDeclaresFamily}/${knownBothEnds} (${pct(sourceDeclaresFamily, knownBothEnds)})`,
);
console.log(
  `  ... of those, leaving the family           : ${sourceDeclaresFamilyButLeaves} (${pct(sourceDeclaresFamilyButLeaves, sourceDeclaresFamily)} = rejection share)`,
);
console.log(
  `  SCOPED/broad: source declares a parent OR is one : ${sourceHasLineage}/${knownBothEnds} (${pct(sourceHasLineage, knownBothEnds)})`,
);
console.log(
  `  ... of those, leaving the family           : ${sourceHasLineageButLeaves} (${pct(sourceHasLineageButLeaves, sourceHasLineage)} = rejection share)`,
);
console.log(
  '\n  NOTE: the corpus carries no per-delivery verdict. Every "rejection share" above is the\n' +
    '        fraction of REAL past traffic a fence would refuse — NOT a measured false-positive\n' +
    '        rate. Precision is unknown; incident I-3 is the one confirmed true positive.',
);

await redis.quit();
