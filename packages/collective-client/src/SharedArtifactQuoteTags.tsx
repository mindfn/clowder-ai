import type { useSharedArtifactComposer } from './use-shared-artifact-composer.js';

export function SharedArtifactQuoteTags({
  attachment,
}: {
  readonly attachment: ReturnType<typeof useSharedArtifactComposer>;
}) {
  if (!attachment.selections.length && !attachment.rework && !attachment.reply && !attachment.failure) return null;
  return (
    <fieldset className="shared-artifact-quote-tags" aria-label="作品引用">
      {attachment.reply && (
        <div>
          <span>回复第 {attachment.reply.ownerRevision} 版的批注 · 留在原讨论</span>
          <button type="button" aria-label="移除批注引用" onClick={attachment.removeReply}>
            ×
          </button>
        </div>
      )}
      {attachment.rework && (
        <div>
          <span>
            第 {attachment.rework.sourceOwnerRevision} 版的修改 · 基于第 {attachment.rework.ownerRevision} 版重做
          </span>
          <button type="button" aria-label="移除修改引用" onClick={attachment.removeRework}>
            ×
          </button>
        </div>
      )}
      {attachment.selections.map((selection, index) => (
        <div key={`${selection.artifactId}:${selection.span.start}:${index}`}>
          <span>
            {index + 1} · 第 {selection.ownerRevision} 版 · {attachment.label(index)}
          </span>
          <button type="button" aria-label={`移除引用 ${index + 1}`} onClick={() => attachment.remove(index)}>
            ×
          </button>
        </div>
      ))}
      {(attachment.stale || attachment.failure) && (
        <p role="alert">
          {attachment.stale ? '引用的版本已改变或无法访问，请重新选取；你写的话仍在。' : attachment.failure}
        </p>
      )}
    </fieldset>
  );
}
