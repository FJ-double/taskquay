本轮针对截图中 ticket-automation 项目、run 短标识 `b889f9` 排查。结果不支持“provider session ID 丢失”的判断，但确认了标题身份选择和终态复用两个缺陷，并已修复源码。

只读诊断入口为 `scripts/inspect-session-reuse.ts`，要求显式数据库路径和已观察的六位 run 后缀，后缀匹配不唯一时拒绝继续。使用 better-sqlite3 readonly/fileMustExist 和读事务，最多 100 个 execution；仅投影身份、时间、状态和 key 数量，身份全部哈希。不读取 prompt、title、response、任意 evidence、命令或配置。真实数据库未迁移、未写入。

观察到同一个 run 中有 3 个不同 agent、3 个不同 provider thread 和 3 个不同 contextKey，workspace/workItem 相同。其中两个 execution 的时间重叠：06:44:15–06:46:17 UTC 与 06:44:37–06:46:09 UTC。之后的两次 continue 指向前两个原 agent，它们当前保存的 providerSessionId 仍分别对应原线程；continue execution 在 thread 绑定前失败，当前固定错误码为 PROVIDER_UNAVAILABLE。没有读取错误正文，不能据此进一步判定是 quota、history 或其他 provider 控制错误。身份字段是当前记录，不是每次调用的完整历史输入。

因此截图显示的是多个真实独立上下文被赋予相同标题，不能仅凭项目或标题将它们强制合并。自动复用仍须 workspace、profile、workItemId、contextKey 和能力签名匹配；不同上下文、不同能力或显式 freshContext 保持分离。host 应将 contextKey 当作稳定领域/角色身份，而非每一步的阶段名；已更新工具字段描述。

Git blame 定位：`a3a63ab` 给所有子上下文使用 `sessionTitle(run.id)`，run ID 被当作标题标识；`b804e1d` 后续只整理标题格式，没有区分 agent。`e6c88c3` 的 context-affinity 查询仅接纳 starting/queued/running/idle，排除了保留 thread ID 的 error/stopped。以排查基线 `9e62c0b` 沿 first-parent 计算，前两项根因分别在 30、31 次提交前，不是最新上游合并造成。

修复包括：

- 标题使用持久化 agent 的八位标识，同一 run 的独立会话可区分；标题规范化兼容旧六位与新八位前缀。续用仍按 provider session ID，不依赖标题匹配。
- 同 context 的显式新任务可以复用 error/stopped 且保存着 provider session ID 的记录，沿正常 provider、claim、scope、reconciliation 检查继续，不通过新建 thread 绕过失败。
- 重复 taskKey 仍返回幂等回执；活跃上下文继续拒绝冲突；freshContext、预算和 workspace 隔离不变。不自动重放旧 prompt，不扫描其他项目挑选会话。

新增 3 个回归先在旧实现上失败：error/stopped 恢复各一例（单会话预算下误报新会话超限），以及相同 run 的独立会话标题碰撞。修复后业务断言通过；第二轮发现测试新增 ledger 句柄关闭晚于 Windows 目录清理的 EPERM，改为短生命周期句柄后修正。最终聚焦 6 文件、30/30 通过，覆盖 thread ID 传入、同 context 保持 agent、重复 start 不再次调用、独立 context 不混用及八位标题的幂等规范化。

初始红灯回执：`releases/test-receipts/2026-09-08T16-28-17-434Z-6ee05dbe-19b4-4493-ac18-02e3a7190214.json`；最终聚焦回执：`releases/test-receipts/2026-09-08T16-30-26-838Z-8c44ab72-e778-428a-88f2-9f14011e7cf2.json`。

typecheck 与隔离 TypeScript 构建通过，回执为 `releases/session-reuse-20260909/candidate-verification.json`，SHA-256 `431fb9adfcd531cb6409b53f28137f8113ff6a970342edcd5cdb707ba7cd54f8`。SDK Client → loopback StreamableHTTP 候选烟测通过，零 provider executions，回执 `releases/session-reuse-20260909/smoke.json`，SHA-256 `b34e073ca9fd741a2e2eea3b6e3e89e7064456d7aaa17cfa021f54286418435b`。会话复用回归使用模拟 provider 的真实 manager/store/runtime-pool 路径，没有真实模型费用。

最终全量 `pnpm test` 通过：87 文件、299 项，292 passed、0 failed、7 skipped、0 cancelled，耗时 221,015.1097 ms；运行前后 sourceSha256 均为 `02c11673466a08215074252c549542c836608a1676d74b15577010f4676835fa`。回执为 `releases/test-receipts/2026-09-08T16-31-30-140Z-fca5daea-0fc5-4e89-b0af-d7142a120d07.json`，原始日志 SHA-256 为 `61fe1d0da4f65b7095728365661f054d79cff9af434dbd617cd5c97f3ef94b04`。测试进程均已退出。

未部署、重启服务、归档/删除/重命名截图中的已有线程。本次源码修复不会立即改变已有 Desktop 标题；新命名适用于之后新建的受管上下文。上述测试在提交前运行，源码提交与推送状态以 Git 记录为准。
