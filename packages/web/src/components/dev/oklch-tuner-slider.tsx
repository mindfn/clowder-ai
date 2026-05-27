/* Shared range slider for OKLCH Tuner sections */

export function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 pl-4">
      <span className="w-5 text-[10px] text-cafe-muted shrink-0">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="flex-1 h-1 accent-[var(--color-cafe-accent)]"
      />
      <span className="w-10 text-right text-[10px] tabular-nums shrink-0">{fmt}</span>
    </div>
  );
}
