# OpenClaw Token 用量统计工具

> ⚠️ This document is the Chinese version. For English, see [README_EN.md](README_EN.md).

---

这是一个为 OpenClaw 开发的独立 Token 用量统计与可视化工具。它通过直接解析本地 Session 文件（JSONL 格式），提供实时的费用监控和数据分析。

## 🌟 核心功能

- **可视化仪表盘 (Web UI)**：基于 Vite + Chart.js 构建的暗黑风格界面。
  - **全量统计**：支持活跃（Active）、重置（Reset）和已删除（Deleted）的所有会话统计。
  - **时间筛选**：支持预设时间段（今天、最近 7 天、本月等）及自定义日期范围。
  - **Provider / Model 筛选**：可按某个 Provider 或某个具体 `provider/model` 过滤，与时间区间叠加；筛选后 **汇总卡片、全部图表与 Session 明细统一重算**，顶部以 chip 回显该维度在所选区间内的费用 / Tokens / 请求数。
  - **Provider / Model 消耗明细表**：按 Provider 或按 Model 两种维度汇总 Input / Output / Cache Read / Cache Write / Total Tokens、**费用($)**、费用占比与请求数，表头可排序，点击任意行即可下钻为筛选条件。
  - **度量指标**：统计 Input/Output Tokens、费用趋势、Provider 分布以及缓存命中（ Cache Read/Write）；首页汇总卡片中 **「总费用」置于最后一格**（前几张为 Tokens / Cache / Sessions 等）；按日趋势图支持 **Token / 费用** 两种视图切换；Provider 费用图 tooltip 会显示其占当前筛选后 Provider 总费用的比例。
  - **Model 对比**：每个 Model 显示一根由普通 Input、Cache Write、Cache Read 分段组成的 Input 柱，以及相邻的 Output 柱；默认跨 Provider 合并带日期 checkpoint 的变体，可通过控件恢复精确条目。
  - **交互体验**：Model 对比支持对数坐标（Log Scale），解决小数据量不可见问题；Session 明细支持分页、搜索与排序。
  
- **MCP 服务端 (Model Context Protocol)**：
  - 使 OpenClaw Agent 能够直接调用工具查询自己的 Token 消耗。
  - 提供 8 个工具：
    - 统计查询：`get_total_usage`、`get_usage_by_provider`、`get_usage_by_model`、`list_recent_sessions`、`get_session_stats`
    - 管理能力：`get_pricing_config`、`update_pricing_config`、`refresh_stats_cache`
  - MCP 工具描述（description）采用中英双语；工具名与输入字段名保持英文稳定标识。

- **自定义价格配置**：
  - 支持按 Provider/Model 组合配置自定义价格（单位 **$/M**，每百万 tokens）。
  - **两级开关**：可关闭「启用自定义价格」（全局），或对单条规则关闭「启用」，以便在**自定义单价重算的理论成本**与**会话中 OpenClaw 写入的账面成本**之间切换。
  - 价格配置页提供 **OpenClaw 内置价格（参考）** 与 **缺少价格的模型（参考）**：数据来自 `OPENCLAW_CONFIG_DIR`（默认 `~/.openclaw`）下的 `agents/main/agent/models.json`，两表在同一文件内按「有/无有效单价」划分；每张表可查看是否已被自定义规则覆盖（含通配符/正则），并对未覆盖项支持一键填入「添加新价格」。**实际在 OpenClaw 里可选的模型**由 `openclaw.json` 的 **`agents.defaults.models`** 决定，与参考表列出的条目并非一一对应。
  - 价格配置页「添加新价格」区提供 **从 models.dev 获取参考价** 按钮：弹出可搜索、单选的 [models.dev](https://models.dev) 公开模型目录，确认后**只填入 Input/Output/Cache Read/Cache Write 四个价格格**，不会写入模型键；价格格已有内容时可选择**全部覆盖 / 只填空白 / 取消**。目录在本地缓存 24 小时（`$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/models-dev-v1.json`），过期后先展示上次快照并后台刷新，首次拉取失败则直接报错（fail-closed）；填入后请自行确认 Provider/Model 再保存。
  - 支持 Input、Output、Cache Read、Cache Write 四种价格类型。
  - Cache 价格可选；留空时不设单独缓存价，**统一按 Input 原价计算**（读写都用 Input）。
  - 独立的价格配置页面，支持添加、编辑、删除和重置价格配置。

- **持久化增量统计缓存**：
  - 页面仍会请求服务端，但 Session 与定价未变化时直接复用持久缓存，不重新解析 JSONL。
  - 检测到变化时先返回最后成功结果，后台只处理变化文件；普通刷新默认增量，下拉菜单提供全量重建。
  - Web 与 MCP 共享同一缓存策略。完整设计见[持久化增量统计缓存规格](docs/superpowers/specs/2026-08-01-persistent-incremental-stats-cache.md)。

## 💰 价格配置文件路径

价格配置文件（`openclaw-usage-pricing.json`）采用**动态路径检测**，优先跟随 OpenClaw 工作目录而非固定路径，以确保多机器使用时配置可跟随。

### 路径优先级（由高到低）

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 1️⃣ | `OPENCLAW_DIR` 环境变量 | `OPENCLAW_DIR=/自定义/path` |
| 2️⃣ | `openclaw.json` 中的 `agents.defaults.workspace` 配置 | `$OPENCLAW_WORKSPACE` → 存到该 workspace 目录 |
| 3️⃣ | 回退 `~/.openclaw/` | 默认 fallback |

> ⚠️ 上表只决定**定价配置文件**的位置；**sessions 与 models.json** 始终读取 `$OPENCLAW_CONFIG_DIR`（默认 `~/.openclaw`），**不跟随 workspace**。

### 模型目录（models.json，用于价格参考 API）

| 变量 | 含义 |
|------|------|
| `OPENCLAW_CONFIG_DIR` | 配置根目录；未设置时默认为 `~/.openclaw` |
| 模型列表文件 | `$OPENCLAW_CONFIG_DIR/agents/main/agent/models.json` |

与 `OPENCLAW_DIR`（用于定价配置文件路径探测）相互独立，可分别指向不同根目录。

### 迁移逻辑

工具启动时会自动检查路径兼容性和迁移需求：

1. 优先读取新路径（跟随 OpenClaw 工作目录）。
2. 若新路径不存在，尝试旧路径 `~/.openclaw/openclaw-usage-pricing.json`。
3. 若旧路径存在，自动将其内容复制到新路径，完成无缝迁移。
4. 若两个路径均不存在，创建空配置（使用 OpenClaw 内置价格）。

### 示例

假设 `openclaw.json` 配置了 `"workspace": "$OPENCLAW_WORKSPACE"`，则价格配置实际存储在：

```
$OPENCLAW_WORKSPACE/openclaw-usage-pricing.json
```

而非 `~/.openclaw/` 下。这确保了配置与 OpenClaw 工作空间绑定，便于多机器共享或通过 dotfiles 管理。

## 📊 数据来源与原理

本工具通过监听和解析 OpenClaw 本地持久化目录实现统计：

- **目标路径**：`$OPENCLAW_CONFIG_DIR/agents/main/sessions/`（未设置环境变量时默认为 `~/.openclaw/agents/main/sessions/`）；与 `agents/main/agent/models.json` 同一配置根。**该路径不受 `agents.defaults.workspace` 影响**——workspace 只决定定价配置文件位置（见下文）。
- **覆盖文件**（目录**不递归**，仅扫描一层）：
  - `*.jsonl`: 当前活跃的 Session 记录。
  - `*.jsonl.reset.*`: 执行 `/reset` 命令后归档的旧 Session。
  - `*.jsonl.deleted.*`: 已删除 Session 的归档。
  - `*.checkpoint.*.jsonl`: **自动跳过**。checkpoint 中的消息与主文件/reset 副本重复，计入统计会双重记账。
  - `sessions.json`: Session 索引及其快照统计信息（不计入用量）。

- **数据采集点**：
  本工具逐行读取 JSONL 文件中基于 LLM API 返回的 `usage` 字段，示例如下：
  ```json
  {
    "usage": {
      "input": 41, "output": 66, "cacheRead": 0, "cacheWrite": 19934,
      "totalTokens": 20041,
      "cost": { "input": 1.23e-05, "output": 7.92e-05, "total": 0.00757 }
    },
    "provider": "minimax-portal", "model": "MiniMax-M2.7"
  }
  ```

## 🗄️ 持久化增量缓存

- **请求不等于刷新**：页面每次打开可以调用 `/api/stats`，但只有 Session 文件身份或定价发生变化时才重新聚合。
- **跨重启复用**：缓存保存到 `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v1.json`，供 Web 与 MCP 进程共享。
- **增量更新**：未变化文件复用逐文件统计贡献；新增、修改、删除文件才触发对应更新。定价变化只重新计算费用。
- **先旧后新**：发现变化时先返回最后成功结果，后台完成增量刷新后页面自动更新（`GET /api/stats?fresh=1`）。
- **两种手动刷新**：默认刷新为增量模式（`GET /api/refresh`）；刷新按钮下拉菜单中的「全量刷新」绕过所有逐文件缓存（`GET /api/refresh?full=1`）。
- **失败保护**：刷新失败或数据源暂时不可用时保留最后成功结果并标记为 `stale`，不静默覆盖为空数据。
- **不使用浏览器持久缓存**：页面刷新后仍从服务端读取，不使用 IndexedDB 或 LocalStorage 保存统计结果。
- **API `cache` 字段**：`GET /api/stats` 响应顶层含 `cache.state`（`fresh | refreshing | stale`）、`revision`、`sourceId`、`checkedAt`。
- **MCP**：`refresh_stats_cache` 默认增量，可选 `full: true` 全量重建；价格相关工具不触发统计聚合。

完整行为、缓存结构与验收标准见[设计规格](docs/superpowers/specs/2026-08-01-persistent-incremental-stats-cache.md)。

## 🔄 多来源 SSH 同步与统一统计

OpenClawUsage 支持 MBP → `claw` 的低频、单向完整快照同步。两端运行同一套 Web UI 和能力驱动（capability-driven）代码：MBP 可以独立查看本机，`claw` 可以把本机与 MBP 等来源合并查看。接收端使用自己的价格配置重新计算所有来源；修改 `claw` 的价格后不需要重新同步。

### 脱敏快照边界

同步传输的是一个完整、版本化的 JSON envelope，不是 JSONL 增量补丁。顶层字段是固定的：

```json
{
  "version": 1,
  "kind": "openclaw-usage-source-contributions",
  "scope": "local-only",
  "source": { "id": "mbp", "label": "MBP" },
  "revision": "opaque-revision",
  "generatedAt": "2026-08-24T12:00:00.000Z",
  "contributions": [
    {
      "contributionId": "opaque-sha256-id",
      "session": { "id": "session-id", "status": "active", "archivedAt": null },
      "firstTimestamp": "2026-08-24T11:00:00.000Z",
      "lastTimestamp": "2026-08-24T12:00:00.000Z",
      "buckets": [
        {
          "date": "2026-08-24",
          "provider": "provider",
          "model": "model",
          "usage": {
            "input": 10,
            "output": 20,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 30
          },
          "openclawCost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "total": 0
          },
          "requests": 1
        }
      ],
      "hasRecords": true
    }
  ]
}
```

允许字段只有上例中的顶层、贡献、会话、bucket、`usage` 和 `openclawCost` 字段；计数与成本必须是有限非负数，并且每个数值不超过 `90,071,992`（在最大贡献/ bucket 数量下仍可安全累计）。`usage` 与 `requests` 还必须是安全整数。`contributionId` 是由本地文件身份单向散列得到的不透明 ID，不暴露文件名。快照保留 `openclawCost`，因此接收端没有匹配的自定义价格或关闭自定义价格时，会回退到 OpenClaw 写入会话的 `usage.cost` 口径；最终 `totalCost` 始终由接收端合并时计算，快照中没有 `totalCost`。

快照禁止包含消息正文、prompt/response、工具调用、文件路径、filename、文件 size/mtime、manifest、OpenClaw 配置、价格配置、凭据、日志或任何预计算 `totalCost`。接收端先在内存中做大小、版本、类型、allowlist、数值安全边界和数组上限校验，任何不能安全累计的快照都会被拒绝；损坏、版本不兼容、未授权或中断输入都 fail closed，不会替换上一份成功快照。

### 同步配置与 SSH 信任边界

同步配置固定在 `$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json`（默认 `~/.openclaw/openclaw-usage-sync.json`）。应用写入路径会强制配置目录 `0700`、文件 `0600`，并使用同目录临时文件再原子重命名；读取只校验内容，不会自动修复手工创建文件的权限，读取到无效配置时也不会静默覆盖。复制 JSON 示例并写入文件后，请显式执行：

```bash
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
mkdir -p "$OPENCLAW_CONFIG_DIR"
chmod 700 "$OPENCLAW_CONFIG_DIR"
chmod 600 "$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json"
```

以下是可直接复制的最小配置示例。

MBP（发送端）：

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

`claw`（接收端）：

```json
{
  "version": 1,
  "source": { "id": "claw", "label": "claw" },
  "policy": { "allowedSshTargets": {} },
  "settings": { "enabled": false, "targetId": null, "intervalMinutes": 60 },
  "imports": { "allowedSourceIds": ["mbp"] }
}
```

来源 ID `all` 是保留字，不能作为 `source.id` 或 `imports.allowedSourceIds`；它只表示 Dashboard 的汇总筛选。`source.id`、target ID 和 `sshAlias` 都必须是严格标识符。同步请求只接受 allowlist 中的 `targetId`，后端解析到固定 `sshAlias`，以参数数组调用固定远程命令 `openclaw-usage receive-sync`，不会拼接 shell 字符串。

SSH 连接的第二层配置由本机 `~/.ssh/config` 管理，例如：

```sshconfig
Host claw
  HostName 192.0.2.20
  User your-user
  Port 22
  IdentityFile ~/.ssh/id_ed25519
  # ProxyJump / 其他连接细节也只放在这里
```

这里有两层明确的 policy：`~/.ssh/config` 决定主机、用户、端口、密钥、ProxyJump 等连接细节；`policy.allowedSshTargets` 决定应用允许使用哪些别名。Web 不保存 credential，也不允许填写任意 host、user、key、SSH options、remote path 或 command。预授权完成后，Settings 只允许修改 `settings.enabled`、从 allowlist 选择 `settings.targetId`、`settings.intervalMinutes`（1–10080 分钟）和展示用 `source.label`。

定时同步的配置不变量是：`settings.enabled` 为 `true` 时必须同时有 allowlist 中的 `settings.targetId`；配置校验和 Settings UI 都会阻止 enabled/no-target 组合。需要停用目标时先关闭定时同步，再清除 target。没有同步配置文件时保持旧的单来源行为，原始 Session UUID 和贡献键不会加来源前缀；进入多来源配置后，本地与导入来源使用来源 namespace。

Settings 中显示的安全提示为：

> SSH 连接由本机 `~/.ssh/config` 管理。本页面只能选择已在 `$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json` 中预先允许的 SSH 别名，不保存凭据，也不能配置任意主机、SSH 参数、远程路径或命令。

### CLI、定时与部署

`openclaw-usage help` 的同步相关帮助保持如下精确命令契约：

```text
  sync [targetId]    Push one sanitized snapshot to an allowlisted target
  receive-sync       Receive one sanitized snapshot from stdin
  sync-status        Print the last sync attempt/success/failure as JSON
```

`sync` 未传 target 时使用 `settings.targetId`；`receive-sync` 只从 stdin 接收一个快照；`sync-status` 只打印安全的公开状态。网页手动操作对应 `POST /api/sync/run` 和 `POST /api/sync/test`，设置对应 `GET /api/sync/config`、`GET /api/sync/status`、`PUT /api/sync/settings`；这些 API 供 Web/API 使用，不要求普通用户直接调用。所有手动同步都仍可运行，不受定时开关限制。

默认同步间隔为 60 分钟且一次运行不重试；失败后等待下一次调度或人工执行。macOS 使用 `./scripts/install-sync-scheduler.sh` 安装 LaunchAgent（`~/Library/LaunchAgents/com.openclaw.usage.sync.plist`）；Linux 使用同一安装器生成 user systemd service/timer（`~/.config/systemd/user/`），timer 使用 `Persistent=false`，不会因离线或休眠补发重试风暴。安装器会把本机 `node` 与 CLI 的绝对路径写入 LaunchAgent/systemd scheduler；定时执行 `openclaw-usage sync --scheduled`，每次运行都会读取 `settings.enabled`；关闭后跳过，手动 `openclaw-usage sync [targetId]` 仍可用。只有 remote non-interactive SSH receiver 需要在 PATH 中找到 `openclaw-usage`；远端如果报 `openclaw-usage: command not found`，请修正远端 PATH/安装器，而不是把命令或路径交给 Web 配置。

状态文件位于 `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/sync-status.json`，包含 `lastAttempt`、`lastSuccess`、`failureSince`、`targetId` 和安全错误分类。导入快照位于 `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/imports/<sourceId>.json`；统计缓存仍是 `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v1.json`。导入来源的 `lastReceivedAt` 由接收文件的最后成功写入时间决定，过期时间为 `lastReceivedAt + intervalMinutes`（使用接收端设置的 interval）；配置了但尚未收到的来源仍会列出为 missing，stale/missing 来源仍计入 All 汇总，Dashboard 会显示警告。

如需在 `claw` 上部署 Web 服务，可显式运行：

```bash
./scripts/install-systemd-user-service.sh --host 0.0.0.0 --port 3001 --config-dir "$OPENCLAW_CONFIG_DIR"
```

`--host 0.0.0.0 --port 3001` 只适用于用户已经接受的家庭 LAN/ZeroTier 边界；该服务没有认证，绝不能直接暴露到公网。默认安装仍绑定 `127.0.0.1`。

### Dashboard 与故障排查

Dashboard 的 Source 筛选会同时作用于汇总卡片、所有图表、Provider/Model 选项、Breakdown 和 Session 表格；`All` 使用合并统计，Session 表格显示 Source 列。Dashboard 从 `GET /api/stats` 响应的 `instance.capabilities` 字段读取同步能力；Settings 从 `GET /api/sync/config` 响应的 `capabilities` 读取目标与操作，两端页面和能力保持一致，不按机器名猜测角色。

常见问题：

- SSH alias 不通：先在终端用 `ssh claw` 验证 `~/.ssh/config`、网络和密钥，再检查发送端 allowlist；Web 不会替你修 SSH 配置。
- 远端找不到 `openclaw-usage`：远端登录环境的 PATH 可能没有 `~/bin`，请在远端安装/重装本机 launcher 并修正 PATH。
- MBP 离线：`claw` 保留上一份 last-good 快照，下一次调度或手动同步再尝试，不会清空 All；来源状态会显示 stale/missing。
- 无效快照：接收端拒绝并保留上一份成功文件，不会用空数据或损坏内容替换它；检查接收端的安全错误分类后修复配置或发送环境。

## 🚀 快速开始

### 环境依赖
- Node.js (建议 v18+)
- 已经运行并产生 Session 的 OpenClaw

### 安装
```bash
git clone <repository-url>
cd OpenClawUsage
npm install
```

### 本机快速启动（推荐日常使用）

对齐 `oc-switch` 的本机体验：安装一次薄包装后，可在任意目录启停**单个**后台 Node 进程（同时提供 API 与已构建的静态前端）。

```bash
# 1. 安装 ~/bin/openclaw-usage（若已存在非本安装器脚本，需加 --force）
./scripts/install-local-launcher.sh

# 2. 显式构建前端（start 不会自动 npm install / build）
openclaw-usage build

# 3. 后台启动（默认 http://127.0.0.1:3001 ，成功后会打开浏览器）
openclaw-usage start

# 常用命令
openclaw-usage status
openclaw-usage stop
openclaw-usage start --no-open   # 适合脚本，不打开浏览器
openclaw-usage help
```

| 项 | 路径 / 说明 |
|----|-------------|
| 默认 URL | `http://127.0.0.1:3001`（仪表盘 `/`，定价页 `/pricing.html`） |
| 端口 | 环境变量 `OPENCLAW_USAGE_PORT`（`1..65535`，默认 `3001`） |
| 运行状态 | `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/serve.json` |
| 生命周期锁 | `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/lifecycle.lock` |
| 后台日志 | `$OPENCLAW_CONFIG_DIR/logs/openclaw-usage/serve.log`（超过 5 MiB 时轮转为 `serve.log.1`） |
| 统计缓存 | `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v1.json`（`start`/`stop` 不会删除） |

设计说明见 [本机启动器规格](docs/superpowers/specs/2026-08-01-local-launcher-like-oc-switch.md)。

#### 排错（本机启动器）

- **`Missing build output`**：先执行 `openclaw-usage build`。
- **端口占用 / `port-conflict`**：默认与开发态 API 同为 `3001`。先 `openclaw-usage stop`，或设置空闲的 `OPENCLAW_USAGE_PORT`；不要与 `npm run dev` 同时跑默认端口。
- **`unhealthy`**：受管进程仍在但 `/api/health` 身份不匹配。查看日志后尝试 `openclaw-usage stop` 再 `start`。
- **`stale` / 归属无法确认**：CLI **不会**向可疑 PID 发信号。确认进程后清理状态或重试 `stop`。
- **仓库移动后**：重新运行 `./scripts/install-local-launcher.sh`（薄包装含绝对路径）。
- **`~/bin` 不在 PATH**：按安装脚本提示把 `$HOME/bin` 写入 shell 配置。

### 开发态 Web 仪表盘
```bash
npm run dev
```
启动后访问：`http://127.0.0.1:3000`（Vite；API 代理到 `127.0.0.1:3001`）。

> ⚠️ 开发态与本机启动器默认共用 API 端口 `3001`，**不能同时运行**。进入 `npm run dev` 前请先 `openclaw-usage stop`。

### 运行 MCP 服务端 (Stdio 模式)
```bash
npm run mcp
```

## 🛠️ MCP 配置示例

在 OpenClaw 或 Claude Desktop 的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "openclaw-usage": {
      "command": "node",
      "args": ["<repository-root>/mcp-server.js"]
    }
  }
}
```

### MCP 工具（管理能力）示例

> ⚠️ `update_pricing_config` 会写入价格配置文件，请确认参数后再执行。

- `get_pricing_config`：读取当前价格配置（只读）。
- `update_pricing_config`：更新价格配置（写入）。
- `refresh_stats_cache`：刷新统计缓存（不改业务数据，仅刷新聚合结果）。**默认执行增量刷新**（只解析新增/变化的 Session 文件），可通过 `full: true` 请求全量重建。

`update_pricing_config` 的 `config` 参数示例（完整配置对象）：

```json
{
  "version": "1.0",
  "enabled": true,
  "updated": "2026-04-20T00:00:00.000Z",
  "pricing": {
    "openai/gpt-4": {
      "input": 30,
      "output": 60,
      "cacheRead": 3,
      "cacheWrite": 6
    }
  }
}
```

## 💰 自定义价格配置

### 配置方式

1. **通过 Web 界面配置**：
   - 启动服务后访问：`http://localhost:3000`
   - 点击右上角的"💰 价格配置"按钮
   - 选择模型并输入价格（单位：$/M）
   - 保存后立即生效

2. **通过 API 配置**：
   ```bash
   # 获取当前价格配置
   curl http://localhost:3001/api/pricing

   # 更新价格配置
   curl -X PUT http://localhost:3001/api/pricing \
     -H "Content-Type: application/json" \
     -d '{
       "version": "1.0",
       "updated": "2026-04-12T00:00:00.000Z",
       "pricing": {
         "openai/gpt-4": {
           "input": 30,
           "output": 60,
           "cacheRead": 3,
           "cacheWrite": 6
         }
       }
     }'

   # 列出 models.json 中有单价 / 缺少价格的模型（与当前自定义价对照，含 findMatchingPricing）
   curl http://localhost:3001/api/openclaw/models

   # 重置为默认配置（使用 OpenClaw 内置价格）
   curl -X POST http://localhost:3001/api/pricing/reset \
     -H "Content-Type: application/json"
   ```

   > 写接口（`PUT /api/pricing`、`POST /api/pricing/reset`）要求 `Content-Type: application/json`；
   > 若请求携带 `Origin`，必须来自同源或本机 loopback，否则返回 403。这是为了阻止其它网站
   > 通过跨站表单静默修改本机价格配置。

### 价格计算规则

- **价格单位**：$/M（每百万 tokens 的美元价，例如 Input $30/M）
- **计算公式**：成本 = (用量 / 1,000,000) × 价格
- **Cache 价格**：留空表示不设单独缓存价；**统一按 Input 原价计算**（读取量与写入量都用 Input 单价）
- **全局开关 `enabled`**（可选，默认视为开启）：为 `false` 时，**全部**模型使用会话 JSONL 中的 OpenClaw 账面成本（`usage.cost`），不进行自定义重算。
- **单条规则 `pricing[k].enabled`**（可选，默认视为开启）：为 `false` 时，**仅该** `provider/model` 使用 OpenClaw 账面成本；其余仍按自定义规则计算（在全局开启的前提下）。
- **可选计价**：仅当全局开启、且某模型存在自定义规则且该规则启用时，对该模型使用自定义单价；否则使用 OpenClaw 账面成本。

### 示例

配置 `openai/gpt-4` 的价格：
- Input: $30/M
- Output: $60/M
- Cache Read: 留空（按 Input $30/M 原价计）
- Cache Write: 留空（按 Input $30/M 原价计）

使用 100,000 input tokens，成本计算为：
- 100,000 / 1,000,000 × 30 = $3

## 📂 项目结构

- `server.js`: Web API 服务端入口（Express）。提供 `/api/stats`、`/api/pricing`、`/api/openclaw/models` 等端点。
- `mcp-server.js`: MCP 服务端入口（@modelcontextprotocol/sdk）；与 Web 共享 `stats-service.js` 及磁盘缓存。
- `stats-service.js`: 统计缓存与价格配置管理的共享服务层；持久化增量缓存、跨进程锁与 `cache` 状态机。
- `stats-cache-store.js`: 磁盘缓存读写、跨进程锁与定价指纹。
- `stats-contribution.js`: 逐文件贡献解析与合并聚合。
- `aggregator.js`: 共享数据处理引擎；解析 `$OPENCLAW_CONFIG_DIR/agents/main/sessions/` 下的 JSONL（跳过 checkpoint 变体），输出 `byDate`、`byDateProvider`、`byDateModel` 等交叉聚合。
- `pricing.js`: 价格配置加载与保存，支持动态路径检测与成本计算；`findMatchingPricing` 负责 exact/wildcard/regex 优先级匹配。
- `openclaw-config.js`: 读取 `agents/main/agent/models.json`（`OPENCLAW_CONFIG_DIR` 或默认 `~/.openclaw`），划分有/无有效单价模型（供参考 API 使用）。
- `pricing.json.example`: 价格配置模板（git 跟踪）。
- `index.html` & `src/`: 前端可视化界面代码；`src/util.js` 内是共享的 HTML 转义与 toast 工具。

## 📜 开源协议

```
            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
                    Version 2, December 2004

 Copyright (C) 2004 Sam Hocevar <sam@hocevar.net>

 Everyone is permitted to copy and distribute verbatim or modified
 copies of this license document, and changing it is allowed as long
 as the name is changed.

            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. You just DO WHAT THE FUCK YOU WANT TO.
```

## 📝 备注
本工具通过扫描 `$OPENCLAW_CONFIG_DIR/agents/main/sessions/` 目录下的文件实现统计，不侵入 OpenClaw 核心代码，安全可靠。
