## Learned User Preferences

- 在实现较大功能前，先同步更新设计说明（如 `README` / `README_EN`、`docs/superpowers/specs/` 下的规格），避免「静默改代码」。
- Web 界面视觉倾向参考 Mastercard / design-md 一类规范：浅色与深色主题，并提供浅色 / 深色 / 跟随系统 的主题切换。
- 前端 UI 调整偏好与现有页面风格统一（布局、间距、按钮尺寸与交互文案保持一致），避免出现突兀的新样式。
- 所有面向用户的文案（README、UI、MCP 工具 description 等）需中英双语同步更新（`README.md` ↔ `README_EN.md`）；MCP 工具 `name` / `inputSchema` 与错误信息暂保持英文/现状。
- 测试数据优先从本地 OpenClaw 抓取真实数据并脱敏作为基线，覆盖不足时再补合成样本；目标是可在 GitHub Actions CI 中稳定复现。
- 多步实施任务偏好 Subagent-Driven Development：implementer 用 auto 模型，主会话负责 review；完成后必须做 Post-Implementation Sync Audit，把实际实现与 spec 的偏差回写到 spec 保持单一事实源。

## Learned Workspace Facts

- 自定义单价存放在 `openclaw-usage-pricing.json`（路径随 OpenClaw 工作区探测）；可选顶层 `enabled` 与每条规则的 `enabled`，用于在「按自定义 $/M 重算」与「使用会话里 OpenClaw 写入的 `usage.cost`」之间切换；Cache 单价留空时按该行 Input/Output 原价计算。每条规则可选 `matchType`：`exact`（默认）、`wildcard`（键为 glob，作用于整串 `provider/model`）、`regex`（键为 `/pattern/flags`）；精确规则优先，其余按配置中的声明顺序匹配。
- `pricing.js` 中 `detectOpenClawDir()` 读取 `~/.openclaw/openclaw.json` 的 `agents.defaults.workspace` 时：值为目录则直接使用；若路径以 `.json` 结尾则取 `dirname`（兼容旧版将 workspace 写成文件路径），避免误解析到上级目录。
- 价格参考 API 从 `OPENCLAW_CONFIG_DIR`（默认 `~/.openclaw`）下的 `agents/main/agent/models.json` 读取全部模型，按有效 input/output 单价划分有价/缺价；`GET /api/openclaw/models` 返回两类列表，每条用 `findMatchingPricing` 附加 `custom`（含通配符/正则）。UI 中「实际可选模型」由 `openclaw.json` 的 `agents.defaults.models` 决定，与参考表非一一对应。
- MCP 侧与价格相关的聚合缓存以 `pricing.updated` 作为失效依据之一，以便开关或单价变更后能刷新，而不只依赖 `version`。
- 价格展示与配置文案统一使用 `$/M`；`Cache Read/Write` 单价留空语义为"按 Input/Output 原价计算"（非不支持缓存、也非额外折算）。
- 共享服务层 `stats-service.js` 统一供 HTTP（`server.js`）与 MCP（`mcp-server.js`）调用：`getStats` / `getPricingConfig` / `updatePricingConfig` / `refreshStatsCache` / `invalidateStatsCache`；HTTP 与 MCP 不再各自维护缓存副本。MCP 管理工具包括 `get_pricing_config` / `update_pricing_config` / `refresh_stats_cache`，所有工具 `description` 中英双语。
- 前端 i18n 使用轻量自研方案（无第三方库）：入口 `src/i18n.js`，词典在 `src/locales/{zh-CN,en-US}.js`；语言持久化键为 `openclaw-locale`，切换时派发 `openclaw-localechange` 事件；`index.html` 与 `pricing.html` 头部各有 `locale-switch`；Phase 1 仅覆盖静态 UI/按钮文案，图表 label、相对时间、API 错误文本不在范围内。
- 测试栈使用 Vitest 双 project（Node + jsdom），辅助文件 `tests/setup.js` 与 `tests/helpers/{tmp-workspace,fixture-loader}.js`；脱敏样本生成脚本 `scripts/extract-test-fixtures.js`；fixture 位于 `tests/fixtures/{sessions-real,sessions-synth,models,pricing,MANIFEST.json}`，并由 `MANIFEST.json` 索引。
- 为可测试化做的低侵入重构：`server.js` 暴露 `createApp()`；`mcp-server.js` 暴露 `createMcpServer()` 并通过 `server.__handlers` 暴露内部 handler 以便单测绕过 MCP transport；`src/main.js` 抽出 `src/data-filter.js`。
- 测试隔离已知陷阱：`loadPricingConfig` 硬编码回退到 `~/.openclaw/openclaw-usage-pricing.json`，不受 `OPENCLAW_DIR` 影响——测试须显式传 `pricingConfig` 或 stash legacy 文件；jsdom 29 的 `localStorage` 不实现 Storage 接口，需用 Map 支撑的 polyfill；Vite 对 template-literal 动态 import 路径需 `/* @vite-ignore */`。
