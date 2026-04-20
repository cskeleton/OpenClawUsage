## Learned User Preferences

- 在实现较大功能前，先同步更新设计说明（如 `README` / `README_EN`、`docs/superpowers/specs/` 下的规格），避免「静默改代码」。
- Web 界面视觉倾向参考 Mastercard / design-md 一类规范：浅色与深色主题，并提供浅色 / 深色 / 跟随系统 的主题切换。
- 前端 UI 调整偏好与现有页面风格统一（布局、间距、按钮尺寸与交互文案保持一致），避免出现突兀的新样式。

## Learned Workspace Facts

- 自定义单价存放在 `openclaw-usage-pricing.json`（路径随 OpenClaw 工作区探测）；可选顶层 `enabled` 与每条规则的 `enabled`，用于在「按自定义 $/M 重算」与「使用会话里 OpenClaw 写入的 `usage.cost`」之间切换；Cache 单价留空时按该行 Input/Output 原价计算。每条规则可选 `matchType`：`exact`（默认）、`wildcard`（键为 glob，作用于整串 `provider/model`）、`regex`（键为 `/pattern/flags`）；精确规则优先，其余按配置中的声明顺序匹配。
- `pricing.js` 中 `detectOpenClawDir()` 读取 `~/.openclaw/openclaw.json` 的 `agents.defaults.workspace` 时：值为目录则直接使用；若路径以 `.json` 结尾则取 `dirname`（兼容旧版将 workspace 写成文件路径），避免误解析到上级目录。
- 价格参考 API 从 `OPENCLAW_CONFIG_DIR`（默认 `~/.openclaw`）下的 `agents/main/agent/models.json` 读取全部模型，按有效 input/output 单价划分有价/缺价；`GET /api/openclaw/models` 返回两类列表，每条用 `findMatchingPricing` 附加 `custom`（含通配符/正则）。UI 中「实际可选模型」由 `openclaw.json` 的 `agents.defaults.models` 决定，与参考表非一一对应。
- MCP 侧与价格相关的聚合缓存以 `pricing.updated` 作为失效依据之一，以便开关或单价变更后能刷新，而不只依赖 `version`。
- 价格展示与配置文案统一使用 `$/M`；`Cache Read/Write` 单价留空语义为“按 Input/Output 原价计算”（非不支持缓存、也非额外折算）。
