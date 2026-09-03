# 设计规格：持久化增量统计缓存

**日期**：2026-08-01
**状态**：已实施（2026-08-01）

## 实施摘要

| 项 | 说明 |
| --- | --- |
| 新增模块 | `stats-cache-store.js`、`stats-contribution.js` |
| 服务层 | `stats-service.js` 重写：持久化、增量/全量刷新、`cache` 三态 |
| HTTP | `GET /api/stats?fresh=1`、`GET /api/refresh?full=1` |
| MCP | `refresh_stats_cache` 可选 `full`；统计工具按需 `waitForRefresh` |
| 前端 | `init` 拆分为事件绑定 / 数据加载 / 渲染；刷新下拉与 `cache` 状态展示 |
| 测试 | `tests/integration/stats-service/cache.test.js` 扩展；`npm test` 通过 |
| 默认定价 `updated` | 无配置文件时为稳定值 `0001-01-01T00:00:00.000Z` |

## 实现偏差与说明

1. **单文件解析稳定性重试**：解析期间文件身份变化时最多重试一次；测试中偶发 2 次 `parseSessionJsonlRaw` 调用属预期。
2. **同进程刷新去重与全量排队**：通过 `inflightRefresh` Promise 去重；若进行中的是增量而新请求为 `full: true`，则在增量结束后再跑一次全量（不得静默降级）。并发增量之间仍共享同一 inflight。
3. **跨进程竞争（选项 A）**：先 `tryAcquireLock`；未拿到则 `waitForLockRelease` 后**对照当前最新 manifest（及 sourceId）**判断磁盘快照是否够新；够新才采纳并合并到内存（定价指纹一致时复用磁盘 `stats`，否则只重计价），**不重复解析 JSONL**。磁盘落后于最新源时不得采纳过期快照。本方请求为 `full: true` 时，仅当磁盘快照带 `buildMode: 'full'`、manifest 对齐，且 `revision` 相比等待前已前进，才视为由本轮持锁方新发布的等价结果；否则重新抢锁自行全量构建（抢不到锁时退化为进程内全量，不得静默吞掉 full）。锁释放后仍无可用磁盘缓存时再抢一次锁成为构建方；仍失败则保留旧结果为 `stale`（无旧结果或本方要求 full 时仅构建进程内缓存）。
4. **前端键盘导航**：下拉支持 Esc / 点击外部关闭；方向键聚焦首项，完整 roving tabindex 未单独实现。
5. **性能复测**：本地真实数据性能复测未纳入 CI；需在开发机手动验证。
6. **`aggregateStats()`**：保留于 `aggregator.js` 供直接全量聚合；运行时路径经 `stats-service` 增量链路。
7. **审查后小修（已并入实现）**：无旧结果时刷新失败继续抛出；定价变化内存命中路径与磁盘路径一致地只重计价；`revision` 防护曾用于「先构建再抢锁」过渡方案，现已由选项 A 的锁优先流程取代。
8. **验收审查修复轮次（2026-08-01）**：
   - 空的 `memory.manifest`（`{}` / 无条目）不得作为增量基线；冷启动 / 模块重置后以磁盘 manifest+files 为基线，源未变时增量刷新不重新解析任何 JSONL。
   - 可写探针文件名改为 `.write-test.<pid>.<random>`，避免并发探测互踩误判不可写。
   - 磁盘命中且定价指纹未变时直接返回已缓存 `stats`（不重新 merge、不改写 `generatedAt` / `revision`）。
   - `getStats({ forceFresh: true })` 必须真正走刷新路径，不得因缓存已 `fresh` 而短路；`waitForRefresh`（HTTP `?fresh=1`）仍仅在检测到变化时等待。
   - 持久化快照新增可选字段 `buildMode: 'full' | 'incremental'`，并结合等待前后的 `revision` 前进判断 full 语义是否由本轮持锁方满足；旧缓存缺少该字段、对方只发布增量快照或 revision 未前进时，full 请求均视为不等价并自行重建。

## 背景

改造前，`stats-service.js` 使用 30 秒、进程内生存的聚合缓存。缓存过期、服务重启或定价变更后，下一次 `GET /api/stats` 会重新扫描全部 Session JSONL。Web API 与 MCP 分别运行时，二者的模块级缓存也不共享。

本地真实数据基准（2026-08-01）如下：

| 指标 | 结果 |
| --- | ---: |
| 有效 Session 文件 | 419 |
| 文件总量 | 763.77 MiB |
| 聚合出的 Session | 135 |
| 聚合出的请求 | 7,441 |
| 全量聚合 | 约 5.3–5.6 秒 |
| 命中进程内缓存 | 约 0.6 毫秒 |
| `/api/stats` JSON | 约 0.12 MiB |

最近 30 分钟只有 2 个文件发生变化，因此主要问题不是页面发出一次 API 请求，而是当前实现把缓存过期等同于全量重算。

## 目标

1. 页面每次打开仍可请求 `/api/stats`，但 Session 与定价未变化时不得重新解析 JSONL 或重新聚合。
2. 服务重启后复用持久化缓存；Web 与 MCP 共享同一份缓存结果。
3. 检测到变化时先返回最后成功结果，后台只处理新增、修改或删除的文件，完成后页面自动更新。
4. 普通刷新默认增量；另提供明确的全量重建入口，作为缓存校验与故障恢复手段。
5. 缓存损坏、刷新失败或数据源暂时不可用时保留最后成功结果，不静默展示不完整统计。

## 非目标

- 不在浏览器使用 IndexedDB、LocalStorage 或 Cache Storage 持久化统计结果。
- 不引入数据库、文件系统 watcher 或第三方缓存服务。
- v1 不实现 JSONL 追加偏移量续读；被修改的单个文件仍从头解析。
- 不改变统计口径、Session 文件识别规则、定价优先级或现有图表数据结构。

## 用户体验

### 页面首次打开

1. 页面正常请求 `GET /api/stats`。
2. 服务端优先读取内存或磁盘中的最后成功结果，并执行轻量的 Session 文件清单检查。
3. 若文件清单和定价未变化，立即返回 `fresh`，不打开任何 JSONL。
4. 若检测到变化，立即返回旧结果和 `refreshing`，后台执行增量刷新。
5. 页面收到 `refreshing` 后调用 `GET /api/stats?fresh=1`，刷新完成后无整页重载地替换数据。
6. 没有任何可用缓存时，首次请求等待一次完整构建；构建失败则沿用现有错误页。

自动替换数据时必须保留日期范围、自定义起止日期、状态筛选、搜索、排序、分页大小、当前页和 Model 对数坐标选项；仅当当前页超过新的最大页数时才收敛到最后一页。

### 刷新控件

- 现有刷新按钮改为**增量刷新**：检查全部文件身份，但只解析变化文件。
- 在刷新按钮旁增加下拉入口 **“全量刷新 / Full rebuild”**，默认收起；全量模式绕过所有逐文件缓存。
- 下拉支持键盘打开、方向键/Tab 导航、Enter/Space 触发、Esc 关闭和点击外部关闭。
- 两种刷新期间都保留当前页面数据，禁用重复提交并显示进度；失败时保留旧数据并显示中英双语非阻塞提示。

## 服务端缓存模型

### 路径与权限

- 缓存目录：`$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/`
- 缓存文件：`stats-v1.json`
- 跨进程锁：`stats-v1.lock`
- 目录权限目标为 `0700`，文件权限目标为 `0600`。

缓存跟随 `OPENCLAW_CONFIG_DIR`，因为它的有效性绑定 Session 数据源；它不跟随用于定价文件的 `OPENCLAW_DIR` 或 `agents.defaults.workspace`。

### 顶层结构

持久化文件至少包含：

- `schemaVersion`：缓存结构和解析语义版本；不兼容变更必须递增。
- `sourceId`：由规范化后的 Session 根目录生成的哈希；API 只暴露哈希，不暴露绝对路径。
- `pricingFingerprint`：覆盖 `version`、`enabled`、`updated` 和保持声明顺序的 `pricing` 内容。
- `manifest`：所有有效 Session 文件的文件名、大小和 mtime。
- `files`：逐文件、与自定义定价无关的统计贡献；无 usage 的文件也保存空贡献。
- `stats`：最后成功的完整聚合结果。
- `revision`、`generatedAt`、`checkedAt`：结果版本和时间信息。
- `buildMode`（可选）：本轮发布时的构建方式（`full` | `incremental`）；跨进程等待方在本方要求全量时用其判断磁盘结果是否等价于 full。

无定价文件时，默认配置的 `updated` 必须使用稳定值，不能在每次读取时生成新时间戳。

### 逐文件贡献

逐文件缓存不保存完整消息或原始 JSONL 行，只保存重建现有聚合所需的最小字段：

- Session 元数据：`id`、`status`、`archivedAt`、`filename`。
- 文件身份：`size`、`mtimeMs`。
- 按 `date + provider + model` 分组的 token、请求数和 OpenClaw 原始 cost 汇总。
- 会话首末时间，以及无 timestamp 记录的汇总贡献。

这些字段足以在定价配置变化后重新计算成本，并重建 `summary`、`byProvider`、`byModel`、`byDate`、`byDateProvider`、`byDateModel` 和 `sessions`，无需重新读取 JSONL。

## 新鲜度与增量算法

1. 枚举 Session 目录顶层文件，继续复用 `parseSessionFile()` 排除 `sessions.json`、probe、checkpoint 和未知格式。
2. 对有效文件收集文件名、大小和 mtime，并按文件名稳定排序。
3. 与缓存 manifest 比较：
   - 身份相同：复用逐文件贡献。
   - 新增或身份变化：从头解析该文件。
   - 已删除：移除对应贡献。
4. 合并全部逐文件贡献，并按当前定价生成完整统计。
5. 仅在本轮所有必需文件读取成功后发布新快照。

同一进程可在 1 秒内复用最近一次文件清单检查，避免页面和 MCP 的密集请求重复 `stat`；这只合并检查，不延长数据缓存 TTL。

文件在解析期间继续变化时，最多立即重试一次；仍不稳定则放弃本轮发布并保留旧快照。单行 malformed JSON 继续沿用现有“跳过该行”语义，文件打开或读取失败则视为整轮刷新失败。

## 并发与持久化安全

- 同一进程中的刷新由一个 in-flight Promise 去重；若 inflight 为增量而新请求要求全量，则在 inflight 结束后再执行全量（`full` 语义不得被吞掉）。
- Web 与 MCP 进程通过独占创建 `stats-v1.lock` 协调：**先抢锁再构建**；未拿到锁的一方等待锁释放后重新扫描最新 manifest，仅当磁盘快照 `sourceId` + manifest 对齐（且本方 `full` 时磁盘 `buildMode === 'full'`、`revision` 相比等待前已前进）才采纳合并，否则重新抢锁自行构建，不得采纳过期快照、等待前遗留的旧 full 快照或吞掉 full 语义。
- 锁记录 PID 和开始时间；超过 120 秒且持有进程已不存在时才允许回收。无法确认进程已退出时不得抢锁。
- 新快照写入同目录的唯一临时文件，完成后原子重命名为 `stats-v1.json`；所有异常路径都在 `finally` 中清理自身锁和临时文件。
- 缓存目录可写探针使用唯一文件名（`pid` + 随机后缀），避免多进程并发探测互踩。
- 缓存 JSON 损坏、schema 不匹配或 `sourceId` 不一致时忽略整份磁盘缓存并重建，不能部分复用未经验证的数据。

## 失败语义

- 有最后成功结果时，任何检查、解析、定价或写入失败都返回旧结果并标记 `stale`。
- 没有缓存且 Session 目录不存在时，保持现有兼容行为：返回空统计；后续目录出现时正常增量构建。
- 已有非空缓存但 Session 目录暂时不存在时，不得用空统计覆盖缓存；返回旧结果并标记 `stale`。
- Session 目录存在且确实为空时，空 manifest 是有效的新状态，可发布空统计。
- 缓存目录不可写时继续提供进程内缓存；同时告警持久化能力不可用。
- API 或 UI 不暴露缓存文件绝对路径、锁 PID 或内部错误堆栈。

## API 与共享服务接口

### HTTP

- `GET /api/stats`
  - 保持现有统计字段。
  - 新增顶层 `cache`：`state`（`fresh | refreshing | stale`）、`revision`、`sourceId`、`checkedAt`。
- `GET /api/stats?fresh=1`
  - 等待当前必要的增量刷新完成后返回。
  - 无法刷新且存在旧结果时仍返回旧结果和 `stale`；仅在没有任何结果时返回 5xx。
- `GET /api/refresh`
  - 默认执行并等待增量刷新。
- `GET /api/refresh?full=1`
  - 忽略逐文件贡献并全量重读，完成后原子替换缓存。

保留 `GET /api/refresh` 形式以兼容现有调用；本期不迁移为新的 HTTP method。

### MCP

- `refresh_stats_cache` 增加可选 `full: boolean`，默认 `false`。
- description 更新为中英双语，说明默认增量、`full: true` 全量。
- 统计查询在需要时等待增量刷新完成，确保单次 MCP 查询得到确定结果。
- `get_pricing_config`、`update_pricing_config` 和 `refresh_stats_cache` 不得在分发前无条件调用 `getStats()`。

### 服务层

保留 `getStats()`、`refreshStatsCache()`、`invalidateStatsCache()` 的现有导出名称，扩展 options 而不是复制 Web/MCP 两套缓存。内部明确区分：

- 清除或重建最终聚合结果。
- 复用逐文件贡献的增量刷新。
- 绕过逐文件贡献的全量刷新。

`getStats` options：

- `waitForRefresh`：检测到变化时等待增量刷新完成（HTTP `?fresh=1` / MCP 统计工具）。
- `forceFresh`：无论缓存是否已 `fresh`，都必须执行一次增量刷新路径后再返回（不得短路）。

价格更新使最终统计失效，但保留与定价无关的逐文件贡献。

## 前端结构调整

- 将 `init()` 拆分为一次性事件绑定、数据请求和数据渲染三个阶段。
- 手动刷新和后台新结果只调用数据渲染，不重复绑定监听器。
- `cache.state` 的用户可见状态、刷新菜单和失败提示全部进入 `src/locales/{zh-CN,en-US}.js`。
- 不在浏览器持久化统计数据；页面刷新后始终从服务端缓存读取。

## 测试与验收

### 自动化测试

- 冷启动构建并写入缓存；清空模块状态后从磁盘复用。
- 未变化请求不打开 JSONL；单文件新增、修改、删除只影响对应贡献。
- 无 usage 文件被缓存，后续请求不重复解析。
- 定价变化只重新计价；默认定价 fingerprint 稳定。
- 损坏缓存、schema/source 不匹配、不可写目录、原子写失败和陈旧锁恢复。
- 同进程请求去重（含「增量进行中请求 full 仍会全量刷新」），以及等待方在磁盘对齐时不重复解析的跨进程锁协调。
- 等锁后磁盘落后于最新源、本方 `full` 而磁盘仅为增量结果、或磁盘仍是等待前的旧 full revision 时，不得采纳过期/不等价快照；本轮新发布且 revision 前进的 full 快照仍可直接采纳。
- 冷启动（空 memory.manifest）增量刷新以磁盘为基线，源未变时不重新解析。
- 并发可写探针稳定返回 true；磁盘命中且定价未变时不重新 merge；`forceFresh` 在已 fresh 时仍触发刷新。
- 解析期间追加、文件读取失败、Session 目录暂时消失和真实空目录。
- HTTP 三态、`fresh=1`、默认增量刷新和 `full=1`。
- MCP 价格工具不触发统计解析；`refresh_stats_cache` 默认增量、`full: true` 全量。
- 前端先显示旧结果再自动替换，并保持筛选/排序/分页状态且不重复绑定事件。

### 验收标准

1. Session 和定价未变化时，打开页面不读取任何 JSONL。
2. 单文件变化时只重新读取该文件；只有全量入口读取所有有效文件。
3. 服务重启后可直接复用磁盘缓存；Web/MCP 不重复全量扫描。
4. 后台刷新失败不清空最后成功页面，并显示明确的陈旧状态。
5. 缓存文件不包含消息正文、提示词、工具参数、凭据或绝对路径。
6. `npm test` 与 `npm run build` 通过；性能复测使用本地真实数据，但 CI 不使用易抖动的毫秒阈值。

## 实施顺序与同步审计

1. 先落地本规格及中英文 README 说明。
2. 以测试驱动方式实现逐文件贡献、持久化、锁和服务层状态机。
3. 更新 HTTP、MCP 和前端刷新交互。
4. 运行完整测试、构建和真实数据性能复测。
5. 执行 Post-Implementation Sync Audit：将实际缓存结构、接口差异、失败语义、测试结果和性能数据回写本规格，使其恢复为单一事实源，并将状态改为「已实施」。（已完成，见上文「实施摘要」与「实现偏差与说明」。审查修复轮次 2026-08-01：落实同进程 full 排队与跨进程锁优先/wait-for-lock。验收审查修复轮次 2026-08-01：等锁后校验最新 manifest、full 不被吞、空 memory.manifest 回落磁盘基线、唯一可写探针、磁盘命中免 remmerge、`forceFresh` 真刷新；最终修复轮次增加等待前后 revision 前进校验，拒绝把旧 full 快照误当成本轮结果；并同步 README / README_EN / AGENTS.md。）

## 附录：schema v3（2026-09-04，UTC 小时粒度）

- 贡献 bucket 的 `date` 从日级（`YYYY-MM-DD`）改为 UTC 小时级（`YYYY-MM-DDTHH`），`CACHE_SCHEMA_VERSION` 2 → 3，旧磁盘缓存整体失效并全量重建；legacy 冻结贡献按既有路径从 `stats-v1.json` 重新迁移。
- 合并输出新增 `byHourModel`（小时 × provider/model 交叉表）；`byDate` / `byDateProvider` / `byDateModel` / session 级日表仍由小时 bucket 上卷（`date.slice(0, 10)`），形状不变。`STATS_SHAPE_VERSION` 2 → 3。
- 旧快照的日级 bucket（无 `T`）不进 `byHourModel`，避免污染单日按小时视图；重新同步后自然获得小时粒度。
- `sync-snapshot.js` 的 bucket 校验放行小时键：`/^\d{4}-\d{2}-\d{2}(T\d{2})?$/`。
- 前端：`filterData` 新增 `byHour`（`sliceHourTable`，按 from/to 日区间与 provider/model matcher 切片）；单日范围且存在小时数据时趋势图按小时渲染（小时键为 UTC，标签转本地时区）。
