/**
 * F202 W2-6b — a bounded, redacted view of an error, safe to write to the Host log.
 *
 * What a plugin (or the SDK it uses) throws can carry anything: request configs with headers,
 * credentials as properties, tokens inside URLs in its message. The logger's redaction only knows
 * fixed paths, so the raw object must never reach it. This keeps a fixed set of fields — name, code,
 * message, the top stack frames, and the same for causes and aggregated errors — and redacts every
 * piece of text before keeping it. Nothing else of the object is read, so an unknown property can
 * never be written, and a property that throws when read counts as absent.
 */
export interface SafeErrorProjection {
  readonly name: string;
  readonly code?: string | number;
  readonly message: string;
  readonly frames?: readonly string[];
  readonly cause?: SafeErrorProjection;
  readonly errors?: readonly SafeErrorProjection[];
}

const MAX_DEPTH = 4;
const MAX_ERRORS = 16;
const MAX_AGGREGATED = 5;
const MAX_FRAMES = 8;
const MAX_MESSAGE = 500;
const MAX_FRAME = 240;
const REDACTED = '[REDACTED]';

/** Where a code runs from a local file, its path and line are what the log is for; nothing else of a URL is kept. */
const LOCAL_SCHEMES = new Set(['file', 'node']);
const URL_PATTERN = /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\s'"<>()[\]{}]*)/g;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic|Digest|Token)\s+[^\s,;'"]+/gi;
const SENSITIVE_PAIR_PATTERN =
  /([\w.-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|aes[_-]?key|authorization|auth|cookie|session|signature|credential|ticket)[\w.-]*)(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&'"}\])]+)/gi;
const OPAQUE_PATTERN = /[A-Za-z0-9_+=-]{20,}/g;

function redactUrl(scheme: string, rest: string): string {
  if (LOCAL_SCHEMES.has(scheme.toLowerCase())) return `${scheme}://${rest.split(/[?#]/u, 1)[0]}`;
  const authority = rest.split(/[/?#]/u, 1)[0] ?? '';
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  return rest.length > authority.length || host !== authority
    ? `${scheme}://${host}/${REDACTED}`
    : `${scheme}://${host}`;
}

function redactCredentials(text: string): string {
  return text
    .replace(URL_PATTERN, (_match, scheme: string, rest: string) => redactUrl(scheme, rest))
    .replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(SENSITIVE_PAIR_PATTERN, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`);
}

/** A cut through a credential would keep its first part, so the word the cut falls in goes too. */
function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).replace(/\S*$/u, '')}…`;
}

/**
 * Free text: credentials, then any long opaque run mixing letters and digits (keys, tokens, JWT
 * parts). Only a bounded prefix is scanned, so a huge message costs no more than a long one.
 */
export function redactErrorText(text: string, limit = MAX_MESSAGE): string {
  const redacted = redactCredentials(bounded(text, limit * 4)).replace(OPAQUE_PATTERN, (run) =>
    /\d/u.test(run) && /[A-Za-z]/u.test(run) ? REDACTED : run,
  );
  return bounded(redacted, limit);
}

/** Stack frames are code locations V8 wrote; their file paths and lines stay, credentials do not. */
function redactFrame(frame: string): string {
  return bounded(redactCredentials(bounded(frame.trim(), MAX_FRAME * 4)), MAX_FRAME);
}

const UNREADABLE = Symbol('unreadable');

function read(target: object, key: string): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return UNREADABLE;
  }
}

/** The error's cause, if it has one that can be read. */
function causeOf(target: object): unknown {
  try {
    if (!('cause' in target)) return undefined;
  } catch {
    return undefined;
  }
  const cause = read(target, 'cause');
  return cause === UNREADABLE ? undefined : cause;
}

/** What an `AggregateError` collected (a failed start that also failed to roll back reports both). */
function aggregated(target: object): readonly unknown[] {
  try {
    if (!(target instanceof AggregateError)) return [];
    const errors: unknown = target.errors;
    return Array.isArray(errors) ? errors.slice(0, MAX_AGGREGATED) : [];
  } catch {
    return [];
  }
}

function safeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z_$][\w$]{0,63}$/u.test(value)) return fallback;
  return redactErrorText(value, 64);
}

function safeCode(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== 'string' || !/^[A-Za-z][\w.-]{0,47}$/u.test(value)) return undefined;
  const redacted = redactErrorText(value, 48);
  return redacted === value ? value : undefined;
}

function frames(stack: unknown): readonly string[] | undefined {
  if (typeof stack !== 'string') return undefined;
  const located = stack
    .split('\n')
    .filter((line) => /^\s+at\s/u.test(line))
    .slice(0, MAX_FRAMES)
    .map(redactFrame);
  return located.length > 0 ? located : undefined;
}

function primitiveMessage(value: unknown): string {
  try {
    return redactErrorText(String(value));
  } catch {
    return '';
  }
}

interface Budget {
  remaining: number;
  readonly inspected: Set<object>;
}

function project(value: unknown, depth: number, budget: Budget): SafeErrorProjection | undefined {
  if (budget.remaining <= 0) return undefined;
  budget.remaining -= 1;
  if (typeof value !== 'object' || value === null) {
    return { name: value === null ? 'null' : typeof value, message: primitiveMessage(value) };
  }
  if (budget.inspected.has(value)) return undefined;
  budget.inspected.add(value);
  const message = read(value, 'message');
  const code = safeCode(read(value, 'code'));
  const located = frames(read(value, 'stack'));
  const rawCause = depth < MAX_DEPTH ? causeOf(value) : undefined;
  const cause = rawCause === undefined ? undefined : project(rawCause, depth + 1, budget);
  const errors = (depth < MAX_DEPTH ? aggregated(value) : [])
    .map((entry) => project(entry, depth + 1, budget))
    .filter((entry): entry is SafeErrorProjection => entry !== undefined);
  return {
    name: safeName(read(value, 'name'), 'Object'),
    ...(code === undefined ? {} : { code }),
    message: typeof message === 'string' ? redactErrorText(message) : '',
    ...(located === undefined ? {} : { frames: located }),
    ...(cause === undefined ? {} : { cause }),
    ...(errors.length === 0 ? {} : { errors }),
  };
}

export function safeErrorProjection(error: unknown): SafeErrorProjection {
  return project(error, 0, { remaining: MAX_ERRORS, inspected: new Set() }) ?? { name: 'Object', message: '' };
}
