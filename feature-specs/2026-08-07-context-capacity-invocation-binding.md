# Context Capacity Invocation Binding Implementation Plan

**Feature:** Issue #1208 — Context limit / session-chain capacity owner
**Goal:** Make one invocation snapshot consume the concrete provider model and become lifecycle-actionable only after the same window is proven on that invocation's carrier.
**Acceptance Criteria:** The effective model/window is identical in prompt budgeting, context health, lifecycle decisions, and native provider configuration; catalog Auto never becomes actionable from capability flags alone; OpenCode native-auth invocations apply the exact snapshot window before provider launch; ACP model overrides feed both capacity resolution and the spawned carrier.
**Architecture cell:** `identity-session`
**Map delta:** none
**Map delta why:** This review closure tightens the existing provider/session binding contract without changing cell ownership.
**Architecture:** Separate static carrier capability from concrete invocation binding. A service-created binding proves model/window already applied at carrier construction; a per-invocation binding proof is created only after native config is successfully written, and the immutable snapshot is projected forward before the provider is launched.
**Tech Stack:** TypeScript, Node test runner, ACP process pools, OpenCode per-invocation JSON config
**前端验证:** No

---

## Finish line

At provider launch, the model used to resolve capacity and the window admitted for automatic lifecycle action are the exact model/window carried by that provider invocation. We are not adding a persistent binding record, a second capacity resolver, account-level window configuration, or a new Hub control.

## Terminal schema

```ts
interface AgentContextBinding {
  readonly model?: string;
  readonly windowTokens?: number;
  readonly source: 'service_spawn' | 'invocation_config';
}

interface InvocationCapacitySnapshot {
  readonly capacity: ResolvedContextCapacity;
  readonly capability: AgentContextCapability;
  readonly binding?: AgentContextBinding;
  readonly memberWindowTokens: number | null;
  readonly model: string | undefined;
}
```

`AgentContextBinding` is a pure, invocation-scoped proof. It is never stored independently. A later transition returns a new snapshot instead of mutating the old one.

## Stateful object census

1. **Concrete carrier binding** — lifecycle owner: the concrete `AgentService` or the per-invocation native-config writer. Registry/catalog readers may not synthesize an applied window.
2. **Invocation capacity snapshot** — lifecycle owner: routing creates it once; trusted provider observations or native binding proofs return a refined copy. Provider code consumes the same copy through `AgentServiceOptions.contextCapacity`.
3. **Persisted context health** — lifecycle owner: `SessionChainStore`; only authoritative current-context usage may update it. Binding proof does not alter or replace usage truth.
4. **OpenCode runtime config** — lifecycle owner: `invokeSingleCat`; it is created before provider launch and removed in the existing `finally`. Instructions-only config cannot claim window enforcement.

## State × event transition table

| State | Event | Next state | Owner / required evidence | Forbidden bypass |
|---|---|---|---|---|
| Service unbound | Registry constructs ACP service | Service-bound model and optional spawn window | `AcpServiceFactory` resolves one effective model, applies it to bootstrap/context policy, and passes the resulting binding into `AcpAgentService` | Reading `config.defaultModel` again in the snapshot |
| Route start | Resolve invocation snapshot | Snapshot with concrete model; catalog remains provisional unless the service exposes an equal already-applied window | `resolveInvocationCapacitySnapshot` | Upgrading catalog from `nativeWindowControl=true` alone |
| OpenCode snapshot provisional | Full native runtime config writes the exact model/window | Snapshot refined with `invocation_config` binding and catalog may become actionable | `invokeSingleCat` after atomic config write succeeds | Treating the fallback instructions-only path as window proof |
| OpenCode config cannot carry exact binding | Continue only with unresolved/non-actionable lifecycle state, or fail the invocation for existing mandatory config failures | No proof transition | `invokeSingleCat` | Guessing from provider family, account type, or known-model catalog |
| Bound snapshot + stored exact usage | Pre-provider lifecycle gate | Seal old session or continue | `sealBeforeInvocationIfNeeded`, before `service.invoke` | Launching the provider before a required seal completes |
| Active invocation | Trusted runtime window report | New snapshot refined/shrunk for this invocation | `applyReportedWindowToInvocationSnapshot` | Re-reading member config or silently expanding a pinned active invocation |
| Invocation end | Cleanup | Binding proof discarded; only existing authoritative context health persists | Existing invocation cleanup / `SessionChainStore` | Persisting a second binding cache or reusing proof on the next invocation |

## Invariants and test matrix

- **INV-1 — Concrete model identity:** `snapshot.model` equals the logical model the concrete carrier executes. Test: ACP env override changes bootstrap/session model, context policy, and snapshot catalog together.
- **INV-2 — Exact window equality:** catalog capacity is actionable only when `binding.windowTokens === capacity.windowTokens`. Test: missing or mismatched binding stays provisional.
- **INV-3 — Same-invocation proof:** generic `nativeWindowControl` and authoritative telemetry flags are insufficient without a binding proof from this service spawn/config write. Test: a capable OpenCode service without a proof stays non-actionable.
- **INV-4 — Native-auth path closure:** OpenCode's synthesized builtin OAuth account writes a native config containing the snapshot window before launch. Test: captured `OPENCODE_CONFIG` includes `limit.context` and the lifecycle snapshot becomes actionable.
- **INV-5 — Pre-provider seal ordering:** when newly actionable catalog capacity plus stored exact usage crosses the threshold, session seal/clear/finalize completes before `service.invoke`. Test: invocation call order records the seal before provider entry.
- **INV-6 — Fail closed on mismatch/failure:** config-write failure or model/window mismatch creates no binding proof and cannot enable automatic handoff. Test: writer failure aborts; mismatched proof remains non-actionable.
- **INV-7 — Pure projection:** no binding proof is serialized to Redis or reused by the next invocation. Test: snapshot functions return new objects and persistence fixtures remain unchanged.

## Adversarial scenarios

- Environment model override differs from catalog `defaultModel` on an ACP member.
- OpenCode subscription uses its synthesized builtin OAuth account and must not rely on instructions alone for window proof.
- OpenCode runtime config writes a different window than the snapshot.
- Runtime config write throws after L0 creation but before provider launch.
- Member configuration changes concurrently after snapshot creation.
- Runtime reports a smaller exact window after a provisional catalog binding.

### Task 1: Define binding proof and fail-closed resolver behavior

**Files:**
- Modify: `packages/api/src/domains/cats/services/types.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invocation-capacity-snapshot.ts`
- Test: `packages/api/test/config/invocation-capacity-snapshot.test.js`

1. Add RED tests for INV-2 and INV-3.
2. Run the focused snapshot test and verify the generic-capability case fails.
3. Add the binding proof type and equality-gated snapshot projection.
4. Re-run the focused test to GREEN.

### Task 2: Bind ACP to one effective model

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/providers/acp/AcpServiceFactory.ts`
- Modify: `packages/api/src/domains/cats/services/agents/providers/acp/AcpAgentService.ts`
- Test: `packages/api/test/acp/acp-service-factory.test.js`

1. Add a RED regression with `CAT_<CATID>_MODEL` differing from `defaultModel`.
2. Assert bootstrap arguments, session model, context policy, and exposed binding agree.
3. Resolve the effective model once in factory construction and pass the applied binding to the service.
4. Re-run ACP factory/pool signature tests to GREEN.

### Task 3: Close the OpenCode subscription binding path

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- Test: `packages/api/test/invoke-single-cat.test.js`

1. Add a RED invocation regression for the synthesized builtin OAuth account with a resolvable provider/model and catalog capacity.
2. Assert the generated config carries the same model/window and provider entry contains `limit.context`.
3. Keep native-auth invocations on the full runtime-config branch without credential placeholders.
4. Apply the binding proof only after the config file write succeeds.
5. Run the pre-provider lifecycle gate after that transition and before `service.invoke`.
6. Re-run focused OpenCode/invocation suites to GREEN.

### Task 4: Failure-mode audit and delivery

**Files:**
- Verify all files above plus existing context-capacity, routing, ACP, OpenCode, and session-chain suites.

1. Run the focused snapshot, ACP factory, OpenCode config, and invocation tests.
2. Run the wider capacity resolver/provider/session-chain failure-mode matrix.
3. Run Biome and TypeScript build checks; inspect fallback-layer growth and `git diff --check`.
4. Commit with a Why body and run exact-HEAD full `pnpm gate --no-rebase` after confirming current `origin/main` ancestry.
5. Push normally, reply/resolve only the two exact-`f80474a80` findings, retrigger cloud review, and register the next CI/review event wait.
