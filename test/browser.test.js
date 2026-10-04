import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserSession } from '../server/browser.js';
import { agentMayUse, readConfig } from '../server/config.js';
import { startDevSite } from './fixtures/dev-site.js';
import { settle, waitFor } from './helpers.js';

/** Real Chromium on the local dev test page. */
async function start(t) {
  const site = await startDevSite();
  const config = readConfig({
    MAYA_TEST_MODE: '1',
    START_URL: site.home,
    EXPECTED_REDEEM_URL: site.form,
    MAYA_ACTION_TIMEOUT_MS: '1500',
    MAYA_DATA_DIR: '/nonexistent-unused',
  });
  const browser = new BrowserSession({ config });
  const frames = [];
  browser.on('frame', (frame) => frames.push(frame));
  await browser.start();
  t.after(async () => {
    await browser.close();
    await site.close();
  });
  const page = () => browser.pageForTests();
  const center = async (selector) => {
    const box = await page().locator(selector).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const refOf = (observation, name) => observation.elements.find((element) => element.name === name)?.ref;
  return { site, config, browser, frames, page, center, refOf };
}

const pending = (promise) => Promise.race([promise.then(() => false, () => false), settle(150).then(() => true)]);

test('the address policy allows only secure pages on listed hosts', () => {
  const config = readConfig({});
  assert.equal(agentMayUse('https://cast.singtel.com/order/login', config), true);
  assert.equal(agentMayUse('https://www.singtel.com/personal', config), true);
  assert.equal(agentMayUse('http://cast.singtel.com/order/login', config), false);
  assert.equal(agentMayUse('https://cast.singtel.com.evil.example/', config), false);
  assert.equal(agentMayUse('https://example.com/', config), false);
  assert.equal(agentMayUse('javascript:alert(1)', config), false);
  assert.equal(agentMayUse('not a url', config), false);
  const extra = readConfig({ ALLOWED_HOSTS: 'login.example.net' });
  assert.equal(agentMayUse('https://login.example.net/', extra), true);
});

test('the live view streams frames on its own as the page changes', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  await waitFor(() => c.frames.length > 0, { label: 'first frame' });
  const first = c.frames.at(-1);
  assert.deepEqual([...first.data.subarray(0, 2)], [0xff, 0xd8], 'frames are JPEG');
  assert.equal(c.browser.latestFrame.seq, first.seq);

  // The page changes by itself: no tool call, no observation.
  await c.page().evaluate(() => document.getElementById('counter').click());
  await waitFor(() => c.frames.at(-1).seq > first.seq, { label: 'frame after a page change' });
});

test('presenter input reaches the page: click, keys, inserted text, and scrolling', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  await c.browser.takeControl();
  assert.equal(c.browser.state().controller, 'human');

  const button = await c.center('#counter');
  await c.browser.humanInput([
    { t: 'move', ...button },
    { t: 'down', ...button, button: 'left' },
    { t: 'up', ...button, button: 'left' },
  ]);
  assert.equal(await c.page().locator('#counter').textContent(), 'Count: 1');

  const field = await c.center('#field-a');
  await c.browser.humanInput([
    { t: 'down', ...field, button: 'left' },
    { t: 'up', ...field, button: 'left' },
    { t: 'key', a: 'down', key: 'a' },
    { t: 'key', a: 'up', key: 'a' },
    { t: 'key', a: 'down', key: 'B' },
    { t: 'key', a: 'up', key: 'B' },
    { t: 'key', a: 'down', key: '7' },
    { t: 'key', a: 'up', key: '7' },
    { t: 'text', text: 'é漢' },
  ]);
  assert.equal(await c.page().locator('#field-a').inputValue(), 'aB7é漢');
  await c.browser.humanInput([{ t: 'key', a: 'down', key: 'Backspace' }, { t: 'key', a: 'up', key: 'Backspace' }]);
  assert.equal(await c.page().locator('#field-a').inputValue(), 'aB7é');

  await c.browser.humanInput([{ t: 'wheel', x: 640, y: 400, dx: 0, dy: 700 }]);
  await waitFor(() => c.page().evaluate(() => window.scrollY > 300), { label: 'scroll' });

  // Out-of-range and unknown input is clamped or ignored, not an error.
  await c.browser.humanInput([
    { t: 'move', x: 99999, y: -50 },
    { t: 'down', x: 1, y: 1, button: 'fourth' },
    { t: 'key', a: 'down', key: 'F13' },
    { t: 'unknown' },
  ]);
  await assert.rejects(() => c.browser.humanInput(new Array(65).fill({ t: 'move', x: 1, y: 1 })), { code: 'invalid_input' });
});

test('control is exclusive: Maya waits for the presenter, and the presenter for Maya', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);

  await assert.rejects(() => c.browser.humanInput([{ t: 'move', x: 1, y: 1 }]), { code: 'not_in_control' });

  // Take control waits for the action Maya has in flight.
  let navigated = false;
  const slow = c.browser.navigate(`${c.site.origin}/slow`).then(() => {
    navigated = true;
  });
  await settle(50);
  await c.browser.takeControl();
  assert.equal(navigated, true, 'the action in flight finished before the presenter got control');
  await slow;

  // Maya's tools and the app's own page operations do not run during takeover.
  const observation = c.browser.observe();
  assert.equal(await pending(observation), true, 'observe waits while the presenter has control');
  await assert.rejects(() => c.browser.screenshot(), { code: 'not_in_control' });
  await assert.rejects(
    () => c.browser.submitCode({ fieldRef: 's1e1', buttonRef: 's1e2', code: 'FIXTURE-NOT-A-CODE', expectedAddress: c.browser.address() }),
    { code: 'not_submitted' },
  );

  await c.browser.returnControl();
  assert.equal((await observation).title, 'Dev test page');
  await assert.rejects(() => c.browser.humanInput([{ t: 'move', x: 1, y: 1 }]), { code: 'not_in_control' });
});

test('buttons and keys the presenter holds are let go on request and when control returns', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  await c.browser.takeControl();
  const button = await c.center('#counter');

  await c.browser.humanInput([
    { t: 'down', ...button, button: 'left' },
    { t: 'down', ...button, button: 'left' },
    { t: 'key', a: 'down', key: 'Shift' },
    { t: 'key', a: 'down', key: 'a' },
  ]);
  assert.deepEqual(c.browser.heldForTests(), { buttons: 1, keys: 2 });
  // The live view lost focus or its stream: everything is released, nothing clicks.
  await c.browser.humanInput([{ t: 'release' }]);
  assert.deepEqual(c.browser.heldForTests(), { buttons: 0, keys: 0 });
  await c.browser.humanInput([{ t: 'up', ...button, button: 'left' }]);
  assert.deepEqual(c.browser.heldForTests(), { buttons: 0, keys: 0 }, 'a stray release is ignored');

  await c.browser.humanInput([{ t: 'down', ...button, button: 'left' }, { t: 'key', a: 'down', key: 'Shift' }]);
  await c.browser.returnControl();
  assert.deepEqual(c.browser.heldForTests(), { buttons: 0, keys: 0 }, 'nothing stays held for Maya');

  // With Shift released, a lowercase key types lowercase.
  await c.browser.takeControl();
  const field = await c.center('#field-a');
  await c.browser.humanInput([
    { t: 'down', ...field, button: 'left' },
    { t: 'up', ...field, button: 'left' },
    { t: 'key', a: 'down', key: 'q' },
    { t: 'key', a: 'up', key: 'q' },
  ]);
  assert.match(await c.page().locator('#field-a').inputValue(), /q$/);
});

test('returning control drains presenter input so none arrives after Maya resumes', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  await c.browser.takeControl();
  const field = await c.center('#field-a');
  await c.browser.humanInput([{ t: 'down', ...field, button: 'left' }, { t: 'up', ...field, button: 'left' }]);

  const keys = [];
  for (let index = 0; index < 60; index += 1) keys.push({ t: 'key', a: 'down', key: 'x' }, { t: 'key', a: 'up', key: 'x' });
  const typing = [c.browser.humanInput(keys.slice(0, 60)), c.browser.humanInput(keys.slice(60))];
  await c.browser.returnControl();
  await Promise.allSettled(typing);

  const atReturn = await c.page().locator('#field-a').inputValue();
  await settle(250);
  assert.equal(await c.page().locator('#field-a').inputValue(), atReturn, 'no late keystrokes');
  assert.equal(c.browser.state().controller, 'maya');
});

test('an observation never contains what is typed into fields', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  await c.page().fill('#field-a', 'VISIBLE-VALUE-123');
  await c.page().fill('#secret', 'TOP-SECRET-456');

  const observation = await c.browser.observe();
  const serialized = JSON.stringify(observation);
  assert.equal(serialized.includes('VISIBLE-VALUE-123'), false);
  assert.equal(serialized.includes('TOP-SECRET-456'), false);
  assert.match(observation.text, /DEV TEST PAGE/);
  const fieldA = observation.elements.find((element) => element.name === 'Field A');
  assert.equal(fieldA.has_text, true);
  assert.equal(fieldA.kind, 'input text');
});

test('element references are validated: unknown, stale, and reused ones are refused', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  await assert.rejects(() => c.browser.click('s0e1'), { code: 'stale_reference' });
  await assert.rejects(() => c.browser.click({ selector: '#counter' }), { code: 'stale_reference' });

  const first = await c.browser.observe();
  const stale = c.refOf(first, 'Count: 0');
  const second = await c.browser.observe();
  await assert.rejects(() => c.browser.click(stale), { code: 'stale_reference' }, 'a reference from an older observation');

  const ref = c.refOf(second, 'Count: 0');
  assert.equal((await c.browser.click(ref)).clicked, 'Count: 0');
  assert.equal(await c.page().locator('#counter').textContent(), 'Count: 1');
  await assert.rejects(() => c.browser.click(ref), { code: 'stale_reference' }, 'a reference is single use');

  // A takeover also invalidates what Maya last saw.
  const third = await c.browser.observe();
  await c.browser.takeControl();
  await c.browser.returnControl();
  await assert.rejects(() => c.browser.click(c.refOf(third, 'Count: 1')), { code: 'stale_reference' });
});

test('Maya cannot open, read, or act on a website outside the allow-list', async (t) => {
  const c = await start(t);
  for (const address of ['https://example.com/', 'http://example.com/', 'file:///etc/hosts', 'javascript:alert(1)', 'about:blank#x']) {
    await assert.rejects(() => c.browser.navigate(address), { code: 'address_not_allowed' });
  }
  // The presenter, or a redirect, can still land elsewhere. Maya is then blind there.
  await c.page().goto('data:text/html,<title>Elsewhere</title><button>Outside</button>');
  await assert.rejects(() => c.browser.observe(), { code: 'outside_allowed_websites' });
  await assert.rejects(() => c.browser.scroll('down'), { code: 'outside_allowed_websites' });
});

test('a new tab becomes the active tab and tabs can be switched', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  const observation = await c.browser.observe();
  const result = await c.browser.click(c.refOf(observation, 'Open the dev test form in a new tab'));
  await waitFor(() => c.browser.state().tabs.length === 2, { label: 'second tab' });
  await waitFor(() => c.browser.address() === c.site.form, { label: 'new tab active' });
  assert.ok(result.tabs.length >= 1);
  assert.equal((await c.browser.observe()).title, 'Dev test form');

  const seq = c.frames.at(-1)?.seq ?? 0;
  const home = c.browser.state().tabs.find((tab) => tab.address === c.site.home);
  await c.browser.switchTab(home.id);
  assert.equal(c.browser.address(), c.site.home);
  await waitFor(() => (c.frames.at(-1)?.seq ?? 0) > seq, { label: 'frames from the newly active tab' });
  await assert.rejects(() => c.browser.switchTab('t99'), { code: 'unknown_tab' });

  // Closing the active tab falls back to a remaining one.
  await c.page().close();
  await waitFor(() => c.browser.state().tabs.length === 1 && c.browser.address() === c.site.form, { label: 'fallback tab' });
});

test('the app enters a code and clicks once; the checks before it fail safe', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.form);
  let observation = await c.browser.observe();
  let fieldRef = c.refOf(observation, 'Test code');
  let buttonRef = c.refOf(observation, 'Submit test code');
  assert.deepEqual(await c.browser.describeSubmission(fieldRef, buttonRef), {
    address: c.site.form,
    fieldLabel: 'Test code',
    buttonLabel: 'Submit test code',
  });
  await assert.rejects(() => c.browser.describeSubmission(buttonRef, fieldRef), { code: 'not_a_code_field' });
  await assert.rejects(() => c.browser.describeSubmission(fieldRef, fieldRef), { code: 'not_a_button' });

  // A page that changed since the request: nothing is typed.
  await assert.rejects(
    () => c.browser.submitCode({ fieldRef, buttonRef, code: 'FIXTURE-CONFIRM', expectedAddress: c.site.home }),
    { code: 'not_submitted' },
  );
  assert.equal(await c.page().locator('#code').inputValue(), '');

  // A field that stopped accepting input: nothing is clicked and the field is left empty.
  await c.page().evaluate(() => document.getElementById('code').setAttribute('readonly', ''));
  await assert.rejects(
    () => c.browser.submitCode({ fieldRef, buttonRef, code: 'FIXTURE-CONFIRM', expectedAddress: c.site.form }),
    { code: 'not_submitted' },
  );
  assert.equal(await c.page().locator('#submissions').textContent(), 'Submissions: 0');
  await c.page().evaluate(() => document.getElementById('code').removeAttribute('readonly'));

  await c.browser.submitCode({ fieldRef, buttonRef, code: 'FIXTURE-CONFIRM', expectedAddress: c.site.form });
  assert.equal(await c.page().locator('#result').textContent(), 'DEV RESULT: accepted');
  assert.equal(await c.page().locator('#submissions').textContent(), 'Submissions: 1');

  // References are spent: the same call cannot click a second time.
  await assert.rejects(
    () => c.browser.submitCode({ fieldRef, buttonRef, code: 'FIXTURE-CONFIRM', expectedAddress: c.site.form }),
    { code: 'not_submitted' },
  );
  assert.equal(await c.page().locator('#submissions').textContent(), 'Submissions: 1');

  observation = await c.browser.observe();
  fieldRef = c.refOf(observation, 'Test code');
  buttonRef = c.refOf(observation, 'Submit test code');
  await assert.rejects(() => c.browser.describeSubmission(fieldRef, buttonRef), { code: 'field_not_empty' });
});

test('a click that does not complete cleanly is reported as uncertain, not as a failure', async (t) => {
  const c = await start(t);
  const address = `${c.site.form}?cover=1`;
  await c.browser.navigate(address);
  const observation = await c.browser.observe();
  await assert.rejects(
    () =>
      c.browser.submitCode({
        fieldRef: c.refOf(observation, 'Test code'),
        buttonRef: c.refOf(observation, 'Submit test code'),
        code: 'FIXTURE-CONFIRM',
        expectedAddress: address,
      }),
    { code: 'submission_uncertain' },
  );
});

test('closing ends the browser, the stream, and every action', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  await waitFor(() => c.frames.length > 0, { label: 'frame' });
  await c.browser.takeControl();
  const queued = c.browser.observe();

  await c.browser.close();
  assert.equal(c.browser.state().closed, true);
  assert.equal(c.browser.latestFrame, null);
  await assert.rejects(queued, (error) => ['cancelled', 'browser_closed'].includes(error.code));
  await assert.rejects(() => c.browser.observe(), { code: 'browser_closed' });
  await assert.rejects(() => c.browser.humanInput([{ t: 'move', x: 1, y: 1 }]), { code: 'browser_closed' });

  const count = c.frames.length;
  await settle(200);
  assert.equal(c.frames.length, count, 'no frames after close');
});

test('a browser that dies is reported as lost and nothing pretends otherwise', async (t) => {
  const c = await start(t);
  await c.browser.navigate(c.site.home);
  let lost = null;
  c.browser.on('lost', (reason) => {
    lost = reason;
  });
  await c.browser.takeControl();
  const queued = c.browser.observe();

  await c.page().context().browser().close();
  await waitFor(() => lost !== null, { label: 'loss detected' });
  assert.ok(c.browser.state().lost);
  await assert.rejects(queued, (error) => ['cancelled', 'browser_lost'].includes(error.code));
  await assert.rejects(() => c.browser.observe(), { code: 'browser_lost' });
  await assert.rejects(() => c.browser.navigate(c.site.home), { code: 'browser_lost' });
  await assert.rejects(() => c.browser.humanInput([{ t: 'move', x: 1, y: 1 }]), { code: 'browser_lost' });
  await assert.rejects(() => c.browser.takeControl(), { code: 'browser_lost' });
});
