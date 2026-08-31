# Plugin Architecture

Clowder AI's core keeps what makes a cat a cat — identity, memory, session truth, and a sense of discretion. **Plugins give those cats bodies that can leave the web page**: a front-end companion, a desktop probe, a voice pack, an IM connector. The core (the soul) and a plugin (the body) meet through a single, versioned **plugin contract**.

## Two repositories, one contract

Plugin *management* and plugin *implementation* live in separate repositories, connected by the contract:

| Repository | Owns |
|---|---|
| **`clowder-ai`** (core) | Plugin discovery and install, the management UI, authorization, the **Host Broker** that runs plugins, orchestration, audit, and all user data. |
| **`clowder-ai-plugins`** | The plugin **contract**, the plugin-side **SDK** and standalone runtime, scaffolding, official plugins, and conformance fixtures. |

The plugins repo is **not** a plugin manager. Official plugins are built and published there independently; the host downloads or receives a plugin artifact, validates its manifest and digest, obtains the user's authorization, and only then installs, enables, and runs it through the Host Broker. **First-party and third-party plugins use the same SDK and the same authorization channel** — there is no privileged side door.

## The contract

`@clowder-ai/plugin-contract` is the machine-readable source of truth both sides consume — JSON Schema, generated types, a capability table, and conformance fixtures. It defines three things:

- **The input envelope** — every input a plugin receives is described on two axes: its **origin** (where it came from) and its **epistemic status** (how settled or trusted that information is).
- **The output event stream** — how a plugin emits results back to the host.
- **The manifest and capability types** — what a plugin declares it owns and is allowed to do.

Because the contract is a shared package, the host and a plugin can never silently drift: a capability is usable only once its contract row moves from *reserved* to *executable*.

## The SDK

`@clowder-ai/plugin-sdk` is for plugin authors and plugin runtimes — not host internals. It provides a schema-neutral **standalone stdio runtime**, handshake validation, and a Host-bound `events.publish` helper. A plugin built with the SDK talks to the **Host Broker** in the core over a bounded, contract-owned transport (`call` / `callback` / `event` / `handshake`).

## What a plugin owns

A plugin declares its resources in a manifest (`plugins/<plugin-id>/plugin.yaml` for repository-local plugins). Resource types include:

- **Skill** — an on-demand prompt package (a workflow or checklist an agent loads when the task calls for it).
- **MCP** — a tool surface exposed to agents through the Model Context Protocol.
- **Limb** — a control-plane capability for a physical or external body (a device action, observation, or readiness signal).
- **Schedule** — a recurring task bound to a whitelisted factory (never an arbitrary script).

All resource types activate through **one shared activator** and are recorded with explicit plugin-ownership metadata, so enabling or disabling a plugin only ever touches that plugin's own resources.

## Install and authorization lifecycle

1. **Discover** — the host finds a plugin (a validated repository-local folder, or a received external package) and reads its manifest.
2. **Validate** — manifest schema, directory identity, config keys, digest, and ownership boundaries are all checked *before* any activation control appears. Invalid or colliding plugins are rejected without touching anything else.
3. **Authorize** — installing and enabling a plugin is an explicit local-owner action in **Settings**. Write actions require local loopback plus request identity, and every enable/disable/config/test emits an audit event.
4. **Activate** — on enable, only that plugin's resources are activated; their status appears in the plugin and capability surfaces, clearly distinct from built-in capabilities.
5. **Rehydrate** — after a restart, only still-enabled, still-valid plugins come back; disabled or invalid ones stay inactive with a visible error state.

Secrets never land in git-tracked manifests: plugin configuration flows through the connector secret boundary, and long-lived external credentials (an IM token, say) stay in a host-managed gateway rather than inside the plugin.

## Trusted-local vs external packages

The framework grew in two layers:

- **Repository-local plugins** — trusted plugins that ship in-tree under `plugins/<id>`, discovered and activated directly. The GitHub integration (CI, review, conflict, and repo-scan pollers) is one of these.
- **External packages** — independently published plugins installed as contract-native packages and run under the Host Broker's one-use handshake sessions, runtime leases, and durable call settlement, with immutable package-to-process authority and fail-closed restart recovery.

## Official plugins

The plugins repo is home to the first official "bodies," each a real vertical built on the contract:

- **Feishu meeting intake** — publishes bounded meeting metadata plus an opaque source handle, with a durable outbox/cursor for reconnection recovery.
- **GitHub** — the CI, review, conflict, and repo-scan integration, migrated onto plugin-owned schedule resources.
- **Physical limb (StackChan)** — a physical body whose contract schema defines device actions, observations, readiness, and an independent device grant (deliberately excluding raw sensor media).

## What plugins never do

- **No arbitrary same-power scripts** — capabilities come only from declared, contract-defined resource types.
- **No bypassing the Host Broker** — a plugin reaches the core only through the contract's transport and authorization.
- **No taking over the core** — identity, memory, session truth, and user data always stay in `clowder-ai`; a plugin is a body, never the soul.
