// The DS Bot side of the bridge.
//
// Talks to DS Bot's own HTTP route `POST /api/bot` over loopback. Auth is a
// browser cookie bootstrapped from the harness launch token, exactly like a
// browser: GET /?token=... sets a signed cookie, then /api/bot accepts it.
//
// Uses node:http rather than fetch on purpose. Under a system proxy, undici
// (fetch) can route even a 127.0.0.1 request through the proxy and fail; the
// core http client ignores proxy environment variables and always hits loopback.
//
// Why /api/bot and not a DSH session: `endpoint: "send"` with a Bot id (or an
// earlier part of its chat) is routed by DS Bot to the Bot's *current* part.
// A Bot rotates to a fresh session as its chat grows; a session id breaks at
// rotation, a Bot id never does.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// Node honors HTTP(S)_PROXY for loopback requests too when NODE_USE_ENV_PROXY is
// set, which breaks reaching our own /api/bot. Make sure loopback always bypasses
// the proxy. This only ADDS localhost entries; it never removes the user's.
{
  const current = process.env.NO_PROXY || process.env.no_proxy || ''
  const entries = new Set(current.split(',').map(item => item.trim()).filter(Boolean))
  for (const host of ['127.0.0.1', 'localhost', '::1']) entries.add(host)
  process.env.NO_PROXY = [...entries].join(',')
}

export const ROUTE = '/api/bot'

export class DsBotError extends Error {
  constructor(message, code = 'dsbot/error') {
    super(message)
    this.name = 'DsBotError'
    this.code = code
  }
}

function webBase() {
  const configured = process.env.DSH_WEB_URL || process.env.DSH_BOT_IM_WEB_URL
  return (configured || 'http://127.0.0.1:3080').replace(/\/+$/, '')
}

function launchToken() {
  const fromEnv = process.env.DSH_BOT_IM_WEB_TOKEN
  if (fromEnv) return fromEnv
  const file = path.join(os.tmpdir(), 'dsh-web.log')
  let text
  try {
    const buffer = fs.readFileSync(file)
    // PowerShell's Tee-Object writes UTF-16LE with a BOM on Windows.
    text = buffer[0] === 0xff && buffer[1] === 0xfe
      ? buffer.slice(2).toString('utf16le')
      : buffer.toString('utf8')
  } catch {
    throw new DsBotError(`harness launch token not found in ${file}; set DSH_BOT_IM_WEB_TOKEN`, 'dsbot/no-token')
  }
  const match = /token=([A-Za-z0-9_-]+)/.exec(text)
  if (!match) throw new DsBotError('harness launch token not found in the log', 'dsbot/no-token')
  return match[1]
}

function request(method, urlPath, { headers = {}, body } = {}) {
  const base = new URL(webBase())
  const payload = body === undefined ? undefined : Buffer.from(body)
  const options = {
    hostname: base.hostname,
    port: base.port || 80,
    path: urlPath,
    method,
    headers: {
      ...headers,
      ...(payload ? { 'content-length': payload.length } : {}),
    },
    timeout: 30_000,
  }
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new DsBotError('loopback HTTP timeout', 'dsbot/timeout')))
    req.on('error', error => reject(new DsBotError(`loopback HTTP failed: ${error?.message ?? error}`, 'dsbot/network')))
    if (payload) req.write(payload)
    req.end()
  })
}

let cachedCookie

async function bootstrapCookie() {
  const response = await request('GET', `/?token=${launchToken()}`)
  const raw = response.headers['set-cookie']
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : []
  if (cookies.length === 0) {
    throw new DsBotError(`browser cookie bootstrap failed (HTTP ${response.status})`, 'dsbot/no-cookie')
  }
  return cookies.map(cookie => cookie.split(';')[0]).join('; ')
}

async function post(endpoint, payload) {
  if (!cachedCookie) cachedCookie = await bootstrapCookie()
  const body = JSON.stringify({ endpoint, payload })
  const send = () => request('POST', ROUTE, {
    headers: { 'content-type': 'application/json', cookie: cachedCookie },
    body,
  })
  let response = await send()
  if (response.status === 401) {
    cachedCookie = await bootstrapCookie()
    response = await send()
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DsBotError(`/api/bot HTTP ${response.status}`, 'dsbot/http')
  }
  let parsed
  try {
    parsed = JSON.parse(response.text)
  } catch {
    throw new DsBotError('/api/bot returned non-JSON', 'dsbot/invalid-response')
  }
  if (!parsed?.ok) {
    throw new DsBotError(parsed?.error?.message ?? String(parsed?.error ?? 'DS Bot call failed'), parsed?.error?.code ?? 'dsbot/failed')
  }
  return parsed.value
}

/** Call one DS Bot endpoint and unwrap its envelope. */
export function call(ctx, endpoint, payload = {}) {
  return post(endpoint, payload)
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
