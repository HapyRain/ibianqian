# 需求5：状态排序 + 筛选 --- 实现报告

## 日期
2026-07-07

## 概述
实现了 Bug 列表的状态排序和筛选功能。排序规则为「修复中(0) → 待修复(1) → 已完成(2)」，同状态保持原序（利用 JS 稳定排序）。筛选通过按钮组切换，每个按钮显示对应状态的 Bug 数量。表格行已有 CSS transition 动效，无需额外添加。

---

## 改动详情

### 1. `public/app.js`（+30行）

| 改动 | 位置 | 代码 |
|------|------|------|
| 新增 `STATUS_ORDER` 常量 | 第53行 | `{ '修复中': 0, '待修复': 1, '已完成': 2 }` |
| 新增 `statusFilter` ref | 第59行 | `ref('全部')`，默认不筛选 |
| 新增 `filteredAndSortedBugs` computed | 第98-107行 | 先筛选（非"全部"时过滤），再排序（稳定排序） |
| 新增 `statusCounts` computed | 第109-116行 | 返回 `{ '全部': N, '待修复': N, '修复中': N, '已完成': N }` |
| 新增 `setStatusFilter` 方法 | 第404-407行 | 设置 `statusFilter.value` |
| 新增 `filterStatusClass` 方法 | 第412-414行 | 返回 `'filter-active'` 或 `''` |
| 更新 return 导出 | 第521-554行 | 导出 `statusFilter`, `filteredAndSortedBugs`, `statusCounts`, `setStatusFilter`, `filterStatusClass` |

**关键逻辑验证**：
- 排序使用 `[...list].sort(...)`，先复制再排序，不修改原数组
- `STATUS_ORDER[a.status] ?? 9` 确保未知状态排到最后
- `Array.prototype.sort` 在 ES2019+ 中为稳定排序，同状态保持原序自动满足
- `statusCounts` 中"全部"使用 `bugs.value.length`（原始总数，不受筛选影响）
- 需求4的 el-select `#default` slot 自定义 trigger 完全未被触碰

### 2. `public/index.html`（+15行）

| 改动 | 位置 | 说明 |
|------|------|------|
| 表格 `:data` 绑定 | 第64行 | 从 `:data="bugs"` 改为 `:data="filteredAndSortedBugs"` |
| 新增筛选按钮组 | 第43-52行 | `v-for="f in ['全部', ...statusOptions]"` 动态渲染4个按钮 |
| 工具栏结构重组 | 第42-59行 | 拆分为 `.filter-buttons` + `.toolbar-actions` 两行 |

**筛选按钮组模板**：
```html
<div class="filter-buttons">
  <el-button
    v-for="f in ['全部', ...statusOptions]"
    :key="f"
    :type="statusFilter === f ? 'primary' : ''"
    size="small"
    :class="filterStatusClass(f)"
    @click="setStatusFilter(f)"
  >{{ f }} ({{ statusCounts[f] || 0 }})</el-button>
</div>
```

- 所有自定义元素使用显式闭合标签
- 需求4的 el-select 结构未作任何修改

### 3. `public/style.css`（+30行）

| 改动 | 位置 | 说明 |
|------|------|------|
| `.toolbar` 改为 column 布局 | 第183-189行 | `flex-direction: column; gap: 10px` |
| 新增 `.toolbar-actions` | 第191-195行 | 新增 Bug 按钮 + 记录数量的水平行 |
| 新增 `.filter-buttons` | 第202-208行 | `flex-wrap: wrap; gap: 8px` |
| 新增筛选按钮样式 | 第210-214行 | 统一 `font-size: 0.85rem; border-radius: 6px` |
| 新增激活态样式 | 第217-219行 | `.filter-active` 加粗字体 |
| 新增非激活态默认样式 | 第222-232行 | 柔和灰色边框 + hover 蓝色高亮 |
| 响应式适配 | 第453-460行 | `.toolbar-actions` 换行、`.filter-buttons` 缩小间距 |

**已有动效确认**：
- `el-button` 全局 transition（第363-365行）：transform + box-shadow + background + border
- 表格行 transition（第244-246行）：已有的 `.table-wrapper .el-table__body tr` transition（transform + box-shadow）
- 表格行 hover 动效（第248-257行）：scale(1.01) + shadow + 背景色变化

以上过渡动效已完整覆盖筛选切换时的视觉反馈需求。

---

## 功能验证要点

| 验证项 | 预期行为 |
|--------|----------|
| 默认排序 | 表格按 修复中 → 待修复 → 已完成 排列 |
| 同状态原序 | 同一状态内的 Bug 保持服务端返回的原始顺序 |
| 点击筛选按钮 | 表格仅显示对应状态的 Bug，按钮变为 primary 蓝色高亮 |
| 点击"全部" | 清除筛选，恢复显示所有 Bug（仍按排序规则排列） |
| 按钮数字 | 各按钮括号内数字反映当前最新计数（"全部"始终为总数） |
| 切换动效 | 表格行有渐变过渡（已有 CSS transition） |
| 新增 Bug | 新增后自动排到"待修复"区域（在"修复中"之后、"已完成"之前） |
| 状态变更 | Bug 状态改变后自动重新排序到对应区域 |
| el-select 自定义 trigger | 状态列的彩色 el-tag trigger 不受影响（需求4保持不变） |

---

## 向后兼容性

- 未修改 WebSocket 消息协议
- 未修改服务端 server.js
- 未修改 data.json 数据结构
- `bugs` ref 仍导出（供 bug-count 显示总数）
- 需求4的 el-select `#default` slot 完全未被触碰

---

## 文件清单

| 文件 | 改动类型 | 行数变化 |
|------|----------|----------|
| `public/app.js` | 新增排序/筛选逻辑 | +30行 |
| `public/index.html` | 新增筛选按钮组 + 表格绑定更新 | +15行 |
| `public/style.css` | 新增筛选按钮样式 + 工具栏布局调整 | +30行 |
| **合计** | | **+75行** |
