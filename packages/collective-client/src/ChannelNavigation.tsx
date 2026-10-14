import { CollectiveIcon } from './CollectiveIcon.js';
import type { channelDestinations } from './channel-navigation.js';

export function ChannelNavigation({
  channels,
  channelId,
  query,
  onQuery,
  onSelect,
  onMembers,
  guideCatCount,
}: {
  readonly channels: ReturnType<typeof channelDestinations>;
  readonly channelId?: string;
  readonly query: string;
  readonly onQuery: (value: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onMembers: () => void;
  readonly guideCatCount?: number;
}) {
  const visible = channels.filter((channel) =>
    channel.id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <label className="destination-search">
        <CollectiveIcon kind="search" />
        <input
          type="search"
          aria-label="搜索频道与话题"
          placeholder="搜索频道、话题或消息"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <div className="destination-scroll">
        <nav className="destination-list" aria-label="频道">
          <p>频道</p>
          {(query ? visible : channels).map((channel) => (
            <button
              key={channel.id}
              type="button"
              className={`destination-item channel-destination ${channel.id === channelId ? 'destination-item-active' : ''}`}
              aria-current={channel.id === channelId ? 'page' : undefined}
              onClick={() => onSelect(channel.id)}
            >
              <span className="destination-symbol">#</span>
              <span>
                <strong>{channel.id}</strong>
                <small>
                  {channel.id === 'general' && guideCatCount !== undefined
                    ? guideCatCount
                      ? '伙伴正在加入'
                      : '正在准备'
                    : channel.messageCount
                      ? `${channel.messageCount} 条消息`
                      : ''}
                </small>
              </span>
            </button>
          ))}
          {query && !visible.length && <p className="navigation-empty">没有同名频道；主区显示匹配的消息。</p>}
        </nav>
        <nav className="destination-list member-destination" aria-label="共同家园成员">
          <button type="button" className="destination-item" onClick={onMembers}>
            <span className="destination-symbol">
              <CollectiveIcon kind="members" />
            </span>
            <span>
              <strong>成员</strong>
              <small>认识这里的人与猫</small>
            </span>
          </button>
        </nav>
      </div>
    </>
  );
}
