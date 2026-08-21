# M0 Host Messaging Delivery Plan

**Feature:** F288 — `docs/features/F288-plugin-messaging-domain.md`

**Goal:** Ship a reviewable, dormant Host implementation of the seven M0 messaging rows that consumes the published contract and keeps K-1 as the only message, ledger, cursor, and snapshot truth source.

**Acceptance Criteria:** AC-A4 plus the M0-C/M0-D roadmap gates: exact beta pins; contract-owned validation; seven Host routes; durable Memory/Redis cursor recovery; stdio Host delivery; dormant production composition; exact-SHA review; and the canonical 18-case joint run.

**Architecture cell:** `plugin`

**Map delta:** none

**Map delta why:** This extends the existing Host Broker, supervised stdio runtime, and `createMessagingDomain(...)` seam already owned by the plugin cell; it adds no registry, state machine, process manager, or transport cell.

**Architecture:** The Broker validates and authorizes contract-native frames, then delegates stateful behavior to the absorbed K-1 MessagingDomain. The external runtime carries correlated Host requests over the existing supervised stdio transport. Production composition constructs these seams but does not expose activation or start a package.

**Tech Stack:** TypeScript, Node.js test runner, Redis/Lua, JSON-RPC over stdio, pnpm, `@clowder-ai/plugin-contract@0.1.0-beta.11`, `@clowder-ai/plugin-sdk@0.1.0-beta.7`
**前端验证:** No — this slice adds no UI or user-visible activation surface.

---

## Finish line

The Host PR is ready when one exact upstream-based Host SHA has passed the full
local gate and independent review, and can be paired with plugins merge
`a0b3554d5ebbe71a9043bbb63cca5bf5dcba74b5` for the canonical 18-case joint
acceptance run.

This delivery does **not** activate a production plugin, modify runtime config,
publish packages, move registry tags, add a local fixture matrix, or close M0-D.

## Terminal public shape

- Contract and SDK remain the only wire/type source; core contains Host-internal
  aliases and adapters, not a public contract mirror.
- The Broker exposes exactly:
  `messaging.send`, `messaging.appendElements`, `messaging.subscribe`,
  `messaging.read`, `messaging.ack`, `messaging.snapshot`, and
  `host.messaging.deliver`.
- K-1 owns authorization, message mutation, idempotency settlement, durable
  event cursors, stale recovery, and snapshot truth.
- The Broker owns frame admission, dispatch intent, call correlation, and
  transport settlement.
- The stdio supervisor owns process lifecycle and correlated Host request
  delivery; it cannot fabricate a domain receipt.
- Production composition is dormant: construction is permitted, activation and
  package start are not.

## Stateful object census

### 1. Subscription and snapshot view

**Lifecycle owner:** `MessagingService` plus `CursorStore`.

| State | Event | Next state | Required behavior |
|---|---|---|---|
| live | `read` | live | advance delivered watermark only |
| live | stale cursor | stale | reject normal read with `STALE_CURSOR` |
| stale | `snapshot` | snapshot-active | persist stable fence and first-page entitlement |
| snapshot-active | valid next-page token | snapshot-active/final-ready | consume token once and issue only the next entitlement |
| snapshot-active | replay/tamper/wrong offset | unchanged | fail closed with zero cursor movement |
| final-ready | final ack | live | atomically advance ack to the frozen resume sequence |
| any | handle/subscription revoke | revoked | reject read, page, and ack |

**Invariants:**

- INV-H1: Page tokens are stateful, single-use entitlements, not editable
  base64 offsets.
- INV-H2: Ack cannot advance before the frozen view has been traversed.
- INV-H3: Snapshot identity and cursor state survive restart with Memory/Redis
  behavioral parity.
- INV-H4: A revoked or cross-subscription token has zero side effects.

**Adversarial tests:** tampered offset, replayed token, fabricated final ack,
cross-subscription token, Redis restart/reload, and final-page crash window.

### 2. Broker call settlement

**Lifecycle owner:** existing Host Broker control plane; product settlement owner
is K-1.

| State | Event | Next state | Required behavior |
|---|---|---|---|
| admitted | unauthorized method/grant | rejected | no domain invocation |
| admitted | dispatch persisted | in-flight | call K-1 exactly through the registered handler |
| in-flight | canonical K-1 receipt | settled | return that receipt without a second product ledger |
| in-flight | ambiguous transport failure | recovering | consult canonical domain settlement before redispatch |
| settled | retry | settled | return canonical result; never double-settle |

**Invariants:**

- INV-H5: Only rows ready in beta.11 may dispatch.
- INV-H6: Frame identity and effective grants are Host-bound, never plugin
  self-report.
- INV-H7: Broker settlement cannot replace or race K-1 idempotency truth.
- INV-H8: Malformed, denied, expired, and cross-instance calls are zero-effect.

**Adversarial tests:** denied grant, malformed closed input, deadline expiry,
cross-instance handle, duplicate idempotency key/operation ID, and recovery after
ambiguous effect.

### 3. Stdio Host delivery request

**Lifecycle owner:** `ExternalPluginSupervisor` and
`StdioBrokerTransport`.

| State | Event | Next state | Required behavior |
|---|---|---|---|
| running | Host delivery request | pending | allocate correlation ID and write one JSON-RPC frame |
| pending | matching result | running | resolve exactly one waiter |
| pending | wrong method/ID or malformed result | unchanged/rejected | do not settle another waiter |
| pending | process close/drain | failed | reject with method-specific stable error |
| not running | delivery request | rejected | fail closed; never auto-start |

**Invariants:**

- INV-H9: Correlation is method- and request-ID-specific.
- INV-H10: Delivery failure uses `DELIVERY_REJECTED`, not heartbeat semantics.
- INV-H11: Invalid plugin output cannot crash the Host or settle another call.
- INV-H12: Composition remains dormant without explicit activation authority.

**Adversarial tests:** wrong correlation ID, mismatched method, malformed frame,
process exit with pending delivery, drain race, and delivery while stopped.

## Work and delivery tasks

### Task 1: Preserve RED evidence and pin the published boundary — complete

**Files:**

- Modify: `packages/api/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `packages/api/test/plugin-messaging-source-admission.test.js`

1. Record failing scalar, unsafe-integer, historical-value, and not-ready-row
   witnesses against the previous package.
2. Pin contract beta.11 and SDK beta.7 exactly; verify the lockfile integrities.
3. Run the source-admission test and API build; expect GREEN.
4. Commit the RED evidence and package admission separately.

### Task 2: Close the six plugin-to-Host messaging routes — complete

**Files:**

- Create: `packages/api/src/domains/plugin/host-broker/messaging-handler.ts`
- Modify: `packages/api/src/domains/plugin/host-broker/control-plane.ts`
- Modify: `packages/api/src/domains/plugin/host-broker/types.ts`
- Modify: `packages/api/src/domains/plugin/host-broker/index.ts`
- Test: `packages/api/test/plugin-host-broker-messaging.test.js`

1. Add failing authorization, closed-input, canonical-settlement, and recovery
   tests for send/append/subscribe/read/ack/snapshot.
2. Register one narrow handler adapter per contract method.
3. Keep domain settlement authoritative; do not add a Broker product ledger.
4. Run the focused Broker suite; expect all vectors GREEN.

### Task 3: Make snapshot paging restart-safe and fail closed — complete

**Files:**

- Create: `packages/api/src/domains/messaging/snapshot-tokens.ts`
- Create: `packages/api/src/domains/messaging/stores/memory-cursor.ts`
- Modify: `packages/api/src/domains/messaging/event-stream.ts`
- Modify: `packages/api/src/domains/messaging/stores/ports.ts`
- Modify: `packages/api/src/domains/messaging/stores/redis-cursor.ts`
- Modify: `packages/api/src/domains/messaging/stores/redis-keys.ts`
- Test: `packages/api/test/plugin-messaging-snapshot*.test.js`

1. Write RED tests for page-token tamper, replay, fabricated final ack, and
   Redis parity.
2. Persist one frozen snapshot view and one current page entitlement.
3. Consume page entitlements atomically; issue the next entitlement only after
   a valid consume.
4. Allow final ack only after traversal completion.
5. Run Memory and isolated Redis suites; expect parity.

### Task 4: Close `host.messaging.deliver` over existing stdio — complete

**Files:**

- Modify: `packages/api/src/domains/plugin/external-runtime/stdio-broker-transport.ts`
- Modify: `packages/api/src/domains/plugin/external-runtime/supervisor.ts`
- Modify: `packages/api/src/domains/plugin/external-runtime/types.ts`
- Test: `packages/api/test/plugin-host-messaging-deliver-stdio.test.js`

1. Write RED tests for correlation, malformed result, pending-close rejection,
   and stopped execution.
2. Reuse the supervised transport pending-request mechanism.
3. Add method-specific `DELIVERY_REJECTED` closure semantics.
4. Run the external-runtime and delivery suites; expect GREEN.

### Task 5: Wire dormant composition — complete

**Files:**

- Modify: `packages/api/src/domains/plugin/runtime-composition.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/test/plugin-runtime-composition*.test.js`

1. Require the shared `messageStore`; accept the existing Redis dependency.
2. Construct `MessagingDomain` and register the seven handlers.
3. Expose the internal messaging seam without adding an activation route or
   starting a package.
4. Assert construction is side-effect-free.

### Task 6: Produce one upstream-clean exact Host SHA — in progress

1. Fetch `upstream/main` and rebase the three feature commits onto it.
2. Verify `git rev-list --left-right --count upstream/main...HEAD` is `0 3`.
3. Verify range-diff preserves all three feature patches.
4. Run:

   ```sh
   cd /Users/lang/workspace/github-lab/cat-cafe-m0-host-messaging
   bash scripts/pre-merge-check.sh --no-rebase
   ```

   `--no-rebase` is required because the repository gate is intentionally bound
   to fork `origin/main`, while this contribution targets upstream. The upstream
   base is checked independently in steps 1–3.
5. Re-run the focused 261-case suite and isolated Redis snapshot suite if the
   gate changes the checkout.
6. Record the exact SHA, commands, counts, and any baseline-only warning in the
   quality report.

### Task 7: Independent review and upstream PR — pending

1. Route the exact Host SHA to a non-author, cross-family reviewer.
2. Require explicit P1/P2/P3 verdicts for authorization, snapshot lifecycle,
   Redis atomicity, stdio correlation, and dormant composition.
3. Fix findings Red→Green; any SHA change invalidates the previous verdict.
4. After approval, push the feature branch and open one upstream PR.
5. Immediately register PR tracking; do not self-approve or self-merge.
6. Iterate cloud and maintainer review until the exact PR head is green and
   approved.

### Task 8: Canonical two-SHA joint acceptance — pending and separate

1. Freeze the merged plugins SHA
   `a0b3554d5ebbe71a9043bbb63cca5bf5dcba74b5` and the final reviewed Host SHA.
2. Select the canonical 18 vector IDs from the contract fixture catalog; do not
   copy them into a Host-local matrix.
3. Run the compiled standalone plugin against the real dormant Host seam in an
   isolated acceptance environment.
4. Prove success and all fail-closed cases, including crash isolation, stale
   recovery, ack-before-crash redelivery, retained state, deadline expiry,
   denied grants, and cross-instance rejection.
5. Publish an integrity report containing both SHAs, package versions and
   digests, environment isolation, vector results, and non-claims.

### Task 9: M0-D release readiness — not part of this Host PR

Deliver separately:

- formal `0.1.0` compatibility decision;
- API reference and plugin developer guide;
- package loading/running contract;
- owner-facing UI and configuration capability;
- explicit runtime activation authority;
- first-party/third-party same-power assertion and production dogfood.

M0 closes only after the roadmap's complete M0-D verdict; beta publication,
Host merge, or an 18-case local loopback cannot close it alone.

## Verification ledger

| Evidence | Required result |
|---|---|
| API build | exit 0 |
| Focused Host/messaging/external-runtime suite | 261/261 pass |
| Isolated Redis snapshot suite | 2/2 pass |
| `git diff --check upstream/main...HEAD` | no output |
| Hotfix classifier scoped to upstream | `hotfix:false` |
| Fallback-layer audit | boundary discriminants explained; no recovery stack |
| Full local gate with `--no-rebase` | exit 0 |
| Independent exact-HEAD review | APPROVE, no open P1/P2 |
| Joint acceptance | all canonical 18 vectors plus M0-D fail-closed matrix |
