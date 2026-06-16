# IM Connector 开发文档

> Build a custom IM connector for Cat Cafe without modifying the main repository.

## Overview

Cat Cafe's IM connector plugin system (F231) lets you integrate any messaging platform by packaging a self-contained plugin archive. Upload via Hub UI, configure credentials — done.

```
# Package your connector as a tar.gz:
tar czf my-connector.tar.gz my-connector/
# Upload via Hub UI → IM 对接 → 安装插件
# Credentials are saved to .cat-cafe/im-connector-config/my-connector.json
```

## Architecture

```
Your IM Platform                     Cat Cafe
┌──────────┐    webhook/ws     ┌─────────────────────────┐
│  Server   │ ───────────────► │ Your Plugin              │
│           │                  │  handleWebhook()         │
│           │                  │  ──► onMessage() ────►   │──► ConnectorRouter
│           │ ◄──────────────  │  ◄── sendReply()         │      ──► LLM
│           │    HTTP API      │                          │      ──► Response
└──────────┘                   └─────────────────────────┘
```

Your plugin sits between the IM platform and Cat Cafe's message router. It translates platform-specific protocols into the unified `IMConnectorPlugin` interface.

## Quick Start

1. Create a directory named after your connector (e.g. `my-connector/`)
2. Add `connector.yaml` — declares config fields, steps, and visual metadata
3. Add `index.js` — default export implementing the `IMConnectorPlugin` interface
4. Implement your platform's webhook parsing or WebSocket connection
5. Implement `sendReply()` in the outbound adapter
6. Package as `tar czf my-connector.tar.gz my-connector/` and upload via Hub UI

## Interface Reference

### IMConnectorPlugin (required fields)

```typescript
interface IMConnectorPlugin {
  readonly id: string;                          // 'welink', 'slack', etc.
  readonly definition: ConnectorDefinition;      // Hub UI display metadata
  readonly requiredEnvKeys: readonly string[];   // Env vars that must be set
  readonly optionalEnvKeys?: readonly string[];  // Optional env vars

  isConfigured(env: Record<string, string | undefined>): boolean;
  createAdapter(ctx: IMConnectorPluginContext): IOutboundAdapter | Promise<IOutboundAdapter>;
}
```

### IMConnectorPlugin (optional lifecycle methods)

```typescript
interface IMConnectorPlugin {
  // ... required fields above ...

  // One-time setup after adapter creation (e.g. bot identity resolution)
  setup?(adapter: IOutboundAdapter, ctx: IMConnectorPluginContext): Promise<void>;

  // HTTP webhook handler — for platforms that POST events to your server
  createWebhookHandler?(
    adapter: IOutboundAdapter,
    onMessage: InboundMessageCallback,
    ctx: IMConnectorPluginContext,
  ): ConnectorWebhookHandler | undefined;

  // Non-webhook inbound — for WebSocket, long polling, SDK stream
  startInbound?(
    adapter: IOutboundAdapter,
    onMessage: InboundMessageCallback,
    ctx: IMConnectorPluginContext,
  ): Promise<IMConnectorLifecycleHandle>;

  // Media download — for inbound attachments (images, files, audio)
  createMediaDownloader?(
    adapter: IOutboundAdapter,
    ctx: IMConnectorPluginContext,
  ): MediaDownloadFn;

  // Action handler — for YAML-declared operation actions (QR scan, OAuth, etc.)
  handleAction?(
    operationName: string,
    actionId: string,
    ctx: HandleActionContext,
  ): Promise<HandleActionResult>;
}
```

At least one of `createWebhookHandler` or `startInbound` is needed to receive messages.

### HandleActionResult

When your connector declares `type: operation` fields in YAML with an `actions` chain, implement `handleAction()` to process each action:

```typescript
interface HandleActionResult {
  render: string;        // Frontend render type: 'button', 'img', 'polling', 'status'
  data: unknown;         // Payload for the frontend renderer
  label?: string;        // Optional display label
  targetValues?: Record<string, string>;  // Values to backfill into target input fields
  advance?: boolean;     // false = don't advance to next action (for polling)
}
```

**Polling data persistence:** The generic action handler persists `lastResult` on every poll cycle (replacing the previous value entirely). If your polling action reads context from `lastResult.data` (e.g. `qrPayload`), you **must** include that data in every polling response — otherwise it's lost after the first persist and subsequent polls fail.

Example: a QR-based login action chain:

```javascript
async handleAction(operationName, actionId, ctx) {
  switch (actionId) {
    case 'qr-generate':
      const qr = await myApi.generateQrCode();
      return { render: 'img', data: { url: qr.imageUrl, qrPayload: qr.id } };
    case 'qr-status':
      const payload = ctx.operationState?.lastResult?.data?.qrPayload;
      const status = await myApi.checkQrStatus(payload);
      if (status.confirmed) {
        return {
          render: 'status', data: { status: 'confirmed' },
          targetValues: { MY_TOKEN: status.token },  // backfill to input field
        };
      }
      // IMPORTANT: carry qrPayload through — the generic handler persists lastResult
      // on every poll cycle, so any data not included here is lost on the next read.
      return { render: 'polling', data: { status: 'waiting', qrPayload: payload }, advance: false };
    case 'disconnect':
      await myApi.disconnect();
      return { render: 'status', data: { status: 'disconnected' }, targetValues: { MY_TOKEN: '' } };
  }
}
```

### ConnectorDefinition

Controls how your connector appears in the Hub UI:

```javascript
const definition = {
  id: 'welink',                    // Must match plugin.id
  displayName: 'WeLink',           // Shown in UI
  icon: { type: 'png', src: '/images/connectors/welink.png' },
  themeColor: '#FF6600',           // Hex color for UI accents
  description: 'Huawei WeLink',   // Tooltip/description
};
```

**Icon options:**
- `{ type: 'png', src: '/path/to/icon.png' }` — PNG image
- `{ type: 'svg', iconId: 'my-icon' }` — SVG component (built-in connectors only)

For external plugins, use `type: 'png'` and place the icon in your package's `assets/` directory (future: the host will serve it from node_modules).

### IOutboundAdapter (minimum)

Your adapter must implement `sendReply()` at minimum:

```javascript
class MyAdapter {
  connectorId = 'welink';

  async sendReply(externalChatId, content, metadata) {
    // Call your IM platform's send message API
    await fetch('https://api.welink.com/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ chat_id: externalChatId, text: content }),
    });
  }
}
```

**Optional adapter methods** (implement for richer functionality):

| Method | Purpose |
|--------|---------|
| `sendRichMessage()` | Send messages with cards/blocks |
| `sendFormattedReply()` | Send interactive card messages |
| `sendMedia()` | Send images/files/audio |
| `addReaction()` | Add emoji reactions |
| `sendPlaceholder()` | Start a streaming edit-in-place message |
| `editMessage()` | Edit an existing message (for streaming) |
| `deleteMessage()` | Delete a message |

### IMConnectorPluginContext

The host injects these dependencies into your plugin:

```typescript
interface IMConnectorPluginContext {
  readonly env: Record<string, string | undefined>;  // Your declared env vars
  readonly log: FastifyBaseLogger;                    // Structured logger
  readonly redis?: RedisClient;                       // Optional Redis client
}
```

**Important:** `ctx.env` only contains keys declared in `requiredEnvKeys` and `optionalEnvKeys`. The host filters out everything else for isolation.

### InboundMessageCallback

When your plugin receives a message, call `onMessage()` with this shape:

```typescript
await onMessage({
  chatId: 'chat-123',           // Required: platform chat/conversation ID
  text: 'Hello!',               // Required: message text
  messageId: 'msg-456',         // Required: platform message ID (for dedup)

  // Optional fields:
  sender: { id: 'user-789', name: 'Alice' },
  chatType: 'p2p',              // 'p2p' or 'group'
  chatName: 'Dev Team',         // Group chat display name
  attachments: [{
    type: 'image',              // 'image' | 'file' | 'audio'
    platformKey: 'file-key-1',  // Platform's file ID/key
    messageId: 'msg-456',       // Some platforms need this for download
    fileName: 'photo.jpg',      // Original filename
    duration: 5,                // Audio duration in seconds
  }],
});
```

### WebhookHandleResult

Your webhook handler returns one of these result types:

```typescript
// URL verification challenge (e.g. Feishu/DingTalk verification flow)
return { kind: 'challenge', response: { challenge: 'token-xyz' } };

// Message processed successfully
return { kind: 'processed', messageId: 'msg-456' };

// Message intentionally skipped
return { kind: 'skipped', reason: 'duplicate' };

// Error (returns HTTP status to caller)
return { kind: 'error', status: 403, message: 'Invalid signature' };
```

## Patterns

### Webhook-based connector (most common)

Best for platforms that POST events to a callback URL (DingTalk, Slack, WeLink):

```javascript
const plugin = {
  id: 'myim',
  // ...
  createWebhookHandler(adapter, onMessage, ctx) {
    return {
      connectorId: 'myim',
      async handleWebhook(body, headers, rawBody) {
        // 1. Verify signature using rawBody + headers
        if (!verifySignature(rawBody, headers, ctx.env.MY_SECRET)) {
          return { kind: 'error', status: 403, message: 'Bad signature' };
        }
        // 2. Parse payload
        const msg = parseEvent(body);
        // 3. Route to Cat Cafe
        await onMessage({ chatId: msg.chatId, text: msg.text, messageId: msg.id });
        return { kind: 'processed', messageId: msg.id };
      },
    };
  },
};
```

The host registers your handler at `POST /api/connectors/{id}/webhook`. Configure this URL as the callback in your IM platform's developer console.

### WebSocket/stream connector

For platforms that push events via persistent connection:

```javascript
const plugin = {
  id: 'myim',
  // ...
  async startInbound(adapter, onMessage, ctx) {
    const ws = new WebSocket(`wss://api.myim.com/stream?token=${ctx.env.MY_TOKEN}`);

    ws.on('message', async (raw) => {
      const event = JSON.parse(raw);
      await onMessage({
        chatId: event.conversation_id,
        text: event.content,
        messageId: event.id,
      });
    });

    return {
      stop: async () => ws.close(),
    };
  },
};
```

### Dual-mode connector (webhook + WebSocket)

Some platforms support both (e.g. Feishu). Implement both methods — the host uses them based on configuration:

```javascript
const plugin = {
  id: 'myim',
  // ...
  createWebhookHandler(adapter, onMessage, ctx) {
    if (ctx.env.MY_CONNECTION_MODE === 'websocket') return undefined; // Skip
    return { /* webhook handler */ };
  },
  async startInbound(adapter, onMessage, ctx) {
    if (ctx.env.MY_CONNECTION_MODE !== 'websocket') return { stop: async () => {} };
    // WebSocket setup ...
  },
};
```

### Sharing state between lifecycle methods

Use a `WeakMap` keyed by the adapter instance to share state across `createAdapter`, `setup`, `startInbound`, etc.:

```javascript
const pluginState = new WeakMap();

const plugin = {
  createAdapter(ctx) {
    const sdk = new MyImSDK(ctx.env.MY_KEY);
    const adapter = new MyAdapter(sdk);
    pluginState.set(adapter, { sdk });
    return adapter;
  },
  async setup(adapter, ctx) {
    const { sdk } = pluginState.get(adapter);
    await sdk.refreshToken();
  },
};
```

### Media downloads

If your platform has image/file/audio attachments:

```javascript
const plugin = {
  // ...
  createMediaDownloader(adapter, ctx) {
    return async (platformKey, type, messageId) => {
      const token = await getToken(ctx.env.MY_SECRET);
      const url = `https://api.myim.com/files/${platformKey}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    };
  },
};
```

The host calls this function when processing inbound attachments and stores files locally for LLM consumption.

## Configuration

### YAML Manifest (`connector.yaml`)

Every connector ships a `connector.yaml` that declares its config fields, visual metadata, and optional action chains. The Hub UI renders config forms directly from this manifest — no frontend changes needed for new connectors.

```yaml
id: myim
name: My IM
description: My custom IM connector
icon: { type: png, src: /images/connectors/myim.png }
themeColor: '#FF6600'
docsUrl: https://docs.myim.com

config:
  - envName: MYIM_APP_KEY
    label: App Key
    type: input
    required: true

  - envName: MYIM_APP_SECRET
    label: App Secret
    type: input
    sensitive: true
    required: true

  - envName: MYIM_CONNECTION_MODE
    label: Connection Mode
    type: select
    options:
      - { value: webhook, label: Webhook }
      - { value: websocket, label: WebSocket }
    default: webhook

  - envName: MYIM_ADMIN_IDS
    label: Admin User IDs
    type: list
    itemLabel: User ID
    group: permissions
```

**Supported field types:** `input`, `toggle`, `select`, `list`, `operation`

Credentials are stored in `.cat-cafe/im-connector-config/{id}.json` (the primary store). Environment variables / `.env` serve as a legacy fallback only — users should configure via Hub UI.

### Plugin env var declarations

Declare the env keys your plugin needs (these must match your YAML `envName` values):

```javascript
const plugin = {
  requiredEnvKeys: ['MYIM_APP_KEY', 'MYIM_APP_SECRET'],
  optionalEnvKeys: ['MYIM_CONNECTION_MODE', 'MYIM_ADMIN_IDS'],
  isConfigured(env) {
    return Boolean(env.MYIM_APP_KEY && env.MYIM_APP_SECRET);
  },
};
```

### Plugin Package Format

External plugins are distributed as `.tar.gz` archives with the following structure:

```
my-connector/
├── connector.yaml   # Manifest (id, name, config fields, steps)
├── index.js         # Entry point — default export of IMConnectorPlugin
└── assets/          # Optional static resources (icons, etc.)
    └── icon.png
```

**Requirements:**
- Archive must contain exactly one top-level directory (the connector ID)
- `connector.yaml` must be present and valid (id, config fields, steps)
- `index.js` must be present and export an `IMConnectorPlugin` as default export
- The plugin ID in `connector.yaml` must not conflict with built-in connectors
- All dependencies must be self-contained (no external npm packages)

### Installing plugins

**Via Hub UI (recommended):**
1. Go to Hub → IM 对接
2. Click "安装插件" (top right) and select your `.tar.gz` archive
3. The plugin is extracted to `.cat-cafe/plugins/<id>/` and the gateway reloads
4. Your connector appears in the same list as built-in connectors (marked "外部")

**Via API:**
```bash
curl -X POST http://localhost:3002/api/connectors/plugins/install \
  -F "file=@my-connector.tar.gz"
```

**Updating:** Upload the same plugin again — files are replaced but user config is preserved.

**Uninstalling:**
```bash
# Via API (config preserved by default)
curl -X DELETE http://localhost:3002/api/connectors/plugins/my-connector

# Clear config too
curl -X DELETE http://localhost:3002/api/connectors/plugins/my-connector?clearConfig=true
```

### Legacy: npm-based loading

For backward compatibility, plugins can also be loaded from npm packages via `IM_CONNECTOR_PLUGINS`:

```bash
IM_CONNECTOR_PLUGINS=@mycompany/connector-welink,@other/connector-slack
```

> **Note:** The tar.gz package format is preferred. npm-based loading is retained as a legacy escape hatch.

## Development Workflow

### Local development

```bash
# 1. Create your plugin directory
mkdir my-connector && cd my-connector

# 2. Create connector.yaml (manifest)
cat > connector.yaml << 'YAML'
id: my-connector
name: My Connector
docsUrl: https://docs.example.com
config:
  - envName: MY_CONNECTOR_TOKEN
    label: API Token
    sensitive: true
steps:
  - text: Register a bot on the platform
  - text: Copy the API token
  - text: Paste the token above and save
YAML

# 3. Create index.js (plugin entry point)
cat > index.js << 'JS'
export default {
  id: 'my-connector',
  definition: {
    id: 'my-connector',
    displayName: 'My Connector',
    icon: { type: 'png', src: '/images/connectors/my-connector.png' },
    themeColor: '#FF6600',
    description: 'My custom connector',
  },
  requiredEnvKeys: ['MY_CONNECTOR_TOKEN'],
  isConfigured: (env) => Boolean(env.MY_CONNECTOR_TOKEN),
  createAdapter: (ctx) => new MyAdapter(ctx),
  // ... implement startInbound or createWebhookHandler
};
JS

# 4. Package as tar.gz
cd .. && tar czf my-connector.tar.gz my-connector/

# 5. Install via Hub UI → IM 对接 → 安装插件
# Or via API:
curl -X POST http://localhost:3002/api/connectors/plugins/install \
  -F "file=@my-connector.tar.gz"

# Look for: [IMConnectorLoader] Installed plugin loaded { id: 'my-connector' }

# 6. Configure credentials via Hub UI → IM Connectors → your connector
# Saved to .cat-cafe/im-connector-config/my-connector.json
```

### Testing your webhook handler

```bash
# Send a test webhook to your connector's endpoint
curl -X POST http://localhost:3002/api/connectors/myid/webhook \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-secret: test-123' \
  -d '{"chat_id": "test", "text": "Hello!", "message_id": "1"}'
```

### Packaging for distribution

```bash
# If using TypeScript, compile first:
tsc

# Package — must have exactly one top-level directory matching the connector ID
tar czf my-connector.tar.gz my-connector/

# Users install by uploading via Hub UI or API
```

## Validation & Error Handling

The host validates loaded plugins before use:

| Check | Fails if |
|-------|----------|
| `id` exists and is a string | Missing or wrong type |
| `definition` exists and is an object | Missing |
| `createAdapter` is a function | Missing |
| `isConfigured` is a function | Missing |
| ID conflicts with built-in connector | `id` matches 'feishu', 'telegram', etc. |

If validation fails, the plugin is skipped with a warning log — it won't crash the host.

## FAQ

**Q: Can I use TypeScript?**
Yes. Compile to ESM JS before publishing. The host loads via `import()` so it needs the compiled output.

**Q: How do I handle platform URL verification challenges?**
Return `{ kind: 'challenge', response: { challenge: token } }` from your `handleWebhook()`. Many platforms (Feishu, DingTalk, Slack) send a verification request when you first register a webhook URL — your handler should detect this and return the challenge token.

**Q: Can my plugin use Redis?**
Yes, `ctx.redis` is available if the host has Redis configured. Use it for token caching, session state, etc.

**Q: What if my connector needs both webhook and WebSocket?**
Implement both `createWebhookHandler()` and `startInbound()`. Use an env var to let the user choose the mode, and return `undefined` from the unused one. See the "Dual-mode connector" pattern above.

**Q: My connector ID conflicts with a built-in one — what happens?**
The host skips your plugin with a warning. Choose a unique ID that doesn't overlap with: feishu, telegram, dingtalk, xiaoyi, wecom-bot, wecom-agent, weixin.
