'use client';
import type { HubCatEditorFormState } from './hub-cat-editor.model';
import { SelectField, TextAreaField, TextField } from './hub-cat-editor-fields';

export function AgyNativeFields({
  form,
  onChange,
}: {
  form: HubCatEditorFormState;
  onChange: (patch: Partial<HubCatEditorFormState>) => void;
}) {
  return (
    <div className="space-y-2" data-testid="agy-native-settings">
      <SelectField
        label="启用 Native"
        value={form.agyProfileEnabled === false ? 'false' : 'true'}
        options={[
          { value: 'true', label: '开启' },
          { value: 'false', label: '暂停' },
        ]}
        onChange={(value) => onChange({ agyProfileEnabled: value === 'true' })}
      />
      <TextField
        label="隔离 Profile ID"
        value={form.agyProfileId ?? form.catId}
        onChange={(value) => onChange({ agyProfileId: value })}
        required
        placeholder="gemini38"
      />
      <TextField
        label="Profile 根目录"
        value={form.agyHomeRoot ?? ''}
        onChange={(value) => onChange({ agyHomeRoot: value })}
        placeholder="留空使用 ~/.cat-cafe/agy-profiles"
      />
      <TextAreaField
        label="批准工作区"
        value={form.agyTrustedWorkspaces ?? ''}
        onChange={(value) => onChange({ agyTrustedWorkspaces: value })}
        placeholder="每行一个完整的工作区绝对路径"
      />
      <p className="text-xs leading-5 text-cafe-secondary">
        使用此隔离 Profile 中已登录的个人 OAuth。Model 填实际 ID（如 gemini-3.8-flash-high）。 首次使用前需完成该
        Profile 的登录；保存设置不会启动模型。
      </p>
      <p className="text-xs leading-5 text-cafe-muted">
        默认只读，不能在此开启自动批准或写入权限。更换 Profile、模型、账号或批准工作区会撤销原 coding 授权。
      </p>
    </div>
  );
}
