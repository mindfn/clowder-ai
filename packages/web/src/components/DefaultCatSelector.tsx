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

/**
 * F154 Phase B (AC-B2): Dropdown for choosing the global default responder cat.
 * clowder-ai#543: Migrated from card grid to dropdown for scalability.
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
  const valueInList = currentDefaultCatId && cats.some((c) => c.id === currentDefaultCatId);

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-[var(--console-card-soft-bg)] px-4 py-3"
      data-testid="default-cat-selector"
    >
      <div className="min-w-[14rem]">
        <h3 className="text-sm font-bold text-cafe-black">全局默认猫</h3>
        <p className="text-[11px] text-cafe-muted mt-0.5">新 thread 没有历史时，默认由这只猫回复</p>
      </div>
      {fetchError && (
        <div className="flex items-center gap-2 text-xs text-conn-amber-text bg-conn-amber-bg rounded-lg px-3 py-2">
          <span>加载失败，当前默认猫未知</span>
          {onRetry && (
            <button
              type="button"
              data-testid="retry-fetch"
              onClick={onRetry}
              className="text-conn-amber-text font-medium underline hover:opacity-90"
            >
              重试
            </button>
          )}
        </div>
      )}
      {saveError && <div className="text-xs text-conn-red-text bg-conn-red-bg rounded-lg px-3 py-2">{saveError}</div>}
      <div className="flex min-w-[18rem] flex-1 items-center gap-2">
        {currentCat && (
          <span
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: currentCat.color.primary }}
            data-testid="selected-color-dot"
          />
        )}
        <select
          data-testid="default-cat-select"
          value={valueInList ? currentDefaultCatId : ''}
          disabled={isLoading}
          onChange={(e) => onSelect(e.target.value)}
          className={`h-10 flex-1 rounded-[10px] border-0 bg-[var(--console-card-bg)] px-3 text-sm text-cafe-black shadow-[0_4px_14px_rgba(43,33,26,0.04)]
            focus:outline-none focus:ring-2 focus:ring-cafe-accent/25
            ${isLoading ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
        >
          {!valueInList && (
            <option value="" disabled>
              {currentDefaultCatId ? '当前默认猫不可用' : '请选择默认猫'}
            </option>
          )}
          {cats.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {formatCatName(cat)}
              {cat.nickname ? ` (${cat.nickname})` : ''}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
