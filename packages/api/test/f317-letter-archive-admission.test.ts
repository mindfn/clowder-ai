import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companionCommandValidator } from '../src/domains/plugin/desktop-window-runtime/admission.js';
import {
  validateHostCompanionCommand,
  validateHostCompanionReply,
} from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';
import { validateHostPluginManifest } from '../src/domains/plugin/desktop-window-runtime/presentation-manifest.js';
import { resolveCompanionArchiveContract } from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { desktopWindowManifest } from './f317-window.fixture.js';

const archive = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.25',
  packageDigest: 'sha512-nAQbBlflHyfY08lzldO/nxEqbLvteXYT3e+rMxw/Lfq/2o8t01WH82aPLHrkyhxgvDe0IS7cfo0DCo30qow/wQ==',
};
test('registry alpha.25 is admitted only by its exact identity and package bytes', () => {
  assert.equal(resolveCompanionArchiveContract(archive), '0.1.0-beta.28');
  for (const bad of [
    { ...archive, version: '0.1.0-alpha.24' },
    { ...archive, pluginId: 'foreign' },
    { ...archive, packageDigest: archive.packageDigest.replace('nAQ', 'xAQ') },
  ])
    assert.equal(resolveCompanionArchiveContract(bad), undefined);
});

test('letter commands and replies use beta.28 while old archives keep strict v1 fences', () => {
  const command = { kind: 'conversation.draft.read', v: 1 };
  const reply = {
    kind: 'conversation',
    v: 2,
    status: 'available',
    threadTitle: 'Home',
    messages: [],
    hasMoreOlder: false,
    olderCursor: null,
  };
  assert.equal(companionCommandValidator('0.1.0-beta.28')(command), true);
  assert.equal(validateHostCompanionCommand(command, '0.1.0-beta.28'), true);
  assert.equal(validateHostCompanionReply(reply, '0.1.0-beta.28'), true);
  for (const contract of [
    '0.1.0-beta.21',
    '0.1.0-beta.23',
    '0.1.0-beta.24',
    '0.1.0-beta.25',
    '0.1.0-beta.27',
  ] as const) {
    assert.equal(companionCommandValidator(contract)(command), false);
    assert.equal(validateHostCompanionCommand(command, contract), false);
    assert.equal(validateHostCompanionReply(reply, contract), false);
  }
});

test('alpha.25 bridge1.5 retains the single builtin window boundary and old package bridge pair', () => {
  const base = desktopWindowManifest(undefined, '1.3.0');
  const letter = {
    ...base,
    pluginId: 'official.companion',
    version: '0.1.0-alpha.25',
    contributions: base.contributions?.map((c) => ({ ...c, bridgeVersion: '1.5.0' })),
  };
  const accepted = validateHostPluginManifest(letter);
  assert.equal(accepted.valid, true);
  if (accepted.valid) assert.deepEqual(accepted.manifest, letter);
  for (const bad of [
    { ...letter, pluginId: 'foreign' },
    { ...letter, version: '0.1.0-alpha.24' },
    { ...letter, contributions: letter.contributions?.map((c) => ({ ...c, bridgeVersion: '1.4.0' })) },
    { ...letter, contributions: [...(letter.contributions ?? []), { ...letter.contributions?.[0], id: 'second' }] },
    { ...letter, runtime: { transport: 'stdio', entrypoint: 'main.js' } },
  ])
    assert.equal(validateHostPluginManifest(bad).valid, false);
});
