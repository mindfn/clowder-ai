# Review Request: OpenCode ACP runtime bug fixes

Review-Target-ID: f161
Branch: feat/f161-acp-generalization

## What

Fixed the current F161 OpenCode/generic ACP runtime failures:

- OpenCode ACP now uses the effective managed runtime model (`provider/model`) for optional `session/set_config_option`, and model-selection rejection no longer aborts the invocation.
- Generic ACP now keeps `clientId: "acp"` fully user-configured: it does not infer built-in env maps from command basenames such as `kimi` or `opencode`.
- User env templates can inject third-party ACP credentials explicitly, e.g. `KIMI_API_KEY=${api_key}` / `KIMI_BASE_URL=${base_url}`, and can reference `${base_model}` when a CLI needs model env.
- OpenCode ACP spawn config keeps secrets in env, pins `small_model`, and avoids a non-null assertion in credential injection.

Touched source and tests:

- `packages/api/src/domains/cats/services/agents/providers/acp/AcpAgentService.ts`
- `packages/api/src/domains/cats/services/agents/providers/acp/AcpClient.ts`
- `packages/api/src/domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.ts`
- `packages/api/src/domains/cats/services/agents/providers/acp/types.ts`
- `packages/api/src/domains/cats/services/agents/providers/env-map.ts`
- `packages/api/src/domains/cats/services/agents/providers/opencode-acp-spawn-config.ts`
- `packages/api/src/domains/cats/services/agents/providers/opencode-config-template.ts`
- `packages/api/src/index.ts`
- matching ACP/env-map/OpenCode config tests

## Why

Runtime logs showed two distinct failures:

- OpenCode ACP reached `session/new`, but Cat Cafe sent a model value that OpenCode rejected through `session/set_config_option` (`model not found`).
- Generic Kimi ACP initialized, but `session/new` failed with `Authentication required`; the correct generic-client fix is explicit account `envVars` mapping to the Kimi CLI env names, not command-name auto-detection.

## Original Requirements

> "我想按照想把 acp 作为独立的 provider 开放出来"
> "clientId 还是 opencode；但是新增一个可选的协议 cli/acp"
> "对于已知的哪些 client 我们可以内置 client 支持的环境变量的 key 到我们内置的环境变量的 key 的映射"

- Source: `docs/features/F161-acp-carrier-generalization.md`
- Please review against the original goal: ACP transport should be reusable across known clients without hard-coding every carrier in `index.ts`.

## Tradeoff

I did not make generic `clientId: "acp"` auto-generate `OPENCODE_CONFIG` or infer any built-in client env map from `command`; generic ACP remains user-configured by design. Managed OpenCode behavior stays behind `clientId: "opencode"`.

I also made ACP model selection best-effort. If the agent advertises no compatible model option, or rejects the selection, the invocation continues with the agent default. This avoids turning an optional session preference into a fatal prompt failure.

## Architecture Ownership

Architecture cell: transport
Map delta: none
Why: this extends the existing F161 ACP carrier/client protocol and env/config mapping path; it does not add a new Store, Queue, Router, Adapter, Dispatcher, or Binding.

Please check:

- `Map delta: none` is consistent with the diff.
- OpenCode managed config still keeps secrets out of config files.
- Generic ACP command-name env inference is absent: `clientId: "acp"` uses only explicit user env templates/static envVars.
- Optional ACP model selection has the right failure semantics.

## Open Questions

### 技术 OQ

- Should OpenCode model selection remain best-effort for all `-32602` validation errors, or should some config-option failures be classified as P1 setup errors?
- No open env-boundary question: CVO clarified that generic `clientId: "acp"` must require explicit user templates/static envVars for third-party ACP commands.

### 价值 OQ

无。

## Next Action

Please review and return P1/P2/P3 findings with file/line references, or approve for the next SOP stage.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/f161/opus`
- Start Command: `pnpm review:start`
- Ports: not started by author; backend/runtime review. Current feature worktree API dogfood context was port `3212`, not a review sandbox.

## 自检证据

### Spec 合规

- F161 Phase A remains covered: generic ACP routing + env template mapping still works.
- This patch addresses Phase B runtime blockers for OpenCode ACP and keeps Kimi/generic ACP credential mapping on the explicit `envVars` path.
- No `.cat-cafe` runtime config files were modified.
- `find designs -type f -name '*.pen'` returned no matches; no UI changes.
- Root artifact gate returned no root media/design artifacts.

### Runtime Preflight

- Worktree: `/Users/lang/workspace/github/cat-cafe-f161-acp-generalization`
- Branch: `feat/f161-acp-generalization`
- Base HEAD after rebase: `877c6805e feat(F161): generalize ACP carrier runtime`
- Dirty diff under review; no push made.
- Live API process was not refreshed for this note update. Verification below is build/unit-targeted.

### Dogfood-Your-Slice

Scope verdict: required, completed without writing Cat Cafe threads/Redis.

Dogfood path:

`dist` OpenCode config generator + `AcpClient` -> real `opencode acp --pure` -> `initialize` -> `session/new` -> `session/set_config_option(model=anthropic/claude-opus-4-6)`.

Result:

- Agent: `OpenCode`
- Version: `1.17.3`
- `session/set_config_option` duration: 2 ms
- `hasError=false`
- No `model not found`

### 验证命令

- `pnpm --filter @cat-cafe/api run build` -> exit 0
- `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./scripts/with-test-home.sh node --import $(pwd)/test/helpers/setup-cat-registry.js --test --test-timeout=60000 test/env-map.test.js test/acp/acp-bootstrap-cwd.test.js test/acp/acp-client.test.js test/acp/gemini-acp-adapter.test.js test/opencode-config-template.test.js` -> 139 passed, 0 failed
- `pnpm exec biome check ... --diagnostic-level=error` on the touched source/test set -> exit 0 (`Checked 13 files`)
- `git diff --check` -> exit 0

### Gate Limitations

- `node scripts/check-hotfix-pattern.mjs` unavailable in this worktree (`MODULE_NOT_FOUND`)
- `node scripts/check-fallback-layers.mjs` unavailable in this worktree (`MODULE_NOT_FOUND`)
- `pnpm check:architecture-ownership` unavailable (`Command "check:architecture-ownership" not found`)
