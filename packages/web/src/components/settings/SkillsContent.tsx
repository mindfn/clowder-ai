'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { CapabilityBoardItem, CapabilityBoardResponse } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import { MarketplacePanel } from '../marketplace/marketplace-panel';
import { SkillPreviewModal } from './SkillPreviewModal';

const AVATAR_COLORS = ['#C65F3D', '#8B6E5A', '#A0522D', '#7B6B63', '#9B7653', '#6F5946'];

function avatarColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function SkillsContent() {
  const [items, setItems] = useState<CapabilityBoardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewItem, setPreviewItem] = useState<CapabilityBoardItem | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await apiFetch('/api/capabilities?probe=true');
      if (!res.ok) return;
      const data = (await res.json()) as CapabilityBoardResponse;
      setItems(data.items.filter((i) => i.type === 'skill'));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-cafe">Skill 管理</h2>
            <p className="mt-1 text-sm text-cafe-secondary">
              Skill 使用独立纵向卡片；点击卡片打开内容预览弹窗；右侧查询和安装可用 Skill。
            </p>
          </div>
          <button
            type="button"
            disabled
            title="新增 Skill 功能即将上线"
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--cafe-accent,#C65F3D)] px-3.5 py-2 text-[13px] font-semibold text-white opacity-50 cursor-not-allowed"
          >
            <HubIcon name="plus" className="h-3.5 w-3.5" />
            新增 Skill
          </button>
        </div>

        {loading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse rounded-xl bg-[var(--console-card-bg)] p-4">
                <div className="h-4 w-1/3 rounded bg-[var(--console-border-soft)]" />
                <div className="mt-2 h-3 w-2/3 rounded bg-[var(--console-border-soft)]" />
              </div>
            ))}
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="rounded-xl bg-[var(--console-card-bg)] p-8 text-center text-sm text-cafe-muted">
            暂无已安装的 Skill
          </div>
        )}

        <div className="space-y-3">
          {items.map((item) => {
            const color = avatarColor(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setPreviewItem(item)}
                className="flex w-full items-center gap-4 rounded-xl bg-[var(--console-card-bg)] p-4 text-left transition-colors hover:bg-[var(--console-card-soft-bg)]"
              >
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                  style={{ backgroundColor: color }}
                >
                  {item.id.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-cafe">{item.id}</p>
                  <p className="mt-0.5 truncate text-xs text-cafe-secondary">{item.description || '—'}</p>
                  {item.category && <p className="mt-0.5 text-[11px] text-cafe-muted">{item.category}</p>}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                    item.enabled
                      ? 'bg-[var(--color-conn-emerald-bg,#ecfdf5)] text-[var(--color-conn-emerald-text,#065f46)]'
                      : 'bg-[var(--console-card-soft-bg)] text-cafe-muted'
                  }`}
                >
                  {item.enabled ? '已启用' : '已禁用'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <aside className="hidden w-[280px] shrink-0 lg:block">
        <div className="rounded-xl bg-[var(--console-card-bg)] p-4">
          <h3 className="text-sm font-bold text-cafe">Skill 市场</h3>
          <p className="mt-1 mb-4 text-xs text-cafe-secondary">
            查询可用 Skill；安装后进入左侧列表。市场永远在右侧 rail，不与数据页混排。
          </p>
          <MarketplacePanel />
        </div>
      </aside>

      {previewItem && (
        <SkillPreviewModal
          skillId={previewItem.id}
          skillName={previewItem.id}
          description={previewItem.description}
          triggers={previewItem.triggers}
          category={previewItem.category}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </div>
  );
}
