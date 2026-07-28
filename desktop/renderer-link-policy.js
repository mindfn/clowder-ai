// Desktop popup policy. Electron-created child windows stay denied; this
// predicate decides whether the URL may be handed to the system browser.

function isAllowedRendererLink(url, allowedHttpOrigins = new Set()) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && allowedHttpOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

module.exports = { isAllowedRendererLink };
