import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getEnvironmentProfile } from '../domains/services/environment-detector.js';
import { buildRecommendation } from '../domains/services/recommendation-matrix.js';
import { getServiceConfig } from '../domains/services/service-config.js';
import {
  type FetchServiceHealth,
  getServiceManifest,
  maskServiceEndpoint,
  PORT_ENV_VARS,
  resolveServiceEndpoint,
  resolveServiceEndpointMap,
  resolveServiceState,
  resolveServiceStates,
} from '../domains/services/service-manifest.js';
import { registerServiceLifecycleRoutes, type ServiceLifecycleRouteOptions } from './services-lifecycle-routes.js';

export interface ServicesRouteOptions {
  env?: NodeJS.ProcessEnv;
  fetchHealth?: FetchServiceHealth;
  lifecycle?: ServiceLifecycleRouteOptions;
}

function resolveSessionUserId(request: FastifyRequest): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireIdentity(request: FastifyRequest, reply: FastifyReply): boolean {
  if (resolveSessionUserId(request)) return true;
  reply.status(401);
  return false;
}

export const servicesRoutes: FastifyPluginAsync<ServicesRouteOptions> = async (app, options) => {
  app.get('/api/services', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    const services = await resolveServiceStates({
      env: options.env,
      fetchHealth: options.fetchHealth,
    });
    return { services };
  });

  app.get('/api/services/endpoints', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    return {
      endpoints: resolveServiceEndpointMap(options.env),
    };
  });

  // Env-aware install preview: detects the host environment (OS / arch /
  // GPU / Python) and returns the recommendation matrix entry for the
  // service — models that work on this machine, plus any unsupported
  // reason if the env is incompatible. Restored from F190 followup
  // pre-sync work after upstream sync #720 inadvertently removed the
  // env-detection + recommendation layer.
  app.get<{ Params: { id: string } }>('/api/services/:id/install-preview', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    const { id } = request.params;
    const service = getServiceManifest(id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const profile = getEnvironmentProfile(true);
    const recommendation = buildRecommendation(id, profile);

    // Suggest a port for the modal to pre-fill. Priority chain:
    //   1. services.json cfg.port  — persisted user intent from prior install
    //   2. PORT_ENV_VARS[id] env  — operator's static .env override
    //   3. undefined              — let modal show "auto" (server allocates default)
    // Codex P2 3268623657 — modal reads `suggestedPort` to prefill; without
    // it, users defaulting to blank silently install on whatever the script
    // resolves at runtime, defeating the collision-avoidance path.
    let suggestedPort: number | undefined;
    const cfg = getServiceConfig(id);
    if (typeof cfg.port === 'number' && cfg.port > 0) {
      suggestedPort = cfg.port;
    } else {
      const portEnvKey = PORT_ENV_VARS[id];
      const envVal = portEnvKey ? (options.env ?? process.env)[portEnvKey]?.trim() : undefined;
      if (envVal && /^\d+$/.test(envVal)) {
        const n = Number.parseInt(envVal, 10);
        if (n > 0 && n <= 65535) suggestedPort = n;
      }
    }

    return { profile, recommendation, suggestedPort };
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/health', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }

    const state = await resolveServiceState(service, {
      env: options.env,
      fetchHealth: options.fetchHealth,
    });
    return {
      id: state.id,
      endpoint: maskServiceEndpoint(resolveServiceEndpoint(service, options.env)),
      configured: state.configured,
      status: state.status,
      httpStatus: state.httpStatus,
      error: state.error,
    };
  });

  await registerServiceLifecycleRoutes(app, options);
};
