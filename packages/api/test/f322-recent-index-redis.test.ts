import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { RedisSessionChainStore } from '../src/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { SessionChainKeys } from '../src/domains/cats/services/stores/redis-keys/session-chain-keys.js';

test('Redis bulk claim projection uses one MGET and one small HMGET pipeline, with no chain traversal', async () => {
  const calls: string[][] = [];
  const pending: string[][] = [];
  const redis = {
    mget: async (...keys: string[]) => {
      calls.push(['mget', ...keys]);
      return ['record-1', null, 'record-3'];
    },
    pipeline: () => ({
      hmget: (...args: string[]) => {
        pending.push(args);
      },
      exec: async () => {
        calls.push(['pipeline', String(pending.length)]);
        return [
          [null, ['record-1', 'native-1', 'thread-1', 'codex', 'owner']],
          [null, ['record-3', 'changed-native-id', 'thread-3', 'codex', 'owner']],
        ];
      },
    }),
  };
  const store = new RedisSessionChainStore(redis as unknown as RedisClient);
  assert.equal((await store.getCliSessionBindings([])).size, 0);
  assert.equal(calls.length, 0);
  const claims = await store.getCliSessionBindings(['native-1', 'missing', 'native-3', 'native-1']);
  assert.equal(claims.size, 1, 'stale byCli pointers cannot project another claim');
  assert.equal(claims.get('native-1')?.threadId, 'thread-1');
  assert.deepEqual(calls, [
    ['mget', ...['native-1', 'missing', 'native-3'].map(SessionChainKeys.byCli)],
    ['pipeline', '2'],
  ]);
  assert.deepEqual(
    pending.map((args) => args.slice(1)),
    Array(2).fill(['id', 'cliSessionId', 'threadId', 'catId', 'userId']),
  );
});
