// Minimal iLink (WeChat bot) client: long-poll getUpdates and sendText.
//
// Protocol constants and header shape follow Tencent's iLink bot API as used by
// the community DeepSeek Harness IM plugin (MIT). Only the two calls this bridge
// needs are implemented; images/files are intentionally out of scope for v0.1.

import { randomBytes } from 'node:crypto'

export const WEIXIN_API_BASE = 'https://ilinkai.weixin.qq.com/'
export const WEIXIN_PROTOCOL_VERSION = '2.4.6'
const ILINK_APP_ID = 'bot'
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
export const MAX_MESSAGE_CHARS = 1800
const DEFAULT_TIMEOUT_MS = 15_000
export const LONG_POLL_TIMEOUT_MS = 35_000
const TEXT_SEND_RETRY_DELAYS_MS = [400, 1200]

export class WeixinError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'WeixinError'
    this.code = code
    Object.assign(this, extra)
  }
}

function baseInfo() {
  return { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'dsh-bot-im-bridge/0.1.0' }
}

function authHeaders(token) {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
    Authorization: `Bearer ${String(token).trim()}`,
  }
}

export function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim() || WEIXIN_API_BASE
  const url = new URL(raw)
  if (url.protocol !== 'https:') throw new WeixinError('bad-base-url', 'WeChat API base must be https')
  if (!/(^|\.)weixin\.qq\.com$/.test(url.hostname)) {
    throw new WeixinError('bad-base-url', `Refusing non-WeChat host ${url.hostname}`)
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

async function requestJson({ baseUrl, endpoint, token, body, method = 'POST', timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  const base = normalizeBaseUrl(baseUrl)
  const url = new URL(endpoint, base)
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  const res = await fetch(url, {
    method,
    headers: authHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any(signals),
  })
  if (!res.ok) throw new WeixinError('http-error', `WeChat API HTTP ${res.status}`, { status: res.status })
  try {
    return await res.json()
  } catch (error) {
    throw new WeixinError('invalid-response', 'WeChat API returned non-JSON', { cause: error })
  }
}

// A rejection shows up as a non-zero ret/errcode with HTTP 200.
function rejected(response) {
  if (!response || typeof response !== 'object') return undefined
  for (const key of ['ret', 'errcode']) {
    const value = response[key]
    if (typeof value === 'number' && value !== 0) return value
  }
  return undefined
}

/**
 * Long-poll for new messages.
 * @returns {{ret:number, msgs:any[], get_updates_buf:string}}
 */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = '', timeoutMs = LONG_POLL_TIMEOUT_MS, signal }) {
  try {
    const response = await requestJson({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      token,
      body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
      timeoutMs,
      signal,
    })
    return {
      ret: typeof response?.ret === 'number' ? response.ret : 0,
      msgs: Array.isArray(response?.msgs) ? response.msgs : [],
      get_updates_buf: typeof response?.get_updates_buf === 'string' ? response.get_updates_buf : getUpdatesBuf,
    }
  } catch (error) {
    // A long poll that simply timed out with nothing to say is not an error.
    if (error?.name === 'TimeoutError' || error?.code === 'timeout' || error?.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
    }
    throw error
  }
}

/** Extract plain text from an inbound message, or '' when it has none. */
export function messageText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  const parts = []
  for (const item of items) {
    if (item?.type === 1 && typeof item?.text_item?.text === 'string') parts.push(item.text_item.text)
  }
  return parts.join('\n').trim()
}

/** Send one text message, retrying once on a connection-level failure. */
export async function sendText({ baseUrl, token, toUserId, text, contextToken, signal }) {
  const recipient = String(toUserId ?? '').trim()
  const content = String(text ?? '').trim()
  if (!recipient || !content) throw new WeixinError('bad-argument', 'toUserId and text are required')
  let lastError
  for (let attempt = 0; attempt <= TEXT_SEND_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await requestJson({
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: recipient,
            client_id: `dsh-bot-im-bridge-${randomBytes(16).toString('hex')}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: content } }],
            ...(contextToken ? { context_token: String(contextToken).trim() } : {}),
          },
          base_info: baseInfo(),
        },
      })
      const code = rejected(response)
      if (code !== undefined) throw new WeixinError('send-rejected', `WeChat rejected the message (ret=${code})`, { providerCode: code })
      return response
    } catch (error) {
      lastError = error
      const isConn = !(error instanceof WeixinError) || error.code === 'http-error'
      const delay = TEXT_SEND_RETRY_DELAYS_MS[attempt]
      if (!isConn || delay === undefined || signal?.aborted) break
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

/** Split long text into chunks that fit one iLink message. */
export function chunkText(text, limit = MAX_MESSAGE_CHARS) {
  const source = String(text ?? '')
  if (source.length <= limit) return source ? [source] : []
  const chunks = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit / 2)) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

export async function sendTextChunked({ baseUrl, token, toUserId, text, contextToken, signal }) {
  const ids = []
  for (const chunk of chunkText(text)) {
    const response = await sendText({ baseUrl, token, toUserId, text: chunk, contextToken, signal })
    ids.push(response?.client_id ?? null)
  }
  return ids
}
