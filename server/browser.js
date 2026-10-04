import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { agentMayUse } from './config.js';

/**
 * The Chromium browser this app runs for one demo session.
 *
 * It is driven two ways, never at once: by Maya, through the bounded actions
 * below, or by the presenter, through input forwarded from the live view.
 * The live view is a CDP screencast of the active tab and runs independently
 * of any model turn. Nothing here is written to disk or logged.
 */

export const VIEWPORT = { width: 1280, height: 800 };
const MAX_TABS = 4;
const MAX_ELEMENTS = 120;
const MAX_TEXT = 3000;
const SETTLE_MS = 350;

const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Control', 'Alt', 'Meta',
]);
const BUTTONS = new Set(['left', 'middle', 'right']);

/** A failure Maya or the presenter can be told about. Never carries page input. */
export class BrowserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}

// ---- Functions evaluated in the page. Fixed, app-authored code only. --------

function pageCollect(max) {
  const selector =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"]';
  const found = [];
  for (const element of document.querySelectorAll(selector)) {
    if (found.length >= max) break;
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    found.push(element);
  }
  return found;
}

// Accepts one element or a list, so it can be evaluated on either kind of handle.
function pageDescribe(input) {
  const elements = Array.isArray(input) ? input : [input];
  const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const textLike = (element) =>
    element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' &&
      !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(element.type));
  return elements.map((element) => {
    const tag = element.tagName.toLowerCase();
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const buttonLike = tag === 'input' && ['button', 'submit', 'reset'].includes(element.type);
    // A field is named by its label, never by what has been typed into it.
    const name =
      element.getAttribute('aria-label') ||
      (element.labels && element.labels[0] && element.labels[0].innerText) ||
      (buttonLike ? element.value : '') ||
      (isField
        ? element.getAttribute('placeholder') || element.getAttribute('name') || ''
        : element.innerText || element.getAttribute('title') || element.querySelector('img[alt]')?.alt || '');
    const box = element.getBoundingClientRect();
    return {
      tag,
      role: element.getAttribute('role') || '',
      type: tag === 'input' ? element.type : '',
      name: clean(name, 80),
      link: tag === 'a' ? clean(element.href, 200) : '',
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      checked: element.type === 'checkbox' || element.type === 'radio' ? Boolean(element.checked) : null,
      textField: textLike(element),
      filled: textLike(element) ? element.value.length > 0 : null,
      editable: textLike(element) ? !element.readOnly && !element.disabled : null,
      inView: box.bottom > 0 && box.top < innerHeight,
    };
  });
}

function pageText(max) {
  const text = document.body ? document.body.innerText : '';
  return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, max);
}

// ---------------------------------------------------------------------------

export class BrowserSession extends EventEmitter {
  #config;
  #browser = null;
  #context = null;
  #tabs = new Map();
  #tabSequence = 0;
  #active = null;
  #cdp = null;
  #refs = new Map();
  #snapshot = 0;
  #frameSequence = 0;
  #queue = Promise.resolve();
  #inFlight = null;
  #generation = 0;
  #gate = null;
  #openGate = null;
  #closing = false;
  // Counts takeovers, so work queued before one can tell it happened.
  #controlEpoch = 0;
  #humanQueue = Promise.resolve();
  // What the presenter is currently holding down, so it can always be let go.
  #heldButtons = new Set();
  #heldKeys = new Set();
  // Tab activations run one at a time; actions wait for the one in progress.
  #activation = Promise.resolve();

  controller = 'maya';
  humanReady = false;
  lost = null;
  closed = false;
  latestFrame = null;

  constructor({ config }) {
    super();
    this.#config = config;
  }

  async start() {
    this.#browser = await chromium.launch({
      headless: this.#config.browserHeadless,
      channel: this.#config.browserChannel,
    });
    this.#browser.on('disconnected', () => {
      if (!this.#closing) this.#lose('The browser process ended unexpectedly.');
    });
    // A private context: nothing persists after it closes.
    this.#context = await this.#browser.newContext({ viewport: VIEWPORT, acceptDownloads: false });
    this.#context.on('page', (page) => void this.#adopt(page));
    await this.#context.newPage();
    await this.#waitFor(() => this.#active !== null);
    await this.#activation;
    this.#assertUsable();
  }

  async #waitFor(check, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new BrowserError('browser_timeout', 'The browser did not become ready.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // ---- Tabs and the live view ----------------------------------------------

  async #adopt(page) {
    if (this.#closing) return;
    if (this.#tabs.size >= MAX_TABS) {
      this.emit('note', 'A page tried to open another tab. It was closed because four tabs are already open.');
      await page.close().catch(() => {});
      return;
    }
    const id = `t${(this.#tabSequence += 1)}`;
    this.#tabs.set(id, page);
    page.on('close', () => void this.#onTabClosed(id, page));
    page.on('crash', () => this.#lose('The browser page crashed.'));
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (page === this.#active) this.#refs.clear();
      this.#emitState();
    });
    page.on('domcontentloaded', () => this.#emitState());
    await this.#activate(page);
  }

  async #onTabClosed(id, page) {
    this.#tabs.delete(id);
    if (this.#closing || this.lost) return;
    if (page !== this.#active) return this.#emitState();
    const remaining = [...this.#tabs.values()].at(-1);
    if (remaining) await this.#activate(remaining);
    else await this.#context.newPage().catch(() => this.#lose('The last browser tab closed.'));
  }

  #activate(page) {
    const run = this.#activation.then(() => this.#activateNow(page));
    this.#activation = run.catch(() => {});
    return run;
  }

  async #activateNow(page) {
    if (this.#closing || page.isClosed()) return;
    this.#refs.clear();
    const previous = this.#cdp;
    this.#cdp = null;
    await previous?.send('Page.stopScreencast').catch(() => {});
    await previous?.detach().catch(() => {});
    this.#active = page;
    try {
      await page.bringToFront();
      const cdp = await this.#context.newCDPSession(page);
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (this.#cdp !== cdp) return;
        this.latestFrame = { data: Buffer.from(data, 'base64'), seq: (this.#frameSequence += 1), at: Date.now() };
        this.emit('frame', this.latestFrame);
      });
      this.#cdp = cdp;
      await this.#startScreencast(cdp);
    } catch {
      if (!this.#closing && !page.isClosed()) this.#lose('The live view of the browser could not be started.');
    }
    this.#emitState();
  }

  /**
   * Chromium refuses to start a screencast while a tab is between pages, so
   * the request is repeated briefly before it counts as a failure.
   */
  async #startScreencast(cdp) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 70,
          maxWidth: VIEWPORT.width,
          maxHeight: VIEWPORT.height,
          everyNthFrame: 1,
        });
      } catch (error) {
        if (attempt >= 9 || this.#closing || this.#cdp !== cdp) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  address() {
    return this.#active && !this.#active.isClosed() ? this.#active.url() : '';
  }

  /** Non-sensitive browser state for the UI: addresses, tabs, and who has control. */
  state() {
    return {
      controller: this.controller,
      humanReady: this.humanReady,
      lost: this.lost,
      closed: this.closed,
      address: this.address(),
      tabs: [...this.#tabs].map(([id, page]) => ({ id, address: page.url(), active: page === this.#active })),
      viewport: VIEWPORT,
    };
  }

  #emitState() {
    if (!this.closed) this.emit('state', this.state());
  }

  #lose(reason) {
    if (this.lost || this.#closing) return;
    this.lost = reason;
    this.humanReady = false;
    this.#refs.clear();
    this.cancelQueued();
    this.#releaseGate();
    this.emit('lost', reason);
    this.#emitState();
  }

  #releaseGate() {
    const open = this.#openGate;
    this.#gate = null;
    this.#openGate = null;
    open?.();
  }

  #assertUsable() {
    if (this.closed) throw new BrowserError('browser_closed', 'The browser has been closed.');
    if (this.lost) throw new BrowserError('browser_lost', 'The browser is no longer available.');
  }

  // ---- Control arbitration -----------------------------------------------------

  /**
   * Runs one of Maya's actions. Actions run one at a time, in order, and wait
   * for as long as the presenter has control.
   */
  #agent(action) {
    const generation = this.#generation;
    const run = this.#queue.then(async () => {
      await this.#activation;
      while (this.#gate) await this.#gate;
      if (generation !== this.#generation) throw new BrowserError('cancelled', 'The action was cancelled.');
      this.#assertUsable();
      this.#inFlight = action();
      try {
        return await this.#inFlight;
      } finally {
        this.#inFlight = null;
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Drops Maya's actions that have not started. The one in flight finishes. */
  cancelQueued() {
    this.#generation += 1;
  }

  /** The presenter takes the browser. Resolves once Maya's action in flight has finished. */
  async takeControl() {
    this.#assertUsable();
    if (this.controller === 'human') return;
    this.controller = 'human';
    this.#controlEpoch += 1;
    this.#gate = new Promise((resolve) => {
      this.#openGate = resolve;
    });
    await this.#inFlight?.catch(() => {});
    // What Maya last saw is no longer valid once the presenter starts acting.
    this.#refs.clear();
    this.humanReady = !this.lost && !this.closed;
    this.#emitState();
  }

  /** The presenter hands the browser back. Maya's waiting actions resume. */
  async returnControl() {
    if (this.controller !== 'human') return;
    // New input is refused at once; the batch in progress stops at its next
    // event and is awaited, so nothing of the presenter's arrives after Maya resumes.
    this.humanReady = false;
    await this.#humanQueue;
    await this.#releaseHeld();
    this.controller = 'maya';
    this.#refs.clear();
    this.#releaseGate();
    this.#emitState();
  }

  /** Lets go of every mouse button and key the presenter still holds. */
  async #releaseHeld() {
    const buttons = [...this.#heldButtons];
    const keys = [...this.#heldKeys];
    this.#heldButtons.clear();
    this.#heldKeys.clear();
    if (!this.#active || this.#active.isClosed()) return;
    for (const button of buttons) await this.#active.mouse.up({ button }).catch(() => {});
    for (const key of keys) await this.#active.keyboard.up(key).catch(() => {});
  }

  // ---- Presenter input ------------------------------------------------------------

  /**
   * Applies a batch of presenter input events to the active tab. Accepted
   * only while the presenter has control. Events are not stored or logged.
   */
  async humanInput(events) {
    this.#assertUsable();
    if (this.controller !== 'human' || !this.humanReady) {
      throw new BrowserError('not_in_control', 'Take control of the browser first.');
    }
    if (!Array.isArray(events) || events.length > 64) {
      throw new BrowserError('invalid_input', 'That input was not valid.');
    }
    // Batches are applied strictly one after another, in arrival order.
    const run = this.#humanQueue.then(() => this.#applyInput(events));
    this.#humanQueue = run.catch(() => {});
    return run;
  }

  async #applyInput(events) {
    const page = this.#active;
    const clamp = (value, max) => Math.min(max, Math.max(0, Number.isFinite(value) ? value : 0));
    for (const event of events) {
      if (this.controller !== 'human' || !this.humanReady) break;
      const x = clamp(Number(event?.x), VIEWPORT.width);
      const y = clamp(Number(event?.y), VIEWPORT.height);
      switch (event?.t) {
        case 'move':
          await page.mouse.move(x, y);
          break;
        case 'down':
        case 'up': {
          if (!BUTTONS.has(event.button)) break;
          // A second "down" or a stray "up" for the same button is ignored.
          if ((event.t === 'down') === this.#heldButtons.has(event.button)) break;
          await page.mouse.move(x, y);
          if (event.t === 'down') {
            this.#heldButtons.add(event.button);
            await page.mouse.down({ button: event.button });
          } else {
            this.#heldButtons.delete(event.button);
            await page.mouse.up({ button: event.button });
          }
          break;
        }
        case 'wheel':
          await page.mouse.move(x, y);
          await page.mouse.wheel(clamp(Math.abs(Number(event.dx)), 2000) * Math.sign(Number(event.dx) || 0), clamp(Math.abs(Number(event.dy)), 2000) * Math.sign(Number(event.dy) || 0));
          break;
        case 'key': {
          const key = typeof event.key === 'string' ? event.key : '';
          if (NAMED_KEYS.has(key) || /^[\x20-\x7e]$/.test(key)) {
            if (event.a === 'up') this.#heldKeys.delete(key);
            else this.#heldKeys.add(key);
            await (event.a === 'up' ? page.keyboard.up(key) : page.keyboard.down(key)).catch(() => {});
          } else if (event.a !== 'up' && [...key].length === 1) {
            // A character outside the US layout is inserted as text.
            await page.keyboard.insertText(key);
          }
          break;
        }
        case 'text':
          if (typeof event.text === 'string' && event.text.length <= 2000) await page.keyboard.insertText(event.text);
          break;
        case 'release':
          // Sent when the live view loses focus or its pointer.
          await this.#releaseHeld();
          break;
        default:
          break;
      }
    }
  }

  // ---- Maya's bounded actions --------------------------------------------------

  #mayUse() {
    return agentMayUse(this.address(), this.#config);
  }

  #assertAllowedPage() {
    if (!this.#mayUse()) {
      throw new BrowserError(
        'outside_allowed_websites',
        `The current page (${this.#originOf(this.address()) || 'blank'}) is outside the websites this assistant may use. Ask the customer, or navigate to an allowed website.`,
      );
    }
  }

  #originOf(address) {
    try {
      return new URL(address).origin;
    } catch {
      return '';
    }
  }

  async #settle(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: this.#config.actionTimeoutMs }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }

  #summary() {
    return {
      address: this.address(),
      tabs: [...this.#tabs].map(([id, page]) => ({ tab_id: id, address: page.url(), active: page === this.#active })),
    };
  }

  /** Reads the active tab: address, title, text, and interactive elements. No input values. */
  observe() {
    return this.#agent(async () => {
      const page = this.#active;
      const summary = { ...this.#summary(), title: await page.title().catch(() => '') };
      if (page.url() === 'about:blank') return { ...summary, note: 'The tab is blank. Navigate to a page.' };
      this.#assertAllowedPage();

      for (const handle of this.#refs.values()) void handle.dispose().catch(() => {});
      this.#refs.clear();
      this.#snapshot += 1;

      const list = await page.evaluateHandle(pageCollect, MAX_ELEMENTS);
      const described = await list.evaluate(pageDescribe);
      const properties = await list.getProperties();
      await list.dispose();
      const elements = [];
      described.forEach((item, index) => {
        const handle = properties.get(String(index))?.asElement();
        if (!handle) return;
        const ref = `s${this.#snapshot}e${index + 1}`;
        this.#refs.set(ref, handle);
        elements.push({
          ref,
          kind: item.role || (item.tag === 'a' ? 'link' : item.tag === 'input' ? `input ${item.type}` : item.tag),
          name: item.name,
          ...(item.link ? { link: item.link } : {}),
          ...(item.disabled ? { disabled: true } : {}),
          ...(item.checked === null ? {} : { checked: item.checked }),
          ...(item.filled === null ? {} : { has_text: item.filled }),
          ...(item.inView ? {} : { below_or_above_view: true }),
        });
      });
      return {
        ...summary,
        text: await page.evaluate(pageText, MAX_TEXT),
        elements,
        note: 'Element references are valid until the next action. Field contents are never included.',
      };
    });
  }

  navigate(address) {
    return this.#agent(async () => {
      if (!agentMayUse(address, this.#config)) {
        throw new BrowserError('address_not_allowed', 'That address is not an HTTPS page on an allowed website.');
      }
      const page = this.#active;
      this.#refs.clear();
      await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error) => {
        throw new BrowserError('navigation_failed', `The page did not load (${String(error.message).split('\n')[0].slice(0, 120)}).`);
      });
      await this.#settle(page);
      return { ...this.#summary(), title: await this.#active.title().catch(() => '') };
    });
  }

  #handle(ref) {
    const handle = typeof ref === 'string' ? this.#refs.get(ref) : null;
    if (!handle) {
      throw new BrowserError('stale_reference', 'That element reference is not from the latest observation. Observe the page again.');
    }
    return handle;
  }

  click(ref) {
    return this.#agent(async () => {
      this.#assertAllowedPage();
      const handle = this.#handle(ref);
      const [info] = await handle.evaluate(pageDescribe).catch(() => [{ name: '' }]);
      const page = this.#active;
      // References are single use: the page may change under them.
      this.#refs.clear();
      await handle.click({ timeout: this.#config.actionTimeoutMs }).catch((error) => {
        throw new BrowserError('click_failed', `The element could not be clicked (${String(error.message).split('\n')[0].slice(0, 120)}).`);
      });
      await this.#settle(page);
      // A click may have opened a tab; report the state once it is active.
      await this.#activation;
      return { clicked: info.name, ...this.#summary(), title: await this.#active.title().catch(() => '') };
    });
  }

  scroll(direction) {
    return this.#agent(async () => {
      this.#assertAllowedPage();
      if (direction !== 'up' && direction !== 'down') throw new BrowserError('invalid_direction', 'Scroll direction must be up or down.');
      this.#refs.clear();
      const position = await this.#active.evaluate((delta) => {
        window.scrollBy(0, delta);
        return { y: Math.round(window.scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
      }, direction === 'down' ? 640 : -640);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { scrolled: direction, position };
    });
  }

  switchTab(tabId) {
    return this.#agent(async () => {
      const page = this.#tabs.get(tabId);
      if (!page) throw new BrowserError('unknown_tab', 'That tab is not open.');
      await this.#activate(page);
      return this.#summary();
    });
  }

  // ---- App-only operations (never exposed to the model) ------------------------

  /** A JPEG of the active tab, taken by the app while Maya has control. */
  screenshot() {
    return this.#appAction(() =>
      this.#active.screenshot({ type: 'jpeg', quality: 70, timeout: this.#config.actionTimeoutMs }),
    );
  }

  /**
   * Runs an app-side operation in the same queue as Maya's actions, so a
   * takeover waits for it. It is refused if the presenter has control now, or
   * takes control before it starts: the page is then theirs, not the app's.
   */
  async #appAction(operation) {
    this.#assertUsable();
    const refused = () => new BrowserError('not_in_control', 'The presenter is controlling the browser.');
    if (this.controller !== 'maya' || this.#gate) throw refused();
    const epoch = this.#controlEpoch;
    return this.#agent(() => {
      if (epoch !== this.#controlEpoch) throw refused();
      return operation();
    });
  }

  /** Checks the two references Maya named for the code form, reading labels from the page itself. */
  describeSubmission(fieldRef, buttonRef) {
    return this.#appAction(() => this.#describeSubmission(fieldRef, buttonRef));
  }

  async #describeSubmission(fieldRef, buttonRef) {
    const field = this.#handle(fieldRef);
    const button = this.#handle(buttonRef);
    const [[fieldInfo], [buttonInfo]] = await Promise.all([
      field.evaluate(pageDescribe),
      button.evaluate(pageDescribe),
    ]).catch(() => {
      throw new BrowserError('stale_reference', 'Those elements are no longer on the page. Observe the page again.');
    });
    const isButton =
      buttonInfo.tag === 'button' || buttonInfo.role === 'button' ||
      (buttonInfo.tag === 'input' && ['submit', 'button'].includes(buttonInfo.type));
    if (!fieldInfo.textField || fieldInfo.type === 'password' || !fieldInfo.editable) {
      throw new BrowserError('not_a_code_field', 'The first reference is not an editable text field.');
    }
    if (fieldInfo.filled) throw new BrowserError('field_not_empty', 'The code field already has text in it.');
    if (!isButton || buttonInfo.disabled) throw new BrowserError('not_a_button', 'The second reference is not an enabled button.');
    return { address: this.address(), fieldLabel: fieldInfo.name, buttonLabel: buttonInfo.name };
  }

  /**
   * Enters a code into the named field and clicks the named button once.
   * Throws `not_submitted` if it fails before the click, and
   * `submission_uncertain` if anything fails once the click has begun.
   */
  async submitCode({ fieldRef, buttonRef, code, expectedAddress }) {
    const fail = (message) => new BrowserError('not_submitted', message);
    try {
      // Queued like Maya's actions, so a takeover cannot begin midway through
      // the fill and click, and one that came first cancels the submission.
      return await this.#appAction(() => this.#submit({ fieldRef, buttonRef, code, expectedAddress, fail }));
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'not_in_control') throw fail(error.message);
      throw error;
    }
  }

  async #submit({ fieldRef, buttonRef, code, expectedAddress, fail }) {
    if (this.address() !== expectedAddress) throw fail('The page changed since the request was made.');
    let field;
    let button;
    try {
      field = this.#handle(fieldRef);
      button = this.#handle(buttonRef);
      const info = await this.#describeSubmission(fieldRef, buttonRef);
      if (info.address !== expectedAddress) throw fail('The page changed since the request was made.');
      await field.fill(code, { timeout: this.#config.actionTimeoutMs });
      const taken = await field.evaluate((element, length) => element.value.length === length, code.length);
      if (!taken) throw fail('The field did not accept the code.');
    } catch (error) {
      await field?.fill('', { timeout: 2000 }).catch(() => {});
      throw error instanceof BrowserError && error.code === 'not_submitted'
        ? error
        : fail(error instanceof BrowserError ? error.message : 'The code could not be entered.');
    }
    // From here on the click may have reached the page, so any failure is uncertain.
    this.#refs.clear();
    const page = this.#active;
    try {
      await button.click({ timeout: this.#config.actionTimeoutMs });
    } catch {
      throw new BrowserError('submission_uncertain', 'The button click did not complete cleanly.');
    }
    await this.#settle(page);
  }

  /** The active page, for tests only. */
  pageForTests() {
    return this.#active;
  }

  /** How many buttons and keys the presenter is holding, for tests only. */
  heldForTests() {
    return { buttons: this.#heldButtons.size, keys: this.#heldKeys.size };
  }

  async close() {
    if (this.closed) return;
    this.#closing = true;
    this.closed = true;
    this.humanReady = false;
    this.cancelQueued();
    this.#releaseGate();
    this.#refs.clear();
    await this.#cdp?.send('Page.stopScreencast').catch(() => {});
    await this.#context?.close().catch(() => {});
    await this.#browser?.close().catch(() => {});
    this.latestFrame = null;
    this.emit('state', this.state());
  }
}
