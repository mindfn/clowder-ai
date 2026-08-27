# Plugin Architecture

Clowder AI is designed to be extended without modifying its core. Plugins add new tools, connect external services, and introduce new interaction patterns -- all through well-defined integration points.

## What Plugins Do

Plugins let you customize what your Clowder instance can do. Out of the box, agents can read files, run commands, and communicate with each other. Plugins add everything else: connecting to Feishu for team notifications, adding a code review workflow, exposing a domain-specific tool that only your team needs.

The core platform handles identity, routing, and coordination. Plugins handle everything domain-specific.

## Plugin Types

### MCP Tools

MCP (Model Context Protocol) tools expose new capabilities directly to agents. When an MCP tool is registered, every agent in the system can discover and call it. Examples include database query tools, API connectors, or specialized analysis utilities.

MCP tools follow a standard schema: each tool has a name, a description, and a typed parameter definition. Agents discover available tools at startup and can call them during conversations.

### Adapters

Adapters connect Clowder to external communication and service platforms. They translate between Clowder's internal message format and the external platform's API.

Examples:
- **Feishu / Lark** -- Receive messages from Feishu groups, route them to the right agent, and post responses back
- **Telegram** -- Bot integration for Telegram channels
- **GitHub** -- Issue and PR tracking, webhook handling

Each adapter handles authentication, message format translation, and connection lifecycle for its platform.

### Skills

Skills are on-demand prompt packages. Unlike tools (which expose actions), skills provide knowledge and workflow structure. An agent loads a skill when it needs guidance on how to approach a specific type of work.

Examples:
- **TDD skill** -- Step-by-step test-driven development workflow
- **Code review skill** -- Review checklist, severity classification, feedback format
- **Design skill** -- Architecture decision process, tradeoff documentation

Skills are not always loaded. An agent working on a bug fix loads the TDD skill. The same agent doing a code review loads the review skill. This keeps the agent's context focused on the current task.

### Capabilities

Capabilities are self-contained functional units that bundle tools, configuration, and UI elements into a single installable package. They are managed through the Hub UI and represent the highest-level unit of extension.

A capability might combine an MCP tool, an adapter, and a skill into a coherent feature. For example, a "GitHub Integration" capability could include the GitHub adapter, PR-related MCP tools, and a review workflow skill.

## MCP Integration

Model Context Protocol is the universal tool-sharing layer in Clowder. It solves a specific problem: different AI models have different tool-calling conventions, but the platform needs a single way to expose tools to all of them.

How it works:

1. **Tool registration** -- A plugin registers its tools with the MCP server, providing schemas and handler functions.
2. **Discovery** -- Agents query the MCP server at startup to learn what tools are available.
3. **Invocation** -- When an agent calls a tool, the request goes through the MCP server, which routes it to the correct handler.
4. **Callback bridge** -- For non-Claude models that do not speak MCP natively, the callback bridge translates tool calls into MCP format and results back into the model's expected format.

This means a tool written once is available to every agent, regardless of whether that agent runs on Claude, GPT, Gemini, or any other model.

## Skills Framework

Skills are prompt packages with a defined lifecycle:

### Definition

Each skill is defined in a manifest with metadata:
- **Name and description** -- What the skill does
- **Trigger conditions** -- When this skill is relevant (e.g., "when the task involves writing tests")
- **Content** -- The actual prompts, checklists, templates, and workflow steps

### Loading

Skills are loaded on demand, not preloaded. This is a deliberate design choice. A system prompt stuffed with every possible instruction becomes noise. Instead:

1. The agent assesses the current task
2. It checks the skill manifest for relevant skills
3. It loads only what applies
4. The loaded skill's instructions take effect for the duration of the task

### Composition

Skills can reference other skills. A "feature development" workflow might load the TDD skill for implementation, then the quality gate skill for pre-review checks, then the review request skill to hand off for review. Each is loaded and unloaded as the workflow progresses.

## Installing Plugins

Plugins are installed through the Hub UI:

**Hub > System Settings > Capabilities**

The installation interface lets you browse available plugins, configure their settings, and enable or disable them per agent or globally.

Important constraints:
- **Local app only** -- Plugin installation requires access to the local Hub instance. LAN mode restricts write operations for safety.
- **Operator approval** -- Installing a plugin is an operator action. Agents cannot install plugins on their own.
- **Configuration isolation** -- Each plugin's configuration is isolated. A misconfigured plugin cannot affect the core platform or other plugins.
