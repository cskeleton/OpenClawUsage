# 设计规格：Mastercard 风格多主题界面重构 (Light/Dark/System)

**日期**：2026-04-19  
**状态**：已实现

## 目标

参照 `getdesign.md/mastercard/design-md` 的风格，为项目（`index.html` 和 `pricing.html`）重构一套支持 浅色(Light) / 深色(Dark) / 跟随系统(System) 切换的前端界面。

**核心视觉语言**：
- Warm cream canvas（温暖的奶油色背景）
- Orbital pill shapes（超大圆角的胶囊形状控件）
- Editorial warmth（编辑级排版温感）
- Traced-orange orbital arcs（橘色轨道弧线装饰）

## 变更范围

### 1. 样式重构 (`src/style.css`)
- **CSS 变量提取与主题化**：
  将原本的 `:root` 变量重构为 `.theme-light` 和 `.theme-dark` 两个主要类，默认使用 `prefers-color-scheme` 媒体查询匹配系统主题。
- **调色板更新**：
  - **浅色**：主背景为温暖奶油色（如 `#FAF9F6`），卡片背景为纯白，主文字为深色偏暖（如 `#1C1917`），点缀色使用橘色（`#EA580C` / `#F97316`）。
  - **深色**：主背景为暖黑色（如 `#1C1917`），卡片背景为次级黑（如 `#292524`），文字为奶油白。
- **形状与边框**：
  将原本的 `--radius` 相关变量更新，按钮（`.btn-primary`, `.btn-secondary`, `.time-btn`）使用超大胶囊圆角（`9999px`）。卡片使用更加平滑的圆角设计。
- **背景装饰**：
  更新 `body::before` 和 `body::after` 的装饰，使用橘黄色的轨道弧线（Orbital arcs）替代原有的蓝紫色光晕，使用 `border` 和 `border-radius: 50%` 结合透明度实现弧线效果。

### 2. 主题切换组件 (`index.html`, `pricing.html`)
- 在 `.header-right` 中增加一个主题切换按钮（如一个下拉菜单或循环切换按钮），图标根据当前状态显示 🌞 (Light)、🌙 (Dark) 或 💻 (System)。
- 提供通用的 HTML 结构。

### 3. 主题切换逻辑 (`src/theme.js` 及其引入)
- 创建一个全局共享的 `src/theme.js` 文件，处理主题切换逻辑：
  1. 读取 `localStorage.getItem('openclaw-theme')`，默认为 `system`。
  2. 根据当前设置，在 `<html>` 标签上添加 `.theme-light` 或 `.theme-dark`，如果为 `system`，则监听 `window.matchMedia('(prefers-color-scheme: dark)')`。
  3. 提供 `setTheme(theme)` 方法，更新状态并重新渲染切换按钮的图标。
- 在 `index.html` 和 `pricing.html` 的 `<head>` 中：先内联一段脚本根据 `localStorage` 与系统偏好设置 `html` 的 `theme-light` / `theme-dark`（减轻 FOUC），再加载 `theme.js` 完成监听与控件绑定（无需在 `main.js` / `pricing.js` 中初始化主题）。

## 审计与检查点
- ✅ 确保 `localStorage` 正常记录用户的偏好。
- ✅ 确保图表（Chart.js）的颜色能够跟随主题切换（Chart.js 的文字和网格线需要动态更新或使用 CSS 变量）。
- ✅ 保持现有功能（价格配置逻辑、数据刷新等）完整可用。

## 相关规格链接

- 前端中英文国际化与语言切换（Phase 1）：
  `docs/superpowers/specs/2026-04-20-frontend-i18n-language-switch.md`
