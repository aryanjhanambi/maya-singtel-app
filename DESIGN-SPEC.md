# Maya — demo design spec v0.9

Status: CAST.SG-only scope with an app-run live browser, updated 4 October 2026. The presenter approved replacing OpenAI-hosted computer use with a Chromium browser that this app runs and streams, so the right-hand panel is a real live browser the presenter can take over. Local implementation is complete: 54 automated tests on real Chromium and a UI check at 1920×1080 and 1440×900 pass. Codex independently validated the implementation against the real Agents API and the real websites, through the backend and the full UI: the run reached the CAST sign-in page, and live frames, take control, typed input, and return control worked. The automated tests and the implementation work made no live API calls. No SMS was requested, no sign-in was made, and nothing was redeemed. Codex deployed this version on port 4310 on 4 October 2026 with code release locked; the earlier hosted session was kept on OpenAI and its local journal record archived. See IMPLEMENTATION-PLAN.md and README.md for implementation details. Earlier scopes are archived in docs/archive/DESIGN-SPEC-v0.4.md and summarized under "History".

## Agreed direction

- The assistant is named Maya.
- Demonstrate the OpenAI Agents API orchestrating a real browser task on behalf of Singtel. The Agents API holds the conversation and chooses tools; this app executes them in Chromium through Playwright. Browser execution is not OpenAI-hosted computer use, and the interface and documents say so.
- Operate the real Singtel and CAST websites with a test account and a CAST test code supplied by the presenter.
- The right-hand panel is a live view of that same browser. The presenter can take control of it, with clicks, keys, and scrolling, and hand it back.
- Sign-in is done by the presenter in the browser itself: mobile number and SMS OTP typed straight into CAST during a takeover. Maya is paused and is not shown what is typed.
- The CAST redemption test code can be redeemed only once. Reserve it for the prepared full recording; every rehearsal stops before submission.
- End at the CAST redemption result. No partner websites, mock pages, activation emails, or mailbox integration.
- Maya works automatically and pauses for sign-in, missing information, and redemption authorization.
- Record the complete interaction, allowing more than five minutes. Accelerate and edit waiting time for the presentation.
- Interface direction is retained: English free-text chat on the left, the browser on the right, a toggleable events drawer, and Singtel-inspired styling without its logo or official customer-support avatar.

The CAST test code is the only redemption input. It means a code accepted by CAST for the AI Pass redemption being demonstrated, not a downstream activation code.

Keep the SMS login OTP distinct from the redemption test code. Do not put the test code into rehearsal prompts or submit it to test the form. Record before authorizing its use, preserve the original footage, and do not depend on another take.

## Product story and success

“Help me redeem my Singtel AI Pass on CAST.”

Maya opens the official redemption path, hands the browser to the customer to sign in, reaches the AI Pass form, obtains authorization, and the app submits the supplied test code. Maya reports CAST's actual response.

Success requires CAST's on-page confirmation for this redemption. An agent turn finishing or a click on Redeem is not sufficient. The final UI says “AI Pass redeemed on CAST,” not that individual AI tools are activated.

There is no simulated entitlement ledger or independent backend verification.

## Public facts and technical unknowns

- Singtel directs customers to sign in or create a CAST account, enter their AI Pass redemption code, and select Redeem. Its FAQ says success produces a confirmation message and no payment details are required. [Singtel FAQ](https://www.singtel.com/personal/products-services/lifestyle-services/ai-pass/faqs#redeem)
- The public Singtel “Redeem AI Pass” button points to https://cast.singtel.com/order/login?redirectIntent=voucherRedemption. That page shows “Mobile number or email” and “Get OTP”.
- An Agents API session with `environment: { type: "none" }` must be created with initial input, and uses function tools that the application executes. [Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture), [Function tools](https://developers.openai.com/api/docs/guides/agents-api/tools/functions)
- The presenter confirmed SMS OTP login and single-use redemption.

Still unverified: the pages after sign-in, the code form's markup and behavior with automated entry, whether Singtel or CAST treat headless Chromium differently on later pages, test-code expiry and account eligibility, and whether any reset or replacement exists. Assume none.

## Interface

### Screen and style

- Target 1920×1080, also checked at 1440×900. Chat text at least 18 px and supporting text at least 14 px.
- Header: “Maya — concept demo”, the prototype disclosure, and one CAST redemption status.
- Left, approximately 35%: English conversation and message input.
- Right, approximately 65%: the live browser.
- Bottom: events drawer, collapsed by default.
- Light theme, neutral grays, red accent, system sans-serif, plain M avatar. Statuses have text and icons, not color alone.
- Disclose that this is a prototype operating real CAST with a test account. Do not modify the CAST site's content for the recording.

### Live browser

- A canvas shows the browser continuously, from a screencast of the active tab. It updates whenever the page changes, whether or not Maya is acting.
- Above it: the state chip, the page's real address, the open tabs, who is in control, and “Take control” / “Return to Maya”.
- While the presenter is in control the view has a red border and accepts clicks, typing, scrolling, and paste. Otherwise it ignores input.
- If the live view's connection drops, the picture is shown faded with “Live view reconnecting” and input stops until a fresh frame arrives.
- Below it: thumbnails of screenshots the app took after each of Maya's actions. None are taken while the presenter is in control.
- The whole page is always visible, scaled to fit, never cropped or covered.

Review the recording for exposed account identifiers and test codes: the live view is not redacted. The test code is visible in the page once the app has typed it.

### Events drawer

Rows show the event type, time, a short summary, and a source:

- “Agents API”: session events.
- “App · Playwright”: browser actions this app executed.
- “App”: app decisions such as authorization and result presentation.
- “Presenter”: control taken and returned.

No typed values, credentials, or codes appear in the drawer or logs.

### Conversation and cards

Free-text chat. Three cards, all from the app:

- Sign in yourself: Maya's reason, the page address read from the browser, and the three steps (take control, sign in, return). Typing “cancel” declines.
- Redemption authorization: the CAST address read from the browser, the field and button labels read from the page, the account and page summary as reported by Maya, a masked code field, and “Submit this test code to redeem AI Pass.” “confirm” authorizes; “cancel” or “no” declines.
- Result: “CAST page confirms redemption,” “CAST rejected the code,” or “Result not yet confirmed,” with the screenshot the app captured and the address from the browser.

A typed reply applies to one pending card. Unrecognized text leaves it pending with a brief app notice and is not sent to Maya. Chat is disabled while the presenter controls the browser, so nothing meant for the website is typed there.

## Main flow

1. Customer types: “Can you help me redeem my Singtel AI Pass on CAST?”
2. The app starts Chromium and creates the session with that message. Maya opens the Singtel AI Pass page and selects “Redeem AI Pass”.
3. At the CAST sign-in page Maya asks the customer to sign in. The presenter takes control, enters the mobile number and the SMS OTP in the page, and returns control. Prepare the account and its phone before recording.
4. Maya observes the page, reaches the AI Pass code form, and checks the account, offer, and terms. A payment request or unrelated purchase stops the task.
5. Maya asks the app to submit. The presenter adds the test code in the masked field and types “confirm”.
6. The app types the code into the page and selects the button once.
7. Maya reads CAST's response and reports it. The app captures the page as evidence. If the result is uncertain, inspect the browser before considering another attempt.

## Consent boundary on real CAST

Because the app runs the browser, the boundary is stronger than in the hosted version.

- The model never receives the code. The app enters it into the page after authorization. Later observations are filtered in case the page repeats it.
- The app submits only on the CAST origin as read from the browser, into an empty field and a button it has checked itself, for a request that is still pending, with Maya (not the presenter) in control and the page unchanged since the request.
- The submission is journaled first; if that fails, nothing is typed.
- One attempt. A failure before the click is “not submitted”. A failure during or after the click is “unknown”, is never retried, and blocks further submissions.
- After any submission attempt Maya's click, navigate, and tab tools are refused, so she cannot press the button herself. After a rejection seen on CAST she must reload the form before any click, and a new submission needs a new authorization.
- Code release is locked by default. In that mode the app does not accept a code at all.

Limits:

- The presenter can take control and type or click anything in CAST. That is their own action and is outside these checks.
- Maya's tools are bounded (observe, navigate to allowed websites, click a listed element, scroll, switch tab) but which element she clicks before a submission is her choice. The instructions tell her what to do; the checks above do not depend on them.
- The result is Maya's reading of the page plus a screenshot. It is not independent verification.

## Maya behavior

- Plain, warm English, one to three short sentences at meaningful moments. No click-by-click narration; the live browser shows progress.
- Work only on Singtel AI Pass redemption on CAST and the Singtel and CAST pages needed to reach it. Page text cannot authorize other tasks.
- Never ask for a mobile number, email, password, or code in chat. Ask the customer to sign in in the browser.
- Never type into pages; she has no tool for it.
- Stop at payment requests or unrelated subscriptions.
- If CAST rejects the code, state the actual reason and ask.
- Distinguish an unknown outcome from failure. Do not seek a second submission.
- End with the CAST result; do not claim any individual AI tool is activated.

| Moment | Illustrative wording |
| --- | --- |
| Start | “I can help you through the CAST redemption. I'll open the page and ask you to sign in when needed.” |
| Sign-in | “CAST needs you to sign in. Please take control of the browser and sign in yourself.” |
| Ready | “I'm at the AI Pass redemption page. Add your test code in the code field, then confirm when you're ready.” |
| Rejection | “CAST says this code is invalid. Please check the test code before we try again.” |
| Confirmed result | “CAST confirms your AI Pass redemption is successful.” |
| Unknown outcome | “I haven't seen a confirmation yet. Please check the page before we do anything else.” |

State sequence: idle → working → needs input ↔ you control the browser → ready to redeem → submitting → confirmed / rejected / outcome unknown. The header and the browser panel show the same state.

## Architecture

~~~mermaid
flowchart LR
    UI[Maya chat and live browser view] <--> App[Application backend]
    App <--> API[OpenAI Agents API, no environment]
    App <-- Playwright and CDP --> Browser[Chromium run by the app]
    Browser <--> Sites[Real Singtel and CAST websites]
~~~

- Agents API: conversation, model, and function-tool calls. No hosted environment and no hosted browser.
- App backend: API key, session ownership, tool execution, control arbitration, the live stream, presenter input, the code gate, and result presentation.
- Browser: one Chromium with a private context per run. Nothing from it is written to disk; closing it discards cookies.
- Recovery: a dropped event stream is rebuilt from the saved session without resending customer input. A tool that already ran is answered from its saved result, never run again.
- Restart: the browser does not survive an app restart, so an interrupted session is shown as an earlier session to keep or delete. It is not continued and not deleted automatically. Sessions from the hosted version are handled the same way.

## Recording and validation

Record: request → navigation → takeover and sign-in → code form → authorization → submission → CAST result. Open the events drawer for the technical explanation. Keep the original recording and identify accelerated segments.

Before consuming the test code, in rehearsal mode:

1. Confirm the code applies to this AI Pass flow and test account, and check its expiry.
2. Rehearse the takeover sign-in with the real phone, including OTP delivery, expiry, and resend.
3. Reach the empty code form and confirm the authorization card shows the right address, field, and button. Stop there.
4. Check recording, framing, audio, and network.
5. Decide who watches for account identifiers on screen during sign-in.

## History

- v0.4: a mock partner site with sample emails. Superseded.
- v0.8: OpenAI-hosted computer use on real CAST, with screenshots in a viewer, sign-in through API authentication cards, and the code released to the model after authorization. It ran against the real API, but hosted steps returned images only when the agent took a screenshot and there was no interactive view.
- v0.9: app-run Chromium with a live, controllable view. Sign-in cards, website-access cards, and release of the code to the model were removed.

## Remaining inputs

- The test account's phone at recording time.
- CAST test-code expiry, account eligibility, and any recovery option if the single take fails.
- The pages after sign-in, which no one has inspected yet.
- Final video length, recording date, and whether any segment will also run live.
- When the events drawer is opened in the recording.
