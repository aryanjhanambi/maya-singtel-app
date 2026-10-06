// Maya demo UI. It holds no secrets: it renders the sanitized view the app
// server sends, shows the live browser the app runs, and posts the
// presenter's input back to the app.

const $ = (id) => document.getElementById(id);

// Set to false to show the browser alongside the welcome chat immediately.
const WELCOME_CHAT_LAYOUT = true;

const ICONS = {
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
};

// state -> [label, tone, icon]
const STATES = {
  setup: ['Setup needed', 'attention', 'alert'],
  idle: ['Idle', 'neutral', 'dot'],
  starting: ['Starting browser and session', 'active', 'spinner'],
  working: ['Working', 'active', 'spinner'],
  needs_input: ['Needs input', 'attention', 'user'],
  human_control: ['You control the browser', 'attention', 'user'],
  ready_to_redeem: ['Ready to redeem', 'attention', 'key'],
  submitting: ['Submitting', 'active', 'spinner'],
  confirmed: ['Confirmed on CAST page', 'success', 'check'],
  rejected: ['Rejected by CAST', 'attention', 'x'],
  outcome_unknown: ['Outcome unknown', 'attention', 'question'],
  cancelled: ['Stopped', 'neutral', 'stop'],
  failed: ['Session failed', 'attention', 'alert'],
  browser_lost: ['Browser closed unexpectedly', 'attention', 'alert'],
  ended: ['Session ended', 'neutral', 'stop'],
};

const RESULT_TITLES = {
  confirmed: ['CAST page confirms redemption', 'check'],
  rejected: ['CAST rejected the code', 'x'],
  not_confirmed: ['Result not yet confirmed', 'question'],
  unknown: ['Result not yet confirmed', 'question'],
};

// Kept for the hidden activity log so event rendering remains safe.
const SOURCE_TAGS = { 'Agents API': 'tag-api', 'App · Playwright': 'tag-pw', Presenter: 'tag-human' };

const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Control', 'Alt', 'Meta',
]);
const MOUSE_BUTTONS = ['left', 'middle', 'right'];
const VIEWPORT = { width: 1280, height: 800 };

const app = {
  config: null,
  runId: null,
  status: null,
  previous: null,
  entries: new Map(),
  entryNodes: new Map(),
  entryJson: new Map(),
  steps: new Map(),
  stepOrder: [],
  thumbs: new Map(),
  eventCount: 0,
  source: null,
  frames: null,
  frameSeq: 0,
  hasFrame: false,
  // The live-view stream: none, connecting, open, or retrying. It is "fresh"
  // once a frame has arrived since it last opened.
  frameStream: 'none',
  frameFresh: false,
  buttonsDown: new Set(),
  // The UI's own event stream from the app server: none, connecting, open, or retrying.
  stream: 'none',
  sending: false,
  // Whether the conversation is following its newest entry.
  pinned: true,
  // Presenter input waiting to be sent, in order.
  input: [],
  inputBusy: false,
  // A "let go of everything" owed to the app. Kept apart from ordinary input
  // so it survives the queue being cleared and is sent even without control.
  releasePending: false,
};

// ---- Small helpers ---------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'data') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function icon(name, className = '') {
  const span = el('span', { class: `${className}${name === 'spinner' ? ' spin' : ''}`.trim(), 'aria-hidden': 'true' });
  // Static markup from the table above; never page or model content.
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

/** True while the UI has a run but its stream from the app server is down. */
const appOffline = () => Boolean(app.runId) && app.stream === 'retrying';

async function api(method, path, body) {
  // What is on screen may be stale while the stream is down, so nothing that
  // acts on a run is sent until it is back.
  if (method !== 'GET' && path.startsWith('/api/runs/') && app.stream !== 'open') {
    throw new Error('The connection to the app is down, so nothing was sent. It reconnects by itself.');
  }
  const response = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Maya-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? 'The app could not complete that.');
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

const runPath = (suffix) => `/api/runs/${app.runId}/${suffix}`;
const imageUrl = (step) => runPath(`steps/${encodeURIComponent(step.id)}/image?rev=${step.imageRev}`);
const clock = (at) => new Date(at).toLocaleTimeString('en-GB');

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

function hostOf(address) {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

function showError(message) {
  const node = $('composer-error');
  node.textContent = message;
  node.hidden = !message;
}

const report = (failure) => showError(failure.message);

// ---- Status, header, composer ------------------------------------------------

function currentState() {
  if (!app.config?.configured) return 'setup';
  return app.status?.state ?? 'idle';
}

const browserOf = () => app.status?.browser ?? { running: false, controller: 'maya', humanReady: false, address: '', tabs: [] };
/** True while what the live view shows may be out of date. */
const viewStale = () => browserOf().running && (app.frameStream !== 'open' || !app.frameFresh);
// Input is forwarded only when the presenter has control and is looking at a current picture.
const inControl = () =>
  browserOf().running && browserOf().controller === 'human' && browserOf().humanReady && !appOffline() && !viewStale();

function renderStatus() {
  const state = currentState();
  const offline = appOffline();
  // While the app stream is down the last known state may be stale, so the
  // status says so instead of repeating it.
  const [label, tone, iconName] = offline
    ? ['Reconnecting to the app', 'attention', 'spinner']
    : (STATES[state] ?? STATES.idle);
  $('status').dataset.tone = tone;
  $('status-value').textContent = label;
  $('status-icon').replaceChildren(icon(iconName));

  const connection = app.status?.connection;
  const connectionText = offline
    ? 'App connection lost · reconnecting'
    : connection === 'recovering'
      ? 'Reconnecting to the session'
      : connection === 'lost'
        ? 'Session connection lost'
        : connection === 'connecting'
          ? 'Connecting'
          : '';
  $('connection').hidden = !connectionText;
  $('connection').textContent = connectionText;
  $('reconnect').hidden = connection !== 'lost';
  $('reconnect').disabled = offline;

  const closed = state === 'ended' || state === 'setup';
  $('stop').disabled = offline || closed || state === 'failed' || !app.status?.sessionId;
  $('end').disabled = offline || closed || !app.runId;
  // Cards cannot be answered while what they show may be out of date.
  $('timeline').inert = offline;

  renderPresentationLayout();

  // The browser panel repeats the same state in its own row.
  const waiting = !offline && (state === 'needs_input' || state === 'ready_to_redeem');
  const panelState = $('browser-state');
  panelState.className = `chip chip-state${tone === 'attention' ? ' chip-warning' : tone === 'success' ? ' chip-success' : ''}`;
  panelState.replaceChildren(icon(iconName), waiting ? `${label} · Waiting for you in the chat` : label);

  renderBrowser();
  renderComposer();
  refreshActivityLabels();
}

/** Starts with a focused welcome, then makes the browser the main stage. */
function renderPresentationLayout() {
  const welcome = WELCOME_CHAT_LAYOUT && !app.runId && !app.previous;
  document.body.classList.toggle('welcome-layout', welcome);
}

function renderComposer() {
  const state = currentState();
  const status = app.status;
  let disabled = false;
  let placeholder = 'Ask Maya anything…';
  if (appOffline()) {
    disabled = true;
    placeholder = 'Reconnecting to the app…';
  } else if (state === 'setup') {
    disabled = true;
    placeholder = 'Add an API key to start';
  } else if (app.previous) {
    disabled = true;
    placeholder = 'Resolve the earlier session above first';
  } else if (state === 'ended' || state === 'failed' || state === 'browser_lost') {
    disabled = true;
    placeholder = state === 'ended' ? 'This session has ended' : 'This session cannot continue. End it to start again.';
  } else if (state === 'human_control') {
    disabled = true;
    placeholder = 'Return control to Maya to chat.';
  } else if (status?.activeCardId) {
    const card = app.entries.get(status.activeCardId);
    placeholder =
      card?.card === 'release' ? 'Type “confirm” to authorize, or “cancel”' : 'Take control above the browser, or type “cancel”';
  }
  $('message').disabled = disabled;
  $('message').placeholder = placeholder;
  $('send').disabled = disabled || app.sending;
  $('new-session').hidden = state !== 'ended';
}

// ---- Live browser ------------------------------------------------------------

function renderBrowser() {
  const state = currentState();
  const browser = browserOf();
  const offline = appOffline();
  const live = browser.running && app.hasFrame;
  const canvas = $('live');
  const empty = $('viewer-empty');
  canvas.hidden = !live;
  empty.hidden = live;
  if (!live) {
    const [title, text] =
      state === 'setup'
        ? ['Getting ready', 'Maya is preparing your AI Pass journey.']
        : state === 'ended'
          ? ['Browser closed', 'The browser closed with the session and its private data was discarded.']
          : browser.lost
            ? ['Browser closed unexpectedly', 'It was not replaced. End the session when ready.']
            : browser.running
              ? ['Starting the live view', 'Waiting for the first frame from the browser.']
              : ['Your browser appears here', 'Maya will guide you through each step, and you can take control whenever needed.'];
    empty.replaceChildren(el('strong', { text: title }), text);
  }

  const human = browser.controller === 'human';
  const stale = viewStale() && app.hasFrame;
  $('viewer').dataset.control = inControl() ? 'human' : 'maya';
  $('viewer').dataset.stale = String(stale);
  canvas.tabIndex = inControl() ? 0 : -1;
  const controller = $('controller');
  controller.hidden = !browser.running;
  controller.className = `chip${human || stale ? ' chip-warning' : ''}`;
  controller.textContent = stale
    ? 'Live view reconnecting…'
    : human
      ? browser.humanReady
        ? 'You are controlling the browser'
        : 'Handing over…'
      : 'Maya is controlling the browser';
  $('take-control').hidden = !browser.running || human;
  $('take-control').disabled = offline;
  const activeCard = app.status?.activeCardId ? app.entries.get(app.status.activeCardId) : null;
  $('take-control').classList.toggle(
    'attention-pulse',
    !human && activeCard?.card === 'takeover' && activeCard.status === 'pending',
  );
  $('return-control').hidden = !browser.running || !human;
  $('return-control').disabled = offline;

  $('address').textContent = browser.running ? browser.address : '';
  $('address').title = browser.running ? browser.address : '';
  $('tabs').replaceChildren(
    ...(browser.tabs.length > 1
      ? browser.tabs.map((tab, index) =>
          el('span', { class: `chip${tab.active ? ' tab-active' : ''}`, title: tab.address, text: `Tab ${index + 1} · ${hostOf(tab.address) || 'blank'}` }),
        )
      : []),
  );
  $('allowed').textContent = '';
  if (!inControl()) {
    app.input.length = 0;
    app.buttonsDown.clear();
  }
}

async function drawFrame(message) {
  const bytes = Uint8Array.from(atob(message.d), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  // Decoding is asynchronous: an older frame must not overwrite a newer one.
  if (message.seq < app.frameSeq) return bitmap.close();
  app.frameSeq = message.seq;
  $('live').getContext('2d').drawImage(bitmap, 0, 0, VIEWPORT.width, VIEWPORT.height);
  bitmap.close();
  if (!app.hasFrame || !app.frameFresh) {
    app.hasFrame = true;
    app.frameFresh = true;
    renderBrowser();
  }
}

function openFrames() {
  app.frames?.close();
  const frames = new EventSource(runPath('browser/stream'));
  app.frames = frames;
  app.frameStream = 'connecting';
  app.frameFresh = false;
  frames.onopen = () => {
    if (app.frames !== frames) return;
    // Open again, but not current until a frame arrives on this connection.
    app.frameStream = 'open';
    app.frameFresh = false;
    renderBrowser();
  };
  frames.onerror = () => {
    if (app.frames !== frames) return;
    // The picture may now be behind the real page, so input stops until the
    // stream is back and has delivered a frame. Anything held is let go.
    releaseHeld();
    app.frameStream = 'retrying';
    app.frameFresh = false;
    renderBrowser();
  };
  frames.onmessage = (event) => {
    if (app.frames !== frames) return;
    const message = JSON.parse(event.data);
    if (message.t === 'frame') void drawFrame(message).catch(() => {});
  };
}

/**
 * Tells the app to let go of anything the presenter is still holding down.
 * Ordinary input not yet sent is dropped: it was meant for a view that is no
 * longer current or focused.
 */
function releaseHeld() {
  if (!app.runId || browserOf().controller !== 'human') return;
  app.buttonsDown.clear();
  app.input.length = 0;
  app.releasePending = true;
  void pumpInput();
}

async function setControl(action) {
  showError('');
  try {
    await api('POST', runPath('browser/control'), { action });
    if (action === 'take') $('live').focus();
    else $('message').focus();
  } catch (failure) {
    report(failure);
  }
}

/** Maps a pointer position on the scaled canvas to a position in the page. */
function pagePoint(event) {
  const box = $('live').getBoundingClientRect();
  const scale = Math.min(box.width / VIEWPORT.width, box.height / VIEWPORT.height);
  const left = box.left + (box.width - VIEWPORT.width * scale) / 2;
  const top = box.top + (box.height - VIEWPORT.height * scale) / 2;
  return {
    x: Math.round(Math.min(VIEWPORT.width, Math.max(0, (event.clientX - left) / scale))),
    y: Math.round(Math.min(VIEWPORT.height, Math.max(0, (event.clientY - top) / scale))),
  };
}

/** Queues presenter input and sends it in order. It is never kept or shown. */
function sendInput(event) {
  if (!inControl()) return;
  const last = app.input.at(-1);
  if (event.t === 'move' && last?.t === 'move') app.input[app.input.length - 1] = event;
  else app.input.push(event);
  void pumpInput();
}

async function pumpInput() {
  if (app.inputBusy) return;
  app.inputBusy = true;
  try {
    for (;;) {
      if (app.releasePending) {
        // Sent by itself, after any request already in flight, and whether or
        // not the presenter can currently use the view.
        app.releasePending = false;
        await api('POST', runPath('browser/input'), { events: [{ t: 'release' }] }).catch((failure) => {
          // Not delivered because the app is unreachable: still owed.
          if (failure.code === undefined) app.releasePending = browserOf().controller === 'human';
        });
        if (app.releasePending) break;
        continue;
      }
      if (app.input.length === 0 || !inControl()) break;
      await api('POST', runPath('browser/input'), { events: app.input.splice(0, 48) });
    }
  } catch (failure) {
    app.input.length = 0;
    if (failure.code !== 'not_in_control') report(failure);
  } finally {
    app.inputBusy = false;
  }
}

function bindLiveInput() {
  const canvas = $('live');
  const guard = (handler) => (event) => {
    if (!inControl()) return;
    event.preventDefault();
    handler(event);
  };
  // Pointer capture keeps a drag attached to the canvas, so a button released
  // outside it is still reported and never left held down in the page.
  canvas.addEventListener('pointermove', guard((event) => sendInput({ t: 'move', ...pagePoint(event) })));
  canvas.addEventListener(
    'pointerdown',
    guard((event) => {
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      const button = MOUSE_BUTTONS[event.button] ?? 'left';
      app.buttonsDown.add(button);
      sendInput({ t: 'down', ...pagePoint(event), button });
    }),
  );
  canvas.addEventListener('pointerup', (event) => {
    const button = MOUSE_BUTTONS[event.button] ?? 'left';
    if (!app.buttonsDown.delete(button)) return;
    event.preventDefault();
    sendInput({ t: 'up', ...pagePoint(event), button });
  });
  canvas.addEventListener('pointercancel', releaseHeld);
  canvas.addEventListener('lostpointercapture', () => {
    if (app.buttonsDown.size > 0) releaseHeld();
  });
  canvas.addEventListener('blur', releaseHeld);
  window.addEventListener('blur', releaseHeld);
  canvas.addEventListener('contextmenu', guard(() => {}));
  canvas.addEventListener('wheel', guard((event) => sendInput({ t: 'wheel', ...pagePoint(event), dx: event.deltaX, dy: event.deltaY })), { passive: false });

  const key = (action) => (event) => {
    if (!inControl() || event.isComposing) return;
    // Paste is handled by the paste event, as text.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
    if (!NAMED_KEYS.has(event.key) && [...event.key].length !== 1) return;
    event.preventDefault();
    sendInput({ t: 'key', a: action, key: event.key });
  };
  canvas.addEventListener('keydown', key('down'));
  canvas.addEventListener('keyup', key('up'));
  canvas.addEventListener('paste', guard((event) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (text) sendInput({ t: 'text', text: text.slice(0, 2000) });
  }));
  canvas.addEventListener('compositionend', (event) => {
    if (inControl() && event.data) sendInput({ t: 'text', text: event.data });
  });
}

// ---- Timeline ----------------------------------------------------------------

function nearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
}

/** Keeps the newest entry in view unless the presenter has scrolled up. */
function followTimeline(force = false) {
  if (!force && !app.pinned) return;
  const timeline = $('timeline');
  timeline.scrollTop = timeline.scrollHeight;
  app.pinned = true;
}

function previousCard(previous) {
  const hosted = previous.engine === 'hosted_browser';
  const resolve = async (action) => {
    showError('');
    try {
      await api('POST', `/api/previous/${encodeURIComponent(previous.id)}`, { action });
      await loadCurrent();
    } catch (failure) {
      report(failure);
    }
  };
  return el(
    'div',
    { class: 'card', id: 'previous', data: { status: 'pending', card: 'previous' } },
    el('div', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon('info')), el('h3', { class: 'card-title', text: 'An earlier session is still open' }), el('span', { class: 'tag tag-app', text: 'App' })),
    el(
      'div',
      { class: 'card-body' },
      el('p', {
        text: hosted
          ? 'This session was started by the earlier version of this app, which used an OpenAI-hosted browser. This version cannot continue it.'
          : 'The app was restarted. That session’s browser closed with the app, so it cannot be continued.',
      }),
      el('div', { class: 'destination', text: previous.sessionId }),
      el('p', { class: 'card-muted', text: `Started ${new Date(previous.createdAt).toLocaleString('en-GB')}. It is still open on OpenAI and has not been deleted.` }),
      previous.codeUsed &&
        el('p', { class: 'callout', text: `A test code was used in that session. Recorded outcome: ${previous.outcome}. Check CAST directly before any new attempt.` }),
      el(
        'div',
        { class: 'card-actions' },
        el('button', { class: 'button', type: 'button', text: 'Keep it and dismiss', onclick: () => void resolve('dismiss') }),
        el('button', { class: 'button', type: 'button', text: 'Delete it on OpenAI', onclick: () => void resolve('delete') }),
      ),
    ),
  );
}

function renderIntro() {
  const timeline = $('timeline');
  if (!app.config?.configured) {
    timeline.replaceChildren(
      el(
        'div',
        { class: 'intro setup', id: 'intro' },
        el('strong', { text: 'Setup needed' }),
        el('p', {}, 'No OpenAI API key is configured. Add ', el('code', { text: 'OPENAI_API_KEY' }), ' to ', el('code', { text: '.env' }), ' and restart the app.'),
        el('p', { text: 'Nothing is simulated: without a key this app does not contact OpenAI, Singtel, or CAST, and it starts no browser.' }),
      ),
    );
    return;
  }
  timeline.replaceChildren(
    ...[
      app.previous && previousCard(app.previous),
      !app.previous &&
        el(
          'div', { class: 'welcome-card', id: 'intro' },
          el('img', { class: 'welcome-avatar', src: '/assets/maya-avatar.png', alt: '' }),
          el('div', { class: 'welcome-copy' },
            el('span', { class: 'eyebrow', text: 'HELLO THERE' }),
            el('strong', { text: 'I’m Maya, your Singtel assistant.' }),
            el('p', { text: 'I’m here to help with your questions, services, and everyday needs.' }),
            el('p', { class: 'welcome-hint', text: 'Ask me anything to get started.' }),
          ),
        ),
    ].filter(Boolean),
  );
}

function createEntryNode(entry) {
  switch (entry.kind) {
    case 'customer':
      return el('div', { class: 'row row-customer' }, el('div', { class: 'bubble bubble-customer', text: entry.text }));
    case 'maya':
      return el(
        'div',
        { class: 'row' },
        el('span', { class: 'avatar avatar-image', 'aria-hidden': 'true' },
          el('img', { src: '/assets/maya-avatar.png', alt: '' }),
        ),
        el('div', { class: 'bubble bubble-maya', text: entry.text }),
      );
    case 'notice':
      return el(
        'div',
        { class: 'notice', data: { tone: entry.tone } },
        icon(entry.tone === 'info' ? 'info' : 'alert', 'notice-icon'),
        el('span', { class: 'notice-text', text: entry.text }),
        el('span', { class: 'tag tag-app', text: 'App' }),
      );
    case 'activity': {
      const node = el('details', { class: 'activity' }, el('summary'), el('ol'));
      renderActivity(node, entry);
      return node;
    }
    case 'card':
      return createCard(entry);
    default:
      return el('div');
  }
}

function updateEntryNode(node, entry) {
  if (entry.kind === 'customer' || entry.kind === 'maya') node.querySelector('.bubble').textContent = entry.text;
  else if (entry.kind === 'notice') node.querySelector('.notice-text').textContent = entry.text;
  else if (entry.kind === 'activity') renderActivity(node, entry);
  else if (entry.kind === 'card') syncCard(node, entry);
}

function upsertEntry(entry) {
  const serialized = JSON.stringify(entry);
  if (app.entryJson.get(entry.id) === serialized) return;
  app.entryJson.set(entry.id, serialized);
  app.entries.set(entry.id, entry);

  let node = app.entryNodes.get(entry.id);
  const isNew = !node;
  if (node) {
    updateEntryNode(node, entry);
  } else {
    $('intro')?.remove();
    node = createEntryNode(entry);
    app.entryNodes.set(entry.id, node);
    $('timeline').append(node);
  }
  refreshActivityLabels();
  renderComposer();
  // A new request for the presenter is always brought into view.
  followTimeline(isNew && entry.kind === 'card' && entry.status === 'pending');
}

function renderActivity(node, entry) {
  const steps = entry.stepIds.map((id) => app.steps.get(id)).filter(Boolean);
  const isLatest = [...app.entries.values()].at(-1)?.id === entry.id;
  const working = isLatest && app.status?.turnActive && app.status?.browser?.controller !== 'human';
  const count = `${entry.stepIds.length} step${entry.stepIds.length === 1 ? '' : 's'}`;
  node.querySelector('summary').replaceChildren(
    icon(working ? 'spinner' : 'browser', 'activity-icon'),
    working ? 'Maya is getting things ready' : 'Journey progress',
  );
  node.querySelector('ol').replaceChildren(
    ...steps.map((step) => el('li', { text: `${step.title}${step.status === 'completed' ? '' : ` (${step.status.replace('_', ' ')})`}` })),
  );
}

function refreshActivityLabels() {
  for (const [id, node] of app.entryNodes) {
    const entry = app.entries.get(id);
    if (entry?.kind === 'activity') renderActivity(node, entry);
  }
}

// ---- Cards -------------------------------------------------------------------

function replyHint(...parts) {
  return el(
    'p',
    { class: 'replies' },
    parts.map((part) => (Array.isArray(part) ? el('span', { class: 'reply-word', text: part[0] }) : part)),
  );
}

function outcomeLine(text) {
  return el('p', { class: 'card-outcome' }, icon('info'), text ?? 'No longer pending');
}

function createCard(entry) {
  const titles = { takeover: ['Sign in yourself', 'user'], release: ['Redemption authorization', 'key'] };
  const [title, iconName] = titles[entry.card] ?? RESULT_TITLES[entry.outcome] ?? ['Request', 'info'];
  const node = el(
    'div',
    { class: 'card', data: { card: entry.card } },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: 'card-icon' }, icon(iconName)),
      el('h3', { class: 'card-title', text: title }),
    ),
    el('div', { class: 'card-body' }),
  );
  syncCard(node, entry);
  return node;
}

function syncCard(node, entry) {
  node.dataset.status = entry.status;
  const body = node.querySelector('.card-body');
  if (entry.card === 'takeover') body.replaceChildren(...takeoverBody(entry));
  else if (entry.card === 'release') body.replaceChildren(...releaseBody(entry));
  else if (entry.card === 'result') syncResult(node, body, entry);
}

function takeoverBody(entry) {
  const parts = [
    entry.reason && el('p', { text: entry.reason }),
    el('p', { class: 'card-muted', text: 'You’ll complete this step securely in the browser.' }),
  ];
  if (entry.status !== 'pending') return [...parts, outcomeLine(entry.outcome)].filter(Boolean);
  return [
    ...parts,
    el(
      'ol',
      { class: 'steps-list' },
      el('li', {}, 'Select ', el('strong', { text: 'Take control' }), ' above the browser.'),
      el('li', { text: 'Sign in or enter your code directly on the page.' }),
      el('li', {}, 'Select ', el('strong', { text: 'Return to Maya' }), '.'),
    ),
    replyHint('Or type', ['cancel'], 'to decline.'),
    el('p', {
      class: 'provenance',
      text: 'While you have control, Maya waits. Your details stay in the browser and are not shared in this chat.',
    }),
  ].filter(Boolean);
}

function releaseBody(entry) {
  const facts = el(
    'dl',
    { class: 'facts' },
    el('dt', { text: 'Website' }),
    el('dd', {}, el('strong', { text: `CAST · ${hostOf(entry.website)}` }), el('div', { class: 'reported', text: `Address in the browser: ${entry.address}` })),
    el('dt', { text: 'Form' }),
    el('dd', {}, `Field “${entry.fieldLabel || 'unnamed'}”, button “${entry.buttonLabel || 'unnamed'}”`, el('span', { class: 'reported', text: ' (read from the page by this app)' })),
    el('dt', { text: 'Account' }),
    el('dd', {}, entry.accountContext || 'Not shown on the page', entry.accountContext && el('span', { class: 'reported', text: ' (reported by Maya)' })),
    el('dt', { text: 'Item' }),
    el('dd', { text: 'Singtel AI Pass' }),
    entry.pageSummary && el('dt', { text: 'Page' }),
    entry.pageSummary && el('dd', {}, entry.pageSummary, el('span', { class: 'reported', text: ' (reported by Maya)' })),
  );

  if (entry.status !== 'pending') return [facts, outcomeLine(entry.outcome)];

  if (entry.locked) {
    return [
      facts,
      el('p', { class: 'callout' }, 'Code submission is unavailable for this session.'),
      replyHint('Reply', ['cancel'], 'to tell Maya to stop here, or select Stop.'),
    ];
  }

  const codeArea = entry.codeStaged
    ? el(
        'div',
        { class: 'field' },
        el('span', { class: 'card-muted', text: 'Test code (held in this app, not yet entered)' }),
        el(
          'div',
          { class: 'field-row' },
          el('span', { class: 'destination masked', text: entry.maskedReference }),
          el('button', { class: 'button', type: 'button', text: 'Clear', onclick: () => api('DELETE', runPath(`cards/${entry.id}/code`)).catch(report) }),
        ),
      )
    : codeField(entry);

  return [
    facts,
    codeArea,
    el('p', { class: 'statement', text: 'Submit this test code to redeem AI Pass.' }),
    replyHint('Type', ['confirm'], 'to authorize, or', ['cancel'], '.'),
    el('p', {
      class: 'provenance',
      text: 'After you confirm, this app types the code into the page and selects the button once. Maya’s model is never given the code. The code will be visible in the live browser.',
    }),
  ];
}

function codeField(entry) {
  const id = `${entry.id}-code`;
  const input = el('input', {
    id,
    type: 'password',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'data-1p-ignore': true,
    'data-lpignore': 'true',
  });
  const add = async () => {
    const code = input.value;
    input.value = '';
    showError('');
    try {
      await api('PUT', runPath(`cards/${entry.id}/code`), { code });
    } catch (failure) {
      report(failure);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void add();
    }
  });
  return el(
    'div',
    { class: 'field' },
    el('label', { for: id, text: 'CAST test code' }),
    el('div', { class: 'field-row' }, input, el('button', { class: 'button', type: 'button', text: 'Add code', onclick: () => void add() })),
    el('span', { class: 'card-muted', text: 'The code stays in this app, masked, until you authorize it.' }),
  );
}

function syncResult(node, body, entry) {
  const [title, iconName] = RESULT_TITLES[entry.outcome] ?? RESULT_TITLES.unknown;
  node.dataset.outcome = entry.outcome;
  node.querySelector('.card-title').textContent = title;
  node.querySelector('.card-icon').replaceChildren(icon(iconName));

  const step = entry.evidenceStepId ? app.steps.get(entry.evidenceStepId) : null;
  const evidence =
    step && step.hasImage
      ? el(
          'div',
          { class: 'evidence' },
          el('img', {
            src: imageUrl(step),
            alt: 'Screenshot of the page, taken by this app as evidence',
            onclick: () => openLightbox(imageUrl(step)),
            onload: () => followTimeline(),
          }),
          el(
            'div',
            { class: 'evidence-actions' },
            el('span', { text: 'Screenshot taken by this app when Maya reported' }),
            entry.address && el('span', { class: 'reported', text: entry.address }),
            el('a', { href: `${imageUrl(step)}&download=1`, text: 'Download screenshot' }),
          ),
        )
      : el('p', { class: 'card-muted', text: 'No screenshot evidence is attached.' });

  body.replaceChildren(
    ...[
      entry.outcome === 'confirmed' && el('p', { class: 'statement', text: 'AI Pass redeemed on CAST' }),
      entry.detail && el('p', { text: entry.detail }),
      entry.pageMessage && el('p', { class: 'card-muted', text: 'Text on the CAST page, as read by Maya' }),
      entry.pageMessage && el('blockquote', { class: 'quote', text: entry.pageMessage }),
      entry.reference && el('p', {}, 'Reference shown on the page: ', el('strong', { text: entry.reference })),
      evidence,
      el('p', {
        class: 'provenance',
        text: 'This is Maya’s reading of the CAST page. It is not independently verified by this app or by any backend.',
      }),
    ].filter(Boolean),
  );
}

// ---- Steps and thumbnails --------------------------------------------------------

function upsertStep(step) {
  const isNew = !app.steps.has(step.id);
  app.steps.set(step.id, step);
  if (isNew) app.stepOrder.push(step.id);

  if (step.hasImage) {
    let thumb = app.thumbs.get(step.id);
    if (!thumb) {
      thumb = el('button', { class: 'thumb', type: 'button', onclick: () => openLightbox(imageUrl(app.steps.get(step.id))) });
      app.thumbs.set(step.id, thumb);
      const strip = $('filmstrip');
      strip.append(thumb);
      strip.scrollLeft = strip.scrollWidth;
    }
    thumb.title = `Step ${step.n}: ${step.title}`;
    thumb.setAttribute('aria-label', thumb.title);
    thumb.replaceChildren(el('img', { src: imageUrl(step), alt: '', loading: 'lazy' }), el('span', { class: 'thumb-number', text: String(step.n) }));
  }

  const latest = app.steps.get(app.stepOrder.at(-1));
  $('caption-main').replaceChildren(
    el('strong', { text: `Step ${latest.n}` }),
    `${latest.title}${latest.status === 'completed' ? '' : ` · ${latest.status.replace('_', ' ')}`} · `,
    el('span', { class: 'age', data: { at: latest.at }, text: ago(latest.at) }),
  );

  refreshActivityLabels();
  // A result card may be waiting for its evidence step to arrive.
  for (const [id, entry] of app.entries) {
    if (entry.card === 'result' && entry.evidenceStepId === step.id) syncCard(app.entryNodes.get(id), entry);
  }
}

function openLightbox(url) {
  $('lightbox-image').src = url;
  $('lightbox').hidden = false;
}

function closeLightbox() {
  $('lightbox').hidden = true;
}

// ---- Events drawer -----------------------------------------------------------

function addEventRow(row) {
  const body = $('drawer-body');
  const stick = nearBottom(body);
  $('event-rows').append(
    el(
      'tr',
      {},
      el('td', { class: 'event-time', text: clock(row.at) }),
      el('td', {}, el('span', { class: `tag ${SOURCE_TAGS[row.source] ?? 'tag-app'}`, text: row.source })),
      el('td', { class: 'event-type', text: row.type }),
      el('td', { text: row.summary }),
    ),
  );
  app.eventCount += 1;
  $('event-count').textContent = String(app.eventCount);
  if (stick) body.scrollTop = body.scrollHeight;
}

function toggleDrawer() {
  const body = $('drawer-body');
  body.hidden = !body.hidden;
  $('drawer-toggle').setAttribute('aria-expanded', String(!body.hidden));
  $('drawer-arrow').textContent = body.hidden ? '▸' : '▾';
  if (!body.hidden) body.scrollTop = body.scrollHeight;
  // Opening the drawer shortens the conversation area.
  followTimeline();
}

// ---- Run lifecycle -------------------------------------------------------------

function resetView() {
  app.source?.close();
  app.frames?.close();
  app.source = null;
  app.frames = null;
  app.stream = 'none';
  app.runId = null;
  app.status = null;
  app.entries.clear();
  app.entryNodes.clear();
  app.entryJson.clear();
  app.steps.clear();
  app.stepOrder = [];
  app.thumbs.clear();
  app.eventCount = 0;
  app.frameSeq = 0;
  app.hasFrame = false;
  app.frameStream = 'none';
  app.frameFresh = false;
  app.buttonsDown.clear();
  app.input.length = 0;
  app.releasePending = false;
  app.pinned = true;
  $('filmstrip').replaceChildren();
  $('event-rows').replaceChildren();
  $('event-count').textContent = '0';
  $('caption-main').replaceChildren();
  showError('');
}

function applySnapshot(view) {
  app.status = view.status;
  for (const step of view.steps) upsertStep(step);
  for (const entry of view.timeline) upsertEntry(entry);
  $('event-rows').replaceChildren();
  app.eventCount = 0;
  for (const row of view.events) addEventRow(row);
  renderStatus();
}

function handleOp(op) {
  if (op.op === 'snapshot') applySnapshot(op.view);
  else if (op.op === 'status') {
    app.status = op.status;
    renderStatus();
  } else if (op.op === 'entry') upsertEntry(op.entry);
  else if (op.op === 'step') upsertStep(op.step);
  else if (op.op === 'event') addEventRow(op.row);
}

/** Opens the run's stream. Resolves once it is open. */
function openStream() {
  app.source?.close();
  const source = new EventSource(runPath('stream'));
  app.source = source;
  app.stream = 'connecting';
  const opened = new Promise((resolve, reject) => {
    source.onopen = () => {
      if (app.source !== source) return;
      app.stream = 'open';
      renderStatus();
      // A release that could not be sent while the app was unreachable goes now.
      void pumpInput();
      resolve();
    };
    source.onerror = () => {
      if (app.source !== source) return;
      // The browser retries a dropped stream by itself; until it reopens the
      // UI shows that it is disconnected and holds back every action.
      app.stream = 'retrying';
      renderStatus();
      if (source.readyState === EventSource.CLOSED) {
        // Refused outright: the app may have restarted. Ask it what is open.
        reject(new Error('The app did not open the session stream.'));
        setTimeout(() => void loadCurrent().catch(() => {}), 2000);
      }
    };
  });
  opened.catch(() => {});
  source.onmessage = (message) => {
    if (app.source === source) handleOp(JSON.parse(message.data));
  };
  return opened;
}

function attach(view) {
  resetView();
  app.runId = view.id;
  $('timeline').replaceChildren();
  applySnapshot(view);
  openFrames();
  return openStream();
}

/** Asks the app what is open for this browser: a live run, or an earlier session to resolve. */
async function loadCurrent() {
  const { run, previous } = await api('GET', '/api/runs/current');
  app.previous = previous ?? null;
  if (run) return attach(run).catch(() => {});
  resetView();
  renderIntro();
  renderStatus();
  return undefined;
}

// ---- Presenter actions ---------------------------------------------------------

function autosize() {
  const box = $('message');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight + 2, 140)}px`;
}

async function sendMessage() {
  const box = $('message');
  const text = box.value.trim();
  // One send at a time, so a fast double Enter cannot create two runs.
  if (!text || box.disabled || app.sending) return;
  app.sending = true;
  showError('');
  box.value = '';
  autosize();
  renderComposer();
  try {
    if (!app.runId) {
      const { run } = await api('POST', '/api/runs', {});
      await attach(run);
    }
    await api('POST', runPath('messages'), { text, replyTo: app.status?.activeCardId ?? undefined });
  } catch (failure) {
    report(failure);
    // Give the draft back unless the presenter has already typed something else.
    if (!box.value) {
      box.value = text;
      autosize();
    }
  } finally {
    app.sending = false;
    renderComposer();
  }
}

async function endSession() {
  showError('');
  try {
    await api('POST', runPath('end'), {});
  } catch (failure) {
    if (failure.code !== 'outcome_unknown') return report(failure);
    if (!window.confirm(`${failure.message}\n\nEnd the session anyway?`)) return undefined;
    try {
      await api('POST', runPath('end'), { force: true });
    } catch (second) {
      report(second);
    }
  }
  return undefined;
}

function bind() {
  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage();
  });
  $('message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  });
  $('message').addEventListener('input', autosize);
  $('stop').addEventListener('click', () => api('POST', runPath('stop'), {}).catch(report));
  $('end').addEventListener('click', () => void endSession());
  $('reconnect').addEventListener('click', () => api('POST', runPath('reconnect'), {}).catch(report));
  $('take-control').addEventListener('click', () => void setControl('take'));
  $('return-control').addEventListener('click', () => void setControl('return'));
  $('new-session').addEventListener('click', () => void loadCurrent().then(() => $('message').focus()));
  $('timeline').addEventListener('scroll', () => {
    app.pinned = nearBottom($('timeline'));
  });
  window.addEventListener('resize', () => followTimeline());
  $('drawer-toggle').addEventListener('click', toggleDrawer);
  $('lightbox').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !inControl()) closeLightbox();
  });
  bindLiveInput();

  // Ages tick once a second.
  setInterval(() => {
    for (const node of document.querySelectorAll('.age')) node.textContent = ago(Number(node.dataset.at));
  }, 1000);
}

async function init() {
  bind();
  try {
    app.config = await api('GET', '/api/config');
  } catch {
    showError('The app server is not responding. Check that it is running, then reload.');
    return;
  }
  $('fixture-banner').hidden = !app.config.fixture;
  if (app.config.codeRelease === 'locked') {
    $('release-lock').replaceChildren(icon('lock'), 'Secure redemption');
    $('release-lock').hidden = false;
  }
  renderIntro();
  renderStatus();
  if (app.config.configured) await loadCurrent();
}

void init();
