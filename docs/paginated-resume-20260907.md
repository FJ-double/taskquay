# 已保存会话无法接续的能力边界

2026-09-07 当前 Voice Memory 原会话恢复在推理之前失败，实际旧线程仍存在，cwd 匹配、ephemeral=false，provider/account identity 与历史绑定一致。只读 `thread/read(includeTurns=false)` 返回 `historyMode=paginated`、status=notLoaded；未读取会话条目、私人思考或凭据，也未改历史格式。

安装中的 Codex 是 0.153.4。官方 App Server 文档明确说明目前 paginated 历史可以列出和读取摘要，但完整历史读取与恢复尚不支持。因此不能继续把这个问题归因于额度耗尽、APK不存在或工作区丢失。来源：https://learn.chatgpt.com/docs/app-server#threads 。

源码现在在这个已核验版本的恢复请求之前执行只读摘要检查，明确返回 `history_preflight / PAGINATED_HISTORY_UNSUPPORTED`，不自动clone/fork、不改原线程、全局配置或session budget、不发送模型turn。新版本须先验证其实际能力，不能将固定旧版本限制无条件外推到未来实现。

新增协议回归要求 paginated 已确认时不调用项目登记、thread/resume、thread/start/fork 或 turn/start。独立 `scripts/inspect-resume-metadata.ts` 只检查显式授权且已终态的managed agent，输出固定元数据与错误分类，不输出原始聊天正文。

本轮改动是源码修复；正在运行的MCP/agentd是否加载该版本另行核验，不能用提交代替运行证据。原应用工作可由主控正常执行；这不等同绕过Codex会话预算创建新线程。

验证：`codex-project-runtime.test.ts` 与 `codex-work-protocol.test.ts` 共5项全部通过、无跳过；`pnpm typecheck` 通过。收据 `releases/test-receipts/2026-09-07T12-46-42-972Z-4a435531-33fa-43cd-ad94-db632db6b60c.json`，源文件指纹 `5aeb6a913adaa627b0b406a027b5754ac8ba18aa1507de79a0e4b37df4318ddc`。其中真实线程只做元数据读取，完整任务未被再次发起；协议模拟测试与真实生产运行分别记录。
