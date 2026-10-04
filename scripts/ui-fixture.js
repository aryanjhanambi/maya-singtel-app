// UI harness: runs the real app, with its real Chromium browser, against a
// scripted local Agents API and a generic local dev test page. It contacts
// neither OpenAI nor Singtel nor CAST. The page carries a permanent "UI
// fixture" banner and the browser shows pages labelled "DEV TEST PAGE". It is
// a development aid for reviewing the interface, not a demo path.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentsApi } from '../server/agents-api.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/http.js';
import { Journal } from '../server/store.js';
import { startFixture } from '../test/fixtures/agents-api-fixture.js';
import { startDevSite } from '../test/fixtures/dev-site.js';

const TOOL_RESULT = 'agent.session.input.tool_result';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refOf = (observation, name) => observation.elements.find((element) => element.name === name)?.ref;

/** Scripts the stand-in API to call the app's tools the way a session might. */
function installScenario(fixture, { start, cast, delay }) {
  const waiting = new Map();
  const call = (name, args = {}) =>
    new Promise((resolve) => {
      const action = fixture.functionCall(name, args);
      waiting.set(action.call_id, resolve);
    });

  async function script() {
    await pause(Math.max(delay, 400));
    fixture.turnStart();
    fixture.say('I can help you through the CAST redemption. I’ll open the page and ask you to sign in when needed.');
    await call('browser_navigate', { url: start.home });
    let seen = JSON.parse((await call('browser_observe')).output);
    await pause(delay);
    await call('browser_click', { ref: refOf(seen, 'Count: 0') });
    await pause(delay);
    await call('browser_navigate', { url: cast.home });
    fixture.say('This page needs you to sign in. Please take control of the browser and sign in yourself.');
    const login = await call('request_customer_login', { reason: 'Sign in on this page yourself, then return control to me.' });
    if (!login.success) {
      fixture.say('I’ll stop here.');
      return fixture.turnEnd('completed');
    }
    await call('browser_navigate', { url: cast.form });
    seen = JSON.parse((await call('browser_observe')).output);
    fixture.say('I’m at the redemption form. Add your test code in the code field, then confirm when you’re ready for me to submit it.');
    const submitted = await call('request_redemption_submission', {
      code_field_ref: refOf(seen, 'Test code'),
      submit_button_ref: refOf(seen, 'Submit test code'),
      account_context: 'Dev test account',
      page_summary: 'Dev test form, no payment requested',
      payment_requested: false,
    });
    if (!submitted.success) {
      fixture.say('I’ll stop here at the empty code form.');
      return fixture.turnEnd('completed');
    }
    seen = JSON.parse((await call('browser_observe')).output);
    const message = (seen.text.match(/DEV RESULT: [^\n]*/) ?? [''])[0];
    const outcome = /accepted/.test(message) ? 'confirmed' : /rejected/.test(message) ? 'rejected' : 'not_confirmed';
    await call('report_redemption_result', { outcome, page_message: message, confirmation_reference: '' });
    fixture.say(
      {
        confirmed: 'The page confirms the redemption was accepted.',
        rejected: 'The page says this code was rejected. Please check the test code before we try again.',
        not_confirmed: 'I haven’t seen a confirmation yet. I’ll check this session before making another attempt.',
      }[outcome],
    );
    return fixture.turnEnd('completed');
  }

  fixture.state.onCreate = () => void script().catch(() => {});
  fixture.state.onInput = async (input) => {
    if (input.type === TOOL_RESULT) waiting.get(input.call_id)?.(input);
    else if (input.type === 'agent.session.input.cancel') fixture.turnEnd('cancelled');
    else if (input.type === 'agent.session.input.message') {
      fixture.turnStart('turn_extra');
      await pause(delay);
      fixture.say('This is the UI fixture. It plays one scripted sequence.', { turnId: 'turn_extra' });
      fixture.turnEnd('completed', 'turn_extra');
    }
  };
}

/** Starts the stand-in API, the dev test pages, and the app on top of them. Used by the visual check too. */
export async function startHarness({ port = 4311, delay = 600, env = {} } = {}) {
  const [fixture, start, cast] = await Promise.all([startFixture(), startDevSite(), startDevSite()]);
  installScenario(fixture, { start, cast, delay });
  const config = readConfig({
    OPENAI_API_KEY: 'fixture-key-not-real',
    OPENAI_BASE_URL: fixture.baseUrl,
    MAYA_UI_FIXTURE: '1',
    MAYA_TEST_MODE: '1',
    START_URL: start.home,
    EXPECTED_REDEEM_URL: cast.form,
    // Fixture codes go nowhere but the local dev page, so release is armed unless overridden.
    CODE_RELEASE: process.env.CODE_RELEASE ?? 'enabled',
    MAYA_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'maya-ui-fixture-')),
    PORT: String(port),
    ...env,
  });
  const journal = new Journal(config.dataDir);
  const app = createApp({
    config,
    api: createAgentsApi({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
    journal,
  });
  await new Promise((resolve) => app.server.listen(port, config.host, resolve));
  return {
    url: `http://${config.host}:${app.server.address().port}`,
    fixture,
    journal,
    server: app.server,
    runs: app.runs,
    browserStreams: app.browserStreams,
    start,
    cast,
    async close() {
      await app.close();
      await Promise.all([fixture.close(), start.close(), cast.close()]);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const harness = await startHarness({ port: Number(process.env.PORT) || 4311 });
  console.log(`[maya] UI fixture harness at ${harness.url}`);
  console.log('[maya] Scripted local API and a local dev test page in real Chromium. Not OpenAI, not Singtel, not CAST.');
  console.log('[maya] Try the code FIXTURE-CONFIRM, FIXTURE-REJECT, or anything else for "not confirmed".');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void harness.close().then(() => process.exit(0)));
}
