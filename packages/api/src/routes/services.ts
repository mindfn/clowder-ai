import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { getOwnerUserId } from '../config/cat-config-loader.js';
import {
  getAllServiceStates,
  getCachedServiceState,
  getKnownServices,
  getServiceById,
  getServiceState,
} from '../domains/services/service-registry.js';
import { resolveUserId } from '../utils/request-identity.js';

function resolveScriptPath(script: string): string {
  const configRoot = process.env['CAT_CAFE_CONFIG_ROOT'] ?? process.cwd();
  return resolve(configRoot, script);
}

function readLogTail(serviceId: string, lines = 100): string[] {
  const logDir = process.env['LOG_DIR'] ?? './data/logs/api';
  const logPath = resolve(logDir, `${serviceId}.log`);
  if (!existsSync(logPath)) return [];
  try {
    const content = readFileSync(logPath, 'utf-8');
    return content.split('\n').slice(-lines).filter(Boolean);
  } catch {
    return [];
  }
}

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/services', async () => {
    const cached = getKnownServices()
      .map((m) => getCachedServiceState(m.id))
      .filter(Boolean);
    if (cached.length > 0) return { services: cached };
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
    const cached = getCachedServiceState(id);
    if (cached) return cached;
    const state = await getServiceState(manifest);
    return state;
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/start', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId || userId !== getOwnerUserId()) {
      reply.status(403);
      return { error: 'Only the owner can manage services' };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    if (!manifest.scripts.start) {
      reply.status(400);
      return { error: `Service "${id}" has no start script` };
    }

    const current = await getServiceState(manifest);
    if (current.status === 'running') {
      return { ok: true, message: `${manifest.name} is already running` };
    }

    const scriptPath = resolveScriptPath(manifest.scripts.start);
    if (!existsSync(scriptPath)) {
      reply.status(400);
      return { error: `Start script not found: ${scriptPath}` };
    }

    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    return { ok: true, message: `${manifest.name} start initiated (pid: ${child.pid})` };
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/stop', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId || userId !== getOwnerUserId()) {
      reply.status(403);
      return { error: 'Only the owner can manage services' };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }

    if (manifest.scripts.stop) {
      const scriptPath = resolveScriptPath(manifest.scripts.stop);
      if (existsSync(scriptPath)) {
        const child = spawn('bash', [scriptPath], { stdio: 'ignore' });
        await new Promise<void>((res) => child.on('close', () => res()));
        return { ok: true, message: `${manifest.name} stopped via script` };
      }
    }

    if (!manifest.port) {
      reply.status(400);
      return { error: `Service "${id}" has no port or stop script` };
    }

    try {
      const child = spawn('lsof', ['-ti', `:${manifest.port}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      await new Promise<void>((res, rej) => {
        child.on('error', rej);
        child.on('close', () => res());
      });
      const pids = stdout.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      return { ok: true, message: `${manifest.name} stopped (${pids.length} process(es))` };
    } catch {
      return { ok: false, error: 'Failed to stop service' };
    }
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/install', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId || userId !== getOwnerUserId()) {
      reply.status(403);
      return { error: 'Only the owner can manage services' };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    if (!manifest.scripts.install) {
      return { ok: true, message: `${manifest.name} has no install script (dependencies managed externally)` };
    }

    const scriptPath = resolveScriptPath(manifest.scripts.install);
    if (!existsSync(scriptPath)) {
      reply.status(400);
      return { error: `Install script not found: ${scriptPath}` };
    }

    const child = spawn('bash', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      output += d.toString();
    });
    const code = await new Promise<number | null>((res) => child.on('close', (c) => res(c)));

    if (code !== 0) {
      return { ok: false, error: `Install failed (exit ${code})`, output: output.slice(-2000) };
    }
    return { ok: true, message: `${manifest.name} installed successfully` };
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/logs', async (request, reply) => {
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const lines = readLogTail(id);
    return { serviceId: id, lines };
  });
};
