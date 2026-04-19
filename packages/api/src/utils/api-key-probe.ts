/**
 * F140: Minimal API-key connectivity probe.
 * Replaces the deleted provider-profiles-probe by inlining protocol-specific test logic.
 */

type ProbeProtocol = 'anthropic' | 'openai' | 'openai-responses' | 'google' | 'kimi';

/**
 * Map clientId to the protocol its API speaks.
 * Only list single-protocol providers here; multi-provider tools like opencode
 * fall through to URL-based inference in inferProtocolFromUrl().
 */
const CLIENT_PROTOCOL: Record<string, ProbeProtocol> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  kimi: 'openai',
  dare: 'openai',
};

function buildHeaders(protocol: ProbeProtocol, apiKey: string): Record<string, string> {
  switch (protocol) {
    case 'anthropic':
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    case 'google':
      return { 'x-goog-api-key': apiKey };
    default:
      return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1(?:beta)?$/, '');
}

function inferProtocolFromUrl(baseUrl: string): ProbeProtocol {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('googleapis') || lower.includes('generativelanguage') || lower.includes('gemini')) return 'google';
  return 'openai';
}

export interface ApiKeyProbeResult {
  ok: boolean;
  mode: 'api_key';
  status?: number;
  message?: string;
  error?: string;
}

export interface ProbeApiKeyOptions {
  model?: string;
  /** Explicit client identity — takes precedence over URL-based inference. */
  clientId?: string;
}

export async function probeApiKey(
  baseUrl: string,
  apiKey: string,
  opts: ProbeApiKeyOptions = {},
): Promise<ApiKeyProbeResult> {
  const base = normalizeBaseUrl(baseUrl);
  const protocol = (opts.clientId && CLIENT_PROTOCOL[opts.clientId]) || inferProtocolFromUrl(base);

  try {
    if (protocol === 'anthropic') {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: buildHeaders(protocol, apiKey),
        body: JSON.stringify({
          model: opts.model ?? 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.ok) return { ok: true, mode: 'api_key', status: res.status, message: `${opts.model ?? '连接'}正常` };
      const error = await res.text().catch(() => '');
      return { ok: false, mode: 'api_key', status: res.status, error: error.slice(0, 400) };
    }

    if (protocol === 'google') {
      const path = opts.model ? `/v1beta/models/${opts.model}` : '/v1beta/models';
      const res = await fetch(`${base}${path}`, {
        method: 'GET',
        headers: buildHeaders(protocol, apiKey),
      });
      if (res.ok) return { ok: true, mode: 'api_key', status: res.status, message: `${opts.model ?? '连接'}正常` };
      const error = await res.text().catch(() => '');
      return { ok: false, mode: 'api_key', status: res.status, error: error.slice(0, 400) };
    }

    // OpenAI-compatible
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(protocol, apiKey),
      body: JSON.stringify({
        model: opts.model ?? 'gpt-4o-mini',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (res.ok) return { ok: true, mode: 'api_key', status: res.status, message: `${opts.model ?? '连接'}正常` };
    const error = await res.text().catch(() => '');
    return { ok: false, mode: 'api_key', status: res.status, error: error.slice(0, 400) };
  } catch (err) {
    return { ok: false, mode: 'api_key', error: err instanceof Error ? err.message : String(err) };
  }
}
