/**
 * 备注多图集成测试（任务级备注 + 条目级备注，note.image → note.images[] 多图语义）
 *
 * 覆盖目标行为（服务端是图片文件生命周期的唯一所有者，且"先改数据、后删文件"）：
 *  0. 迁移冒烟：预置旧格式 note.image 字符串数据启动 → images 数组化 + data.json.backup-note-* 备份
 *     0a 仅含条目级(b.notes)旧图 → 备份由条目级迁移分支触发生成（修复前该分支无备份逻辑）；
 *     0b 任务级旧图（同进程第二次迁移）→ 幂等数组化且不再重复备份（一次性语义）；
 *     B 的 fullSync 即收到迁移后数据
 *  1. 两张图暂存（同一 X-Note-Id，note 未创建）→ addNote(images:[f1,f2]) → note.images=[f1,f2]、
 *     uploads/ 两文件、监听方 B 收到含 images 数组的 addNote 广播
 *  2. 第三张直接关联已有备注（X-Note-Id 命中已建 note）→ images 追加（不替换）、B 收到 updateNote(images 快照) 广播
 *  3. 作者 A 发 updateNote removeImage=f1 → images=[f2,f3]、f1 文件被服务端清理、B 收到快照广播
 *  4. 越权防护：B 对 A 的备注发 updateNote removeImage 被拒（images 不变、无广播、文件保留）
 *  5. 作者 A deleteNote → 备注消失、剩余图片文件全部清理、B 收到 deleteNote 广播
 *  6. 条目级镜像关键路径：addBugNote(images) / 直接关联追加 / updateBugNote removeImage / deleteBugNote 清理
 *  7. （迁移冒烟见阶段 0）
 *  8. DELETE /api/upload/:filename 反查备注图：引用被事务性移除（splice）+ 广播 updateNote/updateBugNote 快照 + 文件清理
 *
 * 运行方式：node test-note-image.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据。
 */
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { startServer } = require('../server');
const {
  DATA_ROOT, UPLOADS_DIR, assert, sleep, readData, listUploads,
  connectWS, httpUpload, httpDeleteUpload, PNG_BUFFER, teardown, getCounts, onFatal,
} = H;

// assert/sleep/readData/listUploads/connectWS/httpUpload/httpDeleteUpload/PNG_BUFFER 见 helpers

function isBroadcastType(msg, type) {
  return !!msg && msg.type === 'broadcast' && !!msg.change && msg.change.type === type;
}

/** 统计某客户端收到的、noteId 匹配且 images 数组等于 images 的 updateNote 广播数 */
function countUpdateNoteImages(client, noteId, images) {
  return client.messages.filter((m) =>
    isBroadcastType(m, 'updateNote') && m.change.noteId === noteId &&
    JSON.stringify(m.change.images) === JSON.stringify(images)
  ).length;
}

async function runTests() {
  console.log('\n=== 备注多图集成测试 ===\n');

  // ===== 阶段 0 前置：预置旧格式数据（启动后触发迁移） =====
  // 注意：必须写在 startServer 之前（readData 在 WS 连接时执行 migrateData）
  // 场景 1：仅条目级备注含旧格式 note.image 字符串（任务级 notes 为空）
  // → 备份必须由条目级(b.notes)迁移分支触发（修复前该分支无备份逻辑，不会生成 backup-note）
  const OLD_TASK_NOTE = 'old-task-note.png';
  const OLD_BUG_NOTE = 'old-bug-note.png';
  fs.writeFileSync(path.join(DATA_ROOT, 'data.json'), JSON.stringify({
    tasks: [{
      id: 'task-mig',
      name: '迁移任务',
      notes: [], // 场景 1 无任务级旧图：证明备份由条目级分支触发
      bugs: [{
        id: 'bug-mig-1', name: '', status: '待修复', images: [],
        notes: [{ id: 'bnote-mig-1', clientId: 'client-x', content: '旧条目备注', updatedAt: 123, image: OLD_BUG_NOTE }],
      }],
    }],
    version: 0,
  }, null, 2), 'utf-8');

  let httpServer = null;
  let clientA = null;
  let clientB = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${DATA_ROOT}`);

    clientA = await connectWS(port, 'client-A');
    clientB = await connectWS(port, 'client-B');
    await sleep(400); // 等待 fullSync / clientCount

    const TASK_ID = 'task-note-img';
    const BUG_ID = 'bug-note-img-001';

    // ===== 阶段 0a：迁移冒烟 — 仅条目级旧数据 → 条目级分支触发备份 =====
    console.log('\n[阶段0a] 迁移冒烟（仅含条目级旧图）：b.notes 分支触发 backup-note 备份:');
    // 触发一次 updateData 使迁移结果落盘（迁移本身只改内存，写盘由 updateData 负责）
    clientA.send({ type: 'createTask', clientId: 'client-a', data: { task: { id: TASK_ID, name: '备注多图任务' } } });
    await sleep(400);

    {
      const migTask = readData().tasks.find(t => t.id === 'task-mig');
      const migBug = migTask && migTask.bugs.find(b => b.id === 'bug-mig-1');
      const migBNote = migBug && migBug.notes.find(n => n.id === 'bnote-mig-1');
      assert(!!migBNote && Array.isArray(migBNote.images) && migBNote.images.length === 1 && migBNote.images[0] === OLD_BUG_NOTE,
        '迁移后 data.json 中条目级备注 note.image → note.images=[old-bug-note.png]');
      assert(!!migBNote && !('image' in migBNote), '迁移后条目级备注不再残留 image 字段');
      assert(fs.readdirSync(DATA_ROOT).some(f => f.startsWith('data.json.backup-note-')),
        '仅含条目级旧图数据启动：backup-note 备份由条目级(b.notes)迁移分支触发生成');
      const bSync = clientB.messages.find(m => m.type === 'fullSync');
      const bTask = bSync && bSync.data && bSync.data.tasks.find(t => t.id === 'task-mig');
      const bBug = bTask && bTask.bugs.find(b => b.id === 'bug-mig-1');
      const bBNote = bBug && bBug.notes.find(n => n.id === 'bnote-mig-1');
      assert(!!bBNote && Array.isArray(bBNote.images) && bBNote.images.length === 1 && bBNote.images[0] === OLD_BUG_NOTE,
        '监听方 B 收到的 fullSync 中条目级备注已为 images 数组（迁移后内存态）');
    }

    // ===== 阶段 0b：迁移冒烟 — 任务级旧数据（同进程第二次迁移，幂等且不再二次备份） =====
    console.log('\n[阶段0b] 迁移冒烟（任务级旧图）：images 数组化 + 不重复备份:');
    // 覆写 data.json 为仅含任务级旧图格式（不含 TASK_ID，保证 createTask 可落盘迁移结果）
    fs.writeFileSync(path.join(DATA_ROOT, 'data.json'), JSON.stringify({
      tasks: [{
        id: 'task-mig',
        name: '迁移任务',
        notes: [{ id: 'note-mig-1', clientId: 'client-x', content: '旧任务备注', updatedAt: 123, image: OLD_TASK_NOTE }],
        bugs: [],
      }],
      version: 0,
    }, null, 2), 'utf-8');
    const backupsBefore = fs.readdirSync(DATA_ROOT).filter(f => f.startsWith('data.json.backup-note-')).length;
    clientA.send({ type: 'createTask', clientId: 'client-a', data: { task: { id: TASK_ID, name: '备注多图任务' } } });
    await sleep(400);
    {
      const migTask = readData().tasks.find(t => t.id === 'task-mig');
      const migNote = migTask && migTask.notes.find(n => n.id === 'note-mig-1');
      assert(!!migNote && Array.isArray(migNote.images) && migNote.images.length === 1 && migNote.images[0] === OLD_TASK_NOTE,
        '第二次迁移（任务级旧图）后 data.json 中任务级备注 note.image → note.images=[old-task-note.png]');
      assert(!!migNote && !('image' in migNote), '第二次迁移后任务级备注不再残留 image 字段');
      assert(fs.readdirSync(DATA_ROOT).filter(f => f.startsWith('data.json.backup-note-')).length === backupsBefore,
        '同进程第二次迁移不再重复备份（backup-note 仍为 1 份，一次性语义）');
    }

    // ===== 阶段 1：建 bug（主流程准备） =====
    console.log('\n[阶段1] 建 bug:');
    clientA.send({ type: 'add', clientId: 'client-a', data: { taskId: TASK_ID, bug: { id: BUG_ID, name: '备注多图Bug', status: '待修复' } } });
    await sleep(300);
    {
      const bug = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
      assert(!!bug && Array.isArray(bug.images) && bug.images.length === 0, '新建 bug 默认 images 为空数组');
    }

    // ===== 阶段 2：① 两张图暂存（同 noteId，note 未创建）→ addNote(images:[f1,f2]) =====
    console.log('\n[阶段2] 任务级备注：两张图暂存（同 X-Note-Id）→ addNote(images:[f1,f2]):');
    const up1 = await httpUpload(port, { 'X-Note-Id': 'note-1', 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'a.png');
    const f1 = up1.body && up1.body.filename;
    assert(up1.statusCode === 200 && up1.body && up1.body.success === true && !!f1, `第 1 张暂存上传返回 200（status=${up1.statusCode}）`);
    assert(!!f1 && listUploads().includes(f1), `第 1 张文件被暂存保留在 uploads/（${f1 || '无'}）`);
    const up2 = await httpUpload(port, { 'X-Note-Id': 'note-1', 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'b.png');
    const f2 = up2.body && up2.body.filename;
    assert(up2.statusCode === 200 && up2.body && up2.body.success === true && !!f2, `第 2 张暂存上传返回 200（status=${up2.statusCode}）`);
    assert(!!f2 && listUploads().includes(f2), `第 2 张文件被暂存保留在 uploads/（${f2 || '无'}）`);
    await sleep(300);

    clientA.send({
      type: 'addNote',
      clientId: 'client-a',
      data: { taskId: TASK_ID, note: { id: 'note-1', clientId: 'client-a', content: 'A的任务备注', updatedAt: Date.now(), images: [f1, f2] } },
    });
    await sleep(500);

    {
      const note1 = readData().tasks.find(t => t.id === TASK_ID).notes.find(n => n.id === 'note-1');
      assert(!!note1 && Array.isArray(note1.images) && note1.images.length === 2 && note1.images[0] === f1 && note1.images[1] === f2,
        'addNote(images:[f1,f2]) 后 data.json 中 note.images=[f1,f2]');
      assert(clientB.messages.some((m) => isBroadcastType(m, 'addNote') && m.change.note && m.change.note.id === 'note-1' &&
        Array.isArray(m.change.note.images) && m.change.note.images.length === 2 && m.change.note.images[0] === f1 && m.change.note.images[1] === f2),
        '监听方 B 收到含 images 数组的 addNote 广播（[f1,f2]）');
    }

    // ===== 阶段 3：② 第三张直接关联已有备注 → 追加（不替换）+ 快照广播 =====
    console.log('\n[阶段3] 任务级备注：第三张直接关联已有备注（追加）:');
    const up3 = await httpUpload(port, { 'X-Note-Id': 'note-1', 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'c.png');
    const f3 = up3.body && up3.body.filename;
    assert(up3.statusCode === 200 && up3.body && up3.body.success === true && !!f3, `第三张上传成功（status=${up3.statusCode}）`);
    await sleep(500);

    {
      const note3 = readData().tasks.find(t => t.id === TASK_ID).notes.find(n => n.id === 'note-1');
      assert(!!note3 && Array.isArray(note3.images) && note3.images.length === 3 && note3.images[2] === f3,
        '直接关联后 data.json 中 note.images=[f1,f2,f3]（追加而非替换）');
      assert(clientB.messages.some((m) => isBroadcastType(m, 'updateNote') && m.change.noteId === 'note-1' &&
        Array.isArray(m.change.images) && m.change.images.length === 3 && m.change.images[2] === f3),
        '监听方 B 收到 updateNote(images 快照=[f1,f2,f3]) 广播');
    }

    // ===== 阶段 4：③ 作者 A 发 updateNote removeImage=f1 → 移除 + 文件清理 + 快照广播 =====
    console.log('\n[阶段4] 任务级备注：作者 A removeImage=f1:');
    clientA.send({ type: 'updateNote', clientId: 'client-a', data: { taskId: TASK_ID, noteId: 'note-1', removeImage: f1 } });
    await sleep(500);

    {
      const note4 = readData().tasks.find(t => t.id === TASK_ID).notes.find(n => n.id === 'note-1');
      assert(!!note4 && Array.isArray(note4.images) && note4.images.length === 2 && note4.images[0] === f2 && note4.images[1] === f3,
        'removeImage=f1 后 data.json 中 note.images=[f2,f3]');
      assert(f1 && !fs.existsSync(path.join(UPLOADS_DIR, f1)), `removeImage 后 f1 文件被服务端清理（${f1} 应已删除）`);
      assert(countUpdateNoteImages(clientB, 'note-1', [f2, f3]) >= 1, '监听方 B 收到 updateNote(images=[f2,f3]) 快照广播');
    }

    // ===== 阶段 5：④ 越权防护：B 对 A 的备注 removeImage 被拒 =====
    console.log('\n[阶段5] 任务级备注：B 越权 removeImage 被拒:');
    const bcBefore = clientB.messages.filter((m) => isBroadcastType(m, 'updateNote') && m.change.noteId === 'note-1').length;
    clientB.send({ type: 'updateNote', clientId: 'client-b', data: { taskId: TASK_ID, noteId: 'note-1', removeImage: f3 } });
    await sleep(500);

    {
      const note5 = readData().tasks.find(t => t.id === TASK_ID).notes.find(n => n.id === 'note-1');
      assert(!!note5 && Array.isArray(note5.images) && note5.images.length === 2 && note5.images[0] === f2 && note5.images[1] === f3,
        'B 越权 removeImage=f3 被拒（note.images 仍为 [f2,f3]，不变）');
      assert(f3 && fs.existsSync(path.join(UPLOADS_DIR, f3)), 'B 越权删图被拒后 f3 文件仍在 uploads/');
      assert(clientB.messages.filter((m) => isBroadcastType(m, 'updateNote') && m.change.noteId === 'note-1').length === bcBefore,
        'B 越权删图被拒后未收到任何新的 updateNote 广播（无广播）');
    }

    // ===== 阶段 5b：契约 GAP1 — 同作者 removeImage 不存在的文件名（no-op）无副作用 =====
    console.log('\n[阶段5b] 契约：作者 A removeImage 不存在的文件名（no-op）→ 无广播、版本不变:');
    const verBefore = readData().version;
    const bcNoopBefore = clientB.messages.filter((m) => isBroadcastType(m, 'updateNote') && m.change.noteId === 'note-1').length;
    clientA.send({ type: 'updateNote', clientId: 'client-a', data: { taskId: TASK_ID, noteId: 'note-1', removeImage: '不存在.png' } });
    await sleep(500);
    {
      const note5b = readData().tasks.find(t => t.id === TASK_ID).notes.find(n => n.id === 'note-1');
      assert(readData().version === verBefore, 'no-op removeImage 后 data.json 版本不变（无写盘、无版本递增）');
      assert(clientB.messages.filter((m) => isBroadcastType(m, 'updateNote') && m.change.noteId === 'note-1').length === bcNoopBefore,
        'no-op removeImage 后 B 未收到任何新的 updateNote 广播');
      assert(!!note5b && Array.isArray(note5b.images) && note5b.images.length === 2 && note5b.images[0] === f2 && note5b.images[1] === f3,
        'no-op removeImage 后 note.images 仍为 [f2,f3]（不变）');
    }

    // ===== 阶段 5c：契约 GAP2 — content-only 编辑广播 change.images 完整快照 =====
    console.log('\n[阶段5c] 契约：content-only 编辑 → 广播 change.images 完整快照 + 新 content:');
    const NEW_CONTENT = 'A编辑后的任务备注';
    clientA.send({ type: 'updateNote', clientId: 'client-a', data: { taskId: TASK_ID, noteId: 'note-1', content: NEW_CONTENT, updatedAt: Date.now() } });
    await sleep(500);
    {
      const note5c = readData().tasks.find(t => t.id === TASK_ID).notes.find(n => n.id === 'note-1');
      assert(!!note5c && note5c.content === NEW_CONTENT && Array.isArray(note5c.images) && note5c.images.length === 2 && note5c.images[0] === f2 && note5c.images[1] === f3,
        'content-only 编辑后 data.json 中 content 已更新且 images 仍为 [f2,f3]');
      const snapBc = clientB.messages.find((m) => isBroadcastType(m, 'updateNote') && m.change.noteId === 'note-1' &&
        m.change.content === NEW_CONTENT && Array.isArray(m.change.images) && m.change.images.length === 2 && m.change.images[0] === f2 && m.change.images[1] === f3);
      assert(!!snapBc, 'B 收到 content-only updateNote 广播：change.images=[f2,f3] 完整快照且 change.content=新值');
    }

    // ===== 阶段 6：⑤ 作者 A deleteNote → 剩余图片文件全部清理 =====
    console.log('\n[阶段6] 任务级备注：作者 A 删除整条备注（剩余图片清理）:');
    clientA.send({ type: 'deleteNote', clientId: 'client-a', data: { taskId: TASK_ID, noteId: 'note-1' } });
    await sleep(500);

    {
      const task6 = readData().tasks.find(t => t.id === TASK_ID);
      assert(!(task6.notes || []).some(n => n.id === 'note-1'), 'deleteNote 后 data.json 中备注消失');
      assert(f2 && !fs.existsSync(path.join(UPLOADS_DIR, f2)) && f3 && !fs.existsSync(path.join(UPLOADS_DIR, f3)),
        `deleteNote 后剩余图片文件 f2、f3 均被服务端清理`);
      assert(clientB.messages.some((m) => isBroadcastType(m, 'deleteNote') && m.change.noteId === 'note-1'),
        '监听方 B 收到 deleteNote 广播');
    }

    // ===== 阶段 7：⑥ 条目级镜像关键路径 =====
    console.log('\n[阶段7] 条目级备注镜像：addBugNote(images) / 直接关联追加 / removeImage / deleteBugNote:');
    const up6 = await httpUpload(port, { 'X-Bug-Note-Id': 'bnote-1', 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'g1.png');
    const g1 = up6.body && up6.body.filename;
    assert(up6.statusCode === 200 && up6.body && up6.body.success === true && !!g1, `条目备注第 1 张暂存上传返回 200（status=${up6.statusCode}）`);
    await sleep(300);
    clientA.send({
      type: 'addBugNote',
      clientId: 'client-a',
      data: { taskId: TASK_ID, bugId: BUG_ID, note: { id: 'bnote-1', clientId: 'client-a', content: 'A的Bug备注', updatedAt: Date.now(), images: [g1] } },
    });
    await sleep(500);
    {
      const bnote1 = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID).notes.find(n => n.id === 'bnote-1');
      assert(!!bnote1 && Array.isArray(bnote1.images) && bnote1.images.length === 1 && bnote1.images[0] === g1,
        'addBugNote(images:[g1]) 后 data.json 中 bugNote.images=[g1]');
      assert(clientB.messages.some((m) => isBroadcastType(m, 'addBugNote') && m.change.note && m.change.note.id === 'bnote-1' &&
        Array.isArray(m.change.note.images) && m.change.note.images.length === 1 && m.change.note.images[0] === g1),
        '监听方 B 收到含 images 数组的 addBugNote 广播（[g1]）');
    }

    const up7 = await httpUpload(port, { 'X-Bug-Note-Id': 'bnote-1', 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'g2.png');
    const g2 = up7.body && up7.body.filename;
    assert(up7.statusCode === 200 && up7.body && up7.body.success === true && !!g2, `条目备注第 2 张直接关联上传成功（status=${up7.statusCode}）`);
    await sleep(500);
    {
      const bnote1b = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID).notes.find(n => n.id === 'bnote-1');
      assert(!!bnote1b && Array.isArray(bnote1b.images) && bnote1b.images.length === 2 && bnote1b.images[1] === g2,
        '直接关联后 data.json 中 bugNote.images=[g1,g2]（追加）');
      assert(clientB.messages.some((m) => isBroadcastType(m, 'updateBugNote') && m.change.noteId === 'bnote-1' &&
        Array.isArray(m.change.images) && m.change.images.length === 2 && m.change.images[1] === g2),
        '监听方 B 收到 updateBugNote(images=[g1,g2]) 快照广播');
    }

    clientA.send({ type: 'updateBugNote', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, noteId: 'bnote-1', removeImage: g1 } });
    await sleep(500);
    {
      const bnote1c = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID).notes.find(n => n.id === 'bnote-1');
      assert(!!bnote1c && Array.isArray(bnote1c.images) && bnote1c.images.length === 1 && bnote1c.images[0] === g2,
        'updateBugNote removeImage=g1 后 bugNote.images=[g2]');
      assert(g1 && !fs.existsSync(path.join(UPLOADS_DIR, g1)), 'removeImage 后 g1 文件被服务端清理');
      assert(clientB.messages.some((m) => isBroadcastType(m, 'updateBugNote') && m.change.noteId === 'bnote-1' &&
        Array.isArray(m.change.images) && m.change.images.length === 1 && m.change.images[0] === g2),
        '监听方 B 收到 updateBugNote(images=[g2]) 快照广播');
    }

    clientA.send({ type: 'deleteBugNote', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, noteId: 'bnote-1' } });
    await sleep(500);
    {
      const bug6 = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
      assert(!(bug6.notes || []).some(n => n.id === 'bnote-1'), 'deleteBugNote 后 data.json 中 bugNote 消失');
      assert(g2 && !fs.existsSync(path.join(UPLOADS_DIR, g2)), 'deleteBugNote 后 g2 文件被服务端清理');
      assert(clientB.messages.some((m) => isBroadcastType(m, 'deleteBugNote') && m.change.noteId === 'bnote-1'),
        '监听方 B 收到 deleteBugNote 广播');
    }

    // ===== 阶段 8：⑧ DELETE 端点反查备注图（任务级 + 条目级） =====
    console.log('\n[阶段8] DELETE /api/upload 反查备注图引用:');
    // 任务级：note-2 关联 h1 → 再传 h2 → DELETE h1
    const up8a = await httpUpload(port, { 'X-Note-Id': 'note-2', 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'h1.png');
    const h1 = up8a.body && up8a.body.filename;
    await sleep(300);
    clientA.send({
      type: 'addNote',
      clientId: 'client-a',
      data: { taskId: TASK_ID, note: { id: 'note-2', clientId: 'client-a', content: '待DELETE备注', updatedAt: Date.now(), images: [h1] } },
    });
    await sleep(400);
    const up8b = await httpUpload(port, { 'X-Note-Id': 'note-2', 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'h2.png');
    const h2 = up8b.body && up8b.body.filename;
    await sleep(400);
    const del8 = await httpDeleteUpload(port, h1);
    assert(del8.statusCode === 200 && del8.body && del8.body.success === true, `DELETE /api/upload/h1 返回 success:true（status=${del8.statusCode}）`);
    await sleep(400);
    {
      const note8 = readData().tasks.find(t => t.id === TASK_ID).notes.find(n => n.id === 'note-2');
      assert(!!note8 && Array.isArray(note8.images) && note8.images.length === 1 && note8.images[0] === h2,
        'DELETE 反查后 data.json 中 note-2.images=[h2]（h1 引用被事务性移除）');
      assert(h1 && !fs.existsSync(path.join(UPLOADS_DIR, h1)), `DELETE 后 h1 文件已从 uploads/ 删除`);
      const delBc = clientB.messages.find(m => isBroadcastType(m, 'updateNote') && m.change.noteId === 'note-2' &&
        m.originClientId === '__delete_upload__' && Array.isArray(m.change.images) && m.change.images.length === 1 && m.change.images[0] === h2);
      assert(!!delBc, '监听方 B 收到 DELETE 触发的 updateNote(images=[h2]) 快照广播（originClientId=__delete_upload__）');
    }
    // 条目级：bnote-2 关联 g3 → 再传 g4 → DELETE g3
    const up8c = await httpUpload(port, { 'X-Bug-Note-Id': 'bnote-2', 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'g3.png');
    const g3 = up8c.body && up8c.body.filename;
    await sleep(300);
    clientA.send({
      type: 'addBugNote',
      clientId: 'client-a',
      data: { taskId: TASK_ID, bugId: BUG_ID, note: { id: 'bnote-2', clientId: 'client-a', content: '待DELETE条目备注', updatedAt: Date.now(), images: [g3] } },
    });
    await sleep(400);
    const up8d = await httpUpload(port, { 'X-Bug-Note-Id': 'bnote-2', 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'g4.png');
    const g4 = up8d.body && up8d.body.filename;
    await sleep(400);
    await httpDeleteUpload(port, g3);
    await sleep(400);
    {
      const bnote8 = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID).notes.find(n => n.id === 'bnote-2');
      assert(!!bnote8 && Array.isArray(bnote8.images) && bnote8.images.length === 1 && bnote8.images[0] === g4,
        'DELETE 反查后 data.json 中 bnote-2.images=[g4]（g3 引用被事务性移除）');
      assert(clientB.messages.some(m => isBroadcastType(m, 'updateBugNote') && m.change.noteId === 'bnote-2' &&
        m.originClientId === '__delete_upload__' && Array.isArray(m.change.images) && m.change.images.length === 1 && m.change.images[0] === g4),
        '监听方 B 收到 DELETE 触发的 updateBugNote(images=[g4]) 快照广播');
    }

    // ===== 阶段 9：最终清理（删光剩余备注 → uploads/ 无残留） =====
    console.log('\n[阶段9] 最终清理：删除剩余备注，uploads/ 无残留:');
    clientA.send({ type: 'deleteNote', clientId: 'client-a', data: { taskId: TASK_ID, noteId: 'note-2' } });
    await sleep(400);
    clientA.send({ type: 'deleteBugNote', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, noteId: 'bnote-2' } });
    await sleep(500);
    {
      const task9 = readData().tasks.find(t => t.id === TASK_ID);
      const bug9 = task9 && task9.bugs.find(b => b.id === BUG_ID);
      assert(h2 && !fs.existsSync(path.join(UPLOADS_DIR, h2)) && g4 && !fs.existsSync(path.join(UPLOADS_DIR, g4)),
        '删除剩余备注后 h2、g4 文件均被清理');
      assert(listUploads().length === 0, '最终 uploads/ 为空（无任何残留图片文件）');
    }
  } finally {
    await teardown(httpServer, clientA, clientB);
  }

  const { passed, failed } = getCounts();
  console.log(`\n=== 备注多图集成测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(onFatal);
