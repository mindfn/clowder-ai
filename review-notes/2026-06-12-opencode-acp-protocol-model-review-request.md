# Review Request: OpenCode ACP protocol model selection

Review-Target-ID: f161
Branch: feat/f161-acp-generalization

## What

OpenCode ACP model selection now follows the stable ACP session configuration path:

- `AcpClient` can send `session/set_config_option` with `{ sessionId, configId, value }`.
- `AcpAgentService` reads `configOptions` from `session/new` and selects the configured model only when the agent advertises a model option (`id: "model"` or `category: "model"`).
- `index.ts` passes Cat Cafe `defaultModel` as `sessionModel` for ACP providers.
- Built-in `clientId: "opencode"` still gets spawn-scoped `OPENCODE_CONFIG` only for managed OpenCode setup needs such as custom provider registration and `small_model`; generic `clientId: "acp"` remains user-configured.

Touched files:

- `packages/api/src/domains/cats/services/agents/providers/acp/AcpAgentService.ts`
- `packages/api/src/domains/cats/services/agents/providers/acp/AcpClient.ts`
- `packages/api/src/domains/cats/services/agents/providers/acp/types.ts`
- `packages/api/src/domains/cats/services/agents/providers/opencode-config-template.ts`
- `packages/api/src/index.ts`
- `packages/api/test/acp/acp-client.test.js`
- `packages/api/test/acp/gemini-acp-adapter.test.js`
- `packages/api/test/opencode-config-template.test.js`

## Why

The original OpenCode ACP failure was not just "missing env". Runtime evidence showed the main response path could work, but OpenCode's title-generation side call used its default small model and the upstream rejected it with `model_not_found`.

After CVO design feedback, I rechecked protocol/docs/source. The right split is:

- ACP session model: selected by the ACP client after `session/new`, through advertised session config options.
- API key/env: user-supplied env for generic ACP; managed OpenCode may inject env placeholders.
- Base URL/custom provider/small model: OpenCode config concern; for managed `clientId: "opencode"` Cat Cafe can generate an invocation-scoped config, but generic `clientId: "acp"` should not.

## Original Requirements

> "你怎么开始review了；不是需要分析我们最重要的opencode响应的问题么"
> "如果说opencode这个内置的client；我们可以自动做；但是如果说acp client这种那我理解是需要用户自己配置env引用吧"
> "acp模式下API_KEY和BASE_URL可以支持；但是model不支持很奇怪啊"

Source: thread `thread_mq5zrg04n1votqb9`, 2026-06-12 07:45-08:43 UTC.

## Tradeoff

I did not pass `--model` through `startupArgs`, because OpenCode 1.15.3 `opencode acp --help` does not advertise `--model`, and `opencode acp --model ...` exits 1 with help output. This patch uses `session/set_config_option`, which matches stable ACP docs.

I kept generated `OPENCODE_CONFIG` for built-in OpenCode ACP only. It does not write secrets; it writes env references and pins `small_model`. Generic ACP profiles keep full manual env/config control.

## Architecture Ownership

Architecture cell: transport
Map delta: none
Why: this extends the existing ACP carrier/client protocol path and managed OpenCode spawn config; it does not introduce a new Store, Queue, Router, Adapter, Dispatcher, or Binding.

Review focus:

- Is `session/set_config_option` correctly ordered after `session/new` and before `session/prompt`?
- Should the model option resolver accept both `id === "model"` and `category === "model"`?
- Does generic `clientId: "acp"` avoid managed OpenCode config injection even when `command` is `opencode`?
- Is generated `OPENCODE_CONFIG` still justified for built-in OpenCode `small_model` and custom provider/baseURL support?

## Open Questions

Technical OQ:

- Should unsupported advertised model values fail fast before sending `session/set_config_option`, or should the ACP agent own validation and error reporting?

Value OQ:

- None.

## Verification

- RED: `packages/api/test/acp/acp-client.test.js` failed with `TypeError: client.setSessionConfigOption is not a function`.
- RED: `packages/api/test/acp/gemini-acp-adapter.test.js` failed because implementation still sent `session/set_model` and never sent `session/set_config_option`.
- GREEN: `pnpm --dir packages/api run build` -> pass.
- GREEN: `pnpm --dir packages/api run lint` -> pass (`tsc --noEmit`).
- GREEN: `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --import $(pwd)/packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/acp/acp-client.test.js` -> 27 pass, 0 fail.
- GREEN: `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --import $(pwd)/packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/acp/gemini-acp-adapter.test.js` -> 37 pass, 0 fail.
- GREEN: `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --test packages/api/test/opencode-config-template.test.js` -> 34 pass, 0 fail.
- GREEN: `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --import $(pwd)/packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/acp/acp-bootstrap-cwd.test.js` -> 14 pass, 0 fail.
- GREEN: `git diff --check` -> pass.

Notes:

- `pnpm exec biome check ...` is not the package lint script and reports pre-existing ACP file complexity/non-null-assertion/style issues. I fixed the only formatter issue in the newly added service block and did not reformat unrelated legacy code.
- `node scripts/check-fallback-layers.mjs` cannot run in this worktree because the script path does not exist.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/f161/opus`
- Start command: `pnpm review:start`
- Ports: not started by author; this is backend protocol/config review.
