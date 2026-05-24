import type { FastifyRequest } from 'fastify';
import { isLoopbackAddress } from '../../utils/loopback-request.js';
import { REDACTED_CAPABILITY_SECRET } from './capability-redaction.js';

export interface CapabilityWriteRouteError {
  status: number;
  error: string;
}

export interface CapabilityWriteOwnerOptions {
  allowMissingOwner?: boolean;
  requireConfiguredOwner?: boolean;
  missingOwnerError?: string;
}

export function resolveCapabilityWriteSessionUserId(request: FastifyRequest): string | null {
  const sessionUserId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof sessionUserId === 'string' && sessionUserId.trim() ? sessionUserId.trim() : null;
}

export function requireCapabilityWriteOwner(
  userId: string,
  options: CapabilityWriteOwnerOptions = {},
): CapabilityWriteRouteError | null {
  const ownerId = process.env.DEFAULT_OWNER_USER_ID?.trim();
  if (!ownerId) {
    if (options.allowMissingOwner && !options.requireConfiguredOwner) return null;
    return {
      status: 403,
      error: options.missingOwnerError ?? 'Capability writes require DEFAULT_OWNER_USER_ID to be configured',
    };
  }
  if (userId !== ownerId) {
    return {
      status: 403,
      error: 'Capability writes can only be modified by the configured owner',
    };
  }
  return null;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeHostForLoopbackCheck(value: string | undefined): string {
  const raw = value?.split(',')[0]?.trim().toLowerCase() ?? '';
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : raw;
  }
  if (raw.indexOf(':') === raw.lastIndexOf(':')) {
    return raw.split(':')[0] ?? raw;
  }
  return raw;
}

function isLoopbackHost(value: string): boolean {
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function hasTrustedLocalOrigin(value: string | undefined): boolean {
  if (!value) return true;
  try {
    return isLoopbackHost(normalizeHostForLoopbackCheck(new URL(value).host));
  } catch {
    return false;
  }
}

export function isLocalCapabilityWriteRequest(request: FastifyRequest): boolean {
  if (!isLoopbackAddress(request.ip)) return false;

  // Host is client-supplied; it only narrows requests after the peer socket is loopback.
  const host = firstHeaderValue(request.headers.host) ?? request.hostname;
  const normalized = normalizeHostForLoopbackCheck(host);
  if (!isLoopbackHost(normalized)) return false;

  return hasTrustedLocalOrigin(firstHeaderValue(request.headers.origin));
}

export function containsRedactedPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(REDACTED_CAPABILITY_SECRET);
  if (Array.isArray(value)) return value.some((item) => containsRedactedPlaceholder(item));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => containsRedactedPlaceholder(item));
  }
  return false;
}
