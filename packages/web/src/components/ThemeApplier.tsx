/*
 * F056 ThemeApplier — bridges the theme store to next-themes + CSS injection
 *
 * Subscribes to the theme store and:
 * 1. Sets `data-theme` via next-themes when the active theme's base changes
 * 2. Injects CSS overrides from the active theme's params
 *
 * Must live inside <ThemeProvider> (next-themes context).
 */
'use client';

import { useEffect } from 'react';
import { useCafeTheme } from '@/hooks/useCafeTheme';
import { applyThemeCSS, getActiveTheme, useThemeStore } from '@/stores/themeStore';

export function ThemeApplier() {
  const { setTheme } = useCafeTheme();
  const active = useThemeStore((s) => getActiveTheme(s));

  /* Sync base mode to next-themes (manages data-theme attribute on <html>) */
  useEffect(() => {
    setTheme(active.base);
  }, [active.base, setTheme]);

  /* Inject CSS overrides for the active theme's OKLCH params */
  useEffect(() => {
    applyThemeCSS(active.params);
  }, [active.params]);

  return null;
}
