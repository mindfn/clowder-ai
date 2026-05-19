'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface ClientProviderInfo {
  clientId: string;
  label: string;
  protocol: string;
  needsCommandConfig: boolean;
  installed: boolean | null;
  version: string | null;
  hasApiKey: boolean | null;
}

interface ClientProvidersState {
  providers: ClientProviderInfo[];
  loading: boolean;
}

let cachedProviders: ClientProviderInfo[] | null = null;

export function useClientProviders(): ClientProvidersState {
  const [state, setState] = useState<ClientProvidersState>({
    providers: cachedProviders ?? [],
    loading: cachedProviders === null,
  });

  useEffect(() => {
    if (cachedProviders) return;
    let cancelled = false;
    apiFetch('/api/cats/client-providers')
      .then((res) => res.json())
      .then((data: { providers: ClientProviderInfo[] }) => {
        if (cancelled) return;
        cachedProviders = data.providers;
        setState({ providers: data.providers, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
