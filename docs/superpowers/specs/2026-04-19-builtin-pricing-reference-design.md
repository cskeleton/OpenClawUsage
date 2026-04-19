# 设计规格：OpenClaw 内置价格参考与自定义价格开关

**日期**：2026-04-19  
**状态**：已实现

## 目标

1. 在价格配置页展示 **models.json** 中已为模型声明有效单价的条目，便于判断是否需要自定义覆盖。
2. 支持两级开关：全局「启用自定义价格」与每条规则上的「启用」，用于在「按自定义单价重算的理论成本」与「会话 JSONL 中 OpenClaw 写入的账面成本」之间切换。

## 数据源

- **配置根目录**：`CONFIG_DIR = OPENCLAW_CONFIG_DIR ?? ~/.openclaw`（与 shell `OPENCLAW_CONFIG_DIR:-$HOME/.openclaw` 一致）。
- **模型目录文件**：`$CONFIG_DIR/agents/main/agent/models.json`，解析 `providers`（兼容根级 `models.providers`）。
- **参考表（有单价）**：上述文件中 **input/output 单价有效**（至少其一非零）的模型。
- **缺少价格的模型**：同一文件中 **无有效 input/output 单价** 的模型；与参考表在同一目录内 **互为补集**。
- **账面成本**：未启用自定义或某条规则关闭时，使用 `msg.usage.cost`（与既有 `calculateCostFromUsage` 中 `source: 'openclaw'` 行为一致）。

## 配置模型

`openclaw-usage-pricing.json` 可选字段：

- 顶层 `enabled`：`false` 时全局不使用自定义重算。
- `pricing[<provider/model>].enabled`：`false` 时该模型不使用自定义重算。

缺省视为 `true`（向后兼容旧文件）。

## API

- `GET /api/openclaw/models`：
  - `models`：`models.json` 中带有效 `cost`（input/output 至少其一非零）的模型列表，并与当前自定义配置 join，字段 `custom` 表示是否已有同名规则及是否启用。
  - `unpricedModels`：同一 `models.json` 中缺少有效单价的模型；每项含 `key`、`provider`、`model`、`displayName`、`cost`（可为 `null`）、`contextWindow`、`maxTokens`、`sources`（当前为 `modelsJson`）。

## 前端

- 页面头部：全局开关「启用自定义价格」，变更后立即 `PUT /api/pricing` 并刷新。
- 自定义表：首列「启用」复选框；保存按钮写入文件。
- 参考表：展示内置单价、覆盖状态徽章；「复制为自定义」「定位规则」使用紧凑行内按钮样式；**每页最多 10 条**，超出部分分页浏览；可折叠，默认折叠。
- **缺少价格的模型（参考）** 卡片：展示 `unpricedModels`，列含 Provider/Model、名称、Context、单价列（占位「—」）、来源；同样 **每页 10 条** 分页；可折叠，默认折叠。

## MCP 缓存

- 聚合结果缓存以 `pricing.updated` 为失效键，确保任意保存（含开关）后数据刷新。
