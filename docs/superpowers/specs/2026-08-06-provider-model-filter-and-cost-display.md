# 设计规格：Provider / Model 维度筛选与费用展示

**日期**：2026-08-06
**状态**：已实施（2026-08-06）

## 目标

1. 在仪表盘上按 **Provider** 或 **Provider/Model** 筛选，与既有时间区间筛选叠加，直接回答「某个 provider / 某个模型在某段时间花了多少」。
2. 新增 **Provider / Model 消耗明细表**：tokens 各分量、费用、费用占比、请求数，可排序、可点击行直接下钻为筛选条件。
3. 按日趋势图增加 **费用视图**，与既有 Token 视图切换。

## 决策（用户确认）

| 议题 | 结论 |
| --- | --- |
| 筛选器作用范围 | **全局**：Summary 卡片、全部图表、Session 明细表统一按 provider/model 重算 |
| 费用展示位置 | 新增 Provider/Model 明细表；趋势图增加费用视图 |
| Session 明细精度 | **精确到 model**：需在后端为每个 session 增加「日期 × provider/model」交叉表 |

## 数据模型变更（后端）

每个 session 增加 `byDateModel`，与既有 `byDate` 并存：

```jsonc
{
  "id": "…",
  "byDate":      { "2026-08-05": { input, output, cacheRead, cacheWrite, totalTokens, totalCost, requests } },
  "byDateModel": { "2026-08-05": { "anthropic/claude-opus-5": { …同上… } } }
}
```

- `byDate` 是 `byDateModel` 在模型维度上的边缘和，**刻意保留冗余**：未选 provider/model 时（最常见路径）直接累加 `byDate`，比遍历交叉表便宜 M 倍，且保持对既有消费方与旧快照的兼容。
- 顶层 `byDateProvider` / `byDateModel` 早已存在，无需变更；provider/model 筛选下的 `summary`、`byProvider`、`byModel`、`byDate` 全部由顶层交叉表切片得出。
- 两条聚合链路（`aggregator.js` 的一次性全量聚合、`stats-contribution.js` 的增量合并）必须同时产出 `byDateModel`，否则增量与全量结果不一致。

## 缓存兼容：`statsShapeVersion`

持久化快照 `stats-v1.json` 同时存 **逐文件贡献 `files`** 与 **合并结果 `stats`**。本次只有「合并结果的形状」发生变化，逐文件贡献结构不变。

因此**不递增** `CACHE_SCHEMA_VERSION`（那会强制重新解析全部 JSONL），改为新增 `statsShapeVersion`：

- 写盘时记录 `statsShapeVersion: STATS_SHAPE_VERSION`（当前为 `2`）。
- 读盘复用 `diskCache.stats` 前，除定价指纹外还需校验 `statsShapeVersion` 一致；不一致则**从 `files` 重新合并**（纯内存计算，不解析 JSONL），从而让旧快照在一次请求内自动补齐 `byDateModel`。
- 缺少该字段的旧快照按 `1` 处理。

## 前端筛选语义

`src/data-filter.js` 新增 `filterData(fullData, { from, to, provider, model })`；`filterDataByDateRange(fullData, from, to)` 保留为其薄封装。

- `provider` 命中规则：`modelKey` 以 `"<provider>/"` 开头。
- `model` 传入完整 `provider/model` 键，精确匹配；同时给出 `provider` 时以 `model` 为准。
- 命中范围内重算 `byDate`（供趋势图）、`byProvider`、`byModel`、`sessions`、`summary`。
- Session 行：以 `s.byDateModel` 按「日期 ∩ 键」切片；旧快照缺 `byDateModel` 时回退为「按 `providers` / `models` 列表判断是否保留整行」，数字为该会话在时间段内的全量合计（保守回退，不静默丢数据）。
- `summary.totalSessions` 为筛选后剩余会话数。

## UI

| 位置 | 变更 |
| --- | --- |
| 筛选栏 | 时间栏下方新增维度行：Provider 下拉、Model 下拉（随 Provider 联动收窄）、「清除筛选」按钮；当前筛选以 chip 形式回显 |
| 趋势图 | 标题行增加 `Token / 费用` 切换；费用视图为单条 amber 曲线，Y 轴与 tooltip 用 `$` 格式化 |
| 明细表 | 新增区块，`按 Provider / 按 Model` 两个维度切换；列：维度、Input、Output、Cache Read、Cache Write、Total Tokens、费用($)、占比、请求数；表头点击排序；点击数据行把该行设为筛选条件 |
| Session 表 | 不变，但数字随 provider/model 筛选重算 |

文案全部走 `src/i18n.js`，`zh-CN` / `en-US` 同步；顺带把 `charts.js` 中三处硬编码中文空态文案接入 i18n。

## 测试

- `tests/unit/frontend/data-filter.test.js`：provider / model 筛选下的 `byDate`、`byProvider`、`byModel`、`sessions`、`summary`；旧快照回退路径。
- `tests/integration/aggregator/aggregate-stats.test.js`：`session.byDateModel` 结构，且为 `byDate` 的边缘和。
- `tests/integration/stats-service/`：旧形状快照（`statsShapeVersion` 缺失/过期）触发重新合并且不重新解析 JSONL。

## 未纳入范围

- 明细表导出 CSV。
- provider/model 筛选写入 URL query（刷新后不保持筛选状态）。
- MCP 侧新增按 provider/model 的查询工具。
