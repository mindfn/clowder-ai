import { SettingsStatusStrip } from '../primitives';
import { type DecisionMessage, DecisionRow } from './DecisionRow';

/** Same switch markup as the retired dump view — visual continuity. */
function ToggleSwitch({ on, onToggle, ariaLabel }: { on: boolean; onToggle: () => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 items-center rounded-full ${
        on ? 'bg-conn-emerald-text' : 'bg-cafe-surface-sunken'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-cafe-white transition-transform ${
          on ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export function LanAccessDecision({
  on,
  message,
  onToggle,
}: {
  on: boolean;
  message: DecisionMessage | null;
  onToggle: () => void;
}) {
  return (
    <DecisionRow label="允许局域网访问" restart smallPrint={on ? '可被同一局域网中的任意设备访问' : '仅本地可以访问'}>
      <div className="flex justify-end">
        <ToggleSwitch on={on} onToggle={onToggle} ariaLabel="允许局域网访问" />
      </div>
      {message && (
        <div className="mt-1">
          <SettingsStatusStrip tone={message.tone}>{message.text}</SettingsStatusStrip>
        </div>
      )}
    </DecisionRow>
  );
}
