import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { anchorBounds } from './review-geometry';

export interface PendingChatMark {
  readonly id: string;
  readonly anchor: ArtifactReviewAnchor;
}

/**
 * The places already put into the chat composer, marked on the picture with the number each one has in its chip. They
 * are not saved annotations (those keep their own numbering and discussion), so they look different: a dashed outline
 * and a filled number badge. Like the chips they go away when the message is sent or the place is removed.
 */
export function ReviewPendingChatMarks({ marks, media }: { marks: readonly PendingChatMark[]; media: ImmutableMedia }) {
  const radius = Math.max(8, media.width / 65);
  return (
    <>
      {marks.map((mark, index) => {
        const box = anchorBounds(mark.anchor);
        if (!box) return null;
        const isPoint = mark.anchor.kind === 'image-point';
        const cx = isPoint ? box.x : box.x + radius;
        const cy = isPoint ? box.y : box.y + radius;
        return (
          <g key={mark.id} data-testid="review-pending-chat-mark" data-selection-id={mark.id}>
            {isPoint ? null : (
              <rect
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                fill="var(--cafe-accent)"
                fillOpacity={0.1}
                stroke="var(--cafe-accent)"
                strokeWidth={2}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <circle cx={cx} cy={cy} r={radius} fill="var(--cafe-accent)" stroke="var(--cafe-surface)" strokeWidth={2} />
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--cafe-surface)"
              fontSize={Math.max(11, radius * 1.2)}
              fontWeight={600}
            >
              {index + 1}
            </text>
          </g>
        );
      })}
    </>
  );
}
