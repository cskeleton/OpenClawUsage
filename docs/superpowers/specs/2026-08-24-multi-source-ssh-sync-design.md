# 多来源 SSH 同步与统一统计设计

**日期**：2026-08-24
**状态**：已实施（2026-08-24 Post-Implementation Sync Audit）

> 历史记录：本文最初以“待实施”状态作为 Task 1–5 的设计事实源；以下审计在实现完成后补充实际接口、路径与有意澄清，不删除原始安全要求和验收标准。

## 背景

用户在家庭 LAN 中运行两套 OpenClaw：常驻设备 `claw` 与可能随身带出门的 MBP。两端可通过 `ssh claw`（LAN 或 ZeroTier）通信。两端应运行同一套 OpenClawUsage；MBP 可独立查看自己的统计，`claw` 则汇总本机和 MBP 等多个来源。

本方案不引入数据库、常驻中心客户端协议或新的认证系统。同步频率低，默认每 60 分钟一次；连接失败不密集重试，保留上次成功数据并等待下一轮或手动同步。

## 目标

1. MBP 把不含消息正文、文件路径、凭据和价格结论的统计贡献快照推送到 `claw`。
2. `claw` 使用自己的价格配置对所有来源统一计算成本，并在价格变化后无需重新同步即可重算。
3. Web UI 在所有部署中保持同一套页面和代码，通过实例能力显示适用的来源筛选、设置和同步操作。
4. 来源筛选覆盖汇总卡片、图表、明细、Provider/Model 选项和 Session 表格。
5. SSH 连接只允许管理员预先写入配置文件的别名；Web UI 不得配置任意主机、命令、远程路径或凭据。
6. 支持定时、网页手动和命令行手动同步，并准确展示最近成功时间与过期/失败状态。

## 非目标

- 不同步原始 JSONL、消息正文、提示词、响应、工具调用或 OpenClaw 配置。
- 不在 v1 实现双向合并、中心主动拉取、实时推送或高频重试。
- 不让 Web UI 管理 `~/.ssh/config`、私钥、SSH 参数、远程命令或远程路径。
- 不要求 MBP 与 `claw` 使用相同价格配置。
- 不改变用户已接受的 `claw` 监听地址 `0.0.0.0:3001`。

## 总体结构

- 每个实例有稳定的 `source.id` 与展示用 `source.label`。
- 本地 JSONL 仍由现有增量缓存解析成价格无关的逐文件贡献。
- 导出器将本地贡献转换为脱敏、可验证、版本化的完整来源快照。
- 发送端通过参数化 SSH 进程调用固定的远端接收命令，以标准输入传输快照。
- 接收端校验来源 allowlist、版本、结构与数值后原子替换该来源的最后成功快照。
- 统计服务将本地贡献与所有有效导入快照合并，再统一调用现有 `mergeFileContributions`。

每次同步都是某来源的**完整替换**，不做跨机器增量补丁。文件规模仍远小于原始 JSONL，且能避免部分批次、删除传播和顺序问题。

## 配置文件

路径：`$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json`，默认 `~/.openclaw/openclaw-usage-sync.json`。目录/文件权限目标分别为 `0700`/`0600`；应用写入路径通过同目录临时文件、原子重命名和 `chmod` 强制这些权限。`loadSyncConfig` 只校验内容，不会自动修复手工创建文件的权限；手工配置必须在写入 JSON 后显式执行 `OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"`、`mkdir -p "$OPENCLAW_CONFIG_DIR"`、`chmod 700 "$OPENCLAW_CONFIG_DIR"` 和 `chmod 600 "$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json"`。

MBP 示例：

```json
{
  "version": 1,
  "source": { "id": "mbp", "label": "MBP" },
  "policy": {
    "allowedSshTargets": {
      "claw": { "label": "claw", "sshAlias": "claw" }
    }
  },
  "settings": { "enabled": true, "targetId": "claw", "intervalMinutes": 60 },
  "imports": { "allowedSourceIds": [] }
}
```

`claw` 示例：

```json
{
  "version": 1,
  "source": { "id": "claw", "label": "claw" },
  "policy": { "allowedSshTargets": {} },
  "settings": { "enabled": false, "targetId": null, "intervalMinutes": 60 },
  "imports": { "allowedSourceIds": ["mbp"] }
}
```

### 信任边界

- `~/.ssh/config` 管理主机、用户、端口、密钥、ProxyJump 与连接细节。
- `policy.allowedSshTargets` 是应用层 allowlist。同步请求只接受其键 `targetId`，后端解析到固定 `sshAlias`。
- `sshAlias`、`targetId`、`source.id` 采用严格标识符格式；不得包含空白、路径分隔符或 shell 元字符。
- 后端使用 `execFile` 参数数组，不拼接 shell 字符串；远程只调用固定命令 `openclaw-usage receive-sync`。
- Web UI 仅可修改 `settings.enabled`、从 allowlist 选择 `settings.targetId`、合法同步间隔和展示 label；不得写 policy、SSH alias、凭据、远程路径或命令。
- `source.id` 一旦已有导出/导入状态就不可通过 Web UI 修改，避免来源身份分裂。

## 脱敏同步快照

顶层结构：

```json
{
  "version": 1,
  "kind": "openclaw-usage-source-contributions",
  "scope": "local-only",
  "source": { "id": "mbp", "label": "MBP" },
  "revision": "opaque-revision",
  "generatedAt": "2026-08-24T12:00:00.000Z",
  "contributions": []
}
```

每条贡献仅包含：

- `contributionId`：由本地文件身份名称单向散列得到的不透明稳定 ID，不暴露 filename。
- `session`：`id`、`status`、`archivedAt`。
- `firstTimestamp`、`lastTimestamp`。
- `buckets[]`：`date`、`provider`、`model`、`usage.input/output/cacheRead/cacheWrite/totalTokens`、`openclawCost`、`requests`。
- 必要的 `hasRecords` 等布尔聚合标记。

禁止包含：消息正文、prompt/response、工具调用、文件路径、filename、文件 size/mtime、manifest、OpenClaw 配置、价格配置、凭据、日志与预计算 `totalCost`。

`openclawCost` 必须保留，因为当接收端关闭自定义价格或没有匹配规则时，现有口径会回退到 OpenClaw 写入会话的 cost。最终 `totalCost` 一律由查看端在合并时计算。

接收端为贡献键增加 `${sourceId}:` 命名空间，展示用 Session ID 也使用 `${sourceId}:${sessionId}`，避免不同机器的相同文件名或 Session ID 冲突。

## 存储、校验与失败语义

- 导入目录：`$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/imports/`，应用接收写入路径强制目录 `0700`、每来源快照 `0600`；读取已有文件不自动修复权限。
- 接收端先在内存中完成大小限制、JSON 解析、schema/version/kind/scope、allowlist、来源一致性、字段类型、有限非负数和数组上限校验，再原子替换。
- 损坏、版本不兼容、未授权来源或中断传输均不得覆盖上一次成功快照。
- 成功接收后使共享统计缓存失效；下一次统计请求合并新快照。
- 导入来源过期或未收到新数据时，继续计入“所有来源”总数，但 UI 显示警告。
- 发送端记录最近尝试、最近成功与最近错误开始时间；发送端能显示精确 SSH 失败，接收端只能根据“最后收到时间 + 期望间隔”判断未同步。
- SSH 失败不立即循环重试；下一次定时或人工触发再试。

## 定时与手动同步

- CLI：`openclaw-usage sync [targetId]`，未给 target 时使用配置的 `settings.targetId`。
- 接收 CLI：`openclaw-usage receive-sync`，只从 stdin 读取单个快照并返回确定的退出状态。
- Web：现有刷新下拉中，在配置了 outbound target 的实例显示“同步到 claw / Sync to claw”。
- 调度器使用同一 CLI，同步间隔默认 60 分钟。macOS 通过 LaunchAgent 定时启动；休眠或离线后不补做密集重试，下次调度继续。Linux 提供 user systemd timer。
- Web 服务与调度器互不依赖；网页未打开时也可同步。

## 统计服务与 API

`GET /api/stats` 保留现有顶层合并统计字段，确保既有 UI/MCP 调用兼容；新增：

- `instance`：当前来源与经过脱敏的 capabilities。
- `sources[]`：动态来源列表、local/imported、最后收到/成功时间、状态和过期信息。
- `statsBySource`：以 source ID 为键的同结构统计结果。

本地来源和导入来源分别生成统计，合并统计则把全部价格无关贡献一次性交给 `mergeFileContributions(all, localPricingConfig)`，因此 `claw` 的价格修改可统一重算所有来源。

MCP 默认继续返回合并统计；现有工具契约不因来源功能而破坏。

## Web UI

### Dashboard

- 在 Provider/Model 之前增加“所有来源 / All sources”筛选，选项来自 `sources[]`。
- 来源筛选作用于汇总卡片、所有图表、Provider/Model 下拉、Breakdown 与 Session 表格。
- Session 表格增加 Source 列。
- 切换来源保留日期范围并重置分页；清除维度筛选同时清除来源、Provider、Model。
- 已配置但还没有数据的来源仍展示；过期来源带明确警告和最近成功/收到时间。
- `claw` 通常显示 All、claw、MBP；MBP 通常只显示 All、MBP。

### Settings

新增统一设置页，代码在两端完全相同。Dashboard 从 `GET /api/stats` 响应的 `instance.capabilities` 字段读取来源筛选和同步能力；Settings 从 `GET /api/sync/config` 响应的公开 `capabilities` 字段决定字段与操作。页面展示当前 source、可选择的预授权 target、启用状态、间隔、最近同步结果，以及“测试连接/立即同步”等可用操作。

必须显示以下帮助说明：

> SSH 连接由本机 `~/.ssh/config` 管理。本页面只能选择已在 `$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json` 中预先允许的 SSH 别名，不保存凭据，也不能配置任意主机、SSH 参数、远程路径或命令。

英文：

> SSH connections are managed by the local `~/.ssh/config`. This page can only select SSH aliases pre-authorized in `$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json`. It does not store credentials or allow arbitrary hosts, SSH options, remote paths, or commands.

空 allowlist 时页面提供 README 配置指引，不渲染任意主机输入框。

## HTTP 写接口安全

- 继续使用现有 same-origin/loopback Origin 与 JSON Content-Type guard。
- 设置 API 只接收明确 allowlist 字段，忽略或拒绝额外敏感字段。
- 同步 API 只接受 target ID，后端重新从 policy 解析。
- HTTP 响应不返回完整配置文件、SSH alias 之外的连接细节、路径、错误堆栈或原始 SSH 输出。

## 文档、兼容与部署

- `README.md` 与 `README_EN.md` 同步说明架构、脱敏字段、SSH alias 配置、Web 设置边界、CLI、调度和故障语义。
- 未创建同步配置时维持现有单来源行为，来源默认为本机且不显示 outbound 操作。
- `claw` 继续监听 `0.0.0.0:3001`，使用 user systemd 管理 Web 服务与可选同步 timer。
- 本机使用现有 `openclaw-usage` 启动器，并安装 LaunchAgent 调度器。
- 实施完成后进行 Post-Implementation Sync Audit，将实际接口、路径和偏差回写到本规格。

## Post-Implementation Sync Audit（2026-08-24）

本节将设计与当前实现逐项对齐，实际实现是本文在后续维护中的事实源。

### 已实施内容与实现路径

- 配置与权限：`sync-config.js` 读取 `$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json`（默认 `~/.openclaw/openclaw-usage-sync.json`），缺失时返回禁用的单来源 `local` 默认值；应用写入使用同目录临时文件 + 原子 rename 并强制配置目录 `0700`、文件 `0600`，load 不自动修复手工文件权限。
- 脱敏导出与接收：`sync-snapshot.js` 只导出本文定义的 envelope、贡献、会话、bucket、`usage`、`openclawCost` 和布尔标记；贡献 ID 为不透明 SHA-256。接收文件为 `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/imports/<sourceId>.json`，应用接收写入路径强制导入目录 `0700`、文件 `0600`，校验在原子替换前完成。
- SSH 传输与状态：`sync-service.js` 通过 `execFile('ssh', args)` 使用 allowlist 解析出的 alias 和固定 `openclaw-usage receive-sync`，单次执行无内部重试；状态写入 `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/sync-status.json`，保留 `lastAttempt`、`lastSuccess`、`failureSince`、`targetId` 和安全错误分类。
- 本地缓存仍由 `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v1.json` 管理；导入快照不写入本地 JSONL 逐文件缓存，接收成功后使共享统计缓存失效。
- 汇总与统一定价：`stats-service.js` 在每次组合统计请求加载有效导入快照，将本地/导入贡献按 `${sourceId}:` 命名空间隔离，再以同一个接收端价格配置执行 `mergeFileContributions`。`GET /api/stats` 保留既有字段并增加 `instance`、`sources`、`statsBySource`；`cache.combinedRevision` 是包含本地 revision/source identity/pricing 和每个导入来源状态、接收时间及 canonical snapshot 内容的 SHA-256 身份。
- Dashboard/Settings：`src/main.js` 从 `GET /api/stats` 响应的 `instance.capabilities` 字段读取同步菜单能力，`src/settings.js` 从 `GET /api/sync/config` 响应的公开 `capabilities` 字段读取设置目标与操作；来源筛选覆盖汇总、图表、Provider/Model、Breakdown 和 Session；`settings.html` 不渲染任意 host/user/key/options/path/command/credential 控件。

### 实际 HTTP 路由

同步相关 API 的准确路径如下；写请求继续受 same-origin/loopback Origin 与 JSON Content-Type guard 保护。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/sync/config` | 返回公开 source/settings/capabilities；不返回 alias、policy、路径或凭据 |
| GET | `/api/sync/status` | 返回发送端公开状态与 allowlisted target 的 ID/label |
| PUT | `/api/sync/settings` | 仅接收 `enabled`、`targetId`、`intervalMinutes`、`label` |
| POST | `/api/sync/run` | 仅接收可选 `{ "targetId": "..." }`，手动发送完整快照 |
| POST | `/api/sync/test` | 仅接收 `{ "targetId": "..." }`，执行固定 probe，不导出/存储贡献 |

`GET /api/stats` 的组合响应增加 `instance`、`sources`、`statsBySource`，`GET /api/refresh`、MCP 统计和已有定价路由保持兼容。

### Probe、保留字与状态规则

- `testSyncTarget` 发送的固定 probe envelope 是 `{ "version": 1, "kind": "openclaw-usage-sync-probe", "scope": "transport-only" }`；接收端识别后只返回成功，不创建导入文件。
- `all` 在 `sync-config.js` 中保留，不能作为 `source.id` 或 `imports.allowedSourceIds`；Dashboard 的 `all` 仅是汇总筛选值。allowlist target ID 仍通过配置解析，不接受任意 SSH 输入。
- 发送端的状态字段精确为 `lastAttempt`、`lastSuccess`、`failureSince`；失败不会覆盖既有 last-success，连续失败复用首次 `failureSince`，成功清除 `failureSince`。
- 接收端对已收到来源用导入文件的 `lastReceivedAt`（最后成功原子替换时间）计算 `lastReceivedAt + intervalMinutes`；未配置 interval 的远端数据不被信任，实际复用接收端 settings。配置但没有快照的来源为 `missing`，过期来源为 `stale`；二者仍出现在 `sources[]`，并继续计入 All。

### 调度器与部署实现

- `scripts/install-local-launcher.sh` 安装 `~/bin/openclaw-usage`，CLI 帮助的同步命令为 `sync [targetId]`、`receive-sync`、`sync-status`；`sync --scheduled` 读取 `settings.enabled`，手动 `sync [targetId]` 不受该开关限制。
- `scripts/install-sync-scheduler.sh` 在 macOS 生成 `~/Library/LaunchAgents/com.openclaw.usage.sync.plist`（`StartInterval`，默认 60 分钟）；Linux 转调 `scripts/install-systemd-user-service.sh` 生成 `~/.config/systemd/user/openclaw-usage-sync.service` 与 `.timer`，默认 `OnBootSec=5min`、`OnUnitActiveSec=<interval>min`、`Persistent=false`。`--sync-only` 仅安装同步单元，不接管 Web 生命周期。
- `deploy/openclaw-usage.service`、`deploy/openclaw-usage-sync.service`、`deploy/openclaw-usage-sync.timer` 是由 installer 填充绝对路径的 user-systemd 模板；Web 默认 `127.0.0.1:3001`，可在用户接受的 LAN/ZeroTier 边界显式安装 `--host 0.0.0.0 --port 3001`，服务无认证，不得公网暴露。

### 有意澄清与实现偏差

1. **导入过期 interval**：快照 envelope 不携带可被远端伪造的期望 interval；stale 计算复用接收端 `settings.intervalMinutes`，以 `lastReceivedAt` 为起点。这是对“接收端判断过期”的安全化具体化。
2. **组合数据的生命周期**：实现采用每请求合并有效导入快照；导入内容保留在独立 imports 目录，不写进本地 `stats-v1.json`，通过 `cache.combinedRevision` 和成功接收后的失效通知保证替换/删除可见。这与“共享缓存失效”目标一致，但不把跨来源数据伪装为本地 JSONL 文件贡献。
3. **Linux 部署范围**：实现的是 user systemd unit/timer（`~/.config/systemd/user`），不是 system-wide unit；`--sync-only` 使调度器与 Web 服务生命周期保持独立。
4. **接收时间字段**：`sources[].lastReceivedAt` 使用接收文件 mtime 的 ISO 表示，快照中的 `generatedAt` 单独保留；若文件在枚举后被替换/删除，当前已验证快照仍以其 `generatedAt` 作保守回退。
5. **连接测试**：Web “测试连接”是 transport-only probe，不会生成或替换来源贡献；真正的完整快照替换只发生在 `sync`/`/api/sync/run`。

## 验收标准

1. 无配置时全部既有测试和单来源页面行为通过。
2. MBP 真实或脱敏基线贡献可通过 `ssh claw` 成功接收，且接收文件不含禁止字段。
3. `claw` 的 All/claw/MBP 统计满足 `All = claw + MBP` 的 token/request 聚合关系；修改 `claw` 价格后两来源成本一起重算，不需重新同步。
4. 未授权来源、畸形快照、SSH 注入式 target、传输中断均 fail closed，并保留最后成功数据。
5. 浏览器可筛选来源、查看来源状态、手动同步与编辑允许的设置；两种语言和两种主题下可用。
6. 定时任务失败后不密集重试，状态显示最近成功及失败/过期起点。
7. 本机与 `claw` 的最终部署均健康；`claw` 仍为 `0.0.0.0:3001`，服务由 user systemd 管理。
