import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const SINGTEL_AI_PASS_URL = 'https://www.singtel.com/personal/products-services/lifestyle-services/ai-pass';
const DEMO_START_URL = 'https://aryanjhanambi.github.io/singtel_demos/';
const DEMO_ENTITLEMENT_URL = 'https://aryanjhanambi.github.io/singtel_demos/ai-pass.html';
const DEMO_PARTNER_HOSTS = ['manus.im', 'hailuoai.video', 'otter.ai', 'www.minimax.io', 'akool.com'];
const DEMO_TRANSITION_HOSTS = ['cast.singtel.com'];

/** Loads .env if present. Variables already in the environment win. */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Normalizes an origin or URL to scheme://host[:port], or null if it cannot be parsed. */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  for (const candidate of [text, `https://${text}`]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // Try the next form.
    }
  }
  return null;
}

export function readConfig(env = process.env) {
  const value = (name) => env[name]?.trim() || null;
  const boundedNumber = (name, fallback, minimum, maximum) => {
    const raw = value(name);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  };
  const baseUrl = (value('OPENAI_BASE_URL') ?? OPENAI_BASE_URL).replace(/\/+$/, '');
  // Test mode uses the local fixture's guarded code-submission path.
  const testMode = value('MAYA_TEST_MODE') === '1';
  // The hosted simulation is the safe default. Set MAYA_DEMO_MODE=false only
  // when deliberately using the real CAST test flow.
  const demoMode = !testMode && value('MAYA_DEMO_MODE')?.toLowerCase() !== 'false';
  const expectedRedeemUrl =
    value('EXPECTED_REDEEM_URL') ??
    (demoMode ? DEMO_ENTITLEMENT_URL : 'https://cast.singtel.com/order/login?redirectIntent=voucherRedemption');
  const startUrl =
    value('START_URL') ??
    (demoMode ? SINGTEL_AI_PASS_URL : SINGTEL_AI_PASS_URL);
  const allowedHostSuffixes = [
    'singtel.com',
    'gomo.sg',
    ...(value('ALLOWED_HOST_SUFFIXES') ?? '').split(',').map((domain) => domain.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '')).filter(Boolean),
  ];
  const publicHost = value('PUBLIC_HOST');
  const accessPassword = value('MAYA_ACCESS_PASSWORD');
  const turnstileSiteKey = value('CLOUDFLARE_TURNSTILE_SITE_KEY');
  const turnstileSecretKey = value('CLOUDFLARE_TURNSTILE_SECRET_KEY');
  if (publicHost && (!accessPassword || accessPassword.length < 16)) {
    throw new Error('A public deployment requires MAYA_ACCESS_PASSWORD with at least 16 characters.');
  }
  if (Boolean(turnstileSiteKey) !== Boolean(turnstileSecretKey)) {
    throw new Error('Cloudflare Turnstile requires both CLOUDFLARE_TURNSTILE_SITE_KEY and CLOUDFLARE_TURNSTILE_SECRET_KEY.');
  }
  return {
    // The only origin on which the app will release the test code.
    castOrigin: new URL(expectedRedeemUrl).origin,
    apiKey: value('OPENAI_API_KEY'),
    baseUrl,
    // Luna evaluation build; Railway can override this with OPENAI_AGENT_MODEL.
    model: value('OPENAI_AGENT_MODEL') ?? 'gpt-6-luna',
    // Keep reasoning effort configurable for the selected model.
    reasoningEffort: value('OPENAI_REASONING_EFFORT') ?? 'low',
    host: value('HOST') ?? '127.0.0.1',
    publicHost,
    accessPassword,
    turnstileSiteKey,
    turnstileSecretKey,
    port: Number(value('PORT')) || 4310,
    demoMode,
    startUrl,
    expectedRedeemUrl,
    // Hosts Maya's tools may open, read, and click on. The presenter can go
    // anywhere while in control; this bounds the model only.
    allowedHosts: [
      ...new Set([
        new URL(startUrl).host,
        new URL(expectedRedeemUrl).host,
        ...(demoMode ? [new URL(DEMO_START_URL).host, ...DEMO_TRANSITION_HOSTS, ...DEMO_PARTNER_HOSTS] : []),
        ...(value('ALLOWED_HOSTS') ?? '').split(',').map((host) => host.trim()).filter(Boolean),
      ]),
    ],
    allowedHostSuffixes: [...new Set(allowedHostSuffixes)],
    browserHeadless: value('BROWSER_HEADLESS')?.toLowerCase() !== 'false',
    // Leave the channel unset by default so Playwright uses its bundled
    // Chromium executable in local and container deployments.
    browserChannel: value('BROWSER_CHANNEL'),
    actionTimeoutMs: Number(value('MAYA_ACTION_TIMEOUT_MS')) || 10_000,
    testMode,
    // Locked unless explicitly armed: the CAST test code is single use.
    codeReleaseEnabled: value('CODE_RELEASE')?.toLowerCase() === 'enabled',
    dataDir: value('MAYA_DATA_DIR') ?? path.join(ROOT, '.data'),
    // Anything other than the real endpoint is labelled in the UI so it can
    // never pass for a live OpenAI session.
    fixtureMode: value('MAYA_UI_FIXTURE') === '1' || testMode || baseUrl !== OPENAI_BASE_URL,
    reconnectBaseMs: Number(value('MAYA_RECONNECT_BASE_MS')) || 1000,
    // Bound concurrent Playwright browsers for a small hosted demo. Each run
    // remains isolated by its owner cookie and run id.
    maxSessions: boundedNumber('MAYA_MAX_SESSIONS', 6, 1, 20),
    sessionIdleMs: boundedNumber('MAYA_SESSION_IDLE_MS', 30 * 60 * 1000, 60_000, 4 * 60 * 60 * 1000),
    sessionMaxAgeMs: boundedNumber('MAYA_SESSION_MAX_AGE_MS', 2 * 60 * 60 * 1000, 5 * 60_000, 12 * 60 * 60 * 1000),
    authSessionTtlMs: boundedNumber('MAYA_AUTH_SESSION_TTL_MS', 12 * 60 * 60 * 1000, 5 * 60_000, 24 * 60 * 60 * 1000),
    authMaxFailures: boundedNumber('MAYA_AUTH_MAX_FAILURES', 5, 2, 20),
    authFailureWindowMs: boundedNumber('MAYA_AUTH_FAILURE_WINDOW_MS', 15 * 60 * 1000, 60_000, 60 * 60 * 1000),
    authLockoutMs: boundedNumber('MAYA_AUTH_LOCKOUT_MS', 15 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    maxMessagesPerMinute: boundedNumber('MAYA_MAX_MESSAGES_PER_MINUTE', 30, 5, 120),
    maxInputRequestsPerMinute: boundedNumber('MAYA_MAX_INPUT_REQUESTS_PER_MINUTE', 1800, 120, 6000),
    logLevel: value('LOG_LEVEL') ?? 'info',
  };
}

/** Blocks literal loopback/private/link-local addresses and metadata hostnames. */
export function isPrivateNetworkHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (['metadata.google.internal', 'instance-data', '169.254.169.254'].includes(host)) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (version === 6) {
    return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host);
  }
  return false;
}

/**
 * Whether Maya's tools may act on this address: HTTPS on an exact host or
 * within an explicitly approved domain suffix. Suffix matching is label
 * bounded (so `notgomo.sg` does not match `gomo.sg`) and rejects custom ports.
 * Plain HTTP is accepted only in test mode, for the local dev page.
 */
export function agentMayUse(address, config) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const secure = url.protocol === 'https:' || (config.testMode && url.protocol === 'http:');
  const exactHost = config.allowedHosts.includes(url.host);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const domainSuffix = !url.port && (config.allowedHostSuffixes ?? []).some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  return secure && (config.testMode || !isPrivateNetworkHost(url.hostname)) && (exactHost || domainSuffix);
}
