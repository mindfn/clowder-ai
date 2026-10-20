---
feature_ids: [F202]
related_features: [F041, F126, F129, F133, F139, F140, F141, F146, F190, F240, F241, F285, F292]
topics: [plugin-framework, plugin-manager, host-inventory, capability-registry, settings, resource-activation, catalog, agent-tools]
doc_kind: spec
created: 2026-05-15
architecture-cell: plugin
tips_exempt: "Generic messaging, Task data and plugin-owned services use existing Settings, conversation and feedback-card entry points. The interface consolidation adds no separate user-discoverable action; the feedback card describes draft creation directly. The consolidated migration scope and incompatible-install diagnostics use the existing Manager. Git marketplace and local-directory discovery are documented by their existing capability tips; shared member avatars add no separate action. Personal Chrome setup is available only after installing an exact trusted candidate; its Manager card provides the installation and extension-loading instructions at the point of use, rather than advertising an unavailable catalog release."
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/features/F202-plugin-framework.md"
mcp_admission_claims:
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_list
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_search
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_get
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_list_tools
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_call
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_install
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_set_enabled
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_uninstall
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
description: "Defines Host plugin admission, lifecycle authority, shared Settings/Agent management, and the separate Train B/C1/C2 boundaries."
description_source: model
description_author: codex-astra
description_updated_at: 2026-09-19T12:49:07+00:00
description_generated_by: gpt-6-astra
description_generated_at: 2026-09-19T12:49:07+00:00
description_confirmed_by: codex-astra
---

# F202: Plugin Manager and Host Interfaces

## Outcome and Scope

One Plugin Manager handles verified package discovery, installation, configuration, grants and lifecycle.
Host supplies ordinary resource APIs; packages own provider connections, routing, business mappings and
private state. Console and Agent management use the same inventory and runtime facts.

C1 packages seven IM connectors, GitHub Operations, media tools, Personal Chrome, enterprise workflow,
Collective, GenOffice and Feishu meeting intake. Dot remains built in; Tripo is excluded. C2 owns plugin
UI embedding and the separately scoped managed-service extensions.

The public interface reference is `clowder-ai-plugins/docs/plugin-development.md`. It contains identity
and Host client, Plugin→Host, and Host→Plugin, including lifecycle. Current PR checks expose validation
status. C1 operator acceptance passed with installed packages and real accounts before the merged-baseline
replay. Replayed Host and package changes require paired validation and renewed acceptance. Soak, distribution
prerequisites and maintainer acceptance remain release requirements; source delivery alone does not
authorize integration or release.

## Why

Installing or configuring a plugin should not require users to edit several Host runtime files. A
shared manager makes installation, enablement, configuration and runtime state visible while keeping
plugin business out of the Host implementation.

## User Journey

Scope: one catalog candidate or installed plugin instance.

1. Open Settings → Plugins to search verified catalog entries and installed plugins. Catalog failure
   does not hide installed plugins.
2. Install a published package or explicitly selected development source. Host verifies its manifest,
   dependencies and identity, then creates an immutable installed copy.
3. Configure credentials and grant the declared capabilities. Configuration fields and action buttons
   appear in manifest order. A test or connection action returns a transient result, not persistent health.
4. Enable the plugin. Host invokes its lifecycle; the plugin opens its connections and manages its helpers.
5. Use the declared tools, message subscriptions and actions. Messages and attachments follow the ordinary
   Host APIs. The detail page shows configuration and runtime facts separately.
6. Disable to stop activity while retaining installation and governed data. Uninstall applies the declared
   data policy without deleting unrelated user data. Installing new source explicitly replaces the
   immutable package; a source checkout or Host restart alone does not update it.

Installed packages whose manifests are incompatible with the current contract remain visible in
Plugin Manager with their instance identity, original grant records, configuration and data preserved.
Host and compatible plugins continue to run; incompatible packages cannot start or receive calls.
Without a higher compatible catalog version, Manager reports that no update is available and hides the
update action. A compatible replacement passes normal admission and replaces the package atomically;
failed replacement retains the original installation and data. After replacement, explicitly enable
the plugin. Corrupt inventory structure, inconsistent identities and invalid digests still reject startup.

## Interface and Ownership

Architecture cells: plugin, collective-runtime.
Map delta: local content authority remains behind the activation-fenced module owner port.
Why: moving remote business into a package must preserve local content, review and custody authorization.

Personal Chrome's local Native Messaging registration is a Host-owned setup operation. One exact-package
policy supplies both the Manager field and its execution matcher; it is not a plugin manifest action or
an SDK capability. The authenticated local owner confirms installation/removal, the Host suspends runtime
under a maintenance lock and invokes the verified package's fixed setup protocol with Host-selected paths.
Inspection is read-only. Failed runtime recovery preserves the reported setup outcome and asks the owner
to inspect before retrying; an unknown child outcome never triggers an automatic mutation retry. Installing
the helper does not prove Chrome connection or conversation authorization. Runtime grant reconciliation
adds only requested, allowlisted capabilities (including Collective's ordinary `plugin.config.read`) and
retains installation identity, package, configuration and data.

Host owns package verification, inventory, configuration/secrets, grants, lifecycle and ordinary resource
operations. Packages own provider behavior and their storage. Plugin identity is bound by Host; business
payloads do not supply authorization identity. Plugins use ordinary threads/messages/members without a
second thread-visibility system. Thread creation is ordinary creation; after an uncertain failure the
plugin can create again and update its own mapping.

Host→Plugin delivery carries a message or execution-status update. Its receipt acknowledges that input,
not model completion or an end user's read. Both directions use streams.read; closing a reader preserves
the underlying attachment. Meeting notifications use ordinary messaging and package-private pending state.

Lifecycle hooks are preStart, start, configRefresh, preStop, stop, preUninstall and uninstall. A missing
refresh hook is a no-op. Plugins explicitly refresh cached resources and manage their own helper processes.
Configuration updates keep the current activation usable; stop, package replacement, grant and caller
validity checks still apply. QR challenges and polling state belong to plugin storage; only declared
configuration/credential targets and generic UI step position persist in Host.

Plugin notifications use the same conversation target resolution, queue admission and drain as user
messages. An unknown, deleted or unavailable mention falls through to ordinary conversation routing,
including the recent available member. The message remains a normal visible thread fact; plugins do not
preflight the member directory or maintain a separate routing/failure protocol.

GitHub operations use `gh` and ordinary plugin actions/MCP capabilities. Review notifications, delegation
and completion use ordinary messaging, mentions and Tasks. Host does not expose custody, deployment,
feedback-draft or browser-service business ports. The feedback card supplies explicit content to the
plugin's owner action and displays its returned draft; draft storage and publication belong to the plugin.
Persisted feedback content is retained independently of GitHub drafts.

Collective owns its HTTP listener, configured port, static client assets and internal requests. Its
start/stop lifecycle opens and closes the listener; changing the port requires an explicit stop/start.
Owner authentication, allowed origins and the GitHub OAuth callback are enforced by the plugin. Host
uses the ordinary declared action to obtain the page URL and does not allocate ports or dispatch its
internal HTTP requests.

The retained local content/review/media/custody owners remain Host authorities behind the narrow,
activation-fenced `collectiveArtifactOwner` module port. Service credentials, routing, polling and
publication relay belong to the package. Retained-media owner actions require current authenticated
Host HTTP context; no local principal is supplied by the plugin. Host message/media facts and plugin
Work receipts jointly authorize document publication without restoring a builtin Work binding.

## Acceptance Criteria

- [x] One verified inventory and management surface serves Console and Agent operations.
- [x] Current C1 provider implementations live in packages and use the shared client and lifecycle.
- [x] Configuration refresh preserves active access while invalid/stopped access is rejected.
- [x] Message delivery, streams and actual package consumers are covered by automated checks.
- [x] Settings preserve manifest order and reject stale action results; retained configuration does not
  restore old receipts.
- [x] Public interfaces and current architecture documentation match the implementation.
- [x] Operator verified Weixin installation, enablement, uninstallation, QR login, phone/Hub message
  exchange, member avatars and Queue/reply identity using installed packages.
- [x] Operator verified that enabling the Weixin public-account plugin mounts its declared `weixin-mp` skill.
- [ ] Complete soak, distribution prerequisites and maintainer acceptance before merge.

## Non-Goals and Limits

C1 does not migrate Dot, add Tripo, introduce arbitrary plugin UI, or open a second event/identity/thread
system. Automated fixtures do not establish provider availability or real-account acceptance. Collective
and Feishu meeting intake remain held outside the current public catalog; their later publication
acceptance is a distribution boundary, not unfinished C1 Host migration. After C1 integration, the
remaining framework development is Dot migration and C2. Runtime restarts remain operator-controlled.

## Follow-up direction: addressable plugins and Dot (2026-10-18)

Deferred direction; not implemented in C1. It spans target resolution, dispatch, UI and Dot's external
connection. The intended behavior and remaining implementation are:

- Use the existing stable plugin instance identity as a message target, independently of its
  editable alias and icon. Do not manufacture a protected cat identity for Dot. A package ID
  describes the package; routing must still identify the actual installed instance.
- Plugins explicitly declare support for addressed delivery. Merge those enabled targets with
  members for mention selection and alias uniqueness checks. Generate and persist a unique
  default alias; resolve mentions to stable identities before enqueueing. Renaming or changing
  the icon must not retarget already queued messages. Alias-only edits update the Host projection;
  they need not restart the plugin.
- Reuse ordinary message admission/queueing, then dispatch members to their execution adapters
  and plugin targets through Plugin Manager to the existing delivery handler. A delivery receipt
  acknowledges that input, not completion of an external model response. Plugin replies use
  `messaging.send`; attachments use streams and state uses existing config/secrets/storage.
- Subscription and addressed delivery are separate choices. Current seven IM connectors call
  `messaging.subscribe(threadId, ...)` for threads in their own business mappings, not a global
  subscription. They implement an outbound delivery action and call `messaging.send` for inbound
  platform messages. Having these functions must not automatically place an IM connector in the
  mention target list. Addressability is opt-in; existing IM forwarding remains unchanged.

Inspected boundaries for the follow-up:

| Area | Current evidence and required change |
| --- | --- |
| Target discovery | `cat-target-resolver.ts` resolves only `catRegistry`; `ChatInput.tsx`, `useCatData.ts` and `mention-highlight.ts` consume member data. Add plugin targets without pretending they have a model/client configuration. |
| Dispatch | `route-serial.ts` and `route-parallel.ts` read cat configuration and invoke `invokeSingleCat`. Reuse scheduling but add the plugin delivery exit; do not pass plugin IDs through cat-only execution. |
| Dot runtime | `cloud-invoke-bridge.ts` has a `gpt-dot` branch; `index.ts` assembles Dot services. Move connection/webhook/reply/image behavior into the plugin and remove those dedicated Host branches. |
| External entry and UI | Dot currently has connection/MCP/test/image routes, callback integration and dedicated Settings/receipt/media UI. Verify their migration and ordinary message attribution, not just package startup. |
| Existing user data | Preserve pairing/configuration and historical messages; do not delete data to eliminate old code. Work out the concrete data relocation during the follow-up. |

SDK message, delivery, stream and lifecycle primitives are reusable; no broad SDK redesign is
implied. The missing work is target declaration/configuration and Host routing/UI integration.
Acceptance must cover addressed request/reply, alias collision and rename with queued input,
icon changes, disable/uninstall, existing IM subscriptions and ordinary member dispatch.

### Remaining code and completion checklist

Paths below are relative to the Host repository; they are implementation starting points, not
a promise that every reference can be deleted. Preserve historical messages and user-owned data.

- [ ] Unify addressable target discovery and alias uniqueness: `packages/api/src/domains/cats/services/agents/routing/cat-target-resolver.ts`, `a2a-mentions.ts` and `AgentRouter.ts`; front-end `packages/web/src/components/ChatInput.tsx`, `packages/web/src/hooks/useCatData.ts` and `packages/web/src/lib/mention-highlight.ts`.
- [ ] Route plugin targets from the ordinary queue to Plugin Manager delivery: `packages/api/src/routes/messages.ts`, `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`, and routing `route-serial.ts` / `route-parallel.ts`. Keep stable target IDs through alias changes and cover disabled/uninstalled targets.
- [ ] Move Dot business ownership out of Host: `packages/api/src/domains/cats/services/cloud-bridge/dot/` (connection, dispatch, ask, return and image services), assembled in `packages/api/src/index.ts`. Replace the `gpt-dot` / `dispatchDot` branch in `cloud-invoke-bridge.ts` and review Dot-specific `cloud-return-grant.ts` / `cloud-bridge-fallback.ts` branches.
- [ ] Replace the built-in identity/package projection: `packages/shared/src/types/builtin-cloud-identity.ts`, `packages/api/src/routes/cats.ts`, `packages/api/src/domains/plugin/chatgpt-dot-manifest.ts` and bundled catalog entries. The new target is the installed plugin identity, not a synthetic cat; retain correct attribution of existing messages.
- [ ] Relocate external protocol and Settings integration: `packages/api/src/routes/chatgpt-dot-{connection,mcp,test,image}-routes.ts`, Dot-specific callback authentication in `callback-auth-prehandler.ts` / `callbacks.ts`, and `packages/web/src/components/settings/plugin-manager/DotConnectionDetail.tsx` plus its Manager call sites. Verify receipt and image presentation (`CloudDotReceipt.tsx`, `Lightbox.tsx`, gallery media URLs) against the replacement.
- [ ] Deliver a real Dot request/reply and attachment journey using the ordinary plugin SDK; verify current pairing/configuration retention, alias collision/rename, icon changes, stop/uninstall, and unchanged member/IM forwarding behavior. Then remove obsolete executable Dot-specific Host branches and their obsolete tests together, with independent review.

The existing IM reference is the plugin repository's seven `packages/connector-*/src/plugin-entrypoint.ts`
files: restore subscriptions from private thread mappings, subscribe only to the selected threads,
and send inbound messages via `messaging.send`. Host subscription behavior lives in
`packages/api/src/domains/plugin/host-surface/plugin-messaging-subscription-host.ts` and
`packages/api/src/domains/messaging/subscription-delivery.ts`. This is not an implicit declaration
of addressability and must not be changed into a global subscription for the Dot migration.

## Agent Tool Admission

| Entry | Boundary retained by the Host |
| --- | --- |
| `plugin_list` | Read the canonical catalog/install projection; no mutation. |
| `plugin_search` | Discover verified metadata through the same read-only projection. |
| `plugin_get` | Inspect one exact plugin and its current lifecycle revision. |
| `plugin_list_tools` | Disclose schemas only for a live, authorized contribution. |
| `plugin_call` | Invoke an exact discovered schema under current live/grant authority; write profile only. |
| `plugin_install` | Admit the exact verified package as a disabled instance; no implicit enablement. |
| `plugin_set_enabled` | Explicit owner lifecycle mutation fenced by the current revision. |
| `plugin_uninstall` | Destructive owner mutation; revoke runtime/grants before retiring the instance. |

This admission does not expose generic update/repair, grant authority to catalog metadata, or register
arbitrary dynamic schemas as canonical tools. Restricted Collective sessions cannot use these entries;
readonly sessions can only use the four read entries. F309 and existing official-plugin lifecycle
policies retain their own authority.

## References

- [Host PR](https://github.com/zts212653/clowder-ai/pull/1487)
- [Package PR](https://github.com/zts212653/clowder-ai-plugins/pull/54)
- [Plugin ownership](../architecture/ownership/cells/plugin.md)

Prior design discussions and acceptance checkpoints are retained in Git history and independent audit
records; they do not define the current public interface.


## C1 migration boundary

Provider-specific IM adapters, GitHub tracking/community backends, video tools, Weixin publishing and
visible-reader tools, personal Chrome companion, enterprise workflows, Collective, document materializers
and meeting intake belong to independent packages. Host retains identity, memory, conversation/task data,
the queue/scheduler, generic package management and granted public primitives. Business moves as a unit;
its Host-facing boundary changes to the common client. Provider-specific public ports and hidden corrective
model turns are not retained as compatibility layers.

Custom pages outside Plugin Manager and managed ASR/TTS/embedding services are outside this C1 UI migration.
C2 moves plugin-owned pages and internal request handling together; Host supplies generic mounting and
management. Plugin configuration and actions inside Manager already use the common manifest-driven UI.
The current public signatures are defined by plugin-contract and the plugin repository's development guide,
not by historical migration plans. See [Plugin Architecture](../architecture/plugin-architecture.md)
for lifecycle, Tasks, Git discovery and local installation boundaries.

Existing user data is retained. Data ownership changes require explicit migration choices; development and
acceptance use isolated stores. Local packages can support acceptance before registry publication, but
release dependency pins must resolve to their intended distributable packages before merge. The real-account
operator journey has passed, including Weixin installation/uninstallation, QR login, message exchange,
member presentation and declared public-account skill activation. Soak, distribution prerequisites and
maintainer acceptance remain; successful CI alone does not satisfy those requirements.
