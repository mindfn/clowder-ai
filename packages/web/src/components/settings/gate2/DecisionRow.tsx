import type { ReactNode } from 'react';

export interface DecisionMessage {
  tone: 'error' | 'success';
  text: string;
}

export const selectClass =
  'h-9 w-full rounded-lg border border-transparent bg-[var(--console-field-bg)] px-3 text-compact text-cafe';

export function DecisionRow({
  label,
  restart,
  smallPrint,
  children,
}: {
  label: string;
  restart?: boolean;
  smallPrint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-cafe">
          {label}
          {restart && <span className="ml-1 text-xs font-normal text-cafe-muted">（重启生效）</span>}
        </div>
        {smallPrint && <div className="mt-0.5 text-xs text-cafe-muted leading-5">{smallPrint}</div>}
      </div>
      <div className="min-w-0 max-w-[50%] flex-1">{children}</div>
    </div>
  );
}
