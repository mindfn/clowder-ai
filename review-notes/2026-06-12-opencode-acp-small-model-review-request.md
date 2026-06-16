# Review Request: OpenCode ACP response model routing

Review-Target-ID: f161
Branch: feat/f161-acp-generalization

## What
Built-in OpenCode ACP profiles now get a spawn-scoped `OPENCODE_CONFIG` that pins provider, model, credentials, and `small_model`. Generic `clientId: 'acp'` profiles are intentionally not auto-configured, even when their command is `opencode`; those profiles must use explicit user env/config mapping. The same runtime config generator is used by normal managed OpenCode invocations, so OpenCode's title-generation side call no longer falls back to its default Haiku model.

Touched files:
- `packages/api/src/domains/cats/services/agents/providers/opencode-config-template.ts`
- `packages/api/src/index.ts`
- `packages/api/test/opencode-config-template.test.js`

## Why
Runtime smoke showed the main ACP response succeeded, but OpenCode then made a `small=true agent=title` call to `claude-haiku-4-5-20251001`; the configured upstream rejected that model with `model_not_found`. Official OpenCode schema documents `small_model` as the config key for title-generation/lightweight tasks, so Cat Cafe must set it alongside `model` for managed runtime configs.

## Original Requirements
> "你怎么开始review了；不是需要分析我们最重要的opencode响应的问题么"
> "如果说opencode这个内置的client；我们可以自动做；但是如果说acp client这种那我理解是需要用户自己配置env引用吧"

- 来源：thread `thread_mq5zrg04n1votqb9`, 2026-06-12 07:45 UTC / 08:05 UTC
- 请对照上面的摘录判断交付物是否解决了 OpenCode ACP response 问题，而不是只看配置代码是否整洁。

## Tradeoff
I pinned `small_model` to the selected main model instead of trying to choose a cheaper model. That favors reliability and account binding correctness over per-title cost, because Cat Cafe cannot infer that an arbitrary proxy/provider exposes OpenCode's default small model.

I did not fix OpenCode's remaining snapshot warning in this patch. The latest smoke still logs a separate pathspec WARN when the session cwd is `packages/api`, but it does not produce `model_not_found`, `stream error`, or failed response persistence.

## Architecture Ownership
Architecture cell: transport
Map delta: none
Why: this extends the existing F161 ACP carrier/runtime config path; it does not introduce a new Store, Queue, Router, Adapter, Dispatcher, or Binding.

Please check:
- diff is consistent with `Map delta: none`
- `small_model` remapping stays correct when provider names are remapped, especially `openai` -> `openai-compat`
- ACP pool spawn signature includes the runtime config summary so stale pools restart when model/small model config changes
- `clientId: 'acp'` remains fully user-configured and does not inherit built-in OpenCode behavior from `command: 'opencode'`

## Open Questions

### 技术 OQ
- Is pinning `small_model` to the final remapped `model` the right default for all managed OpenCode runtime configs?
- Should the snapshot pathspec WARN be tracked as a separate follow-up after this response bug is reviewed?

### 价值 OQ
无。

## Next Action
Please review the three-file diff and runtime evidence. If acceptable, approve; if not, mark P1/P2/P3 with concrete file/line references.

## Review Sandbox
- Path: `/tmp/cat-cafe-review/f161/opus`
- Start Command: `pnpm review:start`
- Ports: not started by author; this is backend/runtime config review. Author dogfood used `api=3212` in the feature worktree.

## 自检证据

### Spec 合规
- F161 Phase B AC-B2 requires OpenCode ACP prompt -> response end-to-end. The latest dogfood got assistant content `OK` and no OpenCode `model_not_found` / stream error.
- Official OpenCode schema confirms `small_model` controls lightweight tasks like title generation.

### 测试结果
- RED: `opencode-config-template.test.js` failed with `config.small_model === undefined`.
- RED: after CVO design feedback, generic `clientId: 'acp'` + `command: 'opencode'` failed because it still auto-created `OPENCODE_CONFIG`.
- GREEN: `pnpm --dir packages/api run build && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --import $(pwd)/packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/opencode-config-template.test.js` -> 34 pass, 0 fail.
- `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --import $(pwd)/packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/f203-phase-i-opencode-l0.test.js` -> 14 pass, 4 skipped, 0 fail.
- `pnpm --dir packages/api run lint` -> pass.
- `pnpm exec biome check packages/api/src/domains/cats/services/agents/providers/opencode-config-template.ts packages/api/src/index.ts packages/api/test/opencode-config-template.test.js --diagnostic-level=error` -> pass.
- `git diff --check` -> pass.

### Dogfood
- Request: `POST http://127.0.0.1:3212/api/messages` to `thread_mqal6mzwr4264wup`, invocation `d5a9c4ee-3720-447d-abf2-b48fc02edd16`.
- Persisted assistant reply: `dragon-li-pwt1` content `OK`, session `ses_1452f67c0ffeE0Z180qplRqINE`.
- API log: runtime config summary includes `smallModel: "anthropic/claude-opus-4-6"` and `session/prompt` completed in 5868 ms.
- OpenCode log: `small=true agent=title` used `providerID=anthropic modelID=claude-opus-4-6`; grep found no `model_not_found` or `stream error`.

### 相关文档
- Feature: `docs/features/F161-acp-carrier-generalization.md`
- External source used: `https://opencode.ai/config.json` (`small_model` schema)
