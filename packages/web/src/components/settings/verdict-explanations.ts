/**
 * F257 #6 (slice 6a) — Canonical verdict vocabulary + explanations (判据 ③).
 *
 * The eval verdict is a loose string (shared/segment-lifecycle.ts: `verdict: string | null`).
 * Before this, the lifeline UI hard-coded only 'alive' / 'dormant' / 'retire-candidate'
 * in its tone logic, so real verdicts the eval layer emits — notably `unmeasurable`
 * and `keep_observe` — fell through to a default amber with NO explanation.
 * Dev evidence: operator screenshot showed `eval(unmeasurable)` with its meaning
 * never surfaced. This module is the single source of truth for
 * verdict → { label, explanation, tone }, consumed by LifelineChainView and
 * EvalStagePanel so the vocabulary can never silently drift again.
 */

export type VerdictTone = 'emerald' | 'amber' | 'red' | 'blue' | 'slate';

export interface VerdictExplanation {
  /** Short Chinese display label. */
  label: string;
  /** One-line Chinese explanation of what this verdict means for the segment. */
  explanation: string;
  tone: VerdictTone;
}

/**
 * Canonical verdict vocabulary. Keys are the exact verdict strings the eval layer
 * emits (harness-eval / RoutingFactProjection / qc-metrics-provider).
 */
export const VERDICT_EXPLANATIONS: Record<string, VerdictExplanation> = {
  alive: {
    label: '活跃',
    explanation: '评估窗口内有足够注入、且未达退役标准，段正常服役。',
    tone: 'emerald',
  },
  keep_observe: {
    label: '继续观察',
    explanation: '数据不足以定论，本窗口不迭代，累计到下一个评估窗口再判。',
    tone: 'blue',
  },
  unmeasurable: {
    label: '无法测量',
    explanation: '指标所需数据缺失（如投影不可用、或窗口内无 typed fact），本窗口不计入趋势——注意：这不等于"零违规"。',
    tone: 'slate',
  },
  dormant: {
    label: '休眠',
    explanation: '段长期无触发 / 无观测，疑似冗余，进入退役候选观察。',
    tone: 'amber',
  },
  'retire-candidate': {
    label: '退役候选',
    explanation: '评估判定该段贡献为零 / 冗余，等待 operator 批准退役。',
    tone: 'red',
  },
};

/** Verdict strings the UI explicitly explains (regression anchor for tests). */
export const KNOWN_VERDICTS = Object.keys(VERDICT_EXPLANATIONS);

/**
 * Resolve a verdict string to its explanation. A null/absent verdict maps to an
 * explicit "未评估" entry; an unknown verdict degrades visibly (raw label + a
 * "please register" explanation) so a newly-emitted verdict surfaces instead of
 * silently misrendering as amber-with-no-meaning.
 */
export function explainVerdict(verdict: string | null | undefined): VerdictExplanation {
  if (!verdict) {
    return { label: '未评估', explanation: '该版本尚未产生评估判定。', tone: 'slate' };
  }
  return (
    VERDICT_EXPLANATIONS[verdict] ?? {
      label: verdict,
      explanation: '未知判定词——评估层新增了词汇但 Console 尚未登记解释，请补充 VERDICT_EXPLANATIONS。',
      tone: 'slate',
    }
  );
}
