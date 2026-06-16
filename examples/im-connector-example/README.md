# @example/im-connector-echo

Minimal IM connector plugin example for [Cat Cafe](https://github.com/zts212653/clowder-ai).

Demonstrates the `IMConnectorPlugin` interface with a webhook-based echo connector that receives POST webhooks and routes them as inbound messages.

## Quick Start

```bash
# 1. Install (or npm link for local development)
cd your-cat-cafe-project
pnpm add @example/im-connector-echo

# 2. Configure environment
echo 'IM_CONNECTOR_PLUGINS=@example/im-connector-echo' >> .env
echo 'ECHO_WEBHOOK_SECRET=my-secret-123' >> .env

# 3. Restart Cat Cafe
pnpm start
```

## Test It

```bash
# Send a test webhook
curl -X POST http://localhost:3002/api/connectors/echo/webhook \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-secret: my-secret-123' \
  -d '{"chat_id": "test-chat", "text": "Hello from echo!", "message_id": "msg-1"}'
```

## Project Structure

```
src/
  index.js    # Plugin entry point — export default IMConnectorPlugin
package.json  # name + main field pointing to src/index.js
```

## Plugin Interface

Your plugin must `export default` an object implementing `IMConnectorPlugin`:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique connector ID (lowercase, no spaces) |
| `definition` | Yes | Display metadata for Hub UI (displayName, icon, themeColor) |
| `requiredEnvKeys` | Yes | Env vars needed to start |
| `isConfigured(env)` | Yes | Returns true when credentials are sufficient |
| `createAdapter(ctx)` | Yes | Creates outbound adapter with `sendReply()` method |
| `createWebhookHandler(adapter, onMessage, ctx)` | No | HTTP webhook handler |
| `startInbound(adapter, onMessage, ctx)` | No | WebSocket/polling/stream inbound |
| `createMediaDownloader(adapter, ctx)` | No | Download platform media to local Buffer |
| `setup(adapter, ctx)` | No | One-time async setup |

At least one of `createWebhookHandler` or `startInbound` must be implemented to receive messages.

## More Info

See the full [IM Connector 开发文档](../../docs/guides/im-connector-dev-guide.md) for detailed documentation.
