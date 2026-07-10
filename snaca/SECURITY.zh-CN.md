# 安全策略

[English](./SECURITY.md) | 中文

SNACA 可以执行工具、调用 LLM provider、读取 workspace，并桥接 IM 插件。请把部署环境视为高权限自动化系统。

## 报告漏洞

请不要为疑似漏洞创建公开 issue。请私下联系项目维护者；如果仓库没有列出专门的安全联系方式，请使用 GitHub profile 上的维护者联系方式。

报告中请包含：

- 受影响版本或 commit。
- 复现步骤和预期影响。
- 是否涉及凭证、workspace 文件、IM 消息或工具执行。

## 部署注意事项

- 不要提交 `snaca.toml`、`.env`、SQLite 数据库、日志或本地 workspace 数据。
- provider 和插件凭证优先使用 `${VAR}` 占位符。
- 发布仓库前，轮换所有曾经写入本地配置文件的凭证。
- 多租户部署前，审查插件命令和 MCP server。
