import { useEffect, useRef } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactVersionHistory } from './use-shared-artifact-version-history.js';

export function SharedArtifactHistory({
  artifact,
  ownerRevision,
  onClose,
}: {
  readonly artifact: SharedArtifact;
  readonly ownerRevision?: number;
  readonly onClose: () => void;
}) {
  const shared = useSharedArtifacts();
  const history = useSharedArtifactVersionHistory(artifact);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  return (
    <dialog
      open
      className="shared-artifact-information shared-artifact-history"
      aria-label="版本记录"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2>版本记录</h2>
        <button ref={close} type="button" aria-label="关闭版本记录" onClick={onClose}>
          ×
        </button>
      </header>
      <ol>
        {history.page?.versions.map((version) => {
          const message = version.lineage && shared?.sourceMessage(version.lineage.requestEventId);
          const author =
            message?.recipient?.kind === 'agent' && message.recipient.agentId === version.authorCatId
              ? `${shared?.catName(message.recipient.humanId, message.recipient.agentId)} · ${shared?.humanName(message.recipient.humanId)}的 Café`
              : '原请求中的具名猫';
          return (
            <li key={version.ownerRevision}>
              <h3>
                第 {version.ownerRevision} 版{version.ownerRevision === ownerRevision && <small> · 正在查看</small>}
              </h3>
              <p>
                {version.adoptedByHumanId
                  ? `${shared?.humanName(version.adoptedByHumanId)}采用了${author}的修改。`
                  : `${shared?.humanName(artifact.publishedByHumanId)}分享的版本。`}
              </p>
              <time dateTime={version.recordedAt}>{new Date(version.recordedAt).toLocaleString('zh-CN')} 记录</time>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    shared?.open(artifact, version.ownerRevision);
                    onClose();
                  }}
                >
                  查看第 {version.ownerRevision} 版
                </button>
                {version.lineage && (
                  <button
                    type="button"
                    aria-label={`在讨论中查看第 ${version.ownerRevision} 版的请求`}
                    onClick={() => {
                      if (!version.lineage) return;
                      shared?.close();
                      shared?.returnToSource?.(version.lineage.location.channelId, version.lineage.requestEventId);
                    }}
                  >
                    在讨论中查看
                  </button>
                )}
              </div>
              <details>
                <summary>{version.adoptedByHumanId ? '采用回执与版本指纹' : '分享回执与版本指纹'}</summary>
                <code>{version.receiptRef}</code>
                <code>{version.blobDigest}</code>
              </details>
            </li>
          );
        })}
      </ol>
      {history.pending && <output>正在读取版本记录…</output>}
      {history.error && <p role="alert">{history.error}</p>}
      {history.page?.nextOffset !== undefined && (
        <button type="button" disabled={history.pending} onClick={() => void history.more()}>
          更早的版本（已读 {history.page.versions.length}/{history.page.total}）
        </button>
      )}
    </dialog>
  );
}
