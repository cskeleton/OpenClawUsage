# 设计规格：OpenClawUsage 完整测试方案（真实数据优先）

**日期**：2026-04-20  
**状态**：已实施（2026-04-20）

> **实施提交范围**：HEAD = `8d81da6`（从 `4c93f56` 开始，共 23 次提交）。最终测试数：111 通过 + 1 跳过（legacy 迁移 opt-in）；全量运行 1.01s；行覆盖率 84.89%（核心模块 ≥ 80%）。

## 目标

为 `OpenClawUsage` 建立可持续、可回归、可演进到 CI 的完整测试体系，满足以下目标：

1. 覆盖计费与聚合核心逻辑，优先保障数据口径正确性。
2. 通过真实 OpenClaw 样本提升测试可信度，避免“只在合成数据下正确”。
3. 保留对边界条件的可控验证能力（由定向合成数据补齐）。
4. 测试设计与仓库解耦于个人机器路径，为后续 GitHub Actions 做准备。

## 范围与原则

### 范围（本期）

- 后端核心模块单元测试：`aggregator.js`、`pricing.js`、`openclaw-config.js`、`stats-service.js`
- Express API 集成测试：`server.js` 的现有端点
- MCP 工具集成测试：`mcp-server.js` 的全部工具
- 前端纯逻辑测试：`src/util.js`、`src/i18n.js`、`src/theme.js`、日期过滤逻辑

### 非范围（本期）

- 前端浏览器 E2E（Playwright）
- 覆盖率阈值 gate 与 CI workflow 落地

### 设计原则

1. **真实数据优先**：优先使用脱敏后的真实会话样本作为回归基线。
2. **边界补齐**：真实样本覆盖不到的分支，由合成数据精确补充。
3. **环境可复现**：测试运行不依赖个人 `~/.openclaw` 实时状态。
4. **低侵入改造**：仅做必要的小规模结构调整以提升可测性。

## 数据策略：真实样本 + 定向合成

### 1) 真实样本引入流程

新增一次性脚本（建议路径：`scripts/extract-test-fixtures.js`），用于从本机 OpenClaw 数据抽取“可复现子集”：

1. **Sessions**：从 `$OPENCLAW_CONFIG_DIR/agents/main/sessions/` 选择代表性样本（多 provider、多 model、含 reset/deleted），复制到 `tests/fixtures/sessions-real/`。
2. **models.json**：从 `$OPENCLAW_CONFIG_DIR/agents/main/agent/models.json` 抽取并脱敏后落到 `tests/fixtures/models/models.real.json`，供 `openclaw-config.js` 相关测试使用。
3. 对敏感字段进行脱敏（会话内容、潜在用户路径、API Key、endpoint、base URL 等隐私字符串）。
4. 保留对统计 / 价格参考表有意义的字段（`provider`、`model`、`usage`、`timestamp`、文件名形态；models.json 中 `providers.*.models[*]` 的 `id`、`name`、`cost`、`contextWindow`、`maxTokens`）。
5. 产出固定样本清单（manifest）以便后续审计。

### 2) 脱敏规范（建议）

**Sessions**

- 对 `message.content`、`tool` 参数、自由文本字段做统一替换（例如 `<REDACTED_TEXT>`）。
- 对绝对路径（如 `/Users/...`）做路径脱敏。
- 保留并可选轻度泛化 `provider/model`（默认保留真实值，便于回归）。
- 保留 `usage` 与 `timestamp` 的数值与结构，以保证统计逻辑可验证。

**models.json**

- **凭据字段走"删除优先"策略**：`apiKey`、`apiSecret`、`token`、`authorization`、`headers` 等直接从 JSON 树中 `delete`，不保留空占位，杜绝误导阅读者以为此处曾有值。
- 删除 / 泛化自定义 `baseUrl`、`endpoint`、内部代理地址等（如需保留结构，可替换为 `https://example.invalid`）。
- 保留 `providers.<name>.models[]` 中 `id`、`name`、`cost`、`contextWindow`、`maxTokens` 等与价格参考表直接相关的结构化字段。
- 保留有价 / 缺价两类模型各自的多个代表样本，确保 `listOpenClawPricedModels` / `listUnpricedModels` 的分流逻辑可回归。

### 3) 定向合成数据补边界

在 `tests/fixtures/sessions-synth/` 中补充仅用于边界验证的数据：

- malformed JSONL 行（容错）
- `.checkpoint.*.jsonl`（跳过逻辑）
- `.jsonl.reset.`* / `.jsonl.deleted.`*（状态与归档时间）
- 价格匹配优先级冲突（exact / wildcard / regex）
- cache 定价回退（`cacheRead/cacheWrite` 缺失时回退 Input/Output 价）

## 测试架构

建议目录：

```text
tests/
  fixtures/
    sessions-real/
    sessions-synth/
    models/
      models.real.json      # 脱敏后的真实 models.json
      models.synth.json     # 最小合成样本（边界用）
    pricing/
  helpers/
    tmp-workspace.js
    fixture-loader.js
  unit/
  integration/
  setup.js
vitest.config.js
```

## 单元测试（unit）

- `aggregator`：
  - `normalizeArchivedAt`
  - `parseSessionFile`
- `pricing`：
  - `wildcardToRegex`
  - `parseRegexEntry`
  - `findMatchingPricing`
  - `calculateCostFromUsage`
  - `validatePricingConfig`
- `openclaw-config`：
  - `listOpenClawPricedModels` / `listUnpricedModels`：基于 `models.real.json` 验证有价 / 缺价模型分流；基于 `models.synth.json` 验证边界（空 providers、cost 为 0、cost 字段缺失）
- 前端纯逻辑：
  - `util`、`i18n`、`theme`
  - 日期过滤函数（必要时从 `main.js` 抽离为可导出模块）

## 集成测试（integration）

- `aggregateStats`：在临时目录加载真实+合成样本，验证 `summary` / `byDateProvider` / `byDateModel` 关键结果
- `stats-service`：验证 TTL 与 `pricing.updated` 触发失效
- `server API`：使用 `supertest` 覆盖 `/api/stats`、`/api/refresh`、`/api/pricing*`、`/api/openclaw/models`、`/api/pricing/models`
- `mcp tools`：覆盖工具清单与典型调用路径，验证返回结构与错误分支

## 环境隔离策略

测试统一通过 helper 注入环境变量与临时目录：

- `OPENCLAW_CONFIG_DIR`
- `OPENCLAW_DIR`
- 必要时隔离 `HOME`

每个 integration case 独立创建 tmpdir，结束后清理，避免缓存与文件状态污染。

### 已知陷阱（实施中发现）

1. **Legacy pricing 回退污染**：`pricing.js::loadPricingConfig` 有硬编码的 `~/.openclaw/openclaw-usage-pricing.json` 回退路径，**不受 `OPENCLAW_DIR` 影响**。任何断言"默认空配置"的测试必须二选一：
  - 在 tmp 工作区内先 `writePricingConfig(...)`
  - 或在测试局部 `renameSync` 将用户真实 legacy 文件暂存，`afterEach` 还原（非破坏性）
   测试套件中统一推荐策略：**集成测试显式传入 `pricingConfig` 参数**，绕过自动加载，彻底避免 legacy 污染。
2. **jsdom 29 `localStorage` 缺陷**：Vitest 4.x + jsdom 29 的 `localStorage` 不实现 Storage 接口（缺 `getItem/setItem/clear` 等方法）。前端测试必须安装 Map 支撑的 polyfill（当前在 `i18n.test.js` / `theme.test.js` 内联实现，后续可上提到 jsdom 专属 setup 文件）。
3. **MCP 模块级状态 + stats-service 缓存**：`stats-service.js` 含模块级缓存；每个集成 case 必须在 `beforeEach/afterEach` 调 `invalidateStatsCache()`。

## 工具与依赖

采用：

- `vitest@4.x`：统一测试框架（Node + jsdom 双 project）
- `@vitest/coverage-v8`：覆盖率
- `supertest`：API 集成测试
- `jsdom@29`：前端测试 DOM 环境

本期不引入 Playwright，不引入 CI 约束。

### Vite / 动态 import 陷阱

当测试需要绕过 ESM 模块缓存（如 `src/theme.js` 的 IIFE 重置），使用 query string cache-busting：

```js
const url = `../../../src/theme.js?t=${Date.now()}-${Math.random()}`;
await import(/* @vite-ignore */ url);
```

`**/* @vite-ignore */` 注释必须加**，否则 Vite 会以 "Unknown variable dynamic import" 为由拒绝。

## 分阶段实施计划

### Phase 1：测试基建与数据基线

1. 引入 `vitest` / `supertest` 与基础配置
2. 建立 `tests/` 目录与 helper
3. 完成真实样本抽取脚本与首批脱敏样本入库（含 sessions 与 `models.json`）

### Phase 2：核心逻辑覆盖

1. 完成 `pricing.js` 与 `aggregator.js` 的核心单元测试
2. 增加 `aggregateStats` 关键回归断言
3. 增加 `stats-service` 缓存行为测试

### Phase 3：接口与协议覆盖

1. 完成 Express API 集成测试
2. 完成 MCP 工具集成测试
3. 补齐前端纯逻辑测试

## 验收标准

1. `npm test` 可在无本地 OpenClaw 目录依赖时稳定通过。
2. 真实样本与合成样本均被纳入测试，并能稳定复现。
3. 至少覆盖一次价格规则优先级、会话文件状态解析、缓存失效逻辑。
4. 核心聚合输出（`summary`、`byDateProvider`、`byDateModel`）存在稳定断言。
5. 文档化“如何新增样本与如何脱敏”，确保后续可维护。

## GitHub Actions 前置兼容设计

虽然本期不接 CI，但需预留：

- 测试命令统一为 `npm test`（可直接用于 workflow）
- 测试运行期间不读取开发者本机绝对路径，只读取 `tests/fixtures/`（抽样脚本例外，它是一次性本地工具）
- 所有 fixture 与配置可随仓库版本管理

后续仅需新增 workflow 文件即可平滑切换到 PR 自动验证。

## 风险与对策

1. **真实样本泄露风险**：通过脚本化脱敏 + 人工抽检双重保障；`models.json` 的凭据字段走“删除优先”策略，不依赖替换。
2. **样本漂移风险**：固定样本集，不在测试阶段直接读实时目录。
3. **可测性不足风险**：对难测模块做最小结构调整（导出纯函数、工厂化 server 初始化）。

## 已实施的测试投资产出

23 次提交，净增 16 个测试文件：

- 11 个 unit 测试（5 pricing、1 aggregator、1 data-filter、1 util、1 i18n、1 theme、1 helpers）
- 5 个 integration 测试（pricing 配置 I/O、openclaw-config 模型分流、aggregateStats、stats-service 缓存、server API、mcp tools）

覆盖率 baseline（作为未来改进参考，本期不作 gate）：


| 模块                   | Lines  | Statements | 备注                          |
| -------------------- | ------ | ---------- | --------------------------- |
| `stats-service.js`   | 100%   | 100%       | 缓存三态 + forceFresh 全覆盖       |
| `openclaw-config.js` | 97.5%  | 89.58%     | models.json 分流完整测           |
| `aggregator.js`      | 95.23% | 93.41%     | real + synth 双数据集           |
| `data-filter.js`     | 88.33% | 86.11%     | 7 分支                        |
| `pricing.js`         | 81.15% | 81.37%     | 5 纯函数 + 集成                  |
| `mcp-server.js`      | 80%    | 81.39%     | 8 工具 + listTools            |
| `server.js`          | 75%    | 75.8%      | 7 端点 happy path（catch 分支未测） |
| `theme.js`           | 73.21% | 75%        | 6 场景                        |
| `i18n.js`            | 68.42% | 63.63%     | 主 API 覆盖；init 流程未直测         |


## 两次"低侵入"生产代码改造

1. `server.js` → 导出 `createApp()` 工厂 + `import.meta.url` listen 守卫
2. `mcp-server.js` → 导出 `createMcpServer()` 工厂 + `server.__handlers` 测试逃生口 + `import.meta.url` stdio 守卫
3. `src/main.js` → 抽出 `src/data-filter.js`（纯搬运，0 行为变化，Vite build 验证通过）

## 同步审计要求

实现完成后执行一次“规格-实现同步审计”（**已完成**，2026-04-20）：

- 真实样本已入库并脱敏（双层 redactor：message 白名单 + 全树 deepScrub）
- 边界合成数据已补齐（`edge-matrix.jsonl`、`models.synth.json`、`wildcard-and-regex.json`）
- 后端核心模块 + API + MCP + 前端纯逻辑全部覆盖
- 本规格已补写"Legacy pricing 回退"、"jsdom 29 localStorage"、"Vite 动态 import 限制" 三个实施期发现的陷阱

### 后续可选改进（本期未做）

- jsdom `localStorage` polyfill 上提到独立的 `tests/setup.jsdom.js`，避免前端测试各自内联
- `server.js` 的 error path（catch 分支）增加专项测试，把覆盖率拉到 85%+
- `i18n.js` 的 `detectInitialLocale` / `initLocaleControls` 直接覆盖
- 接入 GitHub Actions CI（spec 已做兼容设计，只差 workflow 文件）

