'use client';

import type { CapabilityTipContext } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { catColorVar } from '@/lib/cat-slug';
import { CLASSIC_NAME_OPACITY } from '@/lib/readable-name-role';
import type { AppServerLifecycleSnapshot, CatStatusType } from '@/stores/chat-types';
import { CapabilityTipStrip } from './CapabilityTipStrip';
import { CatAvatar } from './CatAvatar';
import { CatNameplate } from './CatNameplate';
import { DEFAULT_STREAMING_TIP_CONTEXTS, isStreamingTipSuppressed } from './capability-tip-placement';
import { MessageBubble } from './MessageBubble';
import { pendingMemberCopy } from './pending-member.shell-copy';

interface PendingMemberBubbleProps {
  catId: string;
  invocationId: string;
  /** Liveness status for stall suppression — hide tips when cat is stalled (AC-B2 red line). */
  catStatus?: CatStatusType;
  /** App-server lifecycle can become stalled while catStatus remains streaming. */
  appServerLifecycle?: AppServerLifecycleSnapshot;
  /** Tip contexts from intentMode — review mode gets review tips instead of generic thinking tips. */
  tipContexts?: readonly CapabilityTipContext[];
  /** Only one pending bubble per thread should show tips (dedup — cloud review P2). */
  showCapabilityTip?: boolean;
}

/**
 * Minimal dots fallback for dedup bubbles (showCapabilityTip=false) and
 * stall-suppressed states where the tip strip is hidden (AC-B2).
 */
function PendingDots() {
  return (
    <div className="flex items-center gap-1 py-2 text-cafe-fg-muted" role="status">
      <span className="sr-only">处理中</span>
      <span className="inline-flex gap-0.5" aria-hidden="true">
        <span className="animate-bounce text-sm" style={{ animationDelay: '0ms' }}>
          ·
        </span>
        <span className="animate-bounce text-sm" style={{ animationDelay: '150ms' }}>
          ·
        </span>
        <span className="animate-bounce text-sm" style={{ animationDelay: '300ms' }}>
          ·
        </span>
      </span>
    </div>
  );
}

/**
 * F322 B (north-star §1.16, 合同三): in the new shell a cat that has started and has not written anything yet is the same
 * nameplate as the reply that will replace it, and one line under it. The dot is grey ("还没有输出", DESIGN.md status-dot).
 */
function PendingStatusLine() {
  const t = useShellCopy(pendingMemberCopy);
  return (
    <output className="flex items-center gap-2 py-1 text-sm" style={{ color: 'var(--shell-body)' }}>
      <span
        data-testid="pending-member-status-dot"
        aria-hidden="true"
        className="inline-block h-2 w-2 flex-none rounded-full"
        style={{ background: 'var(--shell-muted)' }}
      />
      <span data-testid="pending-member-status">{t.started}</span>
    </output>
  );
}

/**
 * #936: Show a member-level pending bubble with avatar before any stream
 * content arrives.
 *
 * F244 operator dogfood Round 4: the tip strip IS the thinking indicator —
 * a unified bubble with breathing animation. No separate dots when tips
 * are active. Dedup bubbles (showCapabilityTip=false) and stall states
 * fall back to minimal dots.
 *
 * F322 B: in the new shell the bubble is the cat's reply as it will look: the nameplate of the real message (the face is the
 * one on the plate, the name is the cat-name role at full opacity, as the message name that replaces this bubble) and one line
 * under it, 「已开始，还没有输出」, in place of the dots. A cat the catalogue does not know has no plate to wear: its name in the
 * body text role, the same line. A stalled turn's own wording belongs to the status contract (§1.16 合同二) and is not part of
 * this bubble yet. Classic keeps the avatar column, the cat hex at 0.8 and the dots (frozen).
 */
export function PendingMemberBubble({
  catId,
  invocationId,
  catStatus,
  appServerLifecycle,
  tipContexts,
  showCapabilityTip = false,
}: PendingMemberBubbleProps) {
  const { getCatById } = useCatData();
  const v2 = useShellPresentation() === 'v2';
  const catData = getCatById(catId);
  const catName = catData ? formatCatName(catData) : catId;
  const tipEnabled = showCapabilityTip && !isStreamingTipSuppressed(catStatus, appServerLifecycle);

  const tip = tipEnabled ? (
    <CapabilityTipStrip
      surface="pending_bubble"
      contexts={tipContexts ?? DEFAULT_STREAMING_TIP_CONTEXTS}
      audience="cvo"
      enabled
      firstDelayMs={0}
    />
  ) : null;

  if (v2) {
    return (
      <MessageBubble
        messageId={`pending-${invocationId}`}
        presentation="nameplate"
        railColor={catData ? catColorVar(catData.id, 'primary') : undefined}
        avatar={null}
        header={
          <div className="mb-1 flex items-center gap-2 min-w-0" data-testid="pending-member-header">
            {catData ? (
              <CatNameplate catId={catData.id} name={catName} />
            ) : (
              <span className="text-compact font-semibold" style={{ color: 'var(--shell-body)' }}>
                {catName}
              </span>
            )}
          </div>
        }
        wrapperClassName="group cat-persona-derived"
      >
        <PendingStatusLine />
        {tip}
      </MessageBubble>
    );
  }

  return (
    <MessageBubble
      messageId={`pending-${invocationId}`}
      avatar={<CatAvatar catId={catId} size={32} status="streaming" />}
      header={
        <span
          className="text-xs font-semibold"
          style={{ color: catData?.color?.primary, opacity: CLASSIC_NAME_OPACITY }}
        >
          {catName}
        </span>
      }
      wrapperClassName="group cat-persona-derived"
    >
      {tip ?? <PendingDots />}
    </MessageBubble>
  );
}
