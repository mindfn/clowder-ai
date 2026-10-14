'use client';

import { apiFetch } from '@/utils/api-client';
import {
  buildCatPatchPayload,
  buildCatPayload,
  buildCodexConfigPatches,
  buildStrategyPayload,
  initialState,
  withDefaultModelMentionPattern,
} from './hub-cat-editor.model';
import type { HubCatEditorProps } from './hub-cat-editor.types';
import { requiredHubCatFields } from './hub-cat-editor-required';
import { useHubCatEditorData } from './useHubCatEditorData';

export async function saveHubCatEditor(props: HubCatEditorProps, data: ReturnType<typeof useHubCatEditorData>) {
  const { cat, onClose, onSaved } = props;
  const {
    form,
    strategyForm,
    strategyBaseline,
    strategyBaselineHasOverride,
    codexSettings,
    codexSettingsBaseline,
    selectedProfile,
    originalProfile,
    showCodexSettings,
    setFieldErrors,
    setError,
    setSaving,
  } = data;

  const { errors, errorMessages } = cat
    ? { errors: {}, errorMessages: [] }
    : requiredHubCatFields(form, selectedProfile, props.presentation === 'page');
  if (Object.keys(errors).length > 0) {
    setFieldErrors(errors);
    setError(props.presentation === 'page' ? null : `请填写必填字段：${errorMessages.join('、')}`);
    return;
  }
  setFieldErrors({});
  setSaving(true);
  setError(null);
  const rollbackSteps: Array<() => Promise<void>> = [];
  const rollbackMutations = async () => {
    for (const rollback of rollbackSteps.reverse()) {
      await rollback().catch(() => {});
    }
  };
  try {
    const effectiveForm = !cat && selectedProfile?.authType === 'api_key' ? withDefaultModelMentionPattern(form) : form;
    const payloadContext = { accountAuthType: selectedProfile?.authType ?? null };
    const catPayload = cat
      ? buildCatPatchPayload(effectiveForm, cat, payloadContext)
      : buildCatPayload(effectiveForm, cat, payloadContext);
    const rollbackCatPayload = cat
      ? cat.identityProtection?.kind === 'builtin-cloud'
        ? buildCatPatchPayload(initialState(cat, null), cat, {
            accountAuthType: originalProfile?.authType ?? null,
            forceServiceTier: true,
          })
        : buildCatPayload(initialState(cat, null), cat, {
            accountAuthType: originalProfile?.authType ?? null,
            forceServiceTier: true,
          })
      : null;
    const strategyEditable = Boolean(cat && strategyForm);
    const nextStrategyPayload = strategyEditable && strategyForm ? buildStrategyPayload(strategyForm) : null;
    const baselineStrategyPayload =
      strategyEditable && strategyBaseline ? buildStrategyPayload(strategyBaseline) : null;
    const strategyChanged =
      cat && nextStrategyPayload && strategyEditable
        ? JSON.stringify(nextStrategyPayload) !== JSON.stringify(baselineStrategyPayload)
        : false;

    if (cat && strategyChanged && nextStrategyPayload) {
      const strategyRes = await apiFetch(`/api/config/session-strategy/${cat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextStrategyPayload),
      });
      if (!strategyRes.ok) {
        const payload = (await strategyRes.json().catch(() => ({}))) as Record<string, unknown>;
        setError((payload.error as string) ?? `Session 策略保存失败 (${strategyRes.status})`);
        return;
      }
      if (strategyBaselineHasOverride && baselineStrategyPayload) {
        rollbackSteps.push(async () => {
          await apiFetch(`/api/config/session-strategy/${cat.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baselineStrategyPayload),
          });
        });
      } else {
        rollbackSteps.push(async () => {
          await apiFetch(`/api/config/session-strategy/${cat.id}`, {
            method: 'DELETE',
          });
        });
      }
    }

    const res = await apiFetch(cat ? `/api/cats/${cat.id}` : '/api/cats', {
      method: cat ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(catPayload),
    });
    if (!res.ok) {
      await rollbackMutations();
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError((payload.error as string) ?? `保存失败 (${res.status})`);
      return;
    }
    const persistedCatBody = (await res.json().catch(() => ({}))) as { cat?: { id?: string } };
    const persistedCatId = persistedCatBody.cat?.id ?? cat?.id ?? null;
    if (persistedCatId) {
      if (cat && rollbackCatPayload) {
        rollbackSteps.push(async () => {
          await apiFetch(`/api/cats/${persistedCatId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rollbackCatPayload),
          });
        });
      } else if (!cat) {
        rollbackSteps.push(async () => {
          await apiFetch(`/api/cats/${persistedCatId}`, {
            method: 'DELETE',
          });
        });
      }
    }

    if (showCodexSettings && codexSettings && codexSettingsBaseline) {
      const codexPatches = buildCodexConfigPatches(codexSettings, codexSettingsBaseline);
      const rollbackCodexPatches = buildCodexConfigPatches(codexSettingsBaseline, codexSettings);
      const appliedConfigPatchKeys: string[] = [];
      for (const patch of codexPatches) {
        const configRes = await apiFetch('/api/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!configRes.ok) {
          const appliedRollbackPatches = rollbackCodexPatches.filter((rollbackPatch) =>
            appliedConfigPatchKeys.includes(rollbackPatch.key),
          );
          for (const rollbackPatch of appliedRollbackPatches.reverse()) {
            await apiFetch('/api/config', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(rollbackPatch),
            }).catch(() => {});
          }
          await rollbackMutations();
          const payload = (await configRes.json().catch(() => ({}))) as Record<string, unknown>;
          setError((payload.error as string) ?? `Codex 运行参数保存失败 (${configRes.status})`);
          return;
        }
        appliedConfigPatchKeys.push(patch.key);
      }
    }

    await onSaved();
    window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'member-editor.profile' } }));
    onClose();
  } catch (err) {
    await rollbackMutations();
    setError(err instanceof Error ? err.message : '保存失败');
  } finally {
    setSaving(false);
  }
}
