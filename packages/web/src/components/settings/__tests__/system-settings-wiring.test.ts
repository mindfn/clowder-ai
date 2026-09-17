/**
 * clowder-ai#1280: production wiring regression guard.
 *
 * #770 Gate 2: the System branch renders ONLY the curated projection
 * (HubSystemSettingsTab → SystemSettingsGate2). The former 「环境 & 文件」
 * env-var dump (HubEnvFilesTab) was removed in Gate 2 — its changelog-era
 * copy (PageIntro) and English banner must not creep back into the page.
 * Reading the production source catches the exact regression without
 * replacing composition with an isolated fixture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_CONTENT_PATH = resolve(__dirname, '../SettingsContent.tsx');

function systemBranch(): string {
  const source = readFileSync(SETTINGS_CONTENT_PATH, 'utf8');
  const match = source.match(/case\s+'system':\s*\n(?:\s*\/\/[^\n]*\n)*\s*return\s*\(\s*\n([\s\S]*?)\n\s*\);/);
  if (!match?.[1]) throw new Error('System settings production branch not found');
  return match[1];
}

describe('System settings production wiring', () => {
  const source = readFileSync(SETTINGS_CONTENT_PATH, 'utf8');

  it('imports the curated System surface', () => {
    expect(source).toContain("from './HubSystemSettingsTab'");
    expect(source).not.toContain('HubEnvFilesTab');
  });

  it('renders the curated System surface and nothing else in the production branch', () => {
    const branch = systemBranch();
    expect(branch).toContain('<HubSystemSettingsTab');
    expect(branch).not.toContain('HubEnvFilesTab');
  });
});
