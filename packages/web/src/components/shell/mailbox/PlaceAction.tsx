import type { OriginalPlace } from './original-place';

const LIST_LABEL = { approval: '打开审批列表', 'needs-me': '打开待处理列表' } as const;

/**
 * The way back to the original place. An exact place says "打开原处处理". Where the panel cannot find the one item it says so
 * and opens the list that owns it, under its own name, instead of letting a list pass for the place. `quiet` is the same
 * way back as a second thing to do (below a card that already carries the decision), not the one way forward.
 */
export function PlaceAction({
  place,
  onOpen,
  quiet = false,
}: {
  place: OriginalPlace;
  onOpen: (place: OriginalPlace) => void;
  quiet?: boolean;
}) {
  // A list is still reachable through the mailbox's second layer; it is not this proposal's original place.
  if (quiet && place.kind === 'list') return null;
  return (
    <div className={quiet ? 'flex items-center' : 'flex items-center justify-between gap-3'}>
      {place.kind === 'list' ? (
        <p className="m-0 text-xs" style={{ color: 'var(--shell-muted)' }} data-testid="mailbox-place-note">
          原处暂不可定位
        </p>
      ) : !quiet ? (
        <span />
      ) : null}
      <button
        type="button"
        data-testid="mailbox-open-original"
        data-place={place.kind}
        onClick={() => onOpen(place)}
        className="shell-focusable flex-none rounded-lg px-3 py-1.5 text-sm font-medium"
        style={
          quiet
            ? {
                background: 'transparent',
                color: 'var(--shell-primary-text)',
                paddingLeft: 0,
                paddingRight: 0,
              }
            : { background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }
        }
      >
        {place.kind === 'exact' ? (quiet ? '在原处看这条提议' : '打开原处处理') : LIST_LABEL[place.destination]}
      </button>
    </div>
  );
}
