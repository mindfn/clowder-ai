---
tips_exempt: K-2E1 is an internal dormant migration authority fence with no owner-facing action or rendered UI
---

# K-2E F202/F240 Connector Migration Implementation Plan

> **Feature:** F202 / K-2E
> **Date:** 2026-08-31
> **Owner:** @cat-eqdvbcxw
> **Review owner:** @opus
> **Base:** `upstream/main@090626a538d59e2b6ce3c3ba9b205b57d958fcdd`

**Architecture cell:** `plugin`
**Map delta:** none
**Why:** K-2E extends the existing F202 Host/F240 connector boundary with one
internal migration authority object. It does not create a new ownership cell or
move an existing public boundary.

## Finish line

An externally installed F240 connector can move from the legacy in-process
`IMConnectorPlugin` loader to the K-2 Host Broker without losing its package,
configuration, operation state, connector bindings, permission state, or
messaging state. The move is copy-and-verify before cutover, uses one explicit
durable authority fence, and can recover or roll back without deleting the old
authority. Settings projects the connector once and reports which runtime owns
it.

K-2E does not migrate built-in connectors, invent a second public plugin
contract, activate a plugin without owner intent, or use F292 as a messaging
consumer. F292 already exercises `events.publish`; a migrated F240 external
connector is the first production consumer of the K-1 messaging rows.

## Grounded scope correction

The handoff proposed K-2C as the next slice. Current source truth shows that
would duplicate merged work:

- PR #1380 (`31105179e1da...`) composed the real messaging facade into the Host
  Broker and exposed all seven messaging methods while keeping the runtime
  dormant.
- PR #1410 (`090626a538d5...`) pinned the current published contract/SDK and ran
  all 18 signed cases through production Host seams.
- `docs/features/F292-feishu-meeting-intake-plugin.md` records a live alpha.8
  official plugin using `events.publish`; it is not a pending activation route
  and does not consume K-1 messaging.
- `docs/plans/2026-07-17-k2-host-broker-design-preparation.md` names K-2E as
  the remaining F202/F240 migration adapter.

Therefore AC-A4's re-pin/runtime prerequisite is ready. The unchecked part is
production reachability through an actual messaging consumer, which K-2E owns.
The old beta.3/manual-mirror task text is stale tracking debt, not a code gate.

## Truth-source matrix

| Concern | Write authority | Read/projection consumer | K-2E rule |
|---|---|---|---|
| Legacy connector package | `.cat-cafe/plugins/<id>/` | F240 loader/routes | Preserve until an explicit post-soak owner action; never delete during migration |
| Legacy connector config and operation state | `.cat-cafe/im-connector-config/<id>.json` | F240 config/action routes | Copy exact three-state values and `_operations`; verify before cutover |
| Host package/install/grant/runtime | `.cat-cafe/plugin-host/inventory.json` | K-2 supervisor/Broker | Reuse existing inventory; no parallel package or grant mirror |
| Runtime authority during migration | `.cat-cafe/plugin-host/connector-migrations.json` | migration coordinator + Settings projection | One explicit revision-fenced record; never infer authority from runtime health |
| Connector thread bindings and permissions | Redis connector stores | ConnectorRouter/Host handle issuer | Preserve in place; migration records only a verified fingerprint/watermark |
| K-1 handles/cursors/ledger/replay/append | K-1 stores | Host messaging facade | Reuse in place; no copy and no deletion |
| Public wire shapes and grants | exact `@clowder-ai/plugin-contract` pin | Host + plugin SDK | Import only; no core-local mirror |

## Invariants

1. **Legacy authority is the default.** Discovery alone cannot start a Host
   process or stop the F240 connector.
2. **Authority is explicit.** `legacy` or `host` comes from a durable migration
   record and is never inferred from `activationState`, PID, or health.
3. **Copy before cutover.** A connector can enter Host authority only after its
   package/config/operation/binding/permission evidence matches the exact
   fingerprint frozen for the migration revision.
4. **One current operation.** Optimistic revision fencing rejects stale,
   duplicate-conflicting, and concurrent transition attempts.
5. **Crash-safe normalization.** Restart during copy/verify/cutover returns to
   legacy authority with a typed interrupted state; it never guesses that the
   Host owns traffic.
6. **No destructive cleanup.** Migration and rollback never remove the legacy
   package, config, audit, bindings, K-1 state, or retained Host archive.
7. **No double-run.** The coordinator cannot commit Host authority while the
   legacy runtime is observed live, and cannot resume legacy while the Host
   runtime still owns the connector lease.
8. **Owner intent is preserved.** A disabled legacy connector remains disabled;
   a migration does not auto-enable it.
9. **Projection is singular.** Settings renders one connector identity with an
   authority/migration facet, not separate F240 and K-2 cards.
10. **Secrets stay opaque.** Fingerprints cover bytes/versions without placing
    raw credential values in the migration record, logs, or API response.

## Persistent object census

| Object | Durable? | Retention | Authority | Recovery rule |
|---|---|---|---|---|
| `ConnectorMigrationRecord` | yes | TTL=0 | K-2E migration store | Parse closed schema; normalize interrupted phases to legacy authority |
| F240 package/config/operation state | existing durable | TTL=0 | existing F240 stores | Never mutated by K-2E1; later copy is additive |
| K-2 package/instance/grant | existing durable | TTL=0 | Host inventory | Shadow install is disabled/stopped until cutover |
| Connector bindings/permissions | existing durable Redis | TTL=0 | connector stores | Fingerprint and reuse; never re-key during K-2E |
| K-1 messaging state | existing durable | TTL=0 | messaging domain | Reuse without migration |

## Migration state machine

`runtimeAuthority` and `phase` are orthogonal. The initial record is
`legacy/observed`; only `beginCutover` may change authority to `host`.

| Current | Event | Preconditions | Next | Side effects |
|---|---|---|---|---|
| none | observe | valid external F240 identity | `legacy/observed`, rev 1 | Persist non-secret source fingerprint |
| `legacy/observed` or `legacy/interrupted` | reconcile observation | expected revision matches | `legacy/observed`, rev + 1 | Persist the latest observation and clear interrupted state before retry |
| `legacy/observed` | begin shadow | expected revision/fingerprint match | `legacy/copying` | Freeze migration fingerprint |
| `legacy/copying` | copy verified | exact staged bytes + data evidence match | `legacy/shadow-ready` | Bind Host instance/digest and evidence |
| `legacy/shadow-ready` | commit cutover | legacy stopped, Host stopped, owner intent present, revision match | `host/activating` | Advance authority fence before Host start |
| `host/activating` | Host healthy | exact instance/session/lease match | `host/active` | Project success |
| `host/activating` | Host start fails | exact instance match | `legacy/rollback-required` | Keep all copied state; no legacy restart inside transaction |
| `host/active` | begin rollback | explicit owner action + revision match | `legacy/rollback-required` | Fence Host authority before stopping child |
| `legacy/rollback-required` | legacy restored | Host stopped, legacy health verified | `legacy/observed` | Preserve shadow package for later retry |
| any nonterminal transition | Host restart | persisted phase is interrupted | `legacy/interrupted` | Fail closed to legacy authority; require reconciliation |

Invalid events, stale revisions, mismatched fingerprints, missing Host
instances, and double-run observations fail closed without a write.

## Delivery slices

### K-2E1 — durable authority fence and unified projection (this PR)

This is a complete safety boundary, not a temporary format:

- Add the closed `ConnectorMigrationRecord` schema, memory/file store, atomic
  file writes, revision fencing, and restart normalization.
- Add a coordinator for observe/begin-shadow/mark-shadow-ready/cutover-result/
  rollback-result transitions. No transition starts or stops a process yet.
- Add a pure projection that joins F240 external connector metadata, Host
  inventory, and migration truth into one connector Settings record.
- Wire read-only projection into `/api/connector/status`; existing clients
  remain compatible because the new `runtimeAuthority` and `migration` fields
  are additive.
- Do not add a mutation route, package adapter, or automatic migration.

Expected files:

- `packages/api/src/domains/plugin/connector-migration/types.ts`
- `packages/api/src/domains/plugin/connector-migration/snapshot.ts`
- `packages/api/src/domains/plugin/connector-migration/stores.ts`
- `packages/api/src/domains/plugin/connector-migration/control-plane.ts`
- `packages/api/src/domains/plugin/connector-migration/projection.ts`
- `packages/api/src/domains/plugin/connector-migration/index.ts`
- `packages/api/src/domains/plugin/runtime-composition.ts`
- `packages/api/src/routes/connector-hub.ts`
- `packages/shared/src/types/connector.ts`
- `packages/api/test/plugin-connector-migration.test.js`
- `packages/api/test/plugin-connector-migration-restart.test.js`
- `packages/api/test/connector-status.test.js`

### K-2E2 — legacy package adapter and copy/verify

- Build a Host-owned adapter package that wraps `IMConnectorPlugin` in a child
  process without admitting legacy same-power `import()` into the API process.
- Convert `connector.yaml` to one contract-valid package manifest, preserve
  operation metadata as Host-owned config schema, and archive exact bytes under
  a canonical SHA-512 SRI.
- Copy config/operation state, verify binding/permission watermarks, install one
  disabled/stopped shadow instance, then call `markShadowReady`.
- Use a synthetic external connector fixture for the first end-to-end proof;
  never reuse files from another worktree or runtime data.

### K-2E3 — owner cutover, real messaging consumer, and rollback

- Add owner-confirmed mutation routes and Settings actions.
- Stop legacy ingress before advancing the authority fence; start the exact Host
  instance after the fence; reconcile either success or rollback.
- Exercise `messaging.send`, subscription/read/ack, and append through the
  supervised connector adapter while preserving ConnectorRouter and outbound
  degradation behavior.
- Validate in a feature checkout, then co-creator acceptance and fork soak
  before upstream merge progression.

## K-2E1 TDD sequence

1. **RED — authority cannot be guessed**
   - Add `plugin-connector-migration.test.js` for observe, revision fencing,
     shadow readiness, and explicit cutover authority.
   - Run:
     `pnpm --filter @cat-cafe/api build && node --test packages/api/test/plugin-connector-migration.test.js`
   - Expected first failure: connector-migration module is absent.
2. **GREEN — schema/store/control plane**
   - Implement types, strict parser, memory/file stores, and transitions.
   - Re-run the focused test.
3. **RED — crash normalization and corrupt snapshot**
   - Add restart cases for `copying`, `activating`, future schema, unknown fields,
     and atomic-write failure.
4. **GREEN — recovery**
   - Normalize only interrupted phases; preserve terminal authority and revision.
5. **RED/GREEN — projection**
   - Add API and shared type tests proving one connector record, additive fields,
     no secrets, and no inference from Host health.
6. **Refactor and gates**
   - `pnpm --filter @cat-cafe/api lint`
   - `pnpm --filter @cat-cafe/api build`
   - focused migration + connector-status tests
   - `pnpm test`

## Existing behavior protections

- Built-in connectors retain the current F240 loader and status shape.
- External connectors continue to load in-process until an owner-confirmed
  later K-2E3 cutover; K-2E1 is read-only with respect to their runtime.
- Connector config tombstones and `_operations` remain byte-for-byte owned by
  the existing config store.
- F292 official plugin install/auth/enable/repair/history/catch-up paths remain
  untouched.
- K-1/K-2 broker tests remain the authority for messaging and transport.
- No `.env`, runtime worktree, Redis data, or existing F240 worktree is changed.

## Review and release gates

- K-2E1 requires non-author review by @opus at the exact final HEAD.
- Any mutation/cutover slice must add crash, concurrency, restore, and side-route
  tests before implementation is considered complete.
- Co-creator feature-checkout acceptance and fork soak remain hard gates before
  upstream merge progression.
