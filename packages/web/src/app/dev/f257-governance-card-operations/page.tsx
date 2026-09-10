'use client';

/**
 * F257 governance card — action/diff fixtures.
 *
 * Why this page exists (operator 2026-09-10): four review rounds on #171 found
 * seven approval-fact defects in this card, and NONE of them could be seen by
 * any cat. The existing showcase (`/showcase/f257-governance-journey`) builds an
 * ApprovalHubItem whose `detail` carries no `changes` at all, so
 * F257GovernanceChanges renders "本卡没有可执行动作" — the action-diff dialog was
 * never on screen. Real cards only appear after a real governance cycle, so the
 * defects were only reachable after merge.
 *
 * This page constructs the data instead of waiting for it: one card per
 * ArtifactOperation, so the whole dialog can be opened and looked at before
 * asking anyone to review it.
 *
 * Fixtures are typed against the production union — a drift becomes a compile
 * error here, not a demo that quietly diverges from what the executor emits.
 */

import type { ApprovalHubItem, HarnessGovernanceProposalChange } from '@cat-cafe/shared';
import { useState } from 'react';
import { GenericApprovalRecommendation } from '@/components/GenericApprovalRecommendation';
import { SettingsText } from '@/components/settings/primitives';

const WINDOW = { start: 1_700_000_000_000, end: 1_700_086_400_000 };

/** add → writer creates two files and APPENDS one registry entry. */
const ADD_CHANGE = {
  action: 'add',
  unitId: 'D22',
  // HarnessGovernanceExecutor.hydrateAdd emits hookId = unitId, not the slug.
  hookId: 'D22',
  assetSlug: 'd22-termination-gate',
  reason: '补入可验证的终止出口门',
  manifest: {
    id: 'D22',
    name: '终止门',
    stage: 'per-turn',
    order: 2200,
    version: 1,
    enabled: true,
    template: 'content.md',
    inputs: ['threadId'],
    variables: [{ name: 'catId', description: '当前 invocation 的猫\n第二行: 用来验证标量转义' }],
    disableable: true,
    safetyTier: 'editable',
    transparencyTier: 'visible-by-default',
    governanceTier: 'human-gated',
  },
  content: '# 终止门\n\n每轮结束前必须给出可验证的终止出口。',
  objectives: [{ objectiveId: 'tool-access-correct-use' }],
} satisfies HarnessGovernanceProposalChange;

/** disable → runtime override only; the body is NOT deleted. */
const DISABLE_CHANGE = {
  action: 'disable',
  unitId: 'L4',
  hookId: 'L4',
  reason: '消融验证该段是否仍有必要',
  beforeEnabled: true,
  beforeContent: '1. **Runtime data safety** — 用隔离的开发/测试数据存储。\n2. **已选择 Review 时必须跨个体**。',
  objectiveImpact: { objectiveId: 'iron-law-compliance', remainingMemberCount: 2 },
} satisfies HarnessGovernanceProposalChange;

/** enable on an already-enabled unit — the executor does not reject this. */
const ENABLE_NOOP_CHANGE = {
  action: 'enable',
  unitId: 'L4',
  hookId: 'L4',
  reason: '重新启用（当前已启用 —— 这是一次空操作）',
  beforeEnabled: true,
  beforeContent: '1. **Runtime data safety** — 用隔离的开发/测试数据存储。',
  objectiveImpact: { objectiveId: 'iron-law-compliance', remainingMemberCount: 3 },
} satisfies HarnessGovernanceProposalChange;

/** modify → content override in the runtime store; no file path is knowable. */
const MODIFY_CHANGE = {
  action: 'modify',
  unitId: 'D8',
  hookId: 'D8',
  reason: '保留原规则并补入终止出口门',
  sourceVersion: 1,
  beforeContent: '<!-- D8 -->\n\n现有球权规则。\n',
  proposedContent: '<!-- D8 -->\n\n现有球权规则。\n\n新增终止门：每轮必须给出可验证出口。',
  beforeCondition: null,
} satisfies HarnessGovernanceProposalChange;

const SCENARIOS = [
  {
    id: 'add',
    title: '新增段 D22',
    hint: '两个新建文件 + 注册表追加：三块应各自标注 create / create / append',
    change: ADD_CHANGE,
  },
  {
    id: 'disable',
    title: '禁用段 L4',
    hint: '只写运行时 store：正文两侧应相等，且不出现任何文件路径或 “file changed”',
    change: DISABLE_CHANGE,
  },
  {
    id: 'enable-noop',
    title: '启用段 L4（空操作）',
    hint: '当前已启用：启用状态两侧应相等，读起来就是一次空操作',
    change: ENABLE_NOOP_CHANGE,
  },
  {
    id: 'modify',
    title: '修改段 D8',
    hint: '原文应保留为上下文、只把新增段落标绿；无权威路径故不显示文件头',
    change: MODIFY_CHANGE,
  },
] as const;

function itemFor(change: HarnessGovernanceProposalChange, ordinal: number): ApprovalHubItem {
  return {
    proposalId: `HGP-fixture-${change.action}`,
    sourceFeatureId: 'F257',
    requesterCatId: 'harness-governance-worker',
    ownerUserId: 'demo-owner',
    resolution: 'open',
    materialization: { state: 'not_started' },
    summary: `Harness 治理 fixture：${change.action}`,
    navigation: {
      state: 'anchored',
      originRef: { kind: 'event', anchor: 'fixture-anchor', summary: '评估结论（fixture）' },
      approvalCardRef: { threadId: 'thread_demo_f257', messageId: 'approval_demo_f257' },
    },
    inlineApprovable: true,
    decisionMode: 'approve-skip-reject',
    createdAt: WINDOW.end,
    detail: {
      header: {
        objective: { id: 'obj', label: '规则正确性', statement: 'Keep the behavior sound.' },
        objectiveId: 'obj',
        currentVersion: 'v1',
        decision: 'evolve',
        windows: [WINDOW],
        triggeredBy: ['counterexamples'],
        triggerCounts: {
          cumulative: { count: 203, threshold: 200 },
          counterexamples: { count: 4, threshold: 3 },
        },
      },
      conclusions: [
        { id: 'metric-a', conclusion: { kind: 'count', value: 3, howCounted: '逐条核对本周期反例后，共确认 3 次。' } },
      ],
      metricVisuals: [{ id: 'metric-a', currentValue: 3, previousValue: 5, delta: -2, lowerIsBetter: true }],
      hasComparisonBaseline: true,
      governanceReason: '反例显示内容需要收紧。',
      history: [],
      rejectReasons: [],
      changes: [change],
      evidenceRefs: ['invocation-1'],
      cardOrdinal: ordinal,
    },
  } as unknown as ApprovalHubItem;
}

export default function F257GovernanceCardOperationsFixtures() {
  const [openId, setOpenId] = useState<string>(SCENARIOS[0].id);

  return (
    <main className="mx-auto min-h-dvh max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <SettingsText as="h1" variant="base" className="font-bold">
          F257 治理卡 · 动作与差异 fixtures
        </SettingsText>
        <SettingsText as="p" variant="xs" tone="muted">
          构造数据而不是等真实周期：每个场景一张卡，点开「查看差异」即可在浏览器里核对四类 artifact operation
          的呈现是否与执行器真实行为一致。
        </SettingsText>
      </header>

      <nav className="flex flex-wrap gap-2" data-testid="f257-fixture-tabs">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            onClick={() => setOpenId(scenario.id)}
            aria-pressed={openId === scenario.id}
            data-testid={`f257-fixture-tab-${scenario.id}`}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              openId === scenario.id
                ? 'bg-cafe-accent text-[var(--cafe-accent-foreground)]'
                : 'border border-cafe text-cafe-secondary hover:bg-cafe-surface'
            }`}
          >
            {scenario.title}
          </button>
        ))}
      </nav>

      {SCENARIOS.filter((scenario) => scenario.id === openId).map((scenario, index) => (
        <section key={scenario.id} className="space-y-3" data-testid={`f257-fixture-${scenario.id}`}>
          <SettingsText as="p" variant="xs" tone="muted">
            预期：{scenario.hint}
          </SettingsText>
          <div className="rounded-2xl border border-cafe bg-[var(--console-card-bg)] p-4">
            <GenericApprovalRecommendation
              item={itemFor(scenario.change, index + 1)}
              f193TargetThreadId=""
              sourceThreadTitle="F257 fixture"
              targetThreadTitle={null}
              resolveCatName={(catId) => catId}
            />
          </div>
        </section>
      ))}
    </main>
  );
}
