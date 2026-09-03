## Learned User Preferences

- 在实现较大功能前，先同步更新设计说明（如 `README` / `README_EN`、`docs/superpowers/specs/` 下的规格），避免「静默改代码」。
- Web 界面视觉倾向参考 Mastercard / design-md 一类规范：浅色与深色主题，并提供浅色 / 深色 / 跟随系统 的主题切换。
- 前端 UI 调整偏好与现有页面风格统一（布局、间距、按钮尺寸与交互文案保持一致），避免出现突兀的新样式。
- 所有面向用户的文案（README、UI、MCP 工具 description 等）需中英双语同步更新（`README.md` ↔ `README_EN.md`）；MCP 工具 `name` / `inputSchema` 与错误信息暂保持英文/现状。
- 测试数据优先从本地 OpenClaw 抓取真实数据并脱敏作为基线，覆盖不足时再补合成样本；目标是可在 GitHub Actions CI 中稳定复现。
- 多步实施任务偏好 Subagent-Driven Development：implementer 用 auto 模型，主会话负责 review；完成后必须做 Post-Implementation Sync Audit，把实际实现与 spec 的偏差回写到 spec 保持单一事实源。
- 本机日常运行偏好类似 oc-switch 的可安装启动器（`openclaw-usage start/stop`），而不是长期依赖 `npm run dev` 临时进程，以便后台常驻与跨重启复用缓存。

## Learned Workspace Facts

- 自定义单价存放在 `openclaw-usage-pricing.json`（路径随 OpenClaw 工作区探测）；可选顶层 `enabled` 与每条规则的 `enabled`，用于在「按自定义 $/M 重算」与「使用会话里 OpenClaw 写入的 `usage.cost`」之间切换；Cache Read/Write 单价留空时均按该规则的 Input 原价计算。每条规则可选 `matchType`：`exact`（默认）、`wildcard`（键为 glob，作用于整串 `provider/model`）、`regex`（键为 `/pattern/flags`）；精确规则优先，其余按配置中的声明顺序匹配。
- `pricing.js` 中 `detectOpenClawDir()` 读取 `~/.openclaw/openclaw.json` 的 `agents.defaults.workspace` 时：值为目录则直接使用；若路径以 `.json` 结尾则取 `dirname`（兼容旧版将 workspace 写成文件路径），避免误解析到上级目录。
- 价格参考 API 从 `OPENCLAW_CONFIG_DIR`（默认 `~/.openclaw`）下 `openclaw.json` 的 `models.providers` 读取全部模型（OpenClaw 2026.8.2 起 `agents/main/agent/models.json` 不再生成，解析器兼容顶层 `providers` 旧形态），按有效 input/output 单价划分有价/缺价；`GET /api/openclaw/models` 返回两类列表，每条用 `findMatchingPricing` 附加 `custom`（含通配符/正则）。UI 中「实际可选模型」由 `openclaw.json` 的 `agents.defaults.models` 决定，与参考表非一一对应。
- MCP 侧与价格相关的聚合缓存以 `pricing.updated` 作为失效依据之一，以便开关或单价变更后能刷新，而不只依赖 `version`。
- 价格展示与配置文案统一使用 `$/M`；`Cache Read/Write` 单价留空语义为“均按该规则的 Input 原价计算”（非不支持缓存、也非额外折算）。
- 共享服务层 `stats-service.js` 统一供 HTTP（`server.js`）与 MCP（`mcp-server.js`）调用：`getStats` / `getPricingConfig` / `updatePricingConfig` / `refreshStatsCache` / `invalidateStatsCache`；HTTP 与 MCP 不再各自维护缓存副本。数据源为 **SQLite 只读**（`sqlite-source.js`，OpenClaw 2026.8.2+）：`agents/main/agent/openclaw-agent.sqlite` 的 `transcript_events`（活跃会话）+ `session_transcript_archives`（zstd 归档）+ `session_windows`（状态映射 running→active、其余→done；归档 reason deleted/reset 直通）。旧 JSONL 扫描（`aggregator.js`）已删除，不做向后兼容。持久化缓存为 **v2**（`stats-v2.json`，锁 `stats-v2.lock`，schemaVersion 2）：会话身份四元组 `(events, maxSeq, lastCreatedAt, watermark)`；`PRAGMA schema_version` 或数据库 inode 变化触发全量重建；v1 旧缓存在首次构建时冻结为 `legacy:<原文件名>` 贡献（与 SQLite 会话 id 零重合，防双计）。规格见 `docs/superpowers/specs/2026-09-03-sqlite-session-source.md` 与 `2026-08-01-persistent-incremental-stats-cache.md`。MCP 管理工具包括 `get_pricing_config` / `update_pricing_config` / `refresh_stats_cache`，所有工具 `description` 中英双语。
- SQLite 数据源注意：`node:sqlite`（`DatabaseSync`）与 zstd 解压要求 **Node ≥ 24**（`package.json` 已声明 engines）；每次 manifest/贡献构建各自开关只读连接（同步 API，进程内不长连）；OpenClaw 网关并发写为 WAL 模式，读侧无锁冲突；`event_json` 中 `message.provider === 'openclaw'` 的内部镜像消息必须过滤；归档 blob 为 zstd（`node:zlib.zstdDecompressSync`）或 identity 编码的原始 JSONL 文本。
- 前端 i18n 使用轻量自研方案（无第三方库）：入口 `src/i18n.js`，词典在 `src/locales/{zh-CN,en-US}.js`；语言持久化键为 `openclaw-locale`，切换时派发 `openclaw-localechange` 事件；`index.html` 与 `pricing.html` 头部各有 `locale-switch`；Phase 1 仅覆盖静态 UI/按钮文案，图表 label、相对时间、API 错误文本不在范围内。
- 测试栈使用 Vitest 双 project（Node + jsdom），辅助文件 `tests/setup.js` 与 `tests/helpers/{tmp-workspace,fixture-loader}.js`；脱敏样本生成脚本 `scripts/extract-test-fixtures.js`（从本机 SQLite 库抽取，`--limit`/`--per-session` 控制尺寸；`transcript_events` 与归档 blob 同口径脱敏——blob 解码逐行 redact 后按原 encoding 重编码并重算 sha256，生成后自检泄漏模式命中即退出 1）；fixture 位于 `tests/fixtures/{db,models,pricing,MANIFEST.json}`（`db/openclaw-agent.sqlite` 为真实脱敏库，含非 UUID 命名会话与 zstd 归档），并由 `MANIFEST.json` 索引。`tmp-workspace.js` 提供 `copyFixtureDb()` / `execSql()`（自动建最小 schema）/ `writeModelsJson()`（写 `openclaw.json`）。
- 为可测试化做的低侵入重构：`server.js` 暴露 `createApp()`；`mcp-server.js` 暴露 `createMcpServer()` 并通过 `server.__handlers` 暴露内部 handler 以便单测绕过 MCP transport；`src/main.js` 抽出 `src/data-filter.js`。
- 测试隔离已知陷阱：`loadPricingConfig` 硬编码回退到 `~/.openclaw/openclaw-usage-pricing.json`，不受 `OPENCLAW_DIR` 影响——测试须显式传 `pricingConfig` 或 stash legacy 文件；jsdom 29 的 `localStorage` 不实现 Storage 接口，需用 Map 支撑的 polyfill；Vite 对 template-literal 动态 import 路径需 `/* @vite-ignore */`。
- `.specstory/` 为本地 SpecStory 产物，已列入 `.gitignore` 并从仓库历史清除；勿重新纳入版本控制。
- 本机启动器类似 oc-switch：`./scripts/install-local-launcher.sh` 安装 `~/bin/openclaw-usage`（薄包装指向仓库内 `scripts/openclaw-usage-cli.js`），支持 `start` / `stop` / `status` / `build`；运行状态在 `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/serve.json`（需区分 missing / invalid / valid）；仓库移动后需重装。写接口经 `writeRequestGuard`：带 `Origin` 须同源或 loopback，`Content-Type` 须 `application/json` 或 `application/*+json`（与 `express.json` 的 `type` 对齐）。规格见 `docs/superpowers/specs/2026-08-01-local-launcher-like-oc-switch.md`。
