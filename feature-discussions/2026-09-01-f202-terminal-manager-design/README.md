---
feature_ids: [F202]
topics: [plugin-manager, design-gate, settings, package-icons]
doc_kind: design-gate
created: 2026-09-01
---

# F202 Terminal Plugin Manager — Design Gate record

## Verdict

**Direction approved; full hands-on acceptance remains pending.** In the real Settings shell, co-creator
accepted the searchable list/detail direction and authorized formal wiring to continue. The only new
blocking implementation feedback was that plugin icons rendered incorrectly. Remaining observations were
classified as minor polish, not a request to redesign the journey.

Operator wording in `thread_mrkmxgdfqquounc9` on 2026-09-01:

> “ui方向我看了；除了前面说的那几点没有什么大问题的；就是图标显示不太对需要调整下的；
> ui这个先这样子吧；你们先继续吧……等完整做完后我再去实际体验和看看的”

This is not phase-4 experience acceptance. The complete install → configure → enable → use → restart →
disable → uninstall product journey must return to co-creator after formal Core composition and Console
wiring are complete.

## Product and state decisions

- Entry remains Settings → Plugins (L2), with offline install at page top-right.
- Default/wide layout remains a fixed-height searchable list at left and the existing expanded-card
  language at right. Lifecycle actions stay on list rows; details do not duplicate them.
- Narrow layout remains list → detail → back, rather than stacking two competing journeys.
- Catalog degraded state keeps installed plugins manageable and replaces one bounded in-context banner.
- Image icons are complete square assets, not glyphs. They fill the 36px avatar and are clipped by its
  shared radius; legacy Hub icon names retain the inset glyph treatment.
- Formal live wiring remains explicit in the feature checkout. Repository-local/connector compatibility,
  production package materialization, durable quarantine and package-icon delivery are now composed behind
  that path. Machine-catalog publication and its deployable index coordinate remain external prerequisites.
  The Train C production-default switch must still preserve specialized plugin journeys rather than silently
  dropping existing controls.

## Architecture / contract integrity

Architecture cell: `plugin`

Map delta: update required; the worktree already updates `docs/architecture/ownership/cells/plugin.md`.

Why: published catalog/package metadata, Host inventory and runtime truth now feed one Manager projection
consumed by REST, Agent tools and Console.

Canonical source: `packages/api/src/domains/plugin/plugin-manager-service.ts#PluginManagerService`

Consumer evidence:

```bash
rg -n "PluginManagerService|/api/plugin-manager|PluginManagerLiveContent" \
  packages/api/src packages/mcp-server/src packages/web/src
```

Claim guard: Console and Agent consume canonical Manager operations →
`PluginManagerContent.test.tsx`, `plugin-manager-routes.test.js`, and
`plugin-management-tools.test.ts` → red when either surface calls a legacy lifecycle route or exposes
update/repair.

Typed configuration is a detail contribution with its own revision-fenced REST path. It is consumed by
the same `PluginManagerService` and Console detail, but intentionally does not expand the six Agent
management tools. Enabled dynamic capabilities use the separate governed `plugin_list_tools` →
`plugin_call` path, which delegates to the same Host supervisor that owns contribution liveness and grants.
`plugin-manager-composition.test.js`, `plugin-manager-routes.test.js`, and
`PluginManagerContent.test.tsx` guard field projection, validation, secret masking, audit redaction and save.

Characterization/contract test: `plugin-manager-service.test.js` plus
`plugin-manager-projection.test.js`.

Code-derived consumer census: the `rg` command above must resolve the route registration, six Agent
management tools, two contribution tools and the live Console container to the same Host-owned Manager and
supervisor boundaries.

Migration/restart/rollback evidence: `plugin-manager-restart.test.js`; compatibility and admitted exact
packages are protected against disappearance/double-run across restart. A dependency-bearing builtin is
runtime-materializable only with a publisher-owned, lockfile-v3, registry-bounded, sha512-complete shrinkwrap. Production
catalog selection therefore remains pending on published exact artifacts/index including that closure; the
default Console cutover remains the Train C aggregate gate.

## Verification at this gate

- Design fixture contract: `PluginManagerDesignGate.test.tsx` — wide/default, search, action placement,
  degraded catalog, localized descriptions, package icons and narrow navigation.
- Icon feedback Red → Green: complete PNG/SVG assets previously rendered at glyph size inside a second
  background; regression now requires full-size `object-cover` plus clipped shared avatar.
- Live wiring contract: `PluginManagerContent.test.tsx` — canonical list/detail, exact digest install,
  revision-fenced enable and stale-conflict refresh.
