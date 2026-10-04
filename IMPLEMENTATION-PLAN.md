# Maya demo — implementation plan

Current as of the migration approved on 4 October 2026: Maya now works in a Chromium browser that this app runs with Playwright and streams live. The earlier OpenAI-hosted `computer_use` version is described under "History" and is no longer what the code does.

## Constraints carried through every milestone

- The CAST redemption test code is single use. No real code is obtained, entered, or submitted during implementation, tests, or rehearsal. No redemption is performed.
- No SMS is triggered and no sign-in is attempted during development.
- No fake live path. Without an API key the app shows a setup state and does nothing else.
- No mock CAST, Singtel, or partner pages. Automated tests use a generic local page that is labelled as a dev test page.
- The API key and `.env` are not read or printed by the implementation work. Neither it nor the automated tests call the real Agents API. Live API calls were made only by Codex's independent validation probes, on public pages, stopping at the CAST sign-in page.
- No push, no public deployment. The server binds to 127.0.0.1. The implementation work did not restart the server on port 4310; Codex did, as the deployment step.

## Architecture

```
Browser UI  <-- SSE + JSON -->  App server (127.0.0.1)  <-- REST + SSE -->  OpenAI Agents API (no environment)
                                     |
                                     +-- Playwright --> Chromium (one private context) --> singtel.com / cast.singtel.com
```

- The Agents API orchestrates: it holds the conversation and decides which tool to call. The session has `environment: { type: "none" }` and only function tools.
- This app executes every browser action. It owns one Chromium context per run through Playwright. Browser execution is not OpenAI-hosted `computer_use`, and the UI and README say so.
- The live view is the same browser: CDP `Page.startScreencast` frames from the active tab, sent to the UI over SSE independently of model turns.
- Exactly one party controls the browser at a time: Maya, through bounded tools, or the presenter, through the live view. The backend enforces this.

## Agents API integration

### Verified

From the documentation (sessions, events and items, function tools, architecture) and from Codex's independent live probes on 4 October 2026:

- `POST /v1/agents/sessions` with `environment: { type: "none" }` requires initial input. Creating one without input returns HTTP 400 "conversation-only sessions currently require initial input". The probe confirmed that top-level `input: [{ role: "user", content: [{ type: "input_text", text }] }]` creates and runs the session.
- Function tools are declared in `agent.tools` as `{ type: "function", name, description, parameters }`.
- A pending call appears in the session's `required_actions` as `{ type: "function_call", turn_id, call_id, name, arguments }`, announced by `agent.session.requires_action`.
- The result is returned with `agent.session.input.tool_result` carrying `turn_id`, `call_id`, `success`, and `output` (a string; JSON is serialized) or `error`. The probe confirmed a JSON-string result is accepted and the model continues.
- If a function already ran, its saved result is resubmitted with the same `turn_id` and `call_id`; the function is not run again.
- Function-tool results are visible to the model and saved in session history.
- Streams do not replay missed events. After opening a stream, the app retrieves the session and its saved items to catch up.
- Follow-up messages, cancel (`agent.session.input.cancel`), retrieve, list items, and delete are unchanged from the earlier version.

### Session start

1. Launch Chromium and its context. If that fails, no session is created.
2. `POST /agents/sessions` with the first customer message as `input`.
3. Open the event stream.
4. Reconcile: retrieve the session and saved items, and act on current `required_actions`. This covers a tool call made before the stream opened.

### Assumptions to confirm with a real run

1. The model uses the tools in the intended order and stops at the pause points. This is cooperative; the gates below do not depend on it.
2. Singtel and CAST serve headless Chromium the same pages as a normal browser. Codex's probe loaded the public CAST login page in this Chromium. `BROWSER_HEADLESS=false` is available if needed.
3. A function call can stay pending for the minutes a human sign-in takes. No timeout is documented.
4. CAST's code form works with Playwright's `fill` and a single click.

## Browser session (`server/browser.js`)

- One Chromium, one non-persistent context, viewport 1280×800. Nothing from the context is written to disk; closing it discards cookies.
- Tabs: a new tab opened by a page becomes the active tab, up to four tabs; further popups are closed. If the active tab closes, the most recent remaining tab becomes active.
- Screencast: JPEG frames from the active tab; restarted when the active tab changes. The latest frame is kept in memory for new viewers. Frames are never stored on disk, logged, or sent to the model.
- Loss: a crashed page or disconnected browser marks the session lost. Tools then fail with a clear error, the UI says the browser closed, and nothing is relaunched silently.
- Dialogs are dismissed, downloads are refused.

### Tools Maya can call

All are function tools executed by this app. There is no tool that runs JavaScript, types text, or reads form values.

| Tool | Bounds |
| --- | --- |
| `browser_observe` | Returns the address, title, tab list, a capped text excerpt, and up to 120 visible interactive elements with short references. Never includes the value of any input. Refused on a website outside the allow-list. |
| `browser_navigate(url)` | HTTPS only, host must be on the allow-list (`www.singtel.com`, `cast.singtel.com`, plus `ALLOWED_HOSTS`). |
| `browser_click(ref)` | `ref` must come from the latest observation of the active tab and still be attached. Refused outside the allow-list. |
| `browser_scroll(direction)` | `up` or `down`, one viewport step. |
| `browser_switch_tab(tab_id)` | Must be an open tab. |
| `request_customer_login(reason)` | Asks the presenter to take control and sign in. Returns only that control came back. |
| `request_redemption_submission(code_field_ref, submit_button_ref, account_context, page_summary, payment_requested)` | Asks the app to enter and submit the code. See "Code gate". |
| `report_redemption_result(outcome, page_message, confirmation_reference)` | See "Result evidence". |

### Control arbitration

- States: Maya in control, or the presenter in control.
- Take control: queued Maya tools wait; the action already in flight finishes first; then presenter input is accepted.
- While the presenter is in control: no Maya tool runs, no observation is taken, and nothing about the page or the input is sent to the model, stored, or logged. Chat is refused so a code is not typed there by mistake.
- Return to Maya: presenter input is refused again and queued tools resume. A pending `request_customer_login` is answered with "control returned" and no detail.
- Presenter input (`move`, `down`, `up`, `wheel`, `key`, `text`) is validated: coordinates clamped to the viewport, buttons and keys from fixed lists, bounded batch and text sizes.

## Code gate

The model never receives the code. The app enters it into the page itself.

`request_redemption_submission` opens the authorization card only if:

1. `payment_requested` is exactly `false`.
2. No earlier submission in this run has an outcome other than a seen rejection.
3. The active tab's real address, read from the browser, is on the CAST origin.
4. Both references resolve in the latest observation: an empty, enabled text field and an enabled button.

The app submits only if, at the moment the presenter types "confirm":

5. Code release is armed (`CODE_RELEASE=enabled`); the default is locked.
6. A code is staged for this card, and the reply is bound to this card.
7. The call is still pending on a fresh fetch of the session.
8. Maya, not the presenter, controls the browser; the active tab's address is unchanged; the field is still empty.
9. The submission is written to the journal first. If that write fails, nothing is entered.

Then the app fills the field, checks it took the value, and clicks the button once.

- A failure before the click is "not submitted"; the field is cleared and a new request may be authorized.
- A failure during or after the click is "submission unknown". It is never retried and blocks any further submission in the run.
- The tool result says only that the app entered the code and selected the button. Later observations pass through redaction in case the page echoes the code.

Limit, stated in the UI and README: the presenter can always take control and type into CAST directly. That is their own action and is outside this gate.

## Result evidence

- "CAST page confirms redemption" needs a submission in this run, a `confirmed` report, the active tab's real address on the CAST origin, and a screenshot the app itself captures at that moment.
- A missing screenshot or a page outside CAST gives "Result not yet confirmed".
- A turn that ends after a submission without a report gives "Result not yet confirmed". Turn completion is never success.
- The card states that the reading is Maya's and is not independently verified.

## Sessions from before, and restarts

- The journal records an `engine` for each run. Records without one are from the hosted-browser version.
- An open record that is not live in this process is never attached to Chromium and never deleted automatically. The UI shows it as a previous session with its ID and any submission bookkeeping, and offers two explicit choices: keep it and dismiss the notice, or delete it on OpenAI.
- A new run cannot start until that notice is resolved.
- After an app restart, the browser of an earlier run is gone, so that run is shown the same way: it cannot be continued, and it is not deleted.

## UI

- Left: conversation, cards, notices, message box. Unchanged in style.
- Right: "Live browser". A canvas shows the screencast. Above it: the real address and title, the tab list, the control state, and "Take control" / "Return to Maya". While the presenter controls, the canvas takes clicks, keys, scrolling, and paste. Below it: thumbnails of screenshots the app took after each of Maya's actions.
- Events drawer sources: "Agents API" for session events, "App · Playwright" for browser actions this app executed, "App" for app decisions, "Presenter" for control changes. No input values appear anywhere.

## Files

```
server/
  index.js         entry point
  config.js        environment parsing; browser and allow-list settings
  agents-api.js    REST client; createSession now carries initial input
  sse.js           text/event-stream parser
  browser.js       Chromium session: tabs, screencast, bounded actions, control, presenter input
  tools.js         function-tool definitions and argument validation
  instructions.js  Maya's instructions and the session request
  replies.js       exact typed-reply matcher
  secrets.js       staged-code vault and redaction
  summarize.js     allow-listed event summaries
  run.js           run controller: session, tool execution, cards, gates, result
  store.js         journal with engine marker and previous-session lookup
  http.js          routes, ownership, UI stream, browser stream, control, input
public/            UI
test/
  fixtures/agents-api-fixture.js   scripted local Agents API
  fixtures/dev-site.js             generic dev test page server
  *.test.js
scripts/
  ui-fixture.js    labelled UI harness: fixture API plus real Chromium on the dev test page
  ui-check.js      drives the harness UI in Chrome, including live-view input
```

## Milestones

- [x] P0 Verify documentation and the initial-input constraint; update this plan.
- [x] P1 Dependencies: `playwright-core` is a runtime dependency; Chromium present.
- [x] P2 `browser.js` and the dev test page, with 14 tests in real Chromium.
- [x] P3 Tools, instructions, and the rewritten run controller, with 25 tests.
- [x] P4 HTTP: browser stream, control, input, previous-session handling, with 4 tests.
- [x] P5 UI: live view, control, input capture, updated cards and labels.
- [x] P6 UI harness and visual check on the dev test page, at 1920×1080 and 1440×900.
- [x] P7 README, DESIGN-SPEC (v0.9), and this plan brought up to date.

Validation and deployment, 4 October 2026:

- Independent validation by Codex against the real Agents API: a session created with initial input and a function-tool round trip; the real model driving navigate, observe, and click from the Singtel page to the CAST sign-in page and then asking for sign-in; and, through the backend and the full UI, live frames, owner-only access, take control, typed input into the CAST field (deleted again, without requesting an OTP), and return control. Temporary sessions were deleted.
- Codex restarted the server on port 4310 with this version: configured, real endpoint, code release locked, UI checked at 1440 and 1920 wide with no page errors.
- The earlier hosted session was kept on OpenAI. Its local journal record was archived, with a backup at `.data/runs.before-chromium-migration.json`, so a new session can start.
- No SMS was requested, no sign-in was made, no code was released, and nothing was redeemed, by anyone.

## Tests

Real Chromium against a local page titled "Dev test page — not CAST, not Singtel". No test contacts OpenAI, Singtel, or CAST.

- Streaming: frames arrive and keep arriving as the page changes, with no tool call involved.
- Input mapping: a click at mapped coordinates, typed keys, inserted text, and wheel scrolling reach the page.
- Arbitration: presenter input is refused while Maya controls; Maya's tools wait while the presenter controls; take control waits for the action in flight.
- Observation: no input values; stale and unknown references refused; redaction applied; websites outside the allow-list refused.
- Tabs: a new tab becomes active and is listed; switching works.
- Cleanup and loss: closing ends the context and stream; a killed browser is reported, not hidden.
- Session start: the create request carries initial input, `environment.type` is `none`, and only function tools are sent; an early tool call is picked up by reconcile.
- Code gate: every condition above, including locked default, wrong origin, changed page, presenter in control, journal failure, and exactly one click.
- The code never appears in any request to the Agents API, the view, the journal, or the logs.
- Unknown outcome: a failure at the click blocks any further submission.
- Result: app-captured evidence and real address required.
- Previous sessions: a hosted-era or restarted record is not attached, not deleted, and blocks a new run until resolved.
- HTTP: owner cookie and same-origin checks on the browser stream, control, and input routes.

## Changes made during review

- Screencast start is retried briefly: Chromium refuses it while a tab is between pages. Tab activations are serialized and actions wait for one in progress.
- App-side page operations (screenshots, checking the form, submitting) run in the same queue as Maya's actions and are refused if a takeover began first, so a takeover cannot start midway through a fill and click.
- Presenter input is applied strictly in order and drained before control returns. Held buttons and keys are tracked on the server and released on request, on loss of focus, when the live view drops, and when control returns.
- After any submission attempt Maya's click, navigate, and tab-switch tools are refused. Previously only the submit tool was gated, which left a plain click on the same button open. After a rejection seen on CAST she must navigate to reload the form before clicking.
- A tool result whose delivery failed ambiguously is offered again on a bounded re-check of the session; the action itself is never repeated.
- The UI tracks the live-view stream separately from the app stream. When only the live view drops, the picture is marked stale and presenter input stops until a fresh frame arrives.
- The pending "release everything" signal is kept apart from the ordinary input queue, so it survives the queue being cleared and is sent after any request in flight.

## Unresolved real checks

1. Maya's tool use and pause points with the real model.
2. The real CAST sign-in through takeover, including SMS delivery, and the page after sign-in.
3. The post-login path to the AI Pass code form and the form's markup.
4. Whether Singtel or CAST treat headless Chromium differently.
5. The single recorded take with `CODE_RELEASE=enabled`.

## History

Version 1 used OpenAI-hosted `computer_use` with screenshots in a viewer. It worked against the real API, but hosted steps returned images only when the agent explicitly took a screenshot, and the API offers no interactive view. The presenter approved replacing browser execution with app-run Chromium for a real live view and human takeover. Sign-in cards, origin approval cards, and release of the code to the model were removed with it.
