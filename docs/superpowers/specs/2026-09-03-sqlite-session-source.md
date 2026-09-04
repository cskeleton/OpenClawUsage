# 设计规格：SQLite 会话数据源迁移（OpenClaw 2026.8.2 适配）

**日期**：2026-09-03
**状态**：已实施
**前置调查**：`/Volumes/OpenClaw/docs/openclaw/sqlite-migration-investigation.md`（外部文档）

## 背景

OpenClaw 2026.8.2 起会话数据全面迁移到 SQLite，不再产生 JSONL：

- 核心数据库：`$OPENCLAW_CONFIG_DIR/agents/main/agent/openclaw-agent.sqlite`（WAL 模式，OpenClaw 网关常驻写入）
- `transcript_events(session_id, seq, event_json, created_at)`：全量消息与事件，`event_json` 与旧 JSONL 行完全同构
- `session_windows(session_id, session_key, status, created_at, updated_at, transcript_updated_at, ...)`：每个有事件的会话必有一行（FK 保证）
- `session_nodes(session_key, current_session_id, status, archived_at, ...)`：会话节点（同一会话多次 reset 产生多个 node）
- `session_transcript_archives(session_id, generation, reason ∈ {deleted, reset}, encoding ∈ {identity, zstd}, archive_blob)`：迁移后被删除/重置的会话整包归档（zstd blob 解压后即原 JSONL 文本），归档时其事件已从 `transcript_events` 移除，因此与活跃事件天然不重叠
- `agents/main/agent/models.json` 在 2026.8.2 起不再生成；模型目录迁移至 `openclaw.json` 的 `models.providers`（结构兼容旧 models.json 的 `providers` 形态）

当前实现（`aggregator.js` 的 JSONL 扫描 + `stats-cache-store.js` 的 mtime/size manifest）自 2026-08-31 起采集不到任何新数据。**本迁移不保留 JSONL 兼容**——历史归档一次性导入后，`aggregator.js` 的文件解析路径整体删除。

## 调查事实（决策依据）

1. **零重合**：sessions/ 目录剩余 180 个 UUID 会话的历史 JSONL 归档与 SQLite 的 27 个活跃会话零重合（迁移时活跃会话的源文件已被移入 `session-sqlite-import-archive/`，其事件全部导入 SQLite）。
2. **历史基线**：本机 v1 缓存（`stats-v1.json`）151 个有记录的会话全部为 reset/deleted 状态，与 SQLite 活跃会话零冲突；9 个 `.zst` 归档会话在旧缓存中均为 0 记录（OpenClaw 先归档压缩、后删除原文件的顺序导致旧扫描器从未计入）。
3. **9 个 zst 会话双份存在**：sessions/ 目录的 `.jsonl.deleted.*.zst` 文件与 `session_transcript_archives` 表是同一数据的两份拷贝。新数据源只读 SQLite 归档表，sessions/ 目录的 zst 不再读取（既避免双计，也无需 zstd CLI）。
4. **usage 提取口径不变**：`event_json` 里 usage 只出现在 `type=message` 事件；`message.provider === 'openclaw'` 的内部镜像消息过滤逻辑保持不变。
5. **seq 连续性**：实测所有会话 `COUNT(seq) === MAX(seq)-MIN(seq)+1`，但 OpenClaw 重写/rewind 时可能清空重写（`transcript_rewrite_watermarks` 存在）。增量水线不能只看 max(seq)。
6. **`session_windows.transcript_updated_at`** 随事件追加单调更新，实测与事件最新 `created_at` 一致（差值 ≤ 数百 ms），可作为可靠的增量变更信号。
7. **`session_transcript_archives`** 的 zstd blob 用 Node 内置 `node:zlib.zstdDecompressSync` 可解压，内容即原 JSONL 文本（按行 JSON 对象，含首行 session 头）。
8. **models.json 已死**：2026.8.2 起不再生成（本机仅存用户手动 `.bak`）；价格参考 API 必须改读 `openclaw.json`。
9. **Node ≥ 24 LTS**：`node:sqlite`（`DatabaseSync`）与 `node:zlib` 的 zstd 支持均可用（本机 v25.9.0 验证）；项目无 CI 版本锁定，`package.json` 增加 `engines.node >= 24`。
10. **多 Agent**：`agents/` 下目前只有 `main`；按需遍历 `agents/*/agent/openclaw-agent.sqlite` 属于锦上添花，本次仅实现 `main`（与现状一致）。
11. **同步线格式不变**：`sync-snapshot.js` 的 contributions/contributionId/status 白名单 (`active/reset/deleted`) 不需要变化，只更换快照的本地构建来源。
12. **前端不依赖 filename/archivedAt**：`src/main.js` 只用 `id`（前 8 位 + tooltip）、`status`（badge + 筛选）。
13. **本机同步角色**：本机（MBP）是 sync 发送方（sourceId `mbp` → 目标 `claw`），改动后 `computeSourceId` 的输入改变会导致下游 `combinedRevision` 变化，但接收方按 contributionId 幂等覆盖，无需迁移对接。
14. **import-archive（`session-sqlite-import-archive/`）与 SQLite 范围外历史**：`archive-tier.*` 与 `agent_main_explicit_*` 前缀文件（46 个会话、含 checkpoint 变体与显式命名研究会话）未导入 SQLite。这些属一次性迁移遗留，**不在本次范围**——纳入会引入 checkpoint 双计风险（原 JSONL 时代明确跳过 checkpoint）。
15. **本机缓存数据基线**：v1 缓存 `generatedAt 2026-09-03T06:28`，4897 requests / 151 sessions；SQLite 活跃数据 6584 usage events（含 openclaw 52 条待过滤）。验收时以「v1 历史 + SQLite 新数据」合并总量 ≥ 两者之和（无重合）。

## 目标

1. 用 SQLite（只读）替换 JSONL 扫描，看板与 MCP 恢复实时数据（含 2026-08-31 之后）。
2. 历史不丢：迁移时把 v1 磁盘缓存里的历史贡献（JSONL 时代）冻结进新缓存。
3. 定价引擎输入不变：`pricing.js` / `calculateCostFromUsage` / 自定义单价与缓存失效逻辑零改动。
4. sync 快照线格式不变，接收方无感。
5. JSONL 代码路径全部移除（无双源）。

## 非目标

- 解析 `session-sqlite-import-archive/` 下未导入 SQLite 的历史（checkpoint 双计风险，一次性遗留）。
- 多 Agent 目录遍历（当前只有 main；`getSessionDir` → `getSqlitePath` 单路径）。
- 读取 SQLite 内其他与用量无关的表（memory、conversations 等）。
- 解析 sessions/ 目录任何残留文件（`.zst`、trajectory、`.json` 元数据）。

## 架构

### 数据流

```
openclaw-agent.sqlite (只读连接)
  ├─ transcript_events          → 活跃贡献（增量按 (session_id, seq) 水线）
  ├─ session_transcript_archives → 归档贡献（zstd blob 一次性解析）
  └─ session_windows + session_nodes → 会话状态（status/archived_at）
stats-v2.json (磁盘缓存, schemaVersion 2)
  ├─ files: Record<contributionKey, contribution>   ← 与 v1 同构的贡献
  ├─ manifest: { dbFingerprint, sessions: {...}, archives: {...} }
  └─ stats / pricingFingerprint / revision / buildMode / ...
openclaw.json (models.providers)  → 价格参考 API
```

### 模块划分

- `sqlite-source.js`（新增）：DB 路径解析、只读连接、manifest 扫描、活跃/归档贡献构建、增量水线查询。原 `aggregator.js` 的「路径 + 文件名身份」职责迁移至此。
- `stats-service.js`：refresh/lock/baseline 逻辑保持不变，`getSessionDir/scanSessionManifest/parseFileStable` 替换为 `sqlite-source` 的对应函数；贡献构建不再有「文件变化重试」语义（SQLite 快照读天然稳定）。
- `stats-contribution.js`：`buildFileContribution` 拆成两步——「原始记录流 → 贡献」（新增 `buildContributionFromRecords(session, records)`，与定价无关），由 sqlite-source 调用。`mergeFileContributions` 不变。
- `stats-cache-store.js`：`CACHE_SCHEMA_VERSION = 2`，文件名 `stats-v2.json`；sourceId 计算输入改为 SQLite 路径。
- `aggregator.js`：删除（`aggregateStats` 一并删除——`server.js` / `mcp-server.js` 已走 stats-service，仅测试用）。`parseSessionJsonlRaw` 保留导出（fixture 提取与 sync 测试仍在用？否——见实现偏差）。

### 数据口径

- **贡献键（contribution key）**：`sqlite:<session_id>`（活跃）与 `sqlite-archive:<session_id>`（归档，`<session_id>@<generation>` 若多代）。v1 的文件名键（`xxx.jsonl.reset.…`）只出现在冻结历史里，键格式统一为 `legacy:<原文件名>`。
- **过滤**：`type === 'message'` && `message.usage` 存在 && `message.provider !== 'openclaw'`。
- **会话状态**：
  - 活跃：`session_windows.status`（`running/done/failed/killed/timeout`）→ 映射 `active`（running）或 `done/failed/killed/timeout` → 前端语义统一为 `active`/`done`；**为兼容前端与 sync 白名单，统一输出 `active`**。
  - 归档：`reason`（deleted/reset）→ `deleted` / `reset`，`archivedAt` 取 blob 首行 `session.timestamp` 或 `session_nodes.archived_at`（见实现偏差）。
- **时间戳**：事件时间用 `event_json` 内的 `timestamp`（ISO 字符串），与旧口径一致；`created_at`（ms）仅作水线，不作展示。
- **session_id 展示**：UUID 截断 8 位逻辑不变；非 UUID 的显式命名会话（如 `research-bohe-k3-off-20260811`）首次出现，前端展示与排序自然兼容（`s.id.substring(0,8)` + 全量 tooltip）。

### 增量模型（缓存 v2）

manifest 扫描（每次刷新前）：
```sql
SELECT session_id,
       COUNT(*) AS events,
       MAX(seq) AS maxSeq,
       MAX(created_at) AS lastCreatedAt,
       MAX(transcript_updated_at) AS watermark
FROM transcript_events e
LEFT JOIN session_windows w ON w.session_id = e.session_id
GROUP BY session_id;
```

- **变更判定**：会话贡献以 `(events, maxSeq, lastCreatedAt, watermark)` 四元组为身份；任一变化 → 重新解析该会话全部事件（主表 13.5k 事件全量单会话 ≤ 9.5k，单会话全量重解析在毫秒级）。
- **归档表 manifest**：`SELECT session_id, generation, reason, encoding, created_at FROM session_transcript_archives`，身份 = `(generation, created_at)`。归档新增即解析；归档消失（理论上不发生）→ 删除贡献。
- **全量重建**：`full:true` 丢弃全部基线（水线清零）重跑；WAL 模式下同一个只读连接跨语句的快照一致性由「先 manifest、后数据」的顺序 + 归档表身份含 generation 保证。
- **快照一致性**：`node:sqlite` 的 `DatabaseSync` 为同步 API，每次 `prepare().all()` 在同一线程顺序执行；OpenClaw 写入是并发 WAL 写。极小概率下 manifest 与数据查询之间有新写入落入 manifest 已见会话——但水线四元组保证下一轮增量捕获，不会永久丢失。
- **dbFingerprint**：`(db file identity: {size, mtimeMs})` 不适合 WAL 活跃写场景（WAL checkpoint 会移动数据），改用 `PRAGMA schema_version` + 数据库文件 inode。`PRAGMA schema_version` 变化意味着 OpenClaw 升级改表 → 自动触发全量重建。

### 冻结历史迁移（one-shot）

启动时发现 v1 缓存（`stats-v1.json`）且 v2 尚不存在：

1. 读 v1 的 `files`（键 `xxx.jsonl.…`，每条含 session/buckets/hasRecords）。
2. 直接拷贝为 v2 的 `legacy:*` 聚合贡献（`hasRecords:false` 的文件跳过（0 记录无意义），仅保留有记录的 151 个）。仅当会话 id 不在 SQLite 活跃/归档会话集合内（零重合已实测，防御性过滤）。
3. legacy 贡献的 `identity` 字段改写为 `{ frozen: true }`，不再参与变更检测。
`getLocalContributionCache`（sync 出口）序列化时 `legacy:` 前缀照常进入 contributionId 哈希，接收方无感。

**不做**：不解析 sessions/ 則/目录残留文件；不读 import-archive 目录。

### openclaw-config.js（models 目录）

- `getAgentModelsJsonPath()` 删除；新增 `getOpenClawJsonPath()`（`$OPENCLAW_CONFIG_DIR/openclaw.json`）与 `listAllModelsFromOpenClawJson()`：读 `models.providers`（结构兼容 `config?.providers || config?.models?.providers` 的现有解析）。
- `GET /api/openclaw/models` 与 MCP 端同样返回两类列表（有价/缺价）+ custom 对照；API 形状不变。
- fixture `models.real.json` 更新为从 `openclaw.json` 抐取（模式同旧：providers → models[] → cost）。
- engines.node >= 24（`node:sqlite`）写入 package.json。

### API / MCP

- `GET /api/stats` 响应形状不变（sessions[] 仍含 id/status/providers/models/byDate/byDateModel/...）。
- `refresh_stats_cache` 工具描述更新（"changed files" → "changed sessions"），中英双语。
- `list_recent_sessions` / `get_session_stats` 返回 `status: 'active'`（SQLite 时代所有活跃会话的统一值）。
- `refreshStatsCache` 返回的 `full` 语义不变。

### 前端

- `statusBadge`：新增 `done` 徽标（✅ Done，`status-done` 类），筛选下拉增加 Done 选项；`running` 不会出现在数据里（见实现偏差）。
- `loadingSessions: 'Scanning session files...'` 文案更新为数据库语义（双语）。
- 其余零改动：ID 截断、搜索、byDate/byDateModel 切片逻辑照旧。

## 测试与验收

### fixtures 重构

- `tests/fixtures/db/openclaw-agent.sqlite`：从本机库脱敏抽取——1 活跃会话（多 provider/model）、1 归档会话（zstd）、1 研究会话（非 UUID id）、1 openclaw 内部消息过滤样例。生成脚本 `scripts/extract-test-fixtures.js` 重写为 SQLite 版；**归档 blob 同样脱敏**（解码 → 逐行 `redactEventJson` → 按原 encoding 重编码并重算 `archive_sha256`），且生成后自检：扫描 fixture 库全部 `event_json` 与解码 blob 的本机路径/token 模式，命中即退出 1。
- `sessions-real/`、`sessions-synth/` 删除；`MANIFEST.json` 更新。
- `tmp-workspace.js`：`writeSession` → `writeDb(sqlScript)`（或直接写 fixture db 拷贝）。

### 自动化测试（vitest，node project）

1. `sqlite-source`：manifest 四元组身份、归档增量、非 UUID 会话、openclaw provider 过滤、数据库缺失（ENOENT → exists:false）。
2. `stats-service`（cache.test.js 重写）：增量/全量、v1→v2 冻结迁移、水线变化触发重解析、归档新增、legacy 贡献不参与变更检测。
3. `stats-contribution.buildContributionFromRecords`：与旧 JSONL 解析结果等价（用同一批事件构造）。
4. `sync`：线格式回归——legacy 贡献 + sqlite 贡献混排的快照能被 validateSourceSnapshot 接受。
4. `openclaw-config`：`openclaw.json` 的 models.providers 解析（含缺价模型）。
5. 前端 dashboard-dom：done 徽标渲染。

### 验收标准（本机真实数据）

- 看板日期分布覆盖到当天（2026-09-03）。
- 历史总量不回退：`totalRequests ≥ 4897`（v1 基线）+ SQLite 过滤后新增（约 6584-52=6532 条中 9/1-9/3 部分）。
- `openclaw-usage status` 显示新缓存存在；`start/stop` 正常。
- sync 推送到 claw 成功（revision 变化，无错误）。

## 实施顺序

1. `sqlite-source.js` + `openclaw-config.js`（models.providers）+ `engines`
2. `stats-contribution.js` 拆分 + `stats-cache-store.js` v2
3. `stats-service.js` 接线 + 冻结迁移
4. `server.js`（日志）/ `mcp-server.js`（描述）微调
5. 前端 done 徽标 + 文案
6. fixtures 重构 + 测试重写
7. 文档（README 双语、AGENTS.md）
8. 端到端验证 + Post-Implementation Sync Audit（本规格回写）

## 实施偏差与说明（Post-Implementation Sync Audit）

实际实现与本规格的差异，均已回写至上述章节保持一致：

1. **归档贡献键带代次**：`session_transcript_archives` 主键为 `(session_id, generation)`，同一会话理论上可有多代归档；实际实现贡献键为 `sqlite-archive:<sessionId>@<generation>`（规格初稿只写了 `sqlite-archive:<session_id>`），manifest 键同理。
2. **会话状态映射**：实际实现将 `session_windows.status` 的 `running` 映射为 `active`，其余终态（`done/failed/killed/timeout`）统一映射为 `done`（规格「数据口径」节的初稿表述含糊，已按实现收敛）；窗口缺失时兜底 `active`。前端相应新增 Done 徽标（✅，indigo 配色、深浅两主题变量 `--accent-done`）与筛选选项。
3. **归档会话的 `archivedAt`**：取归档数据中**第一条带时间戳的 usage 记录**的 `timestamp`（blob 首行 session 头事件无 usage，被解析口径跳过）；未使用 `session_nodes.archived_at`（该列本机数据全为 NULL）。
4. **schema 身份触发全量**：实际实现比较 `PRAGMA schema_version` + 数据库 inode（`manifest.identity`）；由于 v2 内存基线在进程重启后为空、磁盘基线带 identity，升级场景由「磁盘 manifest 与新扫描的 identity 不一致 → manifest 不匹配 → 走刷新路径 → `executeRefresh` 检测到 identity 变化强制 full」完整覆盖。
5. **冻结历史的注入点**：不在 `handleMissingDatabase`（数据库缺失时保持空统计），而是在 `buildSnapshot` 内当 filesMap 无任何 `legacy:` 键时注入一次；后续增量/全量刷新通过前缀判断跳过重复注入。冻结贡献不参与 manifest 防御清理（`legacy:` 前缀豁免）。
6. **`aggregator.js` 完全删除**：`parseSessionJsonlRaw` 未保留——其唯一消费方 `stats-contribution.buildFileContribution` 已重构为 `buildContributionFromRecords(session, records)`（记录流 → 贡献，与来源无关）；fixture 提取脚本直接读 SQLite。`server.js` 的 `aggregateStats` 残留引用经核实不存在（生产代码已全走 stats-service）。
7. **MCP/HTTP 面零形状变化**：`sessions[]` 不再携带 `filename`（`mergeFileContributions` 移除该字段），前端与 sync 线格式均不依赖它（探索报告证实）；其余字段不变。
8. **fixture 提取尺寸控制**：`--per-session`（默认 40 事件/会话）截断大会话，样本库 188KB；隐私审计发现并修复了 compaction 事件 `summary` 字段的路径泄漏（非 message 事件的自由文本字段现统一脱敏）。
9. **engines 约束**：`package.json` 声明 `"engines": { "node": ">=24" }`；本机 v25.9.0 验证。
10. **验收数据（2026-09-03 实测）**：v2 缓存 187 贡献 = 27 sqlite + 9 sqlite-archive + 151 legacy；`totalRequests 11464 = 4897（v1 历史）+ 6567（SQLite 过滤后）`；日期覆盖 2026-06-24 → 2026-09-03；增量刷新耗时 ~250ms。测试 33 文件 324 用例全绿（node 226 + jsdom 97 + 1 skip）。
11. **Code Review 修复——归档 blob 脱敏漏洞（Critical）**：review 发现 `extract-test-fixtures.js` 原样拷贝 `archive_blob`（绕过 `redactEventJson`），导致 fixture 库 9 条归档含本机路径与会话原文。已修复为「解码 → 逐行 `redactEventJson`（无法解析的行丢弃）→ 按原 encoding 重编码并重算 `archive_sha256`」，脚本新增生成后自检（命中泄漏模式即退出 1）；fixture 库已重新生成并独立复核 0 泄漏（源归档 28 行全保留、无解析丢弃）。
12. **Code Review 修复——单归档损坏兜底**：`buildSqliteContributions` 归档循环逐键 try/catch + `console.warn` 跳过（此前 zstd 解压失败/行消失会穿透 `runRefresh`，冷启动直接「刷新后无可用统计」）；manifest 仍含该键，下轮增量自动重试，天然自愈。
13. **Code Review 修复——无 schema db 降级**：`scanSqliteManifest` 与 `listSqliteSessionIds` 的 `transcript_events` 查询补 try/catch（与归档查询一致），0 字节/无 schema 的 db（升级中途可达）降级为空 manifest / 空 id 集，不再穿透为 `/api/stats` 500。同时清理遗留：`src/pricing.js` 空状态文案改指 `openclaw.json` 并接入 i18n（`pricing.openclawRefEmpty` 双语键）；`vitest.config.js` coverage include 由已删除的 `aggregator.js` 换成 `sqlite-source.js`。回归：33 文件 326 用例（1 skip）全绿。
14. **Code Review Minor 清理**：manifest 两条 SQL 补 `ORDER BY`（`manifestsEqual` 用 `JSON.stringify` 比较，行序不稳会产生假阴性空刷新）；`scanSqliteManifest` 头注释写明「两查询无跨语句快照，reset 归档落在其间会瞬态双计、下轮自愈」；清理过期注释（`stats-service.js` 两处「解析 JSONL」与「stats-v1 cache」、根 `pricing.js` 的 models.json 引用，`stats-service.js` 的「v1（JSONL 时代）」为准确历史描述故保留）；补测试——window 缺失→`active` 兜底、sync 线格式 sqlite/archive/legacy 混排 + `done`/`deleted` 状态回归（并修正原测试里误导性的 "missing window → active" 注释位置）。回归：33 文件 328 用例（1 skip）全绿。
15. **存储迁移归档恢复（2026-09-05）**：OpenClaw 升级存储迁移会把旧会话 JSONL 打包到 `agents/<agent>/session-sqlite-import-archive/`（文件名 `…​.<uuid>[-topic-<thread>].jsonl.imported-<ms>`），但迁移只把部分会话导入新 SQLite；未导入且不在 legacy 冻结缓存的会话会从统计丢失。恢复方案为 `scripts/import-session-archive.js`：解析全部 agent 的归档目录，跳过已在该 agent SQLite（`transcript_events`/`session_transcript_archives`/`session_windows`）或 legacy 冻结缓存中的会话（防双计），把剩余会话聚合为日级 bucket 的 source 快照写入 `cache/openclaw-usage/imports/archive-import.json`，走既有 imports 合并通道（要求 `openclaw-usage-sync.json` 的 `imports.allowedSourceIds` 含 `"archive-import"`）。幂等：contributionId = sha256(`archive-import\0<agent>\0<sessionId>`)，每次全量重建覆盖写。trajectory 变体（`.trajectory.jsonl`）与 `provider==='openclaw'` 内部镜像、全零 usage 行均过滤。claw 实测：1170→1198 归档会话（含 Matrix topic 会话），导入 1039 个 ≈ 75.4M tokens（2026-07-19→08-31）；topic 后缀会话 28 个全部已在 SQLite 中（迁移已覆盖），正确跳过。
