// Session-scoped read client. Bootstraps the owner session through the loopback
// GET /api/session route (session-auth.ts) and only ever issues GET requests.
export async function createApiClient(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  const cookies = new Map();

  async function request(path) {
    const headers = new Headers();
    if (cookies.size > 0) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(`${base}${path}`, { method: 'GET', headers, redirect: 'manual' });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  }

  const session = await request('/api/session');
  if (!session.ok) throw new Error(`session_bootstrap_failed:${session.status}`);
  const sessionBody = await session.json();

  return {
    userId: typeof sessionBody?.userId === 'string' ? sessionBody.userId : null,
    async getJson(path) {
      const response = await request(path);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
  };
}
