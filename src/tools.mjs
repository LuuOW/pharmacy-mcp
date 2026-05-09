// MCP tool definitions and handlers.
//
// Public tools work without auth (search, categories). Authenticated tools
// require a VTEX session bootstrapped via the /login page. If called before
// the user has logged in, they return a clear "not authenticated, visit
// /login" message rather than failing cryptically.

import * as vtex from './vtex.mjs'

export const TOOLS = [
  {
    name:        'search_products',
    description: 'Search the Farmacias del Pueblo catalog. Returns up to `limit` products with id, name, price, brand, image, link.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term in Spanish (e.g. "ibuprofeno", "pañales huggies talle G").' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name:        'get_categories',
    description: 'Return the top-level category tree (Dermocosmetica, Bebes y Maternidad, Cuidado Personal, etc).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'browse_category',
    description: 'List products in a category by id (use get_categories first to find ids).',
    inputSchema: {
      type: 'object',
      properties: {
        category_id: { type: 'integer' },
        limit:       { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        page:        { type: 'integer', minimum: 1, default: 1 },
      },
      required: ['category_id'],
    },
  },
  {
    name:        'view_cart',
    description: 'View the current cart (orderForm) — items, totals, shipping, payment options. Requires login.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'add_to_cart',
    description: 'Add a product (by SKU id from search_products) to the cart. Requires login.',
    inputSchema: {
      type: 'object',
      properties: {
        sku_id:   { type: 'string', description: 'The numeric SKU id from search_products results.' },
        quantity: { type: 'integer', minimum: 1, default: 1 },
      },
      required: ['sku_id'],
    },
  },
  {
    name:        'remove_from_cart',
    description: 'Remove an item from the cart by its index (0-based, see view_cart). Requires login.',
    inputSchema: {
      type: 'object',
      properties: { item_index: { type: 'integer', minimum: 0 } },
      required: ['item_index'],
    },
  },
  {
    name:        'update_cart_item',
    description: 'Change the quantity of a cart item. Set quantity 0 to remove. Requires login.',
    inputSchema: {
      type: 'object',
      properties: {
        item_index: { type: 'integer', minimum: 0 },
        quantity:   { type: 'integer', minimum: 0 },
      },
      required: ['item_index', 'quantity'],
    },
  },
  {
    name:        'set_shipping_address',
    description: 'Set the shipping postal code on the cart so delivery options + final price compute. Requires login.',
    inputSchema: {
      type: 'object',
      properties: {
        postal_code: { type: 'string', description: 'Argentine postal code (e.g. "1424").' },
        country:     { type: 'string', default: 'ARG' },
      },
      required: ['postal_code'],
    },
  },
  {
    name:        'get_shipping_options',
    description: 'List available shipping/pickup options for the current cart + address (must call set_shipping_address first). Requires login.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'prepare_checkout',
    description: 'Returns a deeplink URL you can open in a browser to finish login + payment. The cart is preserved across the hand-off. Requires login.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'auth_status',
    description: 'Returns whether the MCP has an active VTEX session, the email it belongs to, and when it expires.',
    inputSchema: { type: 'object', properties: {} },
  },
]

// Trim VTEX search hits down to what's worth surfacing.
function compactProduct(p) {
  const sku    = p.items?.[0]
  const seller = sku?.sellers?.[0]
  const co     = seller?.commertialOffer
  return {
    sku_id:    sku?.itemId,
    name:      p.productName,
    brand:     p.brand,
    price:     (co?.Price ?? 0),
    list_price: (co?.ListPrice ?? 0),
    available: !!co?.IsAvailable,
    image:     sku?.images?.[0]?.imageUrl,
    link:      p.link ? `https://${p.linkText ? '' : ''}${p.link}` : (p.linkText ? `/${p.linkText}/p` : null),
  }
}

function flattenCategories(nodes, depth = 0, acc = []) {
  for (const n of nodes || []) {
    acc.push({ id: n.id, name: n.name, depth, has_children: (n.children?.length || 0) > 0, url: n.url })
    if (n.children?.length) flattenCategories(n.children, depth + 1, acc)
  }
  return acc
}

export async function handleToolCall(env, name, args = {}) {
  switch (name) {
    case 'search_products': {
      const limit = Math.min(Math.max(args.limit || 10, 1), 50)
      const data  = await vtex.searchProducts(env, { query: args.query, from: 0, to: limit - 1 })
      return { products: (data || []).map(compactProduct) }
    }
    case 'get_categories': {
      const tree = await vtex.categoryTree(env, { depth: 3 })
      return { categories: flattenCategories(tree) }
    }
    case 'browse_category': {
      const limit = Math.min(Math.max(args.limit || 20, 1), 50)
      const page  = Math.max(args.page || 1, 1)
      const from  = (page - 1) * limit
      const to    = from + limit - 1
      const data  = await vtex.browseCategory(env, { categoryId: args.category_id, from, to })
      return { products: (data || []).map(compactProduct), page, limit }
    }
    case 'view_cart': {
      return await vtex.viewCart(env)
    }
    case 'add_to_cart': {
      return await vtex.addToCart(env, { skuId: args.sku_id, quantity: args.quantity || 1 })
    }
    case 'remove_from_cart': {
      return await vtex.removeFromCart(env, { itemIndex: args.item_index })
    }
    case 'update_cart_item': {
      return await vtex.updateCartItem(env, { itemIndex: args.item_index, quantity: args.quantity })
    }
    case 'set_shipping_address': {
      return await vtex.setShippingAddress(env, { postalCode: args.postal_code, country: args.country })
    }
    case 'get_shipping_options': {
      const cart = await vtex.viewCart(env)
      return { options: cart.shipping.deliveryOptions, postal_code: cart.shipping.postalCode }
    }
    case 'prepare_checkout': {
      const cart = await vtex.viewCart(env)
      const checkoutUrl = `https://${env.VTEX_HOST}/checkout?orderFormId=${cart.orderFormId}#/cart`
      return {
        checkout_url: checkoutUrl,
        message: 'Open this URL in your browser to complete login + payment. Cart contents are preserved.',
        cart_summary: {
          items_count: cart.items.length,
          total:       cart.value,
          email:       cart.email,
        },
      }
    }
    case 'auth_status': {
      const sess = await vtex.getActiveSession(env)
      if (!sess) return { logged_in: false, hint: 'Visit /login to bootstrap a session.' }
      const expiresInSec = Math.max(0, Math.floor(((sess.expiresAt || 0) - Date.now()) / 1000))
      return {
        logged_in:       true,
        email:           sess.email || env.ALLOWED_EMAIL,
        user_id:         sess.userId || null,
        expires_in_sec:  expiresInSec,
        expires_at:      new Date(sess.expiresAt || 0).toISOString(),
        last_refreshed:  sess.lastRefreshedAt ? new Date(sess.lastRefreshedAt).toISOString() : null,
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
