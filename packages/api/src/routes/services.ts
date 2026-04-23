import type { FastifyPluginAsync } from 'fastify';
import { getAllServiceStates, getServiceById, getServiceState } from '../domains/services/service-registry.js';

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/services', async () => {
    const states = await getAllServiceStates();
    return { services: states };
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/health', async (request, reply) => {
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const state = await getServiceState(manifest);
    return state;
  });
};
