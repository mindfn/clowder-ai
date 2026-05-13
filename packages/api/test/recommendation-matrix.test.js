// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { buildRecommendation, findMatrixEntry, getMatrixServiceIds } = await import(
  '../dist/domains/services/recommendation-matrix.js'
);

function makeProfile(overrides = {}) {
  return {
    os: 'darwin',
    arch: 'arm64',
    gpu: 'apple',
    pythonArch: 'native',
    pythonVersion: '3.11.0',
    ramGb: 32,
    diskFreeGb: 200,
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe('recommendation matrix — service coverage', () => {
  test('matrix covers all 4 core services', () => {
    const ids = getMatrixServiceIds();
    assert.deepEqual(ids.sort(), ['whisper-stt', 'mlx-tts', 'embedding-model', 'llm-postprocess'].sort());
  });
});

describe('recommendation matrix — macOS arm64', () => {
  const profile = makeProfile();

  test('whisper-stt → MLX turbo', () => {
    const rec = buildRecommendation('whisper-stt', profile);
    assert.equal(rec.recommended?.name, 'mlx-community/whisper-large-v3-turbo');
    assert.equal(rec.unsupported, undefined);
    assert.ok(rec.alternatives.length >= 1);
  });

  test('embedding-model → Qwen3 MLX', () => {
    const rec = buildRecommendation('embedding-model', profile);
    assert.match(rec.recommended?.name ?? '', /Qwen3-Embedding/);
  });

  test('llm-postprocess → Qwen3.5-35B with alternatives', () => {
    const rec = buildRecommendation('llm-postprocess', profile);
    assert.match(rec.recommended?.name ?? '', /Qwen3\.5-35B/);
    assert.ok(rec.alternatives.length >= 2);
    assert.ok(rec.caveats.some((c) => c.includes('48GB')));
  });

  test('mlx-tts → Kokoro', () => {
    const rec = buildRecommendation('mlx-tts', profile);
    assert.match(rec.recommended?.name ?? '', /Kokoro/);
  });
});

describe('recommendation matrix — Windows ARM64', () => {
  const profile = makeProfile({ os: 'win32', arch: 'arm64', gpu: 'none' });

  test('llm-postprocess native python → unsupported with guidance', () => {
    const rec = buildRecommendation('llm-postprocess', profile);
    assert.equal(rec.recommended, undefined);
    assert.ok(rec.unsupported);
    assert.match(rec.unsupported.userAction, /x86 Python/);
    assert.match(rec.unsupported.retryHint, /关闭|重新/);
  });

  test('llm-postprocess x86-emulated python → Qwen2.5-3B', () => {
    const x86Profile = makeProfile({
      os: 'win32',
      arch: 'arm64',
      gpu: 'none',
      pythonArch: 'x86-emulated',
    });
    const rec = buildRecommendation('llm-postprocess', x86Profile);
    assert.equal(rec.recommended?.name, 'Qwen/Qwen2.5-3B-Instruct');
    assert.equal(rec.unsupported, undefined);
    assert.ok(rec.caveats.some((c) => c.includes('x86')));
  });

  test('embedding-model → bge-base (ARM64 没 GPU 走 cpu 默认)', () => {
    const rec = buildRecommendation('embedding-model', profile);
    assert.equal(rec.recommended?.name, 'BAAI/bge-base-zh-v1.5');
  });

  test('whisper-stt → faster-whisper base (CPU)', () => {
    const rec = buildRecommendation('whisper-stt', profile);
    assert.equal(rec.recommended?.name, 'base');
    assert.ok(rec.caveats.some((c) => c.includes('CPU')));
  });
});

describe('recommendation matrix — Windows x64 with CUDA', () => {
  const profile = makeProfile({ os: 'win32', arch: 'x64', gpu: 'cuda' });

  test('llm-postprocess → Qwen2.5-7B (GPU)', () => {
    const rec = buildRecommendation('llm-postprocess', profile);
    assert.equal(rec.recommended?.name, 'Qwen/Qwen2.5-7B-Instruct');
    assert.ok(rec.alternatives.length >= 1);
  });

  test('embedding-model → bge-large (GPU)', () => {
    const rec = buildRecommendation('embedding-model', profile);
    assert.equal(rec.recommended?.name, 'BAAI/bge-large-zh-v1.5');
  });

  test('whisper-stt → faster-whisper turbo (GPU)', () => {
    const rec = buildRecommendation('whisper-stt', profile);
    assert.equal(rec.recommended?.name, 'large-v3-turbo');
  });
});

describe('recommendation matrix — Linux x64 CPU only', () => {
  const profile = makeProfile({ os: 'linux', arch: 'x64', gpu: 'none' });

  test('llm-postprocess → 3B CPU model', () => {
    const rec = buildRecommendation('llm-postprocess', profile);
    assert.equal(rec.recommended?.name, 'Qwen/Qwen2.5-3B-Instruct');
  });

  test('mlx-tts → edge-tts only', () => {
    const rec = buildRecommendation('mlx-tts', profile);
    assert.equal(rec.recommended?.name, 'edge-tts');
    assert.equal(rec.alternatives.length, 0);
  });
});

describe('recommendation matrix — match ordering', () => {
  test('GPU entry comes before generic entry (specificity matters)', () => {
    const cudaProfile = makeProfile({ os: 'win32', arch: 'x64', gpu: 'cuda' });
    const noneProfile = makeProfile({ os: 'win32', arch: 'x64', gpu: 'none' });

    const cuda = findMatrixEntry('embedding-model', cudaProfile);
    const cpu = findMatrixEntry('embedding-model', noneProfile);

    assert.notEqual(cuda, cpu);
    assert.equal(cuda?.recommended?.name, 'BAAI/bge-large-zh-v1.5');
    assert.equal(cpu?.recommended?.name, 'BAAI/bge-base-zh-v1.5');
  });
});

describe('recommendation matrix — unknown service', () => {
  test('returns unsupported with developer-facing message', () => {
    const rec = buildRecommendation('nonexistent-service', makeProfile());
    assert.equal(rec.recommended, undefined);
    assert.ok(rec.unsupported);
    assert.match(rec.unsupported.reason, /nonexistent-service/);
  });
});
