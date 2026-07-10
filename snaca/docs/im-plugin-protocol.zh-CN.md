# SNACA IM 插件协议

[English](./im-plugin-protocol.md) | 中文

本文是 [im-plugin-protocol.md](./im-plugin-protocol.md) 的中文版本入口，概述 SNACA host 与 IM 插件之间的 JSON-RPC 协议。

## 状态

- 协议版本：`1.0` draft。
- 稳定性：`0.x` 阶段仍可能调整。
- 默认传输：stdio，按换行分隔 UTF-8 JSON。
- 可选传输：WebSocket，适合远程插件。

## 角色

SNACA host 启动插件子进程，注入 `SNACA_PLUGIN_TOKEN`，并通过 JSON-RPC 调用插件发送消息、上传文件、展示审批卡片等。插件通过 notification 把 IM 事件推回 host。

## 典型方法

- `initialize`
- `shutdown`
- `health.ping`
- `message.send`
- `message.update`
- `card.send`
- `approval.present`
- `file.upload`
- `file.download`
- `acknowledge`

## 认证

插件向 host 发起 reverse call 时必须携带 host 注入的 token。host 会丢弃缺失或不匹配 token 的请求。

完整字段、事件和错误码以英文规范 [im-plugin-protocol.md](./im-plugin-protocol.md) 为准；修改协议时请同步维护两个版本。
