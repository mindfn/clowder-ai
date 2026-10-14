import type { ChatMessage } from '@/stores/chat-types';
import type { freshnessNoticeCopy } from './freshness-notice.shell-copy';

type Copy = (typeof freshnessNoticeCopy)['zh'];

function publicFailureReason(reason: unknown, copy: Copy) {
  // Only owner-defined public reasons are rendered. Unknown future values may contain diagnostic details.
  return Object.entries(copy.reasons).find(([key]) => key === reason)?.[1] ?? copy.unknownReason;
}

export function getFreshnessNotice(
  message: ChatMessage,
  copy: Copy,
): { text: string; title?: string; failed?: boolean } | null {
  const projection = message.extra?.freshnessSupplement;
  const annotation = message.extra?.freshness;
  if (projection) {
    let notice: { text: string; failed?: boolean };
    switch (projection.status) {
      case 'pending':
        notice = { text: copy.pending(projection.requiredCount) };
        break;
      case 'running':
        notice = { text: copy.running(projection.requiredCount) };
        break;
      case 'committed':
        notice = { text: copy.committed };
        break;
      case 'declined':
        notice = { text: copy.declined };
        break;
      case 'failed':
        notice = { text: copy.failed(publicFailureReason(projection.terminalReason, copy)), failed: true };
        break;
    }
    if (projection.budgetExhaustedCount) notice.text += copy.exhausted(projection.budgetExhaustedCount);
    return notice;
  }
  if (annotation?.kind === 'published_with_unseen') {
    return annotation.supplementFailureReason
      ? {
          text: `${copy.unseen(annotation.generatedWithUnseen.length)}; ${copy.offerFailed(publicFailureReason(annotation.supplementFailureReason, copy))}`,
          failed: true,
        }
      : { text: copy.unseen(annotation.generatedWithUnseen.length) };
  }
  if (annotation?.kind === 'freshness_unknown') return { text: copy.unknown };
  if (annotation?.kind === 'scan_pending') return { text: copy.scanning };
  return null;
}
