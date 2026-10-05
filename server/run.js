import { randomUUID } from 'node:crypto';
import { AgentsApiError } from './agents-api.js';
import { BrowserError, BrowserSession } from './browser.js';
import { buildSessionRequest } from './instructions.js';
import { acceptedReplies, matchReply } from './replies.js';
import { CodeVault } from './secrets.js';
import { isDrawerEvent, summarizeApiEvent } from './summarize.js';
import { BROWSER_TOOLS, RESULT_OUTCOMES, TOOL } from './tools.js';

const MAX_STORED_IMAGES = 240;
const MAX_DRAWER_ROWS = 1500;
const MAX_RECONNECT_ATTEMPTS = 5;
const DEMO_START_URL = 'https://aryanjhanambi.github.io/singtel_demos/';

// Where a drawer row or card comes from. Browser actions are executed by this
// app through Playwright; they are not OpenAI-hosted computer use.
const API = 'Agents API';
const APP = 'App';
const PLAYWRIGHT = 'App · Playwright';
const PRESENTER = 'Presenter';

export const ENGINE = 'playwright';

/** An error the HTTP layer can show to the presenter. Never carries secrets. */
export class ActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.code = code;
  }
}

function describeError(error) {
  if (error instanceof AgentsApiError) {
    if (error.status === 0) return 'no response';
    const detail = error.code ?? (error.type === 'invalid_response' ? 'unreadable response' : '');
    return `HTTP ${error.status}${detail ? ` ${detail}` : ''}`;
  }
  return 'unexpected error';
}

function clip(value, max = 300) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Not JSON: treated as no arguments.
    }
  }
  return {};
}

function originOf(address) {
  try {
    return new URL(address).origin;
  } catch {
    return '';
  }
}

const isRootTurn = (event) => (event.turn?.subagent_id ?? null) === null;

/**
 * One demo run: an Agents API session that decides what to do, a Chromium
 * browser this app runs and streams, the staged test code, and the sanitized
 * view sent to the UI.
 */
export class Run {
  #vault = new CodeVault();
  #subscribers = new Set();
  #browserSubscribers = new Set();
  #images = new Map();
  #pinnedImages = new Set();
  #calls = new Map();
  #cardMeta = new Map();
  #timers = new Set();
  #lock = Promise.resolve();
  #streamAbort = null;
  #stagedForCardId = null;
  #sequence = 0;
  #lastStatus = '';
  #journalWarned = false;
  #autoTransitioning = false;
  #createBrowser;

  constructor({ id = randomUUID(), ownerHash, config, api, journal, log = () => {}, createBrowser }) {
    this.id = id;
    this.ownerHash = ownerHash;
    this.config = config;
    this.api = api;
    this.journal = journal;
    this.log = log;
    this.#createBrowser = createBrowser ?? (() => new BrowserSession({ config }));

    this.sessionId = null;
    this.createdAt = Date.now();
    this.submissions = [];
    this.browser = null;
    this.browserLost = null;

    this.timeline = [];
    this.steps = [];
    this.events = [];
    this.turnActive = false;
    this.lastTurnEnd = null;
    this.connection = 'none';
    this.starting = false;
    this.ending = false;
    this.ended = false;
    this.failed = null;
    this.reconnectAttempts = 0;
    this.activityId = null;
    this.state = 'idle';
  }

  // ---- View ---------------------------------------------------------------

  snapshot() {
    return structuredClone({
      id: this.id,
      status: this.#status(),
      timeline: this.timeline,
      steps: this.steps,
      events: this.events,
    });
  }

  subscribe(listener) {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  /** Live frames and browser state for the owner's UI. Frames are not kept. */
  subscribeBrowser(listener) {
    this.#browserSubscribers.add(listener);
    return () => this.#browserSubscribers.delete(listener);
  }

  latestFrame() {
    return this.browser?.latestFrame ?? null;
  }

  browserState() {
    const state = this.browser?.state();
    return {
      running: Boolean(state) && !state.closed && !state.lost,
      controller: state?.controller ?? 'maya',
      humanReady: state?.humanReady ?? false,
      address: state?.address ?? '',
      tabs: state?.tabs ?? [],
      lost: this.browserLost,
      viewport: state?.viewport ?? null,
    };
  }

  image(stepId) {
    return this.#images.get(stepId) ?? null;
  }

  #emit(op) {
    const payload = structuredClone(op);
    for (const listener of this.#subscribers) listener(payload);
  }

  #status() {
    return {
      state: this.state,
      connection: this.connection,
      turnActive: this.turnActive,
      codeRelease: this.config.codeReleaseEnabled ? 'armed' : 'locked',
      sessionId: this.sessionId,
      activeCardId: this.#activeCard()?.id ?? null,
      castOrigin: this.config.castOrigin,
      allowedHosts: this.config.allowedHosts,
      browser: this.browserState(),
    };
  }

  #computeState() {
    if (this.ended) return 'ended';
    if (this.failed) return 'failed';
    if (this.browserLost) return 'browser_lost';
    const submission = this.submissions.at(-1);
    if (submission?.outcome === 'confirmed') return 'confirmed';
    if (this.starting) return 'starting';
    if (this.browser?.controller === 'human') return 'human_control';
    const pending = this.#pending();
    if (pending.length > 0) return pending[0].card === 'release' ? 'ready_to_redeem' : 'needs_input';
    if (submission && submission.status !== 'not_submitted') {
      if (submission.outcome === null) return this.turnActive ? 'submitting' : 'outcome_unknown';
      if (submission.outcome === 'rejected') return this.turnActive ? 'working' : 'rejected';
      return 'outcome_unknown';
    }
    if (this.turnActive) return 'working';
    if (this.lastTurnEnd === 'cancelled') return 'cancelled';
    return 'idle';
  }

  #touch() {
    this.state = this.#computeState();
    const status = this.#status();
    const serialized = JSON.stringify(status);
    if (serialized === this.#lastStatus) return;
    this.#lastStatus = serialized;
    this.#emit({ op: 'status', status });
  }

  #nextId(prefix) {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  #addEntry(entry) {
    const full = { id: this.#nextId(entry.kind), at: Date.now(), ...entry };
    this.timeline.push(full);
    // Anything other than browser steps ends the current working stretch.
    if (full.kind !== 'activity') this.activityId = null;
    this.#emit({ op: 'entry', entry: full });
    return full;
  }

  #updateEntry(entry) {
    this.#emit({ op: 'entry', entry });
  }

  #notice(text, tone = 'info') {
    this.#addEntry({ kind: 'notice', tone, text });
  }

  #row(source, type, summary) {
    const row = { id: this.#nextId('event'), at: Date.now(), source, type, summary };
    this.events.push(row);
    if (this.events.length > MAX_DRAWER_ROWS) this.events.shift();
    this.#emit({ op: 'event', row });
    this.log('debug', `${source} ${type}`);
  }

  /** Writes the recovery journal. Returns false if it could not be saved. */
  #persist() {
    try {
      this.journal.save({
        id: this.id,
        engine: ENGINE,
        ownerHash: this.ownerHash,
        sessionId: this.sessionId,
        createdAt: this.createdAt,
        endedAt: this.ended ? Date.now() : null,
        state: this.state,
        submissions: this.submissions,
      });
      return true;
    } catch {
      this.log('warn', 'journal write failed');
      if (!this.#journalWarned) {
        this.#journalWarned = true;
        this.#notice(
          'The app could not save its recovery journal. A test code will not be submitted while this persists.',
          'warning',
        );
      }
      return false;
    }
  }

  /** Page- or model-written text, clipped and with any released code removed. */
  #safe(value, max = 300) {
    return this.#vault.redact(clip(String(value ?? ''), max));
  }

  #redactDeep(value) {
    if (typeof value === 'string') return this.#vault.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.#redactDeep(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#redactDeep(item)]));
    }
    return value;
  }

  #serial(task) {
    const next = this.#lock.then(task, task);
    this.#lock = next.catch(() => {});
    return next;
  }

  #timer(delayMs, task) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      task();
    }, delayMs);
    timer.unref?.();
    this.#timers.add(timer);
  }

  #pending(card) {
    return this.timeline.filter(
      (entry) => entry.kind === 'card' && entry.status === 'pending' && (!card || entry.card === card),
    );
  }

  /** The one card a typed reply applies to: the oldest pending one. */
  #activeCard() {
    return this.#pending()[0] ?? null;
  }

  #card(cardId, kind) {
    const entry = this.timeline.find((item) => item.id === cardId && item.kind === 'card');
    if (!entry || entry.card !== kind) throw new ActionError(404, 'card_not_found', 'That request was not found.');
    if (entry.status !== 'pending') {
      throw new ActionError(409, 'card_not_pending', 'That request is no longer pending.');
    }
    return entry;
  }

  #assertOpen() {
    if (this.ended || this.ending) throw new ActionError(409, 'run_ended', 'This session has ended.');
    if (this.failed) throw new ActionError(409, 'run_failed', 'This session has failed.');
  }

  #assertBrowser() {
    this.#assertOpen();
    if (!this.browser || this.browserLost) throw new ActionError(409, 'no_browser', 'The browser is not running.');
  }

  // ---- Customer messages and typed replies --------------------------------

  postMessage(rawText, { replyTo = null } = {}) {
    return this.#serial(async () => {
      this.#assertOpen();
      const text = String(rawText ?? '').trim();
      if (!text) throw new ActionError(400, 'empty_message', 'Type a message first.');
      if (text.length > 2000) throw new ActionError(400, 'message_too_long', 'Keep messages under 2,000 characters.');
      if (this.browser?.controller === 'human') {
        throw new ActionError(
          409,
          'human_in_control',
          'You are controlling the browser. Return control to Maya first. Chat is paused so nothing meant for the website is typed here.',
        );
      }
      if (this.#vault.containsStaged(text)) {
        this.#notice(
          'That message contained the staged test code, so it was not sent or shown. Use the masked code field in the card.',
          'warning',
        );
        return;
      }

      const active = this.#activeCard();
      this.#addEntry({ kind: 'customer', text: this.#vault.redact(text) });

      if (replyTo !== null && replyTo !== (active?.id ?? null)) {
        this.#notice('The pending request changed before your reply arrived. Check the current request and reply again.', 'warning');
        return;
      }
      if (active) await this.#answerCard(active, text);
      else if (!this.sessionId) await this.#startSession(text);
      else await this.#sendToMaya(text);
      this.#touch();
    });
  }

  async #answerCard(card, text) {
    const decision = matchReply(card.card, text);
    if (!decision) {
      const what = card.card === 'release' ? 'The redemption authorization' : 'The sign-in request';
      this.#notice(`${what} is waiting. Reply ${acceptedReplies(card.card)}. Your message was not sent to Maya.`);
      return;
    }
    if (card.card === 'takeover') await this.#declineTakeover(card);
    else if (decision === 'authorize') await this.#authorizeSubmission(card);
    else await this.#declineSubmission(card);
  }

  async #sendToMaya(text) {
    if (this.connection !== 'live') {
      this.#notice('Not connected to the session, so your message was not sent. Select Reconnect, then send it again.', 'warning');
      return;
    }
    try {
      await this.api.sendEvents(
        this.sessionId,
        [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }],
        { idempotencyKey: randomUUID() },
      );
      this.#row(APP, 'agent.session.input.message', 'Customer message sent to the session');
      this.turnActive = true;
      this.lastTurnEnd = null;
    } catch (error) {
      this.#notice(`Your message could not be delivered (${describeError(error)}). It was not resent.`, 'error');
    }
  }

  // ---- Browser, session, and stream ---------------------------------------

  #broadcastBrowser(message) {
    for (const listener of this.#browserSubscribers) listener(message);
  }

  async #startBrowser() {
    const browser = this.#createBrowser();
    browser.on('state', () => {
      this.#touch();
      this.#broadcastBrowser({ t: 'state', state: this.browserState() });
      void this.#maybeAutoTransitionAfterLogin();
    });
    browser.on('frame', (frame) => this.#broadcastBrowser({ t: 'frame', frame }));
    browser.on('note', (text) => this.#notice(text, 'info'));
    browser.on('lost', (reason) => this.#onBrowserLost(reason));
    this.#row(PLAYWRIGHT, 'browser.launch', 'Starting Chromium with a private context');
    try {
      await browser.start();
    } catch {
      await browser.close().catch(() => {});
      this.#notice(
        'Chromium could not be started, so no session was created. Run “npm run browser:install” and try again.',
        'error',
      );
      return false;
    }
    this.browser = browser;
    return true;
  }

  /**
   * In the hosted demo, a successful CAST OTP sign-in changes the page away
   * from the login route. That navigation is enough to continue; the OTP
   * itself is never read. Returning control and opening the duplicated page
   * here removes the extra manual handoff from the presenter.
   */
  async #maybeAutoTransitionAfterLogin() {
    if (this.#autoTransitioning || !this.config.demoMode || !this.browser) return;
    if (this.browser.controller !== 'human' || !this.#pending('takeover').length) return;
    let url;
    try {
      url = new URL(this.browser.address());
    } catch {
      return;
    }
    if (url.host !== 'cast.singtel.com' || /\/login(?:[/?#]|$)/i.test(url.pathname)) return;

    this.#autoTransitioning = true;
    try {
      await this.browser.returnControl();
      await this.browser.navigate(DEMO_START_URL);
      this.#row(APP, 'journey.auto_transition', 'Successful sign-in detected; opened the hosted AI Pass page');
      this.#notice('Your sign-in is complete. Maya is continuing with the AI Pass page.', 'info');
      for (const card of this.#pending('takeover')) {
        card.status = 'answered';
        card.outcome = 'Sign-in detected';
        this.#updateEntry(card);
        const call = this.#cardMeta.get(card.id)?.call;
        if (call) {
          void this.#deliver(call, {
            success: true,
            output: 'The sign-in completed and the app already opened the hosted AI Pass page. Continue from there; do not ask the customer to return control.',
          });
        }
      }
      this.#touch();
    } catch {
      // If the redirect is incomplete or the browser closes, leave the normal
      // Take control / Return to Maya flow available to the presenter.
      this.#autoTransitioning = false;
    }
  }

  /**
   * Starts the browser, then creates the session with the first message as
   * its required initial input, then opens the stream and reconciles so a tool
   * call made before the stream opened is not missed.
   */
  async #startSession(firstMessage) {
    this.starting = true;
    this.#touch();
    if (!(await this.#startBrowser())) {
      this.starting = false;
      this.#touch();
      return false;
    }
    this.#row(APP, 'session.create', `POST /agents/sessions: ${this.config.model}, no environment, function tools, initial input`);
    let session;
    try {
      session = await this.api.createSession(buildSessionRequest(this.config, firstMessage));
      if (!session || typeof session.id !== 'string' || !session.id) {
        throw new AgentsApiError({ status: 200, type: 'invalid_response' });
      }
    } catch (error) {
      this.starting = false;
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.#notice(
        `The session could not be created (${describeError(error)}). Its outcome is unknown and nothing is retried automatically.`,
        'error',
      );
      this.#touch();
      return false;
    }
    this.sessionId = session.id;
    this.turnActive = true;
    this.#persist();
    this.#row(API, 'agent.session', `session ${session.id} created and its first turn started`);
    const open = await this.#openStream();
    this.starting = false;
    if (open) await this.#reconcile();
    else this.#notice('The session was created but its event stream did not open. Select Reconnect.', 'error');
    this.#touch();
    return open;
  }

  async #openStream() {
    this.#streamAbort?.abort();
    const abort = new AbortController();
    this.#streamAbort = abort;
    this.connection = 'connecting';
    this.#touch();
    let stream;
    try {
      stream = await this.api.openEventStream(this.sessionId, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) return false;
      this.connection = 'lost';
      this.#row(APP, 'stream.error', `Event stream did not open (${describeError(error)})`);
      this.#touch();
      return false;
    }
    this.connection = 'live';
    this.#row(APP, 'stream.open', 'Listening for session events');
    this.#touch();
    void this.#consume(stream, abort);
    return true;
  }

  async #consume(stream, abort) {
    const openedAt = Date.now();
    try {
      for await (const event of stream) {
        if (abort.signal.aborted) return;
        this.#onEvent(event);
      }
    } catch {
      // Treated the same as a closed stream.
    }
    if (abort.signal.aborted || this.ended || this.ending) return;
    if (Date.now() - openedAt > 10_000) this.reconnectAttempts = 0;
    this.connection = 'recovering';
    this.#row(APP, 'stream.closed', 'Event stream closed. Reconnecting; nothing will be resent.');
    this.#touch();
    this.#scheduleRecover();
  }

  #scheduleRecover() {
    if (this.ended || this.ending) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.connection = 'lost';
      this.#notice('The connection to the session was lost. Select Reconnect to check it. Nothing has been resent.', 'error');
      this.#touch();
      return;
    }
    const delay = Math.min(16, 2 ** this.reconnectAttempts) * this.config.reconnectBaseMs;
    this.reconnectAttempts += 1;
    this.#timer(delay, () => void this.#recover());
  }

  async #recover() {
    if (this.ended || this.ending || !this.sessionId) return;
    if (!(await this.#openStream())) {
      this.connection = 'recovering';
      this.#touch();
      this.#scheduleRecover();
      return;
    }
    await this.#serial(() => this.#reconcile());
  }

  /** Manual reconnect from the UI. Sends no customer input to the session. */
  reconnect() {
    this.#assertOpen();
    if (!this.sessionId) throw new ActionError(409, 'no_session', 'There is no session to reconnect to.');
    this.reconnectAttempts = 0;
    return this.#recover();
  }

  /**
   * Catches up from the saved session: messages, turn state, and pending
   * calls. A call this app already ran is answered from its saved result; it
   * is never run a second time.
   */
  async #reconcile() {
    let session;
    try {
      session = await this.api.retrieveSession(this.sessionId);
    } catch (error) {
      this.#row(APP, 'reconcile.error', `Session could not be retrieved (${describeError(error)})`);
      return;
    }
    let count = 0;
    try {
      for await (const item of this.api.listItems(this.sessionId)) {
        this.#applyItem(item);
        count += 1;
      }
    } catch (error) {
      this.#row(APP, 'reconcile.error', `Saved items could not be listed (${describeError(error)})`);
    }
    const wasActive = this.turnActive;
    this.turnActive = session.status === 'in_progress' || session.status === 'requires_action';
    if (wasActive && !this.turnActive) this.#onRootTurnEnd('ended while disconnected');
    this.#applySession(session);
    this.#row(APP, 'reconcile', `Read ${count} saved items and the current pending calls. No customer input was resent.`);
    this.#touch();
  }

  #onEvent(event) {
    const type = event?.type;
    if (typeof type !== 'string') return;
    if (isDrawerEvent(type)) this.#row(API, type, summarizeApiEvent(event));
    switch (type) {
      case 'agent.session.turn.created':
      case 'agent.session.turn.in_progress':
        if (isRootTurn(event)) {
          this.turnActive = true;
          this.lastTurnEnd = null;
        }
        break;
      case 'agent.session.in_progress':
        this.turnActive = true;
        break;
      case 'agent.session.idle':
        // Idle alone says nothing about success; it only means no turn is running.
        if (this.turnActive) this.#onRootTurnEnd('idle');
        break;
      case 'agent.session.turn.completed':
        if (isRootTurn(event)) this.#onRootTurnEnd('completed');
        break;
      case 'agent.session.turn.failed':
        if (isRootTurn(event)) this.#onRootTurnEnd('failed', event.turn?.error);
        break;
      case 'agent.session.turn.cancelled':
        if (isRootTurn(event)) this.#onRootTurnEnd('cancelled');
        break;
      case 'agent.session.turn.item.done':
        this.#applyItem(event.item);
        break;
      case 'agent.session.turn.output_text.done':
        this.#upsertMaya(`${event.item_id}:${event.content_index ?? 0}`, event.text);
        break;
      case 'agent.session.requires_action':
        void this.#serial(() => this.#refresh(event.session));
        break;
      case 'agent.session.failed':
      case 'agent.session.environment.failed':
        this.#fail(type, event.error ?? event.session?.error ?? event.environment?.error);
        break;
      case 'error':
        this.#notice(
          `The Agents API reported an error (${clip(String(event.error?.code ?? event.error?.type ?? 'error'), 60)}).`,
          'error',
        );
        break;
      default:
        break;
    }
    this.#touch();
  }

  #fail(type, error) {
    if (this.failed) return;
    this.failed = { type, code: clip(String(error?.code ?? error?.type ?? ''), 60) };
    this.turnActive = false;
    this.#vault.clearStaged();
    this.browser?.cancelQueued();
    this.#markUnknownIfSubmitted('The session failed');
    this.#notice(
      `The session failed (${this.failed.code || type}). Nothing is retried automatically. The browser stays open for you to check; end the session when ready.`,
      'error',
    );
  }

  #onRootTurnEnd(kind, error) {
    this.turnActive = false;
    this.lastTurnEnd = kind;
    // A turn ending is never taken as a redemption result.
    this.#markUnknownIfSubmitted("Maya's turn ended without reporting what CAST shows");
    if (kind === 'failed') {
      this.#notice(`Maya's turn failed (${clip(String(error?.code ?? 'error'), 60)}). Nothing was retried.`, 'error');
    } else if (kind === 'cancelled') {
      this.#notice('Maya was stopped.', 'info');
    }
    if (this.#pending().length > 0) void this.#serial(() => this.#refresh());
  }

  #onBrowserLost(reason) {
    if (this.browserLost || this.ending || this.ended) return;
    this.browserLost = clip(reason, 200);
    this.#vault.clearStaged();
    this.#markUnknownIfSubmitted('The browser closed before a result was seen');
    for (const card of this.#pending()) this.#closeCard(card, 'Browser closed');
    this.#row(PLAYWRIGHT, 'browser.lost', this.browserLost);
    this.#notice(
      `${this.browserLost} The session cannot continue in this browser, and it was not replaced. End the session when ready.`,
      'error',
    );
    this.#touch();
  }

  #applyItem(item) {
    if (item?.type !== 'message' || item.role !== 'assistant') return;
    (item.content ?? []).forEach((part, index) => {
      if (part?.type === 'output_text') this.#upsertMaya(`${item.id}:${index}`, part.text);
    });
  }

  #upsertMaya(key, rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return;
    const text = this.#safe(rawText, 4000);
    const existing = this.timeline.find((entry) => entry.kind === 'maya' && entry.key === key);
    if (existing) {
      if (existing.text === text) return;
      existing.text = text;
      this.#updateEntry(existing);
    } else {
      this.#addEntry({ kind: 'maya', key, text });
    }
  }

  // ---- Browser steps (for the activity line and thumbnails) -----------------

  #beginStep(title) {
    const step = {
      id: this.#nextId('step'),
      n: this.steps.length + 1,
      title,
      status: 'in_progress',
      hasImage: false,
      imageRev: 0,
      at: Date.now(),
    };
    this.steps.push(step);
    let entry = this.timeline.find((item) => item.id === this.activityId);
    if (!entry) {
      entry = this.#addEntry({ kind: 'activity', stepIds: [] });
      this.activityId = entry.id;
    }
    entry.stepIds.push(step.id);
    this.#updateEntry(entry);
    this.#emit({ op: 'step', step });
    return step;
  }

  /** Finishes a step and, if asked, attaches a screenshot the app takes now. */
  async #endStep(step, status, { title, capture = false } = {}) {
    step.status = status;
    if (title) step.title = title;
    if (capture && this.browser) {
      // Refused while the presenter has control, so nothing they do is captured.
      const image = await this.browser.screenshot().catch(() => null);
      if (image) {
        this.#images.set(step.id, image);
        step.hasImage = true;
        step.imageRev += 1;
        this.#evictImages();
      }
    }
    this.#emit({ op: 'step', step });
    return step;
  }

  #evictImages() {
    if (this.#images.size <= MAX_STORED_IMAGES) return;
    for (const step of this.steps) {
      if (this.#images.size <= MAX_STORED_IMAGES) break;
      if (!this.#images.has(step.id) || this.#pinnedImages.has(step.id)) continue;
      this.#images.delete(step.id);
      step.hasImage = false;
      this.#emit({ op: 'step', step });
    }
  }

  // ---- Pending function calls -------------------------------------------------

  async #refresh(fallbackSession = null) {
    if (!this.sessionId) return;
    let session = fallbackSession;
    try {
      session = await this.api.retrieveSession(this.sessionId);
    } catch (error) {
      this.#row(APP, 'session.retrieve.error', `Session could not be retrieved (${describeError(error)})`);
    }
    if (session) this.#applySession(session);
    this.#touch();
  }

  #applySession(session) {
    if (session.status === 'failed') this.#fail('agent.session.failed', session.error);
    const actions = Array.isArray(session.required_actions) ? session.required_actions : [];
    const present = new Set();

    for (const action of actions) {
      if (action?.type !== 'function_call' || !action.call_id) {
        const key = `unsupported:${action?.type}`;
        if (!this.#calls.has(key)) {
          this.#calls.set(key, { key });
          this.#notice(
            `The session asked for “${clip(String(action?.type), 60)}”, which this app does not handle. Select Stop if Maya stays blocked.`,
            'warning',
          );
        }
        continue;
      }
      const key = `call:${action.call_id}`;
      present.add(key);
      const known = this.#calls.get(key);
      if (known) {
        // Already run: hand back the saved result rather than running it again.
        if (known.result && !known.acknowledged && !known.delivering) void this.#deliver(known);
        continue;
      }
      const call = { key, action, name: action.name, result: null, acknowledged: false, delivering: false };
      this.#calls.set(key, call);
      if (BROWSER_TOOLS.has(action.name)) void this.#runBrowserTool(call);
      else if (action.name === TOOL.LOGIN) this.#openTakeoverCard(call);
      else if (action.name === TOOL.SUBMIT) void this.#openSubmissionCard(call);
      else if (action.name === TOOL.REPORT) void this.#handleReport(call);
      else void this.#deliver(call, { success: false, error: 'This function is not available.' });
    }

    // Controls are removed for requests the session no longer lists.
    for (const entry of this.#pending()) {
      const meta = this.#cardMeta.get(entry.id);
      if (meta && !present.has(meta.call.key)) this.#closeCard(entry, 'No longer pending');
    }
  }

  /**
   * Returns a function result to the session, once. If the acknowledgement is
   * lost the saved result is offered again on the next sync; the function
   * itself is not repeated.
   */
  async #deliver(call, result = call.result) {
    call.result = result;
    call.delivering = true;
    try {
      await this.api.sendEvents(this.sessionId, [
        { type: 'agent.session.input.tool_result', turn_id: call.action.turn_id, call_id: call.action.call_id, ...result },
      ]);
      call.acknowledged = true;
      this.#row(APP, 'agent.session.input.tool_result', `${clip(String(call.name), 60)}: ${result.success ? 'result returned' : 'error returned'}`);
    } catch (error) {
      this.#row(APP, 'tool_result.error', `${clip(String(call.name), 60)}: ${describeError(error)}`);
      if (error instanceof AgentsApiError && error.rejected) {
        // A clear rejection means the call is no longer waiting for this result.
        call.acknowledged = true;
      } else if ((call.attempts = (call.attempts ?? 0) + 1) < 4) {
        // Otherwise check the session again shortly. If the call is still
        // pending, the saved result is sent again; the action is not repeated.
        this.#timer(this.config.reconnectBaseMs * 2 * call.attempts, () => void this.#serial(() => this.#refresh()));
      }
    } finally {
      call.delivering = false;
    }
  }

  #toolError(error) {
    return error instanceof BrowserError ? error.message : 'The browser action failed.';
  }

  /**
   * Once a submission has been attempted, Maya may only look. Otherwise a
   * plain click on the same button would submit again without authorization
   * or a journal record. After a rejection seen on CAST she must first load
   * the form afresh, which empties it, before any click; a new submission then
   * goes back through the authorization card.
   */
  #mutationBlock(toolName) {
    const submission = this.#lastSubmission();
    if (!submission || toolName === TOOL.OBSERVE || toolName === TOOL.SCROLL) return null;
    if (submission.outcome !== 'rejected') {
      return `A code has been submitted in this session, so the application now allows only ${TOOL.OBSERVE}, ${TOOL.SCROLL}, and ${TOOL.REPORT}. Do not try to submit again. Observe the page and report what it shows.`;
    }
    if (toolName === TOOL.CLICK && !submission.reloadedAfterRejection) {
      return `After a rejected code, open the redemption form again with ${TOOL.NAVIGATE} before clicking anything. A new submission needs ${TOOL.SUBMIT} and the customer's authorization.`;
    }
    return null;
  }

  async #runBrowserTool(call) {
    const args = parseArguments(call.action.arguments);
    const browser = this.browser;
    if (!browser || this.browserLost) {
      return this.#deliver(call, { success: false, error: 'The browser is no longer available. Tell the customer.' });
    }
    const blocked = this.#mutationBlock(call.name);
    if (blocked) {
      this.#row(APP, 'browser_tool.refused', `${call.name} refused after a submission`);
      return this.#deliver(call, { success: false, error: blocked });
    }
    const titles = {
      [TOOL.OBSERVE]: 'Read the page',
      [TOOL.NAVIGATE]: `Opening ${this.#safe(args.url, 120)}`,
      [TOOL.CLICK]: 'Clicking an element',
      [TOOL.SCROLL]: `Scrolling ${args.direction === 'up' ? 'up' : 'down'}`,
      [TOOL.SWITCH_TAB]: 'Switching tab',
    };
    const step = this.#beginStep(titles[call.name]);
    try {
      let output;
      let title;
      if (call.name === TOOL.OBSERVE) output = await browser.observe();
      else if (call.name === TOOL.NAVIGATE) {
        output = await browser.navigate(String(args.url ?? ''));
        title = `Opened ${this.#safe(output.address, 120)}`;
        const rejected = this.#lastSubmission();
        if (rejected?.outcome === 'rejected') rejected.reloadedAfterRejection = true;
      } else if (call.name === TOOL.CLICK) {
        output = await browser.click(args.ref);
        title = `Clicked “${this.#safe(output.clicked, 80) || 'an element'}”`;
      } else if (call.name === TOOL.SCROLL) {
        output = await browser.scroll(args.direction);
        title = `Scrolled ${args.direction}`;
      } else {
        output = await browser.switchTab(String(args.tab_id ?? ''));
        title = 'Switched tab';
      }
      await this.#endStep(step, 'completed', { title, capture: call.name !== TOOL.OBSERVE });
      this.#row(PLAYWRIGHT, call.name, this.#safe(step.title, 120));
      // The page may echo a submitted code; it is removed before the model sees it.
      await this.#deliver(call, { success: true, output: JSON.stringify(this.#redactDeep(output)) });
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'cancelled') {
        await this.#endStep(step, 'incomplete');
        return;
      }
      await this.#endStep(step, 'failed');
      this.#row(PLAYWRIGHT, call.name, `failed: ${error instanceof BrowserError ? error.code : 'error'}`);
      await this.#deliver(call, { success: false, error: this.#toolError(error) });
    }
    this.#touch();
  }

  #openCard(call, fields, meta = {}) {
    const entry = this.#addEntry({ kind: 'card', status: 'pending', source: APP, ...fields });
    this.#cardMeta.set(entry.id, { call, ...meta });
    this.#touch();
    return entry;
  }

  #closeCard(entry, outcome) {
    entry.status = 'closed';
    entry.outcome = outcome;
    if (entry.card === 'release') this.#unstage(entry);
    this.#updateEntry(entry);
  }

  // ---- Presenter control of the browser -------------------------------------

  #openTakeoverCard(call) {
    const args = parseArguments(call.action.arguments);
    this.#openCard(call, {
      card: 'takeover',
      reason: this.#safe(args.reason ?? '', 300),
      // The address comes from the browser itself, not from the model.
      address: this.#safe(this.browser?.address() ?? '', 300),
    });
    this.#row(APP, 'takeover.requested', 'Maya asked the presenter to sign in themselves');
  }

  /** The presenter takes the browser. Maya's tools wait until it is returned. */
  takeControl() {
    return this.#serial(async () => {
      this.#assertBrowser();
      if (this.browser.controller === 'human') return;
      await this.browser.takeControl().catch((error) => {
        throw new ActionError(409, 'no_browser', this.#toolError(error));
      });
      this.#row(PRESENTER, 'control.taken', 'The presenter is controlling the browser; Maya is paused');
      this.#notice('You are controlling the browser. Maya is paused and is not shown what you do.', 'info');
      this.#touch();
    });
  }

  /** The presenter hands the browser back. Nothing about what they did is passed on. */
  returnControl() {
    return this.#serial(async () => {
      this.#assertOpen();
      if (!this.browser || this.browser.controller !== 'human') return;
      await this.browser.returnControl();
      this.#row(PRESENTER, 'control.returned', 'Control returned to Maya');
      this.#notice('Control is back with Maya.', 'info');
      for (const card of this.#pending('takeover')) {
        card.status = 'answered';
        card.outcome = 'Control returned';
        this.#updateEntry(card);
        void this.#deliver(this.#cardMeta.get(card.id).call, {
          success: true,
          output:
            'The customer has finished and returned control of the browser. You were not shown what they did. Observe the page to continue.',
        });
      }
      this.#touch();
    });
  }

  /** Forwards presenter input to the browser. Not stored, logged, or shown to the model. */
  async humanInput(events) {
    this.#assertBrowser();
    try {
      await this.browser.humanInput(events);
    } catch (error) {
      if (error instanceof BrowserError) {
        throw new ActionError(error.code === 'invalid_input' ? 400 : 409, error.code, error.message);
      }
      throw new ActionError(500, 'input_failed', 'That input could not be applied.');
    }
  }

  async #declineTakeover(card) {
    card.status = 'answered';
    card.outcome = 'Declined';
    this.#updateEntry(card);
    await this.#deliver(this.#cardMeta.get(card.id).call, {
      success: false,
      error: 'The customer chose not to sign in now. Do not continue past the sign-in page. Tell the customer and wait.',
    });
  }

  // ---- Test code and submission authorization --------------------------------

  #submissionBlocker() {
    const last = this.submissions.at(-1);
    if (!last || last.status === 'not_submitted' || last.outcome === 'rejected') return null;
    return 'A code was already submitted in this session and CAST has not been seen to reject it.';
  }

  #onCast(address) {
    return originOf(address) === this.config.castOrigin;
  }

  async #openSubmissionCard(call) {
    if (this.config.demoMode) {
      return this.#deliver(call, {
        success: false,
        error: "This page does not require a voucher code. Select Redeem, then Continue to AI Pass to proceed.",
      });
    }
    const args = parseArguments(call.action.arguments);
    const decline = (noticeText, agentError) => {
      this.#notice(noticeText, 'warning');
      return this.#deliver(call, { success: false, error: agentError });
    };

    // Fails closed: anything other than an explicit "no payment" is declined.
    if (args.payment_requested !== false) {
      return args.payment_requested === true
        ? decline(
            'Maya reported a payment request on the page. The app does not submit the code in that case.',
            'The application does not submit the code when a payment request is reported. Tell the customer what the page asks for and wait.',
          )
        : decline(
            'Maya asked for a submission without stating whether the page requests payment. Nothing was submitted.',
            `The request was incomplete. Call ${TOOL.SUBMIT} again with every argument, including payment_requested as true or false.`,
          );
    }
    const blocker = this.#submissionBlocker();
    if (blocker) {
      return decline(
        `${blocker} The app will not submit another code until the outcome is known.`,
        `A code was already submitted in this session and its outcome is not a seen rejection. Do not ask again. Observe the page and call ${TOOL.REPORT}.`,
      );
    }
    if (!this.browser || this.browserLost) {
      return decline('The browser is not available, so nothing was submitted.', 'The browser is no longer available. Tell the customer.');
    }
    // The address is read from the browser, not taken from the model.
    const address = this.browser.address();
    if (!this.#onCast(address)) {
      return decline(
        `Maya asked for a submission while the browser was not on ${this.config.castOrigin}. Nothing was submitted.`,
        `The application submits the code only on ${this.config.castOrigin}. Go to the AI Pass code form there, observe it, then call ${TOOL.SUBMIT}.`,
      );
    }
    let described;
    try {
      described = await this.browser.describeSubmission(args.code_field_ref, args.submit_button_ref);
    } catch (error) {
      return decline(
        'Maya’s request did not point at an empty code field and a button on the current page. Nothing was submitted.',
        `${this.#toolError(error)} Observe the page again, then call ${TOOL.SUBMIT} with references from that observation.`,
      );
    }

    this.#openCard(
      call,
      {
        card: 'release',
        website: this.config.castOrigin,
        address: this.#safe(described.address, 300),
        fieldLabel: this.#safe(described.fieldLabel, 80),
        buttonLabel: this.#safe(described.buttonLabel, 80),
        accountContext: this.#safe(args.account_context ?? '', 200),
        pageSummary: this.#safe(args.page_summary ?? '', 300),
        locked: !this.config.codeReleaseEnabled,
        codeStaged: false,
        maskedReference: null,
      },
      { fieldRef: args.code_field_ref, buttonRef: args.submit_button_ref, address: described.address },
    );
    this.#row(APP, 'submission.requested', 'Maya is at the code form; waiting for the presenter');
    return undefined;
  }

  #unstage(card) {
    if (this.#stagedForCardId === card.id) {
      this.#vault.clearStaged();
      this.#stagedForCardId = null;
    }
    card.codeStaged = false;
    card.maskedReference = null;
  }

  /** Stages the code in memory for one specific pending card. It is not sent anywhere. */
  stageCode(cardId, code) {
    return this.#serial(async () => {
      this.#assertOpen();
      const card = this.#card(cardId, 'release');
      if (!this.config.codeReleaseEnabled) {
        throw new ActionError(403, 'release_locked', 'Code release is locked for rehearsal, so the app does not accept a code.');
      }
      const problem = this.#vault.stage(code);
      if (problem) throw new ActionError(400, 'invalid_code', problem);
      this.#stagedForCardId = card.id;
      card.codeStaged = true;
      card.maskedReference = this.#vault.maskedReference();
      this.#updateEntry(card);
      this.#row(APP, 'submission.code_staged', 'Test code added in the masked field (value withheld)');
    });
  }

  clearCode(cardId) {
    return this.#serial(async () => {
      const card = this.#card(cardId, 'release');
      this.#unstage(card);
      this.#updateEntry(card);
    });
  }

  /**
   * The presenter typed "confirm". If every check holds, the app itself types
   * the code into the page and clicks the button once. The model is never
   * given the code.
   */
  async #authorizeSubmission(card) {
    const meta = this.#cardMeta.get(card.id);
    const refuse = (text) => this.#notice(`${text} Nothing was submitted.`, 'warning');
    if (!this.config.codeReleaseEnabled) {
      return refuse('Code release is locked for rehearsal. Reply “cancel” or select Stop.');
    }
    if (!this.#vault.hasStaged() || this.#stagedForCardId !== card.id) {
      return refuse('Add the test code in the masked field first.');
    }
    const blocker = this.#submissionBlocker();
    if (blocker) {
      this.#closeCard(card, 'Not submitted');
      return refuse(blocker);
    }
    if (!this.browser || this.browserLost) return refuse('The browser is not available.');

    // The authorization applies only if this exact call is still pending now.
    let session;
    try {
      session = await this.api.retrieveSession(this.sessionId);
    } catch (error) {
      return refuse(`The pending request could not be verified (${describeError(error)}).`);
    }
    const stillPending = (session.required_actions ?? []).some(
      (action) =>
        action.type === 'function_call' &&
        action.name === TOOL.SUBMIT &&
        action.call_id === meta.call.action.call_id &&
        action.turn_id === meta.call.action.turn_id,
    );
    if (!stillPending) {
      refuse('That request is no longer pending.');
      this.#applySession(session);
      return undefined;
    }
    if (this.browser.controller !== 'maya') return refuse('You are controlling the browser. Return control to Maya first.');
    if (this.browser.address() !== meta.address || !this.#onCast(meta.address)) {
      this.#closeCard(card, 'Not submitted');
      refuse('The page changed after the request was made.');
      return this.#deliver(meta.call, {
        success: false,
        error: `The page changed after the request, so nothing was submitted. Observe the page again and, if the empty code form is showing, call ${TOOL.SUBMIT} again.`,
      });
    }

    const submission = {
      id: randomUUID(),
      cardId: card.id,
      turnId: meta.call.action.turn_id,
      callId: meta.call.action.call_id,
      status: 'submitting',
      at: Date.now(),
      outcome: null,
    };
    this.submissions.push(submission);
    if (!this.#persist()) {
      // Without a durable record, a restart could not tell that a code had
      // been submitted, so nothing is typed.
      this.submissions.pop();
      this.#notice(
        'The submission could not be recorded in the recovery journal, so nothing was submitted. The code is still staged in this app.',
        'error',
      );
      return undefined;
    }

    const code = this.#vault.take();
    this.#stagedForCardId = null;
    card.status = 'answered';
    card.outcome = 'Authorized';
    card.codeStaged = false;
    this.#updateEntry(card);
    this.#row(APP, 'submission.authorized', 'Presenter typed “confirm”; the app enters the code and clicks once');
    this.#touch();

    const button = card.buttonLabel || 'the button';
    const step = this.#beginStep(`Entering the test code and selecting “${button}” (done by the app)`);
    try {
      await this.browser.submitCode({ fieldRef: meta.fieldRef, buttonRef: meta.buttonRef, code, expectedAddress: meta.address });
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'not_submitted') {
        submission.status = 'not_submitted';
        card.outcome = 'Not submitted';
        this.#updateEntry(card);
        await this.#endStep(step, 'failed');
        this.#persist();
        this.#row(PLAYWRIGHT, 'submission.not_submitted', 'The code was not entered; the button was not clicked');
        this.#notice(
          `The code could not be entered (${this.#toolError(error)}), so nothing was submitted. The code was cleared from this app.`,
          'warning',
        );
        return this.#deliver(meta.call, {
          success: false,
          error: `The application could not enter the code, so nothing was submitted. Observe the page again and, if the empty code form is showing, call ${TOOL.SUBMIT} again.`,
        });
      }
      // The click may have reached the page: unknown, never retried.
      submission.status = 'submit_unknown';
      submission.outcome = 'unknown';
      this.#persist();
      await this.#endStep(step, 'incomplete', { capture: true });
      this.#row(PLAYWRIGHT, 'submission.uncertain', 'The click did not complete cleanly; not retried');
      this.#setResultCard(submission, {
        outcome: 'unknown',
        detail: 'The app could not confirm that the submit click completed. It was not repeated. Check what CAST shows before any new attempt.',
      });
      return this.#deliver(meta.call, {
        success: true,
        output: `The application tried to submit the code once and could not confirm that the click completed. Do not submit anything. Observe the page and call ${TOOL.REPORT} with what it shows.`,
      });
    }
    submission.status = 'submitted';
    submission.at = Date.now();
    this.turnActive = true;
    this.#persist();
    await this.#endStep(step, 'completed', {
      title: `Entered the test code and selected “${button}” (done by the app)`,
      capture: true,
    });
    this.#row(PLAYWRIGHT, 'submission.done', 'Code entered and button clicked once (value withheld)');
    return this.#deliver(meta.call, {
      success: true,
      output: `The application entered the customer's code and selected the button once. You were not given the code. Do not submit again. Observe the page, then call ${TOOL.REPORT}.`,
    });
  }

  async #declineSubmission(card) {
    const meta = this.#cardMeta.get(card.id);
    this.#unstage(card);
    card.status = 'answered';
    card.outcome = 'Declined by the customer';
    this.#updateEntry(card);
    await this.#deliver(meta.call, {
      success: false,
      error: 'The customer has not authorized a submission. Nothing was submitted. Tell the customer you are stopping here and wait.',
    });
  }

  // ---- Result ----------------------------------------------------------------

  #lastSubmission() {
    const last = this.submissions.at(-1);
    return last && last.status !== 'not_submitted' ? last : null;
  }

  #markUnknownIfSubmitted(detail) {
    const submission = this.#lastSubmission();
    if (!submission || submission.outcome !== null) return;
    submission.outcome = 'unknown';
    this.#persist();
    this.#setResultCard(submission, {
      outcome: 'unknown',
      detail: `${detail}. This is not a failure and not a confirmation. Check CAST before any new attempt.`,
    });
  }

  #setResultCard(submission, fields) {
    let entry = this.timeline.find((item) => item.kind === 'card' && item.submissionId === submission.id);
    if (!entry) {
      entry = this.#addEntry({ kind: 'card', card: 'result', source: APP, status: 'shown', submissionId: submission.id });
    }
    Object.assign(entry, {
      pageMessage: '',
      reference: '',
      address: '',
      evidenceStepId: null,
      detail: '',
      ...fields,
      reportedAt: Date.now(),
    });
    this.#updateEntry(entry);
    this.#row(APP, 'result.presented', `Result shown: ${entry.outcome}`);
    this.#touch();
  }

  async #handleReport(call) {
    const args = parseArguments(call.action.arguments);
    const reported = RESULT_OUTCOMES.includes(args.outcome) ? args.outcome : 'not_confirmed';
    const submission = this.#lastSubmission();
    const read = {
      pageMessage: this.#safe(args.page_message ?? '', 500),
      reference: this.#safe(args.confirmation_reference ?? '', 120),
    };

    if (!submission) {
      // Without a submission by this app, a confirmation cannot be about this run.
      if (reported === 'confirmed') {
        this.#notice(
          'Maya reported a confirmation, but this app has not submitted a code in this session. It is not shown as confirmed.',
          'warning',
        );
        return this.#deliver(call, {
          success: false,
          error: 'The application has not submitted a redemption code in this session, so it cannot present a confirmation. Do not claim success.',
        });
      }
      this.#notice(`Maya reported what the page shows: ${read.pageMessage || 'no message'}`, 'info');
      return this.#deliver(call, { success: true, output: 'Recorded.' });
    }
    if (submission.outcome === 'confirmed') return this.#deliver(call, { success: true, output: 'Already recorded.' });

    // Evidence is what the app itself sees now: the browser's real address and
    // a screenshot the app takes of the page Maya is reporting on.
    const usable = this.browser && !this.browserLost;
    const address = usable ? this.browser.address() : '';
    const onCast = this.#onCast(address);
    let evidence = null;
    if (usable) {
      const step = this.#beginStep('Captured the page for the result (done by the app)');
      await this.#endStep(step, 'completed', { capture: true });
      if (step.hasImage) evidence = step;
      else await this.#endStep(step, 'failed');
    }
    read.address = this.#safe(address, 300);

    if (reported !== 'not_confirmed' && (!onCast || !evidence)) {
      const missing = !onCast
        ? `the browser is not on ${this.config.castOrigin}`
        : 'the app could not capture the page as evidence';
      submission.outcome = 'not_confirmed';
      this.#persist();
      this.#setResultCard(submission, {
        ...read,
        outcome: 'not_confirmed',
        evidenceStepId: evidence?.id ?? null,
        detail: `Maya reported “${reported}”, but ${missing}, so it is not shown as ${reported}.`,
      });
      return this.#deliver(call, {
        success: false,
        error: `The application could not accept this report: ${missing}. Without submitting anything, observe the CAST result page, then call ${TOOL.REPORT} again.`,
      });
    }

    submission.outcome = reported;
    this.#persist();
    if (evidence) this.#pinnedImages.add(evidence.id);
    this.#setResultCard(submission, { ...read, outcome: reported, evidenceStepId: evidence?.id ?? null });
    return this.#deliver(call, {
      success: true,
      output: 'Recorded. Tell the customer the result in one or two short sentences. Do not say any individual AI tool is activated.',
    });
  }

  // ---- Stop and end ----------------------------------------------------------

  /** Cancels the active turn. The session, its history, and the browser stay. */
  stop() {
    return this.#serial(async () => {
      this.#assertOpen();
      if (!this.sessionId) throw new ActionError(409, 'no_session', 'Nothing is running.');
      for (const card of this.#pending('release')) {
        this.#unstage(card);
        this.#updateEntry(card);
      }
      this.browser?.cancelQueued();
      try {
        await this.api.sendEvents(this.sessionId, [{ type: 'agent.session.input.cancel' }]);
        this.#row(APP, 'agent.session.input.cancel', 'Stop requested');
      } catch (error) {
        this.#notice(`Stop could not be delivered (${describeError(error)}). It was not resent.`, 'error');
      }
      this.#touch();
    });
  }

  /** Cancels any active turn, deletes the session, closes the browser, and clears secrets. */
  async end({ force = false } = {}) {
    if (this.ended || this.ending) return;
    const submission = this.#lastSubmission();
    if (!force && submission && submission.outcome !== 'confirmed' && submission.outcome !== 'rejected') {
      throw new ActionError(
        409,
        'outcome_unknown',
        'A code was submitted and its outcome is not confirmed. Ending closes the browser and deletes the session, so neither can be checked afterwards.',
      );
    }
    this.ending = true;
    this.#vault.destroy();
    this.#stagedForCardId = null;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.browser?.cancelQueued();

    if (this.sessionId) {
      if (this.turnActive) {
        try {
          await this.api.sendEvents(this.sessionId, [{ type: 'agent.session.input.cancel' }]);
          this.#row(APP, 'agent.session.input.cancel', 'Cancelling the active turn before deleting the session');
        } catch {
          // Deletion is still attempted below.
        }
        for (let waited = 0; this.turnActive && waited < 8000; waited += 200) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      try {
        await this.api.deleteSession(this.sessionId);
        this.#row(APP, 'session.delete', `DELETE /agents/sessions/${this.sessionId}`);
      } catch (error) {
        this.#notice(
          `The session could not be deleted (${describeError(error)}). Delete ${this.sessionId} from your OpenAI project when convenient.`,
          'warning',
        );
      }
    }
    this.#streamAbort?.abort();
    for (const card of this.#pending()) this.#closeCard(card, 'Session ended');
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.#row(PLAYWRIGHT, 'browser.close', 'Chromium closed; its private context was discarded');
    }
    this.turnActive = false;
    this.connection = 'none';
    this.ended = true;
    this.ending = false;
    this.#persist();
    this.#touch();
    this.#broadcastBrowser({ t: 'state', state: this.browserState() });
  }

  /** Stops timers, the stream, and the browser without touching the remote session. */
  async dispose() {
    this.ending = true;
    this.#streamAbort?.abort();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#vault.destroy();
    await this.browser?.close().catch(() => {});
  }
}
