// Visual and interaction check: drives the UI harness in Chrome at 1920x1080
// and 1440x900, including clicking and typing through the live browser view,
// and saves screenshots to ui-check-output/. Local fixture data only.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { readConfig, ROOT } from '../server/config.js';
import { createApp } from '../server/http.js';
import { MemoryJournal } from '../server/store.js';
import { startHarness } from './ui-fixture.js';

const out = path.join(ROOT, 'ui-check-output');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

async function open(url) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    // Network failures are checked through responses below; the probes cause some on purpose.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      failures.push(`console error: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`HTTP ${response.status()} for ${new URL(response.url()).pathname}`);
  });
  await page.goto(url);
  return page;
}

const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });

/** The same state again at a 1440-wide laptop viewport. */
async function laptopShot(page, name) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${name}: the page overflows horizontally at 1440 wide`,
  );
  check(
    await page.evaluate(() => {
      const live = document.getElementById('live').getBoundingClientRect();
      const viewer = document.getElementById('viewer').getBoundingClientRect();
      return live.width <= viewer.width + 1 && live.height <= viewer.height + 1;
    }),
    `${name}: the live view is cropped by its panel`,
  );
  await shot(page, `${name}-1440`);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(300);
}

async function say(page, text) {
  await page.locator('#message').fill(text);
  await page.locator('#message').press('Enter');
}

const pendingCard = (page, card) => page.locator(`.card[data-card="${card}"][data-status="pending"]`);

async function checkInView(page, card) {
  const visible = await pendingCard(page, card).evaluate((node) => {
    const box = node.getBoundingClientRect();
    const area = document.getElementById('timeline').getBoundingClientRect();
    return box.bottom <= area.bottom + 1 && box.bottom > area.top;
  });
  check(visible, `the pending ${card} card is not fully in view`);
}

/** The Chromium page the app is running, for comparing against what the UI shows and sends. */
const innerPage = (harness) => [...harness.runs.values()].at(-1).browser.pageForTests();
const counterText = (harness) => innerPage(harness).locator('#counter').textContent();

/** Where a point of the inner page appears on the outer page's live canvas. */
async function onCanvas(page, harness, selector) {
  const target = await innerPage(harness).locator(selector).boundingBox();
  const box = await page.locator('#live').boundingBox();
  const scale = Math.min(box.width / 1280, box.height / 800);
  return {
    x: box.x + (box.width - 1280 * scale) / 2 + (target.x + target.width / 2) * scale,
    y: box.y + (box.height - 800 * scale) / 2 + (target.y + target.height / 2) * scale,
  };
}

async function toTakeover(page) {
  let runsCreated = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') runsCreated += 1;
  });
  // A fast double Enter must create one run and send one message.
  await page.locator('#message').fill('Can you help me redeem my Singtel AI Pass on CAST?');
  await page.locator('#message').press('Enter');
  await page.locator('#message').press('Enter');
  await pendingCard(page, 'takeover').waitFor();
  check(runsCreated === 1, `expected one POST /api/runs, saw ${runsCreated}`);
  check((await page.locator('.bubble-customer').count()) === 1, 'a double Enter sent the message twice');
  await checkInView(page, 'takeover');
}

/** The live view shows real frames: not hidden, and not a blank canvas. */
async function checkLiveFrames(page) {
  await page.locator('#live').waitFor();
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('live');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, 120).data;
    const colors = new Set();
    for (let index = 0; index < data.length; index += 4 * 97) colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    return colors.size > 2;
  });
  check(painted, 'the live view canvas is blank');
}

async function probeAppConnection(page, harness) {
  // With the app stream down, the UI says so and holds back every action.
  const { server } = harness;
  const port = server.address().port;
  server.close();
  server.closeAllConnections();
  await page.getByText('App connection lost').waitFor();
  check((await page.locator('#status-value').textContent()) === 'Reconnecting to the app', 'the stale status stayed on screen while disconnected');
  check(await page.locator('#message').isDisabled(), 'the message box stayed enabled while disconnected');
  check(await page.locator('#take-control').isDisabled(), 'Take control stayed enabled while disconnected');
  check(await page.locator('#timeline').evaluate((node) => node.inert), 'cards stayed interactive while disconnected');
  await shot(page, '03b-app-connection-lost');
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  await page.getByText('App connection lost').waitFor({ state: 'hidden', timeout: 20_000 });
  check((await pendingCard(page, 'takeover').count()) === 1, 'the pending card was not kept across the reconnect');
}

/** Only the live-view stream drops: the picture is stale, so input must stop until it is current again. */
async function probeLiveViewStream(page, harness, counter) {
  const before = await counterText(harness);
  const held = () => [...harness.runs.values()].at(-1).browser.heldForTests();

  // A key is held and its request is still in flight when the stream drops.
  await page.route('**/browser/input', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.locator('#live').focus();
  await page.keyboard.down('Shift');
  await page.route('**/browser/stream', (route) => route.abort());
  for (const response of harness.browserStreams) response.destroy();
  await page.getByText('Live view reconnecting').waitFor();
  await page.waitForTimeout(1800);
  check(held().keys === 0 && held().buttons === 0, 'a key held when the live view dropped was left held in the page');
  await page.unroute('**/browser/input');
  await page.keyboard.up('Shift');

  check((await page.locator('#viewer').getAttribute('data-stale')) === 'true', 'the stale live view was not marked');
  check(await page.locator('#connection').isHidden(), 'the app connection was reported lost when only the live view dropped');
  await page.mouse.click(counter.x, counter.y);
  await page.keyboard.type('x');
  await page.waitForTimeout(400);
  check((await counterText(harness)) === before, 'input was forwarded while the live view was stale');
  await shot(page, '04b-live-view-reconnecting');

  await page.unroute('**/browser/stream');
  await page.getByText('You are controlling the browser', { exact: true }).waitFor({ timeout: 20_000 });
  check((await page.locator('#viewer').getAttribute('data-stale')) === 'false', 'the live view stayed marked stale after reconnecting');
  await page.mouse.click(counter.x, counter.y);
  await page.waitForTimeout(500);
  check((await counterText(harness)) !== before, 'input did not resume once the live view was current again');
}

/** Takes control in the UI and uses the live view like a browser. */
async function takeover(page, harness) {
  // A failed send keeps the draft and shows why.
  await page.route('**/messages', (route) => route.abort());
  await say(page, 'cancel');
  await page.locator('#composer-error').waitFor();
  check((await page.locator('#message').inputValue()) === 'cancel', 'the draft was lost after a failed send');
  await page.unroute('**/messages');
  await page.locator('#message').fill('');

  // Before taking control, the live view ignores the presenter.
  const counter = await onCanvas(page, harness, '#counter');
  await page.mouse.click(counter.x, counter.y);
  await page.waitForTimeout(300);
  check((await counterText(harness)) === 'Count: 0', 'a click reached the page without control');

  await page.locator('#take-control').click();
  await page.getByText('You are controlling the browser', { exact: true }).waitFor();
  check(await page.locator('#message').isDisabled(), 'chat stayed enabled while the presenter controls the browser');

  await page.mouse.click(counter.x, counter.y);
  await page.waitForTimeout(500);
  check((await counterText(harness)) === 'Count: 1', 'a click on the live view did not reach the page at the mapped position');

  // A button released outside the live view is still released in the page.
  await page.mouse.move(counter.x, counter.y);
  await page.mouse.down();
  await page.mouse.move(20, 20);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.mouse.move(counter.x, counter.y + 60);
  await page.mouse.click(counter.x, counter.y);
  await page.waitForTimeout(500);
  check((await counterText(harness)) === 'Count: 2', 'a drag released outside the live view left the button held');

  const field = await onCanvas(page, harness, '#field-a');
  await page.mouse.click(field.x, field.y);
  await page.keyboard.type('Dev user 42', { delay: 15 });
  await page.waitForTimeout(500);
  check((await innerPage(harness).locator('#field-a').inputValue()) === 'Dev user 42', 'typing in the live view did not reach the field');

  await page.mouse.move(field.x, field.y + 120);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(500);
  check((await innerPage(harness).evaluate(() => window.scrollY)) > 200, 'scrolling the live view did not scroll the page');
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(400);
  await shot(page, '04-presenter-in-control');
  await laptopShot(page, '04-presenter-in-control');

  await probeLiveViewStream(page, harness, await onCanvas(page, harness, '#counter'));

  await page.locator('#return-control').click();
  await page.getByText('Maya is controlling the browser').waitFor();
  check(!(await page.content()).includes('Dev user 42'), 'what the presenter typed appears in the app’s own page');
}

// 1. Setup state: the real app with no key. It must not start a browser.
const bare = createApp({ config: readConfig({ MAYA_DATA_DIR: '/nonexistent-unused' }), api: null, journal: new MemoryJournal() });
await new Promise((resolve) => bare.server.listen(0, '127.0.0.1', resolve));
let page = await open(`http://127.0.0.1:${bare.server.address().port}`);
await page.getByText('Setup needed').first().waitFor();
await shot(page, '01-setup-no-key');
await bare.close();

// 2. Full sequence with code release armed.
let harness = await startHarness({ port: 0, delay: 250 });
page = await open(harness.url);
await page.getByText('Ask Maya to start').waitFor();
await shot(page, '02-idle');
await toTakeover(page);
await checkLiveFrames(page);
await shot(page, '03-sign-in-request');
await laptopShot(page, '03-sign-in-request');
await probeAppConnection(page, harness);
await takeover(page, harness);

await pendingCard(page, 'release').waitFor();
await pendingCard(page, 'release').locator('input[type="password"]').fill('FIXTURE-CONFIRM');
await pendingCard(page, 'release').getByRole('button', { name: 'Add code' }).click();
await pendingCard(page, 'release').getByText('held in this app').waitFor();
await checkInView(page, 'release');
await shot(page, '06-authorization');
await laptopShot(page, '06-authorization');
await say(page, 'confirm');
await page.locator('.card[data-card="result"][data-outcome="confirmed"]').waitFor();
await page.getByText('The page confirms the redemption').waitFor();
await page.waitForTimeout(500);
check((await innerPage(harness).locator('#submissions').textContent()) === 'Submissions: 1', 'the form was not submitted exactly once');
check(
  await page.locator('.bubble-maya').last().evaluate((node) => node.getBoundingClientRect().bottom <= document.getElementById('timeline').getBoundingClientRect().bottom + 1),
  'the latest message is not in view after the result',
);
await shot(page, '07-confirmed');
await laptopShot(page, '07-confirmed');
await page.locator('#drawer-toggle').click();
await shot(page, '08-events-drawer');
await laptopShot(page, '08-events-drawer');
check(!(await page.content()).includes('FIXTURE-CONFIRM'), 'the submitted fixture code appears in the app’s own page');
check(
  !JSON.stringify(harness.fixture.state.requests.map((request) => request.body)).includes('FIXTURE-CONFIRM'),
  'the code was sent to the Agents API stand-in',
);
await harness.close();

// 3. Rehearsal: code release locked.
harness = await startHarness({ port: 0, delay: 250, env: { CODE_RELEASE: 'locked' } });
page = await open(harness.url);
await toTakeover(page);
await page.locator('#take-control').click();
await page.getByText('You are controlling the browser', { exact: true }).waitFor();
await page.locator('#return-control').click();
await pendingCard(page, 'release').waitFor();
await shot(page, '09-rehearsal-locked');

// 4. An earlier session from the hosted-browser version: shown, not attached, not deleted.
const [cookie] = await page.context().cookies();
await page.locator('#end').click();
await page.getByText('Session ended').first().waitFor();
const requestsBefore = harness.fixture.state.requests.length;
harness.journal.save({
  id: 'legacy-run',
  ownerHash: createHash('sha256').update(cookie.value).digest('hex'),
  sessionId: 'sess_from_hosted_version',
  createdAt: Date.now() - 3_600_000,
  endedAt: null,
  releases: [{ status: 'released', outcome: 'unknown' }],
});
await page.reload();
await page.getByText('An earlier session is still open').waitFor();
check(await page.locator('#message').isDisabled(), 'a new run could start before the earlier session was resolved');
await shot(page, '10-earlier-session');
await page.getByRole('button', { name: 'Keep it and dismiss' }).click();
await page.getByText('Ask Maya to start').waitFor();
check(harness.fixture.state.requests.length === requestsBefore, 'the earlier session was contacted or deleted without being asked');
await harness.close();

await browser.close();
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Screenshots written to ${out}`);
