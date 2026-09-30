// Targeted, in-memory reconstruction. No model, Redis, runtime or config access.
// Usage from the feature root: node packages/api/scripts/f117-token-count-probe.mjs <MCP-full.json> <output-dir>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { encodingForModel } from 'js-tiktoken';
import { assembleIncrementalContext } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { estimateTokens } from '../dist/utils/token-counter.js';

const rawFile = process.argv[2];
const outDir = process.argv[3];
if (!rawFile || !outDir) throw new Error('Supply a controlled MCP full fixture and owned output directory');
const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const attachment = raw.message.contentBlocks[0].attachment;
fs.mkdirSync(outDir, { recursive: true });
const results = {
  fixtureKind: 'controlled reconstruction, NOT whole alpha replay or human acceptance',
  quoteChars: attachment.text.length,
  quoteSha256: createHash('sha256').update(attachment.text).digest('hex'),
  cases: [],
};
const save = () => fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));

async function measure(name, fn) {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await new Promise((resolve) => setTimeout(resolve, 30));
  let timerLagMs;
  const scheduled = performance.now();
  const timerDone = new Promise((resolve) =>
    setTimeout(() => {
      timerLagMs = performance.now() - scheduled - 10;
      resolve();
    }, 10),
  );
  const cpu = process.cpuUsage();
  const start = performance.now();
  const value = await fn();
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  await timerDone;
  await new Promise((resolve) => setTimeout(resolve, 30));
  delay.disable();
  const entry = {
    name,
    wallMs,
    cpuUserMs: used.user / 1000,
    cpuSystemMs: used.system / 1000,
    timerLagMs,
    eventLoopMaxMs: delay.max / 1e6,
    value,
  };
  results.cases.push(entry);
  save();
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  return value;
}

await measure('tokenizer-initialization-control', () => estimateTokens('短消息 control'));
for (const length of [1000, 3000, attachment.text.length]) {
  await measure(`actual-quote-${length}`, () => estimateTokens(attachment.text.slice(0, length)));
}

for (const heavy of [false, true]) {
  const messageStore = new MessageStore();
  const userId = 'f117-f3-fixture-user';
  const threadId = 'f117-f3-fixture-thread';
  let current;
  for (let i = 0; i < 142; i++)
    current = messageStore.append({
      from: { kind: 'user', userId },
      userId,
      threadId,
      timestamp: 1790790000000 + i * 1000,
      content: heavy && i === 140 ? attachment.text : `Controlled context message ${i}`,
      ...(heavy && i === 141 ? { contentBlocks: raw.message.contentBlocks } : {}),
      mentions: [],
    });
  const value = await measure(
    heavy ? 'heavy-context-142-with-actual-12k-body-and-quote' : 'small-context-142-control',
    async () => {
      const result = await assembleIncrementalContext(
        { services: {}, invocationDeps: {}, messageStore, deliveryCursorStore: new DeliveryCursorStore() },
        userId,
        threadId,
        'opus',
        current.id,
        'debug',
        {
          effectiveMaxContextTokens: 500000,
          contextProjection: {
            coordinate: {
              providerCarrier: { provider: 'claude', carrier: 'sdk' },
              invocationOrigin: 'interactive',
              routeTopology: 'serial',
            },
            contextEpoch: 1,
            contextMode: 'cold',
            transition: 'scope_first_seen',
            reason: 'no_prior_session',
          },
        },
      );
      return {
        chars: result.contextText.length,
        projected: result.projectedMessageIds.length,
        hasQuoteMarker: result.contextText.includes('QBIGQ-HEAD'),
        hasTailMarker: result.contextText.includes('QBIGQ-TAIL'),
      };
    },
  );
  if (heavy) {
    // Exact previously saved reconstruction output shape; fixture intentionally
    // uses the same timestamps/message order/context budget, not live user data.
    assert.equal(value.chars, 26204);
    assert.equal(value.projected, 12);
    assert.equal(value.hasQuoteMarker, true);
    assert.equal(value.hasTailMarker, true);
  }
}

// Run the slow original only once for an exact large-input oracle. This is a
// bounded managed command, NOT a production fallback or a normal test-suite job.
const reference = encodingForModel('gpt-4o');
const originalCount = await measure(
  'original-full-quote-exact-count-oracle',
  () => reference.encode(attachment.text, [], []).length,
);
results.exactCountMatches = originalCount === estimateTokens(attachment.text);
save();
assert.equal(results.exactCountMatches, true);
