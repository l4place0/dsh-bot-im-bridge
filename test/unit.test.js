import test from 'node:test'
import assert from 'node:assert/strict'

import { chunkText, messageText, normalizeBaseUrl, WeixinError } from '../lib/weixin.js'
import { resolveConfig, ConfigError } from '../lib/config.js'

test('chunkText keeps short text whole', () => {
  assert.deepEqual(chunkText('你好'), ['你好'])
  assert.deepEqual(chunkText(''), [])
})

test('chunkText splits long text under the limit and loses nothing', () => {
  const line = 'x'.repeat(100)
  const source = Array.from({ length: 60 }, () => line).join('\n') // 6060 chars
  const chunks = chunkText(source, 1800)
  assert.ok(chunks.length >= 4)
  for (const chunk of chunks) assert.ok(chunk.length <= 1800)
  assert.equal(chunks.join('\n').replace(/\n+/g, ''), source.replace(/\n+/g, ''))
})

test('chunkText prefers a newline boundary', () => {
  const source = 'a'.repeat(1200) + '\n' + 'b'.repeat(1200)
  const [first] = chunkText(source, 1800)
  assert.equal(first.length, 1200)
})

test('messageText joins text items only', () => {
  const message = { item_list: [{ type: 1, text_item: { text: 'hi' } }, { type: 2, image_item: {} }, { type: 1, text_item: { text: 'there' } }] }
  assert.equal(messageText(message), 'hi\nthere')
  assert.equal(messageText({ item_list: [{ type: 2 }] }), '')
})

test('normalizeBaseUrl accepts wechat hosts and rejects others', () => {
  assert.equal(normalizeBaseUrl('https://ilinkai.weixin.qq.com/').hostname, 'ilinkai.weixin.qq.com')
  assert.equal(normalizeBaseUrl('https://ilinkai.weixin.qq.com').pathname, '/')
  assert.throws(() => normalizeBaseUrl('http://ilinkai.weixin.qq.com/'), WeixinError)
  assert.throws(() => normalizeBaseUrl('https://evil.example.com/'), WeixinError)
})

test('resolveConfig rejects an empty allowlist', () => {
  assert.throws(
    () => resolveConfig({ weixin: { token: 't' }, bot: { name: 'x' }, allowUsers: [] }, {}),
    ConfigError,
  )
})

test('resolveConfig rejects a missing token', () => {
  assert.throws(
    () => resolveConfig({ bot: { name: 'x' }, allowUsers: ['u'] }, {}),
    ConfigError,
  )
})

test('resolveConfig reads the token from the named env var', () => {
  const config = resolveConfig(
    { weixin: { tokenEnv: 'MY_TOKEN' }, bot: { name: '大肥鱼' }, allowUsers: ['u1'] },
    { MY_TOKEN: 'secret-token' },
  )
  assert.equal(config.weixin.token, 'secret-token')
  assert.equal(config.bot.name, '大肥鱼')
  assert.deepEqual(config.allowUsers, ['u1'])
})

test('resolveConfig defaults behavior and state path', () => {
  const config = resolveConfig({ weixin: { token: 't' }, bot: { name: 'x' }, allowUsers: ['u'] }, { DSH_HOME: 'C:/h' })
  assert.equal(config.behavior.pollIntervalMs, 1000)
  assert.ok(config.stateFile.replace(/\\/g, '/').endsWith('dsh-bot-im-bridge/state.json'))
})

test('disabled config is returned without validation', () => {
  const config = resolveConfig({ enabled: false }, {})
  assert.equal(config.enabled, false)
})
