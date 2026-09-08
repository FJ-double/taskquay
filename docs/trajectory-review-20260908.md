# 2026-09-08 轨迹复盘

本阶段仅修复 `work_task finish` 的 run 归属判断和命令进度分类。使用本地 fixture 回放，不调用付费模型，不增加调度框架、provider 控制接口或数据库迁移。

## 证据范围

开始时 HEAD 为 `689d935`，工作区 clean。已核验三个版本化输入的 SHA-256：

| 输入 | SHA-256 |
| --- | --- |
| `src/tool-surfaces/work-task.ts` | `01002720244d10b08cadb69e6a9337d7fb8465cc06403397d168fcc6416f0ae6` |
| `src/execution-coordinator.ts` | `4c67e41eaa8dbb1722c667d379257c479305138326c5e9f6a53f1e9bd9273cc5` |
| `src/agent-progress.ts` | `1f19859465e49d8c010cc51c6122a4f9703ff6eee790e4112415fa972d9a0fa4` |

只读元数据位于 `releases/trajectory-audit-20260908/releases/trajectory-audit-20260907/parent-conversation-metadata.json`，SHA-256 为 `a59b3d003556c28b31ac87ca382a24ce4ae0ba8de941e16b1980df6db2315754`。其精确 parent conversation hash 为 `b79689c572653e7db755f6f6`：17 runs、362 operations、11 executions（7 completed、4 failed）。采集时间为 `2026-09-08T02:08:22.346Z`。

元数据给出的 `knownManagedDeltaTokens` 为 **85,590,157**，完整性为 partial，3 个 execution 用量不可得。这里只引用该汇总，不把同一 execution 的 delta 累计快照相加，不重复加 cache/reasoning 子项；85M 不是账号消耗、订阅余额或账单，也不包含 host tokens。未落 ledger 的 observe/discovery 不在操作计数内，重叠 duration 不能相加当 wall time。没有证据支持整体节省百分比。本次未读取或输出原始 prompts、thoughts、responses、secrets。

## 分层归因

- **Host 工作组织**：过大的任务边界、漏取或漏交回执属于主控的任务切分与收尾问题。已有 snapshot/history、usage-only 稳定 revision、terminal 重取和报错回执已改善可观察性，应继续利用，不能描述成缺失功能。本阶段没有重复实现它们。
- **目标项目**：磁盘问题与 ART/R8 缺陷属于目标项目的构建、运行环境和产物验证边界，不能归成 DevSpace provider 或模型失败。本阶段未重新验证这些缺陷的根因。
- **DevSpace A**：主控提供的 trace 显示 `run_a7feffbb98634955b15cdf12daf2ae35` 自身 children 已结束，却被另一活跃 run 的 agent claim 挡住 finish；对方结束后原 finish 立即成功。源码证实工具层按整个重叠 checkout 的 `inspect().length` 阻挡，ledger 事务中也有同 checkout 的粗粒度 claim 检查。
- **DevSpace B**：源码按整个 command 的 `test/build` 单词分类，普通 adb 命令中的 `artifacts/test-checkin...` 因而被标为 test。分类不能说明测试已执行成功，也不能据此断言整个约 40 分钟阶段都在测试。

按主控提供的验收记录：Test 云于 08:53:57+08 完成；0801 深层验证失败后撤回，0802 签名完整、真实登录/三步/系统 Chrome 通过，10:04:24 正式发布，10:05 公网 hash/range 与 old/new 策略复核通过。上述产品验收未在本阶段重复执行；元数据摘要本身不能独立证明这些设备与公网结果。

## 两处修复

finish 的判定集中在 ledger 原有 immediate 收尾事务内。仍检查本 run 的活跃 operations/executions；对重叠 checkout 的 claims 和未过期 waiters，只在 `latestExecution(agentId)` 活跃、所属另一 run 活跃、project 与 claim checkout 身份一致时排除 foreign agent。活跃 claim 的获取时间还必须不早于 execution 创建时间。命令、未知/孤儿、同 run、身份不符继续 fail closed。

`endExecution` 与 `release` 之间的短窗口仍拒绝收尾：completed 旧记录不能证明当前 claim 的 foreign 归属。原有收尾事务与源码读写排他保留；不删除、不偷取或转移 claim。阻挡响应保留 `WORK_STATE`，增加固定枚举 `blocking` 和有界的 `nextAction`，引导观察子任务、等待终态、请持有者核对释放后重试，不返回跨 workspace 路径、agent 身份、资源名或私人 prompt。finish 无 provider 调用路径。

进度只识别命令开头的已知可执行文件及其直接参数位置。常见 go test、npm test、pytest、gradle assemble、tsc 等保留分类；普通命令里的路径或 echo 文本不参与判断。未知命令、复杂 shell 包装/复合语法或不认识的选项退回 `command`。输出仍只有原有固定枚举，不保存原始 command/args，也没有增加字符串解析框架。

## Fixture 结果与实际启用边界

| 可测项目 | 旧规则回放 | 修复后 |
| --- | --- | --- |
| A 已结束、B 持有 claim 且有 waiter；共享/嵌套 checkout 两例 | `inspect().length = 2`，两例均会阻挡 | 两例均可 finish，B claim/waiter 不变，读写仍被锁拒绝 |
| 自身活跃、未知 command/agent/waiter、同 run、终态未释放、旧记录、身份不符等 | 保守阻挡 | 13 个拒绝 fixture 全部保留；终态 claim 释放后可 finish |
| 26 条命令 fixture | 原全串正则误分类 12 条 | 误分类 0 条，14 条已知构建/测试分类正确 |

定向测试命令：

```powershell
pnpm exec tsx --test --test-concurrency=1 src/work-task-tool.test.ts src/agent-progress.test.ts src/work-ledger.test.ts src/execution-coordinator.test.ts src/work-run-views.test.ts
pnpm typecheck
pnpm exec tsc -p tsconfig.build.json --outDir <独立临时目录>
```

最终 **67 tests：67 passed、0 failed、0 skipped**（进度 29、coordinator 8、ledger 9、work_task 16、snapshot/history 5）。其中真实内存 MCP transport 验证 finish 响应、作用域拒绝与回执；已有持久化脱敏、跨进程排他和 snapshot/history 回归通过。首次新增 fixture 漏建 agent 记录导致 9 个外键错误，补齐 fixture 后通过，未放宽生产约束。

typecheck 和隔离 TypeScript 编译通过，产物位于 `D:\CodexTemp\devspace-trajectory-20260908-6afdcd880f1d4454831b7762c79212aa`。只验证本地源码/fixture 和该编译产物的生成，未重新构建 UI、打包发布或在真实远端 MCP host 热启用。没有运行 `pnpm build`、清理 live dist、升级 npx，或修改/重启 server、agentd、tunnel 进程。当前运行服务仍不保证包含本次修复；由主控决定安全启用时机。

## 主控复核与已启用状态

上段是 worker 交回时的阶段事实。主控随后直接检查 `1d1ec2ac183359bd49e09fca79f5dbad500b0835` 的变更，并重新运行同一五文件定向测试：**67/67，0失败、0跳过，10,330.7671ms**。源码 typecheck 通过。从该提交 Git archive 导出的独立目录 `releases/trajectory-1d1ec2a-runtime/` 完成 TypeScript 与 Vite 构建，编译后内存 MCP smoke 通过，providerInvocations=0；没有把未提交源码混入产物或清理正在服务的 dist。

第一次维护在“daemon 未被确认空闲”处保守退出，未替换监听服务。随后实际 `daemon status` 返回 `DAEMON_UNAVAILABLE`，核对上一 PID23560已不存在，PID文件和ownership lock均不存在，且无活跃 agent/waiter/claim，才允许下一次维护继续。没有把“不可达”直接当作“已停止”，也没有清锁或杀其他进程。

**2026-09-08 10:28:41（UTC+8）新运行产物已启用**：精确核对原监听 PID5584的可执行文件、启动时间和 `D:\project\devspace\dist\cli.js serve` 入口后，仅替换空闲监听；新 PID为21492，端口仍为127.0.0.1:7676。原dist和一致SQLite备份保存在 `releases/activation-trajectory-20260908-022818/`，全部安装文件与独立候选哈希一致，healthz通过，没有回滚。没有更改隧道、根目录权限、OAuth配置或业务数据。回执为该目录的 `receipt.json`。

启用后主控通过本对话原生 MCP 成功读取维护回执、取回同一已完成agent的终态结果；使用实际安装的dist再次运行编译后MCP smoke通过，未发起新模型执行。修改的四个运行模块与已测试staging逐文件哈希一致。具体foreign-claim与命令分类行为以同生产handler/ledger的67项fixture为证，不把普通health请求冒称所有真实并发场景已跑过。

## 仍需区别对待的宿主契约问题

本轮另有一次可复现的宿主schema不一致：源码和实际服务器已有 `work_task snapshot/history`，但本对话工具目录仍只允许 `begin/record/finish/get/list`；一次 `snapshot` 在到达服务器前就被参数校验拒绝。主控没有反复discover、换标识绕过或重复实现服务端功能，改用已支持的 `get/finish`。该边界不能通过修改本地返回文字保证宿主刷新，本次不宣称已修复其缓存；原生终态回执及合法动作仍可用。证据记录为 `op_5bb95810983c4392be402b3b57f13e23`。

原02:08元数据快照的七个running/pending包含历史未结案轮次。主控随后以明确失败证据结清旧主任务 `run_6d83dbd1ca304104b5904ac8b41d432e` 和旧云任务 `run_a7b060c91d044ed6b2dd59f31a392e1c`，保留“当时部署被磁盘门禁拦住”的历史失败，未用今日成功改写旧结果。今日主交付run与云run均已有独立passed回执；这属于主控收尾改进，不是自动接受功能。

本阶段DevSpace受管模型总量为 **965,974 tokens，complete**，缓存输入是输入的子项，不再次相加。fixture/编译/维护和原生回验没有额外模型推理。整个跨轮轨迹的85,590,157只代表上述采集时刻的已知受管delta，仍为partial，不能当成完整账号消耗或账单。
