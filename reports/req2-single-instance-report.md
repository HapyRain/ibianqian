# 需求2：单实例检测 -- 实施报告

## 日期
2026-07-07

## 修改文件
- `d:\Project\ibianqian\electron\main.js`（+18 行，插入位置：第 145-161 行）

## 实现内容

### 单实例锁（第 148-152 行）
- 在 `app.whenReady()` 之前调用 `app.requestSingleInstanceLock()`
- 获取锁失败（返回 `false`）时，调用 `app.quit()` 并 `return` 终止模块执行
- `return` 语句确保后续的 `app.whenReady()` 及事件注册代码不会执行

### second-instance 事件监听（第 155-161 行）
- 当用户尝试启动第二个实例时触发
- 恢复已有窗口：`mainWindow.isMinimized()` 时先 `restore()`，然后 `show()` + `focus()`
- 与现有托盘双击行为保持一致（同样调用 `show()` + `focus()`）

## 代码插入位置

```
第 143 行  } // createWindow 函数结束
第 145 行  // === 单实例检测 ===
第 148 行  const gotTheLock = app.requestSingleInstanceLock();
第 149 行  if (!gotTheLock) { app.quit(); return; }
第 155 行  app.on('second-instance', ...)
第 163 行  // === 应用启动 ===
第 166 行  app.whenReady().then(...)
```

## 与现有代码的兼容性

| 检查项 | 结果 |
|--------|------|
| `Menu.setApplicationMenu(null)` 先于单实例锁执行 | 正常，lock 只是检查实例数，不影响菜单设置 |
| `app.isQuitting = false` 先于锁执行 | 正常，状态变量赋值无副作用 |
| 托盘/窗口函数定义在锁之前 | 正常，函数定义不产生运行时效果 |
| `second-instance` 事件引用 `mainWindow` | 安全，闭包捕获外部变量，运行时 `mainWindow` 已由第一个实例赋值 |
| `app.quit()` 触发 `before-quit` 事件 | 正常，`before-quit` 中设置 `app.isQuitting = true`，保证退出流程完整 |
| 开发环境多开（如 `electron .` 两次） | 第二个进程获取锁失败，调用 `quit()` 后退出，不影响第一个实例 |

## 验收标准

- [x] 双击 exe 两次只有 1 个窗口 + 1 个托盘图标（打包后验证）
- [x] 第二个实例启动时，已有窗口被恢复并聚焦
- [x] 锁检查在 `app.whenReady()` 之前执行
- [x] 获取锁失败时 `app.quit()` 且不继续执行后续代码
