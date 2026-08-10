# 设计规格：仪表盘图表清晰度与模型归并

**日期**：2026-08-11
**状态**：已实现（同步审计后回写）

## 背景与目标

当前仪表盘的 Model 用量图只并列展示 Input / Output，无法直接看出缓存流量；Model 还按精确的 `provider/model` 键拆开，同一模型的不同 Provider 或日期 checkpoint 会形成多根柱。部分区块标题同时使用了装饰性 Emoji，降低了信息界面的克制感。

本次优化目标：

1. 清理不承担识别作用的装饰性 Emoji。
2. 在 Model 用量图的一根完整 Input 柱中区分普通 Input、Cache Write、Cache Read，使柱高代表总 Input。
3. 在 Provider 费用圆环 Tooltip 中同时显示费用与占比。
4. 默认按去除日期 checkpoint 后的模型名跨 Provider 归并 Model 图数据，并允许临时关闭归并。

## 非目标

- 不修改 HTTP API、MCP 工具、统计聚合、持久化缓存或磁盘快照格式。
- 不改变 Provider / Model 筛选器和消耗明细表的精确 `provider/model` 数据。
- 不把模型归并选择写入 LocalStorage 或服务端配置。
- 不移除品牌、状态、摘要卡片或价格配置入口中承担识别作用的图标。
- 不引入新的图表库或前端依赖。

## 1. Emoji 清理

### 移除范围

移除仪表盘图表标题、消耗明细标题、Session 明细标题以及同类内容标题中的装饰性 Emoji。HTML fallback 文案和中英文 i18n 词典必须同步，避免语言切换后重新出现。

明确需要移除的示例：

- `🤖 Model 用量对比` → `Model 用量对比`
- `💵 Provider / Model 消耗明细` → `Provider / Model 消耗明细`
- `📋 Session 明细` → `Session 明细`

### 保留范围

- 左上角品牌 Logo `🦞`。
- Session 状态图标（活跃、重置、删除）。
- 六张摘要卡片各自用于快速识别指标的单个图标。
- `💰 价格配置` 入口。

本次只做上述有明确边界的清理，不把 Emoji 改成新的图标组件。

## 2. Model 用量图

### 2.1 交互

在 Model 图标题区、现有“对数坐标”控制旁新增“合并日期 checkpoint / Merge date checkpoints”复选开关：

- 首次加载默认开启。
- 当前页面生命周期内保留用户选择；时间、Provider、Model、语言和主题变化后的重绘不得重置选择。
- 页面重新加载后恢复默认开启。
- 关闭后使用当前精确 `byModel` 条目，不做 checkpoint 或跨 Provider 归并。
- 此开关只影响 Model 用量图；筛选器和消耗明细保持精确数据。

### 2.2 日期 checkpoint 识别

只移除模型名末尾、以连字符连接的有效日期 checkpoint：

- `-MMDD`，例如 `deepseek-v4-flash-0731`。
- `-YYYYMMDD`，例如 `claude-sonnet-4-20250514`。
- `-YYYY-MM-DD`，例如 `gpt-4o-2024-08-06`。

月、日必须构成有效日期；无效日期原样保留。`MMDD` 使用闰年兼容的日历校验，使 `0229` 可作为 checkpoint。

以下内容不得移除：

- 模型代际：`v4`、`v5`。
- 小数版本：`2.5`、`3.1`。
- 单独年份或不构成上述完整日期格式的普通数字版本。
- 不在模型名末尾的日期样式片段。

归并键只使用规范化后的模型名，不包含 Provider。因此不同 Provider 下规范化后同名的模型合并。

### 2.3 纯数据转换边界

新增一个无 DOM、无 Chart.js 依赖的前端模块，职责限于：

1. `stripDateCheckpoint(modelName)`：按上述规则返回规范化模型名。
2. `buildModelChartRows(byModel, { mergeDateCheckpoints })`：
   - 开启归并时按规范化模型名跨 Provider 分组。
   - 关闭归并时按原始 `provider/model` 条目逐条生成图表行。
   - 累加 `input`、`output`、`cacheRead`、`cacheWrite`、`totalTokens`、`totalCost`、`requests`；缺失数值按 `0`。
   - 计算 `totalInput = input + cacheRead + cacheWrite`。
   - 按 `totalInput + output` 降序排列；相同时按稳定的显示标签排序，保证测试和视觉顺序可预测。

该模块不得写回 `byModel` 或缓存转换结果；每次渲染都从当前筛选后的精确数据生成新结果。

### 2.4 柱状图视觉语义

每个模型显示两个相邻柱组：

1. **Input 堆叠柱**，总高度为 `input + cacheWrite + cacheRead`：
   - `Cache Read`：同一 Input 色系中最深的颜色。
   - `Cache Write`：同一 Input 色系中的中等深度颜色。
   - 普通 `Input`：同一 Input 色系中最浅的颜色。
2. **Output 独立柱**：保持另一色系，不参与 Input 堆叠。

Chart.js 数据集约束：

- 三个 Input 分段使用同一个 `stack` 标识。
- Output 使用不同的 `stack` 标识，从而与 Input 并排。
- 圆角只作用于完整堆叠柱的外缘，不能让中间分段出现视觉断裂。
- 线性坐标与现有对数坐标都必须继续工作。
- 图例使用中英文 i18n 标签，不再硬编码英文 Token 名称。

Tooltip 使用 index 交互，使同一模型的所有分段可一次读取，并显示：普通 Input、Cache Write、Cache Read、总 Input、Output。数值使用本地化千分位。

## 3. Provider 费用圆环

圆环数据和排序保持现状，只扩展 Tooltip：

- 显示格式为“Provider：费用（占比）”。
- 费用沿用现有小额费用格式化，避免小额被显示为 `$0.00`。
- 占比为 `providerCost / allProviderCost * 100%`，保留 1 位小数。
- 总费用为 `0` 时显示 `0.0%`，不得出现 `NaN` 或 `Infinity`。
- 占比基于当前时间与维度筛选后的 `byProvider` 计算。

## 4. 国际化与文档

- 新开关、Input 三分段图例、总 Input Tooltip 文案必须加入 `src/locales/zh-CN.js` 与 `src/locales/en-US.js`，两侧键集合一致。
- Emoji 清理同步修改 `index.html` fallback 和两份语言词典。
- `README.md` 与 `README_EN.md` 同步说明：Model 图的缓存分段、默认 checkpoint 归并及可关闭行为、Provider 费用占比 Tooltip。
- 不修改 `CLAUDE.md`；如需补充长期工作区事实，只更新 `AGENTS.md`。

## 5. 错误处理与兼容性

- `byModel` 为空时沿用现有空态，不创建图表实例。
- 缺失、`null` 或非有限数值的缓存字段在展示转换层按 `0` 处理，避免污染 Chart.js 数据。
- 没有日期 checkpoint 的模型名保持原样。
- 归并开关变化必须沿用现有 destroy-before-render 生命周期，不能泄漏 Chart.js 实例或让旧的异步渲染覆盖新状态。
- 主题和语言切换后，颜色、图例、Tooltip 与空态文案必须使用当前主题和语言。

## 6. 测试与验收

### 自动化测试

1. 日期 checkpoint 单元测试：
   - `MMDD`、`YYYYMMDD`、`YYYY-MM-DD` 正确移除。
   - 闰日、月末和无效日期边界。
   - `v4`、`2.5`、单独年份、普通数字版本及非末尾日期保持原样。
2. Model 图数据单元测试：
   - 同模型跨 Provider 归并。
   - 四类 Token、请求量和费用正确求和。
   - 关闭开关后不归并。
   - 排序使用包含 Cache Read / Write 的总 Input。
   - 输入对象不被修改，缺失和非有限数字安全归零。
3. 图表配置测试：
   - Input 三段共用堆叠组，Output 使用独立组。
   - 三种 Input 分段颜色深浅有明确差异。
   - Tooltip 同时提供各分段、总 Input 和 Output。
4. Provider Tooltip 测试：
   - 费用与 1 位小数百分比同时显示。
   - 零总费用安全显示 `0.0%`。
5. DOM / i18n 测试：
   - checkpoint 开关存在且默认开启，切换后触发重绘。
   - 中英文新键集合一致。
   - 已清理的标题不含装饰性 Emoji，指定保留项仍存在。

### 门禁与真实浏览器验收

- `npm test` 全绿。
- `npm run build` 全绿。
- 在真实浏览器中分别验证浅色和深色主题：
  - 默认归并与关闭归并后的模型数量、标签和数值正确。
  - Input 柱总高等于普通 Input + Cache Write + Cache Read，三段可清楚区分。
  - 线性 / 对数坐标切换不破坏堆叠或 Tooltip。
  - Provider 圆环 Tooltip 显示正确费用与占比。
  - 中英文切换后标题、控件、图例和 Tooltip 同步更新。

## 7. Post-Implementation Sync Audit

实现与验证完成后，逐项对照本规格核查代码、测试和真实浏览器行为。任何经验证需要调整的交互或技术细节必须回写本文件，并把状态更新为“已实现（同步审计后回写）”，确保规格继续作为单一事实源。

## 实现说明与同步审计（2026-08-11）

### 实际实现边界

- 纯转换模块为 `src/model-chart-data.js`：`stripDateCheckpoint()` 识别并校验末尾 `-MMDD`、`-YYYYMMDD`、`-YYYY-MM-DD`；`MMDD` 使用 2000 年校验，因此允许 `0229`。`buildModelChartRows()` 在合并开启时以去除 checkpoint 后的 Model 名跨 Provider 聚合，在关闭时保留每条精确 `provider/model` 记录并以完整键作为显示标签；所有聚合字段先做有限数值归一化，并以饱和加法避免极端输入产生 `Infinity`，排序比较则使用归一化总量避免比较器自身溢出。
- Chart.js 展示集中在 `src/charts.js`：数据集实际顺序为 `Cache Read`、`Cache Write`、普通 `Input`、`Output`；前三者共享 `stack: 'input'`，Output 使用 `stack: 'output'`。Input 三段使用同一靛蓝色系的深、中、浅透明度，并按每根柱实际存在的最底/最顶分段只绘制外缘圆角；Model 图的交互、Tooltip 和坐标轴配置由无 DOM/CDN 依赖的 options builder 生成，并直接传给真实 Chart.js 实例。
- Model Tooltip 使用 `interaction.mode: 'index'`。主体按数据集顺序显示 Cache Read、Cache Write、Input、Output，footer 显示三段相加后的 Total Input；中英文文案均来自 `src/locales/zh-CN.js` 与 `src/locales/en-US.js`。
- 合并开关位于 `index.html` 的 Model 图标题行、对数坐标开关之前，首次加载由 HTML `checked` 默认开启；`src/main.js` 仅在当前页面生命周期读取其状态并沿用既有 destroy-before-render 流程，筛选、线性/对数、主题和语言重绘不会重置它，刷新页面后恢复默认开启。
- Provider 圆环仍使用当前筛选后的 `byProvider` 顺序和费用；Tooltip 由 `formatProviderTooltipLabel()` 输出小额友好费用与一位小数占比，总费用为零时固定为 `0.0%`。
- 装饰性标题 Emoji 已从 `index.html` fallback 与双语词典移除；品牌 `🦞`、Session 状态、摘要卡片和 `💰 价格配置` 图标保留。`README.md` 与 `README_EN.md` 已同步说明缓存分段、默认 checkpoint 合并及 Provider 占比 Tooltip。
- 320px 实机验收额外暴露了日期输入、维度筛选和分页控件的固有宽度溢出。最终 `src/style.css` 在窄屏让日期输入可收缩、维度字段占满可用宽度、分页控件换行；这是对第 6 节“无重叠或横向裁切”验收项的必要修正，不改变桌面端交互。

### 测试与真实浏览器证据

- 单元测试覆盖 `tests/unit/frontend/model-chart-data.test.js`、`tests/unit/frontend/charts.test.js` 与 `tests/unit/frontend/i18n.test.js`；最终 `npm test` 为 25 个测试文件通过，243 个测试通过、1 个跳过（共 244 个），`npm run build` 由 Vite 6.4.2 成功构建 14 个模块。
- 真实浏览器使用工作树本地 launcher 在隔离的临时 `OPENCLAW_CONFIG_DIR` 与 loopback 端口运行；验收数据使用匿名化的受控样本，同时覆盖跨 Provider 的日期 checkpoint 变体以及 Cache Read / Cache Write。
- 在合成验收样本中，合并开启后两个精确条目 `provider-a/model-alpha-0731` 与 `provider-b/model-alpha` 归并为单个 `model-alpha` 标签，各 Token 分量等于两个来源的手工校验合计；关闭开关后恢复两个带 Provider 的精确标签。
- 深色 Tooltip 以合成的有限数值样本验证 Cache Read、Cache Write、Input、Output 与 Total Input 的加总关系；Provider Tooltip 以匿名 Provider 和合成费用验证当前筛选总费用下的一位小数占比。
- 线性 / 对数切换实测分别创建有效 `linear` / `logarithmic` 图表且保持合并开关状态；Provider、Model、最近 30 天、语言和主题操作均生成新的 Chart 实例并保留当前筛选与合并选择。英文状态下标题、开关、图例及 Total Input Tooltip 已同步切换。
- 320px 复验结果为 `document.scrollWidth === 320`，Model 两个开关分行且无重叠，日期输入、Provider/Model 筛选及分页按钮均位于视口内。验证结束后已停止隔离 PID、确认端口释放并删除临时配置目录。
- 截图证据保存在忽略的 SDD 工作区：`artifacts/light-merged-model-chart.png`、`artifacts/dark-merged-model-tooltip.png`、`artifacts/dark-merge-off-model-chart.png`、`artifacts/dark-provider-percentage-tooltip.png`、`artifacts/narrow-320-fixed-full-page.png`（目录：`.superpowers/sdd/2026-08-11-dashboard-chart-clarity-and-model-grouping/`）。

### 审计结论

第 1–6 节的功能、非目标、国际化、文档、空态/非有限数值兼容、Chart 生命周期与验收项均已在代码、自动化测试和真实浏览器中逐项核对。除上述为满足窄屏验收而补充的响应式约束外，最终行为与原设计无语义偏差。
