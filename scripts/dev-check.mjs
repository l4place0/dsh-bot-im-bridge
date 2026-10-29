// Dev check: validate the two halves of the bridge WITHOUT loading the plugin
// into the harness. Runs in its own process, so the host is never restarted.
//
//   node scripts/dev-check.mjs
//
// It does three things:
//   1. WeChat getUpdates  (proves the iLink token + long poll work)
//   2. DS Bot /api/bot    (proves inbound injection and reply reading work)
//   3. WeChat sendText    (proves outbound delivery works)
//
// The DS Bot call needs a browser cookie. It is bootstrapped from the launch
// token in %TEMP%\dsh-web.log, exactly like a browser does.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getUpdates, sendText, messageText } from '../lib/weixin.js'

const WEB = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const LOG = path.join(os.tmpdir(), 'dsh-web.log')

function bootToken() {
  const buffer = fs.readFileSync(LOG)
  // PowerShell's Tee-Object writes UTF-16LE with a BOM on Windows.
  const text = buffer[0] === 0xff && buffer[1] === 0xfe
    ? buffer.slice(2).toString('utf16le')
    : buffer.toString('utf8')
  const match = /token=([A-Za-z0-9_-]+)/.exec(text)
  if (!match) throw new Error('launch token not found in ' + LOG)
  return match[1]
}

async function apiCookie() {
  const response = await fetch(`${WEB}/?token=${bootToken()}`, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie?.() ?? []
  if (cookies.length === 0) throw new Error('no cookie from bootstrap (status ' + response.status + ')')
  return cookies.map(c => c.split(';')[0]).join('; ')
}

async function api(cookie, endpoint, payload = {}) {
  const response = await fetch(`${WEB}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })
  const body = await response.json()
  if (!body.ok) throw new Error(`${endpoint}: ${body.error?.message ?? JSON.stringify(body.error)}`)
  return body.value
}

function step(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

const token = process.env.DSH_WEIXIN_BOT_TOKEN
const owner = process.env.DSH_BOT_IM_TEST_USER
if (!token) throw new Error('DSH_WEIXIN_BOT_TOKEN is not set')
if (!owner) throw new Error('DSH_BOT_IM_TEST_USER is not set (e.g. o9cq...@im.wechat)')

console.log('--- 1. WeChat getUpdates ---')
const batch = await getUpdates({ baseUrl: 'https://ilinkai.weixin.qq.com/', token, timeoutMs: 8000 })
step('getUpdates', batch.ret === 0, `ret=${batch.ret} msgs=${batch.msgs.length}`)
for (const message of batch.msgs) {
  console.log('   inbound:', messageText(message).slice(0, 60) || '(non-text)')
}

console.log('--- 2. DS Bot /api/bot ---')
const cookie = await apiCookie()
const view = await api(cookie, 'state')
const bots = view.bots ?? []
step('state', bots.length > 0, `${bots.length} bots`)
const probeName = process.env.DSH_BOT_IM_TEST_BOT || '冲浪肥鱼'
const probe = bots.find(bot => bot.name === probeName)
if (!probe) throw new Error('probe bot not found: ' + probeName)
const before = await api(cookie, 'chat', { botId: probe.id })
const maxTurn = (before.items ?? []).reduce((n, item) => Math.max(n, item.turn ?? 0), 0)
step('chat read', true, `turns<${maxTurn}, items=${(before.items ?? []).length}`)

const prompt = process.env.DSH_BOT_IM_TEST_PROMPT || '这是一条桥接自测，请只回复两个字：收到'
await api(cookie, 'send', { sessionId: probe.id, text: prompt })
step('send', true, `-> ${probeName}`)

let reply = ''
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 1500))
  const page = await api(cookie, 'chat', { botId: probe.id })
  const fresh = (page.items ?? []).filter(item => item.kind === 'bot' && (item.turn ?? 0) > maxTurn)
  if (fresh.length > 0) reply = String(fresh.at(-1).text ?? '')
  if (reply) break
}
step('reply read', Boolean(reply), reply ? reply.slice(0, 80).replace(/\n/g, ' ') : 'no reply within 120s')

console.log('--- 3. WeChat sendText ---')
const marker = `【桥接自测 ${new Date().toLocaleTimeString('zh-CN')}】微信发送链路正常。`
await sendText({ baseUrl: 'https://ilinkai.weixin.qq.com/', token, toUserId: owner, text: marker })
step('sendText', true, '-> ' + owner)

console.log('done.')
