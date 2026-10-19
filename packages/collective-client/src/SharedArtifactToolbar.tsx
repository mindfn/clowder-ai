import { useRef, useState } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { SharedArtifactHistory } from './SharedArtifactHistory.js';
import { SharedArtifactInformation } from './SharedArtifactInformation.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

/** The scoped key supplied by the surface resets both panels and focus targets together. */
export function SharedArtifactToolbar({
  artifact,
  managementArtifact,
  ownerRevision,
  onReturnToSource,
  onOpenDiscussion,
}: {
  readonly artifact?: SharedArtifact;
  readonly managementArtifact?: SharedArtifact;
  readonly ownerRevision?: number;
  readonly onReturnToSource: () => void;
  readonly onOpenDiscussion: () => void;
}) {
  const shared = useSharedArtifacts();
  const [panel, setPanel] = useState<'information' | 'history'>();
  const infoToggle = useRef<HTMLButtonElement>(null);
  const historyToggle = useRef<HTMLButtonElement>(null);
  const infoOpen = panel === 'information';
  return (
    <>
      <header className="shared-artifact-header">
        <button
          ref={infoToggle}
          type="button"
          onClick={() => {
            setPanel(infoOpen ? undefined : 'information');
          }}
          aria-expanded={infoOpen}
        >
          <strong>{artifact?.title ?? '共同作品'}</strong>
          <span>作品信息 ⌄</span>
        </button>
        <div>
          {artifact && (
            <button
              ref={historyToggle}
              type="button"
              onClick={() => {
                setPanel(panel === 'history' ? undefined : 'history');
              }}
              aria-expanded={panel === 'history'}
            >
              版本记录
            </button>
          )}
          <button type="button" className="shared-discussion-toggle" onClick={onOpenDiscussion}>
            讨论
          </button>
          {artifact && (
            <label>
              版本
              <select value={ownerRevision} onChange={(event) => shared?.open(artifact, Number(event.target.value))}>
                {ownerRevision !== undefined && ownerRevision !== artifact.versions.at(-1)?.ownerRevision && (
                  <option value={ownerRevision}>第 {ownerRevision} 版</option>
                )}
                {artifact.versions.slice(-1).map((version) => (
                  <option key={version.ownerRevision} value={version.ownerRevision}>
                    第 {version.ownerRevision} 版
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" aria-label={shared?.returnLabel ?? '关闭作品'} onClick={shared?.close}>
            {shared?.returnLabel && shared?.returnLabel !== '关闭作品' ? '←' : '×'}
          </button>
        </div>
      </header>
      {infoOpen && (
        <SharedArtifactInformation
          artifact={artifact}
          managementArtifact={managementArtifact}
          ownerRevision={ownerRevision}
          onReturnToSource={onReturnToSource}
          onClose={() => {
            setPanel(undefined);
            infoToggle.current?.focus();
          }}
        />
      )}
      {artifact && panel === 'history' && (
        <SharedArtifactHistory
          artifact={artifact}
          ownerRevision={ownerRevision}
          onClose={() => {
            setPanel(undefined);
            historyToggle.current?.focus();
          }}
        />
      )}
    </>
  );
}
