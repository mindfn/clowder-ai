'use client';

import type { ProfileItem } from './hub-accounts.types';
import { TagEditor } from './hub-tag-editor';
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
  onEdit?: (profile: ProfileItem) => void;
}

const PROVIDER_DEFAULT_HOST: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  google: 'generativelanguage.googleapis.com',
};

function summaryText(profile: ProfileItem): string | null {
  if (profile.authType === 'oauth') return null;
  const host =
    profile.baseUrl?.replace(/^https?:\/\//, '').replace(/\/+$/, '') ||
    (profile.clientId && PROVIDER_DEFAULT_HOST[profile.clientId]) ||
    null;
  const keyStatus = profile.hasApiKey ? '已配置' : '未配置';
  return host ? `${host} · ${keyStatus}` : keyStatus;
}

export function HubAccountItem({ profile, busy, onSave, onDelete, onEdit }: HubAccountItemProps) {
  const confirm = useConfirm();

  return (
    <div className="rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-bold text-[#2D2118]">{profile.displayName}</span>
            {profile.authType === 'oauth' ? (
              <span className="text-[11px] font-semibold text-[#8A776B] flex items-center gap-0.5">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
                内置
              </span>
            ) : null}
            {profile.authType !== 'oauth' ? (
              <span className="rounded-full bg-[#F3E8FF] px-2.5 py-1 text-[11px] font-semibold text-[#9D7BC7]">
                api_key
              </span>
            ) : null}
          </div>
          {summaryText(profile) ? <p className="text-sm text-[#8A776B]">{summaryText(profile)}</p> : null}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#8A776B]">可用模型</p>
            <TagEditor
              tags={profile.models ?? []}
              tone={profile.authType === 'oauth' ? 'orange' : 'purple'}
              addLabel="+ 添加"
              placeholder="输入模型名"
              emptyLabel="(暂无模型)"
              minCount={1}
              onChange={(nextModels) => {
                if (busy) return;
                void onSave(profile.id, {
                  displayName: profile.displayName,
                  ...(profile.authType === 'api_key' ? { baseUrl: profile.baseUrl ?? '' } : {}),
                  models: nextModels,
                });
              }}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {profile.authType !== 'oauth' && onEdit ? (
            <button
              type="button"
              className="rounded-full bg-[#F7F3F0] px-3 py-1.5 text-xs font-semibold text-[#8A776B]"
              onClick={() => onEdit(profile)}
              disabled={busy}
            >
              编辑
            </button>
          ) : null}
          {profile.authType !== 'oauth' ? (
            <button
              type="button"
              className="rounded-full bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600"
              onClick={async () => {
                if (
                  await confirm({
                    title: '删除确认',
                    message: `确认删除账号「${profile.displayName}」吗？该操作不可撤销。`,
                    variant: 'danger',
                    confirmLabel: '删除',
                  })
                ) {
                  onDelete(profile.id);
                }
              }}
              disabled={busy}
            >
              删除
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
