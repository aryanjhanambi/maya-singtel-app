# Cloudflare protection for Maya on Railway

Cloudflare should sit in front of a custom Maya hostname, while Railway continues to run the application. Turnstile protects the password gate; edge rate limits reject abusive requests before they consume Railway or OpenAI capacity. Maya's own throttles remain enabled as a second layer.

## 1. Connect a custom hostname

1. Add your domain to Cloudflare and use Cloudflare's nameservers.
2. In Railway, open the Maya service, then **Settings → Networking → Public Networking → Custom Domain**.
3. Enter a dedicated hostname such as `maya.example.com` and choose the application port.
4. Add Railway's required CNAME and TXT records in Cloudflare DNS. Both records are required. Keep the application CNAME proxied (orange cloud); follow Railway's displayed value exactly.
5. Wait until Railway shows the domain as verified and reports that the Cloudflare proxy was detected.
6. Set Railway `PUBLIC_HOST=maya.example.com`. Do not include `https://` or a path.

Use the custom hostname for the pilot. If the Railway-generated hostname remains public, it bypasses Cloudflare's edge rules; remove it after the custom hostname is verified if your Railway setup permits that without disrupting the custom domain.

## 2. Add Turnstile

1. In Cloudflare, open **Turnstile** and create a widget for the exact Maya hostname.
2. Use Managed mode.
3. Copy the site key and secret key into Railway:

```dotenv
CLOUDFLARE_TURNSTILE_SITE_KEY=<public site key>
CLOUDFLARE_TURNSTILE_SECRET_KEY=<server-only secret key>
```

4. Redeploy Maya. The login page should now show a human-verification widget. A missing, expired, reused, wrong-host, or wrong-action token fails closed.
5. Never put the secret key in GitHub, frontend code, screenshots, or chat.

## 3. Add initial rate limits

Create rate-limiting rules under Cloudflare **Security → Security rules → Rate limiting rules**. Start with a Managed Challenge while observing legitimate pilot traffic, then block clearly abusive patterns.

Suggested starting scopes:

| Purpose | Match | Initial threshold | Action |
| --- | --- | --- | --- |
| Password attempts | `POST /api/auth/login` | 5 per minute per IP | Managed Challenge |
| New agent/browser sessions | `POST /api/runs` | 5 per 10 minutes per IP | Managed Challenge |
| Messages that can invoke the model | POST path ending in `/messages` under `/api/runs/` | 30 per minute per IP | Managed Challenge |

Do not apply a low blanket limit to all `/api/` traffic: browser takeover sends frequent input events and the live view uses long-lived streams. Keep Maya's application limits enabled even after edge rules are active.

## 4. Additional Cloudflare controls

- Enable the managed WAF rules available on your plan.
- Turn on bot protection appropriate to the plan, but test it with corporate VPNs and shared office networks to avoid blocking legitimate users.
- Restrict countries or networks only if that matches the pilot audience.
- Review Security Events and Turnstile token-validation analytics during the pilot.
- Configure OpenAI project budgets and alerts. Cloudflare reduces abusive traffic but cannot guarantee a fixed API bill.

## 5. Verification checklist

- The custom hostname is orange-cloud proxied and Railway shows it as verified.
- `PUBLIC_HOST` exactly matches the browser hostname.
- The login page shows Turnstile and rejects login if its token is omitted.
- Reusing a submitted token fails.
- The three rate-limit rules trigger without breaking normal chat, browser streams, or takeover.
- The old Railway hostname is not an unprotected alternate route.
- `CODE_RELEASE` remains unset during this security test.
