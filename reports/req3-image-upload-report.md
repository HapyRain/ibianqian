# 需求3：Bug 图片上传（三种方式 + 无大小限制）—— 实现报告

## 概述

实现了 Bug 图片上传功能，支持点击、拖拽、Ctrl+V 粘贴三种上传方式，图片存储于 `public/uploads/` 目录，data.json 仅存文件名。无文件大小限制，不做 Canvas 压缩，保留 MIME 白名单和魔数校验。

## 修改文件清单

| 文件 | 改动类型 | 改动量 |
|------|----------|--------|
| `server.js` | 新增 + 修改 | +140 行 |
| `public/app.js` | 新增 + 修改 | +120 行 |
| `public/index.html` | 新增 | +40 行 |
| `public/style.css` | 新增 | +95 行 |

---

## server.js 改动详情

### 1. 启动时创建 uploads 目录（第 17-23 行）

```js
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
```

### 2. MIME 白名单 + 魔数校验（第 259-296 行）

- **ALLOWED_MIME_TYPES**: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/svg+xml`
- **detectMagicMime()**: 读文件头 4 字节，校验 PNG (`89504E47`)、JPEG (`FFD8FF`)、GIF (`47494638`)、WebP/RIFF (`52494646`)、BMP (`424D`)
- **isSafeFilename()**: 防路径穿越，检测 `..`、`/`、`\`，长度限制 255

### 3. parseMultipart()（第 303-345 行）

手动解析 multipart/form-data，使用纯 Buffer 操作（无第三方库依赖）：
- `Buffer.indexOf()` 定位 boundary 和 `\r\n\r\n` 头部结束
- 头部用 UTF-8 解码提取 `filename` 和 `Content-Type`
- 文件数据用 `Buffer.slice()` 提取

### 4. POST /api/upload（第 347-401 行）

- 解析 Content-Type header 获取 boundary
- 调用 parseMultipart 提取文件
- MIME 白名单校验
- 魔数校验（SVG 跳过）
- 生成 `uuid_原始文件名` 格式的唯一文件名
- 同步写入 `public/uploads/`
- 返回 `{ success: true, filename }`

### 5. DELETE /api/upload/:filename（第 406-433 行）

- 双层路径穿越防护：`isSafeFilename()` + `filePath.startsWith(UPLOADS_DIR)`
- 删除文件后返回 `{ success: true }`

### 6. HTTP 路由（第 440-463 行）

在 `createHttpHandler` 中增加 API 路由判断：
- `POST /api/upload` -> handleUpload
- `DELETE /api/upload/:filename` -> handleDeleteUpload
- `OPTIONS /api/*` -> CORS 预检响应

静态文件服务原逻辑 `/uploads/:filename` 由 `serveStaticFile` 处理，映射到 `public/uploads/:filename`。

---

## public/app.js 改动详情

### 1. 新增响应式 refs（第 78-91 行）

| ref | 用途 |
|-----|------|
| `currentImageBugId` | 记录点击上传时关联的 Bug ID |
| `imagePreviewVisible` | 大图预览对话框可见性 |
| `previewImageUrl` | 预览图片 URL |
| `uploadingBugId` | 正在上传中的 Bug ID（loading 遮罩） |
| `fileInputRef` | 隐藏文件输入框的模板引用 |

### 2. handleImageUpload(file, bugId)（第 530-575 行）

核心上传函数，三种方式统一调用：
1. 若 bug 已有旧图，先 DELETE 服务端旧文件
2. 创建 FormData，fetch POST `/api/upload`
3. 成功后更新本地 `bug.image` 并 `sendUpdate` 广播
4. 失败时 `ElementPlus.ElMessage.error` 提示
5. 上传期间设置 `uploadingBugId` 显示 loading 遮罩

### 3. 点击上传（第 577-604 行）

- `triggerFileInput(bugId)`: 设置 `currentImageBugId`，触发隐藏 `<input type="file">` 的 click
- `onFileSelect(event)`: 文件选择回调，取 `event.target.files[0]`，调用 `handleImageUpload`

### 4. 拖拽上传（第 609-643 行）

- `onDragOver(e)`: `preventDefault()` + 添加 `drag-over` CSS class
- `onDragLeave(e)`: 移除 `drag-over` CSS class
- `onDrop(e, bugId)`: 移除高亮，取 `e.dataTransfer.files[0]`，调用 `handleImageUpload`

### 5. Ctrl+V 粘贴上传（第 648-679 行）

- `onPaste(e)`: 遍历 `clipboardData.items`，找到 `type.startsWith('image/')` 的项
- 检查 `editingBugId.value`:
  - 有值 -> `handleImageUpload(blob, editingBugId.value)`
  - 无值 -> `ElMessage.warning('请先双击进入编辑模式再粘贴图片')`

### 6. 删除图片（第 684-705 行）

- `deleteImage(bug)`: fetch DELETE `/api/upload/:filename`，清空 `bug.image = null`，发送广播

### 7. 大图预览（第 710-725 行）

- `openPreview(bug)`: 设置 `previewImageUrl = /uploads/:filename`，显示对话框
- `closePreview()`: 关闭对话框并清空 URL

### 8. 生命周期修改（第 729-732 行）

- `onMounted`: 注册 `document.addEventListener('paste', onPaste)`
- `onUnmounted`: 移除 `document.removeEventListener('paste', onPaste)`

### 9. deleteBug 增强（第 511-524 行）

删除 Bug 时同步发送 DELETE 请求清理关联图片（fire-and-forget）。

### 10. handleRemoteDelete 增强（第 349-361 行）

接收到远程删除广播时，同步清理本地关联的图片文件。

---

## public/index.html 改动详情

### 1. 截图列（第 135-171 行）

在状态列和操作列之间新增 `<el-table-column label="截图" width="120">`：

- **缩略图容器** (`.image-cell`):
  - 绑定 `@click.stop`：有图时预览，无图时触发文件选择
  - 绑定 `@dragover`、`@dragleave`、`@drop` 事件
  - 动态 class：`has-image`（有图）、`drag-over-uploading`（上传中）

- **loading 遮罩**: 上传时显示旋转 spinner

- **缩略图** (`<img class="bug-thumbnail">`): `v-if="scope.row.image"` 条件渲染

- **占位符** (`<span class="image-placeholder">+</span>`): 无图时显示

- **删除按钮** (`<el-button class="image-delete-btn">`): 有图时显示，`@click.stop` 防止冒泡

### 2. 隐藏文件输入框（第 202-209 行）

```html
<input type="file" accept="image/*" ref="fileInputRef"
  style="display: none;" @change="onFileSelect" />
```

### 3. 大图预览对话框（第 211-214 行）

```html
<el-dialog v-model="imagePreviewVisible" title="截图预览"
  width="80%" @close="closePreview">
  <img :src="previewImageUrl" style="width: 100%; display: block;" />
</el-dialog>
```

---

## public/style.css 改动详情

### 新增样式（第 548-650 行）

| 选择器 | 说明 |
|--------|------|
| `.image-cell` | 48x48 容器，虚线边框，居中 flex，cursor pointer |
| `.image-cell:hover` | 蓝色实线边框 + 浅蓝背景 |
| `.image-cell.drag-over` | 拖拽高亮：蓝色实线边框 + 浅蓝背景 |
| `.image-cell.has-image` | 有图片时实线边框，hover 不显示背景 |
| `.bug-thumbnail` | 48x48，object-fit cover，圆角 |
| `.image-placeholder` | 灰色 + 号，hover 变蓝 |
| `.image-delete-btn` | 绝对定位右上角，18px 圆形，默认透明 hover 显示 |
| `.image-uploading-mask` | 半透明白色遮罩 + 居中 spinner |
| `.image-uploading-spinner` | 旋转动画加载圈 |
| `@keyframes spin` | 360 度旋转 |

---

## 数据模型

Bug 对象新增字段：

```json
{
  "id": "uuid",
  "name": "string",
  "status": "待修复|修复中|已完成",
  "image": "uuid_filename.png" | null
}
```

- `image` 字段存储文件名，为 `null` 时表示无图片
- 向后兼容：旧数据无此字段时前端视为 `null`

---

## 安全措施

1. **MIME 白名单**: 仅允许 6 种图片格式
2. **魔数校验**: 读取文件头字节验证真实类型，防止伪造 MIME
3. **路径穿越防护**: DELETE 端点双重校验（`isSafeFilename` + `startsWith`）
4. **唯一文件名**: `crypto.randomUUID()` 生成，防止文件名冲突和猜测

---

## 验收要点

- 点击缩略图区域打开文件选择器，选择后上传并显示缩略图
- 拖拽图片到缩略图区域，拖入时蓝色高亮，松手上传
- 编辑模式下 Ctrl+V 粘贴剪贴板图片，自动关联到当前 Bug
- 非编辑模式下 Ctrl+V 粘贴，toast 提示「请先双击进入编辑模式再粘贴图片」
- 无文件大小限制，大图正常上传
- 上传中显示 loading 遮罩
- 点击缩略图打开大图预览对话框
- 点击删除按钮（x）删除图片
- 删除 Bug 时自动清理关联图片
- 服务重启后 uploads 目录自动创建
