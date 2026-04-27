import type React from 'react';

export interface KVPair {
  key: string;
  value: string;
}

export function kvToObj(pairs: KVPair[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const p of pairs) {
    if (p.key.trim()) obj[p.key.trim()] = p.value;
  }
  return obj;
}

export function FormSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-[var(--console-border-soft)] overflow-hidden rounded-xl bg-[var(--console-card-bg)]">
      {children}
    </div>
  );
}

export function FormItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <p className="mb-2 text-xs font-medium text-cafe-secondary">{label}</p>
      {children}
    </div>
  );
}

export function DynamicList({
  values,
  placeholder,
  onChange,
  addLabel,
}: {
  values: string[];
  placeholder: string;
  onChange: (v: string[]) => void;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {values.map((val, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={val}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
            placeholder={placeholder}
            className="console-form-input flex-1"
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="text-xs text-cafe-muted transition-colors hover:text-red-400"
            title="删除"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className="w-full rounded-lg bg-[var(--console-card-soft-bg)] py-2 text-xs text-cafe-secondary transition-colors hover:text-cafe"
      >
        + 添加{addLabel}
      </button>
    </div>
  );
}

export function DynamicKVList({
  pairs,
  onChange,
  addLabel,
}: {
  pairs: KVPair[];
  onChange: (p: KVPair[]) => void;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {pairs.map((pair, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={pair.key}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...next[i], key: e.target.value };
              onChange(next);
            }}
            placeholder="键"
            className="console-form-input flex-1"
          />
          <input
            type="text"
            value={pair.value}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...next[i], value: e.target.value };
              onChange(next);
            }}
            placeholder="值"
            className="console-form-input flex-1"
          />
          <button
            type="button"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            className="text-xs text-cafe-muted transition-colors hover:text-red-400"
            title="删除"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
        className="w-full rounded-lg bg-[var(--console-card-soft-bg)] py-2 text-xs text-cafe-secondary transition-colors hover:text-cafe"
      >
        + 添加{addLabel}
      </button>
    </div>
  );
}
