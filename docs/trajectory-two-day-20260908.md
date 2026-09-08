本轮已交付只读轨迹审计器、终端回执恢复、执行环境契约及 inherited-stdio 生命周期诊断。基线为 `8d87b40361e8c647445f4f8dd6c8d61413e38c07`，开始时工作树 clean，当前代码未提交。没有创建真实 work_task、子代理、PR 或 push；测试中的 begin/finish 仅作用于隔离 fixture 数据库。没有调用 show_changes，没有部署、替换 dist、重启服务、修改 tunnel/provider 配置或业务工程。

**审计结论与证据范围**

授权窗口固定为北京时间 2026-09-07 00:00 至 2026-09-08 16:49:17，UTC 半开区间 `[2026-09-06T16:00:00Z, 2026-09-08T08:49:17Z)`。`overlap` 选择开始早于 until、结束晚于 since 或尚无结束时间的 runs；`created` 选择窗口内创建的 runs。各自的 operations/executions 再使用同一时间规则，因此“读取元数据行数”不等于“最终入选行数”。时间带显式时区，非法时间/逆序区间计入 malformed，不将其当零时长。

采集以 better-sqlite3 `readonly:true,fileMustExist:true` 打开指定数据库，全部 ledger 查询在一个只读事务内完成，没有 WorkLedger 初始化或迁移。已先检查 `SAFE_PROJECTION`，再运行采集。仅投影 ID、状态、验收、时间、kind、origin 中 entryPoint/conversationHash、usage_quality 和 delta.totalTokens；不读取标题、summary、evidence、命令、prompt、thought、response、credential 或配置。输出 run/project ID 为 SHA-256 截短散列，精确父会话使用原有合法 conversation hash。每表读取上限 100,000 行，CLI JSON 上限 16 MiB，stdout 只含有限汇总和回执。

状态及验收是**采集时的当前值**，不是截止时刻的历史快照。overlap 读到 89 个 run 元数据、选中 72 个 runs，读取 1,200 个 operation 元数据后选中 1,087 个，读取 67 个 execution 元数据后选中 45 个。created 选中 51 个 runs、1,076 个 operations、42 个 executions。两种口径均无 malformed 或行数截断。overlap 多出的旧 run 不能当成两天内新发起的任务。

| overlap 分组：精确父会话 hash | runs | 当前 completed / failed / running | 验收 passed / failed / pending / N/A |
| --- | ---: | --- | --- |
| 9ed095631cfd49793c31019b | 24 | 15 / 0 / 9 | 7 / 7 / 9 / 1 |
| b79689c572653e7db755f6f6 | 17 | 9 / 5 / 3 | 8 / 4 / 3 / 2 |
| 274828b6ba1b732e3ead5237 | 1 | 0 / 0 / 1 | 0 / 0 / 1 / 0 |
| 697be5f03375f5d9753665d7 | 1 | 1 / 0 / 0 | 1 / 0 / 0 / 0 |
| 169818259a4b5017ba52c2e3 | 4 | 4 / 0 / 0 | 4 / 0 / 0 / 0 |
| 1105aed50a486d48060540e8 | 2 | 2 / 0 / 0 | 0 / 2 / 0 / 0 |
| 9faeb08e4c4741ec2126fe44 | 9 | 8 / 0 / 1 | 3 / 0 / 1 / 5 |
| unknown_origin，不能关联父会话 | 14 | 14 reconciliation_required | 0 / 0 / 14 / 0 |

本次没有选中明确标注 other_mcp 的 run；采集器仍将其单列为 `unassociated_other_mcp`，夹具验证不会按项目或时间把它连到父会话。unknown_origin 也未被冒充为 child。全体 72 runs 中，39 lifecycle completed、5 failed、14 running、14 reconciliation_required；验收分别为 passed 23、failed 13、pending 28、N/A 8。**这不是用户请求的端到端成功率**：run 与用户请求并非一一对应，pending/reconciliation 不等于失败，completed 也不等于交付通过。

| 已记录 operation kind | completed | failed |
| --- | ---: | ---: |
| command | 333 | 73 |
| read | 236 | 11 |
| workspace_context | 228 | 20 |
| apply_patch | 158 | 7 |
| verification | 4 | 0 |
| 不在固定 kind 白名单内的 unknown | 17 | 0 |

共 976 completed、111 failed；这些仅是入选 ledger operations，未落 ledger 的 discovery/observe、host 本地拒绝及其他调用覆盖未知。历史失败集中于 command，但不存在足以把 73 个失败逐一归因为 shell、provider 或模型的允许证据。不得把通用 failed 自动分类为额度耗尽、模型错误或用户任务失败。

每会话 JSON 提供仅已结束操作的 p50/p95/max/sum，以及裁剪到窗口的 interval union wall time；未结束操作另列采集时 elapsed。此次入选操作均已结束，但仍有 running runs，因此 run 活跃不能证明 children 正在执行。两个较大的父会话 `9ed…` 的 p50/p95/max 为 36 / 18,207 / 7,426,608 ms，sum 11,206,029 ms，union 11,011,805 ms；`b796…` 为 68 / 26,643 / 1,302,844 ms，sum 6,285,051 ms，union 6,240,309 ms。长时长本身不能证明 stdio 悬挂或模型低效，sum 不能当独立总墙钟时间。

overlap 已知 execution delta 共 109,445,315 tokens，45 executions 中 28 个缺失有效 delta。created 为 85,879,909 tokens、42 executions 中 26 个缺失。每 execution 只累计一次，不把 missing 当 0，不再次累加缓存/推理子项；不按窗口比例拆分跨窗 execution 用量。它们不是 host tokens、账号账单或实时额度，不支持“节省百分比”。与旧报告的不同时间/选择口径不作直接增减比较。

可选日志采集仅打开两个显式诊断文件；流式限制每文件 8 MiB、100,000 行、每行 64 KiB，超长/截断/无时区/未知事件均有固定计数。只输出固定 event/code 及时间，不输出任意日志字符串，也不尝试给 run 建立日志关联。现存日志在授权窗内最早为 `2026-09-08T02:12:45.230Z`，最晚为 `08:49:14.964Z`，不能覆盖 9 月 7 日及 9 月 8 日前段。窗口内两文件分别 465 与 2,771 行事件，无读取截断，合计 70 个 process_finished，其中 53 个 exit_zero、17 个 nonzero_or_unknown_exit；未知事件合计 1,099。没有足够的错误码解释这些非零退出，保留 unknown。日志已轮转，当前可用文件完整读取不等于历史日志完整。

**实际修复及边界**

基线复现脚本从 Git 读取 `8d87b40:src/process-sessions.ts`，在内存编译并运行隔离测试命令；基线 start 终态省略 sessionId 且立即删除 session，write 取得终态后再次空读也报 Unknown process session。没有调用运行中的 DevSpace。修复移除这两处立即删除，所有终态保留 sessionId，默认最多 64 个终态、close 后最多五分钟；满额淘汰最早完成者。保持已有 1,000,000 字符缓冲上限和单次最多约 400,000 字符响应预算，终态首次读取后冻结有界输出和退出信息，后续 EMPTY poll 不再 drain、spawn、结算 ledger 或释放 claim。

返回 `terminalReplay`、`outputScope=since_previous_read`、`outputTruncated`，重放时保留首次终态预算而忽略新预算。早先 running poll 已消费的文本仍不可恢复，终态回执不能被描述为完整命令历史；过期/淘汰/进程重启后也不可重取。终态非空输入和 resize 拒绝，workspace 归属检查在重放之前。输出只保留在已有内存缓冲/回执，不新增持久化正文或日志。

open_workspace 初始及复用响应、exec/write 响应共享 execution helper/type/schema，明确当前平台、实际选定 shell、pipe/PTY transport 和 PTY 能力。本机验证为 win32、cmd.exe、pipe；tty=true 明确为 pipe_fallback，删除原来的伪 resize 成功。没有新增用户输入字段或改成由模型选择 shell。目录不存在时只在授权且 host schema 暴露 createDirectory 时建议该字段；旧 host 使用授权的可用创建途径或由用户创建后再打开，未自动创建猜测路径、扩大 allowed roots 或改变审批规则。

指令只在 host 暴露时建议 snapshot/history，旧 schema 使用 get 和可用 observe；明确服务端不能强制 ChatGPT 刷新。此前已落地的 foreign-run finish/命令分类及 snapshot/history 未重复实现；旧文档的启用记录已阅读，但本轮未重新检验其线上状态。

管道进程在 Node `exit` 仅记录根进程退出时间；直到 `close` 才完成、结算并释放 claim。轮询暴露 `phase=root_exited_stdio_open` 和 `rootExitedElapsedMs`，不自动杀后代、改变 detach 策略或推断任务通过。提供有界 POSIX inherited-stdio fixture，子进程自然在 700 ms 后退出；当前 Windows 运行明确跳过，**没有验证 Windows 的真实 inherited-stdio 悬挂**，也没有把这个诊断当成历史失败归因。

**验证与首次问题**

首轮聚焦测试 40 项：39 passed、0 failed、1 skipped；添加流式日志隐私/边界夹具后的最终聚焦为 41 项：40 passed、0 failed、1 skipped。包含时区边界、ongoing/坏记录/重叠区间/缺失 usage、secret 不泄漏、只读 DB 前后字节相同，终态 start/write 重取、失败/取消、TTL/count 淘汰、跨 workspace 拒绝，以及真实 MCP handler 的契约和 ledger once-only 回归。

最终 `pnpm test`：82 个文件、277 项，271 passed、0 failed、6 skipped、0 cancelled，159,555.8793 ms。运行前后源码指纹均为 `e967a388a1cf91cef1c9d79ec2d787e194f42ab5b1255903aa3d612c699c3fb2`，测试结束后未修改 src。typecheck 和 `tsc -p tsconfig.build.json --outDir releases/trajectory-two-day-20260908/candidate` 均退出 0；候选 93 个 JS 文件，未运行 pnpm build 或 UI 构建。

真实 SDK Client 经 loopback StreamableHTTP 连接候选 MCP registration：tools/list → 初次/复用 open → fixture begin → tty 命令 → 终态 → 两次 EMPTY replay → exit 7 负例 → 错 workspace session/run 拒绝 → 旧 schema get → finish accepted receipt。验证恰好两个 command operations、零 console_executions，重放前后 revision 不变、claims 已释放。旧 schema 模拟实际拒绝 createDirectory 和 snapshot 参数，而非仅修改展示变量。fixture 关闭 client/server/HTTP、进程管理器及 DB 后移除自己的临时目录。

首次 smoke 失败属于夹具：单例 stateless HTTP transport 被复用，初始化通知 HTTP 500；随后 Node Windows 退出时还报告 libuv closing assertion，该次尚未启动测试命令。改为有 session ID 的 transport 后，第二次失败是预期对象未同步文本中的 terminalReplay 标记；修正断言后通过。没有为测试放宽产品约束。首次文件定位还遇到 test/ 与实际 src/ 路径差异及 Windows rg 通配参数错误，已修正。这些初始工具输出未保存成机器测试收据，本段为当时输出的如实记录；不能冒充首次失败也有完整结构化归档。

候选烟测只覆盖隔离 SDK StreamableHTTP 与真实工具 registration，不是生产 OAuth/modern HTTP 路由、真实 ChatGPT、Desktop registration 或 npm/npx 安装验收。生产服务器、客户端 schema 缓存、非 Windows 环境、Windows inherited-stdio 实例均未验证。所有本轮测试命令已结束，未留下新服务，也未操作既有服务进程。

**回执与复现入口**

以下路径均相对仓库；完整逐文件 candidate/source manifest 在 candidate-verification.json。Git blob 哈希与工作树换行字节并不总相同；未在编辑前保存所有原始工作树字节哈希，因此不声称逐项匹配主控给出的全部输入哈希。已记录精确 baseline Git blob 哈希和被测源码指纹，可用于重现本轮实际版本。

| 回执 | SHA-256 |
| --- | --- |
| releases/trajectory-two-day-20260908/audit-overlap.json | 24e81e79981e375df962fdd3eace889a915ea07bbe9ed4b84040cf24d1df65d5 |
| releases/trajectory-two-day-20260908/audit-created.json | 1ef9d5af351529cfffdd479208ad5241fdef8304ca3795c335303c20d6b2616a |
| releases/trajectory-two-day-20260908/baseline-reproduction.json | 1e13f744f10ed41aa9b019f4856a4bb6a57bdda6a0d86101b4dd70650c2fa78c |
| releases/trajectory-two-day-20260908/smoke.json | 6d3a27153800d71678605d765047b8c4075048e007fc9aff124d041f09e789be |
| releases/trajectory-two-day-20260908/candidate-verification.json | ef82aa939db00227ef7ee224071f2ae8827a0d77e4030b3a154e530bc807ac87 |
| releases/test-receipts/2026-09-08T09-04-02-147Z-84b11af7-a119-479c-bb15-345b7a43394a.json | 822bce103923ddf446aae97dbcba211295cdfc3060c714a858c42097c6bfa513 |
| releases/test-receipts/2026-09-08T09-05-14-369Z-73e00206-fabf-4ec5-9e23-42d2b0acd8c6.json | f01fa11c0c19a41e072bf3b3b0777e9a89dc2b0ab05644a0475a8209a17be937 |

候选 manifest SHA-256：`0cb2eb6a6076537ec972a6de6be98309c09b9b68630faa5e7cea1a087554b0ff`。最终全量测试原始日志哈希为 `bf10d9b520095272148a39fcc55c67a91ec356f6341ed6be052ada5fd6ae1d05`；未将原始日志或历史轨迹正文转储到报告。

```powershell
pnpm exec tsx scripts/audit-session-trajectories.ts --db C:/Users/<user>/.local/share/devspace/devspace.sqlite --since 2026-09-06T16:00:00Z --until 2026-09-08T08:49:17Z --selection overlap --diagnostics C:/Users/<user>/.local/share/devspace/logs/server-diagnostics.jsonl --diagnostics-rotated C:/Users/<user>/.local/share/devspace/logs/server-diagnostics.jsonl.1
pnpm exec tsx scripts/audit-session-trajectories.ts --db C:/Users/<user>/.local/share/devspace/devspace.sqlite --selection created
pnpm exec tsx scripts/test-with-receipt.ts src/process-sessions.test.ts src/process-recovery.test.ts src/trajectory-audit.test.ts src/work-task-tool.test.ts src/server.test.ts
pnpm test
pnpm exec tsx scripts/verify-trajectory-candidate.ts
pnpm exec tsx scripts/reproduce-terminal-recovery.ts
pnpm exec tsx scripts/smoke-trajectory-candidate.ts
```

采集时间和活动 run 当前状态可能随重跑变化，JSON 哈希不保证相同；选择规则、隐私投影和边界可重复。原输出应由主控保留后再重跑。代码、测试与文档全部未提交，releases 属于本地产物，未上传。

## 主控独立复核与最终边界

主控没有直接把 worker 的 completed 当作验收通过。已读取本报告、审计器的安全投影、进程回执和执行契约差异、恢复测试、HTTP 烟测脚本、候选构建脚本及汇总回执，再进行独立复验。

2026-09-08 17:20:34.748—17:23:10.651（UTC+8），主控直接执行 `pnpm test`：82 个测试文件、277 项，271 passed、0 failed、6 skipped、0 cancelled，退出码 0。测试计时 155,745.3505 ms；开始/结束源码指纹均为 `e967a388a1cf91cef1c9d79ec2d787e194f42ab5b1255903aa3d612c699c3fb2`，与 worker 首轮全量测试相同。

主控回归回执：`releases/test-receipts/2026-09-08T09-20-34-745Z-e23a3058-62af-4641-aeae-fbc226f8ba17.json`。对应操作 `op_4a95715bc66247a29034fc1a45538daf`。没有把晚轮询所显示的额外等待时间当成测试程序的真实耗时。

随后主控执行 `pnpm typecheck && pnpm exec tsx scripts/smoke-trajectory-candidate.ts`，整体退出码 0，操作 `op_591e50f923fe4b3a9d97da95ccefeac7`。真实 loopback StreamableHTTP 烟测再次通过：初次/复用工作区、旧 schema 条件指引、终态重复读取且账本 revision 不变、退出码 7 负例、跨工作区 session/run 拒绝、旧 get 路径以及 finish 收据均通过。恰好两个命令 operation、零 provider executions，fixture 服务和进程管理器已关闭。烟测收据 SHA-256 与首轮相同：`6d3a27153800d71678605d765047b8c4075048e007fc9aff124d041f09e789be`。

### 三类原因不能混在一起

**失败调用。** 已确认本轮缺失目录的错误建议与宿主 input schema 不一致；Windows 默认 CMD 与主控提交的 PowerShell 语法不一致；终态 session 即读即删导致回执丢失后不能重取。主控也发生了参数失误，包括 capture 的 maxLines 超过 250、read 的 offset 误用 0、补丁路径误用绝对路径。这些参数拒绝是正确校验，不应归为 DevSpace 实现故障。宿主安全检查的拒绝发生在本地执行之前，内部触发原因不可由本地日志证明，不能伪造具体归因，也不能换通道绕过。

**完成率。** 72 runs 的 completed、passed、pending 是不同维度，且一个用户目标可能跨多个 runs。历史记录还包含误建独立子运行、旧运行未结案、代码完成但候选/客户端未加载、外部额度和权限阻断、跨端产物版本不同步等。此前 foreign-run finish 及命令分类修复已落地，本轮没有再次计算为新增。实际新审计只按来源标记分组，不批量关闭或改写旧任务。

**效率。** 入选操作中 read 与 workspace_context 合计 495/1087，约 45.5%；这是发现上下文搬运机会的指标，不证明这些读取都是浪费。长命令时长也不能单独证明模型低效或输出句柄悬挂。本轮新修复使终态回执可重取，且耗时固定到实际 close 时刻，避免为找回输出而重复执行或因晚轮询虚增执行耗时；没有测得可用于宣称整体提速百分比的同条件前后对照。

### 会话标签及历史案例的准确解释

审计文件采集时间为 `2026-09-08T09:09:10.990Z`，即 17:09:10.990（UTC+8）。窗口选择截止 16:49:17，但状态读取的是采集时当前值，不是那个截止时刻的历史快照。JSON 中 `parent:<hash>` 是沿用的来源分组标签，仅表示 `entryPoint=chatgpt_mcp` 与相同 conversation hash，不能独立证明真实父子血缘或一条独立用户需求。尤其 `274828b6ba1b732e3ead5237` 已在既有复盘中被识别为误建的独立 worker run，不能因这个显示标签就将其重新解释成用户父会话。

Library 中的 `voice-memory-verification-20260907.md`、`voice-memory-final-acceptance-20260907.md`、`verification-and-trajectory.md` 和 `ticket-automation-delivery-20260908.md` 提供了具体历史案例：额度/403、后台 PostgreSQL 保留输出句柄、错误父子归属、npm 审计 TLS 暂态失败及随后本地验收通过。抢票项目在没有 HEAD 时差异面板失败也已单列，未伪装成业务失败。本机既有 `docs/trajectory-audit-20260907.md`、`docs/trajectory-review-20260908.md` 则记录了此前修复及启用边界。这些案例的事实时间不同于当前代码版本，不用旧失败推翻之后有证据的成功。

### 未完成与后续优先级

主控追加的 Windows inherited-stdio 实例补测、过期根 PID 的交互保护与按时间排序的脱敏逐条轨迹补丁，被宿主安全检查拦截，未执行；没有改换包装或交由其他 agent 重做该补丁。一次批量文件哈希复核命令也被宿主拦截，未执行。不能声称主控独立逐文件复核了全部候选文件。现有代码及首轮回执保留，独立全量回归所验证的仍是上文源码指纹。

当前交付是会话聚合指标、已有事件案例、源码修复和隔离 MCP 闭环；不是完整 ChatGPT 前端逐条轨迹导出。Windows inherited-stdio 专门用例仍跳过；当前长驻服务没有更新；真实 ChatGPT/OAuth/Desktop/安装包链路没有本轮新版本验收。

后续优先级：先补齐 Windows 生命周期与根 PID 代际保护的专门验收、受控升级后的原生 MCP 验收；再完善显式父子血缘、阶段验收矩阵与最小错误元数据留存，避免短日志轮转使历史因果不可查；最后补新仓库无 HEAD 的差异展示、带容量限制的逐条轨迹和上下文/轮询负载基准。保持错误日志不记录原始命令、prompt、响应正文或凭据，不通过放宽审批、锁或外部权限提高表面成功率。

本轮仅一条受管 Codex 执行，用量完整：input 2,994,128，output 31,241，total 3,025,369；cached input 2,883,456 与 reasoning output 5,559 已包含在对应总量，不重复相加。确定性主控复验与 HTTP 烟测没有新增 provider execution。汇总见 `releases/trajectory-two-day-20260908/host-verification.json`。
