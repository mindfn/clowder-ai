/**
 * @example/im-connector-echo — Minimal IM Connector Plugin for Cat Cafe
 *
 * Demonstrates the IMConnectorPlugin interface with a webhook-based
 * echo connector. Receives POST webhooks and routes them as inbound
 * messages; outbound replies are logged (replace with your IM's send API).
 *
 * Usage:
 *   1. pnpm add @example/im-connector-echo   (or npm link for local dev)
 *   2. Set env: IM_CONNECTOR_PLUGINS=@example/im-connector-echo
 *   3. Set env: ECHO_WEBHOOK_SECRET=your-secret
 *   4. Restart Cat Cafe
 *   5. POST to /api/connectors/echo/webhook with JSON body
 *
 * @see https://github.com/user/clowder-ai/docs/guides/im-connector-plugin-guide.md
 */

// ── Connector Definition (Hub UI display metadata) ───────────────

const definition = {
  id: 'echo',
  displayName: 'Echo Bot',
  icon: { type: 'png', src: '/images/connectors/default.png' },
  themeColor: '#6B7280',
  description: 'Example echo connector for development',
};

// ── Outbound Adapter ─────────────────────────────────────────────

/**
 * Minimal IOutboundAdapter implementation.
 * Replace the console.log with your IM platform's HTTP send API.
 */
class EchoAdapter {
  connectorId = 'echo';

  async sendReply(externalChatId, content, _metadata) {
    // TODO: Replace with your IM platform's send message API
    console.log(`[echo] sendReply to ${externalChatId}: ${content}`);
  }
}

// ── The Plugin ───────────────────────────────────────────────────

/** @type {import('cat-cafe').IMConnectorPlugin} */
const echoPlugin = {
  id: 'echo',
  definition,

  // Env vars the host checks before starting this connector
  requiredEnvKeys: ['ECHO_WEBHOOK_SECRET'],
  optionalEnvKeys: [],

  // Return true when credentials are sufficient to start
  isConfigured(env) {
    return Boolean(env.ECHO_WEBHOOK_SECRET);
  },

  // Create the outbound adapter — called once at startup
  createAdapter(_ctx) {
    return new EchoAdapter();
  },

  // Create a webhook handler — receives HTTP POSTs from your IM platform
  createWebhookHandler(_adapter, onMessage, ctx) {
    const secret = ctx.env.ECHO_WEBHOOK_SECRET;
    return {
      connectorId: 'echo',

      /**
       * Handle an inbound webhook from the IM platform.
       *
       * @param {unknown} body - Parsed JSON body
       * @param {Record<string, string>} headers - HTTP headers
       * @returns {Promise<import('cat-cafe').WebhookHandleResult>}
       */
      async handleWebhook(body, headers) {
        // 1. Verify authenticity (replace with your platform's signature check)
        if (headers['x-webhook-secret'] !== secret) {
          return { kind: 'error', status: 403, message: 'Invalid secret' };
        }

        // 2. Parse the platform-specific payload
        const payload = /** @type {Record<string, unknown>} */ (body);
        const chatId = String(payload.chat_id ?? 'unknown');
        const text = String(payload.text ?? '');
        const messageId = String(payload.message_id ?? `echo-${Date.now()}`);

        if (!text) {
          return { kind: 'skipped', reason: 'empty_text' };
        }

        // 3. Route to Cat Cafe's message processing pipeline
        await onMessage({
          chatId,
          text,
          messageId,
          // Optional fields:
          // sender: { id: 'user-123', name: 'Alice' },
          // chatType: 'p2p',
          // attachments: [{ type: 'image', platformKey: 'file-key-1' }],
        });

        return { kind: 'processed', messageId };
      },
    };
  },

  // Optional: media download function for attachments
  // createMediaDownloader(adapter, ctx) {
  //   return async (platformKey, type, messageId) => {
  //     const res = await fetch(`https://your-im.com/api/download/${platformKey}`);
  //     return Buffer.from(await res.arrayBuffer());
  //   };
  // },

  // Optional: one-time setup after adapter creation
  // async setup(adapter, ctx) {
  //   ctx.log.info('[echo] Running one-time setup');
  // },

  // Optional: non-webhook inbound (WebSocket, long polling, SDK stream)
  // async startInbound(adapter, onMessage, ctx) {
  //   const ws = new WebSocket('wss://your-im.com/stream');
  //   ws.on('message', (data) => onMessage({ ... }));
  //   return { stop: async () => ws.close() };
  // },
};

export default echoPlugin;
