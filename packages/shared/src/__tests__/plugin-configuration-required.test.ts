import { describe, expect, it } from 'vitest';
import {
  isPluginConfigurationFieldConditionMet,
  isPluginConfigurationFieldRequired,
} from '../plugin-configuration-required.js';

describe('isPluginConfigurationFieldConditionMet', () => {
  it('treats fields without a condition as always applicable', () => {
    expect(isPluginConfigurationFieldConditionMet({ requiredWhen: undefined }, () => undefined)).toBe(true);
  });

  it('matches a scalar expected value', () => {
    const field = { requiredWhen: { key: 'mode', value: 'webhook' } };
    expect(isPluginConfigurationFieldConditionMet(field, () => 'webhook')).toBe(true);
    expect(isPluginConfigurationFieldConditionMet(field, () => 'websocket')).toBe(false);
  });

  it('matches any entry of an array expected value', () => {
    const field = { requiredWhen: { key: 'authType', value: ['jwt-hs256', 'hmac-sha256-v4'] } };
    expect(isPluginConfigurationFieldConditionMet(field, () => 'hmac-sha256-v4')).toBe(true);
    expect(isPluginConfigurationFieldConditionMet(field, () => 'apikey')).toBe(false);
  });

  it('treats an unresolved selector value as unmet', () => {
    const field = { requiredWhen: { key: 'mode', value: 'webhook' } };
    expect(isPluginConfigurationFieldConditionMet(field, () => undefined)).toBe(false);
  });
});

describe('isPluginConfigurationFieldRequired', () => {
  it('falls back to the required flag without a condition', () => {
    expect(isPluginConfigurationFieldRequired({ required: true }, () => undefined)).toBe(true);
    expect(isPluginConfigurationFieldRequired({ required: false }, () => undefined)).toBe(false);
  });

  it('requires exactly when the condition holds, regardless of the required flag', () => {
    const field = { required: false, requiredWhen: { key: 'mode', value: 'webhook' } };
    expect(isPluginConfigurationFieldRequired(field, () => 'webhook')).toBe(true);
    expect(isPluginConfigurationFieldRequired(field, () => 'websocket')).toBe(false);
  });
});
