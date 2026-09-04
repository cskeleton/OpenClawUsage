# 设计规格：价格机制重构（归一化匹配 + models.dev 自动填价 + 口径切换）

**日期**：2026-09-04
**状态**：已批准（设计评审通过，待实施）
**取代关系**：实施后本篇为价格机制单一事实源；`2026-04-19-pricing-pattern-matching.md`、`2026-04-19-builtin-pricing-reference-design.md`、`2026-08-09-models-dev-pricing-reference-design.md` 中与被替代部分需在 Post-Implementation Sync Audit 时标注 superseded。

## 背景与目标

自定义定价机制的存在理由：OpenClaw 自身在 `openclaw.json` 配置价格繁琐，本项目提供替代价表，用户未配置好官方价格时用项目配置的价格替代。

现状痛点（经代码与真实数据核实）：

1. **模型名混乱**：反代/逆向渠道下 `provider/model` 形态杂乱——渠道前缀嵌套（`cpa/agy/gemini-3.8-flash-high`、`nvidia/deepseek-ai/deepseek-v4-flash`）、变体后缀（`-high`、`-thinking`、`-0731`）、大小写不一致（`Joverna/grok-4.3-fast`、`minimax-portal/MiniMax-M3`）、同一模型分散在多个 provider 下。现有 exact/wildcard/regex 难以干净表达，用户被迫用 `*mimo-v2.5`（故意不加尾部 `*`）这类 hack 区分 `mimo-v2.5` 与 `mimo-v2.5-pro`，并产生 `*sol*` 这类易误伤规则与大小写重复规则。
2. **models.dev 填价全靠手动搜索**，无自动匹配。
3. 成本来源（custom/openclaw 账面价）与分项在聚合时被丢弃，只剩 total。
4. 读时不校验，坏配置在 `/api/stats` 聚合时才崩，错误离根因远。
5. HTTP/MCP 写入均为整体替换，无乐观锁，多入口并发互相静默覆盖。
6. 定价文件路径解析与数据目录是两套机制（`OPENCLAW_DIR`/workspace vs `OPENCLAW_CONFIG_DIR`），legacy 路径硬编码 `~/.openclaw`。
7. `updated` 无条件刷新 + 指纹键序敏感 → 过度失效。

**参考对象**：CPA-Manager-Plus（CPAMP，github.com/seakee/CPA-Manager-Plus）。可借鉴点：多索引匹配器（精确/大小写不敏感/canonical 归一化/官方条目识别）、唯一命中自动生效 + 歧义人工确认队列、价格溯源（`source` 字段）、configured 标志区分「未填」与「显式 0」。其不足（无通配符、启发式硬编码、无导入导出）不引入。

**目标**：

- 默认按「官方 API 口径」计价（归一化到 canonical 模型、可忽略 provider），支持切换到「真实成本口径」（provider 各自定价）。
- models.dev 价格自动匹配：唯一命中自动生效，歧义进确认队列，支持批量查询/匹配/确认。
- 顺带完成：读时校验、成本来源/分项透传、写入乐观锁、路径统一、缓存失效治理。

**非目标**（明确排除）：写入时归一化（方案 2）；CPAMP 式整表同步（方案 3）；上下文阶梯价 / service tier 倍率；汇率换算；价格导入导出；candidates 相关 MCP 工具（本期仅 HTTP + UI）。

## 总体架构

**方案 1：查询时归一化**。延续现有「贡献与定价解耦」架构：会话贡献缓存存原始 `provider/model`，计价仍在 merge 阶段（`stats-contribution.js` 的 `costForBucket` 调用点）执行。改价、改别名、改归一化规则、改口径开关均只触发 re-merge，不重解析会话、不重建贡献缓存。

匹配管线（对每条贡献的原始 `provider/model` 键，任一环节命中即停；`rules` 同时容纳 `source: "manual"` 与 `source: "models.dev"` 条目，统一查找）：

1. **别名表**：`aliases[observedKey]`（用户确认过的映射）→ 得到 canonical，转步骤 3 的规则查找
2. **原始键精确查找**：`rules[observedKey]` 直接命中（完整保留 v1 exact 语义，与 `ignoreProvider` 无关）
3. **归一化候选 → 规则查找**：生成归一化候选名（见下），对每个候选依次查：当 `matching.ignoreProvider = false`（真实成本口径）时先查 `provider/候选` 再查裸 `候选`；`= true`（官方价口径）时只查裸 `候选`，provider 限定键完全跳过（不同渠道同模型同价）
4. **legacy pattern 规则**：`patterns` 区 wildcard/regex，按声明顺序，优先级最低
5. **OpenClaw 账面价回退**：全部未命中 → 维持现状用 `usage.cost`

步骤 3 未命中任何 `rules` 条目时，触发 models.dev 惰性匹配（见「自动匹配」节）：唯一命中则本次 merge 直接使用并将结果异步持久化为 `rules` 条目，供后续 merge 在步骤 3 命中。

**归一化候选生成**（参考 CPAMP `modelPriceMatcher` 的多索引思路）：对 model 段依次组合——原样、小写化、剥除已知噪声后缀（默认 `-high`、`-thinking`、`-low`、`-medium`，配置项 `matching.noiseSuffixes` 可增删）、剥离渠道前缀段（`agy/gemini-3.8-flash-high` → `gemini-3.8-flash`；`deepseek-ai/deepseek-v4-flash` → `deepseek-v4-flash`）。

**候选必须验证**：归一化产物是「候选名」而非断言，必须能在 alias/rules/models.dev catalog 之一中查到才算命中。因此 `-pro`、`-luna`/`-sol`/`-terra` 等**不在**噪声后缀清单中（它们是不同模型），`mimo-v2.5` 与 `mimo-v2.5-pro` 天然不混淆。

**models.dev 匹配是 provider 感知的**：`ignoreProvider = true`（官方价口径）时优先对齐 catalog 中**模型厂官方条目**（如 `deepseek-v4-pro` → DeepSeek 官方价而非 Fireworks 分销价；官方条目识别参考 CPAMP 的 canonical entry 判定）；`= false` 时优先对齐实际 provider 在 catalog 中的条目，该 provider 不在 catalog 再回落官方条目。

## 配置 Schema v2

`openclaw-usage-pricing.json`（新规范路径见「路径统一」节）：

```jsonc
{
  "version": "2.0",
  "enabled": true,               // 顶层开关，false → 全局回退账面价（不变）
  "updated": "...",              // ISO 时间戳，仅内容实质变化时刷新
  "revision": 12,                // 整数，乐观锁：每次实质写入 +1
  "matching": {
    "ignoreProvider": true,      // 默认 true = 官方价口径（旧 wildcard 本就忽略 provider，行为兼容）
    "noiseSuffixes": ["-high", "-thinking", "-low", "-medium"]
  },
  "rules": {                     // 精确规则层：canonical 键 或 provider/canonical 键
    "deepseek-v4-pro": {
      "input": 0.435, "output": 0.87,
      "cacheRead": 0.003625, "cacheWrite": null,   // null/缺省 = 按该规则 input 原价；显式 0 就是 0
      "enabled": true,           // 缺省 true
      "source": "manual"         // manual | models.dev
    },
    "deepseek/deepseek-v4-pro": { "input": 0.54, "output": 1.09, "cacheRead": null, "cacheWrite": null, "enabled": true, "source": "manual" },
    "gemini-3.8-flash": { "input": 0.5, "output": 3.0, "cacheRead": null, "cacheWrite": null, "enabled": true, "source": "models.dev", "syncedAt": "..." }
  },
  "aliases": {                   // 确认队列产物：observed key → canonical id
    "cpa/agy/gemini-3.8-flash-high": "gemini-3.8-flash"
  },
  "patterns": {                  // legacy wildcard/regex，原样迁移至此，最低优先级
    "*gpt-5.4*": { "input": 2.5, "output": 15, "cacheRead": 0.25, "cacheWrite": null, "enabled": true, "matchType": "wildcard" }
  }
}
```

规则语义：

- **`source`**：`manual`（手填/用户改过的）/ `models.dev`（自动同步，另带 `syncedAt` 记录同步时间）。用户对 `source: "models.dev"` 的条目做任何编辑即升级为 `manual`。自动匹配不得覆盖 `manual` 条目。
- **cacheRead/cacheWrite**：`null` 或缺省 = 按该规则 input 原价（沿用 CPAMP configured 思路：缺省与显式 0 严格区分）。**保持现有 ×1.0 语义**，不引入 CPAMP 的 ×0.1 惯例（避免行为回退）。UI 文案须写明。
- 计价公式不变：`cost = price($/M) × tokens / 1e6`，四项分项。

**歧义候选独立文件**：`openclaw-usage-pricing-candidates.json`（与配置同目录，机器产物）：

```jsonc
{
  "candidates": [
    {
      "observedKey": "cpa/justwoker/claude-opus-5-thinking",
      "candidates": [
        { "catalogId": "claude-opus-5", "provider": "anthropic", "score": 0.82, "reason": "same-model-family",
          "prices": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }
      ],
      "lastSeenAt": "...",
      "dismissed": false
    }
  ]
}
```

该文件**不参与** pricing 指纹；确认后才转为 alias/rule 进而影响计价。文件损坏 → 丢弃重建（可由 rematch 再生成）。

## 迁移

**v1 → v2（结构迁移，语义不变）**：`loadPricingConfig` 检测到无 `version` 或 `version !== "2.0"` 时：

1. 旧 `pricing` map 按 `matchType` 拆分：wildcard/regex 条目原样移入 `patterns`（保留 `matchType`）；exact 条目移入 `rules`，`source: "manual"`，键原样保留（`provider/model` 形式经管线步骤 2「原始键精确查找」命中，与 `ignoreProvider` 无关，行为不变）
2. 补 `matching` 默认值、`revision: 1`、`version: "2.0"`
3. 写回 v2 文件
4. **迁移等价性须有测试**：同一 fixture 在 v1 与迁移后 v2 下计价结果一致（exact 与 wildcard/regex 规则均需覆盖）

**读时校验**：`loadPricingConfig` 增加 `validatePricingConfig` 校验。结构非法时：

- stats 侧按「配置不可用」处理：全局回退账面价 + 记警告日志（不再把 `/api/stats` 打挂）
- `GET /api/pricing` 正常返回原始内容并附 `validationErrors`（带字段路径）
- `PUT /api/pricing` / MCP 更新非法配置 → 422/结构化错误（现状保留）

## models.dev 自动匹配

**匹配器**（新模块，移植 CPAMP `modelPriceMatcher` 思路的简化实现）：

- 输入：未被 `rules`/`aliases` 覆盖的 observed key 列表
- 候选名生成：同「归一化候选生成」
- 对 catalog（沿用现有 `models-dev-v1.json` 磁盘缓存，24h TTL + stale-while-revalidate 不变）建多索引：精确 / 大小写不敏感 / canonical 归一化 / 官方条目识别
- 打分：token Jaccard 与编辑距离加权取大（参考 CPAMP：权重 0.86/0.82，阈值 0.55，弱召回 0.34，每 key 最多 8 候选），带 `reason`
- 判定：**top1 唯一且 ≥ 阈值** → 自动生效；**多候选或仅弱命中** → 进确认队列
- provider 感知：按「总体架构」节口径选条目

**两个触发入口**：

1. **惰性**：merge 管线第 4 步未命中时，对该 key 现场跑匹配器；唯一命中 → 本次 merge 直接使用结果，并**异步防抖持久化**为 `rules` 条目（`source: "models.dev"`；持久化失败不影响本次 merge，下次重匹配）。歧义 → 写入 candidates 文件
2. **批量**：`POST /api/pricing/rematch`（pricing 页「重新扫描匹配」按钮）——对 stats 中出现过的全部未覆盖模型一次性跑匹配器，返回 `{ matched, queued }`

**确认队列操作**（`POST /api/pricing/candidates/resolve`，body 为数组以支持批量）：

- `accept`：写 `aliases[observedKey] = catalogId` + 写/更新 `rules[catalogId]`（`source: "models.dev"`，用候选价格）
- `dismiss`：标记 `dismissed: true`，不再提示
- 手动填价：UI 跳表单预填，走正常规则新增

## API 与 MCP 契约

HTTP（全部过 `writeRequestGuard`，不变）：

| 端点 | 变更 |
|------|------|
| `GET /api/pricing` | 返回 v2 配置 + `revision` + 可选 `validationErrors` |
| `PUT /api/pricing` | body `{ config, baseRevision }`；`baseRevision` 与当前不符 → **409** + 当前配置；校验失败 → 422 带字段路径；成功返回 `{ ok, revision }` |
| `GET /api/pricing/candidates` | 新增，返回候选队列 |
| `POST /api/pricing/candidates/resolve` | 新增，批量 `{ resolutions: [{ observedKey, action, catalogId? }] }` |
| `POST /api/pricing/rematch` | 新增，批量重扫 |

MCP：`get_pricing_config` 返回含 `revision`；`update_pricing_config` 入参加可选 `baseRevision`，冲突返回结构化错误。工具 `description` 中英双语同步更新。candidates/rematch 的 MCP 工具本期不做。

**乐观锁语义**：`revision` 随实质变更 +1；前端 409 时提示「配置已被其他入口修改」并重新加载。多标签页/HTTP+MCP 并发由此安全。

## 成本来源与分项透传

在 merge 阶段计算（贡献缓存 schema **不变**，无需缓存版本升级）：

- 每个 model 行输出增加：`canonical`（解析出的 canonical 名，未解析出时为原 model 段）、`costSource`（`manual` | `models.dev` | `pattern` | `openclaw`）、`costBreakdown`（`{ input, output, cacheRead, cacheWrite }` 四项费用）
- totals 增加 `costBySource` 汇总；`byHourModel` 同口径携带
- **实现验证点**：确认 merge 结果无独立持久化层；若有，需升级缓存 schemaVersion 并在实施时回写本篇

前端统计页：byModel 行显示 canonical 与来源徽标；新增「按 canonical 分组」视图（展示层聚合，不动数据结构）；新增成本构成（四项分项）图表区块。

## 缓存与失效治理

- **指纹规范化**：`buildPricingFingerprint` 改为稳定序列化（键排序），消除键序敏感
- **`updated` 按需刷新**：`savePricingConfig` 先规范化比较新旧内容（排除 `updated`/`revision`），无实质变化则不改 `updated`/`revision`、不触发失效（no-op 保存返回当前 revision）
- candidates 文件不进指纹
- **性能**：merge 内对 `observed key → 匹配结果` 做 Map 备忘（同一键只跑一遍管线）；wildcard/regex 预编译；catalog 索引在 rematch/惰性匹配时懒构建并缓存

## 路径统一

- 新规范路径：`$OPENCLAW_CONFIG_DIR/openclaw-usage-pricing.json`（`OPENCLAW_CONFIG_DIR` 缺省 `~/.openclaw`）
- 解析优先级：`OPENCLAW_USAGE_PRICING_PATH`（新增显式覆盖，便于测试）> `OPENCLAW_CONFIG_DIR` > `OPENCLAW_DIR`（deprecated alias，保留兼容）> 缺省
- **迁移**：新路径不存在时，按旧优先级（workspace 探测路径 → legacy 常量路径）找到旧文件并自动迁移（沿用现有 legacy 迁移模式）；legacy 探测改为受 env 影响，消除 AGENTS.md 记载的测试陷阱
- 定价是全局参考表，不随 workspace 变化；多 workspace 场景统一放 config dir

## UI 变更（pricing 页与统计页）

pricing 页：

- 头部：全局 enabled 开关旁加「忽略 provider」开关（附当前口径说明文案）；噪声后缀清单管理入口（高级区小弹窗）
- **确认队列区**（可折叠，置顶于规则表上方）：按模型调用量排序；每行 = observed key + 候选列表（catalogId/provider/score/reason/价格）+ 操作（采纳某候选 / 手动填价 / 忽略）；**批量操作**：采纳所有唯一候选、忽略全部、勾选多条批量采纳
- 规则表：source 徽标（手动 / models.dev / 高级规则）；行内编辑保留；新增规则 combobox 候选改为 canonical 名
- models.dev 手动搜索弹窗保留为兜底入口
- 409 冲突提示与重新加载

统计页：canonical 分组视图、来源徽标、成本构成图表（见「成本来源与分项透传」）。

全部新增文案中英双语（`src/locales/zh-CN.js` / `en-US.js`），README.md ↔ README_EN.md 价格章节同步重写。

## 错误处理

- 配置读时校验失败：stats 全局回退账面价 + 警告日志；`GET /api/pricing` 附 `validationErrors`；写接口 422 带字段路径
- models.dev 不可达：沿用 fail-closed（无缓存时）；匹配器跳过 catalog 环节，rematch 返回中标注 `catalogUnavailable: true`
- candidates 文件损坏：丢弃重建
- 惰性匹配的异步持久化失败：记警告，不影响 merge 结果

## 文档与清理

- 删除死代码 `getPricingVersion`（`pricing.js:365`）
- `pricing.html` 帮助文案更新（去除 `agents/main/agent/models.json` 旧描述，改为 `openclaw.json` 的 `models.providers`）
- `pricing.json.example` 更新为 v2 示例
- 前端与后端重复的 pattern 校验（`src/pricing.js:265` vs `pricing.js`）收敛为共享实现或明确分工，消除漂移
- 仓库根遗留 `pricing.json`（已 gitignore）：README 不再引用，本篇发布后删除本地文件（实施时确认无引用）

## 测试策略

TDD；实施按 AGENTS.md 偏好采用 Subagent-Driven Development（implementer subagent + 主会话 review），完成后做 Post-Implementation Sync Audit 回写本篇偏差。

- **unit**：归一化候选生成（`cpa/agy/*` 剥段、`-high`/`-thinking` 剥除、大小写、`mimo-v2.5` vs `mimo-v2.5-pro` 不混淆、`-luna` 等不在噪声清单）；matcher（多索引、官方条目识别、打分阈值、provider 感知选条目）；新优先级链（alias > exact > provider 限定 > models.dev > pattern > 账面回退）；v1→v2 迁移；读时校验；乐观锁 revision；规范化指纹；no-op 保存不刷新 `updated`
- **integration**：`PUT /api/pricing` 409/422；candidates resolve/rematch API；MCP 新契约（revision）；merge 输出 source/分项/canonical；**迁移等价性**（v1 fixture 与迁移后 v2 计价一致）；路径迁移（旧位置文件自动迁移到新规范路径）
- **frontend（jsdom）**：确认队列批量操作、ignoreProvider 开关、source 徽标、409 处理
- **fixtures**：用 `scripts/extract-test-fixtures.js` 从生产数据重新抽取脱敏样本，确保覆盖 `cpa/*/*` 多渠道前缀、`-high`/`-thinking` 后缀、大小写混杂模型名
