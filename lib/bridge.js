// The bridge loop: WeChat in -> DS Bot -> WeChat out.
//
// One long-poll loop per plugin instance. Inbound messages are filtered by an
// explicit allowlist, forwarded to the Bot's current part, and the Bot's reply
// is read back from the same chat and sent to WeChat.

import fs from 'node:fs'
import path from 'node:path'
import { getUpdates, messageText, sendTextChunked } from './weixin.js'
import * as dsbot from './dsbot.js'

function readState(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

/** Highest turn number currently in a Bot's chat. */
async function currentTurn(ctx, botId) {
  try {
    const page = await dsbot.chat(ctx, botId)
    const items = Array.isArray(page?.items) ? page.items : []
    let turn = 0
    for (const item of items) if (Number.isFinite(item?.turn) && item.turn > turn) turn = item.turn
    return turn
  } catch {
    return 0
  }
}

/**
 * Poll a Bot's chat until its reply stops growing.
 * Returns { text, turns } where text is the reply ('' if none).
 */
async function waitForReply(ctx, botId, baseTurn, behavior, signal, log) {
  const deadline = Date.now() + behavior.maxWaitMs
  let collected = []
  let lastChange = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) return ''
    let page
    try {
      page = await dsbot.chat(ctx, botId)
    } catch (error) {
      log.warn('chat read failed: %s', error?.message ?? error)
      await sleep(behavior.pollIntervalMs)
      continue
    }
    const items = Array.isArray(page?.items) ? page.items : []
    const fresh = items.filter(item => item?.kind === 'bot' && Number.isFinite(item?.turn) && item.turn > baseTurn)
    if (fresh.length !== collected.length) lastChange = Date.now()
    collected = fresh
    if (collected.length > 0 && Date.now() - lastChange >= behavior.quietMs) break
    await sleep(behavior.pollIntervalMs)
  }
  if (collected.length === 0) return ''
  const merged = collected.map(item => String(item.text ?? '').trim()).filter(Boolean).join('\n\n')
  return merged.split('\n\n').at(-1) ?? merged
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Start the loop. Returns a disposer that stops it. */
export function startBridge({ ctx, config, logger }) {
  const controller = new AbortController()
  const state = readState(config.stateFile)
  const log = logger ?? ctx.logger
  const debugFile = path.join(path.dirname(config.stateFile), 'debug.log')
  const dbg = (message) => {
    try { fs.appendFileSync(debugFile, new Date().toISOString() + ' ' + message + '\n') } catch { /* ignore */ }
  }
  dbg('bridge start')

  async function run() {
    let botId = config.bot.id
    if (!botId) {
      // The connection service and the DS Bot route are registered by other
      // plugins; at load time they may not exist yet. Wait for them instead of
      // crashing, and re-resolve on failure.
      for (;;) {
        if (controller.signal.aborted) return
        try {
          botId = await dsbot.resolveBotId(ctx, config.bot.name)
          log.info('bridge: talking to Bot %s (%s)', config.bot.name, botId)
          break
        } catch (error) {
          dbg('waiting for connection / Bot: ' + (error?.message ?? error))
          await sleep(2000)
        }
      }
    }
    let buffer = typeof state.getUpdatesBuf === 'string' ? state.getUpdatesBuf : ''
    let backoff = 1000
    while (!controller.signal.aborted) {
      let batch
      try {
        batch = await getUpdates({
          baseUrl: config.weixin.baseUrl,
          token: config.weixin.token,
          getUpdatesBuf: buffer,
          timeoutMs: config.behavior.longPollTimeoutMs,
          signal: controller.signal,
        })
        backoff = 1000
      } catch (error) {
        if (controller.signal.aborted) break
        log.warn('bridge: getUpdates failed (%s), retrying in %dms', error?.message ?? error, backoff)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 60_000)
        continue
      }
      if (batch.get_updates_buf && batch.get_updates_buf !== buffer) {
        buffer = batch.get_updates_buf
        state.getUpdatesBuf = buffer
        writeState(config.stateFile, state)
      }
      for (const message of batch.msgs) {
        const from = String(message?.from_user_id ?? '')
        const text = messageText(message)
        if (!text) continue
        if (!config.allowUsers.includes(from)) {
          log.warn('bridge: ignored message from non-allowlisted user %s', from || '(unknown)')
          continue
        }
        const contextToken = typeof message?.context_token === 'string' ? message.context_token : undefined
        try {
          const baseTurn = await currentTurn(ctx, botId)
          await dsbot.send(ctx, botId, text)
          const reply = await waitForReply(ctx, botId, baseTurn, config.behavior, controller.signal, log)
          const body = reply || '(no reply from the Bot)'
          await sendTextChunked({
            baseUrl: config.weixin.baseUrl,
            token: config.weixin.token,
            toUserId: from,
            text: body.slice(0, config.behavior.maxReplyChars),
            contextToken,
            signal: controller.signal,
          })
        } catch (error) {
          log.error('bridge: turn failed: %s', error?.message ?? error)
          try {
            await sendTextChunked({
              baseUrl: config.weixin.baseUrl,
              token: config.weixin.token,
              toUserId: from,
              text: `桥接出错：${error?.message ?? error}`,
              contextToken,
            })
          } catch { /* best effort */ }
        }
      }
    }
    log.info('bridge: stopped')
  }

  const done = run().catch(error => {
    if (!controller.signal.aborted) log.error('bridge: loop crashed: %s', error?.stack ?? error)
  })

  return async () => {
    controller.abort()
    await done
  }
}
