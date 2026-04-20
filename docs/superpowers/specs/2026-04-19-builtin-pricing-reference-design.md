# 设计规格：OpenClaw 内置价格参考与自定义价格开关

**日期**：2026-04-19  
**状态**：已实现  
**修订**：2026-04-20 — 与实现对齐：`unpricedModels` 的 `custom` 对照、缺少价格表列与文案、`agents.defaults.models` 说明；主页汇总卡片「总费用」置末。

## 目标

1. 在价格配置页展示 **models.json** 中已为模型声明有效单价的条目，便于判断是否需要自定义覆盖。
2. 支持两级开关：全局「启用自定义价格」与每条规则上的「启用」，用于在「按自定义单价重算的理论成本」与「会话 JSONL 中 OpenClaw 写入的账面成本」之间切换。

## 数据源

- **配置根目录**：`CONFIG_DIR = OPENCLAW_CONFIG_DIR ?? ~/.openclaw`（与 shell `OPENCLAW_CONFIG_DIR:-$HOME/.openclaw` 一致）。
- **模型目录文件**：`$CONFIG_DIR/agents/main/agent/models.json`，解析 `providers`（兼容根级 `models.providers`）。
- **参考表（有单价）**：上述文件中 **input/output 单价有效**（至少其一非零）的模型。
- **缺少价格的模型**：同一文件中 **无有效 input/output 单价** 的模型；与参考表在同一目录内 **互为补集**。
- **可选模型与参考表的关系**：`models.json` 列出的是目录中的模型元数据；**实际在 OpenClaw 里能选择的模型**取决于 `openclaw.json` 中 **`agents.defaults.models`** 的配置，与下方两张参考表中的条目 **并非一一对应**（页面说明与帮助文案需体现这一点）。
- **账面成本**：未启用自定义或某条规则关闭时，使用 `msg.usage.cost`（与既有 `calculateCostFromUsage` 中 `source: 'openclaw'` 行为一致）。

## 配置模型

`openclaw-usage-pricing.json` 可选字段：

- 顶层 `enabled`：`false` 时全局不使用自定义重算。
- `pricing[<provider/model>].enabled`：`false` 时该模型不使用自定义重算。
- `pricing[<provider/model>].cacheRead/cacheWrite`：可选；留空时表示不设单独缓存价，**Cache Read 与 Cache Write 均按该行 `input` 单价计算**。

缺省视为 `true`（向后兼容旧文件）。

## API

- `GET /api/openclaw/models`：
  - `models`：`models.json` 中带有效 `cost`（input/output 至少其一非零）的模型列表。对每条计算 `key = provider/model` 后，用与成本计算相同的 **`findMatchingPricing(key, pricingConfig.pricing)`**（支持精确 / 通配符 / 正则，见定价匹配规格）判断是否已有自定义规则；若命中则返回 `custom`：`input`、`output`、`cacheRead`、`cacheWrite`、`enabled`；未命中则为 `null`。
  - `unpricedModels`：同一 `models.json` 中缺少有效单价的模型；字段与 `models` 条目结构一致（含 `key`、`provider`、`model`、`displayName`、`cost`、`contextWindow`、`maxTokens`），同样通过 **`findMatchingPricing`** 附加 **`custom`**。响应中 **不** 再包含仅用于展示的 `sources` 字段。

## 前端

- 页面头部：全局开关「启用自定义价格」，变更后立即 `PUT /api/pricing` 并刷新。
- 自定义表：首列「启用」复选框；保存按钮写入文件。
- **OpenClaw 内置价格（参考）** 表：展示内置单价、**覆盖状态**徽章（未覆盖 / 已覆盖·启用 / 已覆盖·禁用；覆盖判断含通配符与正则）；「**复制为自定义**」「**定位规则**」；**每页最多 10 条**，分页；可折叠，默认折叠。副标题与帮助中说明 **`agents.defaults.models`** 与可选模型的关系。
- **缺少价格的模型（参考）** 表：展示 `unpricedModels`；列含 **Provider/Model、名称、Context、状态、操作**（**不**再展示 Input/Output 占位列或「来源 models.json」列）。状态与操作与内置表一致：**未覆盖** 时显示「**复制到自定义**」（仅填入模型键，单价需用户在「添加新价格」中自行填写）；**已覆盖** 时显示「**定位规则**」。**每页 10 条** 分页；可折叠，默认折叠。

## 仪表盘主页（汇总卡片）

- 首页 `summary-cards` 中 **「总费用」卡片排在最后一张**（在 Total / Input / Output / Cache Write / Sessions 之后），与 `src/main.js` 中 `renderSummaryCards` 顺序一致；图标 `nth-child` 样式与顺序对齐。

## MCP 缓存

- 聚合结果缓存以 `pricing.updated` 为失效键，确保任意保存（含开关）后数据刷新。
