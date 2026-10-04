import { createAgentsApi } from '../server/agents-api.js';
import { readConfig } from '../server/config.js';
import { Run } from '../server/run.js';
import { MemoryJournal } from '../server/store.js';
import { startFixture } from './fixtures/agents-api-fixture.js';
import { startDevSite } from './fixtures/dev-site.js';

// Deliberately not shaped like a real code. It is only ever typed into the local dev test page.
export const FIXTURE_CODE = 'FIXTURE-CONFIRM';
export const TOOL_RESULT = 'agent.session.input.tool_result';

export async function waitFor(check, { timeout = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Gives queued work a moment to run, for asserting that nothing happened. */
export const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two local dev test sites and a scripted Agents API. `cast` stands where the
 * CAST origin is configured and `start` where the start page is, so tests can
 * tell "on the redemption origin" from "on another allowed website".
 */
export async function startWorld(t, { armed = false, env = {} } = {}) {
  const [fixture, cast, start] = await Promise.all([startFixture(), startDevSite(), startDevSite()]);
  t.after(async () => {
    await Promise.all([fixture.close(), cast.close(), start.close()]);
  });
  const config = readConfig({
    OPENAI_API_KEY: 'fixture-key-not-real',
    OPENAI_BASE_URL: fixture.baseUrl,
    MAYA_TEST_MODE: '1',
    START_URL: start.home,
    EXPECTED_REDEEM_URL: cast.form,
    CODE_RELEASE: armed ? 'enabled' : '',
    MAYA_RECONNECT_BASE_MS: '10',
    MAYA_ACTION_TIMEOUT_MS: '1500',
    MAYA_DATA_DIR: '/nonexistent-unused',
    ...env,
  });
  return { fixture, cast, start, config };
}

/** A run on real Chromium, wired to the scripted API, with helpers to drive and inspect it. */
export async function setup(t, options = {}) {
  const world = options.world ?? (await startWorld(t, options));
  const { fixture, cast, start, config } = world;
  const journal = options.journal ?? new MemoryJournal();
  const logs = [];
  const ops = [];
  const run = new Run({
    ownerHash: 'owner-hash',
    config,
    api: createAgentsApi({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
    journal,
    log: (level, message) => logs.push(`${level} ${message}`),
    createBrowser: options.createBrowser,
  });
  run.subscribe((op) => ops.push(op));
  t.after(() => run.dispose());

  const c = {
    ...world,
    run,
    journal,
    logs,
    ops,
    timeline: (kind) => run.snapshot().timeline.filter((entry) => !kind || entry.kind === kind),
    cards: (card) => c.timeline('card').filter((entry) => !card || entry.card === card),
    state: () => run.snapshot().status.state,
    page: () => run.browser.pageForTests(),
    toolResults: () => fixture.inputsOf(TOOL_RESULT),
    text: (selector) => c.page().locator(selector).textContent(),

    /** Everything the app could show, store, or log, as one string. */
    exposed() {
      return JSON.stringify({ view: run.snapshot(), ops, logs, journal: [...(journal.records?.values() ?? [])] });
    },

    /** Every request body the app sent to the Agents API: what the model could see. */
    sentToApi() {
      return JSON.stringify(fixture.state.requests.map((request) => request.body));
    },

    async begin(text = 'Can you help me redeem my Singtel AI Pass on CAST?') {
      await run.postMessage(text);
      fixture.turnStart();
      await waitFor(() => run.snapshot().status.turnActive, { label: 'turn start' });
    },

    /** The model calls a tool; resolves with the tool_result the app returns. */
    async tool(name, args = {}, options_ = {}) {
      const action = fixture.functionCall(name, args, options_);
      const result = await waitFor(() => c.toolResults().find((entry) => entry.call_id === action.call_id), {
        label: `result of ${name}`,
      });
      let data = null;
      try {
        data = result.success ? JSON.parse(result.output) : null;
      } catch {
        // A plain-text result.
      }
      return { ...result, action, data };
    },

    /** The model calls a tool that waits on the presenter; returns the pending call. */
    ask(name, args = {}, options_ = {}) {
      return fixture.functionCall(name, args, options_);
    },

    resultOf(action) {
      return waitFor(() => c.toolResults().find((entry) => entry.call_id === action.call_id), { label: 'tool result' });
    },

    pendingCard(card) {
      return waitFor(() => c.cards(card).find((entry) => entry.status === 'pending'), { label: `pending ${card} card` });
    },

    refOf: (observation, name) => observation.elements.find((element) => element.name === name)?.ref,

    /** Opens the dev test form on the redemption origin and returns the form references. */
    async toForm(address = cast.form) {
      await c.tool('browser_navigate', { url: address });
      const { data } = await c.tool('browser_observe');
      return {
        code_field_ref: c.refOf(data, 'Test code'),
        submit_button_ref: c.refOf(data, 'Submit test code'),
        account_context: 'Dev test account',
        page_summary: 'Dev test form',
        payment_requested: false,
      };
    },

    /** Brings the run to a pending authorization card. */
    async toCard(address) {
      await c.begin();
      const args = await c.toForm(address);
      const action = c.ask('request_redemption_submission', args);
      return { action, args, card: await c.pendingCard('release') };
    },

    /** Stages the fixture code and authorizes it; resolves once the app has answered the call. */
    async submit(address, code = FIXTURE_CODE) {
      const { action, card } = await c.toCard(address);
      await run.stageCode(card.id, code);
      await run.postMessage('confirm', { replyTo: card.id });
      return { action, card, result: await c.resultOf(action) };
    },

    report(outcome, message = 'Dev page text') {
      return c.tool('report_redemption_result', { outcome, page_message: message, confirmation_reference: '' });
    },
  };
  return c;
}
