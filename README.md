# pharmacy-mcp

MCP for Farmacias del Pueblo (Argentine VTEX storefront). Browser-mediated
reCAPTCHA bootstrap, headless cart automation thereafter.

## How it works

VTEX gates every auth endpoint behind reCAPTCHA Enterprise v3 — unsolvable
server-side. The trick this MCP uses:

1. **The browser solves the captcha.** A static page at `/login` loads the
   pharmacy's reCAPTCHA Enterprise script with the right site key and asks
   `grecaptcha.enterprise.execute()` for a fresh action token.
2. **The token is posted to the worker**, which forwards to VTEX's REST auth
   endpoints from server-side. Crucially, the resulting `VtexIdclientAutCookie`
   is bound to the **worker's** IP, not the user's — so the worker can keep
   using it indefinitely.
3. **A cron refreshes the session** every 6 hours via VTEX's
   `/api/vtexid/refreshtoken/webstore`, so the user never has to log in again
   (until the refresh-token chain itself expires, typically ~30 days).

The browser is only required for the one-time login. After that the MCP runs
fully headless — search, cart, address, shipping. Final payment still happens
via a browser deeplink (`prepare_checkout`) because Argentine card payments
require 3-D Secure that's hard to automate cleanly.

## Tools

| Tool | Auth? | What it does |
|---|---|---|
| `search_products(query, limit)` | no | Search the catalog |
| `get_categories()` | no | Top categories |
| `browse_category(category_id, limit, page)` | no | List a category |
| `view_cart()` | yes | Current cart with totals + payment options |
| `add_to_cart(sku_id, quantity)` | yes | Add a SKU |
| `remove_from_cart(item_index)` | yes | Remove by index |
| `update_cart_item(item_index, quantity)` | yes | Change qty (0 removes) |
| `set_shipping_address(postal_code, country)` | yes | Set ZIP for delivery quote |
| `get_shipping_options()` | yes | Available delivery options + prices |
| `prepare_checkout()` | yes | Returns a deeplink to finish payment in browser |
| `auth_status()` | meta | Is the VTEX session live? when does it expire? |

## Deploy

```sh
cd pharmacy-mcp
npm install

# Create the KV namespace and copy the id into wrangler.toml.
wrangler kv:namespace create PHARMACY_KV
# → put the printed id under [[kv_namespaces]] in wrangler.toml

# Pick a domain. Either use a workers.dev subdomain (default) or bind a custom
# domain. If you go custom, uncomment the `routes` block in wrangler.toml and
# update wrangler.toml's `vars.ISSUER` to match.

wrangler deploy
```

## Bootstrap the VTEX session

1. Open `https://<your-worker-domain>/login` in any browser.
2. Email is pre-filled with `ALLOWED_EMAIL`. Click **Send code** — your browser
   solves the captcha and the worker forwards the request to VTEX. A 6-digit
   code lands in your inbox.
3. Paste the code, click **Verify**. The worker validates with VTEX, stores the
   resulting cookie + refresh token in KV.
4. You're done. Close the tab.

The cron tick (every 6h) keeps the cookie fresh from then on. If a refresh
ever fails (e.g. VTEX rotates something), `view_cart` or any authed tool will
return a "not authenticated, visit /login" error and you redo step 1.

## Connect to Claude.ai / Grok / ChatGPT

The MCP itself is OAuth 2.1 + PKCE protected (separate from the VTEX login).
In your AI host's connector settings, point it at:

- Streamable HTTP MCP URL: `https://<worker-domain>/mcp`
- The host will discover `.well-known/oauth-authorization-server` and walk
  through the `/authorize` page automatically.

## Environment

Set in `wrangler.toml` under `[vars]`:

| Var | What |
|---|---|
| `ISSUER` | Public URL of this worker (used in OAuth metadata) |
| `VTEX_ACCOUNT` | `farmaciasdelpueblo` |
| `VTEX_HOST` | `www.farmaciasdelpueblo.com.ar` |
| `RECAPTCHA_SITE_KEY` | `6LdV7CIpAAAAAPUrHXWlFArQ5hSiNQJk6Ja-vcYM` (extracted from the site's HTML) |

Set via `wrangler secret put`:

| Secret | What |
|---|---|
| `ALLOWED_EMAIL` | Pins the MCP to a single email so the public `/login` URL can't be used by anyone else. Leave unset to allow any email. |

No upstream credentials are stored — captcha is solved browser-side and the
resulting VTEX cookie is bound to the worker.

## Known risks

- **reCAPTCHA Enterprise origin restriction.** If the site key is configured
  with a strict allowed-domains list, `grecaptcha.execute()` will refuse to
  generate tokens from `<your-worker-domain>`. Fix: register your worker's
  domain in the reCAPTCHA Enterprise admin (you'd need access to the
  pharmacy's reCAPTCHA console — you don't, so you'd need a workaround). If
  this hits, the `/login` page fails at "Solving captcha…" with a Google error.
- **Account rate-limit.** Burning too many failed code attempts triggers a
  ~30 min lockout. Don't auto-retry; surface the error.
- **Cookie binding strength.** VTEX binds the cookie to the issuing IP. As
  long as the worker stays on the same edge IPs (Cloudflare's pool), it's
  fine — but if VTEX ever tightens this to "single IP", we'd see 401s and need
  to add a residential proxy.

## File layout

```
src/
  index.mjs      Worker entry — routes, OAuth shell, MCP handler, cron
  vtex.mjs       VTEX REST client (auth + catalog + cart + shipping)
  tools.mjs      MCP tool definitions and dispatch
  login.html     Browser-mediated bootstrap page (reCAPTCHA + email + code)
wrangler.toml    CF Worker config
package.json
```
