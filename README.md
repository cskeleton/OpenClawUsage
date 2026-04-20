# OpenClaw Token 用量统计工具

> ⚠️ This document is the Chinese version. For English, see [README_EN.md](README_EN.md).

---

这是一个为 OpenClaw 开发的独立 Token 用量统计与可视化工具。它通过直接解析本地 Session 文件（JSONL 格式），提供实时的费用监控和数据分析。

## 🌟 核心功能

- **可视化仪表盘 (Web UI)**：基于 Vite + Chart.js 构建的暗黑风格界面。
  - **全量统计**：支持活跃（Active）、重置（Reset）和已删除（Deleted）的所有会话统计。
  - **时间筛选**：支持预设时间段（今天、最近 7 天、本月等）及自定义日期范围。
  - **度量指标**：统计 Input/Output Tokens、费用趋势、Provider 分布以及缓存命中（ Cache Read/Write）；首页汇总卡片中 **「总费用」置于最后一格**（前几张为 Tokens / Cache / Sessions 等）。
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
  - 支持 Input、Output、Cache Read、Cache Write 四种价格类型。
  - Cache 价格可选；留空时不设单独缓存价，**按 Input / Output 原价计算**（读用 Input、写用 Output）。
  - 独立的价格配置页面，支持添加、编辑、删除和重置价格配置。

## 💰 价格配置文件路径

价格配置文件（`openclaw-usage-pricing.json`）采用**动态路径检测**，优先跟随 OpenClaw 工作目录而非固定路径，以确保多机器使用时配置可跟随。

### 路径优先级（由高到低）

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 1️⃣ | `OPENCLAW_DIR` 环境变量 | `OPENCLAW_DIR=/自定义/path` |
| 2️⃣ | `openclaw.json` 中的 `agents.defaults.workspace` 配置 | `/Users/gc/gcDora` → 存到 `gcDora` 目录 |
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

假设 `openclaw.json` 配置了 `"workspace": "/Users/gc/gcDora"`，则价格配置实际存储在：

```
/Users/gc/gcDora/openclaw-usage-pricing.json
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

### 运行 Web 仪表盘
```bash
npm run dev
```
启动后访问：`http://localhost:3000`

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
      "args": ["/Users/gc/Dev/MyProject/OpenClawUsage/mcp-server.js"]
    }
  }
}
```

### MCP 工具（管理能力）示例

> ⚠️ `update_pricing_config` 会写入价格配置文件，请确认参数后再执行。

- `get_pricing_config`：读取当前价格配置（只读）。
- `update_pricing_config`：更新价格配置（写入）。
- `refresh_stats_cache`：强制刷新统计缓存（不改业务数据，仅刷新聚合结果）。

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
   curl -X POST http://localhost:3001/api/pricing/reset
   ```

### 价格计算规则

- **价格单位**：$/M（每百万 tokens 的美元价，例如 Input $30/M）
- **计算公式**：成本 = (用量 / 1,000,000) × 价格
- **Cache 价格**：留空表示不设单独缓存价；**按 Input / Output 原价计算**（读取量用 Input 单价，写入量用 Output 单价）
- **全局开关 `enabled`**（可选，默认视为开启）：为 `false` 时，**全部**模型使用会话 JSONL 中的 OpenClaw 账面成本（`usage.cost`），不进行自定义重算。
- **单条规则 `pricing[k].enabled`**（可选，默认视为开启）：为 `false` 时，**仅该** `provider/model` 使用 OpenClaw 账面成本；其余仍按自定义规则计算（在全局开启的前提下）。
- **可选计价**：仅当全局开启、且某模型存在自定义规则且该规则启用时，对该模型使用自定义单价；否则使用 OpenClaw 账面成本。

### 示例

配置 `openai/gpt-4` 的价格：
- Input: $30/M
- Output: $60/M
- Cache Read: 留空（按 Input $30/M 原价计）
- Cache Write: 留空（按 Output $60/M 原价计）

使用 100,000 input tokens，成本计算为：
- 100,000 / 1,000,000 × 30 = $3

## 📂 项目结构

- `server.js`: Web API 服务端入口（Express）。提供 `/api/stats`、`/api/pricing`、`/api/openclaw/models` 等端点；缓存以 `pricing.updated` 为失效键。
- `mcp-server.js`: MCP 服务端入口（@modelcontextprotocol/sdk）；复用同一缓存策略。
- `stats-service.js`: 统计缓存与价格配置管理的共享服务层，被 Web API 与 MCP 共用。
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
