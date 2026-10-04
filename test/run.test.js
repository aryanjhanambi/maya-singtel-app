import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { FIXTURE_CODE, settle, setup, waitFor } from './helpers.js';

const SUBMIT = 'request_redemption_submission';
const posts = (fixture) =>
  fixture.state.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/events')).length;

// ---- Session start -----------------------------------------------------------

test('a session is created with initial input, no environment, and only function tools', async (t) => {
  const c = await setup(t);
  const text = 'Can you help me redeem my Singtel AI Pass on CAST?';
  await c.run.postMessage(text);

  const [body] = c.fixture.state.createBodies;
  assert.deepEqual(body.environment, { type: 'none' });
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text }] }]);
  assert.ok(body.agent.tools.length >= 8);
  assert.ok(body.agent.tools.every((tool) => tool.type === 'function'), 'no hosted computer_use tool');
  assert.deepEqual(
    c.fixture.state.requests.map((request) => `${request.method} ${request.path.replace(/sess_fixture_\d+/, ':id')}`),
    ['POST /v1/agents/sessions', 'GET /v1/agents/sessions/:id/events', 'GET /v1/agents/sessions/:id', 'GET /v1/agents/sessions/:id/items'],
    'the first message is not posted again after creation',
  );
  const status = c.run.snapshot().status;
  assert.equal(status.browser.running, true);
  assert.equal(status.connection, 'live');
  assert.equal(c.journal.findOpen('owner-hash').engine, 'playwright');
});

test('a tool call made before the stream opened is picked up by reconcile', async (t) => {
  const c = await setup(t);
  let early;
  c.fixture.state.onCreate = (fixture) => {
    early = { type: 'function_call', turn_id: 'turn_1', call_id: 'call_early', name: 'browser_navigate', arguments: { url: c.start.home } };
    fixture.state.session.required_actions.push(early);
    fixture.state.session.status = 'requires_action';
  };
  await c.run.postMessage('Can you help me redeem my Singtel AI Pass on CAST?');
  const result = await c.resultOf(early);
  assert.equal(result.success, true);
  assert.equal(JSON.parse(result.output).address, c.start.home);
});

test('no session is created when Chromium cannot start', async (t) => {
  const broken = Object.assign(new EventEmitter(), {
    start: async () => {
      throw new Error('no browser');
    },
    close: async () => {},
    state: () => ({ closed: true }),
  });
  const c = await setup(t, { createBrowser: () => broken });
  await c.run.postMessage('Can you help me redeem my Singtel AI Pass on CAST?');
  assert.equal(c.fixture.state.createBodies.length, 0);
  assert.equal(c.run.snapshot().status.sessionId, null);
  assert.match(c.timeline('notice').at(-1).text, /Chromium could not be started/);
});

test('the browser is closed again when the session cannot be created', async (t) => {
  const c = await setup(t);
  await c.fixture.close();
  await c.run.postMessage('Can you help me redeem my Singtel AI Pass on CAST?');
  assert.equal(c.run.browser, null);
  assert.equal(c.state(), 'idle');
  assert.match(c.timeline('notice').at(-1).text, /could not be created/);
});

// ---- Tools executed by the app ---------------------------------------------------

test('Maya’s browser tools are executed by the app and report honestly', async (t) => {
  const c = await setup(t);
  await c.begin();

  const opened = await c.tool('browser_navigate', { url: c.start.home });
  assert.equal(opened.data.address, c.start.home);

  await c.page().fill('#field-a', 'TYPED-BY-NOBODY-123');
  const seen = await c.tool('browser_observe');
  assert.equal(seen.data.title, 'Dev test page');
  assert.equal(seen.output.includes('TYPED-BY-NOBODY-123'), false, 'field contents are not observed');

  const clicked = await c.tool('browser_click', { ref: c.refOf(seen.data, 'Count: 0') });
  assert.equal(clicked.data.clicked, 'Count: 0');
  assert.equal(await c.text('#counter'), 'Count: 1');

  // Failures go back to the model as errors, not as invented results.
  assert.equal((await c.tool('browser_click', { ref: c.refOf(seen.data, 'Count: 0') })).success, false);
  assert.equal((await c.tool('browser_navigate', { url: 'https://example.com/' })).success, false);
  assert.equal((await c.tool('unknown_tool')).success, false);

  const view = c.run.snapshot();
  assert.deepEqual(
    view.steps.slice(0, 3).map((step) => [step.title, step.status, step.hasImage]),
    [
      [`Opened ${c.start.home}`, 'completed', true],
      ['Read the page', 'completed', false],
      ['Clicked “Count: 0”', 'completed', true],
    ],
  );
  assert.ok(c.run.image(view.steps[0].id));
  assert.ok(view.events.some((row) => row.source === 'App · Playwright' && row.type === 'browser_click'));
});

test('a result whose acknowledgement was lost is returned again without repeating the action', async (t) => {
  const c = await setup(t);
  await c.begin();
  await c.tool('browser_navigate', { url: c.start.home });
  const seen = await c.tool('browser_observe');

  c.fixture.state.failNextInput = { status: 500 };
  const action = c.ask('browser_click', { ref: c.refOf(seen.data, 'Count: 0') });
  await waitFor(() => c.run.snapshot().events.some((row) => row.type === 'tool_result.error'), { label: 'failed delivery' });
  assert.equal(await c.text('#counter'), 'Count: 1');

  // The app checks the session again by itself and hands back the saved result.
  const result = await c.resultOf(action);
  assert.equal(result.success, true);
  assert.equal(JSON.parse(result.output).clicked, 'Count: 0');
  await settle(100);
  assert.equal(await c.text('#counter'), 'Count: 1', 'the click was not performed twice');
});

// ---- Presenter takeover ----------------------------------------------------------

test('sign-in is a takeover: Maya waits, sees nothing of it, and is told only that control came back', async (t) => {
  const c = await setup(t);
  await c.begin();
  await c.tool('browser_navigate', { url: c.start.home });

  const login = c.ask('request_customer_login', { reason: 'Please sign in on this page.' });
  const card = await c.pendingCard('takeover');
  assert.equal(card.address, c.start.home, 'the address comes from the browser');
  assert.equal(c.state(), 'needs_input');
  await assert.rejects(() => c.run.humanInput([{ t: 'move', x: 1, y: 1 }]), { code: 'not_in_control' });

  await c.run.takeControl();
  assert.equal(c.state(), 'human_control');
  await assert.rejects(c.run.postMessage('91234567'), { code: 'human_in_control' });

  // A tool call that arrives during the takeover is held, not run.
  const held = c.ask('browser_observe');
  const box = await c.page().locator('#secret').boundingBox();
  const at = { x: box.x + 10, y: box.y + 10 };
  await c.run.humanInput([
    { t: 'down', ...at, button: 'left' },
    { t: 'up', ...at, button: 'left' },
    { t: 'text', text: 'HUMAN-ONLY-OTP-778899' },
  ]);
  assert.equal(await c.page().locator('#secret').inputValue(), 'HUMAN-ONLY-OTP-778899');
  await settle(150);
  assert.equal(c.toolResults().some((entry) => [login.call_id, held.call_id].includes(entry.call_id)), false);
  const stepsDuring = c.run.snapshot().steps.filter((step) => step.hasImage).length;

  await c.run.returnControl();
  const loginResult = await c.resultOf(login);
  assert.equal(loginResult.success, true);
  assert.match(loginResult.output, /returned control/);
  const observed = await c.resultOf(held);
  assert.equal(observed.success, true);

  assert.equal(c.cards('takeover')[0].status, 'answered');
  assert.equal(c.run.snapshot().steps.filter((step) => step.hasImage).length, stepsDuring, 'no screenshot was taken for the held call during takeover');
  assert.equal(c.sentToApi().includes('HUMAN-ONLY-OTP'), false, 'nothing the presenter typed reached the API');
  assert.equal(c.exposed().includes('HUMAN-ONLY-OTP'), false);
  assert.equal(c.exposed().includes('91234567'), false);
  assert.ok(c.run.snapshot().events.some((row) => row.source === 'Presenter' && row.type === 'control.taken'));
});

test('the sign-in request can be declined by typing cancel', async (t) => {
  const c = await setup(t);
  await c.begin();
  const login = c.ask('request_customer_login', { reason: 'Please sign in.' });
  await c.pendingCard('takeover');
  await c.run.postMessage('later maybe');
  assert.equal(c.cards('takeover')[0].status, 'pending');
  await c.run.postMessage('cancel');
  assert.equal((await c.resultOf(login)).success, false);
  assert.equal(c.cards('takeover')[0].outcome, 'Declined');
});

// ---- Code gate -------------------------------------------------------------------

test('code release is locked by default: no code is accepted and nothing is typed', async (t) => {
  const c = await setup(t);
  const { card } = await c.toCard();
  assert.equal(card.locked, true);
  assert.equal(c.state(), 'ready_to_redeem');

  await assert.rejects(c.run.stageCode(card.id, FIXTURE_CODE), { code: 'release_locked' });
  await c.run.postMessage('confirm', { replyTo: card.id });
  assert.equal(await c.page().locator('#code').inputValue(), '');
  assert.equal(await c.text('#submissions'), 'Submissions: 0');
  assert.equal(c.cards('release')[0].status, 'pending');
});

test('the app enters the code itself after exact confirmation; the model never receives it', async (t) => {
  const c = await setup(t, { armed: true });
  const { action, card } = await c.toCard();
  assert.equal(card.source, 'App');
  assert.equal(card.address, c.cast.form, 'the address is read from the browser');
  assert.equal(card.fieldLabel, 'Test code');
  assert.equal(card.buttonLabel, 'Submit test code');

  await c.run.postMessage('confirm', { replyTo: card.id });
  assert.equal(await c.text('#submissions'), 'Submissions: 0', 'no code staged');

  await c.run.stageCode(card.id, FIXTURE_CODE);
  assert.equal(c.cards('release')[0].maskedReference.includes('FIXTURE'), false);
  await c.run.postMessage('yes', { replyTo: card.id });
  await c.run.postMessage('ok confirm', { replyTo: card.id });
  assert.equal(await c.text('#submissions'), 'Submissions: 0', 'only the exact word authorizes');

  await c.run.postMessage('Confirm', { replyTo: card.id });
  const result = await c.resultOf(action);
  assert.equal(result.success, true);
  assert.equal(await c.text('#result'), 'DEV RESULT: accepted');
  assert.equal(await c.text('#submissions'), 'Submissions: 1');
  assert.equal(c.state(), 'submitting');
  assert.equal(c.journal.findOpen('owner-hash').submissions[0].status, 'submitted');

  // A second "confirm" has no card and no code: it is only a chat message.
  await c.run.postMessage('confirm');
  assert.equal(await c.text('#submissions'), 'Submissions: 1');

  assert.equal(c.sentToApi().includes(FIXTURE_CODE), false, 'the code was never sent to the Agents API');
  assert.equal(c.exposed().includes(FIXTURE_CODE), false);
});

test('after a submission Maya cannot click or navigate her way to a second one', async (t) => {
  const c = await setup(t, { armed: true });
  await c.submit();
  assert.equal(await c.text('#submissions'), 'Submissions: 1');

  // Looking is still allowed and gives her the button's reference.
  const seen = await c.tool('browser_observe');
  const button = c.refOf(seen.data, 'Submit test code');
  assert.ok(button);

  const click = await c.tool('browser_click', { ref: button });
  assert.equal(click.success, false);
  assert.equal(await c.text('#submissions'), 'Submissions: 1', 'a generic click did not submit again');
  assert.equal((await c.tool('browser_navigate', { url: c.cast.form })).success, false);
  assert.equal((await c.tool('browser_switch_tab', { tab_id: 't1' })).success, false);
  assert.equal((await c.tool('browser_scroll', { direction: 'down' })).success, true);

  const again = await c.tool(SUBMIT, {
    code_field_ref: c.refOf(seen.data, 'Test code'),
    submit_button_ref: button,
    account_context: '',
    page_summary: '',
    payment_requested: false,
  });
  assert.equal(again.success, false);
  assert.equal(c.cards('release').filter((card) => card.status === 'pending').length, 0);
  assert.equal(await c.text('#submissions'), 'Submissions: 1');
});

test('a click that may not have completed is unknown: never retried, and no route to a second attempt', async (t) => {
  const c = await setup(t, { armed: true });
  const { result } = await c.submit(`${c.cast.form}?cover=1`);
  assert.equal(result.success, true);
  assert.match(result.output, /could not confirm/);
  assert.equal(c.run.submissions[0].status, 'submit_unknown');
  assert.equal(c.state(), 'outcome_unknown');
  assert.equal(c.cards('result')[0].outcome, 'unknown');

  // The form is still filled and its button still there; Maya must not be able to press it.
  await c.page().evaluate(() => document.getElementById('overlay').remove());
  const seen = await c.tool('browser_observe');
  const click = await c.tool('browser_click', { ref: c.refOf(seen.data, 'Submit test code') });
  assert.equal(click.success, false);
  assert.equal(await c.text('#submissions'), 'Submissions: 0');

  const again = await c.tool(SUBMIT, {
    code_field_ref: c.refOf(seen.data, 'Test code'),
    submit_button_ref: c.refOf(seen.data, 'Submit test code'),
    account_context: '',
    page_summary: '',
    payment_requested: false,
  });
  assert.equal(again.success, false);
  assert.equal(c.sentToApi().includes(FIXTURE_CODE), false);
});

test('a code that could not be entered is not a submission, and a new request is possible', async (t) => {
  const c = await setup(t, { armed: true });
  const { action, card } = await c.toCard();
  await c.run.stageCode(card.id, FIXTURE_CODE);
  await c.page().evaluate(() => document.getElementById('code').setAttribute('readonly', ''));
  await c.run.postMessage('confirm', { replyTo: card.id });

  assert.equal((await c.resultOf(action)).success, false);
  assert.equal(c.run.submissions[0].status, 'not_submitted');
  assert.equal(await c.text('#submissions'), 'Submissions: 0');
  assert.equal(c.cards('result').length, 0);

  await c.page().evaluate(() => document.getElementById('code').removeAttribute('readonly'));
  const seen = await c.tool('browser_observe');
  c.ask(SUBMIT, {
    code_field_ref: c.refOf(seen.data, 'Test code'),
    submit_button_ref: c.refOf(seen.data, 'Submit test code'),
    account_context: '',
    page_summary: '',
    payment_requested: false,
  });
  assert.equal((await c.pendingCard('release')).codeStaged, false, 'the code has to be entered again');
});

test('a submission is offered only on the redemption origin, for a real empty field and button', async (t) => {
  const c = await setup(t, { armed: true });
  await c.begin();

  // The same form on another allowed website is not the redemption origin.
  const elsewhere = await c.toForm(c.start.form);
  assert.equal((await c.tool(SUBMIT, elsewhere)).success, false);

  const args = await c.toForm();
  for (const bad of [
    { ...args, payment_requested: true },
    { ...args, payment_requested: 'false' },
    { code_field_ref: args.code_field_ref, submit_button_ref: args.submit_button_ref },
    { ...args, code_field_ref: 's0e1' },
    { ...args, code_field_ref: args.submit_button_ref },
    { ...args, submit_button_ref: args.code_field_ref },
    'not json',
  ]) {
    assert.equal((await c.tool(SUBMIT, bad)).success, false);
  }

  // A field that already has text in it is not the empty form.
  await c.page().fill('#code', 'already here');
  assert.equal((await c.tool(SUBMIT, args)).success, false);

  assert.equal(c.cards('release').length, 0);
  assert.equal(await c.text('#submissions'), 'Submissions: 0');
});

test('authorization fails safe if the page, the call, or control changed after the request', async (t) => {
  const c = await setup(t, { armed: true });

  // The page changed.
  let { action, card } = await c.toCard();
  await c.run.stageCode(card.id, FIXTURE_CODE);
  await c.page().goto(c.cast.home);
  await c.run.postMessage('confirm', { replyTo: card.id });
  assert.equal((await c.resultOf(action)).success, false);
  assert.equal(c.cards('release')[0].status, 'closed');
  assert.equal(c.run.submissions.length, 0);

  // The call is no longer pending on the session.
  let args = await c.toForm();
  action = c.ask(SUBMIT, args);
  card = await c.pendingCard('release');
  await c.run.stageCode(card.id, FIXTURE_CODE);
  c.fixture.dropAction((pending) => pending.call_id === action.call_id);
  await c.run.postMessage('confirm', { replyTo: card.id });
  assert.equal(c.cards('release').at(-1).status, 'closed');
  assert.equal(c.run.submissions.length, 0);

  // A reply bound to a different card, and the presenter holding the browser.
  args = await c.toForm();
  c.ask(SUBMIT, args);
  card = await c.pendingCard('release');
  await c.run.stageCode(card.id, FIXTURE_CODE);
  await c.run.postMessage('confirm', { replyTo: 'card-from-elsewhere' });
  await c.run.takeControl();
  await assert.rejects(c.run.postMessage('confirm', { replyTo: card.id }), { code: 'human_in_control' });

  assert.equal(c.run.submissions.length, 0);
  assert.equal(await c.text('#submissions'), 'Submissions: 0');
  assert.equal(await c.page().locator('#code').inputValue(), '');
});

test('nothing is typed when the submission cannot be written to the journal', async (t) => {
  const journal = {
    fail: false,
    records: new Map(),
    save(record) {
      if (this.fail) throw new Error('disk full');
      this.records.set(record.id, structuredClone(record));
    },
    get(id) {
      return this.records.get(id) ?? null;
    },
    findOpen: () => null,
  };
  const c = await setup(t, { armed: true, journal });
  const { action, card } = await c.toCard();
  await c.run.stageCode(card.id, FIXTURE_CODE);

  journal.fail = true;
  await c.run.postMessage('confirm', { replyTo: card.id });
  assert.equal(await c.page().locator('#code').inputValue(), '');
  assert.equal(c.run.submissions.length, 0);
  assert.equal(c.cards('release')[0].status, 'pending');

  journal.fail = false;
  await c.run.postMessage('confirm', { replyTo: card.id });
  assert.equal((await c.resultOf(action)).success, true);
  assert.equal(await c.text('#submissions'), 'Submissions: 1');
});

test('a page that echoes the code does not leak it to the model, the view, or the logs', async (t) => {
  const c = await setup(t, { armed: true });
  await c.submit(`${c.cast.form}?echo=1`);
  assert.equal(await c.text('#result'), `DEV RESULT: accepted for ${FIXTURE_CODE}`);

  const seen = await c.tool('browser_observe');
  assert.equal(seen.output.includes(FIXTURE_CODE), false);
  assert.match(seen.output, /DEV RESULT: accepted for \[test code\]/);
  await c.report('confirmed', `Accepted for ${FIXTURE_CODE.toLowerCase()}`);

  assert.equal(c.sentToApi().toLowerCase().includes(FIXTURE_CODE.toLowerCase()), false);
  assert.equal(c.exposed().toLowerCase().includes(FIXTURE_CODE.toLowerCase()), false);
});

test('a chat message containing the staged code is neither sent nor shown', async (t) => {
  const c = await setup(t, { armed: true });
  const { card } = await c.toCard();
  await c.run.stageCode(card.id, FIXTURE_CODE);
  const before = posts(c.fixture);
  await c.run.postMessage(`my code is ${FIXTURE_CODE}`);
  assert.equal(posts(c.fixture), before);
  assert.equal(c.exposed().includes(FIXTURE_CODE), false);
});

// ---- Result ------------------------------------------------------------------------

test('a confirmation needs a submission, the redemption origin, and a screenshot the app takes', async (t) => {
  const c = await setup(t, { armed: true });
  await c.begin();
  await c.tool('browser_navigate', { url: c.cast.form });
  assert.equal((await c.report('confirmed')).success, false, 'no submission yet');
  assert.equal(c.cards('result').length, 0);

  const args = (await c.tool('browser_observe')).data;
  const action = c.ask(SUBMIT, {
    code_field_ref: c.refOf(args, 'Test code'),
    submit_button_ref: c.refOf(args, 'Submit test code'),
    account_context: '',
    page_summary: '',
    payment_requested: false,
  });
  const card = await c.pendingCard('release');
  await c.run.stageCode(card.id, FIXTURE_CODE);
  await c.run.postMessage('confirm', { replyTo: card.id });
  await c.resultOf(action);

  // The browser is somewhere other than the redemption origin: not confirmed.
  await c.page().goto(c.start.home);
  assert.equal((await c.report('confirmed')).success, false);
  assert.equal(c.cards('result')[0].outcome, 'not_confirmed');
  assert.equal(c.state(), 'outcome_unknown');

  await c.page().goto(`${c.cast.form}?after`);
  const accepted = await c.report('confirmed', 'DEV RESULT: accepted');
  assert.equal(accepted.success, true);
  const result = c.cards('result')[0];
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.address, `${c.cast.form}?after`, 'the address is the browser’s, not the model’s');
  assert.equal(result.pageMessage, 'DEV RESULT: accepted');
  assert.ok(c.run.image(result.evidenceStepId), 'the app captured the page itself');
  assert.equal(c.state(), 'confirmed');
});

test('a turn that completes after a submission is not treated as success', async (t) => {
  const c = await setup(t, { armed: true });
  await c.submit();
  c.fixture.say('All done!');
  c.fixture.turnEnd('completed');
  await waitFor(() => c.state() === 'outcome_unknown', { label: 'outcome unknown' });
  assert.equal(c.cards('result')[0].outcome, 'unknown');
});

test('after a rejection seen on the page, a retry must reload the form and be authorized again', async (t) => {
  const c = await setup(t, { armed: true });
  await c.submit(undefined, 'FIXTURE-REJECT');
  assert.equal(await c.text('#result'), 'DEV RESULT: rejected');
  assert.equal((await c.report('rejected', 'DEV RESULT: rejected')).success, true);
  c.fixture.turnEnd('completed');
  await waitFor(() => c.state() === 'rejected', { label: 'rejected' });

  c.fixture.turnStart('turn_2');
  const seen = await c.tool('browser_observe', {}, { turnId: 'turn_2' });
  const click = await c.tool('browser_click', { ref: c.refOf(seen.data, 'Submit test code') }, { turnId: 'turn_2' });
  assert.equal(click.success, false, 'no click on the still-filled form');
  assert.equal(await c.text('#submissions'), 'Submissions: 1');

  await c.tool('browser_navigate', { url: c.cast.form }, { turnId: 'turn_2' });
  const fresh = await c.tool('browser_observe', {}, { turnId: 'turn_2' });
  c.ask(
    SUBMIT,
    {
      code_field_ref: c.refOf(fresh.data, 'Test code'),
      submit_button_ref: c.refOf(fresh.data, 'Submit test code'),
      account_context: '',
      page_summary: '',
      payment_requested: false,
    },
    { turnId: 'turn_2' },
  );
  const card = await c.pendingCard('release');
  assert.equal(card.codeStaged, false, 'the presenter must enter and confirm a code again');
});

// ---- Disconnects, loss, and ending ---------------------------------------------------

test('a dropped stream is recovered from saved state without resending customer input', async (t) => {
  const c = await setup(t);
  await c.begin();
  await c.tool('browser_navigate', { url: c.start.home });
  const before = posts(c.fixture);

  c.fixture.dropStreams();
  const login = c.ask('request_customer_login', { reason: 'Please sign in.' });
  c.fixture.say('I need you to sign in.');
  await waitFor(() => c.run.snapshot().status.connection === 'live' && c.cards('takeover').length === 1, { label: 'reconnect' });
  await waitFor(() => c.timeline('maya').length === 1, { label: 'restored message' });
  assert.equal(posts(c.fixture), before, 'nothing was posted while reconnecting');
  assert.equal(c.fixture.inputsOf('agent.session.input.message').length, 0);
  assert.equal(c.toolResults().some((entry) => entry.call_id === login.call_id), false);
});

test('a browser that dies is reported, not replaced, and the session is not deleted', async (t) => {
  const c = await setup(t, { armed: true });
  await c.submit();
  const login = c.ask('request_customer_login', { reason: 'Please sign in.' });
  await c.pendingCard('takeover');

  await c.page().context().browser().close();
  await waitFor(() => c.state() === 'browser_lost', { label: 'browser lost' });
  assert.equal(c.cards('takeover')[0].status, 'closed');
  assert.equal(c.cards('result')[0].outcome, 'unknown', 'the submitted code has no seen outcome');
  assert.equal((await c.tool('browser_observe')).success, false);
  assert.equal(c.fixture.state.deleted, false);
  assert.equal(c.fixture.state.createBodies.length, 1, 'no new session or browser was started');
  await assert.rejects(() => c.run.takeControl(), { code: 'no_browser' });
  assert.equal(c.toolResults().some((entry) => entry.call_id === login.call_id), false);

  await assert.rejects(c.run.end(), { code: 'outcome_unknown' });
  const ending = c.run.end({ force: true });
  await waitFor(() => c.fixture.inputsOf('agent.session.input.cancel').length === 1, { label: 'cancel' });
  c.fixture.turnEnd('cancelled');
  await ending;
  assert.equal(c.fixture.state.deleted, true);
});

test('stop cancels the turn, drops queued actions, and clears a staged code', async (t) => {
  const c = await setup(t, { armed: true });
  const { card } = await c.toCard();
  await c.run.stageCode(card.id, FIXTURE_CODE);
  await c.run.stop();
  assert.deepEqual(c.fixture.state.inputs.at(-1), { type: 'agent.session.input.cancel' });
  assert.equal(c.cards('release')[0].codeStaged, false);
  await c.run.postMessage('confirm', { replyTo: card.id });
  assert.equal(await c.text('#submissions'), 'Submissions: 0');
});

test('ending deletes the session once and closes the browser', async (t) => {
  const c = await setup(t);
  await c.begin();
  await c.tool('browser_navigate', { url: c.start.home });
  const browser = c.run.browser;
  const ending = c.run.end();
  await waitFor(() => c.fixture.inputsOf('agent.session.input.cancel').length === 1, { label: 'cancel' });
  c.fixture.turnEnd('cancelled');
  await ending;
  assert.equal(c.fixture.state.requests.filter((request) => request.method === 'DELETE').length, 1);
  assert.equal(browser.state().closed, true);
  assert.equal(c.state(), 'ended');
  assert.equal(c.run.snapshot().status.browser.running, false);
  assert.equal(c.journal.findOpen('owner-hash'), null);
});
