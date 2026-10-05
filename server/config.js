import { existsSync } from 'node:fs';
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
  return {
    // The only origin on which the app will release the test code.
    castOrigin: new URL(expectedRedeemUrl).origin,
    apiKey: value('OPENAI_API_KEY'),
    baseUrl,
    model: value('OPENAI_AGENT_MODEL') ?? 'gpt-6-astra',
    host: value('HOST') ?? '127.0.0.1',
    publicHost: value('PUBLIC_HOST'),
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
    logLevel: value('LOG_LEVEL') ?? 'info',
  };
}

/**
 * Whether Maya's tools may act on this address: HTTPS on an allow-listed
 * host. Plain HTTP is accepted only in test mode, for the local dev page.
 */
export function agentMayUse(address, config) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const secure = url.protocol === 'https:' || (config.testMode && url.protocol === 'http:');
  return secure && config.allowedHosts.includes(url.host);
}
