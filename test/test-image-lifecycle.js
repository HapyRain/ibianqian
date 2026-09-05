/**
 * 图片文件生命周期集成测试（多图语义，协议变更：bug.image → bug.images）
 *
 * 覆盖目标行为（服务端是图片文件生命周期的唯一所有者，且"先改数据、后删文件"）：
 *  1. 上传追加：同一 bug 依次上传 A、B → data.json 中 bug.images=[A,B]，uploads/ 同时保留 A 与 B（不再替换）
 *  2. WS removeImage 删除单张 → 引用从 images 移除、对应文件被服务端清理、监听方收到 removeImage 广播
 *  3. DELETE /api/upload/:filename 反查引用：data.json 引用被事务性移除、文件删除、
 *     监听方收到 removeImage 广播（originClientId='__delete_upload__'，混版本窗口兜底）
 *  4. WS delete 删除 bug → data.json 中 bug 消失，且该 bug 的全部图片文件被服务端从 uploads/ 清理
 *  5. update field='image'（白名单收敛）→ 被拒：data.json 不变、无广播
 *  6. 空目录孤儿上传清理（保持 validation-guards 语义）：400 且 uploads/ 无残留
 *  7. 未知 bugId 上传（未发 WS add）→ 服务端自动创建该 bug（images=[filename]）并广播完整 add
 *
 * 运行方式：node test-image-lifecycle.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据。
 */
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { startServer } = require('../server');
const {
  DATA_ROOT, UPLOADS_DIR, assert, sleep, readData, listUploads, countBroadcasts,
  connectWS, httpDeleteUpload, PNG_BUFFER, teardown, getCounts, onFatal,
} = H;

// 本文件历史以位置参数调用 upload，包一层适配到 helpers 的通用签名
const httpUpload = (port, taskId, bugId, clientId, buf, filename) =>
  H.httpUpload(port, { 'X-Bug-Id': bugId, 'X-Task-Id': taskId, 'X-Client-Id': clientId }, buf, filename);

async function runTests() {
  console.log('\n=== 图片文件生命周期测试（多图语义） ===\n');

  let httpServer = null;
  let client = null;
  let listener = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${DATA_ROOT}`);

    client = await connectWS(port, '操作方');
    listener = await connectWS(port, '监听方');
    await sleep(400); // 等待 fullSync / clientCount

    const TASK_ID = 'task-img-multi';
    const BUG_ID = 'bug-img-multi-001';
    const getBug = () => readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);

    // ===== 阶段 0：空目录孤儿上传清理（可选保持项） =====
    console.log('\n[阶段0] 空目录孤儿上传清理:');
    const up0 = await httpUpload(port, TASK_ID, BUG_ID, 'client-main', PNG_BUFFER, 'orphan.png');
    assert(up0.statusCode === 400, `空目录 + X-Bug-Id 上传被拒（HTTP 400，实际 status=${up0.statusCode}）`);
    assert(listUploads().length === 0, '空目录上传后 uploads/ 为空（孤儿文件被清理，无残留）');

    // ===== 阶段 1：建任务 + 建 bug =====
    console.log('\n[阶段1] 建任务 + 建 bug:');
    client.send({ type: 'createTask', clientId: 'client-main', data: { task: { id: TASK_ID, name: '多图生命周期任务' } } });
    await sleep(300);
    client.send({ type: 'add', clientId: 'client-main', data: { taskId: TASK_ID, bug: { id: BUG_ID, name: '多图Bug', status: '待修复' } } });
    await sleep(300);
    {
      const bug0 = getBug();
      // handleAdd 归一化：服务端保证 add 后 images 始终为数组
      assert(bug0 && Array.isArray(bug0.images) && bug0.images.length === 0, '新建 bug 默认 images 为空数组');
    }

    // ===== 阶段 2：上传 A → images=[A] =====
    console.log('\n[阶段2] 上传第一张图片 A:');
    const upA = await httpUpload(port, TASK_ID, BUG_ID, 'client-main', PNG_BUFFER, 'shot-a.png');
    const fA = upA.body && upA.body.filename;
    assert(upA.statusCode === 200 && upA.body && upA.body.success === true, `上传 A 成功（status=${upA.statusCode}）`);
    assert(!!fA && listUploads().includes(fA), `uploads/ 目录出现文件 A（${fA || '无'}）`);
    await sleep(300);
    {
      const bug = getBug();
      assert(bug && Array.isArray(bug.images) && bug.images.length === 1 && bug.images[0] === fA, '上传 A 后 data.json 中 bug.images=[A]');
    }

    // ===== 阶段 3：再上传 B → images=[A,B]（追加不替换） =====
    console.log('\n[阶段3] 再上传第二张图片 B（追加而非替换）:');
    const upB = await httpUpload(port, TASK_ID, BUG_ID, 'client-main', PNG_BUFFER, 'shot-b.png');
    const fB = upB.body && upB.body.filename;
    assert(upB.statusCode === 200 && upB.body && upB.body.success === true, `上传 B 成功（status=${upB.statusCode}）`);
    await sleep(300);
    {
      const bug = getBug();
      assert(bug && Array.isArray(bug.images) && bug.images.length === 2 && bug.images[0] === fA && bug.images[1] === fB,
        '上传 B 后 bug.images=[A,B]（追加而非替换）');
      const files = listUploads();
      assert(files.includes(fA) && files.includes(fB), 'uploads/ 同时保留 A 与 B（旧图不再被覆盖清理）');
    }

    // ===== 阶段 4：WS removeImage A → images=[B]、A 文件清理、监听方收到广播 =====
    console.log('\n[阶段4] WS removeImage 删除单张图片 A:');
    client.send({ type: 'removeImage', clientId: 'client-main', data: { taskId: TASK_ID, bugId: BUG_ID, filename: fA } });
    await sleep(500);
    {
      const bug = getBug();
      assert(bug && Array.isArray(bug.images) && bug.images.length === 1 && bug.images[0] === fB, 'WS removeImage A 后 bug.images=[B]');
      assert(!fs.existsSync(path.join(UPLOADS_DIR, fA)), `WS removeImage A 后文件 A 被服务端清理（${fA} 应已删除）`);
      assert(listener.messages.some(m => m.type === 'broadcast' && m.change && m.change.type === 'removeImage' && m.change.bugId === BUG_ID && m.change.filename === fA),
        '监听方收到 removeImage 广播（filename=A）');
    }

    // ===== 阶段 5：DELETE /api/upload/B → 反查引用移除 + 文件删除 + 广播（混版本窗口兜底） =====
    console.log('\n[阶段5] 直接 DELETE /api/upload/B（反查引用并事务性移除）:');
    const del = await httpDeleteUpload(port, fB);
    assert(del.statusCode === 200 && del.body && del.body.success === true, `DELETE /api/upload/B 返回 success:true（status=${del.statusCode}）`);
    await sleep(400);
    {
      const bug = getBug();
      assert(bug && Array.isArray(bug.images) && bug.images.length === 0, 'DELETE 后 data.json 中 bug.images 不再包含 B（引用被反查移除）');
      assert(!fs.existsSync(path.join(UPLOADS_DIR, fB)), `DELETE 后文件 B 已从 uploads/ 删除`);
      const rm = listener.messages.find(m => m.type === 'broadcast' && m.change && m.change.type === 'removeImage' && m.change.filename === fB);
      assert(!!rm, '监听方收到 DELETE 触发的 removeImage 广播');
      assert(!!rm && rm.originClientId === '__delete_upload__', 'DELETE 触发广播的 originClientId 为 __delete_upload__');
    }

    // ===== 阶段 6：重新上传 C、D → WS delete bug → bug 消失、C/D 文件均清理 =====
    console.log('\n[阶段6] 重新上传 C、D 后 WS delete 删除 bug，全部图片清理:');
    const upC = await httpUpload(port, TASK_ID, BUG_ID, 'client-main', PNG_BUFFER, 'shot-c.png');
    const fC = upC.body && upC.body.filename;
    const upD = await httpUpload(port, TASK_ID, BUG_ID, 'client-main', PNG_BUFFER, 'shot-d.png');
    const fD = upD.body && upD.body.filename;
    assert(upC.statusCode === 200 && upC.body && upC.body.success === true && fC &&
           upD.statusCode === 200 && upD.body && upD.body.success === true && fD,
      '重新上传 C、D 均成功（前置条件）');
    await sleep(300);
    client.send({ type: 'delete', clientId: 'client-main', data: { taskId: TASK_ID, bugId: BUG_ID } });
    await sleep(500);
    {
      const task = readData().tasks.find(t => t.id === TASK_ID);
      const bugGone = !(task && task.bugs.find(b => b.id === BUG_ID));
      assert(bugGone, 'WS delete 后 data.json 中 bug 消失');
      assert(!!fC && !fs.existsSync(path.join(UPLOADS_DIR, fC)) && !!fD && !fs.existsSync(path.join(UPLOADS_DIR, fD)),
        `WS delete 后 C、D 文件均被服务端清理（${fC || '?'}, ${fD || '?'} 应已删除）`);
    }

    // ===== 阶段 7：update field='image' → 白名单收敛被拒：data 不变、无广播 =====
    console.log('\n[阶段7] update field=image 被拒（白名单收敛）:');
    const BUG2 = 'bug-img-reject';
    client.send({ type: 'add', clientId: 'client-main', data: { taskId: TASK_ID, bug: { id: BUG2, name: '白名单测试', status: '待修复' } } });
    await sleep(300);
    const before7 = countBroadcasts(listener);
    client.send({ type: 'update', clientId: 'client-main', data: { taskId: TASK_ID, bugId: BUG2, field: 'image', value: 'fake.png' } });
    await sleep(400);
    {
      const task = readData().tasks.find(t => t.id === TASK_ID);
      const bug2 = task && task.bugs.find(b => b.id === BUG2);
      // 被拒：未写入 image 字段，且 images 保持空数组（handleAdd 归一化保证）
      assert(bug2 && !('image' in bug2) && Array.isArray(bug2.images) && bug2.images.length === 0,
        'update field=image 被拒：未写入 image 字段且 images 保持空数组');
      assert(countBroadcasts(listener) === before7, 'update field=image 被拒：监听方未收到任何广播');
    }

    // ===== 阶段 8：上传到不存在于 data.json 的 bugId（未发 WS add）→ 服务端自动创建并广播完整 add =====
    console.log('\n[阶段8] 未知 bugId 上传 → 服务端自动创建 bug 并广播 add:');
    const BUG3 = 'bug-img-autocreate';
    const upE = await httpUpload(port, TASK_ID, BUG3, 'client-main', PNG_BUFFER, 'shot-e.png');
    const fE = upE.body && upE.body.filename;
    assert(upE.statusCode === 200 && upE.body && upE.body.success === true && fE, `未知 bugId 上传成功（status=${upE.statusCode}）`);
    await sleep(400);
    {
      const task = readData().tasks.find(t => t.id === TASK_ID);
      const created = task && task.bugs.find(b => b.id === BUG3);
      assert(created && created.id === BUG3 && Array.isArray(created.images) && created.images.length === 1 && created.images[0] === fE,
        'data.json 中自动创建了该 bug（id 匹配，images=[filename]）');
      const addBc = listener.messages.find(m => m.type === 'broadcast' && m.change && m.change.type === 'add' && m.change.bug && m.change.bug.id === BUG3);
      assert(!!addBc && Array.isArray(addBc.change.bug.images) && addBc.change.bug.images.includes(fE),
        '监听方收到 type=add 广播：change.bug.id 匹配且 images 含 filename');
    }
  } finally {
    await teardown(httpServer, client, listener);
  }

  const { passed, failed } = getCounts();
  console.log(`\n=== 图片文件生命周期测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(onFatal);
