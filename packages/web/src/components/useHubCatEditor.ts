'use client';

import { useEffect, useRef } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { TemplateCard } from './first-run-quest/TemplateStep';
import { uploadAvatarAsset, uploadRefAudioAsset } from './hub-cat-editor.client';
import {
  autoSlug,
  type CodexRuntimeSettings,
  type HubCatEditorFormState,
  initialState,
  joinTags,
  normalizeMentionPattern,
  type StrategyFormState,
  toCodexRuntimeSettings,
} from './hub-cat-editor.model';
import type { HubCatEditorProps } from './hub-cat-editor.types';
import { useMembersCopy } from './members/editor-presentation';
import { saveHubCatEditor } from './saveHubCatEditor';
import { readApiError } from './settings/settings-utils';
import { useConfirm } from './useConfirm';
import { useHubCatEditorData } from './useHubCatEditorData';

export function useHubCatEditor(props: HubCatEditorProps) {
  const { onClose, onSaved } = props;
  const confirm = useConfirm();
  const copy = useMembersCopy();
  const data = useHubCatEditorData(props);
  const baseline = useRef(data.form);
  useEffect(() => {
    if (!data.hasUnsavedChanges) baseline.current = data.form;
  }, [data.form, data.hasUnsavedChanges]);
  const dirtyCount =
    Object.keys(data.form).filter(
      (key) =>
        key !== 'displayName' &&
        JSON.stringify(data.form[key as keyof HubCatEditorFormState]) !==
          JSON.stringify(baseline.current[key as keyof HubCatEditorFormState]),
    ).length +
    (JSON.stringify(data.strategyForm) !== JSON.stringify(data.strategyBaseline) ? 1 : 0) +
    (data.codexSettingsBaseline !== null &&
    JSON.stringify(data.codexSettings) !== JSON.stringify(data.codexSettingsBaseline)
      ? 1
      : 0);
  const discard = () => {
    data.setForm(baseline.current);
    data.setStrategyForm(data.strategyBaseline);
    data.setCodexSettings(data.codexSettingsBaseline);
    data.setHasUnsavedChanges(false);
    data.setError(null);
    data.setFieldErrors({});
  };
  const {
    restoringCloudIdentity,
    hasUnsavedChanges,
    reservedPatterns,
    setForm,
    setFieldErrors,
    setError,
    setSelectedTemplateId,
    setHasUnsavedChanges,
    setRestoringCloudIdentity,
    setUploadingAvatar,
    setStrategyForm,
    setCodexSettings,
  } = data;
  const patchForm = (patch: Partial<HubCatEditorFormState>) => {
    setHasUnsavedChanges(true);
    setForm((prev) => ({ ...prev, ...patch }));
    if (props.presentation === 'page') {
      const fields: Partial<Record<keyof HubCatEditorFormState, string>> = {
        name: 'Name',
        roleDescription: 'Description',
        defaultModel: 'Model',
        provider: 'OC Provider Name',
        mentionPatterns: 'Aliases',
        accountRef: 'Account',
      };
      setFieldErrors((prev) => ({
        ...prev,
        ...Object.fromEntries(
          Object.keys(patch).flatMap((key) =>
            fields[key as keyof HubCatEditorFormState] ? [[fields[key as keyof HubCatEditorFormState], false]] : [],
          ),
        ),
      }));
    }
    if (patch.mentionPatterns !== undefined) {
      setFieldErrors((prev) => ({ ...prev, routing: false }));
    }
    if (patch.name !== undefined || patch.roleDescription !== undefined) {
      setFieldErrors((prev) => ({ ...prev, identity: false }));
    }
    if (patch.defaultModel !== undefined || patch.clientId !== undefined || patch.accountRef !== undefined) {
      setFieldErrors((prev) => ({ ...prev, account: false }));
    }
  };
  const patchStrategy = (patch: Partial<StrategyFormState>) => {
    setHasUnsavedChanges(true);
    setStrategyForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };
  const patchCodex = (patch: Partial<CodexRuntimeSettings>) => {
    setHasUnsavedChanges(true);
    setCodexSettings((prev) => ({
      ...(prev ?? toCodexRuntimeSettings()),
      ...patch,
    }));
  };

  const handleTemplateSelect = (t: TemplateCard | null) => {
    if (!t) {
      setSelectedTemplateId('custom');
      setForm(initialState(null, null));
      setHasUnsavedChanges(false);
      return;
    }
    setSelectedTemplateId(t.id);
    const name = t.name;
    const catId = autoSlug(name);
    // Auto-suffix aliases that conflict with existing cats
    const rawAliases = [t.nickname, name].filter((s): s is string => Boolean(s));
    const deduped = rawAliases.map((alias) => {
      const normalized = normalizeMentionPattern(alias);
      if (!reservedPatterns.has(normalized.toLowerCase())) return normalized;
      for (let i = 2; i <= 99; i++) {
        const candidate = normalizeMentionPattern(`${alias}${i}`);
        if (!reservedPatterns.has(candidate.toLowerCase())) return candidate;
      }
      return normalized; // fallback — backend will catch it
    });
    patchForm({
      name,
      displayName: name,
      nickname: t.nickname ?? '',
      avatar: t.avatar ?? '',
      colorPrimary: t.color.primary,
      colorSecondary: t.color.secondary,
      roleDescription: t.roleDescription,
      personality: t.personality,
      teamStrengths: t.teamStrengths ?? '',
      catId,
      mentionPatterns: joinTags(deduped),
    });
  };

  const requestClose = async () => {
    if (props.presentation === 'page' ? dirtyCount === 0 : !hasUnsavedChanges) {
      onClose();
      return;
    }
    const options =
      props.presentation === 'page'
        ? { title: copy.closeTitle, message: copy.unsavedPrompt, confirmLabel: copy.leave, cancelLabel: copy.取消 }
        : { title: '关闭确认', message: '有未保存的修改，确定要关闭吗？' };
    if (await confirm(options)) onClose();
  };

  const handleAvatarUpload = async (file: File) => {
    setUploadingAvatar(true);
    setError(null);
    try {
      patchForm({ avatar: await uploadAvatarAsset(file) });
    } catch (err) {
      setError(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleRefAudioUpload = async (file: File) => {
    setError(null);
    await uploadRefAudioAsset(file).then(
      (result) => patchForm({ voiceRefAudio: result.url }),
      (err) => setError(err instanceof Error ? err.message : '参考音频上传失败'),
    );
  };

  const handleRestoreBuiltinCloudIdentity = async (catId: string) => {
    if (restoringCloudIdentity) return;
    setRestoringCloudIdentity(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/cats/${catId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restoreBuiltinCloudIdentity: true }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '云端身份恢复失败');
    } finally {
      setRestoringCloudIdentity(false);
    }
  };

  const handleSave = () => saveHubCatEditor(props, data);

  return {
    ...data,
    dirtyCount,
    discard,
    patchForm,
    patchStrategy,
    patchCodex,
    handleTemplateSelect,
    requestClose,
    handleAvatarUpload,
    handleRefAudioUpload,
    handleRestoreBuiltinCloudIdentity,
    handleSave,
  };
}

export type HubCatEditorController = ReturnType<typeof useHubCatEditor>;
