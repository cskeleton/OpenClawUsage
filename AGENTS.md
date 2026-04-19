## Learned User Preferences

- 在实现较大功能前，先同步更新设计说明（如 `README` / `README_EN`、`docs/superpowers/specs/` 下的规格），避免「静默改代码」。
- Web 界面视觉倾向参考 Mastercard / design-md 一类规范：浅色与深色主题，并提供浅色 / 深色 / 跟随系统 的主题切换。

## Learned Workspace Facts

- 自定义单价存放在 `openclaw-usage-pricing.json`（路径随 OpenClaw 工作区探测）；可选顶层 `enabled` 与每条规则的 `enabled`，用于在「按自定义 $/M 重算」与「使用会话里 OpenClaw 写入的 `usage.cost`」之间切换；Cache 单价留空时按该行 Input/Output 原价计算。
- `pricing.js` 中 `detectOpenClawDir()` 读取 `~/.openclaw/openclaw.json` 的 `agents.defaults.workspace` 时：值为目录则直接使用；若路径以 `.json` 结尾则取 `dirname`（兼容旧版将 workspace 写成文件路径），避免误解析到上级目录。
- 价格参考 API 从 `OPENCLAW_CONFIG_DIR`（默认 `~/.openclaw`）下的 `agents/main/agent/models.json` 读取全部模型，按有效 input/output 单价划分有价/缺价；`GET /api/openclaw/models` 返回两类列表并与当前自定义规则做对照。
- MCP 侧与价格相关的聚合缓存以 `pricing.updated` 作为失效依据之一，以便开关或单价变更后能刷新，而不只依赖 `version`。
