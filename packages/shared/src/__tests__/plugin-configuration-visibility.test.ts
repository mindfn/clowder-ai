import { describe, expect, it } from 'vitest';
import { isPluginConfigurationFieldVisible } from '../plugin-configuration-required.js';

describe('isPluginConfigurationFieldVisible', () => {
  it('treats a field without visibleWhen as visible', () => {
    expect(isPluginConfigurationFieldVisible({}, () => undefined)).toBe(true);
  });

  it('matches a scalar condition against the effective value', () => {
    const field = { visibleWhen: { key: 'mode', value: 'webhook' } };
    expect(isPluginConfigurationFieldVisible(field, () => 'webhook')).toBe(true);
    expect(isPluginConfigurationFieldVisible(field, () => 'websocket')).toBe(false);
  });

  it('matches any entry of an array condition and non-string values', () => {
    const field = { visibleWhen: { key: 'mode', value: ['webhook', 'hybrid', 2] } };
    expect(isPluginConfigurationFieldVisible(field, () => 'hybrid')).toBe(true);
    expect(isPluginConfigurationFieldVisible(field, () => '2')).toBe(true);
    expect(isPluginConfigurationFieldVisible(field, () => 'polling')).toBe(false);
  });

  it('hides the field when the referenced value is unknown', () => {
    const field = { visibleWhen: { key: 'mode', value: 'webhook' } };
    expect(isPluginConfigurationFieldVisible(field, () => undefined)).toBe(false);
  });
});
