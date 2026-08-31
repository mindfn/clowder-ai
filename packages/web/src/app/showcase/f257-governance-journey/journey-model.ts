import type { ActiveStage } from '@cat-cafe/shared';

export const CANDIDATE_ID = 'gc-EC-demo-001';
export const TRIAL_ID = 'pt-EC-demo-001';
export const BASELINE_HASH = 'sha256:baseline-failing-trace';
export const IMPROVED_HASH = 'sha256:treatment-disabled-trace';

export type JourneyScenario = 'happy' | 'recovery';
export type JourneySceneId =
  | 'signal-collected'
  | 'judgment-committed'
  | 'candidate-opened'
  | 'operator-approved'
  | 'override-interrupted'
  | 'override-applied'
  | 'treatment-inconclusive'
  | 'trial-closed';

export type JourneyEvent =
  | 'TraceAnnotationCommitted'
  | 'ObjectiveJudgmentCommitted'
  | 'GovernanceCandidateOpened'
  | 'CandidateDecisionApproved'
  | 'OverrideExecutionInterrupted'
  | 'OverrideApplied'
  | 'PatchTrialEvaluated'
  | 'PatchTrialClosed';

export interface DemoCandidate {
  candidateId: string;
  status: 'proposed' | 'executing' | 'approved' | 'closed';
  decisionMode: 'approve-reject' | 'resume-only' | 'none';
  operatorDecisionCount: number;
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
  activeStage: ActiveStage;
  selectedStage: 'tracing' | 'eval' | 'governance';
  verdict: 'retire-candidate' | null;
  candidate: DemoCandidate | null;
  override: DemoOverride | null;
  patchTrial: DemoPatchTrial | null;
  actionableCandidateCount: number;
  terminal: boolean;
}

const proposedCandidate: DemoCandidate = {
  candidateId: CANDIDATE_ID,
  status: 'proposed',
  decisionMode: 'approve-reject',
  operatorDecisionCount: 0,
};

const executingCandidate: DemoCandidate = {
  candidateId: CANDIDATE_ID,
  status: 'executing',
  decisionMode: 'resume-only',
  operatorDecisionCount: 1,
};

const approvedCandidate: DemoCandidate = {
  candidateId: CANDIDATE_ID,
  status: 'approved',
  decisionMode: 'none',
  operatorDecisionCount: 1,
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

const commonScenes: Record<Exclude<JourneySceneId, 'override-interrupted' | 'override-applied'>, JourneyScene> = {
  'signal-collected': {
    id: 'signal-collected',
    event: 'TraceAnnotationCommitted',
    eyebrow: 'Tracing · 第三个结构化反例',
    title: '证据达到评估触发条件',
    explanation: 'S13 的工具 Schema 失败累计到 3 次；触发阈值只负责启动评估，不替评估规则下结论。',
    activeStage: 'tracing',
    selectedStage: 'tracing',
    verdict: null,
    candidate: null,
    override: null,
    patchTrial: null,
    actionableCandidateCount: 0,
    terminal: false,
  },
  'judgment-committed': {
    id: 'judgment-committed',
    event: 'ObjectiveJudgmentCommitted',
    eyebrow: 'Eval · v1 snapshot',
    title: '版本化规则形成可追溯结论',
    explanation:
      'counter-zero 规则判断 breach，ObjectiveJudgment 原子提交 retire-candidate；evidence-only 指标保持 inconclusive。',
    activeStage: 'tracing',
    selectedStage: 'eval',
    verdict: 'retire-candidate',
    candidate: null,
    override: null,
    patchTrial: null,
    actionableCandidateCount: 0,
    terminal: false,
  },
  'candidate-opened': {
    id: 'candidate-opened',
    event: 'GovernanceCandidateOpened',
    eyebrow: 'Governance · 幂等 dispatch',
    title: '结论自动进入一次真实治理决定',
    explanation: 'post-commit worker 用 owner/objective/snapshot 坐标创建唯一 Candidate，并投影到 Approval Hub。',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    candidate: proposedCandidate,
    override: null,
    patchTrial: null,
    actionableCandidateCount: 1,
    terminal: false,
  },
  'operator-approved': {
    id: 'operator-approved',
    event: 'CandidateDecisionApproved',
    eyebrow: 'Approval · operator authority',
    title: '人只决定是否干预，不替系统造结论',
    explanation: '批准先占有 durable transition；并发 reject 会被拒绝，执行失败也不会要求 operator 再批准。',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    candidate: executingCandidate,
    override: { attempts: 0, successfulWrites: 0, mechanism: 'override-disable', error: null },
    patchTrial: null,
    actionableCandidateCount: 1,
    terminal: false,
  },
  'treatment-inconclusive': {
    id: 'treatment-inconclusive',
    event: 'PatchTrialEvaluated',
    eyebrow: 'PatchTrial · 首个 treatment window',
    title: '流量变多不等于干预有效',
    explanation: '新样本仍来自同一注入状态，before/after trace hash 相同；试验诚实保持 inconclusive。',
    activeStage: 'tracing',
    selectedStage: 'eval',
    verdict: 'retire-candidate',
    candidate: approvedCandidate,
    override: { attempts: 1, successfulWrites: 1, mechanism: 'override-disable', error: null },
    patchTrial: { ...pendingTrial, outcome: 'inconclusive', afterHash: BASELINE_HASH },
    actionableCandidateCount: 0,
    terminal: false,
  },
  'trial-closed': {
    id: 'trial-closed',
    event: 'PatchTrialClosed',
    eyebrow: 'Re-eval · disabled-state corpus',
    title: '下一窗口测得改善，试验才允许收口',
    explanation: '反例计数降为 0 且 immutable trace hash 已变化；PatchTrial improved/solidify，Candidate closed。',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    candidate: { ...approvedCandidate, status: 'closed' },
    override: { attempts: 1, successfulWrites: 1, mechanism: 'override-disable', error: null },
    patchTrial: {
      ...pendingTrial,
      outcome: 'improved',
      decision: 'solidify',
      measurement: 0,
      afterHash: IMPROVED_HASH,
    },
    actionableCandidateCount: 0,
    terminal: true,
  },
};

function overrideApplied(attempts: number): JourneyScene {
  return {
    id: 'override-applied',
    event: 'OverrideApplied',
    eyebrow: 'Override · approved treatment',
    title: '执行成功后只开启一个 PatchTrial',
    explanation:
      '同一 Candidate 写入 disable override，并以当前 Objective measurement 和 baseline trace 打开唯一试验。',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    candidate: approvedCandidate,
    override: { attempts, successfulWrites: 1, mechanism: 'override-disable', error: null },
    patchTrial: pendingTrial,
    actionableCandidateCount: 0,
    terminal: false,
  };
}

const interruptedScene: JourneyScene = {
  id: 'override-interrupted',
  event: 'OverrideExecutionInterrupted',
  eyebrow: 'Recovery · override write interrupted',
  title: '失败留在可恢复的同一决定上',
  explanation: 'Candidate 保持 executing，Approval Hub 改为“继续执行”；没有 override 写入，也没有提前创建 PatchTrial。',
  activeStage: 'governance',
  selectedStage: 'governance',
  verdict: 'retire-candidate',
  candidate: executingCandidate,
  override: {
    attempts: 1,
    successfulWrites: 0,
    mechanism: 'override-disable',
    error: 'simulated_override_failure_before_write',
  },
  patchTrial: null,
  actionableCandidateCount: 1,
  terminal: false,
};

const happyJourney: readonly JourneyScene[] = [
  commonScenes['signal-collected'],
  commonScenes['judgment-committed'],
  commonScenes['candidate-opened'],
  commonScenes['operator-approved'],
  overrideApplied(1),
  commonScenes['treatment-inconclusive'],
  commonScenes['trial-closed'],
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
];

export function journeyFor(scenario: JourneyScenario): readonly JourneyScene[] {
  return scenario === 'recovery' ? recoveryJourney : happyJourney;
}
