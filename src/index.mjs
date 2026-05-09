// Pharmacy MCP — Cloudflare Worker.
//
// Routes:
//   GET  /                              — version banner
//   GET  /healthz                       — liveness
//   GET  /login                         — browser-mediated VTEX bootstrap
//                                          (renders src/login.html with the
//                                          reCAPTCHA site key + allowed email)
//   POST /api/auth/send                 — calls VTEX /accesskey/send (browser
//                                          provides recaptcha token)
//   POST /api/auth/validate             — calls VTEX /accesskey/validate, stores
//                                          the resulting auth cookie in KV
//   POST /api/auth/logout               — clears the stored cookie
//
//   GET  /.well-known/oauth-authorization-server — RFC 8414 discovery
//   GET  /.well-known/oauth-protected-resource    — RFC 9728 discovery
//   GET  /authorize                     — OAuth 2.1 + PKCE form (for the MCP)
//   POST /authorize                     — issues auth code, redirects
//   POST /token                         — auth-code → access_token
//   POST /mcp                           — JSON-RPC over Streamable HTTP
//
// Cron (every 6h): refresh the VTEX session if the cookie is within 12h of expiry.

import { Server }                                    from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport }   from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import * as vtex   from './vtex.mjs'
import { TOOLS, handleToolCall } from './tools.mjs'
import LOGIN_HTML  from './login.html'

const PKG_VERSION   = '0.1.0'
const SUPPORTED_SCOPE = 'pharmacy_cart'
const CODE_TTL_SEC    = 5 * 60
const TOKEN_TTL_SEC   = 7 * 24 * 60 * 60
const KV_CODE_PREFIX  = 'mcpcode:'
const KV_TOKEN_PREFIX = 'mcptok:'

const CORS = {
  'access-control-allow-origin':   '*',
  'access-control-allow-methods':  'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':  'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
  'access-control-max-age':        '86400',
}

// ─── helpers ───────────────────────────────────────────────────────

function b64urlFromBytes(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes); crypto.getRandomValues(buf); return b64urlFromBytes(buf)
}
async function sha256B64url(text) {
  const buf  = new TextEncoder().encode(text)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
  return b64urlFromBytes(hash)
}
function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...(init.headers || {}) },
  })
}
function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  })
}
function textResponse(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS },
  })
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}

// ─── /login ─────────────────────────────────────────────────────────

function renderLoginPage(env, oauthFormHtml = '') {
  return LOGIN_HTML
    .replaceAll('__SITE_KEY__',      env.RECAPTCHA_SITE_KEY)
    .replaceAll('__ALLOWED_EMAIL__', env.ALLOWED_EMAIL || '')
    .replaceAll('__OAUTH_FORM__',    oauthFormHtml)
}

// Hidden form posted to /authorize once VTEX login completes. Carries the
// OAuth params untouched so PKCE + state survive the round-trip.
function buildOAuthConsentForm(params) {
  const inputs = AUTH_PARAMS.map(k =>
    `      <input type="hidden" name="${k}" value="${escapeHtml(params.get(k) || '')}">`).join('\n')
  return `<form id="oauth-consent" method="POST" action="/authorize" style="display:none">\n${inputs}\n    </form>`
}

// ─── /api/auth/* ────────────────────────────────────────────────────

async function handleAuthSend(req, env) {
  let body; try { body = await req.json() } catch { return jsonResponse({ error: 'JSON body required' }, { status: 400 }) }
  const email     = (body.email || '').trim().toLowerCase()
  const recaptcha = body.recaptcha
  if (!email)     return jsonResponse({ error: 'email required' },     { status: 400 })
  if (!recaptcha) return jsonResponse({ error: 'recaptcha required' }, { status: 400 })
  if (env.ALLOWED_EMAIL && email !== env.ALLOWED_EMAIL.toLowerCase()) {
    return jsonResponse({ error: 'this MCP is locked to a single email' }, { status: 403 })
  }
  console.log(`[auth/send] email=${email} recaptcha_len=${recaptcha.length}`)
  try {
    const start = await vtex.startAuthFlow(env)
    console.log(`[auth/send] start: token_len=${start.authenticationToken?.length || 0} accessKey=${start.showAccessKeyAuthentication}`)
    if (!start.authenticationToken) return jsonResponse({ error: 'failed to obtain VTEX authenticationToken' }, { status: 502 })
    const send = await vtex.sendAccessKey(env, { authenticationToken: start.authenticationToken, email, recaptcha })
    console.log(`[auth/send] vtex_status=${send.status} vtex_body=${JSON.stringify(send.body).slice(0, 300)}`)
    if (!send.ok) return jsonResponse({ error: `VTEX rejected send: ${send.status} ${send.body}` }, { status: 502 })
    return jsonResponse({ ok: true, authenticationToken: start.authenticationToken })
  } catch (e) {
    console.log(`[auth/send] EXCEPTION: ${e.message || e}`)
    return jsonResponse({ error: e.message || String(e) }, { status: 502 })
  }
}

async function handleAuthValidate(req, env) {
  let body; try { body = await req.json() } catch { return jsonResponse({ error: 'JSON body required' }, { status: 400 }) }
  const { email, code, recaptcha, authenticationToken } = body
  if (!email || !code || !recaptcha || !authenticationToken) {
    return jsonResponse({ error: 'email, code, recaptcha, authenticationToken required' }, { status: 400 })
  }
  if (env.ALLOWED_EMAIL && email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
    return jsonResponse({ error: 'email mismatch' }, { status: 403 })
  }
  try {
    const result = await vtex.validateAccessKey(env, {
      authenticationToken, email, accesskey: code, recaptcha,
    })
    if (result.authStatus !== 'Success' || !result.authCookie) {
      return jsonResponse({
        error: 'validate failed',
        authStatus: result.authStatus,
        hint: result.authStatus === 'WrongCredentials'
          ? 'Wrong code, or captcha failed verification.'
          : 'See VTEX response.',
      }, { status: 401 })
    }
    const expiresAt = Date.now() + (result.expiresIn || 86400) * 1000
    await vtex.saveSession(env, {
      authCookie:      result.authCookie,
      email,
      userId:          result.userId,
      expiresAt,
      issuedAt:        Date.now(),
      lastRefreshedAt: Date.now(),
    })
    return jsonResponse({
      ok:         true,
      email,
      user_id:    result.userId,
      expires_at: new Date(expiresAt).toISOString(),
    })
  } catch (e) {
    return jsonResponse({ error: e.message || String(e) }, { status: 502 })
  }
}

async function handleAuthLogout(_req, env) {
  await vtex.clearSession(env)
  await env.PHARMACY_KV.delete(vtex.KV_KEYS.ORDERFORM)
  return jsonResponse({ ok: true })
}

// ─── OAuth 2.1 + PKCE for the MCP itself ───────────────────────────

function discoveryAS(env) {
  const issuer = env.ISSUER
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint:         `${issuer}/token`,
    response_types_supported: ['code'],
    grant_types_supported:    ['authorization_code'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SUPPORTED_SCOPE],
  }
}
function discoveryProtectedResource(env) {
  return {
    resource: `${env.ISSUER}/mcp`,
    authorization_servers: [env.ISSUER],
    scopes_supported: [SUPPORTED_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Pharmacy MCP',
  }
}

const AUTH_PARAMS = ['response_type','client_id','redirect_uri','scope','state','code_challenge','code_challenge_method']

function renderAuthorizePage(params) {
  const hidden = AUTH_PARAMS.map(k =>
    `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) || '')}">`).join('')
  const client = escapeHtml(params.get('client_id') || 'your AI host')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Pharmacy MCP</title>
<style>
  :root { color-scheme: dark }
  body { background:#0b0d12; color:#e6eaf2; font:14px/1.5 ui-sans-serif, system-ui, sans-serif; margin:0; min-height:100vh; display:grid; place-items:center }
  .card { width:min(440px, calc(100vw - 32px)); background:#10131a; border:1px solid #1b2030; border-radius:14px; padding:28px }
  .logo { font-size:24px; margin-bottom:12px }
  h1 { font-size:18px; font-weight:600; margin:0 0 8px }
  p, ul li { color:#94a0b8 } ul { padding-left:18px } code { background:#0b0d12; padding:1px 5px; border-radius:4px; border:1px solid #1b2030 }
  button { margin-top:8px; width:100%; background:#5b8cff; color:#0b0d12; border:0; border-radius:8px; padding:12px; font-weight:600; cursor:pointer }
  button:hover { background:#7aa3ff }
  .meta { margin-top:18px; padding-top:14px; border-top:1px solid #1b2030; color:#6c7790; font-size:11.5px }
</style></head><body>
  <form class="card" method="POST" action="/authorize">${hidden}
    <div class="logo">💊</div>
    <h1>Authorize <strong>${client}</strong> to use Pharmacy MCP</h1>
    <p>This connects your AI host to the Farmacias del Pueblo cart automation. The host will be able to:</p>
    <ul>
      <li>Search the catalog and read product info</li>
      <li>Read, add, remove, and update items in an anonymous cart</li>
      <li>Set shipping address + see delivery options</li>
      <li>Build a <code>/checkout/cart/add</code> URL that hands the cart to your browser for login + payment</li>
    </ul>
    <button type="submit">Authorize</button>
    <div class="meta">Anonymous-cart mode. Search and cart tools work immediately after authorization; <code>prepare_checkout</code> emits a <code>/checkout/cart/add</code> URL you open in your own browser to finish login + payment.</div>
  </form></body></html>`
}

async function handleAuthorizeGet(url, env) {
  const p = url.searchParams
  for (const k of ['response_type','client_id','redirect_uri','code_challenge','code_challenge_method']) {
    if (!p.get(k)) return textResponse(`missing ${k}`, { status: 400 })
  }
  if (p.get('response_type')        !== 'code') return textResponse('only response_type=code', { status: 400 })
  if (p.get('code_challenge_method') !== 'S256') return textResponse('only S256',               { status: 400 })

  // Anonymous-cart mode: server-side VTEX login is dormant (captcha origin
  // enforced — see README). The connector consent page is the only step
  // here. The merged login+consent path stays in this file for the day a
  // Browserbase-backed re-enable flips it back on; until then, show the
  // simple consent page directly.
  return htmlResponse(renderAuthorizePage(p))
}

async function handleAuthorizePost(req, env) {
  let form; try { form = await req.formData() } catch { return textResponse('expected form body', { status: 400 }) }
  const get = (k) => form.get(k) ? String(form.get(k)) : ''
  const redirect_uri   = get('redirect_uri')
  const code_challenge = get('code_challenge')
  const scope          = get('scope') || SUPPORTED_SCOPE
  const state          = get('state')
  if (!redirect_uri || !code_challenge || get('code_challenge_method') !== 'S256') {
    return textResponse('invalid OAuth params', { status: 400 })
  }
  const code = randomToken(32)
  await env.PHARMACY_KV.put(KV_CODE_PREFIX + code, JSON.stringify({ code_challenge, redirect_uri, scope }), {
    expirationTtl: CODE_TTL_SEC,
  })
  const dest = new URL(redirect_uri)
  dest.searchParams.set('code', code)
  if (state) dest.searchParams.set('state', state)
  return new Response(null, { status: 302, headers: { 'location': dest.toString(), ...CORS } })
}

async function handleTokenPost(req, env) {
  let form
  try { form = await req.formData() }
  catch {
    try {
      const body = await req.clone().json()
      form = new Map(Object.entries(body))
      form.get = (k) => form instanceof Map ? form.get(k) : null
    } catch { return jsonResponse({ error: 'invalid_request' }, { status: 400 }) }
  }
  const get = (k) => form.get(k) ? String(form.get(k)) : ''
  if (get('grant_type') !== 'authorization_code') {
    return jsonResponse({ error: 'unsupported_grant_type' }, { status: 400 })
  }
  const code           = get('code')
  const code_verifier  = get('code_verifier')
  const redirect_uri   = get('redirect_uri')
  if (!code || !code_verifier) return jsonResponse({ error: 'invalid_request' }, { status: 400 })

  let stored = null
  for (const wait of [0, 250, 500, 1000, 2000]) {
    if (wait) await new Promise(r => setTimeout(r, wait))
    stored = await env.PHARMACY_KV.get(KV_CODE_PREFIX + code, 'json')
    if (stored) break
  }
  if (!stored) return jsonResponse({ error: 'invalid_grant', error_description: 'auth code unknown or expired' }, { status: 400 })
  await env.PHARMACY_KV.delete(KV_CODE_PREFIX + code)

  const expected = await sha256B64url(code_verifier)
  if (expected !== stored.code_challenge) {
    return jsonResponse({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 })
  }
  if (redirect_uri && redirect_uri !== stored.redirect_uri) {
    return jsonResponse({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 })
  }

  const access_token = randomToken(32)
  await env.PHARMACY_KV.put(KV_TOKEN_PREFIX + access_token, JSON.stringify({ scope: stored.scope, issued_at: Date.now() }), {
    expirationTtl: TOKEN_TTL_SEC,
  })
  return jsonResponse({
    access_token,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SEC,
    scope:      stored.scope || SUPPORTED_SCOPE,
  })
}

function bearerOf(req) {
  const h = req.headers.get('authorization')
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1].trim() : null
}

async function resolveBearer(bearer, env) {
  if (!bearer) return { error: 'missing Authorization: Bearer <access-token>' }
  let stored = null
  for (const wait of [0, 250, 500, 1000]) {
    if (wait) await new Promise(r => setTimeout(r, wait))
    stored = await env.PHARMACY_KV.get(KV_TOKEN_PREFIX + bearer, 'json')
    if (stored) break
  }
  if (!stored) return { error: 'invalid or expired access token' }
  return { ok: true }
}

// ─── /mcp handler ──────────────────────────────────────────────────

function buildMcpServer(env) {
  const server = new Server(
    { name: 'pharmacy', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      const result = await handleToolCall(env, name, args || {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      const msg = e.code === 'NOT_AUTHENTICATED'
        ? `Not authenticated. Visit ${env.ISSUER}/login to bootstrap a VTEX session.`
        : `Error: ${e.message || e}`
      return { content: [{ type: 'text', text: msg }], isError: true }
    }
  })
  return server
}

async function handleMcp(request, env) {
  const bearer   = bearerOf(request)
  const resolved = await resolveBearer(bearer, env)
  if (resolved.error) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: resolved.error } }),
      { status: 401, headers: {
        'content-type':     'application/json',
        'www-authenticate': `Bearer realm="pharmacy-mcp", resource_metadata="${env.ISSUER}/.well-known/oauth-protected-resource"`,
        ...CORS,
      } },
    )
  }
  const server    = buildMcpServer(env)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  try {
    await server.connect(transport)
    const res = await transport.handleRequest(request)
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
    return new Response(res.body, { status: res.status, headers })
  } catch (e) {
    return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message || String(e) } }, { status: 500 })
  }
}

// ─── cron: refresh VTEX session ────────────────────────────────────

async function refreshSessionIfNeeded(env) {
  const sess = await vtex.getActiveSession(env)
  if (!sess?.authCookie) return { skipped: true, reason: 'no session' }
  const remaining = (sess.expiresAt || 0) - Date.now()
  // Refresh when within 12h of expiry — gives us margin against transient errors.
  if (remaining > 12 * 60 * 60 * 1000) return { skipped: true, reason: `${Math.round(remaining/3600000)}h remaining` }
  try {
    const r = await vtex.refreshAuthCookie(env, { authCookie: sess.authCookie })
    const next = {
      ...sess,
      authCookie:      r.authCookie,
      expiresAt:       Date.now() + 24 * 60 * 60 * 1000,  // assume new 24h JWT
      lastRefreshedAt: Date.now(),
    }
    await vtex.saveSession(env, next)
    return { refreshed: true }
  } catch (e) {
    return { error: e.message || String(e) }
  }
}

// ─── router ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (url.pathname === '/healthz') return textResponse('ok')

    if (url.pathname === '/' && request.method === 'GET') {
      return textResponse(`Pharmacy MCP v${PKG_VERSION}\n\n` +
        `POST /mcp           — JSON-RPC (OAuth bearer required)\n` +
        `GET  /login         — bootstrap VTEX session\n` +
        `GET  /authorize     — OAuth flow (for connector hosts)\n`)
    }

    // VTEX bootstrap
    if (url.pathname === '/login' && request.method === 'GET')
      return htmlResponse(renderLoginPage(env))
    if (url.pathname === '/api/auth/send' && request.method === 'POST')
      return handleAuthSend(request, env)
    if (url.pathname === '/api/auth/validate' && request.method === 'POST')
      return handleAuthValidate(request, env)
    if (url.pathname === '/api/auth/logout' && request.method === 'POST')
      return handleAuthLogout(request, env)
    if (url.pathname === '/api/auth/status' && request.method === 'GET') {
      const sess = await vtex.getActiveSession(env)
      if (!sess) return jsonResponse({ logged_in: false })
      return jsonResponse({
        logged_in:  true,
        email:      sess.email,
        expires_at: new Date(sess.expiresAt || 0).toISOString(),
      })
    }

    // OAuth + MCP
    if (url.pathname === '/.well-known/oauth-authorization-server') return jsonResponse(discoveryAS(env))
    if (url.pathname === '/.well-known/oauth-protected-resource')   return jsonResponse(discoveryProtectedResource(env))
    if (url.pathname === '/authorize' && request.method === 'GET')  return handleAuthorizeGet(url, env)
    if (url.pathname === '/authorize' && request.method === 'POST') return handleAuthorizePost(request, env)
    if (url.pathname === '/token'     && request.method === 'POST') return handleTokenPost(request, env)
    if (url.pathname === '/mcp')                                    return handleMcp(request, env)

    return textResponse('not found', { status: 404 })
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshSessionIfNeeded(env))
  },
}
