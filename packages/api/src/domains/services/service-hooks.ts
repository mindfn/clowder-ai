// Event-driven service readiness hooks.
// Consumers register "when service X becomes healthy, do Y" callbacks instead
// of polling on their own. Hooks fire exactly once per service per process
// startup; late registration after the service is already ready still fires.

type ServiceReadyHook = (serviceId: string) => Promise<void> | void;

const hooks = new Map<string, ServiceReadyHook[]>();
const alreadyReady = new Set<string>();

/**
 * Register a callback to run when the named service becomes healthy.
 * If the service is already healthy, the callback runs on the next tick.
 */
export function onServiceReady(serviceId: string, hook: ServiceReadyHook): void {
  if (!hooks.has(serviceId)) hooks.set(serviceId, []);
  hooks.get(serviceId)?.push(hook);

  if (alreadyReady.has(serviceId)) {
    queueMicrotask(() => {
      void runHook(serviceId, hook);
    });
  }
}

/**
 * Fire all registered hooks for a service. Idempotent — calling twice with the
 * same serviceId just marks the service as "ready" so late registrations still
 * trigger; existing hooks are not re-fired.
 */
export async function fireServiceReady(serviceId: string): Promise<void> {
  const firstTime = !alreadyReady.has(serviceId);
  alreadyReady.add(serviceId);
  if (!firstTime) return;

  const list = hooks.get(serviceId) ?? [];
  for (const hook of list) {
    await runHook(serviceId, hook);
  }
}

/** Test-only — reset hook state between test cases. */
export function _resetServiceHooks(): void {
  hooks.clear();
  alreadyReady.clear();
}

async function runHook(serviceId: string, hook: ServiceReadyHook): Promise<void> {
  try {
    await hook(serviceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[service-hooks] ${serviceId} ready-hook failed: ${msg}`);
  }
}
