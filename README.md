# dsh-bot-im-bridge

[简体中文](README.zh.md) | English

Bridge **WeChat** to a **DS Bot**: talk to one of your Bots from WeChat.

A **standard DeepSeek Harness plugin** (host-side cordis plugin), used together with [DS Bot](https://github.com/Fei2411/DeepSeek-Bot).

## Why not an existing IM plugin

Community IM plugins bind a WeChat chat to **one DSH session**. But a DS Bot is a long-lived conversation that **rotates to a fresh session** ("part") as it grows. Bind a session id and the next rotation breaks it: inbound is still forwarded to the current part, but the reply lands in the new part, so WeChat never receives it.

This plugin sidesteps that entirely. It does **not bind a session**; it calls DS Bot's own `POST /api/bot`. Its `send` action maps a **Bot id** (or any earlier part) to the Bot's **current part** — see DS Bot's `src/host/channel.js`. Rotation no longer matters.

```
WeChat iLink  <->  dsh-bot-im-bridge  <->  POST /api/bot  <->  DS Bot
```

## Prerequisites

1. **DS Bot** plugin installed, with a Bot you want to talk to.
2. A **WeChat iLink bot token**.
3. **Stop any other WeChat channel.** Only one `getupdates` long-poll may run per WeChat bot; two will steal messages from each other. If you run `@xmanrui/dsh-im` or similar, disable its WeChat channel or uninstall it first.

## Install

Fully quit the harness, then (use your real profile):

```sh
dsh plugin --profile web add github:l4place0/dsh-bot-im-bridge
# or, from a local checkout
dsh plugin --profile web add D:\l4place\Workspace\dsh-bot-im-bridge
```

Then configure it in the profile's `cordis.patch.yml` (below) and restart `dsh web`.

## Configuration

```yaml
- id: dsh-bot-im-bridge
  name: dsh-bot-im-bridge
  config:
    enabled: true

    # The DS Bot to talk to (exact name; or set id)
    bot:
      name: BigFish

    weixin:
      baseUrl: https://ilinkai.weixin.qq.com/
      # read the token from an env var; never put secrets in yaml
      tokenEnv: DSH_WEIXIN_BOT_TOKEN

    # Allowlist. An empty list refuses to start.
    allowUsers:
      - o9cq80-xxxxxxxxxxxxxxxxxxx@im.wechat

    behavior:
      pollIntervalMs: 1000
      quietMs: 3000
      maxWaitMs: 180000
      longPollTimeoutMs: 35000
      maxReplyChars: 20000
```

The env var named by `tokenEnv` must exist in the environment that starts `dsh web`.

## How it works

1. Long-poll `ilink/bot/getupdates`, persisting the cursor to `$DSH_HOME/dsh-bot-im-bridge/state.json`.
2. Handle **plain text** from allowlisted users only.
3. Record the Bot's current max `turn`, then `send` the user's text.
4. Poll `chat`, collect Bot messages with a greater `turn` until it goes quiet for `quietMs`, and take the **last** one as the reply.
5. Send it back to WeChat in chunks (<=1800 chars), carrying `context_token`.

## Limits (v0.1)

- **Text only.** Images / files / voice are ignored.
- **One WeChat bot <-> one DS Bot.**
- Only the **last** Bot message is sent; intermediate progress notes are not pushed one by one.
- Depends on DS Bot's `POST /api/bot` route.
- Calls that route in-process via `ctx.connection.fetch` + `ctx.connection.browserPeer` — no port, no token.

## Security

- An empty allowlist refuses to start, so it can never become an open gateway.
- HTTPS only, and the host must be `*.weixin.qq.com`, so the token cannot be sent elsewhere.
- The token is read from env/config and never logged.
- Intended for personal use; do not add it to group chats.

## Develop

```sh
node --check lib/index.js
node --test test/
```

## License

MIT. WeChat iLink protocol details were informed by the public, MIT-licensed implementation in `@xmanrui/dsh-im`.
