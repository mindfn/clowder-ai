'use client';
import type { ArtifactReviewAction, ArtifactReviewRound } from '@cat-cafe/shared';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ReviewActor } from './ReviewActor';
import { useReviewDraft } from './useReviewDraft';

type DecisionProps = {
  round: ArtifactReviewRound;
  ownerUserId: string;
  canWrite: boolean;
  saving: boolean;
  draftKey: string;
  act: (action: ArtifactReviewAction, round: number) => Promise<boolean>;
  compact?: boolean;
  onDiscuss?: (body?: string) => boolean;
};

export function ReviewRoundDecision(props: DecisionProps) {
  return useShellPresentation() === 'v2' ? <ChatRoundDecision {...props} /> : <ClassicRoundDecision {...props} />;
}

function ChatRoundDecision({ round, canWrite, saving, act, onDiscuss, draftKey }: DecisionProps) {
  const saved = useReviewDraft(draftKey);
  const needed = round.state === 'awaiting_human' && !round.attentionRetiredReason;
  return (
    <section aria-label="这一轮的结论" className="flex flex-wrap items-center justify-end gap-2 text-xs">
      {saved.draft.body ? (
        <div className="w-full text-cafe-secondary">
          <p className="line-clamp-3 whitespace-pre-wrap">之前未发出的说明：{saved.draft.body}</p>
          {onDiscuss ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                if (onDiscuss(saved.draft.body)) saved.clear();
              }}
            >
              放到聊天
            </button>
          ) : null}
        </div>
      ) : null}
      {round.decision ? <span>{round.decision.outcome === 'approved' ? '这版通过' : '需要修改'}</span> : null}
      {round.decision?.explanation ? <p>{round.decision.explanation}</p> : null}
      {onDiscuss ? (
        <button
          type="button"
          disabled={saving}
          className="rounded-lg border border-cafe-subtle px-3 py-2 font-semibold hover:bg-cafe-surface"
          title={canWrite ? '在原聊天中说明需要怎样修改' : '在原聊天中讨论这一版'}
          onClick={() => onDiscuss()}
        >
          {canWrite ? '要求修改' : '讨论此版本'}
        </button>
      ) : null}
      {canWrite && needed ? (
        <button
          type="button"
          disabled={saving}
          className="rounded-lg bg-cafe-accent px-3 py-2 font-semibold text-[var(--cafe-accent-foreground)] disabled:opacity-40"
          onClick={() => void act({ kind: 'decide', outcome: 'approved', explanation: '' }, round.number)}
        >
          通过此版本
        </button>
      ) : null}
    </section>
  );
}

function ClassicRoundDecision({ round, ownerUserId, canWrite, saving, draftKey, act, compact = false }: DecisionProps) {
  const { draft, update, clear, storageError } = useReviewDraft(draftKey);
  const decided = round.state === 'approved' || round.state === 'changes_requested';
  const needed = round.state === 'awaiting_human' && !round.attentionRetiredReason;
  async function submit(action: ArtifactReviewAction) {
    if (await act(action, round.number)) clear();
  }
  return (
    <section
      className={compact ? 'space-y-2' : 'rounded-xl border border-cafe-accent/25 bg-cafe-accent/5 p-4'}
      aria-label="这一轮的结论"
    >
      <h3 className="text-sm font-semibold text-cafe-black">
        {needed ? '猫已准备好，需要你判断' : decided ? '这一轮的结论' : '把意见交给负责的猫'}
      </h3>
      {round.judgmentRequest ? (
        <div className="mt-3 space-y-2 text-sm leading-6 text-cafe-secondary">
          <ReviewActor actor={round.judgmentRequest.requestedBy} ownerUserId={ownerUserId} />
          <p className="whitespace-pre-wrap break-words">{round.judgmentRequest.summary}</p>
          <p className="whitespace-pre-wrap break-words font-medium text-cafe-black">
            {round.judgmentRequest.judgmentNeeded}
          </p>
        </div>
      ) : null}
      {round.decision ? (
        <div className="mt-3 space-y-2" data-testid="review-round-decision">
          <span className="rounded-full bg-cafe-surface px-3 py-1 text-xs font-semibold text-cafe-accent">
            {round.decision.outcome === 'approved' ? '这版通过' : '需要修改'}
          </span>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-cafe-black">
            {round.decision.explanation}
          </p>
          <ReviewActor actor={round.decision.actor} ownerUserId={ownerUserId} />
        </div>
      ) : null}
      {canWrite ? (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-cafe-secondary">
            {decided ? '重新打开的原因' : '你的判断与下一步'}
            <textarea
              value={draft.body}
              onChange={(event) => update({ ...draft, body: event.target.value })}
              aria-label="审阅结论说明"
              disabled={saving}
              maxLength={8000}
              className="mt-2 min-h-20 w-full resize-y rounded-lg border border-cafe-subtle bg-cafe-surface p-3 text-sm text-cafe-black"
              placeholder={decided ? '还有需要一起确认的地方…' : '把需要调整的地方或批准理由说给猫听…'}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {decided ? (
              <button
                type="button"
                disabled={saving || !draft.body.trim()}
                className="rounded-lg border border-cafe-accent/30 px-3 py-2 text-xs font-semibold text-cafe-accent disabled:opacity-40"
                onClick={() => void submit({ kind: 'reopen', explanation: draft.body })}
              >
                重新打开这一轮
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={saving || !draft.body.trim()}
                  className="rounded-lg border border-cafe-accent/30 px-3 py-2 text-xs font-semibold text-cafe-accent disabled:opacity-40"
                  onClick={() =>
                    void submit(
                      needed
                        ? { kind: 'decide', outcome: 'changes_requested', explanation: draft.body }
                        : { kind: 'submit_feedback', explanation: draft.body },
                    )
                  }
                >
                  要求修改
                </button>
                {needed ? (
                  <button
                    type="button"
                    disabled={saving || !draft.body.trim()}
                    className="rounded-lg bg-cafe-accent px-3 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] disabled:opacity-40"
                    onClick={() => void submit({ kind: 'decide', outcome: 'approved', explanation: draft.body })}
                  >
                    通过此版本
                  </button>
                ) : null}
              </>
            )}
          </div>
          {storageError ? (
            <p role="alert" className="text-xs text-cafe-error">
              这段说明尚未保存到浏览器，请保留页面。
            </p>
          ) : null}
          <p className="text-micro leading-5 text-cafe-secondary">
            结论会连同这一版的讨论交还原任务；后续工作继续由原来的猫完成。
          </p>
        </div>
      ) : null}
    </section>
  );
}
