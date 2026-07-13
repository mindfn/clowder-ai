// F257: Approval-executor minimal surface — operator-gated hook override management.
// KD-14 审批执行器 first leg: the execute path for approved segment-patch trials
// (five-ring: candidate → operator approve → THIS ROUTE → behavior diff → verify).
//
// Auth mirrors trigger-now (eval-hub.ts): session + connector-write network/owner
// gates — mutating live prompt segments is privilege-equivalent to waking eval
// cats (cloud codex R9 P1 precedent). The store's own three-axis gates
// (safetyTier / disableable / unknown-hook) stay authoritative; this route only
// transports and maps OverrideGateError to HTTP.
//
// GET list doubles as the read API for the Phase D lifeline view (KD-19).
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  requireConnectorWriteNetworkGuard,
  requireConnectorWriteOwner,
} from '../config/connector-secret-write-guards.js';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import { OverrideGateError } from '../domains/prompt-hooks/HookOverrideStore.js';

export interface PromptInjectionOverrideRoutesOptions {
  /** Undefined when redis is absent — routes answer 503 (observability infra off). */
  overrideStore: HookOverrideStore | undefined;
}

const ACTIONS = ['enable', 'disable', 'rollback'] as const;
type OverrideAction = (typeof ACTIONS)[number];

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

/** Session + connector-write network/owner gates for the mutating surface. */
function requireWriteAuth(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = requireSession(request, reply);
  if (!userId) return null;
  const networkError = requireConnectorWriteNetworkGuard(request);
  if (networkError) {
    reply.status(networkError.status).send({ error: networkError.error });
    return null;
  }
  const ownerError = requireConnectorWriteOwner(userId);
  if (ownerError) {
    reply.status(ownerError.status).send({ error: ownerError.error });
    return null;
  }
  return userId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Dispatch an approved action to the store — gates live in the store, not here. */
async function executeOverrideAction(
  store: HookOverrideStore,
  action: OverrideAction,
  hookId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const actionOpts = { source: 'operator' as const, reason };
  if (action === 'enable') return store.enable(hookId, userId, actionOpts);
  if (action === 'disable') return store.disable(hookId, userId, actionOpts);
  return store.rollback(hookId, userId, actionOpts);
}

/**
 * Parse the untrusted request body. Non-record bodies and non-string fields
 * map to 400, never 500 (terra P2: this is an operator-facing trust boundary).
 */
function parseOverrideBody(raw: unknown): { action: OverrideAction; reason: string } | { error: string } {
  const body = isRecord(raw) ? raw : {};
  const action = body.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return { error: `action must be one of: ${ACTIONS.join(' | ')}` };
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return { error: 'reason is required (audit trail)' };
  }
  return { action: action as OverrideAction, reason };
}

export const promptInjectionOverrideRoutes: FastifyPluginAsync<PromptInjectionOverrideRoutesOptions> = async (
  app,
  opts,
) => {
  // Read surface: current overrides (lifeline "治理" nodes come from here + event stream).
  app.get('/api/prompt-hooks/overrides', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;
    if (!opts.overrideStore) {
      return reply.status(503).send({ error: 'override store unavailable (redis off)' });
    }
    const overrides = await opts.overrideStore.listOverrides();
    return reply.send({ overrides });
  });

  // Write surface: execute an approved action. reason is REQUIRED — every
  // operator action must carry a why (audit trail feeds the lifeline view).
  app.post('/api/prompt-hooks/:hookId/override', async (request, reply) => {
    const userId = requireWriteAuth(request, reply);
    if (!userId) return;
    if (!opts.overrideStore) {
      return reply.status(503).send({ error: 'override store unavailable (redis off)' });
    }

    const { hookId } = request.params as { hookId: string };
    const parsed = parseOverrideBody(request.body);
    if ('error' in parsed) {
      return reply.status(400).send({ error: parsed.error });
    }

    const store = opts.overrideStore;
    try {
      await executeOverrideAction(store, parsed.action, hookId, userId, parsed.reason);
      const override = await store.getOverride(hookId);
      return reply.send({ ok: true, hookId, action: parsed.action, override });
    } catch (err) {
      if (err instanceof OverrideGateError) {
        // unknown-hook = addressing error (404); policy gates = manifest conflict (409).
        const status = err.gate === 'unknown-hook' ? 404 : 409;
        return reply.status(status).send({ error: err.message, gate: err.gate, hookId: err.hookId });
      }
      throw err;
    }
  });
};
