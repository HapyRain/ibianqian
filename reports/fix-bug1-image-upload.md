# BUG-1 修复报告：图片上传失败导致旧图被删除

**时间**: 2026-07-07
**文件**: `d:\Project\ibianqian\public\app.js`
**函数**: `handleImageUpload` (约第 535-584 行)

## 问题描述

原逻辑先 DELETE 旧图文件，再 POST 上传新图。若上传失败，`bug.image` 仍指向已删除的旧文件名，导致缩略图显示裂图。

## 修复方案

改为"先上传新图成功，再删除旧图"：

1. 函数开头保存旧文件名到局部变量 `oldImage = bug.image`
2. 移除原来在 POST 之前的 DELETE 逻辑
3. 上传成功并更新 `bug.image` 后，再异步删除旧图
4. 删除旧图的 fetch 用 `.catch()` 包裹（fire-and-forget），失败只打印 warn，不影响任何状态
5. 上传失败时，旧图完整保留，不会出现裂图

## 改动的代码位置

- 删除：原第 543-549 行（inline DELETE + try/catch）
- 新增：第 542-543 行（局部变量 oldImage）、第 570-575 行（上传成功后的 fire-and-forget DELETE）

## 影响范围

仅 `handleImageUpload` 函数内部逻辑顺序调整，无接口变更，无其他文件受影响。
