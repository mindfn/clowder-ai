/**
 * MediaHub — Behavioral Tests
 * F139: Tests for JobStore, MediaStorage, and bootstrap fallback.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// ==================== JobStore Tests ====================

describe('JobStore (in-memory RedisClient)', () => {
  /** @type {import('../dist/mediahub/job-store.js').RedisClient} */
  let redis;
  /** @type {import('../dist/mediahub/job-store.js').JobStore} */
  let store;

  beforeEach(async () => {
    // Use in-memory Map-based stub matching bootstrap.ts pattern
    const data = new Map();
    const sortedSets = new Map();

    redis = {
      async hset(key, obj) {
        const existing = data.get(key) ?? {};
        data.set(key, { ...existing, ...obj });
        return Object.keys(obj).length;
      },
      async hgetall(key) {
        return data.get(key) ?? {};
      },
      async expire() {
        return 1;
      },
      async zadd(key, ...args) {
        const set = sortedSets.get(key) ?? [];
        for (let i = 0; i < args.length; i += 2) {
          const score = Number(args[i]);
          const member = String(args[i + 1]);
          const idx = set.findIndex((e) => e.member === member);
          if (idx >= 0) set[idx].score = score;
          else set.push({ score, member });
        }
        set.sort((a, b) => b.score - a.score);
        sortedSets.set(key, set);
        return args.length / 2;
      },
      async zrevrangebyscore(key, _max, _min, ...args) {
        const set = sortedSets.get(key) ?? [];
        let limit = set.length;
        const li = args.indexOf('LIMIT');
        if (li >= 0 && args[li + 2]) limit = Number(args[li + 2]);
        return set.slice(0, limit).map((e) => e.member);
      },
      async del(key) {
        data.delete(key);
        return 1;
      },
    };

    const { JobStore } = await import('../dist/mediahub/job-store.js');
    store = new JobStore(redis);
  });

  /** @returns {import('../dist/mediahub/types.js').JobRecord} */
  function makeJob(overrides = {}) {
    return {
      jobId: 'test-job-1',
      providerId: 'cogvideox',
      capability: 'text2video',
      model: 'cogvideox-flash',
      prompt: 'a cat playing piano',
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it('save and get round-trips a job record', async () => {
    const job = makeJob();
    await store.save(job);
    const retrieved = await store.get('test-job-1');
    assert.ok(retrieved);
    assert.equal(retrieved.jobId, 'test-job-1');
    assert.equal(retrieved.providerId, 'cogvideox');
    assert.equal(retrieved.status, 'queued');
    assert.equal(retrieved.prompt, 'a cat playing piano');
  });

  it('get returns null for nonexistent job', async () => {
    const result = await store.get('nonexistent');
    assert.equal(result, null);
  });

  it('updateStatus changes status and preserves other fields', async () => {
    await store.save(makeJob());
    await store.updateStatus('test-job-1', 'running', {
      providerTaskId: 'ext-123',
    });
    const job = await store.get('test-job-1');
    assert.ok(job);
    assert.equal(job.status, 'running');
    assert.equal(job.providerTaskId, 'ext-123');
    assert.equal(job.prompt, 'a cat playing piano');
  });

  it('updateStatus to succeeded with outputPath', async () => {
    await store.save(makeJob());
    await store.updateStatus('test-job-1', 'succeeded', {
      outputPath: '/data/output.mp4',
    });
    const job = await store.get('test-job-1');
    assert.ok(job);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.outputPath, '/data/output.mp4');
  });

  it('updateStatus to failed with error message', async () => {
    await store.save(makeJob());
    await store.updateStatus('test-job-1', 'failed', {
      error: 'API rate limit',
    });
    const job = await store.get('test-job-1');
    assert.ok(job);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'API rate limit');
  });

  it('listRecent returns jobs in reverse chronological order', async () => {
    const now = Date.now();
    await store.save(makeJob({ jobId: 'j1', createdAt: now - 2000 }));
    await store.save(makeJob({ jobId: 'j2', createdAt: now - 1000 }));
    await store.save(makeJob({ jobId: 'j3', createdAt: now }));

    const jobs = await store.listRecent(10);
    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].jobId, 'j3');
    assert.equal(jobs[1].jobId, 'j2');
    assert.equal(jobs[2].jobId, 'j1');
  });

  it('listRecent respects limit', async () => {
    const now = Date.now();
    await store.save(makeJob({ jobId: 'j1', createdAt: now - 1000 }));
    await store.save(makeJob({ jobId: 'j2', createdAt: now }));

    const jobs = await store.listRecent(1);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, 'j2');
  });
});

// ==================== MediaStorage Tests ====================

describe('MediaStorage', () => {
  it('rejects non-http protocols (SSRF protection)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(() => storage.download('test', 'j1', 'file:///etc/passwd'), /protocol "file:" not allowed/);
  });

  it('rejects ftp protocol', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(
      () => storage.download('test', 'j1', 'ftp://evil.com/file.mp4'),
      /protocol "ftp:" not allowed/,
    );
  });
});

// ==================== ProviderRegistry Tests ====================

describe('ProviderRegistry', () => {
  /** @type {import('../dist/mediahub/provider.js').ProviderRegistry} */
  let registry;

  beforeEach(async () => {
    const { ProviderRegistry } = await import('../dist/mediahub/provider.js');
    registry = new ProviderRegistry();
  });

  const mockProvider = {
    id: 'test-provider',
    info: {
      id: 'test-provider',
      name: 'Test Provider',
      capabilities: ['text2video'],
      models: ['test-model'],
      authMode: 'api_key',
    },
    supports: (cap) => cap === 'text2video',
    submit: async () => ({ taskId: 't1', status: 'queued' }),
    queryStatus: async () => ({
      status: 'succeeded',
      resultUrl: 'https://example.com/out.mp4',
    }),
  };

  it('register and get provider', () => {
    registry.register(mockProvider);
    const p = registry.get('test-provider');
    assert.ok(p);
    assert.equal(p.id, 'test-provider');
  });

  it('get returns undefined for unknown provider', () => {
    assert.equal(registry.get('unknown'), undefined);
  });

  it('list returns all registered providers', () => {
    registry.register(mockProvider);
    const list = registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'test-provider');
  });

  it('listByCapability filters correctly', () => {
    registry.register(mockProvider);
    const video = registry.listByCapability('text2video');
    assert.equal(video.length, 1);
    const image = registry.listByCapability('text2image');
    assert.equal(image.length, 0);
  });
});
