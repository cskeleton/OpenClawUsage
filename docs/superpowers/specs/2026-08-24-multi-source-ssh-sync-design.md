# 多来源 SSH 同步与统一统计设计

**日期**：2026-08-24
**状态**：待实施

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

路径：`$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json`，默认 `~/.openclaw/openclaw-usage-sync.json`。目录权限目标 `0700`，文件权限目标 `0600`，写入采用同目录临时文件加原子重命名。

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

- 导入目录：`$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/imports/`，目录 `0700`，每来源快照 `0600`。
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

新增统一设置页，代码在两端完全相同，字段由 `instance.capabilities` 决定。页面展示当前 source、可选择的预授权 target、启用状态、间隔、最近同步结果，以及“测试连接/立即同步”等可用操作。

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

## 验收标准

1. 无配置时全部既有测试和单来源页面行为通过。
2. MBP 真实或脱敏基线贡献可通过 `ssh claw` 成功接收，且接收文件不含禁止字段。
3. `claw` 的 All/claw/MBP 统计满足 `All = claw + MBP` 的 token/request 聚合关系；修改 `claw` 价格后两来源成本一起重算，不需重新同步。
4. 未授权来源、畸形快照、SSH 注入式 target、传输中断均 fail closed，并保留最后成功数据。
5. 浏览器可筛选来源、查看来源状态、手动同步与编辑允许的设置；两种语言和两种主题下可用。
6. 定时任务失败后不密集重试，状态显示最近成功及失败/过期起点。
7. 本机与 `claw` 的最终部署均健康；`claw` 仍为 `0.0.0.0:3001`，服务由 user systemd 管理。
