# dsh-bot-im-bridge

简体中文 | [English](README.md)

把 **微信** 接到 **DS Bot**：在微信里跟你的某个 Bot 说话。

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个**标准插件**（host 侧 cordis 插件），配合 [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) 使用。

## 为什么不用现成的 IM 插件

社区 IM 插件是把微信聊天**绑定到一个 DSH 会话**。但 DS Bot 的每个 Bot 是一个长期对话，聊长了会**换段**（换到新的 Session）。绑定会话 id，下一次换段就断线——入站还能转发过去，回复却回到新段，微信里再也等不到。

本插件绕开这件事：它**不绑会话**，而是调 DS Bot 自己的 `POST /api/bot`。该接口的 `send` 动作对 `sessionId` 传 Bot id 时会**自动路由到当前段**（DS Bot 源码 `src/host/channel.js` 明确如此）。所以 Bot 怎么换段都不影响。

```
微信 iLink  ⇄  dsh-bot-im-bridge  ⇄  POST /api/bot  ⇄  DS Bot
```

## 前置条件

1. **DS Bot 插件已装好**，且有一个你想在微信里对话的 Bot。
2. **一个微信 iLink 机器人**（bot token）。可以用别的 IM 插件扫码拿到，也可以自行申请。
3. **必须停用其它插件的微信通道。** 同一个微信 bot 只能有一个 `getupdates` 长轮询；两个同时跑会互相抢消息。装了 `@xmanrui/dsh-im` 之类的，先在它的设置里关掉微信渠道或卸载它。

## 安装

先完全退出 harness，再执行（profile 按你实际的来）：

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:l4place0/dsh-bot-im-bridge

# 或从本地目录安装
dsh plugin --profile web add D:\l4place\Workspace\dsh-bot-im-bridge
```

装完在 profile 的 `cordis.patch.yml` 里配置（见下），再重启 `dsh web`。

## 配置

```yaml
- id: dsh-bot-im-bridge
  name: dsh-bot-im-bridge
  config:
    enabled: true

    # 微信要对话的那个 DS Bot（名字要完全一致；也可用 id）
    bot:
      name: 大肥鱼

    weixin:
      baseUrl: https://ilinkai.weixin.qq.com/
      # 从环境变量读 token，别把密钥写进 yaml
      tokenEnv: DSH_WEIXIN_BOT_TOKEN

    # 白名单：只有这些微信用户 id 能说话。**空列表会拒绝启动。**
    allowUsers:
      - o9cq80-xxxxxxxxxxxxxxxxxxx@im.wechat

    # 可选，调默认值
    behavior:
      pollIntervalMs: 1000     # 取回复的轮询间隔
      quietMs: 3000            # 回复停止增长多久算说完
      maxWaitMs: 180000        # 单轮最多等多久
      longPollTimeoutMs: 35000 # 微信长轮询超时
      maxReplyChars: 20000     # 单次回复截断上限
```

`tokenEnv` 指向的环境变量要在启动 `dsh web` 的环境里存在。也可以在 `weixin.token` 里直接写（不推荐，会进版本库）。

微信用户 id 的获取：机器人收到任何消息时会把发送者 id 写进宿主日志（`bridge: ignored message from non-allowlisted user <id>`），把那个 id 加进白名单即可。

## 工作方式

1. 长轮询 `ilink/bot/getupdates`，游标持久化到 `$DSH_HOME/dsh-bot-im-bridge/state.json`。
2. 只处理白名单用户的**纯文本**；其余忽略。
3. 记录该 Bot 当前最大 `turn`，然后 `send` 一条用户消息。
4. 轮询 `chat`，收集 `turn` 变大之后的 Bot 消息，直到安静 `quietMs`，取**最后一条**作为回复。
5. 分片（每片 ≤1800 字）发回微信，带 `context_token`。

## 已知限制（v0.1）

- **只支持文本**。图片、文件、语音不处理（入站非文本会被忽略）。
- **一个微信机器人 ↔ 一个 DS Bot**。多对多以后再说。
- **只取最后一条 Bot 消息**作为回复；Bot 中间的过程说明不会逐条推送。
- 依赖 DS Bot 的 `POST /api/bot` 接口；它若改名，本插件要跟着改。
- 进程内通过 `ctx.connection.fetch` + `ctx.connection.browserPeer` 调该接口，不占端口、不用 token。

## 安全

- 白名单为空直接拒绝启动，避免变成对外的开放网关。
- 只允许 https 且域名必须是 `*.weixin.qq.com`，防止把 token 发到别处。
- token 只从环境变量或配置读，不写日志。
- 建议把微信机器人设为个人使用，不要拉群。

## 开发

```sh
node --check lib/index.js
node --test test/
```

## 许可

MIT。微信 iLink 的协议细节参考了社区插件 `@xmanrui/dsh-im` 的公开实现（同样 MIT）。
