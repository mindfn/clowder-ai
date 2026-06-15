# IM Connector Plugin Guide

> Build a custom IM connector for Cat Cafe without modifying the main repository.

## Overview

Cat Cafe's IM connector plugin system (F231) lets you integrate any messaging platform by publishing an npm package that implements the `IMConnectorPlugin` interface. Install the package, set a few environment variables, restart — done.

```
pnpm add @mycompany/connector-welink
# .env
IM_CONNECTOR_PLUGINS=@mycompany/connector-welink
WELINK_APP_KEY=xxx
WELINK_APP_SECRET=yyy
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

1. Copy the example: `examples/im-connector-example/`
2. Rename the connector ID, definition, and env keys
3. Implement your platform's webhook parsing or WebSocket connection
4. Implement `sendReply()` in the outbound adapter
5. Publish to npm (or use `npm link` for local dev)

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
}
```

At least one of `createWebhookHandler` or `startInbound` is needed to receive messages.

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

## Environment Variables

### Plugin env vars

Declare all env vars your plugin needs:

```javascript
const plugin = {
  requiredEnvKeys: ['MYIM_APP_KEY', 'MYIM_APP_SECRET'],
  optionalEnvKeys: ['MYIM_WEBHOOK_TOKEN', 'MYIM_ADMIN_IDS'],
  isConfigured(env) {
    return Boolean(env.MYIM_APP_KEY && env.MYIM_APP_SECRET);
  },
};
```

### Host env var

Users activate external plugins via `IM_CONNECTOR_PLUGINS`:

```bash
# Single plugin
IM_CONNECTOR_PLUGINS=@mycompany/connector-welink

# Multiple plugins (comma-separated)
IM_CONNECTOR_PLUGINS=@mycompany/connector-welink,@other/connector-slack
```

## Development Workflow

### Local development

```bash
# 1. Create your plugin package
mkdir my-connector && cd my-connector
npm init -y
# Set "type": "module" and "main": "src/index.js" in package.json

# 2. Implement the plugin (copy from examples/im-connector-example/)

# 3. Link into your Cat Cafe dev instance
npm link
cd /path/to/cat-cafe
npm link my-connector

# 4. Add to .env
echo 'IM_CONNECTOR_PLUGINS=my-connector' >> .env
echo 'MY_WEBHOOK_SECRET=test-123' >> .env

# 5. Start Cat Cafe
pnpm start
# Look for: [IMConnectorLoader] External connector loaded { id: 'myid' }
```

### Testing your webhook handler

```bash
# Send a test webhook to your connector's endpoint
curl -X POST http://localhost:3002/api/connectors/myid/webhook \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-secret: test-123' \
  -d '{"chat_id": "test", "text": "Hello!", "message_id": "1"}'
```

### Publishing

```bash
# Build (if using TypeScript)
tsc

# Publish
npm publish --access public
```

Users install with:

```bash
pnpm add @mycompany/connector-myim
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

## Reference Implementations

Study these built-in plugins as references (from simplest to most complex):

| Plugin | Lines | Pattern | Notable |
|--------|-------|---------|---------|
| `im-connectors/xiaoyi/` | ~75 | WebSocket stream | Simplest; async import for heavy SDK |
| `im-connectors/telegram/` | ~77 | Long polling | Token normalization |
| `im-connectors/dingtalk/` | ~117 | Webhook + signature | HMAC verification with raw body |
| `im-connectors/wecom-bot/` | ~109 | WebSocket stream | Dynamic start/stop lifecycle |
| `im-connectors/wecom-agent/` | ~136 | Webhook (GET+POST) | XML parsing + AES decryption |
| `im-connectors/weixin/` | ~134 | Polling | Session state management; always-create pattern |
| `im-connectors/feishu/` | ~325 | Webhook + WebSocket | Most complex; OAuth token, card actions, media |

## FAQ

**Q: Can I use TypeScript?**
Yes. Compile to ESM JS before publishing. The host loads via `import()` so it needs the compiled output.

**Q: How do I handle platform URL verification challenges?**
Return `{ kind: 'challenge', response: { challenge: token } }` from your `handleWebhook()`. See the Feishu or DingTalk plugin for examples.

**Q: Can my plugin use Redis?**
Yes, `ctx.redis` is available if the host has Redis configured. Use it for token caching, session state, etc.

**Q: What if my connector needs both webhook and WebSocket?**
Implement both `createWebhookHandler()` and `startInbound()`. Use an env var to let the user choose the mode, and return `undefined` from the unused one. See the Feishu plugin.

**Q: My connector ID conflicts with a built-in one — what happens?**
The host skips your plugin with a warning. Choose a unique ID that doesn't overlap with: feishu, telegram, dingtalk, xiaoyi, wecom-bot, wecom-agent, weixin.
