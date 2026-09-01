import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { CANONICAL_TOOL_REGISTRY } from '../src/canonical-server-tools.js';
import type { McpSurfaceSnapshot } from '../src/tool-governance-snapshot.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

const STALE_PROPOSE_THREAD_PHRASES = [
  'automatically inject',
  'automatically injects',
  'maintainer five questions',
  'Strategy B',
  'zts212653/clowder-ai PR',
  '服务端自动注入 maintainer 五问',
  'server 自动注入',
];

const STALE_CAPABILITY_WAKEUP_PHRASES = ['服务端自动注入 maintainer 五问', 'server 自动注入', 'automatically inject'];

const STALE_SKILL_INDEX_PHRASES = ['clowder-ai inbound/outbound', 'Repo Inbox', '社区 issue/PR maintainer 守门'];

const STALE_THREAD_ORCHESTRATION_PHRASES = [
  'Strategy B',
  '家猫 fixup',
  '服务端自动注入 opensource-ops',
  'server 自动注入',
];

const STALE_OPENSOURCE_OPS_PHRASES = [
  'Strategy B',
  '家猫',
  '服务端自动注入',
  'server 自动注入',
  'zts212653/clowder-ai',
  '无条件同步',
];

const STALE_MANIFEST_PHRASES = [
  'Strategy B',
  '家猫',
  '服务端自动注入',
  'server 自动注入',
  'zts212653/clowder-ai',
  '无条件同步',
];

const REQUIRED_OPENSOURCE_OPS_CONTRACT_TERMS = [
  'provider-neutral',
  'providerSubject',
  'verifiedAuthorIdentity',
  'authenticatedContributorIdentity',
  'authenticatedRole',
  'cat_cafe_set_thread_metadata',
  'reverse provenance',
];

async function readText(...segments: string[]): Promise<string> {
  return readFile(resolve(repoRoot, ...segments), 'utf8');
}

describe('#1387 opensource-ops surface regression', () => {
  it('cat_cafe_propose_thread source description does not contain stale server-inference phrases', () => {
    const definition = CANONICAL_TOOL_REGISTRY.find((d) => d.name === 'cat_cafe_propose_thread');
    assert.ok(definition, 'cat_cafe_propose_thread must be registered');
    const text = definition.description.toLowerCase();
    for (const phrase of STALE_PROPOSE_THREAD_PHRASES) {
      assert.ok(!text.includes(phrase.toLowerCase()), `source description contains stale phrase: ${phrase}`);
    }
  });

  it('cat_cafe_propose_thread input schema does not contain stale server-inference phrases', () => {
    const definition = CANONICAL_TOOL_REGISTRY.find((d) => d.name === 'cat_cafe_propose_thread');
    assert.ok(definition, 'cat_cafe_propose_thread must be registered');
    const schemaJson = JSON.stringify(definition.inputSchema).toLowerCase();
    for (const phrase of STALE_PROPOSE_THREAD_PHRASES) {
      assert.ok(!schemaJson.includes(phrase.toLowerCase()), `input schema contains stale phrase: ${phrase}`);
    }
  });

  it('governed MCP baseline matches the source registry for propose_thread', async () => {
    const baseline = JSON.parse(
      await readText('packages/mcp-server/governance/mcp-surface-baseline.json'),
    ) as McpSurfaceSnapshot;
    const baselineTool = baseline.tools.find((t) => t.name === 'cat_cafe_propose_thread');
    assert.ok(baselineTool, 'baseline must include cat_cafe_propose_thread');

    const definition = CANONICAL_TOOL_REGISTRY.find((d) => d.name === 'cat_cafe_propose_thread');
    assert.ok(definition, 'source registry must include cat_cafe_propose_thread');
    assert.equal(baselineTool.description, definition.description);
  });

  it('governed MCP baseline propose_thread description does not contain stale phrases', async () => {
    const baseline = JSON.parse(
      await readText('packages/mcp-server/governance/mcp-surface-baseline.json'),
    ) as McpSurfaceSnapshot;
    const tool = baseline.tools.find((t) => t.name === 'cat_cafe_propose_thread');
    assert.ok(tool, 'baseline must include cat_cafe_propose_thread');
    const text = tool.description.toLowerCase();
    for (const phrase of STALE_PROPOSE_THREAD_PHRASES) {
      assert.ok(!text.includes(phrase.toLowerCase()), `baseline description contains: ${phrase}`);
    }
  });

  it('capability-wakeup-index.md does not claim server auto-injects maintainer questions', async () => {
    const text = await readText('cat-cafe-skills/refs/capability-wakeup-index.md');
    const lower = text.toLowerCase();
    for (const phrase of STALE_CAPABILITY_WAKEUP_PHRASES) {
      assert.ok(!lower.includes(phrase.toLowerCase()), `capability-wakeup-index contains: ${phrase}`);
    }
  });

  it('cat-cafe-skills/index.md opensource-ops entry is portable and repo-neutral', async () => {
    const text = await readText('cat-cafe-skills/index.md');
    const rowMatch = /\| opensource-ops\/SKILL\.md \|[^|]+\|([^|]+)\|/.exec(text);
    assert.ok(rowMatch, 'opensource-ops row must exist in skill index');
    const description = rowMatch[1].toLowerCase();
    for (const phrase of STALE_SKILL_INDEX_PHRASES) {
      assert.ok(!description.includes(phrase.toLowerCase()), `skill index contains: ${phrase}`);
    }
    assert.ok(description.includes('provider-neutral'), 'skill index must mention provider-neutral contract');
    assert.ok(!description.includes('github'), 'skill index must not hard-code GitHub');
  });

  it('thread-orchestration/SKILL.md does not contain stale Strategy B / server-inference phrases', async () => {
    const text = await readText('cat-cafe-skills/thread-orchestration/SKILL.md');
    const lower = text.toLowerCase();
    for (const phrase of STALE_THREAD_ORCHESTRATION_PHRASES) {
      assert.ok(!lower.includes(phrase.toLowerCase()), `thread-orchestration skill contains: ${phrase}`);
    }
  });

  it('opensource-ops/SKILL.md contains required provider-neutral contract terms', async () => {
    const text = await readText('cat-cafe-skills/opensource-ops/SKILL.md');
    const lower = text.toLowerCase();
    for (const term of REQUIRED_OPENSOURCE_OPS_CONTRACT_TERMS) {
      assert.ok(lower.includes(term.toLowerCase()), `opensource-ops skill missing contract term: ${term}`);
    }
  });

  it('opensource-ops/SKILL.md does not contain stale instance-specific / server-inference phrases', async () => {
    const text = await readText('cat-cafe-skills/opensource-ops/SKILL.md');
    const lower = text.toLowerCase();
    for (const phrase of STALE_OPENSOURCE_OPS_PHRASES) {
      assert.ok(!lower.includes(phrase.toLowerCase()), `opensource-ops skill contains stale phrase: ${phrase}`);
    }
  });

  it('opensource-ops/SKILL.md treats GitHub only as an adapter example, not as the workflow identity', async () => {
    const text = await readText('cat-cafe-skills/opensource-ops/SKILL.md');
    const lower = text.toLowerCase();
    assert.ok(lower.includes('provider adapter'), 'must mention provider adapter abstraction');
    assert.ok(
      lower.includes('github') && (lower.includes('example') || lower.includes('例如')),
      'GitHub must be framed as one provider adapter example',
    );
  });

  it('cat-cafe-skills/manifest.yaml opensource-ops entry does not contain stale instance-specific phrases', async () => {
    const yaml = await readText('cat-cafe-skills/manifest.yaml');
    const start = yaml.indexOf('  opensource-ops:');
    assert.ok(start >= 0, 'manifest must contain opensource-ops entry');
    const end = yaml.indexOf('\n  open-source-teardown:', start);
    const block = end > start ? yaml.slice(start, end) : yaml.slice(start);
    const lower = block.toLowerCase();
    for (const phrase of STALE_MANIFEST_PHRASES) {
      assert.ok(
        !lower.includes(phrase.toLowerCase()),
        `manifest opensource-ops entry contains stale phrase: ${phrase}`,
      );
    }
  });

  it('cat-cafe-skills/manifest.yaml opensource-ops entry is provider-neutral and treats GitHub as an adapter example', async () => {
    const yaml = await readText('cat-cafe-skills/manifest.yaml');
    const start = yaml.indexOf('  opensource-ops:');
    assert.ok(start >= 0, 'manifest must contain opensource-ops entry');
    const end = yaml.indexOf('\n  open-source-teardown:', start);
    const block = end > start ? yaml.slice(start, end) : yaml.slice(start);
    const lower = block.toLowerCase();
    assert.ok(lower.includes('provider-neutral'), 'manifest opensource-ops description must mention provider-neutral');
    assert.ok(lower.includes('provider adapter'), 'manifest must mention provider adapter abstraction');
    if (lower.includes('github')) {
      assert.ok(
        lower.includes('example') || lower.includes('例如'),
        'manifest must frame GitHub as one provider adapter example',
      );
    }
  });
});
