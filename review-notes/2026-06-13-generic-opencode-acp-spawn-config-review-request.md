# Review Request: Generic OpenCode ACP spawn config pinning

Review-Target-ID: f161
Branch: feat/f161-acp-generalization

## What

Fixed the generic ACP OpenCode path so `clientId: "acp"` with `acp.command: "opencode"` receives the same spawn-scoped OpenCode runtime config as the fixed OpenCode ACP client.

Touched files:

- `packages/api/src/domains/cats/services/agents/providers/opencode-acp-spawn-config.ts`
- `packages/api/src/index.ts`
- `packages/api/test/acp/acp-bootstrap-cwd.test.js`
- `packages/api/test/env-map.test.js`
- `packages/api/test/opencode-config-template.test.js`

Core delta:

- `prepareOpenCodeAcpSpawnConfig()` now recognizes OpenCode by either `clientId === "opencode"` or command basename `opencode` / `opencode.cmd` / `opencode.exe`.
- Generic ACP still controls startup args explicitly, but OpenCode commands now receive the required `--pure` safety flag automatically when Cat Cafe pins their spawn config.
- Added a regression test proving generic OpenCode ACP writes `OPENCODE_CONFIG`, `CAT_CAFE_OC_API_KEY`, and `CAT_CAFE_OC_BASE_URL`.
- Added regression coverage for OpenCode command path basenames and for generic OpenCode ACP `--pure` injection.

## Why

Runtime diagnosis showed the user account configuration was sufficient: account `claude` had base URL, API key, model, and env templates including `OPENCODE_API_KEY=${api_key}` / `OPENCODE_BASE_URL=${base_url}`.

The bug was adapter-side. Fixed `@opencode-acp` got Cat Cafe's generated `OPENCODE_CONFIG`, but generic `@acp-opencode` only got env templates because spawn config generation was gated on `clientId === "opencode"`. OpenCode then read its own global config/MCPs and the prompt path hung.

## Original Requirements

> "我想按照想把 acp 作为独立的 provider 开放出来"
> "对于已知的哪些 client 我们可以内置 client 支持的环境变量的 key 到我们内置的环境变量的 key 的映射"
> "通用acp配置的话还有什么需要适配的么"

- Source: `docs/features/F161-acp-carrier-generalization.md`
- Source: current thread `thread_mqas4hktrogydo0f`, user messages at 2026-06-13 13:34 UTC and 13:52 UTC
- Please review against the goal that generic ACP should work when the command is a known ACP-capable client, without requiring the user to understand Cat Cafe's internal OpenCode runtime config file.

## Tradeoff

This does not make all generic ACP commands eligible for built-in config generation. Only commands whose basename is clearly OpenCode are pinned with OpenCode runtime config and receive `--pure`.

This also does not solve Kimi ACP authentication. Current Kimi ACP appears to require CLI OAuth state at `session/new`; `KIMI_*` env templates alone do not satisfy that separate gate.

## Architecture Ownership

Architecture cell: transport
Map delta: none
Why: this extends the existing F161 ACP spawn config path for a known command target; it does not add a new Store, Queue, Router, Adapter, Dispatcher, or Binding.

Please check:

- `Map delta: none` is consistent with the diff.
- Command basename recognition is narrow enough and does not accidentally capture unrelated ACP clients.
- Secrets remain in env and are not written into generated OpenCode config files.
- Generic ACP remains explicit for non-OpenCode commands.

## Open Questions

### 技术 OQ

- Should command basename matching also cover package-manager wrappers, or is the current narrow direct-command recognition the right boundary?

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

- F161 generic ACP remains user-configurable through account env templates.
- Known OpenCode ACP command now gets Cat Cafe's spawn-scoped runtime config, matching the fixed OpenCode ACP client behavior.
- No runtime config files were manually edited.
- No frontend changes; browser validation is not applicable.
- Root media/design artifact gate returned no matches.

### Red -> Green

RED command:

```bash
pnpm --dir packages/api run build >/tmp/f161-build-red.log && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --test packages/api/test/opencode-config-template.test.js
```

Expected failure observed: the new generic OpenCode ACP test failed because `prepareOpenCodeAcpSpawnConfig()` returned `null`.

GREEN command:

```bash
pnpm --dir packages/api run build >/tmp/f161-build-green.log && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --test packages/api/test/opencode-config-template.test.js
```

Result: 35 passed, 0 failed.

### Final Verification

```bash
pnpm --dir packages/api run build >/tmp/f161-review-refactor-build.log && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --test packages/api/test/acp/acp-bootstrap-cwd.test.js packages/api/test/opencode-config-template.test.js packages/api/test/env-map.test.js
```

Result: 75 passed, 0 failed.

```bash
pnpm --dir packages/api run lint
```

Result: passed (`tsc --noEmit` exit 0).

```bash
git diff --check -- packages/api/src/domains/cats/services/agents/providers/opencode-acp-spawn-config.ts packages/api/src/index.ts packages/api/test/acp/acp-bootstrap-cwd.test.js packages/api/test/env-map.test.js packages/api/test/opencode-config-template.test.js review-notes/2026-06-13-generic-opencode-acp-spawn-config-review-request.md
```

Result: passed.

### Runtime Dogfood

- `@opencode-acp diagnostic ping: reply exactly OK` completed with response `OK`.
- Before this patch, `@acp-opencode` initialized and reached `session/new`, then produced no prompt event until cancellation; logs showed only env-template injection and no prepared OpenCode runtime config.
- After this patch, `@acp-opencode diagnostic ping after config fix: reply exactly OK` completed with response `OK`.
- Generic `@acp-opencode` logs changed from `envKeyCount: 5` to `envKeyCount: 8` and emitted `ACP OpenCode: prepared spawn runtime config`.
- After the review follow-up `--pure` fix, `@acp-opencode review follow-up ping after pure auto-inject fix: reply exactly OK` completed with response `OK`; logs showed `args:["acp","--pure"]`, `envKeyCount:8`, `newSession completed`, and `promptStream completed`.

### Worktree

- Worktree: `/Users/lang/workspace/github/cat-cafe-f161-acp-generalization`
- Branch: `feat/f161-acp-generalization`
- Base HEAD before this patch: `a46226644`
