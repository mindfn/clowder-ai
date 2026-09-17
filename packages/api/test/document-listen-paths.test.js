import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resolveTtsCacheDir } from '../dist/config/data-dirs.js';
import { resolveDocumentListenStatePath } from '../dist/domains/cats/services/tts/document-listen-paths.js';

describe('resolveDocumentListenStatePath', () => {
  const homeDir = path.join(path.sep, 'tmp', 'cat-cafe-home');

  it('stores durable state below the current user data root by default', () => {
    assert.equal(resolveDocumentListenStatePath({}, homeDir), path.join(homeDir, '.cat-cafe', 'listen-mode.sqlite'));
  });

  it('honors CAT_CAFE_DATA_DIR without depending on the paused F289 catalog', () => {
    const dataRoot = path.join(path.sep, 'var', 'cat-cafe-data');
    assert.equal(
      resolveDocumentListenStatePath({ CAT_CAFE_DATA_DIR: dataRoot }, homeDir),
      path.join(dataRoot, 'listen-mode.sqlite'),
    );
  });

  it('expands a home-relative CAT_CAFE_DATA_DIR before resolving durable state', () => {
    assert.equal(
      resolveDocumentListenStatePath({ CAT_CAFE_DATA_DIR: '~/.cat-cafe-custom' }, homeDir),
      path.join(homeDir, '.cat-cafe-custom', 'listen-mode.sqlite'),
    );
  });

  it('lets LISTEN_MODE_DB override both canonical root choices', () => {
    const override = path.join(path.sep, 'var', 'listen', 'custom.sqlite');
    assert.equal(
      resolveDocumentListenStatePath(
        { CAT_CAFE_DATA_DIR: path.join(path.sep, 'ignored'), LISTEN_MODE_DB: override },
        homeDir,
      ),
      override,
    );
  });

  it('expands a home-relative LISTEN_MODE_DB override', () => {
    assert.equal(
      resolveDocumentListenStatePath({ LISTEN_MODE_DB: '~/state/listen.sqlite' }, homeDir),
      path.join(homeDir, 'state', 'listen.sqlite'),
    );
  });
});

describe('resolveTtsCacheDir (canonical resolver in config/data-dirs.js)', () => {
  // The canonical resolver reads process.env directly — save/restore the
  // knobs each test touches so the rest of the suite sees a clean env.
  const touched = ['TTS_CACHE_DIR', 'CACHE_DIR', 'DATA_DIR'];
  const saved = {};
  afterEach(() => {
    for (const key of touched) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function setEnv(key, value) {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  }

  it('defaults to the cwd-based legacy cache dir when no root or override is set', () => {
    for (const key of ['TTS_CACHE_DIR', 'CACHE_DIR']) {
      if (!(key in saved)) saved[key] = process.env[key];
      delete process.env[key];
    }
    assert.equal(resolveTtsCacheDir(), path.resolve(process.cwd(), 'data/tts-cache'));
  });

  it('derives the cache dir from CACHE_DIR/tts', () => {
    const cacheRoot = path.join(path.sep, 'var', 'cache', 'cat-cafe');
    setEnv('CACHE_DIR', cacheRoot);
    assert.equal(resolveTtsCacheDir(), path.join(cacheRoot, 'tts'));
  });

  it('keeps an explicit TTS_CACHE_DIR override working (deprecated compat)', () => {
    const override = path.join(path.sep, 'var', 'cache', 'cat-cafe-tts');
    setEnv('CACHE_DIR', path.join(path.sep, 'ignored'));
    setEnv('TTS_CACHE_DIR', override);
    assert.equal(resolveTtsCacheDir(), override);
  });

  it('expands a home-relative TTS_CACHE_DIR override', () => {
    setEnv('TTS_CACHE_DIR', '~/custom-tts-cache');
    assert.equal(resolveTtsCacheDir(), path.join(homedir(), 'custom-tts-cache'));
  });
});
