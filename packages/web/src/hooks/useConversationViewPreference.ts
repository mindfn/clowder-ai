'use client';

import {
  type ConversationViewPreference,
  type ConversationViewPreferenceSnapshot,
  conversationViewPreferenceSnapshotSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const PRODUCT_SNAPSHOT: ConversationViewPreferenceSnapshot = {
  stored: null,
  effective: { mode: 'group' },
  source: 'product',
};

function parseSnapshot(value: unknown): ConversationViewPreferenceSnapshot | null {
  const parsed = conversationViewPreferenceSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sameView(left: ConversationViewPreference | null, right: ConversationViewPreference): boolean {
  if (!left || left.mode !== right.mode) return false;
  return left.mode === 'group' || (right.mode === 'cat' && left.catId === right.catId);
}

async function persistConversationView(
  threadId: string,
  view: ConversationViewPreference,
): Promise<ConversationViewPreferenceSnapshot> {
  const response = await apiFetch('/api/config/conversation-view', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, view }),
  });
  if (!response.ok) throw new Error(`conversation view save failed (${response.status})`);
  const parsed = parseSnapshot(await response.json());
  if (!parsed) throw new Error('conversation view response is invalid');
  return parsed;
}

export type ConversationViewPreferenceError = 'load' | 'save' | null;

export interface ConversationViewPreferenceController {
  snapshot: ConversationViewPreferenceSnapshot;
  loading: boolean;
  saving: boolean;
  error: ConversationViewPreferenceError;
  save(view: ConversationViewPreference): Promise<boolean>;
}

export function useConversationViewPreference(threadId: string): ConversationViewPreferenceController {
  const [snapshot, setSnapshot] = useState<ConversationViewPreferenceSnapshot>(PRODUCT_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ConversationViewPreferenceError>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    const abort = new AbortController();
    setSnapshot(PRODUCT_SNAPSHOT);
    setLoading(true);
    setSaving(false);
    setError(null);
    void apiFetch(`/api/config/conversation-view?threadId=${encodeURIComponent(threadId)}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`conversation view load failed (${response.status})`);
        const parsed = parseSnapshot(await response.json());
        if (!parsed) throw new Error('conversation view response is invalid');
        if (generation === generationRef.current) setSnapshot(parsed);
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted || generation !== generationRef.current) return;
        console.error('Failed to load conversation view preference', cause);
        setError('load');
      })
      .finally(() => {
        if (generation === generationRef.current) setLoading(false);
      });
    return () => {
      abort.abort();
      if (generation === generationRef.current) generationRef.current += 1;
    };
  }, [threadId]);

  const save = useCallback(
    async (view: ConversationViewPreference): Promise<boolean> => {
      if (loading || saving) return false;
      if (sameView(snapshot.stored, view)) {
        setError(null);
        return true;
      }
      const generation = generationRef.current;
      setSaving(true);
      setError(null);
      try {
        const parsed = await persistConversationView(threadId, view);
        if (generation !== generationRef.current) return false;
        setSnapshot(parsed);
        return true;
      } catch (cause) {
        if (generation !== generationRef.current) return false;
        console.error('Failed to save conversation view preference', cause);
        setError('save');
        return false;
      } finally {
        if (generation === generationRef.current) setSaving(false);
      }
    },
    [loading, saving, snapshot.stored, threadId],
  );

  return { snapshot, loading, saving, error, save };
}
