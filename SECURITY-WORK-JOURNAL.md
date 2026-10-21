
## Changes made

### 5 October 2026 — Prepared Maya to run online

- Added production settings for the public website address and secure browser cookies.
- Set up the app to run in a container with its own Chromium browser.
- Limited which websites Maya's AI can visit, helping prevent it from being sent to unrelated or private sites.
- Added basic time limits for sessions and limits on how many sessions can run at once.

### 5 October 2026 — Separated users' browser sessions

- Maya can support up to six separate browser sessions at the same time by default.
- Each person gets a separate browser and session identity, so one person should not see or control another person's browser.
- The app still needs to run as one server instance for this protection to work as designed. Supporting multiple server instances needs shared session tracking first.

### 6 October 2026 — Added a password gate

- Added a password page before people can use Maya.
- Login sessions expire, and repeated incorrect password attempts are temporarily blocked.
- The password is shared, so it does not identify each person individually. The password previously used during development was shared in conversation and should be replaced before a wider pilot.

### 19 October 2026 — Hardened the public app

- Added limits on repeated login attempts, chat messages, browser input, and other requests. These limits help slow abuse and runaway usage.
- Restricted browser automation to approved secure websites and blocked local, private-network, and cloud-control addresses.
- Added protections against unexpected website addresses and unsafe redirects.
- Kept sign-in details in the browser. Maya's AI is not given password or OTP field values.
- Kept voucher codes in the app, not in the AI conversation. Voucher submission is off by default and requires a deliberate confirmation when enabled.
- Recorded a voucher attempt before submission and designed the app not to repeat a submission if the result is uncertain.
- Configured the container to run with fewer system privileges.

### 19 October 2026 — Added Cloudflare's human check

- Added Cloudflare Turnstile to the login page to make automated sign-ins harder.
- The server checks each challenge result with Cloudflare; a browser-only check would not be enough.
- Turnstile checks are tied to the configured website and cannot be reused.
- The user confirmed the Cloudflare setup was working after deployment.

### 20 October 2026 — Strengthened Maya's safety instructions

- Added clearer rules telling Maya to treat website text, screenshots, and tool results as information to inspect, not directions to obey. This helps resist attempts hidden in a page that tell Maya to ignore its rules or reveal private information.
- Added a direct refusal for requests to demean, exclude, or target people based on protected traits. Maya is told to answer exactly: “I can't help you with that request” and not suggest a workaround.
- These instructions add protection, but AI instructions alone cannot guarantee that a model will always resist every attack. Website restrictions and the app's existing limits on what actions Maya can take remain important safeguards.

### 20 October 2026 — Broader sensitive-topic guardrails requested

- Requested follow-up work: add strong safeguards for terrorism and violence, racism, sexism, xenophobia, homophobia, and other discriminatory or hateful conduct.
- This broader work is not yet complete. The current safety instructions are an initial layer, not a comprehensive policy or a guarantee that every harmful request will be handled correctly.
- The planned guardrails should block assistance that enables violence or terrorism, or promotes, targets, demeans, or excludes people based on protected traits, while still allowing appropriate educational, historical, prevention, news, and support conversations.
- The work should also test repeated pressure, role-play, encoded or indirect requests, and malicious instructions embedded in webpages or other content; ensure the assistant does not invoke browser actions or other tools to carry out a disallowed request; and record what was tested and any known limitations.

### 20 October 2026 — Added a guard against deliberate credit-wasting loops

- Maya now recognizes clear requests to repeat page trips several times or indefinitely, and refuses them before sending the message to the AI service. This avoids paying for an AI response to an explicitly wasteful request.
- The browser controller also allows at most four page navigations for one customer message, as a backstop if a repetitive loop is phrased indirectly or the AI tries to continue one.
- The guard is intentionally narrow: ordinary questions about usage and the normal Singtel AI Pass journey are still allowed. It is not a substitute for account-level spending limits, traffic controls, or monitoring.

### 21 October 2026 — Allowed approved Singtel and GOMO domains without listing every page

- Maya's browser may now use HTTPS pages on `singtel.com` and `gomo.sg`, including subdomains such as the hi! app's `hiapp.singtel.com`. This avoids maintaining a separate URL for every page.
- Matching is limited to the actual domain boundary, rejects lookalike names and custom ports, and still applies the existing HTTPS and private-address checks.
- Maya's task instructions remain limited to the Singtel AI Pass journey. The broader page access can still expose more website text to the assistant, so prompt-injection testing and infrastructure egress controls remain important.
