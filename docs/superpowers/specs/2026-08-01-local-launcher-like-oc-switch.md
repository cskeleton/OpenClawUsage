# 本机启动器（对齐 oc-switch）设计

| 字段 | 内容 |
|------|------|
| 状态 | 已实施 |
| 日期 | 2026-08-01 |
| 范围 | 本机日常启动 Web 仪表盘；不替代 claw 上的 systemd |
| 参考 | `oc-switch` 的 `~/bin` 薄包装与 `start` / `stop` 生命周期 |

## Review 修复轮次 Sync Audit（2026-08-01，第 3 轮）

用户验收发现 P2：`writeRequestGuard` 允许 `application/*+json`，但 `express.json()` 默认只解析 `application/json`，导致 vendor JSON（如 `application/vnd.test+json`）guard 放行后 `req.body` 为空，业务层误报 400「价格配置必须包含 version 字段」。

| 编号 | 问题 | 修复 | 规格影响 |
|------|------|------|----------|
| P2-4 | Guard 与 body parser 对 `+json` 不一致 | 采用方案 A：`express.json({ type: ['application/json', 'application/*+json'] })`，与 guard 正则对齐；集成测试覆盖合法 vendor JSON → 200、非法配置仍 400 | 正文 §3.5.1 第 2 条明确「解析范围必须与内容类型校验一致」 |

**本轮取舍：** 保留 vendor JSON 支持（与既有 guard / 规格一致），不收紧为仅 `application/json`。

**本轮新增测试：** `tests/integration/server/api.test.js` — `application/vnd.test+json` 合法配置 200；同类型非法单价仍 400。

---

## Review 修复轮次 Sync Audit（2026-08-01，第 2 轮）

用户审阅认定「尚不能认定完全按规格落地」，本轮修复以下 P1/P2 并把新增约束回写到正文（§3.5、§4.1、§5.1、§5.3、§5.4、§7.1）：

| 编号 | 问题 | 修复 | 规格影响 |
|------|------|------|----------|
| P1 | `cmdStart` 在子进程 `detached` 之后才写 `serve.json`；原子写入失败时异常直接逃逸，子进程不回收 → health 仍通但 `stop` 无法管理 | spawn 之后整体进入事务区：`try/catch` 包住启动时间读取、状态写入与 readiness 轮询；所有失败分支统一走新增的 `rollbackStartedChild()`（SIGTERM → 超时 SIGKILL → 复核存活），**仅在确认子进程退出后**才清理状态；无法确认退出时保留 `serve.json` 供 `stop` 重试 | 正文 §5.1 第 10 条改写为事务语义 |
| P2-1 | `readServeState()` 把「文件缺失」与「JSON 损坏 / 字段非法」都返回 `null`，导致 `status` 误报 `stopped`、`stop` 误报 `Not running` 并保留坏文件 | 新增 `readServeStateEntry()` 返回 `missing / valid / invalid` 三态；`evaluateManagedState` 对 `invalid` 报 `stale`，`cmdStop` 对 `invalid` 清理并退 0，`cmdStart` 清理前打印告警；`readServeState()` 保留为兼容包装 | 正文 §5.3 / §5.4 明确三态 |
| P2-2 | 所有写接口（含 `POST /api/pricing/reset`）不校验 `Origin`，任意站点可用跨站表单静默改本机定价 | 新增 `writeRequestGuard`（挂在 `/api` 前）：写方法携带 `Origin` 时必须同源或本机 loopback，否则 403；写请求必须为 `application/json`，否则 415（HTML 表单无法发送该类型）；前端 `resetPricingConfig()` 补上 JSON 头 | 正文 §3.5 新增写接口防护小节 |
| P2-3 | `install-local-launcher.sh` 在 `$TMPDIR` 建临时文件再 `mv` 到 `~/bin`，跨文件系统时退化为复制+删除，失去原子性 | `mktemp` 模板改为 `$TARGET_DIR/.openclaw-usage.XXXXXX`，同文件系统内 rename | 正文 §4.1 第 4 条明确「同目录临时文件」 |

**本轮取舍与偏差：**

1. **loopback Origin 放行**：开发态 Vite proxy 使用 `changeOrigin: true`，浏览器 Origin 为 `127.0.0.1:3000` 而代理改写后的 Host 为 `127.0.0.1:3001`，严格同源比较会打断开发态保存定价。因此放行 `127.0.0.1` / `localhost` / `::1` 的任意端口 Origin。跨站攻击页面无法伪造 loopback Origin，防跨站表单的安全意图不受削弱。
2. **无 `Origin` 请求放行**：现代浏览器对跨站 `POST` / `PUT` 必带 `Origin`，缺失即视为本机命令行工具（curl / 脚本），仅受 JSON 内容类型约束；README 中英已同步该约定。
3. **`GET /api/refresh` 未纳入写防护**：它只重建统计快照、不改用户数据，且当前是 GET 语义。如果后续要求严格 CSRF 边界，应先把它改为 `POST` 再纳入 guard——本轮未改，属已知残留项。
4. **测试钩子**：`cmdStart` 新增 `readyWaitMs` 与 `onSpawn` 两个可选参数，仅用于测试注入超时与捕获子进程 PID，不改变默认 CLI 行为（与既有 `paths` 覆盖同一取舍）。
5. **`clearServeState` 容忍 `ENOTDIR`**：状态文件父级不是目录时等价于「文件不存在」，避免回滚清理阶段二次抛错。

**本轮新增测试（`npm test` 177 passed / 1 skipped）：**

- `tests/integration/launcher/smoke.test.js`：注入真实的 `serve.json` 写入失败（父级路径做成普通文件 → `ENOTDIR`），断言子进程被杀、端口释放、无残留状态与锁；readiness 永不成功时复用同一 rollback 路径。
- `tests/unit/launcher/lifecycle.test.js`：`readServeStateEntry` 三态与各字段失效原因；损坏状态文件在 `evaluateManagedState` 报 `stale`；`cmdStop` 清理坏文件退 0，缺文件退 0。
- `tests/integration/server/api.test.js`：跨站 Origin / `null` Origin / 表单内容类型 / 缺内容类型均被拒；同源与 loopback（dev proxy）JSON 请求正常通过；读接口不受影响。
- `tests/integration/launcher/install-script.test.js`：隔离 `HOME` 运行安装器，校验包装脚本内容与 `0755`，目标目录内不残留临时文件，`--force` 规则。

---

## Post-Implementation Sync Audit（2026-08-01）

对照本规格逐项核对后的结论：**已按规格落地**；下列为实现取舍与非偏离性补充（规格据此保持为单一事实源）。

| 规格章节 | 实现情况 | 偏差 / 取舍 |
|----------|----------|-------------|
| §3.1 Vite 双页面 | `vite.config.js` 配置 `index.html` + `pricing.html` → `dist/` | 为满足「生产页不得依赖 `/src/*.js`」，将 `theme.js` 的 `<script>` 改为 `type="module"`，使 Vite 打进 `dist/assets`（原为非 module 同步脚本；FOUC 仍由 head 内联脚本防护） |
| §3.2 Express 仅托管 dist | `createApp({ staticDir })`；默认 `server.js` 旁 `dist/`；未知 API JSON 404；未知页 404 | 无偏离 |
| §3.3 `/api/health` | 返回 `ok/service/pid/launchId`，不调用 `getStats` | 无偏离 |
| §3.4 监听与退出 | 仅 `127.0.0.1`；`OPENCLAW_USAGE_PORT` 校验；SIGTERM graceful close | 优雅退出额外设 5s 硬超时，避免挂死 |
| §3.5 安全 | 移除 unrestricted `cors()`；依赖 `cors` 已从 `package.json` 删除 | 无偏离 |
| §4 安装器 | `scripts/install-local-launcher.sh` 原子写入 `~/bin/openclaw-usage`，`--force` 规则 | 无偏离 |
| §4.2 显式构建 | `start` 不自动 build；缺 dist 非零退出 | 无偏离 |
| §5 CLI | `scripts/openclaw-usage-cli.js`：start/stop/status/build/help | 测试可注入 `paths` 覆盖（不改变默认 CLI 行为） |
| §5.1–5.3 锁与归属 | `lifecycle.lock` / `serve.json` / owned health / fail-closed | **锁写入**使用 `writeFileSync(..., { flag: 'wx' })` 一次写满内容，避免 `openSync('wx')` 空文件窗口被并发进程误判为损坏锁并删除（并发 start 实测修复）；损坏锁仅在 mtime > 30s 时回收 |
| §5.4 status | 五种状态与退出码 | 无偏离 |
| §6 开发态 | Vite proxy 改为 `127.0.0.1:3001`；README 标明不可与启动器同跑默认端口 | 无偏离 |
| §7 测试 | static-hosting、lifecycle helpers、smoke（含缓存复用与并发 start） | 本机真实数据验证已跑：install + start/stop + revision/generatedAt 复用 |
| §8 文件规划 | 与表一致；另改 `index.html` / `pricing.html` / `src/theme.js` 注释、`package.json`（去 cors） | 见上 |

**验证：** `npm test` 160 passed（1 skipped）；`npm run build` 通过；`./scripts/install-local-launcher.sh --force` + `openclaw-usage start/stop` 本机通过。

---
## 1. 背景与目标

本机当前常用 `npm run dev` 启动 Vite 与 API 两个进程，适合开发，不适合“需要时打开仪表盘，用完再关闭”的日常使用。

本方案对齐 `oc-switch` 的本机启动体验，但不追求真正的单文件二进制：

1. 安装一次后，可在任意目录执行 `openclaw-usage start` / `stop` / `status` / `build`。
2. 由**单个 Node 进程**同时提供 API 与已构建的静态前端，默认地址为 `http://127.0.0.1:3001`。
3. `start` 拉起脱离当前终端的后台进程；PID、启动身份与日志持久化，能够安全、幂等地启停。
4. 后台服务与 MCP 继续共用现有持久化增量统计缓存，重启服务不会强制全量解析 Session。
5. `npm run dev` 继续作为开发入口；它与本机启动器互不替代，但默认使用同一个 API 端口，因此不能同时运行。

### 1.1 明确不做

- 不优先使用 `pkg`、`bun compile` 或 Node SEA 制作独立可执行文件。
- 不默认安装 LaunchAgent；日常使用手动 `start` / `stop`。
- 不把 MCP stdio 服务并入 Web 后台进程；MCP 仍由 OpenClaw 按需拉起 `mcp-server.js`。
- 不改变 claw 上现有 systemd unit 与 `run.sh`。
- 不做跨机器分发安装包。
- 首版不提供远程监听或局域网访问。

## 2. 运行与数据边界

### 2.1 路径

所有新增运行状态都跟随 `OPENCLAW_CONFIG_DIR`，但不与可清理的统计缓存混放。

| 数据 | 路径 | 说明 |
|------|------|------|
| 统计缓存 | `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v1.json` | 已实现；Web 与 MCP 共享 |
| 统计锁 | `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v1.lock` | 已实现；只保护统计快照刷新 |
| 定价配置 | 跟随 OpenClaw workspace / `OPENCLAW_DIR` | 已实现 |
| 启动器状态 | `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/serve.json` | 新增；记录受管进程身份 |
| 生命周期锁 | `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/lifecycle.lock` | 新增；串行化并发 `start` / `stop` |
| 后台日志 | `$OPENCLAW_CONFIG_DIR/logs/openclaw-usage/serve.log` | 新增；stdout / stderr 合并写入 |

运行状态目录权限为 `0700`，状态文件与锁文件权限为 `0600`。状态文件使用临时文件加原子 rename 发布。

`start` 与 `stop` 不删除 `stats-v1.json`；清理统计缓存也不得删除启动器状态。日志超过 5 MiB 时，在下次 `start` 前轮转为 `serve.log.1`，只保留一份旧日志。

### 2.2 `serve.json` 结构

```json
{
  "version": 1,
  "pid": 12345,
  "repoRoot": "/absolute/path/to/OpenClawUsage",
  "serverEntry": "/absolute/path/to/OpenClawUsage/server.js",
  "host": "127.0.0.1",
  "port": 3001,
  "launchId": "random-per-start-id",
  "processStartedAt": "value-read-from-process-table",
  "startedAt": "2026-08-01T00:00:00.000Z"
}
```

`launchId` 不是认证凭据，只用于区分本次启动的子进程与同端口上的其他 HTTP 服务。`processStartedAt` 用于防止 PID 被操作系统复用后误杀无关进程。

## 3. 生产态 Web 服务

### 3.1 Vite 双页面构建

当前项目同时包含 `index.html` 与 `pricing.html`，因此生产构建必须配置为多页面构建：

- `index.html` → 仪表盘。
- `pricing.html` → 定价配置页。
- 两个页面及其 JS/CSS 依赖都输出到 `dist/`。

`npm run build` 成功后，至少必须存在：

- `dist/index.html`
- `dist/pricing.html`
- 两个页面引用的构建后 assets

禁止依赖源码目录下的 `/src/*.js` 或 `/src/*.css` 提供生产页面。

### 3.2 Express 路由顺序

`createApp()` 中间件与路由顺序固定为：

1. JSON body parser。
2. `/api/health` 与现有 `/api/*` 路由。
3. 仅托管 `dist/` 的 `express.static`。
4. 404 处理。

为便于静态托管测试，工厂签名采用可选参数 `createApp({ staticDir } = {})`；默认值从 `server.js` 所在目录解析到 `dist/`，不得依赖 `process.cwd()`。现有 `createApp()` 无参数调用保持兼容。

生产服务**不得**使用 `express.static(__dirname)`，不得通过 HTTP 暴露 `package.json`、README、源码、测试 fixture、配置文件或其他仓库内容。

当前前端没有客户端路由器，因此首版不需要 SPA fallback：

- `GET /` 返回 `dist/index.html`。
- `GET /pricing.html` 返回 `dist/pricing.html`。
- 未知页面返回 404。
- 未知 `/api/*` 返回 JSON 404，不回退到 HTML。
- 非 `GET` / `HEAD` 的未知请求不得返回 HTML 200。

### 3.3 健康检查

新增轻量、无统计扫描副作用的 `GET /api/health`：

```json
{
  "ok": true,
  "service": "openclaw-usage",
  "pid": 12345,
  "launchId": "random-per-start-id"
}
```

该接口不得调用 `getStats()`，避免 `start` 的 readiness 探测触发 Session 扫描。CLI 只有在响应中的 `service`、`pid` 与 `launchId` 全部匹配本次子进程时，才能报告启动成功。

### 3.4 监听与退出

- 默认且首版唯一允许的监听地址：`127.0.0.1`。
- 默认端口：`3001`。
- 可通过 `OPENCLAW_USAGE_PORT` 修改端口；必须验证为 `1..65535` 的整数。
- 首版不提供 `OPENCLAW_USAGE_HOST`；远程监听需要另行设计认证与访问控制。
- `node server.js` 直接运行时才调用 `listen`；导入 `createApp()` 的测试路径不监听端口。
- 监听失败必须写日志并以非零状态退出。
- 收到 `SIGTERM` 时停止接受新连接，短暂等待现有请求结束后退出。

### 3.5 本机安全边界

服务包含读取统计和修改定价配置的接口，但当前没有登录认证。因此：

- 服务必须只绑定 loopback。
- 生产态移除 unrestricted `cors()`。
- 开发态通过 Vite `/api` proxy 访问同源 API，不需要浏览器跨域权限。
- 如果未来需要绑定 `0.0.0.0`，必须先单独设计认证、Origin 策略和敏感数据边界，不能只增加一个 HOST 环境变量。

#### 3.5.1 写接口防护（防跨站表单）

仅绑定 loopback 不足以防御 CSRF：用户浏览器访问任意站点时，该站点可以向 `127.0.0.1:3001` 提交跨站表单，静默改写本机定价配置。因此所有 `/api` 下的写方法（`POST` / `PUT` / `PATCH` / `DELETE`）在进入业务处理前必须通过统一防护：

1. **Origin 校验**：请求携带 `Origin` 时，必须满足其一，否则返回 `403`：
   - `Origin` 的 host 与请求 `Host` 完全一致（生产态同源）；
   - `Origin` 的 hostname 为 `127.0.0.1` / `localhost` / `::1`（开发态 Vite `changeOrigin` 代理会造成 Origin 与 Host 端口不同）。
   - `null` Origin（sandbox iframe、`file://`）一律拒绝。
2. **内容类型校验**：写请求必须声明 `Content-Type: application/json`（或 `application/*+json`），否则返回 `415`。HTML 表单只能发送 `application/x-www-form-urlencoded` / `multipart/form-data` / `text/plain`，因此无法构造合法写请求。**正文解析必须与此对齐**：`express.json` 使用 `type: ['application/json', 'application/*+json']`（或等价 type 函数），避免 guard 放行 vendor JSON 后 `req.body` 为空导致业务层误报 400。
3. **无 `Origin` 的请求**：视为本机命令行工具（curl / 脚本），仅受内容类型约束。现代浏览器对跨站写请求必带 `Origin`，因此这一放行不构成跨站入口。
4. 读接口（`GET` / `HEAD`）不受该防护影响。`GET /api/refresh` 只重建统计快照、不改用户数据，暂不纳入；若将其改为写语义，必须同时改为 `POST` 并纳入防护。

前端所有写请求都必须显式带 `Content-Type: application/json`，包括无 body 的 `POST /api/pricing/reset`。

## 4. 安装器与薄包装

### 4.1 安装脚本

新增 `scripts/install-local-launcher.sh`：

1. 解析当前仓库的绝对路径。
2. 检查 `node`、`npm`、`package.json` 与 `scripts/openclaw-usage-cli.js`。
3. 创建 `~/bin`（如不存在）。
4. 通过临时文件加 rename，原子写入 `~/bin/openclaw-usage`。临时文件必须建在**目标目录内**（`$TARGET_DIR/.openclaw-usage.XXXXXX`）：若建在 `$TMPDIR` 而两者分处不同文件系统，`mv` 会退化为「复制 + 删除」，失去原子性并可能留下半截可执行文件。
5. 薄包装使用绝对路径执行仓库内 CLI，不依赖调用时的当前目录。
6. 若目标文件已存在且不是本安装器生成的包装脚本，默认拒绝覆盖并给出说明；显式 `--force` 才允许替换。
7. 安装完成后检查 `~/bin` 是否在 `PATH`，不在时打印配置提示。

薄包装只负责定位仓库和转交参数，不复制源码、`node_modules` 或 `dist`。仓库移动或删除后，需要重新运行安装脚本。

### 4.2 构建策略

首版采用**显式构建**，不在 `start` 内自动运行 `npm install` 或 `npm run build`：

- `openclaw-usage build`：在仓库根目录执行 `npm run build`。
- `openclaw-usage start`：若 `dist/index.html` 或 `dist/pricing.html` 缺失，则非零退出，并提示执行 `openclaw-usage build`。
- 前端源码更新后由用户显式重新 build；后台服务不会静默使用耗时或失败的自动构建。

## 5. CLI 设计

新增无第三方 CLI 框架的 `scripts/openclaw-usage-cli.js`，支持：

| 命令 | 行为 |
|------|------|
| `openclaw-usage start` | 校验构建和生命周期状态，后台启动服务，确认 owned health 后打开浏览器 |
| `openclaw-usage start --no-open` | 同上，但不打开浏览器，适合脚本调用 |
| `openclaw-usage stop` | 只停止经状态文件和进程身份共同确认的后台服务 |
| `openclaw-usage status` | 只读报告运行状态、PID、URL、端口冲突、日志和缓存信息 |
| `openclaw-usage build` | 在仓库根目录执行 `npm run build` |
| `openclaw-usage help` | 输出命令、环境变量和主要文件路径 |

未知命令或非法参数必须非零退出并打印简短帮助。

### 5.1 `start` 生命周期

`start` 必须持有 `lifecycle.lock` 才能修改状态或拉起进程，以避免两个终端并发启动。锁文件记录调用进程 PID 与时间；只有锁持有进程已退出时才能回收陈旧锁。获取锁最多等待 15 秒，超时后不得继续启动。

执行顺序：

1. 解析并验证 `OPENCLAW_USAGE_PORT`。
2. 检查 `dist/index.html` 与 `dist/pricing.html`。
3. 读取 `serve.json`（必须区分 `missing` / `invalid` / `valid` 三态，见 §5.4）：
   - 文件存在但 JSON 损坏或字段非法：按陈旧状态处理，打印告警并删除后继续启动。
   - 状态合法、进程身份匹配且 `/api/health` 匹配：视为已运行，打印 URL；除非传入 `--no-open`，仍打开浏览器；退出码 0。
   - 进程身份匹配但 health 未就绪或身份响应不匹配：保留状态，拒绝拉起第二个进程，报告 `unhealthy` 并非零退出。
   - PID 已退出：清理陈旧状态。
   - PID 存活且能够确认命令行、进程启动时间或仓库路径不匹配：不得发送信号；删除陈旧状态并明确警告。
   - PID 存活但暂时无法读取足够的归属证据：保留状态并非零退出，避免把真实受管进程变成无法停止的孤儿进程。
4. 使用 TCP 探测目标端口；若已监听但不属于上述受管服务，拒绝启动并提示端口占用。
5. 生成本次 `launchId`，必要时轮转日志。
6. 使用 `spawn(process.execPath, [serverEntry], ...)` 拉起子进程：
   - `cwd` 固定为仓库根目录。
   - `detached: true`，stdin 为 ignore，stdout/stderr 写入日志。
   - 环境中传入 `NODE_ENV=production`、`OPENCLAW_USAGE_PORT` 与 `OPENCLAW_USAGE_LAUNCH_ID`。
   - 不使用 shell 拼接命令，避免路径空格和转义问题。
7. 将子进程身份原子写入 `serve.json`。
8. 最多等待 10 秒；轮询时必须同时确认子进程仍存活，以及 `/api/health` 的 `pid`、`service`、`launchId` 与本次启动一致。
9. 成功后打印 URL、PID、日志路径；默认在 macOS 使用 `open <url>` 打开浏览器。
10. 子进程提前退出或 readiness 超时：回收属于本次启动的子进程、清理状态、打印日志路径并非零退出。

端口预检只能提供友好错误，不能代替启动后的 owned health 校验；预检与真正 bind 之间仍可能发生竞争。

#### 5.1.1 spawn 之后必须是事务

子进程一旦 `detached` 拉起，就已经脱离当前终端；如果此后任何一步（读取进程启动时间、写 `serve.json`、readiness 轮询）抛出异常而直接结束 `start`，就会留下「`/api/health` 仍然可用但 `stop` 完全管不到」的孤儿进程，并占用端口。

因此 spawn 之后的全部逻辑必须包在一个事务区内：

1. 所有失败分支（含未预期异常，典型如原子写入的 `rename` 失败）统一走同一个回滚 helper，不允许异常逃逸出 `start`。
2. 回滚 helper 先 `SIGTERM`，超时后 `SIGKILL`，并**再次确认进程确实退出**。
3. **只有确认子进程退出后**才允许删除 `serve.json`；若无法确认退出，必须保留状态文件并打印诊断，让后续 `openclaw-usage stop` 能继续接管，绝不静默清状态。
4. readiness 失败分支与异常分支复用同一 helper，避免出现两套不一致的回收逻辑。

### 5.2 进程归属校验

对存活 PID 发送信号前，必须同时满足：

1. PID 与 `serve.json` 一致。
2. 进程命令行包含状态文件记录的绝对 `serverEntry`。
3. 进程启动时间与 `processStartedAt` 一致，排除 PID 复用。
4. 仓库根目录与当前安装器指向的仓库一致。

健康接口中的 `launchId` 是启动与状态判断的额外证据，但不得单独作为发送信号的依据。任一归属检查无法完成或不匹配时，必须 fail closed，不向该 PID 发送信号。能够确认身份不匹配时可清理陈旧状态；只是暂时无法读取证据时必须保留状态，供稍后重试和排错。

### 5.3 `stop` 生命周期

`stop` 与 `start` 共用 `lifecycle.lock`：

1. 无 `serve.json`（`missing`）：打印“未在运行”，退出码 0。
2. 状态无效（`invalid`：JSON 损坏或字段非法）或 PID 已退出：清理陈旧状态，退出码 0。**不得**把损坏文件当成「不存在」而原样留在磁盘上。
3. PID 存活且能够确认归属不匹配：不发送信号，删除陈旧状态，打印警告，退出码 1。
4. PID 存活但暂时无法完成归属校验：不发送信号、不删除状态，打印警告，退出码 1。
5. 归属确认后发送 `SIGTERM`，最多等待 3 秒。
6. 仍未退出时发送 `SIGKILL`，再次确认进程结束。
7. 仅在进程确认结束后删除 `serve.json`；失败时保留诊断信息并非零退出。
8. `stop` 只管理由 `start` 记录的后台进程，不扫描或批量终止其他 Node 进程。

### 5.4 `status` 语义

`status` 不修改状态，报告以下五种情况：

| 状态 | 含义 |
|------|------|
| `running` | PID 归属与 health 均匹配 |
| `unhealthy` | PID 属于本服务，但 health 未就绪或返回异常 |
| `stale` | 状态文件无效、PID 已退出、PID 已被复用或归属暂时无法确认 |
| `stopped` | 无状态文件且目标端口空闲 |
| `port-conflict` | 无受管服务，但目标端口被其他进程占用 |

状态文件读取必须返回三态，不能把「损坏」压缩成「不存在」：

| 读取结果 | 含义 | status 判定 |
|----------|------|-------------|
| `missing` | 文件不存在 | 结合端口探测 → `stopped` 或 `port-conflict` |
| `invalid` | 文件存在但 JSON 损坏 / 字段非法 | `stale`（并在 `start` / `stop` 中清理） |
| `valid` | 结构合法 | 继续做归属与 health 判定 |

输出至少包含：状态、PID（如有）、URL、日志路径、`stats-v1.json` 是否存在及其更新时间。`running` 返回 0，其余状态返回 1，便于脚本判断。

## 6. 开发态关系

开发态保持现状：

- Vite：`http://127.0.0.1:3000`
- API：`http://127.0.0.1:3001`
- Vite `/api` proxy → `:3001`

本机启动器默认也使用 API 端口 `3001`，因此进入开发态前应先执行 `openclaw-usage stop`。若启动器使用自定义 `OPENCLAW_USAGE_PORT`，不会自动修改 Vite proxy；开发态端口定制不属于首版范围。

## 7. 测试与验收

### 7.1 自动化测试

#### 构建与静态托管

- `npm run build` 同时生成 `dist/index.html` 与 `dist/pricing.html`。
- `GET /` 与 `GET /pricing.html` 返回对应构建页面。
- 页面引用的构建后 assets 可访问。
- `/package.json`、`/server.js`、`/src/main.js` 与测试 fixture 不可访问。
- 未知页面、未知 `/api/*` 和 `POST /unknown` 正确返回 404。
- `createApp()` 现有 API 单测继续可直接导入，且不会监听端口。

#### 写接口防护

- 跨站 `Origin` 与 `null` Origin 的写请求返回 403。
- 表单类内容类型（urlencoded / multipart / text-plain）与缺失 `Content-Type` 的写请求返回 415。
- 同源 Origin 与 loopback（dev proxy）Origin 的 JSON 写请求正常通过。
- 读接口不受 Origin 影响。

#### 安装脚本

- 隔离 `HOME` 运行安装器后生成带 marker、`0755` 的包装脚本，且目标目录内不残留临时文件。
- 目标文件非本安装器生成时默认拒绝覆盖（不留临时文件），`--force` 才替换。

#### 生命周期 helper

- 无 dist 时 `start` 非零退出。
- 无状态、陈旧 PID、无效状态文件均安全处理；损坏状态文件报 `stale` 并在 `stop` 时被清理。
- 记录 `serve.json` 失败（原子写入抛错）时，本次 spawn 的子进程被确认杀掉、端口释放、无残留状态与孤儿进程。
- readiness 永不成功时走同一 rollback 路径，同样不留孤儿。
- 存活但不归属本服务的 PID 永远不会收到信号。
- PID 相同但进程启动时间不同，视为 PID 复用，不发送信号。
- 端口已被其他服务占用时拒绝启动。
- 仅有任意 HTTP 响应但 health 身份不匹配时，不得报告启动成功。
- 两次并发 `start` 最终只能留下一个受管进程。
- `SIGTERM` 超时后才允许升级为 `SIGKILL`。
- 日志与状态文件权限符合约定。

#### 端到端 smoke

1. 在临时 `OPENCLAW_CONFIG_DIR` 和现有脱敏 fixture 上执行 build/start。
2. 确认 CLI 退出后后台进程仍存活。
3. 确认仪表盘、定价页、`/api/health` 与 `/api/stats` 可访问。
4. 执行 stop，确认 PID 退出且端口释放。
5. 再次 start，在 Session 与定价未变化时请求 `/api/stats`；`cache.revision` 与 `generatedAt` 不应因重启而变化，以证明命中已有磁盘快照而非强制重建。

所有进程型测试必须使用临时端口、独立配置目录、明确超时和 finally 清理，保证 GitHub Actions 稳定复现。

### 7.2 用户验收标准

1. `./scripts/install-local-launcher.sh` 后，可在任意目录执行 `openclaw-usage build` 与 `openclaw-usage start`。
2. `start` 返回成功时，`http://127.0.0.1:3001` 的仪表盘、定价页和 API 均真实可用。
3. 关闭启动命令所在终端不会结束后台服务。
4. 重复 `start` 幂等，不产生第二个后台进程。
5. `stop` 只停止本机制拉起且归属校验通过的进程，停止后端口释放。
6. 服务重启能够复用已有 `stats-v1.json`，不强制全量解析。
7. `npm run dev` 仍可用于开发；README 明确它与默认端口的后台服务不能同时运行。
8. README.md 与 README_EN.md 同步增加“本机快速启动”、状态路径、日志路径和排错说明。
9. 现有 Vitest 全部通过，新增生命周期与静态托管测试通过。

## 8. 实现文件规划

| 文件 | 变更 |
|------|------|
| `vite.config.js` | 配置 `index.html` / `pricing.html` 双页面构建 |
| `server.js` | health、仅托管 dist、loopback/port、graceful shutdown、移除 unrestricted CORS、写接口 Origin/内容类型防护 |
| `src/pricing.js` | 前端写请求显式声明 `Content-Type: application/json` |
| `scripts/openclaw-usage-cli.js` | 命令解析、生命周期锁、进程身份、start/stop/status/build |
| `scripts/install-local-launcher.sh` | 原子安装 `~/bin/openclaw-usage` 薄包装 |
| `tests/` | 静态托管、生命周期 helper、真实子进程 smoke 与缓存复用测试、写接口防护、安装脚本 |
| `README.md` / `README_EN.md` | 中英同步的使用与排错说明 |

不新增 Commander 等完整 CLI 框架；优先使用 Node 标准库，并将进程探测、状态存储、端口检查拆成可单测的小函数。

## 9. 实施顺序

1. 调整 Vite 双页面构建，并实现仅托管 `dist` 的生产静态服务。
2. 增加 `/api/health`、loopback/port 配置、监听错误与优雅退出。
3. 实现 CLI 生命周期 helper、锁、状态文件和 `start` / `stop` / `status` / `build`。
4. 实现安装脚本。
5. 补齐自动化测试并运行完整 Vitest 与构建检查。
6. 同步更新 README.md / README_EN.md。
7. 在本机使用真实 OpenClaw 数据进行启动、停止、端口释放与缓存复用验证；输出中不得泄露 Session 内容或完整本机配置。
8. 完成 Post-Implementation Sync Audit：逐项核对实际实现与本规格，将最终偏差和明确取舍回写到本文档，使规格继续作为单一事实源。
