// F117 Phase M: "read" for a Claude SDK Append rests on the engine's untyped `command_lifecycle`
// frame. It is not in the SDK's public types, so an upgrade may drop it; the documented echo would
// then still work, but only at the end of the turn, and Landy's "read" would quietly degrade. The
// frame was verified live against one SDK version; any other version must be re-verified first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMAND_LIFECYCLE_VERIFIED_SDK_VERSION } from '../dist/domains/cats/services/agents/providers/claude-sdk-input-consumption.js';

describe('F117 Phase M: SDK read-evidence contract', () => {
  it('runs only the SDK version whose command_lifecycle frame was verified live', () => {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const installed = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')).version;
    assert.equal(
      installed,
      COMMAND_LIFECYCLE_VERIFIED_SDK_VERSION,
      'The Claude Agent SDK changed. Run `node packages/api/scripts/f117-sdk-read-evidence-contract.mjs` ' +
        '(one real haiku call) against it; only if it passes, update COMMAND_LIFECYCLE_VERIFIED_SDK_VERSION.',
    );
  });
});
