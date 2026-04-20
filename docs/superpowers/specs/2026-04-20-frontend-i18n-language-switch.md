# 设计规格：前端中英文国际化与语言切换（Phase 1）

**日期**：2026-04-20  
**状态**：规划中

## 目标

为现有前端多页面（`index.html`、`pricing.html`）提供统一的中英文切换能力，至少支持：

- `zh-CN`（默认）
- `en-US`

并确保用户选择可持久化、跨页面一致。

## 范围（Phase 1）

本期仅覆盖**静态 UI 文案与按钮文案**，不包含以下内容：

- 图表图例/tooltip 等图表文本
- 相对时间文案（如“x 分钟前”）
- 后端 API 返回错误信息的多语言

## 设计原则

1. 轻量实现，不引入第三方 i18n 依赖。
2. 与现有主题切换机制保持一致的使用体验（同级入口、同级持久化策略）。
3. 保持现有视觉风格，避免新增突兀样式。

## 架构设计

### 1) i18n 核心模块

新增 `src/i18n.js`，提供以下能力：

- `getLocale()`：返回当前 locale。
- `setLocale(locale)`：设置并持久化 locale。
- `t(key)`：按 key 取翻译文本。
- `applyI18nDocument()`：更新 `<html lang>` 和页面标题等基础信息。
- `translateStaticElements(root)`：按 `data-i18n` / `data-i18n-attr` 批量翻译 DOM。

持久化 key 约定：

- `openclaw-locale`

### 2) 词典组织

新增：

- `src/locales/zh-CN.js`
- `src/locales/en-US.js`

命名空间约定：

- `common`
- `dashboard`
- `pricing`

### 3) 页面接入方式

- `index.html`、`pricing.html` 的头部都增加语言切换控件。
- 使用 `data-locale-control` 标记按钮（如 `zh-CN` / `en-US`）。
- 使用 `data-i18n` / `data-i18n-attr` 标记静态文案节点。
- 页面入口脚本（`src/main.js`、`src/pricing.js`）初始化时调用 i18n 模块完成首次渲染，并监听语言切换后重渲染相关静态文案。

## 兼容与回退

- 若 localStorage 不可用，回退到默认 `zh-CN`。
- 若 key 缺失，回退到 `zh-CN` 同 key；仍缺失时返回 key 字面值，避免页面空白。

## 验收标准

1. 仪表盘与价格页均可切换中英文。
2. 切换后刷新页面语言保持不变。
3. 从任一页面跳转到另一页面后语言保持一致。
4. 主题切换、数据加载、价格配置功能不受影响。

## 同步审计要求

实现完成后需执行一次“规格-实现同步审计”：

- 检查是否仅覆盖了 Phase 1 范围。
- 若实现因技术约束偏离规格，需同步更新本文档，保证文档为单一事实源。
