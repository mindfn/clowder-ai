'use client';

import type { ParticipationView } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

export function CollectiveChannelListeningSettings({
  state,
  view,
  channelId,
  enabled,
  onSelectCats,
}: {
  readonly state: CollectiveWorkPolicyState;
  readonly view: ParticipationView;
  readonly channelId: string;
  readonly enabled: boolean;
  readonly onSelectCats?: () => void;
}) {
  const participants = view.cats.filter((cat) => view.channelRoutes[channelId]?.participants[cat.id]);
  const current = state.listening?.channelListening[channelId];
  const selected = participants.find((cat) => cat.id === current?.dutyCatId);
  const fallback = selected ?? participants[0];
  const disabled = !enabled || state.busy || !state.listening;
  return (
    <section aria-label={`# ${channelId} 的消息回应`} className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold">我家的猫在这个频道</h3>
        <p className="mt-1 text-xs text-cafe-muted">仅自己可见</p>
      </header>
      <fieldset className="space-y-2" disabled={disabled}>
        <label className="flex gap-2 text-sm">
          <input
            type="radio"
            className="accent-[var(--cafe-text)]"
            name="collective-listening"
            checked={Boolean(state.listening) && current?.mode !== 'all'}
            onChange={() => void state.listen(channelId, 'mentions')}
          />
          仅在被 @ 时回应
        </label>
        <label className="flex gap-2 text-sm">
          <input
            type="radio"
            className="accent-[var(--cafe-text)]"
            name="collective-listening"
            checked={current?.mode === 'all'}
            disabled={disabled || !participants.length}
            onChange={() => fallback && void state.listen(channelId, 'all', fallback.id)}
          />
          留意所有消息
        </label>
      </fieldset>
      <ListeningReadState loaded={Boolean(state.listening)} error={state.error} onRetry={() => void state.read()} />
      {!participants.length ? (
        <p className="text-xs text-cafe-muted">
          先让一只猫加入这个频道。
          {onSelectCats && (
            <button type="button" className="ml-1 underline" onClick={onSelectCats}>
              选择猫…
            </button>
          )}
        </p>
      ) : current?.mode === 'all' && !selected ? (
        <label className="grid gap-1 text-xs text-cafe-muted">
          原来的猫已不再参与
          <select
            aria-label="换一只留意消息的猫"
            className="h-8 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 text-sm text-cafe-primary disabled:opacity-50"
            value=""
            disabled={disabled}
            onChange={(event) => void state.listen(channelId, 'all', event.target.value)}
          >
            <option value="" disabled>
              换一只…
            </option>
            {participants.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.nickname ?? cat.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : current?.mode === 'all' && selected ? (
        <label className="grid gap-1 text-xs text-cafe-secondary">
          {selected.nickname ?? selected.displayName} 看每条消息，需要时回应
          <select
            aria-label="换一只留意消息的猫"
            className="h-8 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 text-sm text-cafe-primary disabled:opacity-50"
            value={selected.id}
            disabled={disabled}
            onChange={(event) => void state.listen(channelId, 'all', event.target.value)}
          >
            {participants.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.nickname ?? cat.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </section>
  );
}

function ListeningReadState({
  loaded,
  error,
  onRetry,
}: {
  readonly loaded: boolean;
  readonly error?: string;
  readonly onRetry: () => void;
}) {
  if (!loaded && !error)
    return (
      <p aria-live="polite" className="text-xs text-cafe-muted">
        正在读取频道设置…
      </p>
    );
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-conn-red-text">
      读不到频道设置。{' '}
      <button type="button" className="underline" onClick={onRetry}>
        重试
      </button>
    </p>
  );
}
