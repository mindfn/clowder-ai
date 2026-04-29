'use client';

import type { ProfileItem } from './hub-accounts.types';
import { HubIcon } from './hub-icons';
import { useConfirm } from './useConfirm';

export interface ProfileEditPayload {
  displayName: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  modelOverride?: string | null;
}

interface HubAccountItemProps {
  profile: ProfileItem;
  busy: boolean;
  onSave: (profileId: string, payload: ProfileEditPayload) => Promise<void>;
  onDelete: (profileId: string) => void;
}

function summaryText(profile: ProfileItem): string | null {
  if (profile.builtin) return profile.authType === 'oauth' ? 'OAuth' : '内置';
  const host = profile.baseUrl?.replace(/^https?:\/\//, '') ?? '(未设置)';
  return `${host} · ${profile.authType === 'oauth' ? 'OAuth' : 'API Key'}`;
}

export function HubAccountItem({ profile, busy, onDelete }: HubAccountItemProps) {
  const confirm = useConfirm();

  const handleDelete = async () => {
    const ok = await confirm({
      title: '删除账号',
      message: `确定要删除「${profile.displayName}」吗？此操作不可撤销。`,
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (ok) onDelete(profile.id);
  };

  return (
    <div className="flex w-full items-center gap-4 rounded-xl bg-[var(--console-card-bg)] p-4 transition-colors hover:bg-[var(--console-card-soft-bg)]">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-cafe">{profile.displayName}</p>
        <p className="mt-1 text-[12px] text-cafe-secondary truncate">{summaryText(profile)}</p>
      </div>
      {!profile.builtin && (
        <button
          type="button"
          disabled={busy}
          onClick={handleDelete}
          className={`shrink-0 rounded-md p-1.5 text-cafe-muted hover:bg-[var(--console-card-soft-bg)] hover:text-[var(--console-stop,#f26767)] transition-colors ${busy ? 'opacity-50' : ''}`}
          title="删除"
        >
          <HubIcon name="trash" className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
