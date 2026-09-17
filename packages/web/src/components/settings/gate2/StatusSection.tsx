import { SettingsSection, SettingsStatusStrip } from '../primitives';

export interface PendingRestartItem {
  label: string;
  saved: string;
  current: string | null;
}

function StatusRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="text-sm font-medium text-cafe">{label}</div>
      <div
        className={`min-w-0 max-w-[60%] truncate text-right text-sm text-cafe-muted ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * #770 Gate 2 status facts. `dataDirDisplay` / `platformDir` arrive as
 * absolute resolved paths from the API (resolvedValue) — the rows answer
 * "where is my data", never "did you set the variable".
 */
export function StatusSection({
  memoryMode,
  dataDirDisplay,
  accessAddress,
  ownerLabel,
  platformDir,
  pendingItems,
}: {
  memoryMode: boolean;
  dataDirDisplay: string;
  accessAddress: string;
  ownerLabel: string;
  platformDir: string;
  pendingItems: PendingRestartItem[];
}) {
  return (
    <SettingsSection title="系统状态">
      <div className="divide-y divide-[var(--console-border-soft)]">
        <StatusRow label="存储模式" value={memoryMode ? '内存模式' : '持久化（Redis）'} mono={false} />
        <StatusRow label="数据存在哪" value={dataDirDisplay} />
        <StatusRow label="当前访问地址与端口" value={accessAddress} />
        <StatusRow label="所有者模式" value={ownerLabel} mono={false} />
        <StatusRow label="平台状态目录" value={platformDir} />
      </div>
      {memoryMode && <SettingsStatusStrip tone="warn">内存模式下，重启后数据不会保留</SettingsStatusStrip>}
      {pendingItems.length > 0 && (
        <div className="mt-2 space-y-1">
          {pendingItems.map((item) => (
            <div key={item.label} className="text-xs text-cafe-muted">
              待重启 · {item.label}：已保存 {item.saved}，当前生效 {item.current}
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
