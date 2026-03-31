/**
 * MediaHub — Phase 4B Tests
 * Verify Gemini-first video understanding path.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

function createMemoryRedis() {
  const data = new Map();
  const sortedSets = new Map();
  return {
    async hset(key, obj) {
      data.set(key, { ...(data.get(key) ?? {}), ...obj });
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
        set.push({ score: Number(args[i]), member: String(args[i + 1]) });
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
    async zrem(key, ...members) {
      const set = sortedSets.get(key) ?? [];
      sortedSets.set(
        key,
        set.filter((entry) => !members.includes(entry.member)),
      );
      return members.length;
    },
    async del(key) {
      data.delete(key);
      return 1;
    },
  };
}

async function setupServiceWithJob(job) {
  const { JobStore } = await import('../dist/mediahub/job-store.js');
  const { ProviderRegistry } = await import('../dist/mediahub/provider.js');
  const { MediaHubService } = await import('../dist/mediahub/mediahub-service.js');
  const { setMediaHubService } = await import('../dist/mediahub/mediahub-tools.js');

  const redis = createMemoryRedis();
  const jobStore = new JobStore(redis);
  await jobStore.save(job);

  const registry = new ProviderRegistry();
  const storage = {
    async download() {
      return '';
    },
    getBaseDir() {
      return '/tmp';
    },
  };
  const service = new MediaHubService(registry, jobStore, storage);
  setMediaHubService(service);
}

describe('mediahub_analyze_video', () => {
  it('returns error when neither job_id nor video_url is provided', async () => {
    const { handleAnalyzeVideo } = await import('../dist/mediahub/mediahub-tools.js');
    const result = await handleAnalyzeVideo({});
    assert.ok(result.isError);
    assert.match(result.content[0].text, /job_id|video_url/i);
  });

  it('analyzes a succeeded job using Gemini inline video input', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-4b-'));
    const videoPath = path.join(tmpDir, 'output.mp4');
    const buf = Buffer.alloc(64);
    buf.write('ftyp', 4, 'ascii');
    fs.writeFileSync(videoPath, buf);

    const now = Date.now();
    await setupServiceWithJob({
      jobId: 'job-inline-1',
      providerId: 'cogvideox',
      capability: 'text2video',
      model: 'cogvideox-flash',
      prompt: 'cat in garden',
      status: 'succeeded',
      outputPath: videoPath,
      providerResultUrl: 'https://cdn.example.com/output.mp4',
      createdAt: now,
      updatedAt: now,
    });

    const originalFetch = globalThis.fetch;
    const originalKey = process.env['GEMINI_API_KEY'];
    process.env['GEMINI_API_KEY'] = 'test-gemini-key';

    let requestBody;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'A calm cinematic cat nap scene.',
                      keyMoments: ['Cat enters frame', 'Cat lies down'],
                      styleTags: ['cinematic', 'warm-tone'],
                      qualityScore: 88,
                      issues: [],
                      recommendRegenerate: false,
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    };

    try {
      const { handleAnalyzeVideo } = await import('../dist/mediahub/mediahub-tools.js');
      const result = await handleAnalyzeVideo({ job_id: 'job-inline-1' });
      assert.ok(!result.isError);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.analysis.qualityScore, 88);
      assert.equal(parsed.method, 'inline_video');
      assert.equal(parsed.sourceJob.jobId, 'job-inline-1');
      assert.ok(requestBody.contents[0].parts[0].inlineData?.data, 'Gemini request should contain inlineData');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env['GEMINI_API_KEY'];
      else process.env['GEMINI_API_KEY'] = originalKey;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses file URI mode when analyzing a public URL directly', async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env['GEMINI_API_KEY'];
    process.env['GEMINI_API_KEY'] = 'test-gemini-key';

    let requestBody;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"summary":"ok","keyMoments":[],"styleTags":[],"qualityScore":76,"issues":[]}' }],
              },
            },
          ],
        }),
      );
    };

    try {
      const { handleAnalyzeVideo } = await import('../dist/mediahub/mediahub-tools.js');
      const result = await handleAnalyzeVideo({ video_url: 'https://cdn.example.com/demo.mp4' });
      assert.ok(!result.isError);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.method, 'file_uri');
      assert.equal(requestBody.contents[0].parts[0].fileData.fileUri, 'https://cdn.example.com/demo.mp4');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env['GEMINI_API_KEY'];
      else process.env['GEMINI_API_KEY'] = originalKey;
    }
  });
});
