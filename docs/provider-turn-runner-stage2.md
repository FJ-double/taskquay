# Provider Turn isolation — development checkpoint (2026-10-14)

## Safety and release boundaries

All code is in the local source snapshot (`<source-snapshot>`).
No production Taskquay, running daemon, user configuration, live SQLite state,
or real Provider sessions were updated. There is no production feature switch
for this Provider Runner yet: it is NOT connected to LocalAgentManager.

## Provider topology

| Provider | Current backend | Implication for per-Turn Job |
| --- | --- | --- |
| Codex | `CodexAppServerRuntime` launching `codex app-server` | AppServer must be created inside Job after GO; thread ID and live control need a parent ACK |
| Claude | `ClaudeQueryRuntime`, async SDK Query | SDK/session context recreated in each Job; callback on durable session identity must be awaited |
| OpenCode | `OpencodeRuntime` with a spawned service process | Service lifetime and session ownership must be explicit; old shared server is not itself one Turn |
| Pi | `PiSessionRuntime`, SDK session plus sandbox tools | Bootstrap must import SDK only after GO; sandbox permissions and tool processes require real-process verification |
| ACP providers | `AcpRuntime` with stdio child | Retain protocol lifecycle and verified continuation identity |

## Current implementation

- `provider-turn-ipc.ts`: allowlisted lifecycle callbacks, request-level
  ACK, execution/generation/sequence identity, maximum outstanding calls,
  bounded callback ACK and control deadlines.
- `provider-turn-child.ts`: one Node child per Turn, with READY → GO and
  deferred adapter import, callback/ACK transport and remote turn controls.
- `provider-turn-runner.ts`: one Windows Job; identity verified via native
  process creation timestamp and membership; caller must persist armed state
  before GO; no success receipt without Job-empty observation. Terminal
  cancellation is idempotent. Pending callback host state can never implicitly
  approve a resource release.
- `provider-turn-fixture-child.ts`, `provider-turn-ipc.test.ts`,
  `provider-turn-runner.test.ts`: no real paid inference. Covers blocking
  session ID commit, error ACK, replay rejection, callback timeout,
  control steer/interrupt, native Job cleanup, idempotent terminal cancel.
- `scripts/test-provider-job-packaged.mjs`: uses compiled parent/child and an
  intentionally unknown provider. Must emit `PACKAGED_PROVIDER_JOB_OK`
  with `activeProcesses:0`, `modelRequests:0`; expected error is a safely
  rejected adapter, not a real model error.

## Actual verification

- `pnpm typecheck` passed.
- `pnpm build` passed. The only observed build warning concerns front-end
  bundles larger than the suggested chunk threshold.
- `pnpm test` passed 353 total: 345 passed, 8 skipped, 0 failed, in 97
  test files. Receipt:
  `releases/test-receipts/2026-10-14T04-04-17-405Z-80128510-0682-4f26-947c-13689c0264db.json`.
- After fixing a forgotten parent-side timeout handle, compiled Windows
  smoke test went from ~33 s process exit to ~1 s process exit while reporting
  Job members = 0. Both behaviors were observed against the isolated package.

## Mandatory next task; not implemented

1. Wire `WindowsProviderTurnRunner` into the actual provider turn dispatch
   (`LocalAgentManager.runTurn` / `LocalAgentRuntimePool`) behind an
   explicitly disabled-by-default configuration gate. Do not silently change
   behavior of existing sessions.
2. Introduce an atomic admission commit for Agent work: owner generation,
   `execution_claims`, `managed_executions`, `console_executions` and
   the WorkLedger operation. Never load a Provider SDK before Job armed is
   durably committed.
3. Associate exact local agent/turn/provider-session identity and callback ACK
   with this execution. Late messages, retry after timeout, wrong generation
   and PID reuse must fail closed without replaying inference.
4. Verify full Provider adapter lifecycle (Codex/Claude/OpenCode/Pi) using
   injected fake adapters first, then Windows real processes and controlled
   cancellations. Restore original thread/session continuity.
5. Replace the interim unverified boot identity with real OS boot identity
   before implementing proof-backed recovery. No production release until
   all five phases and migration rehearsal pass.

Important: A working independent Provider transport is NOT equivalent to
having enabled per-Turn isolation in Taskquay.

## 2026-10-14 update: experimental LocalAgentManager connection

This update supersedes the earlier "not connected" statement **only for the
explicitly opted-in development path**:

- `src/provider-managed-dispatch.ts`: adopts an existing, owner-matched
  Agent claim in the same SQLite transaction that creates its managed
  execution record, links the claim to `execution_id`, and performs
  Windows Job armed state transitions before Provider GO. Finalization checks
  execution generation, original owner, runner PID and kernel Job identity,
  then atomically commits managed terminal state, Job-empty evidence, the
  WorkLedger execution outcome and claim deletion. Claim release is blocked
  if any part fails.
- `src/local-agent-manager.ts`: routes `runTurn` to the managed dispatcher
  only under an explicit experimental opt-in; default remains the
  `LocalAgentRuntimePool`. It preserves all original callback-driven thread
  and control state. It never silently falls back to a pooled runtime when an
  opted-in managed turn lacks execution identity. Unverified worker exits
  quarantine the claim and mark ledger reconciliation required.
- During manager shutdown, it cancels only its own tracked Job runners before
  waiting for active turns, avoiding an indefinitely live per-Turn worker.
  An interrupted Turn without a final, committed receipt retains its claim.
- `src/local-agent-daemon-main.ts`: experimental env gate
  `TASKQUAY_EXPERIMENTAL_PROVIDER_JOB_TURNS=1`, **OFF by default**. Do NOT
  set this variable for the real daemon.
- `src/provider-turn-child.ts`: transmits the same `SubagentsConfig` that
  production passes to driver construction, avoiding silent loss of provider
  configuration when SDKs are created inside the Job.
- `src/local-agent-managed-turn.test.ts`: three Windows real-process
  scenarios with a model-free Provider fixture: successful manager Turn and
  continuity identity, loss of worker without proof retains claim, and
  manager shutdown terminates its own Job while leaving an unproven claim.

**Results:** `node --import tsx --test src/local-agent-managed-turn.test.ts`
passed **3/3**; `pnpm typecheck` passed; `pnpm test` passed **356 total,
348 passed, 8 skipped, 0 failed**, 98 files; `pnpm build` passed; packaged
provider smoke emitted `PACKAGED_PROVIDER_JOB_OK`, active processes 0,
model requests 0. Full test receipt:
`releases/test-receipts/2026-10-14T04-20-02-604Z-4ddc0f38-3077-4857-8960-9ae086a92eb3.json`.

**Not production ready:** Existing `console_executions` and original Agent
`execution_claims` are still created in separate prior steps. The adoption
transaction covers linking a *previously acquired* claim, not original
admission; a daemon crash between those steps is not yet safely recoverable.
LocalAgentStore and WorkLedger use separate connections for some earlier
state writes, so cross-table completion is not fully atomic end to end.
Windows OS reboot identity and verified stale-owner recovery, fair four-way
admission, durable queue leasing, and actual Codex/Claude/OpenCode/Pi adapter
real-process testing remain undone. Never deploy this experimental gate.

## 2026-10-14 update: atomic Agent admission (isolated snapshot only)

The previously identified **claim / console execution / managed execution**
pre-admission split has now been closed in the experimental path:

- `ManagedProviderDispatcher.admit()` uses
  `ExecutionCoordinator.admitManaged()` and a **borrowed WorkLedger SQLite
  connection** to atomically: check source/thread/resource capacity, insert
  `execution_claims`, establish or reuse the WorkRun, insert the
  `console_executions` receipt, insert `managed_executions` and link the
  claim to the exact managed execution ID.
- Any failure in that transaction, including a deliberately injected ledger
  insert failure, rolls back the newly inserted claims, execution, WorkRun
  and WorkItem in the same SQLite connection. There is no Provider GO.
- `ManagedProviderDispatcher.run()` now accepts the already admitted
  `managedExecutionId` and checks linked claim/owner/provider/agent/work-run
  identities before creating the Job. It can no longer adopt an unrelated
  legacy claim mid-flight.
- If `LocalAgentStore.beginTurnResult` fails **before** any worker dispatch,
  `abandonUndispatched()` records a terminal outcome, a
  `never_dispatched_verified` receipt and removes only that claim within
  one transaction. Any ambiguity after worker launch retains the claim.
- When the experimental path encounters resource contention, it currently
  **rejects** and creates no legacy queue entry. FIFO lease-based admission
  is reserved for Stage 4; the default legacy path remains unchanged.
- Managed continuations use existing request-key reservation; a duplicate
  continuation key returns the recorded response rather than replaying
  inference. The managed record additionally supports a scoped idempotency
  key in the same transaction.

### Verified receipts

- Seven real Windows / temporary SQLite Agent tests passed, including
  admission rollback, no orphan waiter on conflict, never-dispatched release,
  exact requestKey de-duplication, and previous Job cleanup behaviors.
- `pnpm typecheck` and `pnpm build` passed (only the unrelated front-end
  chunk-size warning).
- `pnpm test`: **360 tests; 352 passed, 0 failed, 8 skipped**, 98 test
  files. Source unchanged during tests. Receipt:
  `releases/test-receipts/2026-10-14T04-32-25-646Z-7e447a05-f95f-4843-921a-098c851ae018.json`.

### Release blockers retained

The `LocalAgentStore` turn record and completion state still use another
SQLite connection and therefore are not yet one atomic work unit with the
Agent claim and WorkLedger result. Windows reboot/owner verification and
stale-lock recovery remain unimplemented. Four-way fair queue admission,
long-lived service ownership, and real Codex/Claude/OpenCode/Pi adapter
process testing are also outstanding. The feature gate remains OFF for
production. Do not infer that live Taskquay lock deadlocks are fixed.

## 2026-10-14: shared-connection Agent Turn lifecycle

The opt-in managed Windows path now puts LocalAgentStore and WorkLedger on
the **same SQLite connection** owned by ExecutionCoordinator. The store
verifies the expected database path before borrowing the connection and no
longer closes that connection itself. The default legacy path is unchanged.

- Managed admission now creates the claim, WorkRun, ledger execution,
  managed execution, and **AgentStore beginTurn** inside one SQLite immediate
  transaction. Failure at any point rolls back the complete admission.
- Managed terminal finalization commits the response, AgentStore terminal
  turn state, ledger outcome, OS Job-empty evidence and claim deletion in one
  transaction. A failure at the last ledger update rolls back the Agent
  response and leaves the claim held. Uncertain completion fences the agent
  with `reconcile_required`.
- Ordinary commands and the opt-out path retain existing semantics. Provider
  launch remains gated by durable Job arming, not a heartbeat guess.

**Verification:** 9 targeted tests passed (8 Windows managed-turn tests
plus the legacy manager test), including injected pre-GO and terminal
SQLite failures; `pnpm typecheck` and `pnpm build` passed. Full
`pnpm test` passed **361 tests: 353 pass, 8 skipped, 0 failures** in
98 files. Receipt:
`releases/test-receipts/2026-10-14T04-50-25-331Z-a920339d-6bf2-4af7-9b26-bb555668c624.json`.
The packaged smoke showed active Job processes 0 and model requests 0.

**Unfinished / do not deploy:** Windows boot identity and verified owner
crash recovery, expired lease handling, callback replay fencing across
restarts, fair four-way queues and live Codex/Claude/OpenCode/Pi adapter
testing are still outstanding. SQLite cannot itself atomically commit
external Provider actions or OS Job creation, so ambiguous crashes must
be quarantined and must not replay inference.

## 2026-10-14: owner-crash and late IPC callback fault injection

All tests ran only in the isolated checkout with disposable temporary
SQLite databases and synthetic, model-free Provider children. They do not
modify or terminate the actual Taskquay daemon or user sessions.

### Crash boundaries: three physical Windows owner terminations

`provider-owner-crash-fixture.ts` and `provider-owner-crash.test.ts`
spawn dedicated throwaway Node owner processes and create persistent
managed claims in a temporary SQLite database. Tests forcibly terminate
**only those fixture owner PIDs** at three boundaries:

1. **After admission, before fork:** `managed_executions.phase=starting`,
   the claim stays held, and no child is dispatched.
2. **After durable Job arming, before GO:** `phase=running`, with armed
   Job identity persisted; no Provider GO is allowed. The Windows kernel
   terminates the Job child when the owner exits.
3. **During a running fixture Provider turn:** the Job child is verified
   running before owner termination; after owner death the Job child dies
   without any database cleanup by the dead parent.

In all cases `resource_state=held`, the exact execution claim remains
and `exit_evidence` is NULL: OS Job disappearance without a durable
recovery proof is NOT permission to delete a claim. **No inference is
automatically replayed**.

### Provider callback identity and terminal-event fence

- `provider-turn-ipc.ts`: serializes lifecycle callbacks on the host so
  `onRequest` cannot overtake a still-uncommitted `onSessionId`, even
  if a faulty child pipelines messages. If one callback persistence fails,
  subsequent pipelined events receive negative ACK and are never invoked.
- `provider-turn-runner.ts`: rejects any callback arriving after the
  `PROVIDER_RESULT` message, records a protocol violation and fails closed
  after draining its own Job. A callback persistence error also invalidates
  any terminal success receipt. The fence closes on cancel or failed cleanup.
- `provider-turn-fixture-child.ts`: deliberately sends late and
  wrong-generation callbacks to exercise the rejection rules. Resumed fake
  Provider turns now use **distinct provider-turn IDs**, matching the
  schema's `(managed_thread_id, provider_turn_id)` uniqueness guarantee.
  It does not misrepresent an unverified prior-history boundary as clean.
- Tests cover wrong generation, late post-result callbacks, duplicate
  identities, pipelined callbacks with delayed ACK, bad session persistence,
  owner crash after arm and during execution, and genuine Job-empty checks.

### Verified results

- Targeted tests: **22/22 passed**, with 3 real owner-crash scenarios and
  the existing managed Agent continuation and IPC tests.
- `pnpm typecheck` and `pnpm build`: passed.
- Full `pnpm test`: **368 cases, 360 passed, 8 skipped, 0 failed** in
  **99 test files**; before/after source hashes match. Receipt:
  `releases/test-receipts/2026-10-14T05-20-42-454Z-3475e2e2-b709-456c-b1c5-3e0bd8e129ac.json`.
- Compiled Windows smoke: `PACKAGED_PROVIDER_JOB_OK`, Job members 0,
  model requests 0; `git diff --check` exited successfully.

**Not implemented / release gate remains OFF:** this work establishes
safe **quarantine** on owner crash, not verified **automatic recovery**.
Cross-restart owner/boot identity, a trusted observation that the exact
Job and descendants are gone, idempotent claim recovery, four-way FIFO
admission, and real Codex/Claude/OpenCode/Pi SDK lifecycle validation are
still outstanding. Do not turn on the experimental gates for production.

## 2026-10-14: actual Provider metadata probes and kernel boot identity

All work is still in the isolated `source-snapshot`; online Taskquay,
production SQLite, real Agent sessions, and user-owned processes are
untouched. No model request was submitted.

### Actual Provider process / SDK capability results

- `provider-adapter-probe-child.ts` and `provider-adapter-probe.test.ts`:
  a disposable worker is assigned to a real Windows Job and receives GO
  only after the Job has been armed. **Codex** launches the installed CLI's
  real `app-server` inside that Job, completes the actual
  `initialize/initialized` metadata handshake, closes it, and proves the
  Job is empty. Uses a throwaway `CODEX_HOME` under a temporary directory,
  not the user's original conversation store or account configuration.
  The installed CLI in the tested machine reported `codex-cli 0.130.0`.
- **Claude** imports the installed real `@anthropic-ai/claude-agent-sdk`
  and checks for the CLI without calling SDK `query()` or sending a prompt.
- **OpenCode** imports the installed real `@opencode-ai/sdk` and probes
  for the CLI. On this machine the global OpenCode CLI was not found;
  an SDK import is not proof that the OpenCode server can start.
- **Pi** imports the installed real `@earendil-works/pi-coding-agent`
  and verifies `createAgentSession` exists, but deliberately does not
  create or run a model session.
- All four probes run after Job GO and return metadata-only receipts with
  `modelRequests:0`. They are capability probes, **not** real Turn/resume
  tests for Claude, OpenCode, Pi or Codex.

### Windows native boot identity

- New `windows-boot-identity.ts` reads two *kernel-returned* fields via
  `NtQuerySystemInformation`: the loader's BootIdentifier GUID (class 90)
  and raw NT BootTime FILETIME (class 3). Both must be valid; no generated
  fallback is allowed. GUID-only evidence is insufficient for reboot
  recognition, so the raw boot timestamp is included.
- Experimentally managed Provider and command owners now save the native
  composite as `boot_id`, instead of the earlier
  `runtime-unverified:UUID` label. The random owner generation is still
  separate; PID creation time continues to be collected from the kernel.
- Tests confirm the identity is stable across repeated native queries and
  a separate Windows process in the **same actual boot**. It has NOT been
  tested across a real computer reboot or all supported Windows versions.
  The native information class is partially undocumented. Any query
  failure must fail closed and forbid automatic recovery.
- This change **does not delete or recover claims**. A matching/different
  boot ID alone never proves the exact old Job and descendants are gone.

### Verified tests

- `node --import tsx --test src/provider-adapter-probe.test.ts
  src/windows-boot-identity.test.ts`: **5/5 passed** on Windows x64.
- `pnpm typecheck` and `pnpm build`: passed.
- Full `pnpm test`: **373 total, 365 passed, 8 skipped, 0 failed**,
  101 files, before/after source hashes identical. Receipt:
  `releases/test-receipts/2026-10-14T05-35-19-932Z-0ad84e7a-7dc8-4e88-8309-cc5d4bcb2e21.json`.
- Compiled Job smoke: `PACKAGED_PROVIDER_JOB_OK`, active processes 0,
  model requests 0. No production cutover.

### Next and remaining release blockers

1. Test true per-Turn provider session continuation with isolated,
   no-cost Provider protocol simulations that mirror SDK states; only then
   attempt controlled actual Codex/Claude/Pi/OpenCode Turn tests when the
   user authorizes any inference costs and missing binaries are available.
2. Design the Stage 3 recovery verifier around owner generation,
   kernel boot ID, PID creation time, and exact named Job observation.
   Failure/ambiguity must quarantine rather than release. Do not replay
   a paid request or trust heartbeat expiration alone.
3. Stage 4 fair FIFO four-way admission and Stage 5 long-lived services,
   shadow migration and production deployment have NOT been completed.
