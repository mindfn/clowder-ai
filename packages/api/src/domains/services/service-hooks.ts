// Event-driven service hook bus.
//
// Consumers register interest in a specific event on a specific service.
// The service lifecycle layer (service-autostart, install/uninstall routes)
// is the only place that *fires* events. Consumers never poll on their own.
//
// Registration shape:
//   onServiceEvent(serviceId, event, callback, options?)
//
// Lifecycle policy (per callback):
//   • Run at most once per fire-cycle for the registered event.
//   • On success → callback is unregistered (default; opt-out via
//     options.unregisterOnSuccess = false to keep it always-on).
//   • On throw   → callback stays registered so the next fire of the same
//     event retries it.
//   • Late registration: if the event already fired AND no other hooks are
//     pending retry for it, the new hook fires on the next microtask.
//     Otherwise it waits and rides the next external fire-cycle alongside
//     the existing retries.
//
// Adding a new event later: just add to ServiceEvent below; the bus is
// generic. Today the only emitter is "started" (service health probe
// transitioned to running). Future emitters can hook in the same way
// (e.g. install/uninstall routes calling fireServiceEvent(id, 'installed')).

export type ServiceEvent =
  | 'started' // sidecar health probe transitioned to `running`
  | 'stopped' // (reserved) sidecar transitioned away from `running`
  | 'installed' // (reserved) install completed successfully
  | 'uninstalled'; // (reserved) uninstall completed

export interface ServiceEventContext {
  serviceId: string;
  event: ServiceEvent;
}

type ServiceEventHook = (ctx: ServiceEventContext) => Promise<void> | void;

interface RegisterOptions {
  /** Drop the hook from the registry after a successful run. Default true. */
  unregisterOnSuccess?: boolean;
}

interface HookEntry {
  fn: ServiceEventHook;
  unregisterOnSuccess: boolean;
}

const hooks = new Map<string, HookEntry[]>(); // key = `${serviceId}:${event}`
const fired = new Set<string>(); // key = `${serviceId}:${event}` once seen ready

function key(serviceId: string, event: ServiceEvent): string {
  return `${serviceId}:${event}`;
}

/**
 * Register a callback for a specific event on a specific service.
 * The default lifecycle is "fire once on success, retry on failure".
 */
export function onServiceEvent(
  serviceId: string,
  event: ServiceEvent,
  hook: ServiceEventHook,
  options?: RegisterOptions,
): void {
  const k = key(serviceId, event);
  if (!hooks.has(k)) hooks.set(k, []);
  hooks.get(k)?.push({
    fn: hook,
    unregisterOnSuccess: options?.unregisterOnSuccess ?? true,
  });

  // Late-registration fast path: if the event already fired and the new hook
  // is the only entry pending, fire it on the next microtask. If other hooks
  // are queued (= previous retries), the new hook waits and rides the next
  // external fire-cycle alongside them.
  if (fired.has(k)) {
    const pending = hooks.get(k) ?? [];
    if (pending.length === 1) {
      queueMicrotask(() => {
        void fireServiceEvent(serviceId, event);
      });
    }
  }
}

/**
 * Fire all registered hooks for a service/event pair. Successful hooks with
 * unregisterOnSuccess=true (default) are dropped; failed and "always-on"
 * hooks stay registered for future fires.
 */
export async function fireServiceEvent(serviceId: string, event: ServiceEvent): Promise<void> {
  const k = key(serviceId, event);
  fired.add(k);

  const list = hooks.get(k) ?? [];
  if (list.length === 0) return;

  // Snapshot before iteration so late registrations during a hook run get
  // picked up by the next fire-cycle, not this one.
  const snapshot = [...list];
  const survivors: HookEntry[] = [];
  const ctx: ServiceEventContext = { serviceId, event };

  for (const entry of snapshot) {
    let ok = false;
    try {
      await entry.fn(ctx);
      ok = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[service-hooks] ${serviceId}/${event} hook failed: ${msg} (will retry on next fire)`);
    }
    // Survive into the next fire-cycle if:
    //   - the hook threw (retry semantics), OR
    //   - the consumer asked to stay registered after success.
    if (!ok || !entry.unregisterOnSuccess) {
      survivors.push(entry);
    }
  }

  if (survivors.length > 0) {
    hooks.set(k, survivors);
  } else {
    hooks.delete(k);
  }
}

// ─── Backward-compatibility aliases (started event) ───────────────────────
// Older code paths used onServiceReady / fireServiceReady. They map 1:1 to
// the 'started' event so internal callers can migrate at their own pace.

export function onServiceReady(serviceId: string, hook: (id: string) => Promise<void> | void): void {
  onServiceEvent(serviceId, 'started', (ctx) => hook(ctx.serviceId));
}

export async function fireServiceReady(serviceId: string): Promise<void> {
  await fireServiceEvent(serviceId, 'started');
}

/** Test-only — reset hook state between test cases. */
export function _resetServiceHooks(): void {
  hooks.clear();
  fired.clear();
}
