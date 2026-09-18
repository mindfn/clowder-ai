'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'cat-cafe:pinned-settings-sections';
const DESKTOP_SEED_KEY = 'cat-cafe:pinned-settings-sections:desktop-seeded';
const SYNC_EVENT = 'cat-cafe:pinned-settings-sync';
const MAX_PINS = 8;
const DESKTOP_DEFAULT_PINS = ['members', 'accounts'] as const;

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

function readWithDesktopDefaults(): string[] {
  const current = read();
  if (typeof window === 'undefined' || !window.desktopBridge) return current;

  try {
    // The seed receipt intentionally follows the packaged app's local profile.
    // Clearing site data or moving to another device establishes a fresh install;
    // cross-device preference sync is outside this local-only settings contract.
    if (localStorage.getItem(DESKTOP_SEED_KEY) === '1') return current;

    const next = [...current];
    for (const id of DESKTOP_DEFAULT_PINS) {
      if (!next.includes(id) && next.length < MAX_PINS) next.push(id);
    }

    if (next.length !== current.length) writeAndBroadcast(next);
    if (DESKTOP_DEFAULT_PINS.every((id) => next.includes(id))) {
      localStorage.setItem(DESKTOP_SEED_KEY, '1');
    }
    return next;
  } catch {
    return current;
  }
}

export function usePinnedSections() {
  const [pinned, setPinned] = useState<readonly string[]>([]);

  useEffect(() => {
    setPinned(readWithDesktopDefaults());
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
