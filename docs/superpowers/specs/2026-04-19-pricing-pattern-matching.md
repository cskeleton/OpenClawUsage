# 设计规格：价格规则通配符与正则匹配

**日期**：2026-04-19  
**状态**：已实现

## 目标

在 `openclaw-usage-pricing.json` 的 `pricing` 中，除 **`provider/model` 精确键** 外，支持：

- **通配符（wildcard）**：键为 glob 风格，`*` 匹配任意长度字符，`?` 匹配单个字符；匹配对象为完整键 `provider/model`（含 `/`）。
- **正则（regex）**：键为 `/pattern/flags` 形式（与常见字面量写法一致），对完整 `provider/model` 做 `RegExp.test`。

用于跨 provider 统一单价：例如 `*/claude-opus-4*` 可覆盖所有 provider 下名称包含该片段的模型。

## 数据结构

每条 `pricing[<key>]` 可选字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `matchType` | `"exact"` \| `"wildcard"` \| `"regex"` | 缺省或省略时视为 `exact`（与历史配置兼容） |

- **exact**：`<key>` 必须与会话中的 `provider/model` 字符串完全一致。
- **wildcard**：`<key>` 为通配符模式。
- **regex**：`<key>` 为正则字面量形式字符串，解析为 `RegExp` 后匹配整串 `provider/model`。

## 匹配优先级

1. **精确规则优先**：若存在 `pricing[modelKey]`，且该条 `matchType` 为 `exact` 或未设置，且 `enabled !== false`，则使用该条。
2. **模式规则**：若无精确命中，按 `Object.keys(pricing)` 的**声明顺序**遍历所有 `matchType` 为 `wildcard` 或 `regex` 的条目；**第一条**匹配成功的规则生效。
3. 若无任何命中，或全局 `enabled === false`，行为与既有逻辑一致：回退到 OpenClaw 会话账面成本。

## 校验

- `matchType` 若存在，必须为上述三值之一。
- `regex` 类型：键须能解析为合法 `RegExp`（含 flags），否则保存失败。
- `wildcard` 类型：须能构造用于匹配的 `RegExp`（实现中转义除 `*`、`?` 外的正则元字符）。

## 前端

- 定价主表增加「类型」列，展示当前规则的匹配类型。
- 「添加新价格」区增加「匹配类型」；精确时使用模型下拉；通配符/正则时使用文本框输入模式字符串，并对正则做客户端语法提示/校验。

## 与参考表的关系

OpenClaw 参考表仍以 `models.json` 的 `provider/model` 为键；模式规则不会出现在「未配置」候选下拉中，需用户手动输入模式后保存。

**内置价格 / 缺少价格** 两张参考表中，「是否已覆盖」对每一行同样用 **`findMatchingPricing`** 判断，因此通配符或正则命中时也会显示为已覆盖（与 `GET /api/openclaw/models` 返回的 `custom` 一致）。可选模型与 `models.json` 全量条目的关系见 **builtin-pricing-reference-design** 规格中的 **`agents.defaults.models`** 说明。
