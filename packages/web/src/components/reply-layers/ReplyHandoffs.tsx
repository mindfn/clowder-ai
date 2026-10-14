'use client';

import type { CatData } from '@/hooks/useCatData';
import { formatCatName } from '@/hooks/useCatData';
import { CatAvatar } from '../CatAvatar';
import { useShellCopy } from '../shell/shell-copy';
import type { ReplyHandoffProjection } from './reply-handoff';
import { replyLayersCopy } from './reply-layers.shell-copy';

function Target({ catId, getCatById }: { catId: string; getCatById: (catId: string) => CatData | undefined }) {
  const cat = getCatById(catId);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {cat ? <CatAvatar catId={catId} size={16} ring="none" /> : null}
      <span className="truncate">{cat ? formatCatName(cat) : catId}</span>
    </span>
  );
}

function HandoffLine({
  handoff,
  getCatById,
}: {
  handoff: ReplyHandoffProjection;
  getCatById: (catId: string) => CatData | undefined;
}) {
  const t = useShellCopy(replyLayersCopy);
  const prefix = t.handoff[handoff.kind];
  return (
    <div
      data-testid="reply-handoff"
      data-handoff-kind={handoff.kind}
      data-source-message-ids={handoff.sourceMessageIds.join(',')}
      className="flex min-w-0 items-center gap-1.5 text-xs"
      style={{ color: 'var(--shell-muted)' }}
    >
      <span className="flex-none">{prefix}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {handoff.targetCatIds.map((catId, index) => (
          <span key={catId} className="contents">
            {index > 0 ? <span aria-hidden="true">、</span> : null}
            <Target catId={catId} getCatById={getCatById} />
          </span>
        ))}
      </span>
    </div>
  );
}

export function ReplyHandoffs({
  handoffs,
  getCatById,
  standaloneMessageId,
}: {
  handoffs: readonly ReplyHandoffProjection[];
  getCatById: (catId: string) => CatData | undefined;
  standaloneMessageId?: string;
}) {
  if (handoffs.length === 0) return null;
  const content = handoffs.map((handoff, index) => (
    <HandoffLine key={`${handoff.sourceMessageIds.join(':')}:${index}`} handoff={handoff} getCatById={getCatById} />
  ));
  if (!standaloneMessageId) return <div className="mt-1 flex min-w-0 flex-col gap-1">{content}</div>;
  return (
    <div data-message-id={standaloneMessageId} className="mb-3 flex justify-center px-4">
      <div className="max-w-[85%]">{content}</div>
    </div>
  );
}
