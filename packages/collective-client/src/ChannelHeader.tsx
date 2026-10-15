import type { MouseEvent } from 'react';

export function ChannelHeader({
  collectiveName,
  channelId,
  searchCount,
  connection,
  onOpenNavigation,
  onCafe,
  onChannelCafe,
  guideCatCount,
}: {
  readonly collectiveName: string;
  readonly channelId: string;
  readonly searchCount?: number;
  readonly connection: 'online' | 'offline';
  readonly onOpenNavigation: () => void;
  readonly onCafe?: () => void;
  readonly onChannelCafe?: () => void;
  readonly guideCatCount?: number;
}) {
  const searching = searchCount !== undefined;
  const openChannelCafe = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    onChannelCafe?.();
  };
  return (
    <header className="scene-header">
      <button type="button" className="mobile-navigation" aria-label="频道导航" onClick={onOpenNavigation}>
        ☰{guideCatCount !== undefined && <span className="mobile-cat-badge">{guideCatCount}</span>}
      </button>
      <div>
        {searching ? (
          <>
            <p className="scene-eyebrow">{collectiveName}</p>
            <h1>搜索结果</h1>
            <p>找到 {searchCount} 段相关讨论</p>
          </>
        ) : (
          <details className="channel-menu">
            <summary>
              <h1># {channelId}</h1>
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="channel-menu-popover">
              <span>频道详情</span>
              {onChannelCafe && (
                <button type="button" onClick={openChannelCafe}>
                  我家的猫在这个频道… <small>仅自己可见</small>
                </button>
              )}
            </div>
          </details>
        )}
      </div>
      <div className="scene-header-actions">
        {connection === 'offline' && <span className="offline-label">暂时离线</span>}
        {onCafe && (
          <button type="button" className="cafe-window-button" onClick={onCafe}>
            我的猫
          </button>
        )}
      </div>
    </header>
  );
}
