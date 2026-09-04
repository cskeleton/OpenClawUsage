# 设计规格：models.dev 在线价格参考（价格配置页弹窗填价）

**日期**：2026-08-09
**状态**：⚠️ 部分被取代（2026-09-04 价格机制重构）；原实现说明保留于下

> **Superseded（2026-09-04，部分）**：`2026-09-04-pricing-mechanism-redesign-design.md` 引入 models.dev 自动匹配（惰性 + `POST /api/pricing/rematch` 批量 + 确认队列）后，本篇描述的「手动搜索弹窗」不再是唯一入口，降级为**兜底入口**保留（交互与字段映射仍有效）。磁盘缓存层（`models-dev-v1.json`，24h TTL + stale-while-revalidate）被新匹配器沿用不变。

> 实现说明（2026-08-09 Post-Implementation Sync Audit）：
> - 按钮实际位于「添加」按钮（`#add-pricing-btn`）左侧同行。
> - 弹窗「填入价格」行内按钮文案为「填入价格 / Fill prices」。
> - 二次确认「取消」仅收起确认区、不关闭整个弹窗（直觉修正）。
> - 列表行行内展示 `provider/model` 与 Input/Output/Cache Read/Cache Write 四价（`I:/O:/CR:/CW:` 紧凑格式，缺省显示 `—`）。
> - 加载态为文案「正在加载 models.dev 目录…」（无独立 spinner 元素）。
> - 空值规则修正：`input`/`output` 缺失时归一化层保留 `null`（而非 `0`），填入时留空——避免把「无价」误写为 0 价。

## 目标

在价格配置页「添加新价格」区域旁提供「从 models.dev 获取参考价」入口：

1. 点击后弹出模态窗口，可搜索、单选 [models.dev](https://models.dev) 公开目录中的模型。
2. 确认选择后，**仅**把该模型的 Input / Output / Cache Read / Cache Write 参考单价（$/M）填入当前新增表单的价格格。
3. **不**填入 Provider/Model 模型键字段，**不**触碰任何名称字段；最终保存由用户自己点击「添加」完成。

## 非目标

- 不新增整表式 models.dev 参考表（已否决：交互过重、与本功能诉求不匹配）。
- 不做 Provider 别名自动映射（如 `anthropic-vertex` ≠ `anthropic`），避免误导性填价。
- 不修改成本计算逻辑（`pricing.js` 的匹配与 `calculateCostFromUsage` 完全不变）。
- 不改动 MCP 工具集（本期仅 Web UI + 只读 HTTP API；MCP 侧无新增工具）。

## 数据源与约束

- **唯一上游**：`GET https://models.dev/api.json`（公开目录，约 181 个 provider）。
- **隐私**：仅向 models.dev 发起上述固定 GET；**绝不外发**本地 Provider ID、Model ID、`baseUrl`、API Key 等任何信息。
- **单位**：models.dev 的 `cost` 单位为 USD / 1M tokens，与本项目 $/M 展示一致，直接透传数值。
- **字段映射**（models.dev → 本系统）：
  - `cost.input` → `input`（缺省/非数值 → `null`）
  - `cost.output` → `output`（缺省/非数值 → `null`）
  - `cost.cache_read` → `cacheRead`（缺省/非数值 → `null`）
  - `cost.cache_write` → `cacheWrite`（缺省/非数值 → `null`）
  - `limit.context` → `contextWindow`
  - `name` → `displayName`（缺省回退为模型 id）

## 服务端

### 新模块 `models-dev.js`（仓库根，与 `openclaw-config.js` 平级）

导出：

- `getModelsDevCatalog({ fetchImpl, nowMs } = {})`
  - 返回 `{ models, fetchedAt, stale, source: 'models.dev' }`。
  - `models[]`：`{ key, provider, model, displayName, cost: { input, output, cacheRead, cacheWrite }, contextWindow }`，按 `key` 排序。
- `__clearModelsDevCacheForTests()`：测试辅助，清空进程内状态。

行为：

1. **缓存文件**：`$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/models-dev-v1.json`（沿用 stats 缓存目录约定；`OPENCLAW_CONFIG_DIR` 缺省 `~/.openclaw`）。内容为 `{ fetchedAt, models }`。
2. **TTL 24h**：缓存新鲜（`now - fetchedAt < 24h`）→ 直接返回 `stale: false`，不发网络请求。
3. **先旧后新**：缓存过期 → **先返回陈旧快照 `stale: true`，同时后台刷新**；刷新成功后下一次请求得到新数据；刷新失败保留旧快照（不破坏可用性）。
4. **首次无缓存**：同步拉取；成功则落盘后返回 `stale: false`；网络/解析失败 → 抛出带明确信息的错误（API 层映射为 502），**不伪造数据**（fail-closed）。
5. **防护**：整体请求超时 10s（`AbortController`）；响应体 JSON 解析失败、结构缺 `providers` 形态时视为失败。
6. **进程内并发**：同一时间至多一个后台刷新在途（in-flight 去重），避免并发请求打爆上游。
7. 写入缓存文件前确保目录存在（递归创建）；写文件失败仅记日志，不影响返回数据。

### 新 API `GET /api/models-dev/models`（`server.js`）

- 直接调用 `models-dev.js`，返回 `{ models, fetchedAt, stale, source }`。
- 失败：`502 { error: string }`。
- 只读 GET：天然不受 `writeRequestGuard`（仅拦截 POST/PUT/PATCH/DELETE）影响。
- 不走 stats-service（与聚合缓存无关的独立只读资源）。

## 前端（`pricing.html` + `src/pricing.js`）

### 入口按钮

- 「添加新价格」卡片内、模型键输入行附近新增按钮：`id="fetch-models-dev-btn"`（实现：位于「添加」按钮左侧同行），文案「从 models.dev 获取参考价 / Fetch reference prices from models.dev」。
- 视觉沿用现有 `btn-secondary` 风格与卡片布局，不引入新色系。

### 模态窗口（新 DOM + `src/pricing.js` 逻辑）

- `id="models-dev-modal"`，结构：标题栏（含关闭 ×）、搜索输入框、状态区、模型列表（可滚动）、底部「取消 / 填入价格」按钮（实现：行内按钮文案「填入价格 / Fill prices」）。
- **搜索**：本地过滤 `provider/model`、`displayName`（大小写不敏感子串匹配）。
- **列表行**：行内展示 `provider/model` 与 Input/Output/Cache Read/Cache Write 四价参考（$/M，紧凑格式 `I:/O:/CR:/CW:`，缺省显示 `—`）；单选高亮；未选中时「填入价格」禁用。
- **状态机**：
  - 加载中：状态区文案「正在加载 models.dev 目录… / Loading models.dev catalog…」；
  - 失败：错误占位 + 「重试」按钮（重新请求 API）；
  - 成功但 `stale: true`：角标提示「缓存数据（更新失败，展示上次结果）/ Cached (refresh failed, showing last snapshot)」。
- **Esc / 点击遮罩 / ×**：关闭弹窗，不做任何修改。

### 填入语义（核心契约）

点击「填入价格」且已选中一行：

1. 若表格行正处于行内编辑态（`pricingTableEditingKey !== null`）：toast 提示「请先完成或取消表格中正在编辑的行」，**不**填入。
2. 读取 4 个价格格（`new-input-price` / `new-output-price` / `new-cache-read-price` / `new-cache-write-price`）当前值：
   - **全部为空** → 直接写入参考价（见 ④ 空值规则），关闭弹窗。
   - **任一格非空** → 弹出二次确认（小三选对话框）：**全部覆盖** / **只填空白** / **取消**。
     - 全部覆盖：4 格整体替换为参考价（成组同源）。
     - 只填空白：仅写入当前为空的格子，已有值保留。
     - 取消：不做任何修改（实现：仅收起二次确认区，弹窗保持打开，便于重新选择；遮罩/×/「取消」按钮才关闭弹窗）。
3. **空值规则**：参考价为 `null`（含 `cacheRead` / `cacheWrite`，以及罕见的 `input` / `output` 缺失）时，对应格子一律写入空；Cache 格留空沿用「留空 = 按 Input 原价计算」语义，绝不用 `0` 冒充无价字段。
4. **绝不写入** `new-model-input`（模型键留空由用户自填）、`new-match-type` 不变；不触碰任何名称/显示字段。
5. toast 反馈：「已填入 models.dev 参考价（覆盖价格格），请确认 Provider/Model 后保存」或「已填入参考价（仅空白格）…」。

### 与现有流程的关系

- 填入后用户自行输入 Provider/Model 键并点「添加」；后续走既有 `addPricing` → `PUT /api/pricing` 流程，本功能**不**新增写接口。
- 与「复制为自定义」「复制到自定义」按钮共存，互不干扰。

## 文案与国际化

- `pricing.html` 新文案（按钮、弹窗标题、搜索占位、状态、二次确认、toast）全部进 `src/locales/zh-CN.js` 与 `src/locales/en-US.js` 的 `pricing` 节，中英同步。
- 帮助 tooltip 追加一条：models.dev 数据来源、24h 缓存 / 先旧后新语义、仅供参考不自动生效。
- `README.md` ↔ `README_EN.md` 各补一段功能说明。

## 测试（Vitest 双 project 既有体系）

- **单元 `tests/unit/models-dev/`**：
  - 归一化：`cache_read/cache_write` 映射、缺字段 → `null`、key 排序。
  - 缓存：新鲜命中不发请求；过期返回 stale + 触发后台刷新；无缓存且 fetch 失败 → 抛错；并发 in-flight 去重。
  - 容错：坏 JSON、缺结构、超时中止。
  - 通过注入 `fetchImpl` / `nowMs` 与 tmp `OPENCLAW_CONFIG_DIR` 隔离。
- **集成 `tests/integration/server/`**：`GET /api/models-dev/models` 成功契约、`stale` 语义、502 失败；确认 GET 不被 guard 拦截。
- **前端 jsdom**：弹窗打开/搜索过滤/单选/「填入价格」三态（全空直接填、覆盖、只填空白、取消）、编辑态拦截提示；**断言不写入 `new-model-input`**。
- 门禁：`npm test` 与 `npm run build` 全绿。
