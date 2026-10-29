// Proactive push: send a WeChat message using the newest stored context_token.
//
// iLink only accepts a message that carries a context_token, and the token
// comes from the most recent inbound message. The bridge stores it in
// $DSH_HOME/dsh-bot-im-bridge/state.json as contextTokens[userId].
//
// Usage:
//   node scripts/push.mjs "text to send"
//   node scripts/push.mjs "text" --user o9cq...@im.wechat
//
// Exit codes: 0 sent; 2 token missing or rejected (fall back to the GUI);
// 3 bad arguments.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendText, WeixinError } from '../lib/weixin.js'

const args = process.argv.slice(2)
const text = args.find(a => !a.startsWith('--'))
const userFlag = args.indexOf('--user')
const wantUser = userFlag >= 0 ? args[userFlag + 1] : process.env.DSH_BOT_IM_PUSH_USER

if (!text) {
  console.error('usage: node scripts/push.mjs "text" [--user <wechatUserId>]')
  process.exit(3)
}

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const statePath = path.join(home, 'dsh-bot-im-bridge', 'state.json')
let state
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
} catch {
  console.error(`no bridge state at ${statePath}`)
  process.exit(2)
}
const tokens = state.contextTokens || {}
const user = wantUser || Object.keys(tokens)[0]
const contextToken = user ? tokens[user] : undefined
if (!contextToken) {
  console.error('no context token stored for ' + (user || '(any user)') + '; the user must message the Bot first')
  process.exit(2)
}

const token = process.env.DSH_WEIXIN_BOT_TOKEN
if (!token) {
  console.error('DSH_WEIXIN_BOT_TOKEN is not set')
  process.exit(2)
}

try {
  await sendText({
    baseUrl: process.env.DSH_WEIXIN_BASE_URL || 'https://ilinkai.weixin.qq.com/',
    token,
    toUserId: user,
    text,
    contextToken,
  })
  console.log('SENT')
  process.exit(0)
} catch (error) {
  if (error instanceof WeixinError && error.code === 'send-rejected') {
    console.error('NOT-DELIVERED: token expired or rejected (ret=' + error.providerCode + '); fall back to the GUI')
    process.exit(2)
  }
  console.error('FAILED: ' + (error?.message ?? error))
  process.exit(2)
}
