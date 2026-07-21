/**
 * Callback Documentation Routes
 * On-demand fallback endpoints for MCP callback API reference and rich block
 * usage rules. Primary source of truth is in cat-cafe-skills/ (Skills system).
 *
 * These endpoints are unauthenticated — they serve static documentation
 * that is safe to expose. Kept as fallback for when skills are not readable.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { RICH_BLOCK_RULES } from '../domains/cats/services/context/rich-block-rules.js';
import { loadObjectiveRegistry } from '../infrastructure/harness-eval/objective-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Strip YAML frontmatter (between --- delimiters) from markdown content. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? content.slice(match[0].length).trimStart() : content;
}

/** Resolve path to a refs file in cat-cafe-skills/refs/. */
function refsPath(fileName: string): string {
  // From packages/api/src/routes/ → go up 4 levels to project root
  return resolve(__dirname, '..', '..', '..', '..', 'cat-cafe-skills', 'refs', fileName);
}

/** F257 #3: resolve the objective registry YAML (docs/harness-feedback/objectives/). */
function objectiveRegistryPath(): string {
  return resolve(__dirname, '..', '..', '..', '..', 'docs', 'harness-feedback', 'objectives', 'registry.yaml');
}

/**
 * Register documentation endpoints (fallback for Skills system).
 * No auth required — these return static reference text.
 */
export const registerCallbackDocsRoutes: FastifyPluginAsync = async (app) => {
  // Rich block usage rules
  app.get('/api/callbacks/rich-block-rules', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return { rules: RICH_BLOCK_RULES };
  });

  // F257 #3: objective registry — read-only discovery for report_harness_signal
  // objectiveId (so cats stop doing archaeology). Definition layer (id/statement/segments).
  app.get('/api/callbacks/objectives', async (_request, reply) => {
    const registry = await loadObjectiveRegistry(objectiveRegistryPath());
    reply.header('cache-control', 'public, max-age=3600');
    return { registryVersion: registry.registryVersion, objectives: registry.objectives };
  });

  // MCP callback instructions — reads refs file (SOT moved from skill to refs/)
  app.get('/api/callbacks/instructions', async (_request, reply) => {
    try {
      const raw = await readFile(refsPath('mcp-callbacks.md'), 'utf-8');
      const instructions = stripFrontmatter(raw);
      reply.header('cache-control', 'public, max-age=3600');
      return { instructions };
    } catch {
      reply.code(503);
      return { error: 'Refs file not readable. Ensure cat-cafe-skills/refs/mcp-callbacks.md exists.' };
    }
  });
};
