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
import {
  BASELINE_HASH,
  CANDIDATE_ID,
  DEFAULT_REJECTION_REASON,
  type JourneyScenario,
  type JourneyScene,
  journeyFor,
  DEMO_WINDOW as WINDOW,
} from './journey-model';

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

function governanceDecisionFor(scene: JourneyScene): 'pending' | 'approved' | null {
  const status = scene.candidate?.status;
  if (!status || status === 'rejected') return null;
  if (status === 'proposed' || status === 'executing') return 'pending';
  return 'approved';
}

function epochStatusFor(
  scene: JourneyScene,
  governanceDecision: 'pending' | 'approved' | null,
  hasEvaluation: boolean,
): VersionEpoch['status'] {
  if (scene.round === 2 && scene.activeStage === 'tracing') return 'tracing';
  if (scene.activeStage === 'governance') {
    return governanceDecision === 'approved' ? 'governance-approved' : 'governance-pending';
  }
  return hasEvaluation ? 'eval-reject' : 'tracing';
}

function tracingSummaryFor(scene: JourneyScene): VersionEpoch['tracing'] {
  if (scene.round === 2) {
    return { observationCount: 0, firedCount: 0, firstAt: null, lastAt: null };
  }
  return {
    observationCount: 146,
    firedCount: 146,
    firstAt: WINDOW.start + 60_000,
    lastAt: WINDOW.end - 60_000,
  };
}

function chainFor(scene: JourneyScene): VersionEpoch[] {
  const hasEvaluation = scene.verdict !== null;
  const governanceDecision = governanceDecisionFor(scene);
  return [
    {
      version: 1,
      origin: 'manifest',
      startedAt: WINDOW.start,
      status: epochStatusFor(scene, governanceDecision, hasEvaluation),
      isActive: true,
      tracing: tracingSummaryFor(scene),
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
              decidedAt: governanceDecision === 'pending' ? null : WINDOW.end + 60_000,
              actorId: governanceDecision === 'pending' ? null : 'operator',
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
  const [isRejecting, setIsRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState(DEFAULT_REJECTION_REASON);
  const journey = useMemo(() => journeyFor(scenario, rejectionReason), [rejectionReason, scenario]);
  const scene = journey[stepIndex] ?? journey[0];
  const atStart = stepIndex === 0;
  const atEnd = stepIndex === journey.length - 1;

  const moveTo = useCallback(
    (nextIndex: number) => {
      setIsRejecting(false);
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
    setIsRejecting(false);
    if (nextScenario === 'rejected') setRejectionReason(DEFAULT_REJECTION_REASON);
    setIsPlaying(false);
  };

  const confirmReject = () => {
    const reason = rejectionReason.trim();
    if (!reason) return;
    const rejectedJourney = journeyFor('rejected', reason);
    const rejectedIndex = rejectedJourney.findIndex((entry) => entry.id === 'operator-rejected');
    setScenario('rejected');
    setRejectionReason(reason);
    setStepIndex(rejectedIndex);
    setIsRejecting(false);
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
            <button
              type="button"
              className={scenario === 'rejected' ? activeControlClass : controlClass}
              onClick={() => selectScenario('rejected')}
              data-testid="f257-journey-scenario-rejected"
            >
              拒绝并进入下一回合
            </button>
            <span className="mx-1 h-4 w-px bg-cafe-border" aria-hidden="true" />
            <button type="button" className={controlClass} onClick={movePrevious} disabled={atStart}>
              上一幕
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
              下一幕
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
        <JourneyLoopReturn scene={scene} />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4" data-testid="f257-journey-stage-detail">
          <JourneyStageDetail
            selected={selected}
            scene={scene}
            isRejecting={isRejecting}
            rejectionReason={rejectionReason}
            onApprove={moveNext}
            onStartReject={() => {
              setIsRejecting(true);
              setIsPlaying(false);
            }}
            onChangeRejectionReason={setRejectionReason}
            onConfirmReject={confirmReject}
            onCancelReject={() => setIsRejecting(false)}
            onResume={moveNext}
          />
        </section>

        <aside className="space-y-3">
          <ContractLedger scene={scene} />
          <TrialEvidence scene={scene} />
        </aside>
      </div>
    </main>
  );
}

function JourneyLoopReturn({ scene }: { scene: JourneyScene }) {
  if (scene.round !== 2) return null;
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2"
      data-testid="f257-journey-loop-return"
    >
      <SettingsBadge tone="emerald" size="xxs">
        下一回合
      </SettingsBadge>
      <SettingsText as="span" variant="xs" tone="muted">
        当前循环回到 tracing；上一轮决定留在历史，新窗口重新收集证据。
      </SettingsText>
    </div>
  );
}

function JourneyStageDetail({
  selected,
  scene,
  ...governanceProps
}: {
  selected: SelectedStage;
  scene: JourneyScene;
  isRejecting: boolean;
  rejectionReason: string;
  onApprove: () => void;
  onStartReject: () => void;
  onChangeRejectionReason: (reason: string) => void;
  onConfirmReject: () => void;
  onCancelReject: () => void;
  onResume: () => void;
}) {
  if (selected.stage === 'tracing') return <TracingEvidence scene={scene} />;
  if (selected.stage === 'eval') {
    return (
      <div className="space-y-4">
        <EvaluationEvidenceChain scene={scene} />
        <ObjectiveEvaluationPanel data={EVALUATION} />
      </div>
    );
  }
  if (selected.stage === 'governance') return <GovernanceSurface scene={scene} {...governanceProps} />;
  return <VersionEvidence />;
}

function GovernanceSurface({
  scene,
  isRejecting,
  rejectionReason,
  onApprove,
  onStartReject,
  onChangeRejectionReason,
  onConfirmReject,
  onCancelReject,
  onResume,
}: {
  scene: JourneyScene;
  isRejecting: boolean;
  rejectionReason: string;
  onApprove: () => void;
  onStartReject: () => void;
  onChangeRejectionReason: (reason: string) => void;
  onConfirmReject: () => void;
  onCancelReject: () => void;
  onResume: () => void;
}) {
  if (!scene.candidate) {
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        尚未产生治理候选；评估结论提交后由 post-commit worker 自动衔接。
      </SettingsText>
    );
  }

  if (scene.candidate.status === 'rejected') {
    return (
      <div className="space-y-3" data-testid="f257-journey-rejected">
        <SettingsBadge tone="slate" size="xxs">
          Candidate rejected · 继续观察
        </SettingsBadge>
        <SettingsText as="p" variant="sm" tone="muted">
          Candidate 已 settled；没有写入 override，也没有创建 PatchTrial。拒绝理由保留在 durable approval note。
        </SettingsText>
        <blockquote className="rounded-xl border border-cafe-subtle bg-cafe-surface-elevated p-3 text-sm text-cafe">
          {scene.candidate.decisionNote}
        </blockquote>
      </div>
    );
  }

  if (isRejecting) {
    return (
      <div className="space-y-3 rounded-xl border border-cafe-subtle bg-cafe-surface p-4">
        <div>
          <SettingsBadge tone="amber" size="xxs">
            拒绝治理候选
          </SettingsBadge>
          <SettingsText as="p" variant="sm" tone="muted" className="mt-2">
            写明为什么不执行本次干预。理由会先作为 Candidate 审计 note 留存；进入下一轮 evaluator 的桥接状态会单独标明。
          </SettingsText>
        </div>
        <label className="block space-y-1.5 text-sm font-medium text-cafe">
          拒绝理由
          <textarea
            className="min-h-24 w-full rounded-xl border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2 text-sm text-cafe outline-none focus:border-cafe-accent"
            value={rejectionReason}
            onChange={(event) => onChangeRejectionReason(event.target.value)}
            data-testid="f257-journey-reject-reason"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <span data-testid="f257-journey-confirm-reject">
            <SettingsPrimaryButton onClick={onConfirmReject} disabled={!rejectionReason.trim()}>
              确认拒绝并进入下一回合
            </SettingsPrimaryButton>
          </span>
          <SettingsSecondaryButton onClick={onCancelReject}>取消</SettingsSecondaryButton>
        </div>
      </div>
    );
  }

  const item = approvalItemFor(scene);
  const isProposed = scene.candidate.status === 'proposed';
  const isExecuting = scene.candidate.status === 'executing';
  return (
    <div className="space-y-3">
      {scene.id === 'candidate-opened' && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2"
          data-testid="f257-journey-automatic-governance"
        >
          <SettingsBadge tone="blue" size="xxs">
            系统自动创建
          </SettingsBadge>
          <SettingsText as="span" variant="xs" tone="muted">
            post-commit worker 已生成 Candidate；用户无需触发 governance，现在只需审批或拒绝。
          </SettingsText>
        </div>
      )}
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
            onReject={onStartReject}
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
    </div>
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
        <span data-testid="f257-journey-reject">
          <SettingsSecondaryButton onClick={onReject}>拒绝并说明理由</SettingsSecondaryButton>
        </span>
      </div>
    );
  }
  if (isExecuting) {
    if (scene.candidate?.decisionMode !== 'resume-only') {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <SettingsBadge tone="blue" size="xxs">
            审批已持久化
          </SettingsBadge>
          <SettingsText as="span" variant="xs" tone="muted">
            系统自动执行 override；正常路径无需再次点击。
          </SettingsText>
        </div>
      );
    }
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

function EvaluationEvidenceChain({ scene }: { scene: JourneyScene }) {
  const evidence = scene.evaluationEvidence;
  if (!evidence) {
    return (
      <section
        className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3"
        data-testid="f257-journey-evaluation-evidence"
      >
        <SettingsText as="p" variant="sm" tone="muted">
          当前时间窗尚未提交 evaluation snapshot，因此还没有指标结论。
        </SettingsText>
      </section>
    );
  }

  return (
    <section
      className="space-y-3 rounded-xl border border-cafe-subtle bg-cafe-surface p-3"
      data-testid="f257-journey-evaluation-evidence"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SettingsBadge tone="blue" size="xxs">
          评估证据链
        </SettingsBadge>
        <SettingsText as="span" variant="xs" tone="muted">
          数据 → 指标规则 → measurement → 结论
        </SettingsText>
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-micro sm:grid-cols-[auto_1fr]">
        <dt className="text-cafe-muted">snapshot</dt>
        <dd className="font-mono text-cafe">{evidence.snapshotId}</dd>
        <dt className="text-cafe-muted">时间窗</dt>
        <dd className="font-mono text-cafe">
          {new Date(evidence.window.start).toISOString()} → {new Date(evidence.window.end).toISOString()}
        </dd>
        <dt className="text-cafe-muted">数据源</dt>
        <dd className="text-cafe">
          {evidence.sourceKind} · {evidence.sourceRefs.length} 个锚点
        </dd>
        <dt className="text-cafe-muted">来源锚点</dt>
        <dd className="break-all font-mono text-cafe">{evidence.sourceRefs.join(' · ')}</dd>
      </dl>
      <div className="overflow-x-auto rounded-xl border border-cafe-subtle">
        <table className="w-full min-w-[38rem] text-left text-micro">
          <thead className="bg-cafe-surface-elevated text-cafe-muted">
            <tr>
              <th className="px-3 py-2 font-medium">指标</th>
              <th className="px-3 py-2 font-medium">规则</th>
              <th className="px-3 py-2 font-medium">measurement</th>
              <th className="px-3 py-2 font-medium">判定</th>
            </tr>
          </thead>
          <tbody>
            {evidence.metrics.map((metric) => (
              <tr key={metric.metricId} className="border-t border-cafe-subtle text-cafe">
                <td className="px-3 py-2">
                  <div>{metric.label}</div>
                  <div className="font-mono text-cafe-muted">{metric.metricId}</div>
                </td>
                <td className="px-3 py-2 font-mono">{metric.rule}</td>
                <td className="px-3 py-2 font-mono">{metric.measurement}</td>
                <td className="px-3 py-2">
                  <SettingsBadge tone="red" size="xxs">
                    {metric.decision}
                  </SettingsBadge>
                  <div className="mt-1 text-cafe-muted">{metric.reason}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-cafe-surface-elevated px-3 py-2">
        <SettingsText as="span" variant="xs" tone="muted">
          Objective verdict
        </SettingsText>
        <SettingsBadge tone="red" size="xxs">
          {evidence.verdict}
        </SettingsBadge>
      </div>
    </section>
  );
}

function TracingEvidence({ scene }: { scene: JourneyScene }) {
  if (scene.round === 2) {
    return (
      <div className="space-y-3" data-testid="f257-journey-next-round">
        <div className="flex flex-wrap items-center gap-2">
          <SettingsBadge tone="emerald" size="xxs">
            下一回合
          </SettingsBadge>
          <h3 className="text-sm font-semibold text-cafe">当前循环回到 tracing</h3>
        </div>
        <SettingsText as="p" variant="sm" tone="muted">
          新时间窗从空的 observation set 开始；上一轮结论、Candidate 与决策仍可追溯，但不会冒充本轮评估。
        </SettingsText>
        {scene.nextEvaluationContext && (
          <section className="space-y-2 rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <SettingsBadge tone="blue" size="xxs">
                Candidate.approval.note 已持久化
              </SettingsBadge>
              <SettingsBadge tone="amber" size="xxs">
                需要后端触点
              </SettingsBadge>
            </div>
            <SettingsText as="p" variant="xs" tone="muted">
              演示把该理由带入“下一轮评估上下文”；当前生产后端只持久化 note，尚未把它自动桥接为 evaluator 输入。
            </SettingsText>
            <blockquote className="rounded-lg bg-cafe-surface-elevated p-2 text-sm text-cafe">
              {scene.nextEvaluationContext.rejectionNote}
            </blockquote>
          </section>
        )}
      </div>
    );
  }
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
        <dt className="text-cafe-muted">round</dt>
        <dd>第 {scene.round} 回合</dd>
        <dt className="text-cafe-muted">event</dt>
        <dd className="font-mono text-cafe">{scene.event}</dd>
        <dt className="text-cafe-muted">owner</dt>
        <dd className="font-mono text-cafe">{scene.transitionOwner}</dd>
        <dt className="text-cafe-muted">operator</dt>
        <dd>{scene.operatorActionRequired}</dd>
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
        <div className="mt-2 space-y-1">
          {scene.candidate?.status === 'rejected' && (
            <SettingsText as="p" variant="xs" tone="muted">
              拒绝分支没有写入 override。
            </SettingsText>
          )}
          <SettingsText as="p" variant="xs" tone="muted">
            尚未创建 PatchTrial
          </SettingsText>
        </div>
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
