// dsh-bot-im-bridge: talk to a DS Bot from WeChat.
//
// A DeepSeek Harness host plugin. It long-polls a WeChat iLink bot, forwards
// each allowed user's text to the configured DS Bot through the Bot plugin's
// own `/api/bot` route, reads the reply back, and sends it to WeChat.
//
// Mount it through this package's cordis.patch.yml (see README for config).

import { resolveConfig } from './config.js'
import { startBridge } from './bridge.js'

/** Plugin name registered with the Loader. */
const name = 'dsh-bot-im-bridge'

/** The route dispatcher and the owner peer come from the connection service. */
const inject = ['connection']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} raw plugin config
 */
function apply(ctx, raw = {}) {
  const logger = ctx.logger
  let config
  try {
    config = resolveConfig(raw, process.env)
  } catch (error) {
    // A misconfiguration must not take the whole host down. Say exactly what is
    // wrong and stay inert until it is fixed and the host is restarted.
    logger.error('dsh-bot-im-bridge: configuration rejected, bridge not started: %s', error?.message ?? error)
    return
  }
  if (!config.enabled) {
    logger.info('dsh-bot-im-bridge: disabled by config')
    return
  }
  logger.info(
    'dsh-bot-im-bridge: starting, Bot=%s, allowUsers=%d, state=%s',
    config.bot.id || config.bot.name,
    config.allowUsers.length,
    config.stateFile,
  )
  ctx.effect(() => {
    const dispose = startBridge({ ctx, config, logger })
    return () => { void dispose() }
  }, 'dsh-bot-im-bridge: WeChat bridge')
}

export { apply, inject, name }
