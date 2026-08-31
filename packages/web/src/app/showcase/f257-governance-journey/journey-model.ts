import type { ActiveStage } from '@cat-cafe/shared';

export const CANDIDATE_ID = 'gc-EC-demo-001';
export const TRIAL_ID = 'pt-EC-demo-001';
export const BASELINE_HASH = 'sha256:baseline-failing-trace';
export const IMPROVED_HASH = 'sha256:treatment-disabled-trace';
export const DEFAULT_REJECTION_REASON = '反例来自已退役工具别名；下一窗口按新工具目录重新评估。';
export const DEMO_WINDOW = {
  start: Date.UTC(2026, 7, 24, 12),
  end: Date.UTC(2026, 7, 31, 12),
} as const;

export type JourneyScenario = 'happy' | 'recovery' | 'rejected';
export type JourneySceneId =
  | 'signal-collected'
  | 'judgment-committed'
  | 'candidate-opened'
  | 'operator-approved'
  | 'operator-rejected'
  | 'override-interrupted'
  | 'override-applied'
  | 'treatment-inconclusive'
  | 'trial-closed'
  | 'next-round-tracing';

export type JourneyEvent =
  | 'TraceAnnotationCommitted'
  | 'ObjectiveJudgmentCommitted'
  | 'GovernanceCandidateOpened'
  | 'CandidateDecisionApproved'
  | 'CandidateDecisionRejected'
  | 'OverrideExecutionInterrupted'
  | 'OverrideApplied'
  | 'PatchTrialEvaluated'
  | 'PatchTrialClosed';

export type JourneyTransitionOwner =
  | 'tracing-runtime'
  | 'evaluation-runtime'
  | 'governance-worker'
  | 'operator'
  | 'override-executor';

export interface DemoEvaluationEvidence {
  snapshotId: string;
  window: { start: number; end: number };
  sourceKind: 'InjectionTrace summary';
  sourceRefs: readonly string[];
  metrics: readonly {
    metricId: string;
    label: string;
    rule: 'counter-zero';
    measurement: string;
    decision: 'breach';
    reason: string;
  }[];
  verdict: 'retire-candidate';
}

export interface DemoNextEvaluationContext {
  rejectionNote: string;
  persistence: 'candidate-approval-note';
  evaluatorBridge: 'prototype-only';
}

export interface DemoCandidate {
  candidateId: string;
  status: 'proposed' | 'executing' | 'approved' | 'rejected' | 'closed';
  decisionMode: 'approve-reject' | 'resume-only' | 'none';
  operatorDecisionCount: number;
  decisionNote: string | null;
}

export interface DemoOverride {
  attempts: number;
  successfulWrites: number;
  mechanism: 'override-disable';
  error: string | null;
}

export interface DemoPatchTrial {
  trialId: string;
  trialCount: 1;
  outcome: 'pending' | 'inconclusive' | 'improved';
  decision: 'pending' | 'solidify';
  measurement: number | null;
  beforeHash: string;
  afterHash: string | null;
}

export interface JourneyScene {
  id: JourneySceneId;
  event: JourneyEvent;
  eyebrow: string;
  title: string;
  explanation: string;
  round: 1 | 2;
  transitionOwner: JourneyTransitionOwner;
  operatorActionRequired: 'none' | 'approve-or-reject' | 'resume';
  activeStage: ActiveStage;
  selectedStage: 'tracing' | 'eval' | 'governance';
  verdict: 'retire-candidate' | null;
  evaluationEvidence: DemoEvaluationEvidence | null;
  candidate: DemoCandidate | null;
  override: DemoOverride | null;
  patchTrial: DemoPatchTrial | null;
  nextEvaluationContext: DemoNextEvaluationContext | null;
  actionableCandidateCount: number;
  terminal: boolean;
}

const evaluationEvidence: DemoEvaluationEvidence = {
  snapshotId: 'snapshot-s13-schema-failure',
  window: DEMO_WINDOW,
  sourceKind: 'InjectionTrace summary',
  sourceRefs: ['turn_schema_failure_1', 'turn_schema_failure_2', 'turn_schema_failure_3'],
  metrics: [
    {
      metricId: 'tool-schema-failure-count',
      label: '工具名或 Schema 校验失败次数',
      rule: 'counter-zero',
      measurement: 'count = 3',
      decision: 'breach',
      reason: 'counter=3; zero required',
    },
  ],
  verdict: 'retire-candidate',
};

const proposedCandidate: DemoCandidate = {
  candidateId: CANDIDATE_ID,
  status: 'proposed',
  decisionMode: 'approve-reject',
  operatorDecisionCount: 0,
  decisionNote: null,
};

const executingCandidate: DemoCandidate = {
  candidateId: CANDIDATE_ID,
  status: 'executing',
  decisionMode: 'none',
  operatorDecisionCount: 1,
  decisionNote: '批准 disable override 试验',
};

const resumeCandidate: DemoCandidate = {
  ...executingCandidate,
  decisionMode: 'resume-only',
};

const approvedCandidate: DemoCandidate = {
  candidateId: CANDIDATE_ID,
  status: 'approved',
  decisionMode: 'none',
  operatorDecisionCount: 1,
  decisionNote: '批准 disable override 试验',
};

const pendingTrial: DemoPatchTrial = {
  trialId: TRIAL_ID,
  trialCount: 1,
  outcome: 'pending',
  decision: 'pending',
  measurement: null,
  beforeHash: BASELINE_HASH,
  afterHash: null,
};

const commonScenes: Record<
  Exclude<JourneySceneId, 'override-interrupted' | 'override-applied' | 'operator-rejected' | 'next-round-tracing'>,
  JourneyScene
> = {
  'signal-collected': {
    id: 'signal-collected',
    event: 'TraceAnnotationCommitted',
    eyebrow: '第 1 回合 · Tracing · 第三个结构化反例',
    title: '证据达到评估触发条件',
    explanation: 'S13 的工具 Schema 失败累计到 3 次；触发阈值只负责启动评估，不替评估规则下结论。',
    round: 1,
    transitionOwner: 'tracing-runtime',
    operatorActionRequired: 'none',
    activeStage: 'tracing',
    selectedStage: 'tracing',
    verdict: null,
    evaluationEvidence: null,
    candidate: null,
    override: null,
    patchTrial: null,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: false,
  },
  'judgment-committed': {
    id: 'judgment-committed',
    event: 'ObjectiveJudgmentCommitted',
    eyebrow: '第 1 回合 · Eval · v1 snapshot',
    title: '数据、指标与规则形成可追溯结论',
    explanation:
      '固定时间窗内的 3 个来源锚点进入 snapshot；counter-zero 规则判定 breach，ObjectiveJudgment 原子提交 retire-candidate。',
    round: 1,
    transitionOwner: 'evaluation-runtime',
    operatorActionRequired: 'none',
    activeStage: 'tracing',
    selectedStage: 'eval',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: null,
    override: null,
    patchTrial: null,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: false,
  },
  'candidate-opened': {
    id: 'candidate-opened',
    event: 'GovernanceCandidateOpened',
    eyebrow: '第 1 回合 · Governance · 系统自动 dispatch',
    title: '系统自动把结论变成一次真实治理决定',
    explanation: 'post-commit worker 自动按 owner/objective/snapshot 坐标创建唯一 Candidate；用户只需审批或拒绝。',
    round: 1,
    transitionOwner: 'governance-worker',
    operatorActionRequired: 'approve-or-reject',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: proposedCandidate,
    override: null,
    patchTrial: null,
    nextEvaluationContext: null,
    actionableCandidateCount: 1,
    terminal: false,
  },
  'operator-approved': {
    id: 'operator-approved',
    event: 'CandidateDecisionApproved',
    eyebrow: '第 1 回合 · Approval · operator authority',
    title: '人只决定是否干预，不替系统造结论',
    explanation: '批准先持久化决定，随后系统自动执行；正常路径不需要第二次点击，只有中断时才出现“继续执行”。',
    round: 1,
    transitionOwner: 'operator',
    operatorActionRequired: 'none',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: executingCandidate,
    override: { attempts: 0, successfulWrites: 0, mechanism: 'override-disable', error: null },
    patchTrial: null,
    nextEvaluationContext: null,
    actionableCandidateCount: 1,
    terminal: false,
  },
  'treatment-inconclusive': {
    id: 'treatment-inconclusive',
    event: 'PatchTrialEvaluated',
    eyebrow: '第 1 回合 · PatchTrial · 首个 treatment window',
    title: '流量变多不等于干预有效',
    explanation: '新样本仍来自同一注入状态，before/after trace hash 相同；试验诚实保持 inconclusive。',
    round: 1,
    transitionOwner: 'evaluation-runtime',
    operatorActionRequired: 'none',
    activeStage: 'tracing',
    selectedStage: 'eval',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: approvedCandidate,
    override: { attempts: 1, successfulWrites: 1, mechanism: 'override-disable', error: null },
    patchTrial: { ...pendingTrial, outcome: 'inconclusive', afterHash: BASELINE_HASH },
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: false,
  },
  'trial-closed': {
    id: 'trial-closed',
    event: 'PatchTrialClosed',
    eyebrow: '第 1 回合 · Re-eval · disabled-state data',
    title: '下一窗口测得改善，试验才允许收口',
    explanation: '反例计数降为 0 且 trace hash 已变化；PatchTrial improved/solidify，Candidate closed。',
    round: 1,
    transitionOwner: 'evaluation-runtime',
    operatorActionRequired: 'none',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: { ...approvedCandidate, status: 'closed' },
    override: { attempts: 1, successfulWrites: 1, mechanism: 'override-disable', error: null },
    patchTrial: {
      ...pendingTrial,
      outcome: 'improved',
      decision: 'solidify',
      measurement: 0,
      afterHash: IMPROVED_HASH,
    },
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: true,
  },
};

function overrideApplied(attempts: number): JourneyScene {
  return {
    id: 'override-applied',
    event: 'OverrideApplied',
    eyebrow: '第 1 回合 · Override · approved treatment',
    title: '执行成功后只开启一个 PatchTrial',
    explanation:
      '同一 Candidate 写入 disable override，并以当前 Objective measurement 和 baseline trace 打开唯一试验。',
    round: 1,
    transitionOwner: 'override-executor',
    operatorActionRequired: 'none',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: approvedCandidate,
    override: { attempts: attempts, successfulWrites: 1, mechanism: 'override-disable', error: null },
    patchTrial: pendingTrial,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: false,
  };
}

const interruptedScene: JourneyScene = {
  id: 'override-interrupted',
  event: 'OverrideExecutionInterrupted',
  eyebrow: '第 1 回合 · Recovery · override write interrupted',
  title: '失败留在可恢复的同一决定上',
  explanation: 'Candidate 保持 executing，Approval Hub 改为“继续执行”；没有 override 写入，也没有提前创建 PatchTrial。',
  round: 1,
  transitionOwner: 'override-executor',
  operatorActionRequired: 'resume',
  activeStage: 'governance',
  selectedStage: 'governance',
  verdict: 'retire-candidate',
  evaluationEvidence: evaluationEvidence,
  candidate: resumeCandidate,
  override: {
    attempts: 1,
    successfulWrites: 0,
    mechanism: 'override-disable',
    error: 'simulated_override_failure_before_write',
  },
  patchTrial: null,
  nextEvaluationContext: null,
  actionableCandidateCount: 1,
  terminal: false,
};

function rejectedScene(reason: string): JourneyScene {
  return {
    id: 'operator-rejected',
    event: 'CandidateDecisionRejected',
    eyebrow: '第 1 回合 · Approval · reject with reason',
    title: '拒绝会结清候选，但不会触发干预',
    explanation: '理由写入 Candidate.approval.note；Candidate settled，系统不写 override，也不创建 PatchTrial。',
    round: 1,
    transitionOwner: 'operator',
    operatorActionRequired: 'none',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: {
      ...proposedCandidate,
      status: 'rejected',
      decisionMode: 'none',
      operatorDecisionCount: 1,
      decisionNote: reason,
    },
    override: null,
    patchTrial: null,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: true,
  };
}

function approvedNextRoundScene(): JourneyScene {
  return {
    id: 'next-round-tracing',
    event: 'TraceAnnotationCommitted',
    eyebrow: '第 2 回合 · 新时间窗 · Tracing',
    title: '治理完成后，闭环回到下一回合',
    explanation: '上一轮 Candidate 与 PatchTrial 留在历史中；新窗口重新从 tracing 收集，不沿用旧结论冒充新评估。',
    round: 2,
    transitionOwner: 'tracing-runtime',
    operatorActionRequired: 'none',
    activeStage: 'tracing',
    selectedStage: 'tracing',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: { ...approvedCandidate, status: 'closed' },
    override: { attempts: 1, successfulWrites: 1, mechanism: 'override-disable', error: null },
    patchTrial: commonScenes['trial-closed'].patchTrial,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: true,
  };
}

function rejectedNextRoundScene(reason: string): JourneyScene {
  return {
    id: 'next-round-tracing',
    event: 'TraceAnnotationCommitted',
    eyebrow: '第 2 回合 · 新时间窗 · Tracing',
    title: '拒绝后也回到下一回合，而不是停在线尾',
    explanation: '上一轮 Candidate 已 rejected；新窗口继续 tracing。拒绝理由已留存，进入 evaluator 仍需明确桥接。',
    round: 2,
    transitionOwner: 'tracing-runtime',
    operatorActionRequired: 'none',
    activeStage: 'tracing',
    selectedStage: 'tracing',
    verdict: 'retire-candidate',
    evaluationEvidence: evaluationEvidence,
    candidate: rejectedScene(reason).candidate,
    override: null,
    patchTrial: null,
    nextEvaluationContext: {
      rejectionNote: reason,
      persistence: 'candidate-approval-note',
      evaluatorBridge: 'prototype-only',
    },
    actionableCandidateCount: 0,
    terminal: true,
  };
}

const happyJourney: readonly JourneyScene[] = [
  commonScenes['signal-collected'],
  commonScenes['judgment-committed'],
  commonScenes['candidate-opened'],
  commonScenes['operator-approved'],
  overrideApplied(1),
  commonScenes['treatment-inconclusive'],
  commonScenes['trial-closed'],
  approvedNextRoundScene(),
];

const recoveryJourney: readonly JourneyScene[] = [
  commonScenes['signal-collected'],
  commonScenes['judgment-committed'],
  commonScenes['candidate-opened'],
  commonScenes['operator-approved'],
  interruptedScene,
  overrideApplied(2),
  commonScenes['treatment-inconclusive'],
  commonScenes['trial-closed'],
  approvedNextRoundScene(),
];

export function journeyFor(
  scenario: JourneyScenario,
  rejectionReason = DEFAULT_REJECTION_REASON,
): readonly JourneyScene[] {
  if (scenario === 'recovery') return recoveryJourney;
  if (scenario === 'rejected') {
    return [
      commonScenes['signal-collected'],
      commonScenes['judgment-committed'],
      commonScenes['candidate-opened'],
      rejectedScene(rejectionReason),
      rejectedNextRoundScene(rejectionReason),
    ];
  }
  return happyJourney;
}
