// The DS Bot side of the bridge.
//
// It talks to the DS Bot plugin's own HTTP route (`POST /api/bot`) in-process,
// through the harness connection dispatcher, so no port, token or cookie is
// involved. `ctx.connection.browserPeer` is the owner peer, which the route
// accepts exactly as it accepts the browser.
//
// Why this route and not a DSH session: `endpoint: "send"` with a Bot id (or
// any earlier part of that Bot's chat) is routed by DS Bot to the Bot's
// *current* part. A Bot rotates to a fresh session as its chat grows; binding a
// DSH session id would break at the next rotation, but a Bot id never does.

export const ROUTE = '/api/bot'

export class DsBotError extends Error {
  constructor(message, code = 'dsbot/error') {
    super(message)
    this.name = 'DsBotError'
    this.code = code
  }
}

function connectionOf(ctx) {
  const connection = ctx.get?.('connection') ?? ctx.connection
  if (!connection) throw new DsBotError('connection service not ready yet', 'dsbot/no-connection')
  return connection
}

// Dispatch an exact Fetch route in-process. Different harness versions expose
// the dispatcher differently, so try the known shapes in order.
function dispatch(connection, request) {
  const peer = connection.browserPeer
  if (typeof connection.fetch === 'function') return connection.fetch(request, peer)
  if (connection.fetch && typeof connection.fetch.dispatch === 'function') return connection.fetch.dispatch(request, peer)
  const routes = connection.fetchRoutes
  const route = routes?.get?.(new URL(request.url).pathname)
  if (route && typeof route.fetch === 'function') return route.fetch(request)
  throw new DsBotError(`no in-process dispatcher for ${ROUTE}`, 'dsbot/no-dispatcher')
}

/** Call one DS Bot endpoint and unwrap its envelope. */
export async function call(ctx, endpoint, payload = {}) {
  const connection = connectionOf(ctx)
  const request = new Request('http://127.0.0.1' + ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  const response = await dispatch(connection, request)
  if (!response.ok) throw new DsBotError(`DS Bot route HTTP ${response.status}`, 'dsbot/http')
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new DsBotError('DS Bot route returned non-JSON', 'dsbot/invalid-response')
  }
  if (!body?.ok) throw new DsBotError(body?.error?.message ?? body?.error ?? 'DS Bot call failed', body?.error?.code ?? 'dsbot/failed')
  return body.value
}

/** The whole team view. Used to resolve a Bot name to its id. */
export function state(ctx) {
  return call(ctx, 'state')
}

/** One page of a Bot's current chat. Items carry { kind, text, turn, seq, time }. */
export function chat(ctx, botId, cursor) {
  return call(ctx, 'chat', cursor === undefined ? { botId } : { botId, cursor })
}

/** Deliver a user message to a Bot. `sessionId` may be the Bot id: DS Bot maps it to the current part. */
export function send(ctx, botId, text) {
  return call(ctx, 'send', { sessionId: botId, text })
}

/** Resolve a Bot by display name (case-sensitive), returning its id. */
export async function resolveBotId(ctx, name) {
  const view = await state(ctx)
  const bots = Array.isArray(view?.bots) ? view.bots : []
  const found = bots.find(bot => bot?.name === name)
  if (!found) throw new DsBotError(`no Bot named ${name}`, 'dsbot/unknown-bot')
  return found.id
}
