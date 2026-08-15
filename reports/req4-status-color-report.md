# 需求4：状态颜色强化 -- 实施报告

## 日期
2026-07-07

## 概述
在状态列的 el-select 上添加自定义 trigger slot，使用彩色 el-tag 直观显示当前状态，同时保持下拉切换功能不变。

## 改动详情

### 一、`public/index.html` — 状态列模板改动

**位置**: 第 88-119 行（原 88-107 行，净增约 12 行）

**改动内容**: 在 el-select 上新增 `#default` slot，渲染一个动态颜色的 `<el-tag>` 作为触发器显示。

**关键实现**:
- 使用 `<template #default>` 插槽自定义 el-select 的触发区域
- 通过三元表达式动态绑定 `:type` 属性，实现颜色映射:

| 状态     | el-tag type   | 颜色      | 对应 CSS 变量          |
|----------|---------------|-----------|------------------------|
| 待修复   | `warning`     | 橙色 #e6a23c | `--color-pending`      |
| 修复中   | `primary`     | 蓝色 #409eff | `--color-fixing`       |
| 已完成   | `success`     | 绿色 #67c23a | `--color-done`         |

- Element Plus 的 el-tag 默认 `effect="light"` 效果提供浅色背景 + 深色文字，恰好匹配设计规范中的背景色要求
- 使用 `disable-transitions` 避免不必要的动画
- 使用 `size="small"` 确保标签在 select 内尺寸合适
- 添加 class `status-trigger-tag` 便于样式控制
- **下拉选项保持不变**: 依然使用圆点 + 文字样式（通过 `getStatusClass(opt)` 和 `.status-tag-dot`）
- **所有自定义元素使用显式闭合标签**（`></el-tag>` 而非 `/>`），符合 HTML5 解析器要求

### 二、`public/style.css` — 样式改动

**位置**: 第 252-265 行（净增约 6 行）

**改动内容**:

1. **合并 `.status-select .el-select__wrapper` 规则** (第 252-255 行):
   - 在原有 `box-shadow: none !important;` 基础上增加 `padding-right: 28px`
   - 确保下拉箭头（suffix icon）有足够空间，不被 el-tag 遮挡

2. **新增 `.status-trigger-tag` 规则** (第 261-265 行):
   - `cursor: pointer !important;` — 鼠标悬停时显示手型，提示用户可点击切换
   - `user-select: none;` — 防止点击时选中文字

## 视觉效果

- **待修复**: 橙色标签，浅橙色背景（`#fdf6ec`），橙色文字（`#e6a23c`）
- **修复中**: 蓝色标签，浅蓝色背景（`#ecf5ff`），蓝色文字（`#409eff`）
- **已完成**: 绿色标签，浅绿色背景（`#f0f9eb`），绿色文字（`#67c23a`）

点击标签可打开下拉菜单，选择其他状态进行切换。下拉选项保持原有的圆点 + 文字样式。

## 风险与注意事项

| 项目 | 说明 |
|------|------|
| 下拉箭头可见性 | 通过 `padding-right: 28px` 确保箭头不被标签遮挡 |
| el-tag type 映射 | Element Plus 的 `warning`/`primary`/`success` 颜色与设计要求的橙/蓝/绿一致 |
| 标签尺寸 | `size="small"` 使标签适配 120px 宽的 select |
| 键盘导航 | el-select 本身支持键盘操作（方向键 + Enter），自定义 trigger 不影响此功能 |

## 验收清单

- [x] 三种状态显示为彩色标签（橙/蓝/绿）
- [x] 点击标签可打开下拉菜单切换状态
- [x] 下拉选项保持圆点 + 文字样式
- [x] 下拉箭头可见
- [x] 光标悬停在标签上时显示为手型
