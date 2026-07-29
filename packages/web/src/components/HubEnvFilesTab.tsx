'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  ConfigFilesSection,
  DataDirsSection,
  type EnvSaveResponse,
  type EnvSummaryData,
  type EnvVar,
  EnvVarsSection,
  initialDraftValue,
  isEditableVariable,
  isMaskedUrlVariable,
  isSensitiveEditable,
  PageIntro,
} from './settings/EnvSubComponents';
import { SettingsStatusStrip } from './settings/primitives';
import { SystemSettingsView } from './settings/SystemSettingsView';

type StorageMode = 'redis' | 'memory';

interface SystemStatusData {
  storage?: {
    mode?: StorageMode;
    persistent?: boolean;
    warning?: string | null;
  };
}

function normalizeStorageMode(data: SystemStatusData): StorageMode | null {
  const mode = data.storage?.mode;
  return mode === 'redis' || mode === 'memory' ? mode : null;
}

function StorageModeStatus({ mode }: { mode: StorageMode | null }) {
  if (!mode) return null;
  if (mode === 'memory') {
    return <SettingsStatusStrip tone="warn">Memory mode — data will be lost on restart</SettingsStatusStrip>;
  }
  return <SettingsStatusStrip tone="success">Redis persistent mode</SettingsStatusStrip>;
}

interface HubEnvFilesTabProps {
  /**
   * Settings-surface filter.  When `'system'`, the backend returns only the
   * platform-level allowlist (#770).  Unset = all hub-visible vars.
   */
  surface?: 'system';
}

export function HubEnvFilesTab({ surface }: HubEnvFilesTabProps = {}) {
  const [data, setData] = useState<EnvSummaryData | null>(null);
  const [storageMode, setStorageMode] = useState<StorageMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const saveLockRef = useRef(false);
  const [saveState, setSaveState] = useState<{ saving: boolean; error: string | null; success: string | null }>({
    saving: false,
    error: null,
    success: null,
  });

  useEffect(() => {
    const url = surface ? `/api/config/env-summary?surface=${surface}` : '/api/config/env-summary';
    apiFetch(url)
      .then(async (res) => {
        if (res.ok) {
          const body = (await res.json()) as EnvSummaryData;
          setData(body);
          setDrafts(
            Object.fromEntries(
              body.variables.filter(isEditableVariable).map((variable) => [variable.name, initialDraftValue(variable)]),
            ),
          );
        } else {
          setError('环境信息加载失败');
        }
      })
      .catch(() => setError('环境信息加载失败'));
  }, [surface]);

  // Backend already filters when surface is set — derive categories from returned vars
  const visibleCategories = useMemo(() => {
    if (!data) return {};
    const usedCategories = new Set(data.variables.map((v) => v.category));
    return Object.fromEntries(Object.entries(data.categories).filter(([k]) => usedCategories.has(k)));
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/system/status')
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as SystemStatusData;
        if (!cancelled) setStorageMode(normalizeStorageMode(body));
      })
      .catch(() => {
        if (!cancelled) setStorageMode(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>;
  if (!data) return <SettingsStatusStrip tone="muted">加载中...</SettingsStatusStrip>;

  const editableVariables = data.variables.filter(isEditableVariable);
  const changedUpdates = editableVariables
    .map((variable) => ({
      name: variable.name,
      value: drafts[variable.name] ?? '',
      baselineValue: initialDraftValue(variable),
      maskedUrl: isMaskedUrlVariable(variable),
    }))
    .filter((variable) => variable.value !== variable.baselineValue)
    .filter((variable) => !variable.maskedUrl || variable.value.trim().length > 0)
    .map(({ name, value }) => ({ name, value }));

  const isDirty = changedUpdates.length > 0;

  const handleDraftChange = (name: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [name]: value }));
    setSaveState((prev) => ({ ...prev, error: null, success: null }));
  };

  const handleSave = async () => {
    if (saveLockRef.current) return;
    if (!isDirty) {
      setSaveState({ saving: false, error: null, success: '当前没有待写回的变更' });
      return;
    }
    saveLockRef.current = true;
    setSaveState({ saving: true, error: null, success: null });
    try {
      const res = await apiFetch('/api/config/env', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: changedUpdates }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<EnvSaveResponse> & { error?: string };
      if (!res.ok) {
        setSaveState({ saving: false, error: body.error ?? '保存失败', success: null });
        return;
      }
      // #770 P1 fix: re-fetch with surface filter to preserve System allowlist.
      // PATCH /api/config/env returns buildEnvSummary() (unfiltered), so using
      // body.summary directly would expose non-system vars on the System page.
      // Refresh is best-effort: save already succeeded, so network errors here
      // must NOT propagate to the outer catch which would misleadingly report "保存失败".
      const refreshUrl = surface ? `/api/config/env-summary?surface=${surface}` : '/api/config/env-summary';
      const optimisticUpdate = (): EnvVar[] => {
        const vars = data.variables.map((variable) => {
          const update = changedUpdates.find((item) => item.name === variable.name);
          if (!update) return variable;
          if (isSensitiveEditable(variable)) {
            return { ...variable, currentValue: update.value ? '***' : null };
          }
          return { ...variable, currentValue: update.value || null };
        });
        setData((prev) => (prev ? { ...prev, variables: vars } : prev));
        return vars;
      };
      let nextVariables: EnvVar[];
      try {
        const refreshRes = await apiFetch(refreshUrl);
        if (refreshRes.ok) {
          const refreshBody = (await refreshRes.json()) as EnvSummaryData;
          setData(refreshBody);
          nextVariables = refreshBody.variables;
        } else {
          nextVariables = optimisticUpdate();
        }
      } catch {
        // Network error on refresh — save already succeeded, use optimistic fallback.
        nextVariables = optimisticUpdate();
      }
      setDrafts(
        Object.fromEntries(
          nextVariables.filter(isEditableVariable).map((variable) => [variable.name, initialDraftValue(variable)]),
        ),
      );
      setSaveState({ saving: false, error: null, success: '已写回 .env 并刷新摘要；部分变量需重启相关服务生效' });
    } catch {
      setSaveState({ saving: false, error: '保存失败', success: null });
    } finally {
      saveLockRef.current = false;
    }
  };

  const envSection =
    surface === 'system' ? (
      <SystemSettingsView
        variables={data.variables}
        drafts={drafts}
        isDirty={isDirty}
        saveState={saveState}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
      />
    ) : (
      <EnvVarsSection
        categories={visibleCategories}
        variables={data.variables}
        drafts={drafts}
        isDirty={isDirty}
        saveState={saveState}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
      />
    );

  return (
    <div className="space-y-4">
      <PageIntro />
      <StorageModeStatus mode={storageMode} />
      {envSection}
      <ConfigFilesSection projectRoot={data.paths.projectRoot} />
      <DataDirsSection dataDirs={data.paths.dataDirs} projectRoot={data.paths.projectRoot} />
    </div>
  );
}
