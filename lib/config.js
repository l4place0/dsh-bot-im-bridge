// Plugin configuration: defaults, validation, and secret resolution.

import path from 'node:path'
import os from 'node:os'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function num(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function home() {
  return str(process.env.DSH_HOME) || path.join(os.homedir(), '.dsh')
}

/**
 * Resolve the raw plugin config into a validated shape.
 * @param {object} raw plugin config from cordis.patch.yml
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveConfig(raw = {}, env = process.env) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const enabled = config.enabled !== false

  const weixinRaw = config.weixin && typeof config.weixin === 'object' ? config.weixin : {}
  const tokenEnv = str(weixinRaw.tokenEnv, 'DSH_WEIXIN_BOT_TOKEN')
  const token = str(weixinRaw.token) || str(env[tokenEnv])
  const baseUrl = str(weixinRaw.baseUrl, 'https://ilinkai.weixin.qq.com/')

  const botRaw = config.bot && typeof config.bot === 'object' ? config.bot : {}
  const botName = str(botRaw.name)
  const botId = str(botRaw.id)

  const allowUsers = Array.isArray(config.allowUsers)
    ? config.allowUsers.map(item => str(item)).filter(Boolean)
    : []

  const behaviorRaw = config.behavior && typeof config.behavior === 'object' ? config.behavior : {}
  const behavior = {
    pollIntervalMs: num(behaviorRaw.pollIntervalMs, 1000, { min: 200, max: 30_000 }),
    quietMs: num(behaviorRaw.quietMs, 3000, { min: 500, max: 60_000 }),
    maxWaitMs: num(behaviorRaw.maxWaitMs, 180_000, { min: 5000, max: 1_800_000 }),
    longPollTimeoutMs: num(behaviorRaw.longPollTimeoutMs, 35_000, { min: 5000, max: 120_000 }),
    maxReplyChars: num(behaviorRaw.maxReplyChars, 20_000, { min: 100, max: 200_000 }),
  }

  const stateFile = str(config.stateFile) || path.join(home(), 'dsh-bot-im-bridge', 'state.json')

  const result = { enabled, weixin: { baseUrl, token, tokenEnv }, bot: { name: botName, id: botId }, allowUsers, behavior, stateFile }

  if (!enabled) return result

  if (!token) throw new ConfigError(`WeChat bot token is missing: set weixin.token or the ${tokenEnv} env var`)
  if (!botName && !botId) throw new ConfigError('bot.name (or bot.id) is required: which DS Bot should WeChat talk to?')
  if (allowUsers.length === 0) {
    throw new ConfigError('allowUsers is empty: refusing to run an open WeChat gateway. List the WeChat user ids allowed to talk to this Bot.')
  }
  return result
}
