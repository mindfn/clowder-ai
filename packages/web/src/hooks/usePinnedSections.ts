'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'cat-cafe:pinned-settings-sections';
const SEEDED_DEFAULTS_KEY = 'cat-cafe:pinned-settings-sections:seeded-defaults';
const LEGACY_DEFAULTS_SEED_KEY = 'cat-cafe:pinned-settings-sections:defaults-seeded';
const LEGACY_DESKTOP_SEED_KEY = 'cat-cafe:pinned-settings-sections:desktop-seeded';
const SYNC_EVENT = 'cat-cafe:pinned-settings-sync';
const MAX_PINS = 8;
const DEFAULT_PINS = ['members', 'accounts'] as const;

function read(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function writeAndBroadcast(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

function readSeededDefaults(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEDED_DEFAULTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(DEFAULT_PINS.filter((id) => parsed.includes(id)));
  } catch {
    return new Set();
  }
}

function writeSeededDefaults(ids: ReadonlySet<string>) {
  localStorage.setItem(SEEDED_DEFAULTS_KEY, JSON.stringify(DEFAULT_PINS.filter((id) => ids.has(id))));
}

function readWithDefaults(): string[] {
  const current = read();
  if (typeof window === 'undefined') return current;

  try {
    // Seed through the same persisted pin list used by manual pin/unpin actions.
    // Clearing site data establishes a fresh local install; cross-device preference
    // sync is outside this browser-profile contract.
    const hasLegacyCompleteReceipt =
      localStorage.getItem(LEGACY_DEFAULTS_SEED_KEY) === '1' || localStorage.getItem(LEGACY_DESKTOP_SEED_KEY) === '1';
    const seeded = hasLegacyCompleteReceipt ? new Set<string>(DEFAULT_PINS) : readSeededDefaults();
    let receiptChanged = hasLegacyCompleteReceipt;

    const next = [...current];
    for (const id of DEFAULT_PINS) {
      if (seeded.has(id)) continue;
      if (next.includes(id)) {
        seeded.add(id);
        receiptChanged = true;
        continue;
      }
      if (next.length < MAX_PINS) {
        next.push(id);
        seeded.add(id);
        receiptChanged = true;
      }
    }

    if (next.length !== current.length) writeAndBroadcast(next);
    if (receiptChanged) writeSeededDefaults(seeded);
    return next;
  } catch {
    return current;
  }
}

export function usePinnedSections() {
  const [pinned, setPinned] = useState<readonly string[]>([]);

  useEffect(() => {
    setPinned(readWithDefaults());
    const refresh = () => setPinned(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(SYNC_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SYNC_EVENT, refresh);
    };
  }, []);

  const pin = useCallback((id: string) => {
    setPinned((prev) => {
      if (prev.includes(id) || prev.length >= MAX_PINS) return prev;
      const next = [...prev, id];
      writeAndBroadcast(next as string[]);
      return next;
    });
  }, []);

  const unpin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = prev.filter((x) => x !== id);
      writeAndBroadcast(next as string[]);
      return next;
    });
  }, []);

  const isPinned = useCallback((id: string) => pinned.includes(id), [pinned]);

  return { pinned, pin, unpin, isPinned } as const;
}
