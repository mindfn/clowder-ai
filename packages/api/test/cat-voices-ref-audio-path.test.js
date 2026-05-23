// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveRefAudioPath } from '../dist/config/cat-voices.js';

describe('resolveRefAudioPath', () => {
  /** @type {string} */
  let dataRoot;
  /** @type {string} */
  let uploadDir;
  /** @type {string} */
  let characterDir;
  /** @type {string | undefined} */
  let prevDataDir;

  before(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-ref-audio-data-'));
    uploadDir = join(dataRoot, 'uploads');
    characterDir = await mkdtemp(join(tmpdir(), 'cat-cafe-character-voices-'));
    prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataRoot;
  });

  after(async () => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(characterDir, { recursive: true, force: true });
  });

  it('resolves uploaded refAudio URLs inside DATA_DIR/uploads', () => {
    assert.equal(resolveRefAudioPath('/uploads/ref-audio-1.wav', characterDir), join(uploadDir, 'ref-audio-1.wav'));
  });

  it('resolves relative refAudio paths inside CHARACTER_VOICE_DIR', () => {
    assert.equal(resolveRefAudioPath('魈/vo_xiao.wav', characterDir), join(characterDir, '魈/vo_xiao.wav'));
  });

  it('rejects uploaded refAudio traversal outside DATA_DIR/uploads', () => {
    assert.equal(resolveRefAudioPath('/uploads/../secret.wav', characterDir), join(uploadDir, 'invalid-ref'));
  });

  it('rejects nested uploaded refAudio traversal even when normalized path stays inside DATA_DIR/uploads', () => {
    assert.equal(resolveRefAudioPath('/uploads/sub/../secret.wav', characterDir), join(uploadDir, 'invalid-ref'));
  });

  it('rejects absolute refAudio paths outside CHARACTER_VOICE_DIR', () => {
    assert.equal(resolveRefAudioPath('/tmp/outside.wav', characterDir), join(characterDir, 'invalid-ref'));
  });

  it('rejects empty refAudio strings', () => {
    assert.equal(resolveRefAudioPath('', characterDir), join(characterDir, 'invalid-ref'));
  });
});
