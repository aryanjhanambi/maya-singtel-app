import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentsApiError } from '../server/agents-api.js';
import { normalizeOrigin, readConfig } from '../server/config.js';
import { buildSessionRequest } from '../server/instructions.js';
import { matchReply } from '../server/replies.js';
import { CodeVault } from '../server/secrets.js';
import { createSseParser } from '../server/sse.js';
import { summarizeApiEvent } from '../server/summarize.js';

function parse(chunks) {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

test('SSE parser handles events split across chunks and CRLF boundaries', () => {
  const events = parse(['data: {"a"', ':1}\r', '\n\r\n', ': comment\n', 'event: x\ndata: one\ndata: two\n\n']);
  assert.deepEqual(events, [
    { event: 'message', data: '{"a":1}' },
    { event: 'x', data: 'one\ntwo' },
  ]);
});

test('SSE parser does not dispatch an event until its blank line arrives', () => {
  assert.deepEqual(parse(['data: partial\n']), []);
});

test('typed replies match only the exact lists', () => {
  assert.equal(matchReply('release', 'Confirm'), 'authorize');
  assert.equal(matchReply('release', '  confirm. '), 'authorize');
  assert.equal(matchReply('release', 'cancel'), 'decline');
  assert.equal(matchReply('release', 'no'), 'decline');
  assert.equal(matchReply('takeover', 'Cancel'), 'decline');

  // Anything else is not a decision.
  assert.equal(matchReply('release', 'yes'), null);
  assert.equal(matchReply('release', 'allow'), null);
  assert.equal(matchReply('release', 'confirm it please'), null);
  assert.equal(matchReply('takeover', 'confirm'), null);
  assert.equal(matchReply('takeover', 'yes'), null);
  assert.equal(matchReply('result', 'confirm'), null);
});

test('only an unambiguous 4xx counts as a rejection', () => {
  const rejected = (status, type) => new AgentsApiError({ status, type }).rejected;
  for (const status of [400, 401, 403, 404, 409, 422, 429]) assert.equal(rejected(status), true, `${status}`);
  // These can all follow a request that was processed.
  for (const status of [0, 408, 500, 502, 503, 504]) assert.equal(rejected(status), false, `${status}`);
  assert.equal(rejected(200, 'invalid_response'), false);
  assert.equal(rejected(409, 'invalid_response'), false);
});

test('code vault never serializes the code and releases it once', () => {
  const vault = new CodeVault();
  assert.equal(vault.stage('  FIXTURE-NOT-A-CODE '), null);
  assert.equal(JSON.stringify(vault), '{}');
  assert.equal(JSON.stringify({ vault }).includes('FIXTURE'), false);
  assert.equal(vault.maskedReference().includes('FIXTURE'), false);
  assert.equal(vault.maskedReference().endsWith('DE'), true);
  assert.equal(vault.containsStaged('my code is fixture-not-a-code ok'), true);

  assert.equal(vault.take(), 'FIXTURE-NOT-A-CODE');
  assert.equal(vault.take(), null);
  assert.equal(vault.hasStaged(), false);
});

test('code vault redacts a released code, including reformatted echoes', () => {
  const vault = new CodeVault();
  vault.stage('FIXTURE-NOT-A-CODE');
  vault.take();
  assert.equal(vault.redact('Typed FIXTURE-NOT-A-CODE into the field'), 'Typed [test code] into the field');
  assert.equal(vault.redact('typed fixture not a code'), 'typed [test code]');
  assert.equal(vault.redact('FIXTURENOTACODE'), '[test code]');
  assert.equal(vault.redact('nothing here'), 'nothing here');
});

test('code vault rejects unusable codes', () => {
  const vault = new CodeVault();
  assert.ok(vault.stage('abc'));
  assert.ok(vault.stage('has space'));
  assert.ok(vault.stage(undefined));
  assert.equal(vault.hasStaged(), false);
});

test('code release is locked unless explicitly enabled', () => {
  assert.equal(readConfig({}).codeReleaseEnabled, false);
  assert.equal(readConfig({ CODE_RELEASE: 'true' }).codeReleaseEnabled, false);
  assert.equal(readConfig({ CODE_RELEASE: 'enabled' }).codeReleaseEnabled, true);
});

test('config defaults to the hosted demo and can be switched to the live CAST flow', () => {
  const config = readConfig({});
  assert.equal(config.demoMode, true);
  assert.equal(config.castOrigin, 'https://aryanjhanambi.github.io');
  assert.deepEqual(config.allowedHosts, [
    'www.singtel.com', 'aryanjhanambi.github.io', 'cast.singtel.com', 'manus.im', 'hailuoai.video', 'otter.ai', 'www.minimax.io', 'akool.com',
  ]);
  assert.equal(config.apiKey, null);
  assert.equal(config.fixtureMode, false);
  assert.equal(config.testMode, false);
  assert.equal(config.browserHeadless, true);
  assert.equal(readConfig({ BROWSER_HEADLESS: 'false' }).browserHeadless, false);
  assert.equal(readConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:9/v1' }).fixtureMode, true);
  assert.equal(readConfig({ MAYA_TEST_MODE: '1' }).fixtureMode, true, 'test mode is always labelled');
  assert.equal(readConfig({ MAYA_DEMO_MODE: 'false' }).demoMode, false);
  assert.equal(readConfig({ MAYA_DEMO_MODE: 'false' }).castOrigin, 'https://cast.singtel.com');
  assert.equal(normalizeOrigin('https://cast.singtel.com/order/login'), 'https://cast.singtel.com');
});

test('session request has no environment, carries initial input, and offers only bounded function tools', () => {
  const body = buildSessionRequest(readConfig({}), 'Can you help me?');
  assert.deepEqual(body.environment, { type: 'none' });
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'Can you help me?' }] }]);
  assert.deepEqual(
    body.agent.tools.map((tool) => [tool.type, tool.name]),
    [
      ['function', 'browser_observe'],
      ['function', 'browser_navigate'],
      ['function', 'browser_click'],
      ['function', 'browser_scroll'],
      ['function', 'browser_switch_tab'],
      ['function', 'request_customer_login'],
      ['function', 'request_redemption_submission'],
      ['function', 'report_redemption_result'],
    ],
  );
  // No tool can type, read field contents, or run script.
  const names = body.agent.tools.map((tool) => tool.name).join(' ');
  assert.doesNotMatch(names, /type|fill|evaluate|script|key/);
  for (const tool of body.agent.tools) assert.equal(tool.parameters.additionalProperties, false);
});

test('event summaries never copy arguments or message text', () => {
  const functionCall = summarizeApiEvent({
    type: 'agent.session.turn.item.done',
    item: { type: 'function_call', name: 'request_redemption_submission', status: 'completed', arguments: { secret: 'ARG-VALUE' } },
  });
  assert.equal(functionCall.includes('ARG-VALUE'), false);
  assert.match(functionCall, /request_redemption_submission/);

  const text = summarizeApiEvent({ type: 'agent.session.turn.output_text.done', text: 'private words' });
  assert.equal(text.includes('private'), false);
});
