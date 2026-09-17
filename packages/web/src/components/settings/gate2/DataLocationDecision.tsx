import { DirPickerField } from '../DirPickerField';
import { SettingsPrimaryButton, SettingsStatusStrip } from '../primitives';
import { type DecisionMessage, DecisionRow } from './DecisionRow';

export function DataLocationDecision({
  draft,
  effective,
  initialized,
  message,
  onDraftChange,
  onSave,
}: {
  draft: string;
  effective: string;
  initialized: boolean;
  message: DecisionMessage | null;
  onDraftChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <DecisionRow label="数据存放位置" restart>
      <div className="flex items-center gap-2">
        <DirPickerField value={draft} onChange={onDraftChange} placeholder="默认位置" aria-label="数据存放位置" />
        <SettingsPrimaryButton onClick={onSave} disabled={!initialized || draft.trim() === effective.trim()}>
          保存
        </SettingsPrimaryButton>
      </div>
      {message && (
        <div className="mt-1">
          <SettingsStatusStrip tone={message.tone}>{message.text}</SettingsStatusStrip>
        </div>
      )}
    </DecisionRow>
  );
}
