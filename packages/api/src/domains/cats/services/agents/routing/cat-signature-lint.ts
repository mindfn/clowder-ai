/**
 * F257 修复清单 #4 — message-signature structural lint (O2→O1).
 *
 * The trailing `[昵称/模型🐾]` signature is an L0 identity convention enforced
 * only by prompt text (O2 观测层). dev-7a882ba0: Fable 漏签靠 operator 人工发现 —
 * zero structural coverage. This module upgrades the convention to a
 * regex-decidable structural assertion (O1 结构强制): does an agent message end
 * with a recognized cat signature?
 *
 * Reuses the single-source-of-truth matcher `isCatSignatureLine` (F167
 * `cat-signature-strip.ts`, narrowed over many FP-reduction rounds R3–R7) —
 * this module never re-implements the regex. It is presence-only (does a
 * trailing signature exist), NOT identity-correctness (does the signature match
 * the posting cat); the latter needs per-cat nickname/model resolution (F257 #1
 * territory) and is out of scope for the minimal O1 upgrade.
 *
 * Consumed observe-only at the agent post-message seam (routes/callbacks.ts):
 * the boolean result rides on message `extra.signatureLint`, making per-message
 * sign status a structured field (queryable, denominator-bearing) instead of a
 * prose convention discovered by eye. Non-blocking by design: record a miss,
 * never reject a persisted user-visible message.
 *
 * SCOPE — two-phase (F257 owner vision-guardian review 2026-07-20; AC 完成 ≠
 * feature 完成). This module + the post seam are the **detection layer** (O1
 * structural detection, message-level observable). The harness **ledger closure**
 * — auto-emitting a deviation on miss, attributed to `obj-identity-integrity`,
 * so signature-miss rate/trend becomes ledger-observable (automating the manual
 * `report_harness_signal` that recorded dev-7a882ba0) — is DEFERRED to after #3
 * (objective registry). Why deferred: the harness ledger reads
 * DeviationEventLog / GuardRejectionEventLog / eval verdicts, NOT `message.extra`;
 * a correct deviation needs a *registered* objective (else it reintroduces the
 * free-string-objective archaeology #3 fixes) + the segment/condition attribution
 * infra of the #2/#3 data root. `extra.signatureLint` is the interim detection
 * observable — NOT the ledger closure; do not read extra-only as "#4 complete".
 */

import { isCatSignatureLine } from './cat-signature-strip.js';

export interface SignatureLintResult {
  /** true iff the last non-blank line is a recognized cat signature. */
  signed: boolean;
  /** the matched signature line (trimmed) when signed; null otherwise. */
  signatureLine: string | null;
}

const UNSIGNED: SignatureLintResult = { signed: false, signatureLine: null };

/**
 * Structurally lint whether `text` ends with a trailing cat signature.
 *
 * Walks from the last line backwards skipping blank lines; the first non-blank
 * line decides. A signature that is NOT trailing (content follows it) does not
 * count — the L0 convention is that the signature is the final line, and the
 * routing strip walker (`stripTrailingCatSignatures`) uses the same tail-anchored
 * rule.
 */
export function lintCatSignature(text: string): SignatureLintResult {
  if (!text) return UNSIGNED;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue; // skip trailing blank lines
    return isCatSignatureLine(line) ? { signed: true, signatureLine: line.trim() } : UNSIGNED;
  }
  return UNSIGNED; // all-blank / empty
}

/**
 * Post-seam projection: the observe-only `extra.signatureLint` fragment for a
 * message. Empty for blank/whitespace content — pure-media posts carry no text
 * signature, so they get no lint verdict and stay out of the sign-rate
 * denominator. Spread into the message `extra` bag at the post-message seam so
 * the branch-complexity stays out of the (already large) callback handler.
 */
export function signatureLintExtra(text: string): { signatureLint?: { signed: boolean } } {
  if (!text.trim()) return {};
  return { signatureLint: { signed: lintCatSignature(text).signed } };
}
