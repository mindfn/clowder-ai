// Shared model resolver: pick the right model id to inject into a sidecar's
// env. Single source of truth so /api/services/:id/start, install endpoint's
// auto-start branch, AND autostart all behave identically — historically
// autostart only honored cfg.selectedModel and didn't fall back to the matrix
// default, so a legacy enabled+installed service with no selectedModel would
// fail to start under autostart even though the same service starts fine via
// console (which uses the matrix fallback).
//
// Priority: explicit body.model (caller-side) > stored cfg.selectedModel >
// matrix recommendation default. Returns undefined only if nothing yields a
// validating id; callers can decide to error out (server scripts are now
// fail-fast on missing env, so undefined will surface a clear error).

import { getEnvironmentProfile } from './environment-detector.js';
import { buildRecommendation } from './recommendation-matrix.js';
import { getServiceConfig } from './service-config.js';
import { isValidModelId } from './service-logs.js';

export function resolveSelectedModel(serviceId: string, manifestId: string): string | undefined {
  const cfg = getServiceConfig(serviceId);
  if (cfg.selectedModel && isValidModelId(cfg.selectedModel)) return cfg.selectedModel;
  try {
    const profile = getEnvironmentProfile();
    const rec = buildRecommendation(manifestId, profile);
    const fallback = rec.models[0]?.name;
    if (fallback && isValidModelId(fallback)) return fallback;
  } catch {
    /* env detector failure shouldn't block start — let the script handle it */
  }
  return undefined;
}
