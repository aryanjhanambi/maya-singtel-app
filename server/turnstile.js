const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Validates a single-use Turnstile token at Cloudflare; any ambiguity fails closed. */
export async function verifyTurnstile({ secret, token, remoteIp, expectedHostname, fetchImpl = fetch }) {
  if (!secret || typeof token !== 'string' || !token.trim()) return false;
  const body = new URLSearchParams({ secret, response: token.trim() });
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    const hostname = String(expectedHostname ?? '').split(':')[0].toLowerCase();
    return result.success === true && result.action === 'maya-login' && (!hostname || result.hostname === hostname);
  } catch {
    return false;
  }
}
