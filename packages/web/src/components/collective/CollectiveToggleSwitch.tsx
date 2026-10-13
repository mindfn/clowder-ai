'use client';

export function CollectiveToggleSwitch({
  checked,
  disabled,
  label,
  describedBy,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly describedBy?: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-describedby={describedBy}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cafe-accent)] disabled:opacity-50 ${
        checked
          ? 'border-[var(--cafe-text)] bg-[var(--cafe-text)]'
          : 'border-[var(--console-border-soft)] bg-[var(--console-border-soft)]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`block h-3.5 w-3.5 rounded-full bg-[var(--console-card-bg)] transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
