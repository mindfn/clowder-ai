import type { CatData } from '@/hooks/useCatData';
import { formatCatName } from '@/hooks/useCatData';

interface DefaultCatSelectorProps {
  cats: CatData[];
  currentDefaultCatId: string;
  onSelect: (catId: string) => void;
  isLoading?: boolean;
  /** P1-2: Show error state when GET /api/config/default-cat fails */
  fetchError?: boolean;
  /** P2-1: Show error message when PUT fails */
  saveError?: string | null;
  /** P1-2: Retry fetching default cat */
  onRetry?: () => void;
}

function catLabel(cat: CatData): string {
  const name = formatCatName(cat);
  return cat.nickname ? `${name}（${cat.nickname}）` : name;
}

/**
 * F154 Phase B (AC-B2): Dropdown selector for the global default responder cat.
 * Replaces the card grid (#543) to save vertical space as cat count grows.
 */
export function DefaultCatSelector({
  cats,
  currentDefaultCatId,
  onSelect,
  isLoading,
  fetchError,
  saveError,
  onRetry,
}: DefaultCatSelectorProps) {
  const currentCat = cats.find((c) => c.id === currentDefaultCatId);

  return (
    <div className="rounded-xl border border-cafe bg-cafe-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-cafe-black">全局默认猫</h3>
          <p className="text-[11px] text-cafe-muted mt-0.5">新 thread 没有历史时，默认由这只猫回复</p>
        </div>
      </div>
      {fetchError && (
        <div className="flex items-center gap-2 mb-3 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
          <span>加载失败，当前默认猫未知</span>
          {onRetry && (
            <button
              type="button"
              data-testid="retry-fetch"
              onClick={onRetry}
              className="text-amber-700 font-medium underline hover:text-amber-800"
            >
              重试
            </button>
          )}
        </div>
      )}
      {saveError && <div className="mb-3 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{saveError}</div>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {cats.map((cat) => {
          const isDefault = cat.id === currentDefaultCatId;
          return (
            <button
              key={cat.id}
              type="button"
              data-testid="default-cat-card"
              disabled={isLoading}
              onClick={() => onSelect(cat.id)}
              className={`relative flex items-center gap-2 rounded-lg border p-3 text-left transition-colors ${
                isDefault
                  ? 'border-cafe-accent bg-[var(--console-active-bg)] shadow-[var(--console-shadow-soft)]'
                  : 'border-[var(--console-border-soft)] hover:border-cafe-secondary hover:bg-[var(--console-hover-bg)]'
              } ${isLoading ? 'opacity-50 cursor-wait' : ''}`}
            >
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: cat.color.primary }}
                data-testid="card-color-dot"
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-cafe-black truncate block">{formatCatName(cat)}</span>
                {cat.nickname && <span className="text-[10px] text-cafe-muted">{cat.nickname}</span>}
              </div>
              {isDefault && (
                <span
                  data-testid="default-badge"
                  className="absolute top-1 right-1 rounded-full bg-cafe-accent px-1.5 py-0.5 text-[9px] font-bold text-white"
                >
                  默认
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
