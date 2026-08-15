# server.js Bug 修复报告

## 修复概览

| Bug ID | 严重度 | 描述 | 状态 |
|--------|--------|------|------|
| BUG-2 | 高 | MIME 白名单校验可被绕过 | 已修复 |
| BUG-3 | 中 | 版本号无意义递增 | 已修复 |
| BUG-4 | 低 | rename 失败后临时文件残留 | 已修复 |
| EDGE-1 | 中 | 无上传文件大小限制 | 已修复 |

---

## BUG-2: MIME 白名单校验可被绕过

**位置:** `handleUpload` 函数（约第 409-431 行）

**问题:** 当 `declaredMime` 为 null（客户端不带 Content-Type 头）时，MIME 白名单校验 `if (declaredMime && ...)` 直接跳过。若此时 `magicMime` 也为 null（文本文件、SVG 等无魔数的文件），两份校验全部跳过，任意文件可上传。

**修复:** 在魔数校验后增加兜底检查 `effectiveMime = declaredMime || magicMime`，确保至少有一个来源的 MIME 类型在白名单中。SVG（`image/svg+xml` 在白名单中但无魔数）不受影响：`declaredMime` 为 `image/svg+xml` 时 `effectiveMime` 在白名单中，正常放行。

---

## BUG-3: 版本号无意义递增

**位置:** `updateData` 函数（约第 81-84 行）

**问题:** 无论 `transformFn` 返回 null（无变化）还是正常 change，都递增 version 并写盘。例如 handleAdd 中 bug 已存在时返回 null，但版本号仍增加。

**修复:** 在 `transformFn(data)` 返回 null 时，提前返回 `{ data, change: null, version: data.version }`，不递增版本、不写盘。调用方（handleUpdate/handleAdd/handleDelete）已检查 `result.change` 才广播，无需修改。

---

## BUG-4: rename 失败后临时文件残留

**位置:** `updateData` 函数（约第 90-97 行）

**问题:** `writeFileSync` 成功但 `renameSync` 失败时，`.data.tmp` 残留在磁盘上。

**修复:**
1. 在 `writeFileSync` 之前先 `unlinkSync(TMP_FILE)` 清理旧残留（忽略 ENOENT）。
2. `renameSync` 失败时在 catch 中 `unlinkSync(TMP_FILE)` 清理当前临时文件，然后 `throw renameErr` 向上传播错误。

---

## EDGE-1: 无上传文件大小限制

**位置:** `handleUpload` 函数（约第 367-389 行）

**问题:** 不检查上传文件大小，理论上可上传超大文件耗尽磁盘或内存。

**修复:**
1. 设置 `MAX_FILE_SIZE = 100 * 1024 * 1024`（100MB，适合局域网场景）。
2. 在 `req.on('data')` 中累加 `totalSize`，超过限制时 `req.destroy()` 提前终止连接（避免内存积压）。
3. 在 `req.on('end')` 中二次检查 `body.length > MAX_FILE_SIZE`，返回 HTTP 413 状态码。
