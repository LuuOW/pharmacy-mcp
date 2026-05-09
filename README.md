# pharmacy-mcp

MCP for **Farmacias del Pueblo** (Argentine VTEX storefront). Lets your AI
host search the catalog, build a cart over time, and hand the cart off to
your browser for the final login + payment.

Live at **https://botica.ask-meridian.uk** — tools at `/mcp`.

## What it actually does

VTEX gates every authentication endpoint behind reCAPTCHA Enterprise v3 with
**server-side hostname enforcement** — Google issues the token, but VTEX's
backend rejects tokens that weren't generated on `www.farmaciasdelpueblo.com.ar`.
We confirmed this empirically (the worker forwards a real 2233-char token,
VTEX returns `200 {}` and silently drops the email). Without a real browser
running on the pharmacy's own origin, server-side login isn't reachable.

So the MCP runs in **anonymous-cart mode**:

1. Search the catalog (public API, no auth needed).
2. Add items to an anonymous orderForm the worker keeps in KV.
3. When you're ready, `prepare_checkout` returns a `/checkout/cart/add` URL —
   open it in your browser, the pharmacy adds those SKUs to your real cart and
   routes you to checkout. You finish login + payment in the place where they
   already work (your browser, your captcha, your saved cards).

You keep ~95% of the AI value — chat-driven search, recommendations, cart
building over multiple sessions, "buy what I bought last time" — without
needing a Browserbase-class headless browser to fight reCAPTCHA.

## Tools

| Tool | What it does |
|---|---|
| `search_products(query, limit)` | Search the catalog (Spanish queries work best) |
| `get_categories()` | Top-level category tree |
| `browse_category(category_id, limit, page)` | List a category |
| `view_cart()` | Current cart with items, totals, shipping options |
| `add_to_cart(sku_id, quantity)` | Add a SKU |
| `remove_from_cart(item_index)` | Remove by index (0-based, see `view_cart`) |
| `update_cart_item(item_index, quantity)` | Change qty (0 removes) |
| `clear_cart()` | Empty the cart (drops the stored orderForm) |
| `set_shipping_address(postal_code, country)` | Set ZIP for delivery quote |
| `get_shipping_options()` | Available delivery options + prices |
| `prepare_checkout()` | Returns the `/checkout/cart/add` URL for the browser hand-off |
| `auth_status()` | Reports whether the (currently dormant) server-side VTEX session is active |

## Use it

In Grok / Claude.ai / ChatGPT connector settings, add a custom MCP:

- **MCP URL:** `https://botica.ask-meridian.uk/mcp`
- **Auth:** OAuth 2.1 + PKCE. The host discovers
  `/.well-known/oauth-authorization-server` and walks through `/authorize`.
- **Client ID:** any non-empty string (we only check presence)
- **Client Secret:** *empty* — PKCE replaces it
- **Scopes:** `pharmacy_cart`
- **Token Auth Method:** `none (PKCE only)`

Once authorized, the public tools work immediately. Cart tools work
immediately too (anonymous orderForm). No `/login` step needed in this mode.

## Deploy from scratch

```sh
cd pharmacy-mcp
npm install
wrangler kv namespace create PHARMACY_KV
# paste the printed id into wrangler.toml under [[kv_namespaces]]
wrangler deploy
```

To bind a custom domain, the `routes = [{ pattern = "...", custom_domain = true }]`
block in `wrangler.toml` is honored on a clean deploy. Wrangler 3.114 has been
seen to silently skip it; if so, attach manually via the API:

```sh
ZONE_ID=$(curl -sH "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=<your-zone>" \
  | jq -r '.result[0].id')
curl -X PUT -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT_ID/workers/domains" \
  -d '{"environment":"production","hostname":"botica.<zone>","service":"pharmacy-mcp","zone_id":"'$ZONE_ID'"}'
```

## Environment

Set in `wrangler.toml` under `[vars]`:

| Var | What |
|---|---|
| `ISSUER` | Public URL of this worker (used in OAuth metadata) |
| `VTEX_ACCOUNT` | `farmaciasdelpueblo` |
| `VTEX_HOST` | `www.farmaciasdelpueblo.com.ar` |
| `RECAPTCHA_SITE_KEY` | `6LdV7CIpAAAAAPUrHXWlFArQ5hSiNQJk6Ja-vcYM` (public — extracted from the site's HTML) |

Optional secret via `wrangler secret put`:

| Secret | What |
|---|---|
| `ALLOWED_EMAIL` | Currently unused (auth path is dormant). Was meant to pin `/login` to a single email so a stranger couldn't register-via-our-worker. Re-becomes relevant once the auth path is re-enabled. |

## What's still in the codebase but dormant

`/login`, `/api/auth/send`, `/api/auth/validate`, the captcha JS in
`src/login.html`, the cron-based session refresher in `src/index.mjs`, and
`startAuthFlow / sendAccessKey / validateAccessKey / refreshAuthCookie` in
`src/vtex.mjs` are all kept in-tree on purpose. They wired up cleanly and are
shaped correctly for VTEX's REST auth — they just can't pass the captcha
hostname check from this origin. If you ever route the login dance through a
real browser running on `www.farmaciasdelpueblo.com.ar` (Browserbase, an
extension, or a stealth Playwright on Fly), this code is the consumer side
already in place. See "Future: Browserbase mode" below.

## Future: Browserbase mode

To unlock the full original architecture (server-side authenticated cart
operations, saved-card payments, automated re-orders), the missing piece is a
real browser running on the pharmacy's own origin. Sketch:

1. Browserbase / Playwright spawns a session at
   `https://www.farmaciasdelpueblo.com.ar/login`.
2. It runs the same access-key flow as a human would — captcha is solved by
   Google in the browser context, hostname matches.
3. After validating the 6-digit code, the resulting `VtexIdclientAutCookie`
   gets exfiltrated and POSTed to `/api/auth/import-cookie` (a small new
   endpoint we'd add).
4. Worker stores it in KV. Cron `/api/vtexid/refreshtoken/webstore` keeps it
   alive.
5. The cart tools flip from "anonymous orderForm + browser hand-off" to
   "authenticated orderForm + server-side checkout submit".

Cost: ~$10–30/mo for Browserbase or ~$5/mo for a small Fly Playwright sidecar.
Until that's worth building, the anonymous-cart mode is the right shape.

## File layout

```
src/
  index.mjs      Worker entry — routes, OAuth, MCP, dormant /login, cron
  vtex.mjs       VTEX REST client (catalog + anonymous cart + shipping; auth funcs dormant)
  tools.mjs      MCP tool definitions and dispatch
  login.html     Dormant: was the browser-mediated login; kept for Browserbase re-enable
wrangler.toml    CF Worker config (KV, cron, custom domain, vars)
package.json
```

## Why this design instead of a real headless-browser stack today

A pharmacy MCP I'll use weekly-ish from my phone doesn't justify
$30/mo + Browserbase maintenance. The hand-off pattern leaves one tap-to-pay
in my browser anyway (Argentine 3-D Secure on first card use after a fresh
session), so "fully automated" was an illusion of value beyond what the
hand-off already gives. If I find myself wishing the cart auto-checked-out
weekly without me, that's the moment to build Browserbase mode.
