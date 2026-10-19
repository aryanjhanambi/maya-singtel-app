
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
