'use client';

import type { ApprovalItem, SegmentEvaluationResponse, VersionEpoch } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApprovalDecisionCard } from '@/components/ApprovalDecisionCard';
import { GenericApprovalRecommendation } from '@/components/GenericApprovalRecommendation';
import { LifelineChainView, type SelectedStage } from '@/components/settings/LifelineChainView';
import { ObjectiveEvaluationPanel } from '@/components/settings/ObjectiveEvaluationPanel';
import {
  SettingsBadge,
  SettingsPrimaryButton,
  SettingsSecondaryButton,
  SettingsText,
} from '@/components/settings/primitives';
import { BASELINE_HASH, CANDIDATE_ID, type JourneyScenario, type JourneyScene, journeyFor } from './journey-model';

const WINDOW = {
  start: Date.UTC(2026, 7, 24, 12),
  end: Date.UTC(2026, 7, 31, 12),
};

const EVALUATION: SegmentEvaluationResponse = {
  segmentId: 'S13',
  window: WINDOW,
  tracing: {
    trigger: {
      traceCount: 146,
      traceRequired: 200,
      windowMs: 7 * 24 * 60 * 60 * 1000,
      counterexampleCount: 3,
      counterexampleRequired: 3,
      perObjective: [
        {
          objectiveId: 'tool-access-correct-use',
          traceCount: 146,
          traceRequired: 200,
          windowStartMs: WINDOW.start,
          windowEndMs: WINDOW.end,
          counterexampleCount: 3,
          counterexampleRequired: 3,
        },
      ],
    },
    structuredCounterexamples: [
      {
        annotationId: 'annotation-s13-schema-failure',
        incidentKey: 'incident-s13-schema-failure',
        objectiveId: 'tool-access-correct-use',
        metricId: 'tool-schema-failure-count',
        source: 'structured-rule',
        createdAt: WINDOW.end - 60_000,
        rationale: '工具名不存在，调用在 Schema 校验前失败',
        threadId: 'thread_demo_f257',
        turnId: 'turn_schema_failure_3',
        catId: 'cat-reviewer',
      },
    ],
    unclassifiedEpisodeCount: 0,
  },
  objectives: [
    {
      objectiveId: 'tool-access-correct-use',
      objectiveLabel: '工具可达与正确使用',
      evaluationModelId: 'em-tool-access-correct-use',
      evaluationModelLabel: '工具可达与正确使用评估',
      ruleVersion: 'v1',
      unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
      latestJudgment: {
        judgmentId: 'judgment-s13-demo',
        completion: 'complete',
        evaluatedAt: WINDOW.end,
        window: WINDOW,
        metricOutcomes: [{ metricId: 'tool-schema-failure-count', status: 'evaluated' }],
        verdict: 'retire-candidate',
        verdictDecision: {
          schemaVersion: 2,
          evaluationModelVersion: 'v1',
          primaryMetricId: 'tool-schema-failure-count',
          measurement: {
            kind: 'count',
            value: 3,
            howCounted: 'tool-schema-failure-count:distinct-counterexamples(3)',
          },
          targetSegmentIds: ['S13'],
          metricDecisions: [
            {
              metricId: 'tool-schema-failure-count',
              rule: { kind: 'counter-zero' },
              status: 'breach',
              reason: 'counter=3; zero required',
              measurement: {
                kind: 'count',
                value: 3,
                howCounted: 'tool-schema-failure-count:distinct-counterexamples(3)',
              },
              attributedSegmentIds: ['S13'],
            },
          ],
        },
      },
      metrics: [
        {
          metricId: 'tool-schema-failure-count',
          label: '工具名或 Schema 校验失败次数',
          kind: 'counter',
          evaluatorKind: 'code',
          evaluatorRuleRef: 'tool-schema-failure',
          trigger: { kind: 'distinct-counterexamples', threshold: 3 },
          collection: {
            window: WINDOW,
            positive: 0,
            counterexamples: 3,
            candidates: 0,
            classifiedTotal: 3,
            pendingTowardTrigger: 3,
            required: 3,
          },
          latestEvaluation: {
            result: {
              resultId: 'result-s13-schema-failure',
              snapshotId: 'snapshot-s13-schema-failure',
              ownerUserId: 'demo-owner',
              objectiveId: 'tool-access-correct-use',
              metricId: 'tool-schema-failure-count',
              kind: 'counter',
              value: { kind: 'counter', count: 3, threshold: 3 },
              evaluatedAt: WINDOW.end,
            },
            window: WINDOW,
          },
        },
      ],
    },
  ],
};

function chainFor(scene: JourneyScene): VersionEpoch[] {
  const hasEvaluation = scene.verdict !== null;
  const governanceDecision = scene.candidate
    ? scene.candidate.status === 'proposed' || scene.candidate.status === 'executing'
      ? 'pending'
      : 'approved'
    : null;
  return [
    {
      version: 1,
      origin: 'manifest',
      startedAt: WINDOW.start,
      status:
        scene.activeStage === 'governance'
          ? governanceDecision === 'approved'
            ? 'governance-approved'
            : 'governance-pending'
          : hasEvaluation
            ? 'eval-reject'
            : 'tracing',
      isActive: true,
      tracing: {
        observationCount: 146,
        firedCount: 146,
        firstAt: WINDOW.start + 60_000,
        lastAt: WINDOW.end - 60_000,
      },
      eval: hasEvaluation
        ? {
            verdict: scene.verdict,
            injectionCount: 3,
            violationCount: 3,
            evaluatedAt: WINDOW.end,
            evalWindow: { startMs: WINDOW.start, endMs: WINDOW.end },
            evalWindowGap: null,
            denominatorKind: 'fired-count',
            denominatorGap: null,
            objectives: [
              {
                objectiveId: 'tool-access-correct-use',
                judgmentId: 'judgment-s13-demo',
                verdict: 'retire-candidate',
                evaluatedAt: WINDOW.end,
                evalWindow: { startMs: WINDOW.start, endMs: WINDOW.end },
              },
            ],
            aggregateRule: 'objective-vector-v1',
          }
        : null,
      governance:
        governanceDecision === null
          ? null
          : {
              decision: governanceDecision,
              decidedAt: governanceDecision === 'approved' ? WINDOW.end + 60_000 : null,
              actorId: governanceDecision === 'approved' ? 'operator' : null,
            },
      events: [],
    },
  ];
}

function approvalItemFor(scene: JourneyScene): ApprovalItem {
  return {
    proposalId: CANDIDATE_ID,
    sourceFeatureId: 'F257',
    requesterCatId: 'harness-governance-worker',
    ownerUserId: 'demo-owner',
    status: 'pending',
    summary: 'S13 评估结论建议开启 disable override 试验',
    detail: {
      targetSegmentIds: ['S13'],
      objectiveId: 'tool-access-correct-use',
      proposedAction: { mechanism: 'override-disable' },
      evidence: { summary: 'v1 counter-zero：3 个结构化反例，要求为 0' },
      baselineTraceHash: scene.patchTrial?.beforeHash ?? BASELINE_HASH,
    },
    navigation: {
      state: 'anchored',
      originRef: {
        kind: 'event',
        anchor: 'judgment-s13-demo',
        summary: 'ObjectiveJudgmentCommitted(retire-candidate)',
      },
      approvalCardRef: { threadId: 'thread_demo_f257', messageId: 'approval_demo_f257' },
    },
    inlineApprovable: true,
    decisionMode: scene.candidate?.decisionMode === 'resume-only' ? 'resume-only' : 'approve-reject',
    createdAt: WINDOW.end,
  };
}

export default function F257GovernanceJourneyDemo() {
  const [scenario, setScenario] = useState<JourneyScenario>('happy');
  const [stepIndex, setStepIndex] = useState(0);
  const [selected, setSelected] = useState<SelectedStage>({ version: 1, stage: 'tracing' });
  const [isPlaying, setIsPlaying] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [rejected, setRejected] = useState(false);
  const journey = useMemo(() => journeyFor(scenario), [scenario]);
  const scene = journey[stepIndex] ?? journey[0];
  const atStart = stepIndex === 0;
  const atEnd = stepIndex === journey.length - 1;

  const moveTo = useCallback(
    (nextIndex: number) => {
      setRejected(false);
      setStepIndex(Math.max(0, Math.min(journey.length - 1, nextIndex)));
    },
    [journey.length],
  );
  const moveNext = useCallback(() => moveTo(stepIndex + 1), [moveTo, stepIndex]);
  const movePrevious = useCallback(() => moveTo(stepIndex - 1), [moveTo, stepIndex]);

  useEffect(() => {
    setSelected({ version: 1, stage: scene.selectedStage });
  }, [scene.selectedStage]);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      setStepIndex((current) => {
        if (current >= journey.length - 1) {
          setIsPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 2200);
    return () => window.clearInterval(timer);
  }, [isPlaying, journey.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        movePrevious();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveNext();
      } else if (event.key === ' ') {
        event.preventDefault();
        setIsPlaying((playing) => !playing);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveNext, movePrevious]);

  const selectScenario = (nextScenario: JourneyScenario) => {
    setScenario(nextScenario);
    setStepIndex(0);
    setRejected(false);
    setIsPlaying(false);
  };

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-6" data-testid="f257-governance-journey-demo">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SettingsBadge tone="blue" size="xxs">
            F257 体验 Gate
          </SettingsBadge>
          <span data-testid="f257-journey-truth-label">
            <SettingsBadge tone="amber" size="xxs">
              功能原型 · 演示数据 · 不连接生产
            </SettingsBadge>
          </span>
        </div>
        <h1 className="text-2xl font-semibold text-cafe">结论不是标签：它要走完治理、试验与再评估</h1>
        <SettingsText as="p" variant="sm" tone="muted">
          这条确定性旅程复用产品组件；状态名与恢复规则来自 PR #143 的真实契约，数字与人物均为演示数据。
        </SettingsText>
      </header>

      {!controlsHidden ? (
        <section
          className="space-y-3 rounded-xl border border-dashed border-cafe-subtle bg-cafe-surface-elevated p-3"
          aria-label="演示控制"
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={scenario === 'happy' ? activeControlClass : controlClass}
              onClick={() => selectScenario('happy')}
              data-testid="f257-journey-scenario-happy"
            >
              正常执行
            </button>
            <button
              type="button"
              className={scenario === 'recovery' ? activeControlClass : controlClass}
              onClick={() => selectScenario('recovery')}
              data-testid="f257-journey-scenario-recovery"
            >
              Override 中断与恢复
            </button>
            <span className="mx-1 h-4 w-px bg-cafe-border" aria-hidden="true" />
            <button type="button" className={controlClass} onClick={movePrevious} disabled={atStart}>
              上一步
            </button>
            <button
              type="button"
              className={controlClass}
              onClick={() => setIsPlaying((playing) => !playing)}
              data-testid="f257-journey-play"
            >
              {isPlaying ? '暂停' : '播放'}
            </button>
            <button
              type="button"
              className={controlClass}
              onClick={moveNext}
              disabled={atEnd}
              data-testid="f257-journey-next"
            >
              下一步
            </button>
            <button type="button" className={`${controlClass} ml-auto`} onClick={() => setControlsHidden(true)}>
              隐藏讲解控制
            </button>
          </div>
          <nav className="flex flex-wrap gap-1.5" aria-label="旅程场景">
            {journey.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                className={index === stepIndex ? activeStepClass : stepClass}
                onClick={() => moveTo(index)}
                aria-current={index === stepIndex ? 'step' : undefined}
              >
                {index + 1}. {entry.event}
              </button>
            ))}
          </nav>
        </section>
      ) : (
        <button type="button" className={controlClass} onClick={() => setControlsHidden(false)}>
          显示讲解控制
        </button>
      )}

      <section className="rounded-2xl border border-cafe bg-cafe-surface p-4 shadow-sm" aria-live="polite">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <SettingsText as="p" variant="xs" tone="muted">
              {scene.eyebrow}
            </SettingsText>
            <h2 className="mt-1 text-xl font-semibold text-cafe">{scene.title}</h2>
            <SettingsText as="p" variant="sm" tone="muted" className="mt-1 max-w-3xl">
              {scene.explanation}
            </SettingsText>
          </div>
          <div className="text-right">
            <SettingsBadge tone={scene.terminal ? 'emerald' : 'slate'} size="xxs">
              {scene.event}
            </SettingsBadge>
            <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
              {stepIndex + 1} / {journey.length}
            </SettingsText>
          </div>
        </div>

        <LifelineChainView
          chain={chainFor(scene)}
          selected={selected}
          onSelect={setSelected}
          activeStage={scene.activeStage}
          actionable={{
            stage: scene.actionableCandidateCount > 0 ? 'governance' : null,
            candidateCount: scene.actionableCandidateCount,
            source: 'candidate-count',
          }}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4" data-testid="f257-journey-stage-detail">
          {selected.stage === 'tracing' && <TracingEvidence />}
          {selected.stage === 'eval' && <ObjectiveEvaluationPanel data={EVALUATION} />}
          {selected.stage === 'governance' && (
            <GovernanceSurface
              scene={scene}
              rejected={rejected}
              onApprove={moveNext}
              onReject={() => {
                setRejected(true);
                setIsPlaying(false);
              }}
              onResume={moveNext}
              onRestore={() => setRejected(false)}
            />
          )}
          {selected.stage === 'version' && <VersionEvidence />}
        </section>

        <aside className="space-y-3">
          <ContractLedger scene={scene} />
          <TrialEvidence scene={scene} />
        </aside>
      </div>
    </main>
  );
}

function GovernanceSurface({
  scene,
  rejected,
  onApprove,
  onReject,
  onResume,
  onRestore,
}: {
  scene: JourneyScene;
  rejected: boolean;
  onApprove: () => void;
  onReject: () => void;
  onResume: () => void;
  onRestore: () => void;
}) {
  if (!scene.candidate) {
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        尚未产生治理候选；评估结论提交后由 post-commit worker 自动衔接。
      </SettingsText>
    );
  }

  if (rejected) {
    return (
      <div className="space-y-3" data-testid="f257-journey-rejected">
        <SettingsBadge tone="slate" size="xxs">
          已拒绝 · 继续观察
        </SettingsBadge>
        <SettingsText as="p" variant="sm" tone="muted">
          Candidate 已 settled；没有写入 override，也没有创建 PatchTrial。批准权仍属于 operator。
        </SettingsText>
        <SettingsSecondaryButton onClick={onRestore}>返回候选</SettingsSecondaryButton>
      </div>
    );
  }

  const item = approvalItemFor(scene);
  const isProposed = scene.candidate.status === 'proposed';
  const isExecuting = scene.candidate.status === 'executing';
  return (
    <ApprovalDecisionCard
      testId="f257-journey-approval-card"
      header={
        <div className="flex items-center gap-2 text-micro">
          <SettingsBadge tone={candidateTone(scene)} size="xxs">
            Candidate {scene.candidate.status}
          </SettingsBadge>
          <span className="ml-auto font-mono text-cafe-muted">{scene.candidate.candidateId}</span>
        </div>
      }
      title={item.summary}
      actionReason="由版本化评估结论触发；只有 operator 可以决定是否执行干预。"
      recommendation={
        <GenericApprovalRecommendation
          item={item}
          f193TargetThreadId=""
          sourceThreadTitle="F257 演示 thread"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />
      }
      currentDecision={
        <CandidateDecision
          scene={scene}
          isProposed={isProposed}
          isExecuting={isExecuting}
          onApprove={onApprove}
          onReject={onReject}
          onResume={onResume}
        />
      }
      details={{
        label: 'Canonical provenance',
        testId: 'f257-journey-provenance',
        content: (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-micro">
            <dt>objective</dt>
            <dd>tool-access-correct-use@v1</dd>
            <dt>judgment</dt>
            <dd>judgment-s13-demo</dd>
            <dt>candidate</dt>
            <dd>{CANDIDATE_ID}</dd>
          </dl>
        ),
      }}
    />
  );
}

function candidateTone(scene: JourneyScene): 'amber' | 'emerald' | 'blue' {
  if (scene.candidate?.status === 'executing') return 'amber';
  return scene.terminal ? 'emerald' : 'blue';
}

function CandidateDecision({
  scene,
  isProposed,
  isExecuting,
  onApprove,
  onReject,
  onResume,
}: {
  scene: JourneyScene;
  isProposed: boolean;
  isExecuting: boolean;
  onApprove: () => void;
  onReject: () => void;
  onResume: () => void;
}) {
  if (isProposed) {
    return (
      <div className="flex flex-wrap gap-2">
        <span data-testid="f257-journey-approve">
          <SettingsPrimaryButton onClick={onApprove}>批准并启动试验</SettingsPrimaryButton>
        </span>
        <SettingsSecondaryButton onClick={onReject}>拒绝并继续观察</SettingsSecondaryButton>
      </div>
    );
  }
  if (isExecuting) {
    return (
      <div className="space-y-2">
        {scene.override?.error && (
          <SettingsText as="p" variant="xs" tone="red">
            Override 写入中断：{scene.override.error}。决定已持久化，不需要再次批准。
          </SettingsText>
        )}
        <span data-testid="f257-journey-resume">
          <SettingsPrimaryButton onClick={onResume}>继续执行</SettingsPrimaryButton>
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SettingsBadge tone={scene.terminal ? 'emerald' : 'blue'} size="xxs">
        {scene.terminal ? 'Candidate closed' : 'Override 已执行'}
      </SettingsBadge>
      <SettingsText as="span" variant="xs" tone="muted">
        operator 决策 1 次 · override 成功写入 {scene.override?.successfulWrites ?? 0} 次
      </SettingsText>
    </div>
  );
}

function TracingEvidence() {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-cafe">结构化信号</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        {['turn_schema_failure_1', 'turn_schema_failure_2', 'turn_schema_failure_3'].map((turnId, index) => (
          <article key={turnId} className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
            <SettingsBadge tone="red" size="xxs">
              counterexample {index + 1}/3
            </SettingsBadge>
            <p className="mt-2 font-mono text-micro text-cafe-secondary">{turnId}</p>
            <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
              tool-schema-failure · fired
            </SettingsText>
          </article>
        ))}
      </div>
      <SettingsText as="p" variant="xs" tone="muted">
        触发阈值只决定何时评估；verdict 由 snapshot 中的 counter-zero 规则决定。
      </SettingsText>
    </div>
  );
}

function VersionEvidence() {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-cafe">S13 · manifest v1</h3>
      <SettingsText as="p" variant="xs" tone="muted">
        Objective、verdict rule 与 evaluator version 在 evaluation snapshot 中冻结；registry 后续升版不会重判历史结论。
      </SettingsText>
    </div>
  );
}

function ContractLedger({ scene }: { scene: JourneyScene }) {
  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
      <h3 className="text-sm font-semibold text-cafe">这一跳由谁拥有</h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-micro">
        <dt className="text-cafe-muted">event</dt>
        <dd className="font-mono text-cafe">{scene.event}</dd>
        <dt className="text-cafe-muted">stage</dt>
        <dd>{scene.activeStage}</dd>
        <dt className="text-cafe-muted">candidate</dt>
        <dd>{scene.candidate?.status ?? 'not-created'}</dd>
        <dt className="text-cafe-muted">actionable</dt>
        <dd>{scene.actionableCandidateCount}</dd>
      </dl>
    </section>
  );
}

function TrialEvidence({ scene }: { scene: JourneyScene }) {
  const trial = scene.patchTrial;
  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3" data-testid="f257-journey-trial">
      <h3 className="text-sm font-semibold text-cafe">PatchTrial 证据</h3>
      {!trial ? (
        <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
          尚未创建 PatchTrial
        </SettingsText>
      ) : (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-micro">
          <dt className="text-cafe-muted">outcome</dt>
          <dd>{trial.outcome}</dd>
          <dt className="text-cafe-muted">decision</dt>
          <dd>{trial.decision}</dd>
          <dt className="text-cafe-muted">measurement</dt>
          <dd>{trial.measurement ?? 'pending'}</dd>
          <dt className="text-cafe-muted">before</dt>
          <dd className="break-all font-mono">{trial.beforeHash}</dd>
          <dt className="text-cafe-muted">after</dt>
          <dd className="break-all font-mono">{trial.afterHash ?? 'pending'}</dd>
        </dl>
      )}
    </section>
  );
}

const controlClass =
  'rounded-full border border-cafe-subtle bg-cafe-surface px-3 py-1 text-xs font-medium text-cafe transition hover:bg-cafe-muted disabled:cursor-not-allowed disabled:opacity-40';
const activeControlClass =
  'rounded-full border border-cafe-accent bg-cafe-accent px-3 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)]';
const stepClass =
  'rounded-md border border-cafe-subtle bg-cafe-surface px-2 py-1 font-mono text-micro text-cafe-muted transition hover:text-cafe';
const activeStepClass =
  'rounded-md border border-cafe-accent bg-cafe-accent px-2 py-1 font-mono text-micro font-semibold text-[var(--cafe-accent-foreground)]';
