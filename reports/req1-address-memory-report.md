# 需求 1：服务器地址记忆 + 连接失败提示 -- 实现报告

## 概述

实现了 localStorage 持久化服务器地址、连接失败时阻止静默重连并显示中文错误提示，以及 5 秒防抖窗口。

## 改动清单

### 1. `public/app.js`（~30 行新增/修改）

#### 1.1 地址记忆（第 55-64 行）

```javascript
const serverHost = ref(
  (function () {
    try {
      const saved = localStorage.getItem('buglist_server_host');
      if (saved) return saved;
    } catch (e) { /* 静默忽略 */ }
    return location.host;
  })()
);
```

- **key**: `buglist_server_host`
- 使用 IIFE 在 `setup()` 顶层立即执行，避免闪烁（在 Vue 响应式系统接管前就确定初始值）
- `localStorage` 读取包裹 try/catch（防止隐私模式 / storage 满等异常）
- fallback 为 `location.host`

#### 1.2 新增响应式状态（第 34-41 行）

| 变量 | 类型 | 说明 |
|------|------|------|
| `disconnectReason` | `ref(null)` | 连接失败原因文案，非空时替换 statusText |
| `lastOnCloseTime` | `let` (非响应式) | 上次 onclose 触发时间戳，用于 5 秒防抖 |
| `allowReconnect` | `let` (非响应式) | 是否允许自动重连，首次加载为 false |

#### 1.3 statusText 计算属性更新（第 79-90 行）

优先检查 `disconnectReason.value`，非空则直接返回错误文案，否则沿用原有状态映射。

#### 1.4 onopen 更新（第 114-122 行）

新增两行：
- `disconnectReason.value = null` -- 连接成功后清除错误文案
- `allowReconnect = true` -- 连接成功后恢复重连能力

#### 1.5 onclose 替换静默重连（第 133-152 行）

```javascript
ws.onclose = function (event) {
  ws = null;

  // 防抖：5 秒内重复触发忽略
  const now = Date.now();
  if (now - lastOnCloseTime < 5000) {
    return;
  }
  lastOnCloseTime = now;

  connectionStatus.value = 'disconnected';

  if (!allowReconnect) {
    disconnectReason.value = '连接失败，服务器端口可能已变更，请联系服务端确认地址';
  } else {
    scheduleReconnect();
  }
};
```

核心逻辑：
- 不再无条件调用 `scheduleReconnect()`
- `allowReconnect === false`（首次加载使用保存的地址）：设置错误文案，不重连
- `allowReconnect === true`（用户已手动修改过地址）：正常调用 `scheduleReconnect()`
- 防抖窗口 5 秒，避免 onclose 重复触发导致闪烁

#### 1.6 onServerChange 更新（第 346-362 行）

```javascript
function onServerChange(newHost) {
  if (!newHost || newHost === serverHost.value) return;
  serverHost.value = newHost;

  // 持久化到 localStorage
  try {
    localStorage.setItem('buglist_server_host', newHost);
  } catch (e) { /* 静默忽略 */ }

  // 重置防抖计数器，恢复自动重连逻辑
  lastOnCloseTime = 0;
  disconnectReason.value = null;
  allowReconnect = true;

  disconnect();
  connectWebSocket();
}
```

- 写入 `localStorage`（同步持久化）
- 重置防抖 `lastOnCloseTime = 0`
- 清除错误文案 `disconnectReason.value = null`
- 恢复自动重连 `allowReconnect = true`

#### 1.7 导出新增（第 486 行）

`disconnectReason` 加入 return 语句，供模板 `:class` 绑定使用。

### 2. `public/index.html`（1 行修改）

```html
<!-- 修改前 -->
<span class="status-text">{{ statusText }}</span>

<!-- 修改后 -->
<span class="status-text" :class="{ 'disconnect-reason': disconnectReason }">{{ statusText }}</span>
```

- 当 `disconnectReason` 非空时，给 `<span>` 添加 `disconnect-reason` CSS 类
- 错误文案通过 `statusText` 计算属性自动替换

### 3. `public/style.css`（5 行新增）

```css
.status-text.disconnect-reason {
  color: var(--color-danger);
  font-weight: 500;
}
```

- 红色文字 (`#f56c6c`)
- 加粗 500 以突出显示
- 仅当 `.disconnect-reason` 类存在时生效

## 状态流转图

```
页面加载
  │
  ├─ localStorage 有值 → serverHost = 保存的地址
  └─ 无值              → serverHost = location.host
  │
  ▼
connectWebSocket()
  │
  ├─ 连接成功 (onopen)
  │   ├─ disconnectReason = null
  │   ├─ allowReconnect = true
  │   └─ 状态灯绿色 + "已连接"
  │
  └─ 连接失败 (onclose)
      ├─ 防抖检查（5s 窗口）
      ├─ allowReconnect === false（首次）
      │   ├─ disconnectReason = "连接失败，服务器端口可能已变更..."
      │   ├─ 状态灯红色
      │   └─ 不重连，等待用户手动修改地址
      │
      └─ 用户修改地址 (onServerChange)
          ├─ localStorage 写入新地址
          ├─ lastOnCloseTime = 0（重置防抖）
          ├─ disconnectReason = null（清除错误）
          ├─ allowReconnect = true（恢复重连）
          └─ 重连新地址 → 成功则绿，失败则正常重连
```

## 与方案对照

| 验收项 | 状态 |
|--------|------|
| 地址记忆: 刷新/重启后恢复上次输入的服务器地址 | 已实现 -- `localStorage.getItem('buglist_server_host')` |
| 连接失败提示: 状态指示器变红 + 中文提示，不静默重连 | 已实现 -- `disconnectReason` + 条件跳过 `scheduleReconnect()` |
| 连接恢复: 手动修改地址重连成功后恢复绿色 + "已连接" | 已实现 -- `onopen` 清除 `disconnectReason` |
| 防抖: 5 秒内重复 onclose 不产生新提示 | 已实现 -- `lastOnCloseTime` 时间戳比较 |
| 防抖: 手动重连时重置计数器 | 已实现 -- `onServerChange` 中 `lastOnCloseTime = 0` |
