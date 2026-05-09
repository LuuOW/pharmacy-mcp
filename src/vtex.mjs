// VTEX storefront API client.
//
// Two flavors of call:
//   - Public (search, category tree, product lookup) — no auth needed.
//   - Authenticated (orderForm CRUD, addresses, cards, checkout) — needs the
//     VtexIdclientAutCookie issued by /accesskey/validate. We persist this
//     cookie in KV and refresh it before expiry via /api/vtexid/refreshtoken.
//
// All authenticated calls accept an optional `cookie` arg; if omitted we pull
// the latest from KV via getActiveCookie(). Callers that already loaded the
// session blob can pass it through to skip the KV lookup.

const COOKIE_KEY      = 'vtex:session'      // { authCookie, expiresAt, email, userId }
const ORDERFORM_KEY   = 'vtex:orderform_id' // string

export const KV_KEYS = { COOKIE: COOKIE_KEY, ORDERFORM: ORDERFORM_KEY }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// ─── low-level helpers ─────────────────────────────────────────────

function baseUrl(env) {
  return `https://${env.VTEX_HOST}`
}

function defaultHeaders(env, extra = {}) {
  return {
    'user-agent':      UA,
    'accept':          'application/json',
    'accept-language': 'es-AR,es;q=0.9,en;q=0.8',
    'referer':         baseUrl(env) + '/',
    'origin':          baseUrl(env),
    ...extra,
  }
}

async function jsonOrThrow(res, label) {
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`)
    err.status = res.status
    err.body = text
    throw err
  }
  if (!text) return null
  try { return JSON.parse(text) }
  catch { return text }
}

// VTEX writes the auth cookie as `VtexIdclientAutCookie_<account>` in
// Set-Cookie headers. We extract its value (just the JWT) so we can
// re-attach it on subsequent requests.
function extractAuthCookie(setCookieHeader, account) {
  if (!setCookieHeader) return null
  const cookies = setCookieHeader.split(/,(?=\s*\w+=)/)
  for (const c of cookies) {
    const m = c.match(new RegExp(`VtexIdclientAutCookie_${account}=([^;]+)`))
    if (m) return m[1]
    const m2 = c.match(/VtexIdclientAutCookie=([^;]+)/)
    if (m2) return m2[1]
  }
  return null
}

// Build a Cookie header from our stored authCookie + an orderForm id.
function buildCookieHeader(env, authCookie, orderFormId) {
  const parts = []
  if (authCookie) {
    parts.push(`VtexIdclientAutCookie_${env.VTEX_ACCOUNT}=${authCookie}`)
    parts.push(`VtexIdclientAutCookie=${authCookie}`)
  }
  if (orderFormId) parts.push(`checkout.vtex.com=__ofid=${orderFormId}`)
  return parts.join('; ')
}

// ─── auth flow (browser-mediated bootstrap) ────────────────────────

export async function startAuthFlow(env) {
  const url = `${baseUrl(env)}/api/vtexid/pub/authentication/start?` +
    new URLSearchParams({
      scope: '', locale: 'es-AR', accountName: env.VTEX_ACCOUNT, appStart: 'true',
    })
  const res  = await fetch(url, { headers: defaultHeaders(env) })
  const data = await jsonOrThrow(res, 'authentication/start')
  return {
    authenticationToken:        data.authenticationToken,
    showAccessKeyAuthentication: data.showAccessKeyAuthentication,
    showClassicAuthentication:   data.showClassicAuthentication,
  }
}

export async function sendAccessKey(env, { authenticationToken, email, recaptcha }) {
  const url  = `${baseUrl(env)}/api/vtexid/pub/authentication/accesskey/send`
  const body = new URLSearchParams({ authenticationToken, email, recaptcha }).toString()
  const res  = await fetch(url, {
    method:  'POST',
    headers: defaultHeaders(env, { 'content-type': 'application/x-www-form-urlencoded' }),
    body,
  })
  // VTEX returns 200 {} on success. With invalid/missing captcha some tenants
  // return 200 too but never queue the email — the surface looks identical.
  // The validate step will be the real "did the email actually go" gate.
  return { ok: res.ok, status: res.status, body: await res.text() }
}

export async function validateAccessKey(env, { authenticationToken, email, accesskey, recaptcha }) {
  const url  = `${baseUrl(env)}/api/vtexid/pub/authentication/accesskey/validate`
  const body = new URLSearchParams({
    authenticationToken, login: email, accesskey, recaptcha,
  }).toString()
  const res = await fetch(url, {
    method:   'POST',
    headers:  defaultHeaders(env, { 'content-type': 'application/x-www-form-urlencoded' }),
    body,
    redirect: 'manual',
  })
  const data       = await jsonOrThrow(res, 'accesskey/validate')
  const setCookie  = res.headers.get('set-cookie') || ''
  const authCookie = extractAuthCookie(setCookie, env.VTEX_ACCOUNT) || data?.authCookie?.Value || null
  return {
    authStatus: data?.authStatus,
    userId:     data?.userId,
    authCookie,
    expiresIn:  data?.expiresIn || 86400,
    raw:        data,
  }
}

// VTEX has a refresh-token endpoint that mints a new auth cookie before the
// current one expires. The session refreshes itself transparently — we just
// re-issue with the existing cookie attached.
export async function refreshAuthCookie(env, { authCookie }) {
  const url = `${baseUrl(env)}/api/vtexid/refreshtoken/webstore`
  const res = await fetch(url, {
    method:  'POST',
    headers: defaultHeaders(env, { 'cookie': buildCookieHeader(env, authCookie) }),
  })
  const data       = await jsonOrThrow(res, 'refreshtoken').catch(() => null)
  const setCookie  = res.headers.get('set-cookie') || ''
  const newCookie  = extractAuthCookie(setCookie, env.VTEX_ACCOUNT) || authCookie
  return { authCookie: newCookie, raw: data }
}

// ─── KV-backed session helpers ─────────────────────────────────────

export async function getActiveSession(env) {
  return await env.PHARMACY_KV.get(COOKIE_KEY, 'json')
}

export async function saveSession(env, session) {
  // Keep the entry alive for 60 days; the cron will keep refreshing within.
  await env.PHARMACY_KV.put(COOKIE_KEY, JSON.stringify(session), {
    expirationTtl: 60 * 24 * 60 * 60,
  })
}

export async function clearSession(env) {
  await env.PHARMACY_KV.delete(COOKIE_KEY)
}

// NOTE: dormant. Originally guarded the cart tools so they could attach the
// VTEX auth cookie to every request. We discovered that this tenant enforces
// reCAPTCHA Enterprise origin-binding on /accesskey/send, so the worker can't
// mint a server-side session. Cart tools now operate on an anonymous
// orderForm and hand the cart to the user's browser via prepare_checkout.
// Kept here so a future Browserbase-mediated login can re-enable the path
// without re-introducing the function.
async function requireAuthCookie(env) {
  const sess = await getActiveSession(env)
  if (!sess?.authCookie) {
    const e = new Error('Not logged in. Visit /login to bootstrap a session.')
    e.code = 'NOT_AUTHENTICATED'
    throw e
  }
  return sess
}

// ─── public catalog ────────────────────────────────────────────────

export async function searchProducts(env, { query, from = 0, to = 9 } = {}) {
  const q   = encodeURIComponent(query || '')
  const url = `${baseUrl(env)}/api/catalog_system/pub/products/search/${q}?_from=${from}&_to=${to}`
  const res = await fetch(url, { headers: defaultHeaders(env) })
  return await jsonOrThrow(res, 'products/search')
}

export async function categoryTree(env, { depth = 3 } = {}) {
  const url = `${baseUrl(env)}/api/catalog_system/pub/category/tree/${depth}`
  const res = await fetch(url, { headers: defaultHeaders(env) })
  return await jsonOrThrow(res, 'category/tree')
}

export async function browseCategory(env, { categoryId, from = 0, to = 19 }) {
  const url = `${baseUrl(env)}/api/catalog_system/pub/products/search?fq=C:${categoryId}&_from=${from}&_to=${to}`
  const res = await fetch(url, { headers: defaultHeaders(env) })
  return await jsonOrThrow(res, 'products/search by category')
}

// ─── orderForm (cart) ──────────────────────────────────────────────
//
// All operations work on an *anonymous* orderForm — no VTEX auth cookie.
// The orderForm id is persisted in KV so the cart survives across MCP
// sessions. When the user is ready to check out, prepare_checkout reads
// the items and emits a /checkout/cart/add URL that the user opens in
// their browser; their browser handles login + payment in its own
// origin-correct context.

async function getOrCreateOrderForm(env) {
  let id = await env.PHARMACY_KV.get(ORDERFORM_KEY)
  if (id) {
    try {
      await viewOrderFormRaw(env, id)
      return { id }
    } catch (e) {
      if (e.status !== 404) throw e
    }
  }
  const url = `${baseUrl(env)}/api/checkout/pub/orderForm`
  const res = await fetch(url, {
    method:  'POST',
    headers: defaultHeaders(env, { 'content-type': 'application/json' }),
    body: '{}',
  })
  const data = await jsonOrThrow(res, 'orderForm create')
  id = data.orderFormId
  await env.PHARMACY_KV.put(ORDERFORM_KEY, id)
  return { id }
}

async function viewOrderFormRaw(env, id) {
  const url = `${baseUrl(env)}/api/checkout/pub/orderForm/${id}`
  const res = await fetch(url, {
    headers: defaultHeaders(env, { 'cookie': `checkout.vtex.com=__ofid=${id}` }),
  })
  return await jsonOrThrow(res, 'orderForm view')
}

export async function viewCart(env) {
  const { id } = await getOrCreateOrderForm(env)
  const data = await viewOrderFormRaw(env, id)
  return summarizeOrderForm(data)
}

export async function addToCart(env, { skuId, quantity = 1, seller = '1' }) {
  const { id } = await getOrCreateOrderForm(env)
  const url  = `${baseUrl(env)}/api/checkout/pub/orderForm/${id}/items`
  const body = JSON.stringify({ orderItems: [{ id: String(skuId), quantity, seller }] })
  const res  = await fetch(url, {
    method:  'POST',
    headers: defaultHeaders(env, {
      'cookie':       `checkout.vtex.com=__ofid=${id}`,
      'content-type': 'application/json',
    }),
    body,
  })
  const data = await jsonOrThrow(res, 'addToCart')
  return summarizeOrderForm(data)
}

export async function updateCartItem(env, { itemIndex, quantity }) {
  const { id } = await getOrCreateOrderForm(env)
  const url  = `${baseUrl(env)}/api/checkout/pub/orderForm/${id}/items/update`
  const body = JSON.stringify({ orderItems: [{ index: itemIndex, quantity }] })
  const res  = await fetch(url, {
    method:  'POST',
    headers: defaultHeaders(env, {
      'cookie':       `checkout.vtex.com=__ofid=${id}`,
      'content-type': 'application/json',
    }),
    body,
  })
  const data = await jsonOrThrow(res, 'update item')
  return summarizeOrderForm(data)
}

export async function removeFromCart(env, { itemIndex }) {
  return updateCartItem(env, { itemIndex, quantity: 0 })
}

export async function setShippingAddress(env, { postalCode, country = 'ARG' }) {
  const { id } = await getOrCreateOrderForm(env)
  const url = `${baseUrl(env)}/api/checkout/pub/orderForm/${id}/attachments/shippingData`
  const body = JSON.stringify({
    address:           { addressType: 'residential', postalCode, country, geoCoordinates: [] },
    selectedAddresses: [{ addressType: 'residential', postalCode, country, geoCoordinates: [] }],
  })
  const res = await fetch(url, {
    method:  'POST',
    headers: defaultHeaders(env, {
      'cookie':       `checkout.vtex.com=__ofid=${id}`,
      'content-type': 'application/json',
    }),
    body,
  })
  const data = await jsonOrThrow(res, 'shippingData')
  return summarizeOrderForm(data)
}

export async function clearCart(env) {
  await env.PHARMACY_KV.delete(ORDERFORM_KEY)
  return { cleared: true }
}

// Build the public VTEX cart-handoff URL: opens in the user's browser,
// VTEX adds these SKUs to whatever orderForm the browser already has
// (anonymous or logged-in), then routes to checkout.
export function buildCheckoutUrl(env, items) {
  const u = new URL(`${baseUrl(env)}/checkout/cart/add`)
  for (const it of items) {
    u.searchParams.append('sku',    String(it.skuId))
    u.searchParams.append('qty',    String(it.quantity || 1))
    u.searchParams.append('seller', String(it.seller || '1'))
  }
  u.searchParams.set('redirect', 'true')
  u.searchParams.set('sc', '1')
  return u.toString()
}

export async function shippingSimulation(env, { items, postalCode, country = 'ARG' }) {
  const url = `${baseUrl(env)}/api/checkout/pub/orderForms/simulation?sc=1`
  const body = JSON.stringify({
    items: items.map(i => ({ id: String(i.skuId), quantity: i.quantity, seller: i.seller || '1' })),
    postalCode,
    country,
  })
  const res = await fetch(url, {
    method:  'POST',
    headers: defaultHeaders(env, { 'content-type': 'application/json' }),
    body,
  })
  return await jsonOrThrow(res, 'simulation')
}

// ─── presentation helper ───────────────────────────────────────────

function summarizeOrderForm(of) {
  if (!of) return null
  const cents = (n) => (n || 0) / 100
  return {
    orderFormId: of.orderFormId,
    loggedIn:    of.loggedIn,
    email:       of.clientProfileData?.email || null,
    items: (of.items || []).map((it, i) => ({
      index:    i,
      skuId:    it.id,
      name:     it.name,
      quantity: it.quantity,
      price:    cents(it.price),
      sellingPrice: cents(it.sellingPrice),
      listPrice:    cents(it.listPrice),
      imageUrl: it.imageUrl,
      detailUrl: it.detailUrl,
    })),
    totalizers: (of.totalizers || []).map(t => ({ id: t.id, name: t.name, value: cents(t.value) })),
    value:       cents(of.value),
    shipping: {
      postalCode:  of.shippingData?.address?.postalCode || null,
      city:        of.shippingData?.address?.city || null,
      deliveryOptions: (of.shippingData?.logisticsInfo?.[0]?.slas || []).map(s => ({
        id:    s.id,
        name:  s.name,
        price: cents(s.price),
        eta:   s.shippingEstimate,
      })),
    },
    paymentSystems: (of.paymentData?.paymentSystems || []).map(p => ({
      id: p.id, name: p.name, group: p.groupName,
    })),
    messages: of.messages || {},
  }
}
