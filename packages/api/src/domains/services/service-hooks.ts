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
const inFlight = new Set<string>(); // key set while fireServiceEvent is dispatching

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

  // Late-registration fast path: if the event already fired AND no
  // fireServiceEvent is currently dispatching for this key, schedule a
  // microtask replay so the just-registered hook catches up. Previously
  // gated on `pending.length === 1`, which incorrectly treated an
  // already-present always-on hook (`unregisterOnSuccess: false`) as a
  // blocker — the new hook would silently wait for a "next external
  // fire" that may never come (codex P2 3249789190). The `inFlight`
  // guard prevents recursive re-fire when a hook registers another hook
  // mid-dispatch — fireServiceEvent's own snapshot-diff late-detect
  // (commit 6fd14749) handles the in-flight case, so we only schedule
  // here for AFTER-dispatch registrations.
  if (fired.has(k) && !inFlight.has(k)) {
    queueMicrotask(() => {
      void fireServiceEvent(serviceId, event);
    });
  }
}

/**
 * Internal: dispatch a specific subset of hooks for a (serviceId, event)
 * pair. The external `fireServiceEvent` calls this with the full current
 * list; the late-registration microtask calls it with ONLY the hooks
 * registered during the previous dispatch, so survivors aren't re-fired.
 */
async function dispatchHooks(serviceId: string, event: ServiceEvent, toFire: HookEntry[]): Promise<void> {
  const k = key(serviceId, event);
  fired.add(k);
  if (toFire.length === 0) return;

  inFlight.add(k);
  try {
    // Capture pre-dispatch state. `preNotFired` lets us preserve hooks
    // that were registered BEFORE this dispatch but aren't ours to fire
    // (an outer survivor when this is a microtask replay). Without this
    // separation, the recursive late-hook microtask would re-fire outer
    // survivors via newList rebuilding.
    const preList = hooks.get(k) ?? [];
    const preSet = new Set(preList);
    const survivors: HookEntry[] = [];
    const ctx: ServiceEventContext = { serviceId, event };

    // Snapshot toFire BEFORE iteration. Callers like fireServiceEvent
    // pass `hooks.get(k)` as a live reference; an in-flight hook that
    // calls onServiceEvent would push to that same array, and the
    // for-of loop would then iterate the new entry — firing the late
    // hook once here AND once via the microtask replay below. Copy to
    // pin the iteration set.
    const toFireSnapshot = [...toFire];

    for (const entry of toFireSnapshot) {
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

    // Reclassify post-dispatch registry into three buckets:
    //   - survivors:      ones WE fired that should stay
    //   - preNotFired:    pre-existing hooks we didn't fire (outer survivors
    //                     when this is a microtask replay)
    //   - lateRegistered: hooks that appeared DURING our dispatch — these
    //                     missed this fire-cycle and need a microtask replay
    const current = hooks.get(k) ?? [];
    const lateRegistered = current.filter((e) => !preSet.has(e));
    // Use snapshot (what we actually fired), not `toFire` — when toFire is
    // a live `hooks.get(k)` reference, it may have been mutated by an
    // in-flight onServiceEvent push and would then incorrectly classify
    // late-registered hooks as "ours to fire".
    const preNotFired = preList.filter((e) => !toFireSnapshot.includes(e));
    const newList = [...survivors, ...preNotFired, ...lateRegistered];

    if (newList.length > 0) {
      hooks.set(k, newList);
    } else {
      hooks.delete(k);
    }

    // Replay ONLY the late-registered hooks. Survivors already ran in this
    // cycle; preNotFired weren't ours to fire. Codex P2 3252047840 — the
    // previous implementation called fireServiceEvent(...) recursively,
    // which re-fired survivors (e.g. always-on hooks with
    // unregisterOnSuccess:false).
    if (lateRegistered.length > 0) {
      queueMicrotask(() => {
        void dispatchHooks(serviceId, event, lateRegistered);
      });
    }
  } finally {
    inFlight.delete(k);
  }
}

/**
 * Fire all registered hooks for a service/event pair. Successful hooks with
 * unregisterOnSuccess=true (default) are dropped; failed and "always-on"
 * hooks stay registered for future fires.
 */
export async function fireServiceEvent(serviceId: string, event: ServiceEvent): Promise<void> {
  const k = key(serviceId, event);
  const list = hooks.get(k) ?? [];
  await dispatchHooks(serviceId, event, list);
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
  inFlight.clear();
}
