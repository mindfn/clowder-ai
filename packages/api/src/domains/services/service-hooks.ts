// Event-driven service readiness hooks.
// Consumers register "when service X becomes healthy, do Y" callbacks instead
// of polling on their own.
//
// Lifecycle policy:
//   • Each hook runs at most once per process startup per service.
//   • On success → the hook is unregistered (removed from the map). Re-firing
//     the same service won't re-run it.
//   • On throw   → the hook stays registered so a future re-fire (e.g. API
//     restart that re-detects the sidecar as healthy) can retry it.
//   • Late registration (hook added after fire) — if all previously registered
//     hooks have already succeeded for this service, the new hook fires on
//     the next microtask; otherwise it waits for the next fire.

type ServiceReadyHook = (serviceId: string) => Promise<void> | void;

const hooks = new Map<string, ServiceReadyHook[]>();
// Per-service "we've seen this service become ready at least once" flag.
// Used so a late-registered hook can fire immediately if the service is
// already up — but only when there are no still-pending (previously-failed)
// hooks; otherwise the next fire-cycle picks it up alongside the retries.
const alreadyReady = new Set<string>();

/**
 * Register a callback to run when the named service becomes healthy.
 * If the service is already healthy AND no prior hooks are pending retry,
 * the callback runs on the next microtask.
 */
export function onServiceReady(serviceId: string, hook: ServiceReadyHook): void {
  if (!hooks.has(serviceId)) hooks.set(serviceId, []);
  hooks.get(serviceId)?.push(hook);

  // Already-ready + no pending retries → fire this late-comer right away.
  if (alreadyReady.has(serviceId)) {
    const pending = hooks.get(serviceId) ?? [];
    if (pending.length === 1) {
      // The only entry is the one we just pushed → safe to fire immediately
      queueMicrotask(() => {
        void fireServiceReady(serviceId);
      });
    }
    // If pending.length > 1, there are previously-failed hooks waiting —
    // the next external fireServiceReady() call will pick this one up too.
  }
}

/**
 * Fire all registered hooks for a service. Runs each hook; successful hooks
 * are unregistered, failed ones stay so the next fire-cycle retries them.
 *
 * Calling twice with the same serviceId is safe:
 *   • If all hooks succeeded last time, the map is empty → no-op.
 *   • If some failed, the next call retries the leftovers (and any
 *     new late-registered hooks).
 */
export async function fireServiceReady(serviceId: string): Promise<void> {
  alreadyReady.add(serviceId);

  const list = hooks.get(serviceId) ?? [];
  if (list.length === 0) return;

  // Snapshot before iterating — late registrations during a hook run will
  // be picked up by the next fire-cycle, not this one (avoids surprising
  // mid-iteration mutations).
  const snapshot = [...list];
  const survivors: ServiceReadyHook[] = [];

  for (const hook of snapshot) {
    const ok = await runHook(serviceId, hook);
    if (!ok) {
      // Failure → keep registered for the next fire-cycle.
      survivors.push(hook);
    }
    // Success → silently dropped (= unregistered).
  }

  if (survivors.length > 0) {
    hooks.set(serviceId, survivors);
  } else {
    hooks.delete(serviceId);
  }
}

/** Test-only — reset hook state between test cases. */
export function _resetServiceHooks(): void {
  hooks.clear();
  alreadyReady.clear();
}

/** Returns true if hook succeeded, false if it threw. */
async function runHook(serviceId: string, hook: ServiceReadyHook): Promise<boolean> {
  try {
    await hook(serviceId);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[service-hooks] ${serviceId} ready-hook failed: ${msg} (will retry on next fire)`);
    return false;
  }
}
