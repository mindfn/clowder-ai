/**
 * F221 Phase I: taste proposal approval card block.
 *
 * Shown in the source thread when a cat captures a taste signal for operator review.
 * Informational only — no `actions` array.  Decisions happen in the F246
 * Approval Hub panel (the canonical decision surface).  This is a permanent
 * boundary: approval cards are status indicators, not interactive controls.
 */

import type { RichCardBlock, TasteProposal } from '@cat-cafe/shared';

const DIMENSION_LABELS: Record<string, string> = {
  'relationship-stance': '关系立场',
  'cognitive-honesty': '认知诚实',
  'architecture-aesthetics': '架构美学',
  'visual-quality': '视觉品质',
  'authentic-expression': '真实表达',
  'system-philosophy': '系统哲学',
  'creative-craft': '创作工艺',
};

export function buildTasteProposalCardBlock(proposal: TasteProposal): RichCardBlock {
  const scenePreview = proposal.scene.length > 200 ? `${proposal.scene.slice(0, 197)}…` : proposal.scene;
  const correction = proposal.correctionTarget;

  return {
    id: `taste-proposal-${proposal.id}`,
    kind: 'card',
    v: 1,
    title: correction ? '提议更正品味记忆' : '提议捕捉品味信号',
    bodyMarkdown: [
      ...(correction
        ? [
            `**更正原因：** ${correction.reason}`,
            '',
            `**建议改动：** \`${JSON.stringify(correction.suggestedPatch)}\``,
            '',
          ]
        : []),
      ...(proposal.takeaway ? [`**猫的判断（假设）：** ${proposal.takeaway}`, ''] : []),
      `**场景：** ${scenePreview}`,
      '',
      `> ${proposal.quote}`,
    ].join('\n'),
    tone: 'info',
    fields: [
      { label: '维度', value: DIMENSION_LABELS[proposal.dimension] ?? proposal.dimension },
      { label: '标签', value: proposal.tags.join(', ') },
      { label: '隐私', value: proposal.privacy === 'sensitive' ? '敏感' : '公开' },
      { label: '捕捉猫', value: proposal.catId },
      ...(correction ? [{ label: '动作', value: '更正已有记忆' }] : []),
    ],
  };
}
