# 归档文档（Stale Archive）

> ⚠️ 本目录下的文档**已过时**，仅供历史参考，**不要**按其中描述操作（端口、数据目录、行数、功能均与当前代码不符）。
> 当前权威入口：项目根 **`README.md`**。

| 文件 | 原位置 | 归档日期 | 过时原因 |
|---|---|---|---|
| `HANDOFF.md` | 根目录 | 2026-07-18 | 7/7 旧版：单任务、Bug清单 名、数据目录方案已变更（详见 README「知识索引」的过时点清单） |
| `project-summary.md` | `reports/` | 2026-07-18 | 7/7 旧版：server.js 597 行时代的功能/行号快照，多任务/备注/备份等新功能未收录 |
| `plan.md` | 根目录 | 2026-07-18 | 7/2 立项计划：端口 3000 系、阶段划分与文件结构均已过时 |

`reports/` 下其余文档（req1~req5、fix-*、agent-*、integration-test、ux-improvement-plan）为历史开发/修复记录，保留在原处。

### `old-tests/`

2026-08-14 归档的 5 个旧测试脚本（test-edge-cases.js、test-fix-verification.js、test-loop-guard.js、test-persistence.js、test-ws.js）：针对过时的单任务协议编写（消息无 taskId、数据在顶层 bugs 数组），与当前多任务协议不符，无法运行。后期如需按新协议重写时再取出参考。

当前有效的测试在项目根目录：`test-image-lifecycle.js`、`test-note-ownership.js`。
