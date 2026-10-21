# Maya security and deployment gates

This document describes the safeguards in the Sol evaluation build and the controls still required outside the application. It is a deployment gate, not a claim that browser automation is risk-free.

## Implemented application controls

- Every successful password login receives a unique, expiring, server-side session. Logging out revokes only that session.
- Authentication failures are throttled per client and globally. Session creation, messages, browser input, and other mutations also have bounded rates.
- Optional Cloudflare Turnstile is validated server-side before password authentication. Tokens must be fresh, single-use, issued for the configured hostname, and tagged for Maya login.
- Owner cookies are random, HTTP-only, `SameSite=Strict`, time limited, and marked `Secure` when `PUBLIC_HOST` is configured.
- Each customer run has its own non-persistent Chromium context and owner identity. One customer cannot attach to another customer's run or browser stream.
- Sessions close after an idle timeout or maximum lifetime. `outcome_unknown` runs are retained rather than silently discarding an uncertain redemption result.
- Agent navigation is HTTPS-only and allow-listed by exact host or approved domain suffix (`singtel.com` and `gomo.sg`, including subdomains). Redirects are revalidated; suffix matches reject custom ports and lookalike domains. Literal loopback, private, link-local, multicast, and cloud-metadata destinations are blocked outside tests.
- The model cannot read form input values or type arbitrary text. Sign-in is a human takeover, and the redemption code is held by the application rather than sent to the model.
- Code submission is disabled unless `CODE_RELEASE=enabled`; submission requires explicit confirmation and is journaled before the one permitted attempt.
- The container runs as the Playwright image's unprivileged `pwuser` account.

## Required public-pilot settings

1. Serve only through the hosting platform's HTTPS endpoint.
2. Set `PUBLIC_HOST` to the exact public hostname. The app will then reject unexpected Host headers and issue secure cookies.
3. Set `MAYA_ACCESS_PASSWORD` to a newly generated secret of at least 16 characters. Do not reuse the password previously shared in chat, source code, screenshots, or a presentation.
4. Put a Cloudflare-proxied custom domain in front of Railway. Configure a Turnstile widget for that hostname and set both `CLOUDFLARE_TURNSTILE_SITE_KEY` and `CLOUDFLARE_TURNSTILE_SECRET_KEY` in Railway.
5. Add Cloudflare rate-limiting rules for `POST /api/auth/login` and `POST /api/runs`, plus a broader limit for `/api/*`. Use a managed challenge before blocking while tuning thresholds.
6. Keep `CODE_RELEASE` unset until the approved live-redemption window.
7. Keep one application replica. Run state is currently in memory; horizontal scaling needs shared coordination or session-aware routing.
8. Limit the service to the intended audience at the hosting edge when possible, and set budget and usage alerts for both the host and OpenAI project.
9. Send application logs to a restricted central sink. Never record browser frames, OTPs, voucher codes, or customer-entered fields.

Recommended pilot values:

```dotenv
MAYA_MAX_SESSIONS=6
MAYA_SESSION_IDLE_MS=1800000
MAYA_SESSION_MAX_AGE_MS=7200000
MAYA_AUTH_SESSION_TTL_MS=43200000
MAYA_AUTH_MAX_FAILURES=5
MAYA_AUTH_FAILURE_WINDOW_MS=900000
MAYA_AUTH_LOCKOUT_MS=900000
MAYA_MAX_MESSAGES_PER_MINUTE=30
MAYA_MAX_INPUT_REQUESTS_PER_MINUTE=1800
```

## Residual risks before broad production

- A shared password is admission control, not customer identity. Replace it with Singtel SSO/OIDC, named accounts, roles, and audit attribution before a broad launch.
- Application throttles are per process and reset on restart. Use an edge WAF/rate limiter and a shared store such as Redis before running multiple replicas or facing untrusted public traffic.
- Domain-suffix access exposes more pages on those brands to Maya's browser and increases prompt-injection and sensitive-page exposure risk. The task instructions remain restricted to Singtel AI Pass, but this is not a substitute for page-level action policies.
- Hostname allow-listing reduces SSRF risk but is not a complete egress boundary against DNS rebinding or a compromised permitted site. Enforce outbound firewall or proxy rules at the infrastructure layer.
- A permitted web page can contain hostile instructions. The bounded tool surface and app policies limit impact, but prompt-injection and adversarial-page evaluations remain a release requirement.
- CAST completion is inferred from the page. For money-, entitlement-, or voucher-sensitive production use, add a trusted backend confirmation or idempotency key instead of relying only on rendered text.
- Browser frames may expose whatever the customer can see. Do not enable session recording by default, and obtain consent plus retention controls if recording is later introduced.
- Secrets in environment variables still require a managed secret store, access review, rotation, and incident procedures.

## Release checks

- Run `npm test` and confirm all tests pass.
- Run `npm audit --omit=dev` and resolve production dependency findings.
- Build and smoke-test the exact container deployed to the host.
- Exercise two simultaneous customers and verify isolation of chat, stream, cookies, and control.
- Test password lockout, logout, idle expiry, hard session expiry, and capacity rejection.
- Attempt off-list navigation, redirects, private-address access, prompt injection, and repeated submission.
- Rehearse OTP takeover with test data and submission locked.
- Document the owner for disabling the service, rotating secrets, reviewing logs, and resolving an uncertain redemption.

## Incident response

If credentials, customer data, or redemption integrity may be affected: disable the public route, keep `CODE_RELEASE` locked, rotate the access password and OpenAI key, terminate active sessions, preserve restricted diagnostic logs, and involve the designated Singtel security and service owners. Treat an uncertain voucher submission as unresolved until CAST confirms its state; never retry automatically.
