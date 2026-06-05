# Review Request — Continuation Auto Resume

Review-Target-ID: fix-continuation-auto-resume
Branch: fix/continuation-auto-resume
Author: 砚砚 / gpt-5.5

## Original Requirement

Source: thread_mojzvgzxmmd2lbgu live incident investigation.

铲屎官现场要求: "未处理完触发压缩必须续".

Observed failure chain: Codex session sealed at threshold, QueueProcessor wrote pending continuation, but production `threadStore` path stayed passive and waited for a later trigger. A following manual `@codex 继续` was needed.

## What Changed

- `QueueProcessor` now treats seal capsules as store-and-resume: it keeps durable pending continuation in `threadStore` and also enqueues bounded auto continuation.
- Failed/canceled executions that already produced a continuation capsule now bypass the ordinary 10s failed-slot pause for continuation entries.
- Pending continuation consumption avoids duplicate bootstrap prompts when the queued continuation entry already carries the same capsule.
- `CodexAgentService` no longer suppresses Codex exit code 1 as a benign quirk when recent stream diagnostics show compact/stream-disconnect failure.

## Review Focus

- Please check that the failed/canceled branch only bypasses pause for `sourceCategory: 'continuation'` auto entries and does not reopen generic failed-work auto-resume.
- Please check the prompt de-duplication condition based on `continuationKey`; same capsule should not duplicate, different capsule should still prepend pending context.
- Please check the Codex exit-1 suppression carve-out: ordinary substantive-output exit 1 remains suppressed, compact failure surfaces as an error.

## Self-Check Evidence

- `pnpm --dir packages/api run build` → pass.
- `pnpm --dir packages/api run lint` → pass (`tsc --noEmit`).
- `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --import $(pwd)/packages/api/test/helpers/setup-cat-registry.js --test --test-timeout=60000 packages/api/test/queue-processor.test.js` → 85/85 pass.
- `pnpm --dir packages/mcp-server run build` → pass; required before full Codex provider test because new worktree initially lacked `packages/mcp-server/dist`.
- `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --import $(pwd)/packages/api/test/helpers/setup-cat-registry.js --test --test-timeout=60000 packages/api/test/codex-agent-service.test.js` → 46/46 pass.
- `git diff --check` → pass.
- Artifact hygiene: root media/design worktree and diff checks returned no matches.

## Changed Files

- `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts`
- `packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts`
- `packages/api/test/queue-processor.test.js`
- `packages/api/test/codex-agent-service.test.js`

## Open Questions

- None from author. Reviewer should decide whether the compact failure regex should be hoisted into shared CLI diagnostics reason codes in a follow-up, or stay provider-local for this bug fix.
