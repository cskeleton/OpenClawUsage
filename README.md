# OpenClaw Token 用量统计工具

这是一个为 OpenClaw 开发的独立 Token 用量统计与可视化工具。它通过直接解析本地 Session 文件（JSONL 格式），提供实时的费用监控和数据分析。

## 🌟 核心功能

- **可视化仪表盘 (Web UI)**：基于 Vite + Chart.js 构建的暗黑风格界面。
  - **全量统计**：支持活跃（Active）、重置（Reset）和已删除（Deleted）的所有会话统计。
  - **时间筛选**：支持预设时间段（今天、最近 7 天、本月等）及自定义日期范围。
  - **度量指标**：统计 Input/Output Tokens、费用趋势、Provider 分布以及缓存命中（Cache Read/Write）。
  - **交互体验**：Model 对比支持对数坐标（Log Scale），解决小数据量不可见问题；Session 明细支持分页、搜索与排序。
  
- **MCP 服务端 (Model Context Protocol)**：
  - 使 OpenClaw Agent 能够直接调用工具查询自己的 Token 消耗。
  - 提供 `get_total_usage`, `get_usage_by_model`, `get_session_stats` 等 5 个核心工具。

## 📊 数据来源与原理

本工具通过监听和解析 OpenClaw 本地持久化目录实现统计：

- **目标路径**：`~/.openclaw/agents/main/sessions/`
- **覆盖文件**：
  - `*.jsonl`: 当前活跃的 Session 记录。
  - `*.jsonl.reset.*`: 执行 `/reset` 命令后归档的旧 Session。
  - `*.jsonl.deleted.*`: 已删除 Session 的归档。
  - `sessions.json`: Session 索引及其快照统计信息。

- **数据采集点**：
  本工具会递归读取 JSONL 文件中基于 LLM API 返回的 `usage` 字段，示例如下：
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

## 📂 项目结构

- `server.js`: Web API 服务端入口（Express）。
- `mcp-server.js`: MCP 服务端入口（@modelcontextprotocol/sdk）。
- `aggregator.js`: 共享的数据处理引擎，负责解析 `~/.openclaw` 下的 JSONL 文件。
- `index.html` & `src/`: 前端可视化界面代码。

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
本工具通过扫描 `~/.openclaw/agents/main/sessions/` 目录下的文件实现统计，不侵入 OpenClaw 核心代码，安全可靠。
