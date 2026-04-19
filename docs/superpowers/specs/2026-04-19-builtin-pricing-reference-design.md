# 设计规格：OpenClaw 内置价格参考与自定义价格开关

**日期**：2026-04-19  
**状态**：已实现

## 目标

1. 在价格配置页展示 OpenClaw 在 `openclaw.json` 中已为模型声明的单价（`models.providers[].models[].cost`），便于判断是否需要自定义覆盖。
2. 支持两级开关：全局「启用自定义价格」与每条规则上的「启用」，用于在「按自定义单价重算的理论成本」与「会话 JSONL 中 OpenClaw 写入的账面成本」之间切换。

## 数据源

- **参考表**：仅读取 OpenClaw 的 `openclaw.json`（路径解析与 `openclaw-usage-pricing.json` 一致：优先工作目录，其次 `~/.openclaw/openclaw.json`）。
- **账面成本**：未启用自定义或某条规则关闭时，使用 `msg.usage.cost`（与既有 `calculateCostFromUsage` 中 `source: 'openclaw'` 行为一致）。

## 配置模型

`openclaw-usage-pricing.json` 可选字段：

- 顶层 `enabled`：`false` 时全局不使用自定义重算。
- `pricing[<provider/model>].enabled`：`false` 时该模型不使用自定义重算。

缺省视为 `true`（向后兼容旧文件）。

## API

- `GET /api/openclaw/models`：返回 `openclaw.json` 中带有效 `cost` 的模型列表，并与当前自定义配置 join，字段 `custom` 表示是否已有同名规则及是否启用。

## 前端

- 页面头部：全局开关「启用自定义价格」，变更后立即 `PUT /api/pricing` 并刷新。
- 自定义表：首列「启用」复选框；保存按钮写入文件。
- 参考表：展示内置单价、覆盖状态徽章；「复制为自定义」「定位规则」辅助操作。

## MCP 缓存

- 聚合结果缓存以 `pricing.updated` 为失效键，确保任意保存（含开关）后数据刷新。
