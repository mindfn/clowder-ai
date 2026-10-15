import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountQuotaObservation, CodexManagedAccount } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveByAccountRef } from '../config/account-resolver.js';
import { readAccountStoreSnapshot } from '../config/account-store-snapshot.js';
import { writeCatalogAccount } from '../config/catalog-accounts.js';
import {
  codexIdentityFromAuth,
  codexManagedStatus,
  readCodexAccountIdentity,
  sameCodexIdentity,
} from '../config/codex-account-identity.js';
import { resolveCodexAccountLaunch } from '../config/codex-account-launch.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';
import { parseCodexWhamUsageResponse } from './quota.js';

function managedQuotaOwnerUnchanged(
  requested: CodexManagedAccount,
  current: CodexManagedAccount | undefined,
  wasReady: boolean,
): boolean {
  if (!current || current.credentialHome !== requested.credentialHome) return false;
  if ((requested.identity || current.identity) && !sameCodexIdentity(requested.identity, current.identity))
    return false;
  return !wasReady || sameCodexIdentity(requested.identity, readCodexAccountIdentity(requested.credentialHome));
}

/** Per-account, explicit and read-only. No global Codex cache, token refresh or credential fallback. */
export function registerCodexQuotaRoutes(app: FastifyInstance, fetcher: typeof fetch = globalThis.fetch): void {
  app.post('/api/accounts/:profileId/codex/quota', async (request, reply) => {
    if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
    const parsed = z
      .object({ projectPath: z.string().optional() })
      .strict()
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const root = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!root) return reply.code(400).send({ error: 'Invalid project path' });
    const { profileId } = request.params as { profileId: string };
    try {
      const profile = resolveByAccountRef(root, profileId);
      if (!profile || profile.client !== 'openai') return reply.code(404).send({ error: 'Codex account not found' });
      const requestedIdentity = profile.codex?.identity;
      const wasReady = !!profile.codex && codexManagedStatus(profile.codex) === 'ready';
      let observation: AccountQuotaObservation;
      if (profile.authType === 'api_key')
        observation = {
          observedAt: Date.now(),
          source: 'codex_official_readonly',
          status: 'unsupported',
          items: [],
          error: 'API 账号请在服务商账单页查看余额',
        };
      else {
        try {
          if (profile.codex && codexManagedStatus(profile.codex) !== 'ready') throw new Error('login_required');
          const home = resolveCodexAccountLaunch(profile, { cwd: root }).credentialHome;
          const raw = readFileSync(join(home, 'auth.json'), 'utf8');
          if (raw.length > 262144) throw new Error('credentials_invalid');
          if (profile.codex && !sameCodexIdentity(profile.codex.identity, codexIdentityFromAuth(raw)))
            throw new Error('login_required');
          const tokens = (JSON.parse(raw) as { tokens?: { access_token?: string; account_id?: string } }).tokens;
          if (!tokens?.access_token || !tokens.account_id) throw new Error('login_required');
          const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
              'ChatGPT-Account-Id': tokens.account_id,
              Accept: 'application/json',
            },
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) throw new Error(response.status === 401 ? 'login_expired' : 'quota_unavailable');
          const items = parseCodexWhamUsageResponse(
            (await response.json()) as Parameters<typeof parseCodexWhamUsageResponse>[0],
            response.headers,
          );
          if (!items.length) throw new Error('quota_unavailable');
          observation = { observedAt: Date.now(), source: 'codex_official_readonly', status: 'ok', items };
        } catch (error) {
          observation = {
            observedAt: Date.now(),
            source: 'codex_official_readonly',
            status: 'unavailable',
            items: [],
            error: /login_expired/.test(String(error))
              ? '登录凭据已过期，请让官方 Codex 完成续期后再查询'
              : /login_required/.test(String(error))
                ? '请先完成此账号的官方登录'
                : '暂时无法查询此账号额度，请重试',
          };
        }
      }
      const current = readAccountStoreSnapshot(root).resolve(profileId).account;
      // The same ref may now name another principal. Reject late results before synchronous write.
      if (!current || (profile.codex && !managedQuotaOwnerUnchanged(profile.codex, current.codex, wasReady)))
        return reply.code(409).send({ error: '账号登录已变化，请刷新账号列表后重新查询' });
      if (requestedIdentity)
        observation = {
          ...observation,
          owner: {
            accountRef: profileId,
            userId: requestedIdentity.userId,
            workspaceId: requestedIdentity.workspaceId,
          },
        };
      // Preserve a concurrently changed note/attempt, without recreating a deleted account.
      writeCatalogAccount(root, profileId, { ...current, quota: observation });
      return { accountRef: profileId, quota: observation };
    } catch {
      return reply.code(409).send({ error: '无法读取账号，请核对账号配置' });
    }
  });
}
