# Windows Job ExecutionRunner — Stage 2 isolation checkpoint

This is a **development-only implementation in the source-snapshot checkout**.
It is not yet wired into `ProcessSessionManager`, `agentd`, or any Provider.
Do not publish or enable the migration based on these tests alone.

## What is implemented and verified

- `src/windows-job-object.ts`: one named Windows x64 Job per execution,
  `KILL_ON_JOB_CLOSE`, verified runner process membership, native process
  creation time, accounting-based active process count and whole-Job termination.
  Assignment/verification failure is fatal; there is no PID-only fallback.
- `src/execution-runner-child.ts`: isolated Node bootstrap. Its only pre-GO
  application action is the control-channel READY handshake. A command is
  launched only after IPC GO with matching execution ID, generation and sequence.
  stdout/stderr are separate from IPC control.
- `src/execution-runner.ts`: READY → Job membership check → caller's durable
  `persistArmed` callback → GO. The job is forcibly drained after a root exit,
  cancel, or lost runner; an exit receipt is issued only after the native
  active-process counter has reached zero. The owner keeps the Job handle until
  verification. With unresolved cleanup, the proof fails instead of claiming
  released. Source TS uses the installation-local development loader; packaged
  JS runs without `tsx`.
- `src/execution-runner.test.ts`: real Windows child-process checks for
  pre-GO non-dispatch, persisted SQLite armed record, failure-to-arm behavior,
  owner crash closing the Job, and isolated Job tree cleanup.
- `scripts/test-windows-job-packaged.mjs`: smoke test of built JS entry
  including a real command and zero-active-process confirmation.

## Verified commands (isolated copy)

```powershell
pnpm typecheck
node --import tsx --test src/execution-runner.test.ts
pnpm build
node scripts/test-windows-job-packaged.mjs
pnpm test
```

Actual 2026-10-14 results: Windows tests **5/5 passed**, build and typecheck
passed; full suite **342 tests: 334 passed, 8 skipped, 0 failed**, on 94 files.
Full-suite receipt:

`releases/test-receipts/2026-10-14T03-15-58-050Z-fa1026be-db05-4cc8-993b-c6b97a4a3245.json`

## Not implemented — mandatory before stage 2 sign-off

1. Connect ordinary `exec_command` and `write_stdin` to one Runner each, with
   durable `execution_id`, same-connection claim/ledger/managed-execution
   admission, retained output semantics, and a release-after-proof transition.
2. Move every supported Provider turn behind a Runner IPC protocol. Session
   IDs, thread binding, callbacks awaiting persistent owner ACK, interrupt,
   steer, stop and late messages must preserve current behavior.
3. Establish authoritative owner/boot identity across restarts and prove
   worktree/checkout and serialized resource claims together before GO.
   A test callback supplying `persistArmed` is not itself an OS authority.
4. Add all Provider adapter fake tests, PID reuse/restart checks, legacy-session
   compatibility, nested-host restrictions and intentionally failed Job
   assignment checks. Non-Windows must preserve existing behavior.
5. Only after stages 2–5 have passed should the real daemon be switched, using
   the separate maintenance window and migration/back-up procedure.

## 2026-10-14: command-session integration completed in isolated snapshot

The first item above now has an **experimental implementation**:

- `src/process-sessions.ts` implements a separate Windows-managed
  `startManaged` path. Its admission puts the claim, `managed_executions`
  record and optional WorkLedger operation in **one SQLite transaction**,
  using a borrowed WorkLedger connection. GO is emitted only after the real
  Windows Job member identity and state-store armed evidence are committed.
- `src/execution-coordinator.ts` introduces `admitManaged`,
  `withManagedState` and `completeManaged`. The latter commits the terminal
  state, OS exit proof, ledger outcome and claim deletion together; errors
  retain the claim. Legacy admit/release methods are intentionally unchanged.
- `src/tool-surfaces/codex.ts` exposes `execution_id` in structured and
  human-readable command output. For managed sessions, subsequent
  `write_stdin` requires that exact identity and rejects stale/missing IDs.
  Numeric session IDs are randomized, not restarted at 1 in managed mode.
- `src/server.ts` passes
  `managedWindowsCommands: process.env.TASKQUAY_EXPERIMENTAL_MANAGED_WINDOWS_COMMANDS === "1"`
  on Windows only. **Default OFF. Do not set this in the real daemon.**
- `src/execution-runner-child.ts` matches the existing Windows
  `spawn(command, {shell: cmd.exe})` quoting behavior for paths with spaces.
- `src/process-sessions-managed.test.ts` uses temporary SQLite databases and
  real Windows processes to verify success, idempotency, unique execution ID,
  stdin, independent jobs, cancel, atomic admission rollback and proof-gated
  rollback when finalizing the ledger fails. The latter intentionally leaves
  the claim in SQLite; it is not an automatically recovered lock.

### Verification after command wiring

- Targeted managed + existing command/ledger compatibility tests: **30/30 pass**
  before the two additional fault-path checks; the fault-path checks then
  passed **4/4**, including atomic rollback and retained claim.
- `pnpm typecheck`, `pnpm build` and packaged Windows smoke test:
  **passed**, `PACKAGED_JOB_OK` with native active process count 0.
- Full suite: **346 tests, 338 passed, 8 skipped, 0 failed**, 95 files;
  final receipt `releases/test-receipts/2026-10-14T03-36-14-157Z-34ff2fc3-663a-4ecd-89cb-fc57e3f71fb1.json`.

**Remaining limitations:** all Provider turn adapters still use their previous
runtime pools; Windows Job identity does not yet provide verified OS reboot
lineage (the current `boot_id` marks its runtime as unverified), so this
code must NOT auto-recover claims from previous owners. The session-number
randomization is combined with exact `execution_id` validation, but migration
and backwards compatibility for provider-specific session/turn IDs remain
outstanding. Runtime startup and production cutover were not performed.

In particular, do **not** misinterpret an isolated primitive's passing tests
as a production lock recovery guarantee. The currently running Taskquay is
unchanged and still uses its legacy command and Provider process paths.
