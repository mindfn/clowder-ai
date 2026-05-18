import type { AuthResult, AuthStrategy } from '../types.js';

export const apikeyStrategy: AuthStrategy = {
  type: 'apikey',
  sign(credentials): AuthResult {
    const key = credentials['apiKey'] ?? credentials['api_key'] ?? '';
    return { headers: { Authorization: `Bearer ${key}` } };
  },
};

export const queryParamStrategy: AuthStrategy = {
  type: 'query-param',
  sign(credentials): AuthResult {
    const key = credentials['apiKey'] ?? credentials['api_key'] ?? '';
    return { queryParams: { key } };
  },
};
