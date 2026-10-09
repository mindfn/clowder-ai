import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('community sync wiring in index.ts', () => {
  test('guards main api bootstrap against dropping community sync dependencies', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');

    assert.ok(source.includes('const fetchIssuesForSync = async (repo: string) => {'));
    assert.ok(!source.includes('fetchPrsForSync'));
    assert.ok(!source.includes('fetchPrReviewsForSync'));
    assert.ok(!source.includes('InMemoryCommunityPrStore'));
    assert.ok(source.includes('new InstalledPrObservations(pluginRuntime.inventoryStore, pluginRuntime.supervisor)'));
    assert.ok(
      source.includes('fetchIssues: fetchIssuesForSync'),
      'REGRESSION: communityIssueRoutes must receive fetchIssues for GitHub issue sync.',
    );
    assert.ok(
      source.includes('pullRequests,'),
      'communityIssueRoutes must receive the installed PR observation source.',
    );
    assert.ok(
      source.includes('registry,'),
      'REGRESSION: communityIssueRoutes must keep callback auth wiring from the shared InvocationRegistry.',
    );
    // F168 Phase C C0.2 (optional-dep 硬层守护): threadStore 是 routeAccepted Path 2
    // （narrator 推荐新建 thread）的强依赖。注释标记精确定位 communityIssueRoutes
    // register block，避免误匹配 index.ts 其它 register 的 threadStore。
    assert.ok(
      source.includes('threadStore, // F168 Phase C'),
      'REGRESSION: communityIssueRoutes must receive threadStore for narrator Path 2 (new-thread) routing — without it routeAccepted silently drops new-thread cases (F168 Phase C C0.1).',
    );
  });
});
