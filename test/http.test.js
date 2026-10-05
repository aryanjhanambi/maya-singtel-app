import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createAgentsApi } from '../server/agents-api.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/http.js';
import { MemoryJournal } from '../server/store.js';
import { FIXTURE_CODE, TOOL_RESULT, startWorld, waitFor } from './helpers.js';

async function startApp(t, { configured = true, armed = false } = {}) {
  const world = await startWorld(t, { armed });
  const { fixture, config } = world;
  const logs = [];
  const journal = new MemoryJournal();
  const app = createApp({
    config: configured ? config : readConfig({ MAYA_DATA_DIR: '/nonexistent-unused' }),
    api: configured ? createAgentsApi({ apiKey: config.apiKey, baseUrl: config.baseUrl }) : null,
    journal,
    log: (level, message) => logs.push(`${level} ${message}`),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(() => app.close());

  /** A browser-like client with its own cookie jar. */
  function client() {
    let cookie = null;
    const call = (method, path, body, headers = {}) =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: {
              ...(cookie ? { Cookie: cookie } : {}),
              ...(method === 'GET' ? {} : { 'X-Maya-Request': '1', 'Content-Type': 'application/json' }),
              ...headers,
            },
          },
          (response) => {
            const isStream = (response.headers['content-type'] ?? '').includes('text/event-stream');
            const chunks = [];
            response.on('data', (chunk) => {
              chunks.push(chunk);
              // A stream never ends by itself: take what arrives in the first moments.
              if (isStream && !response.timer) response.timer = setTimeout(() => response.destroy(), 700);
            });
            const finish = () => {
              const setCookie = response.headers['set-cookie']?.[0];
              if (setCookie) cookie = setCookie.split(';')[0];
              const raw = Buffer.concat(chunks);
              const isJson = (response.headers['content-type'] ?? '').includes('application/json');
              resolve({ status: response.statusCode, headers: response.headers, body: isJson && raw.length ? JSON.parse(raw.toString('utf8')) : raw.toString('utf8') });
            };
            response.on('end', finish);
            response.on('close', finish);
          },
        );
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
      });
    call.ownerHash = () => createHash('sha256').update(cookie.split('=')[1]).digest('hex');
    return call;
  }

  /** A client that owns a run with a started session and browser. */
  async function owner() {
    const call = client();
    await call('GET', '/api/config');
    const created = await call('POST', '/api/runs', {});
    assert.equal(created.status, 201);
    const runId = created.body.run.id;
    const path = (suffix) => `/api/runs/${runId}/${suffix}`;
    const view = async () => (await call('GET', '/api/runs/current')).body.run;
    const tool = async (name, args = {}) => {
      const action = fixture.functionCall(name, args);
      return waitFor(() => fixture.inputsOf(TOOL_RESULT).find((entry) => entry.call_id === action.call_id), { label: name });
    };
    await call('POST', path('messages'), { text: 'Can you help me redeem my Singtel AI Pass on CAST?' });
    fixture.turnStart();
    return { call, runId, path, view, tool };
  }

  return { ...world, app, client, owner, logs, journal, port };
}

test('without an API key the app reports setup, starts no browser, and contacts nothing', async (t) => {
  const { client, fixture, app } = await startApp(t, { configured: false });
  const call = client();
  const config = await call('GET', '/api/config');
  assert.equal(config.body.configured, false);
  assert.equal(config.body.codeRelease, 'locked');
  assert.equal(config.body.browser, 'app_chromium');

  const created = await call('POST', '/api/runs', {});
  assert.equal(created.status, 503);
  assert.equal(created.body.error.code, 'not_configured');
  assert.deepEqual((await call('GET', '/api/runs/current')).body, { run: null, previous: null });
  assert.equal(fixture.state.requests.length, 0);
  assert.equal(app.runs.size, 0);
});

test('the live browser stream, control, and input belong to the browser that owns the run', async (t) => {
  const { client, owner, start, port, logs } = await startApp(t);
  const a = await owner();
  await a.tool('browser_navigate', { url: start.home });

  // Frames and state arrive on the owner's stream.
  const stream = await a.call('GET', a.path('browser/stream'));
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /text\/event-stream/);
  assert.match(stream.body, /"t":"state"/);
  assert.match(stream.body, /"t":"frame","seq":\d+,"d":"\/9j\//, 'a JPEG frame was sent');

  // Input is refused until the owner has control.
  const refused = await a.call('POST', a.path('browser/input'), { events: [{ t: 'move', x: 1, y: 1 }] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'not_in_control');

  assert.equal((await a.call('POST', a.path('browser/control'), { action: 'take' })).status, 200);
  assert.equal((await a.view()).status.browser.controller, 'human');
  const typed = await a.call('POST', a.path('browser/input'), { events: [{ t: 'text', text: 'HTTP-ONLY-SECRET-55' }] });
  assert.deepEqual([typed.status, typed.body], [200, { ok: true }]);
  assert.equal((await a.call('POST', a.path('browser/input'), { events: new Array(65).fill({ t: 'move', x: 1, y: 1 }) })).status, 400);
  const malformed = await a.call('POST', a.path('browser/input'), '{"events":[{"t":"text","text":"HTTP-ONLY-SECRET-66"');
  assert.equal(malformed.status, 400);
  assert.equal(JSON.stringify(malformed.body).includes('SECRET'), false);
  assert.equal((await a.call('POST', a.path('messages'), { text: 'hello' })).body.error.code, 'human_in_control');

  // Another browser sees nothing and can do nothing.
  const b = client();
  await b('GET', '/api/config');
  assert.equal((await b('GET', '/api/runs/current')).body.run, null);
  for (const [method, suffix, body] of [
    ['GET', 'browser/stream'],
    ['GET', 'stream'],
    ['POST', 'browser/control', { action: 'return' }],
    ['POST', 'browser/input', { events: [{ t: 'text', text: 'x' }] }],
    ['POST', 'messages', { text: 'confirm' }],
    ['POST', 'stop', {}],
    ['POST', 'end', { force: true }],
  ]) {
    assert.equal((await b(method, a.path(suffix), body)).status, 404, `${method} ${suffix}`);
  }
  const second = await b('POST', '/api/runs', {});
  assert.equal(second.status, 201, 'a second owner can start an isolated browser session');
  assert.notEqual(second.body.run.id, a.runId);
  assert.equal((await client()('POST', '/api/runs', {})).status, 401);
  assert.equal((await a.view()).status.browser.controller, 'human', 'the other browser did not take control back');

  // Cross-origin, headerless, and foreign-host requests are refused, input included.
  const input = { events: [{ t: 'text', text: 'x' }] };
  assert.equal((await a.call('POST', a.path('browser/input'), input, { Origin: 'http://evil.example' })).body.error.code, 'cross_origin');
  assert.equal((await a.call('POST', a.path('browser/control'), { action: 'return' }, { 'X-Maya-Request': '0' })).body.error.code, 'missing_header');
  assert.equal((await a.call('GET', a.path('browser/stream'), undefined, { Host: `evil.example:${port}` })).body.error.code, 'bad_host');

  assert.equal((await a.call('POST', a.path('browser/control'), { action: 'return' })).status, 200);
  const everything = JSON.stringify({ view: await a.view(), logs });
  assert.equal(everything.includes('HTTP-ONLY-SECRET'), false, 'presenter input is not in the view or the logs');
});

test('an earlier session is described, never attached or deleted without being asked', async (t) => {
  const { client, fixture, journal, app } = await startApp(t);
  const call = client();
  await call('GET', '/api/config');
  const record = (id, extra) =>
    journal.save({ id, ownerHash: call.ownerHash(), sessionId: `sess_${id}`, createdAt: Date.now() - (id === 'hosted' ? 2000 : 1000), endedAt: null, ...extra });

  // One from the hosted-browser version, and a newer one whose browser died with a restart.
  record('hosted', { releases: [{ status: 'released', outcome: null }] });
  record('restarted', { engine: 'playwright', submissions: [{ status: 'not_submitted', outcome: null }] });

  let { body } = await call('GET', '/api/runs/current');
  assert.equal(body.run, null);
  assert.deepEqual(
    { ...body.previous, createdAt: 0 },
    { id: 'restarted', sessionId: 'sess_restarted', engine: 'app_browser', createdAt: 0, codeUsed: false, outcome: null },
  );
  const blocked = await call('POST', '/api/runs', {});
  assert.equal(blocked.body.error.code, 'previous_session_open');
  assert.equal(app.runs.size, 0, 'no run and no browser were started for it');
  assert.equal(fixture.state.requests.length, 0, 'the session was not contacted');

  // Keeping it closes the notice and leaves the session alone.
  assert.equal((await call('POST', '/api/previous/restarted', { action: 'dismiss' })).status, 200);
  assert.equal(journal.get('restarted').closedBy, 'dismissed');
  assert.equal(fixture.state.requests.length, 0);

  ({ body } = await call('GET', '/api/runs/current'));
  assert.deepEqual(
    { ...body.previous, createdAt: 0 },
    { id: 'hosted', sessionId: 'sess_hosted', engine: 'hosted_browser', createdAt: 0, codeUsed: true, outcome: 'unknown' },
  );
  assert.equal((await client()('GET', '/api/runs/current')).status, 401, 'no cookie, no answer');
  const other = client();
  await other('GET', '/api/config');
  assert.equal((await other('GET', '/api/runs/current')).body.previous, null, 'another browser is not shown it');
  assert.equal((await other('POST', '/api/previous/hosted', { action: 'delete' })).status, 404);

  // Deleting happens only on this explicit request, and once.
  assert.equal((await call('POST', '/api/previous/hosted', { action: 'erase' })).status, 400);
  assert.equal((await call('POST', '/api/previous/hosted', { action: 'delete' })).status, 200);
  const deletes = fixture.state.requests.filter((request) => request.method === 'DELETE');
  assert.deepEqual(deletes.map((request) => request.path), ['/v1/agents/sessions/sess_hosted']);
  assert.equal(journal.get('hosted').closedBy, 'deleted');
  assert.equal((await call('GET', '/api/runs/current')).body.previous, null);
  assert.equal((await call('POST', '/api/runs', {})).status, 201);
});

test('starting a new run never deletes a failed session whose submission outcome is unknown', async (t) => {
  const { owner, fixture, cast } = await startApp(t, { armed: true });
  const a = await owner();
  await a.tool('browser_navigate', { url: cast.form });
  const seen = JSON.parse((await a.tool('browser_observe')).output);
  const ref = (name) => seen.elements.find((element) => element.name === name).ref;
  const submit = fixture.functionCall('request_redemption_submission', {
    code_field_ref: ref('Test code'),
    submit_button_ref: ref('Submit test code'),
    account_context: '',
    page_summary: '',
    payment_requested: false,
  });
  const card = await waitFor(async () => (await a.view()).timeline.find((entry) => entry.card === 'release'), { label: 'card' });
  assert.equal((await a.call('PUT', a.path('cards/card-404/code'), { code: FIXTURE_CODE })).status, 404);
  assert.equal((await a.call('PUT', a.path(`cards/${card.id}/code`), { code: FIXTURE_CODE })).status, 200);
  await a.call('POST', a.path('messages'), { text: 'confirm', replyTo: card.id });
  await waitFor(() => fixture.inputsOf(TOOL_RESULT).find((entry) => entry.call_id === submit.call_id), { label: 'submitted' });

  fixture.emit({ type: 'agent.session.failed', error: { type: 'server_error', code: 'internal_error' } });
  await waitFor(async () => (await a.view()).status.state === 'failed', { label: 'failed' });

  const blocked = await a.call('POST', '/api/runs', {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'outcome_unknown');
  assert.equal(fixture.state.deleted, false, 'the session is kept for inspection');
  assert.equal((await a.view()).status.browser.running, true, 'and so is its browser');

  // Only an explicit, forced end by the owner removes it.
  assert.equal((await a.call('POST', a.path('end'), {})).status, 409);
  assert.equal((await a.call('POST', a.path('end'), { force: true })).status, 200);
  assert.equal(fixture.state.deleted, true);
  assert.equal((await a.call('POST', '/api/runs', {})).status, 201);
  assert.equal(JSON.stringify(fixture.state.requests.map((request) => request.body)).includes(FIXTURE_CODE), false);
});
