# Stage 4 (partial): managed four-way FIFO admission

Date: 2026-10-14. **Isolated snapshot only. Experimental path OFF
in production.**

## Implemented

- `ExecutionCoordinator.enqueueManaged(input,waitMs)` persists only an
  Agent waiting ticket, with no Provider request, Job, Claim or WorkLedger
  execution. Maximum 64 tickets and bounded expiry.
- `ticket.tryAdmit(callback)` verifies ownership, original scope,
  expiration, active Agent limits and older runnable tickets. It commits
  ticket deletion, Claim creation, callback's managed execution/ledger
  operations, and the exact claim-to-execution link **in one IMMEDIATE
  SQLite transaction**. An injected callback failure rolls everything
  back, retaining the original waiting ticket.
- A default limit of four applies to this new managed FIFO, and to the
  opt-in LocalAgentManager managed path when no explicit user limit is
  provided. Legacy default two is unchanged.
- Fair, work-conserving FIFO: earlier runnable tickets reserve available
  slots; earlier tickets blocked on their own busy checkout do not block
  unrelated work. Per-checkout writers and explicit shared resources
  remain exclusive. Consumed, cancelled and expired ticket IDs cannot be
  reused to dispatch work.

## Verified

- Nine queue tests: four independent checkouts, fifth waiting, two SQLite
  Owner connections, older-ticket priority, nonblocking independent
  checkout, writer FIFO, injected transaction rollback, 24 FIFO tickets
  rotating through one free slot, shared-resource exclusion and expired/
  cancelled ticket rejection.
- A real Windows, no-model LocalAgentManager test starts **four distinct
  Job containers from four separate directories simultaneously** and
  places the fifth in its durable FIFO queue without a Provider request
  or managed execution.
- The Windows exact Job/Owner recovery race ran **six independent times**:
  two recovery subprocesses compete; only one release and one audit record
  per round. Useful repeated concurrency verification, **not a soak test**.
- Full `pnpm test`: **402 total, 394 passed, 8 skipped, 0 failures**,
  106 files; source SHA-256 remained identical. Receipt:
  `releases/test-receipts/2026-10-14T09-23-59-830Z-aacf0a75-1130-4395-be47-eb9132bc7de0.json`.
  `pnpm typecheck`, `pnpm build`, `git diff --check` all passed.
  Packaged Job smoke showed zero active processes, zero model requests.

## 2026-10-14 update: Manager auto-queue / wake / cancel integration

**The managed FIFO ticket is now wired into the opt-in
`LocalAgentManager` lifecycle**, still only inside this isolated snapshot:

- `ManagedProviderDispatcher.enqueue` creates the durable Agent ticket;
  the same `persistAdmittedTurn` callback is used by immediate admission
  and ticket promotion. The callback atomically creates WorkLedger,
  `managed_executions`, Claim and `LocalAgentStore.beginTurnResult`
  **only after** the queued ticket is selected for a slot. No Turn or paid
  Provider request exists while waiting.
- When immediate admission finds a conflicting checkout, shared resource,
  thread, or four-slot capacity, `LocalAgentManager` now queues instead
  of rejecting (unless `queueWaitMs=0`). A 100-ms cancellable poll checks
  the same durable ticket; the Owner lease is revalidated on each attempt.
- `wait()` tracks the queued Agent promise even though there is no Turn
  yet. It returns `running/wait:timeout` if no slot arrives during the
  caller's wait budget and the actual Turn result after promotion.
  `cancelQueued()` can abort and stop a queued Agent without creating
  a Turn. The queue ticket is removed in cleanup, while an already-started
  Job remains governed by its existing proof-gated cancel path.
- An identical taskKey during waiting returns the existing Agent; it
  neither inserts another ticket nor replays the model request.
- LocalAgentManager's old nonmanaged asynchronous queue and default
  concurrency limit are preserved.

Native, model-free Windows tests verified all of these end-to-end:

1. **Four real Job owners, fifth queued without Turn**, exactly four
   managed execution receipts and one waiting ticket.
2. **Fifth automatically promoted** after the first Job completes; it
   then receives its own Turn and completes, and the ticket is removed.
3. **Queued cancellation** before GO leaves no Turn, WorkLedger execution,
   extra claim or child Job.
4. **Same-checkout writer serialization** even when other global Agent
   slots are available.
5. **Idempotent taskKey** remains a single durable ticket.

Earlier fixture versions returned one fake Provider thread ID for
unrelated Agents; the real WorkLedger correctly rejected that identity
collision. The test fixture was fixed to generate distinct thread IDs
for fresh concurrent Agent simulations; **no production thread ownership
check was weakened**.

Latest full regression: **405 total / 397 passed / 8 skipped /
0 failed**, 106 test files, source SHA-256 unchanged:
`releases/test-receipts/2026-10-14T09-50-23-505Z-984feb7e-35cb-4711-9aa2-18719ab43201.json`.
`pnpm typecheck`, `pnpm build`, `git diff --check` and packaged
Provider Job smoke passed, with Job members 0 and paid model calls 0.
Production Taskquay HEAD remained `00dcb20`.

## Remaining release blockers

Queue owner death and server restart require a trusted orphan waiting
ticket / `LocalAgentStore.status=queued` reconciliation protocol: a
new daemon must not replay a possibly dispatched Provider Turn.
Cross-restart queue recovery, clock skew / timeout race testing, higher
volume adversarial competition, Stage 3 true reboot validation and a
long-duration soak are **not done**. A work-item policy for queues of
multiple pending tasks and live Provider adapter signoff also remain.
Stage 5 long-lived services, migration, shadow verification, rollback
and controlled production cutover have not started. Keep all experimental
flags OFF in production.

## 2026-10-14: deterministic Agent contention and legacy TTL compatibility

New test coverage: **24 separate rounds with 20 Agent admissions and
releases each** (480 total) across four global slots, without leftover
claims or tickets. A legacy enqueue/acquire regression specifically
verifies an expired v19 managed ticket is never deleted by the old TTL
sweep; the legacy path deletes only legacy `owner_generation IS NULL`
waiters. See `docs/managed-service-isolation-stage5.md` for the
independent long-lived service ownership namespace introduced in Stage 5.

## 2026-10-14: orphaned FIFO ticket recovery and crash boundaries

**Isolated snapshot only. No recovery scheduler, no production migration,
no auto-replay of a Provider Turn, no user process termination.**

The queue state machine now has two additional safety properties:

- Migration **v19** adds `execution_waiters.owner_generation` (NULL for
  older legacy waiter rows) and `managed_queue_recovery_audit`. New
  managed tickets are bound to the exact registered Owner generation.
  An expired managed ticket is **not** silently deleted by the normal
  generic TTL sweep; it must be reconciled with its Agent and OS owner
  evidence. Older legacy queue semantics remain unchanged.
- In opt-in `LocalAgentManager`, the original queue ticket INSERT and
  Agent `status=queued` update commit in the **same SQLite transaction**.
  Injecting an error into the Agent status update leaves no waiter or
  Provider work. Queued cancellation checks and deletes the exact ticket
  alongside the Agent status update in the same transaction. If admission
  already consumed the ticket, cancellation is refused; it never touches
  the promoted Provider Turn.

`src/managed-queue-orphan-recovery.ts` is a **default read-only**
verifier. Its bounded scan returns structured candidate/active/quarantine
states; it never calls a Provider. An explicit `apply:true` can only
commit when:

1. The durable ticket still exists with the precise Owner ID and
   generation. Its Agent is still `queued`, belongs to the same checkout,
   has exactly one waiter, and has **no active Agent Turn, Claim or managed
   execution**. An absent ticket is **not** a safe candidate: atomic
   promotion may already have committed.
2. The original registered Windows Owner PID and kernel process creation
   timestamp agree with the persisted ticket identity, and native OS
   verification establishes its **actual exit** in the **same boot**.
   A live or unqueryable PID, a mismatched/unknown boot identity or a
   claimed prior reboot are quarantined. Real across-reboot identity
   verification remains an independent release blocker.
3. The SQLite IMMEDIATE transaction rereads and compares every ticket,
   Agent, Owner and dependency field (CAS). It commits the exact ticket
   deletion, Agent `stopped` state and one immutable queue-specific audit
   event together. Failures roll back all three. It does **not** touch
   unrelated Claims, terminate processes or replay inference.

**Disposable native Windows process fault tests** exercise all three
persisted crash boundaries:

- `queued`, before promotion: verified lost Owner leaves a ticket that
  can be explicitly stopped, without Turn/Claim/Job.
- `promotion_rollback`, while committing: original queue ticket and
  `queued` Agent survive; no managed execution or Turn is present;
  recovered only after native Owner disappearance is established.
- `promoted`, after atomic ticket consumption and **before GO**: there
  is no ticket, but the managed Claim and a running Agent Turn remain;
  queue recovery returns `not_found` and cannot release, restart or
  re-run that ambiguous execution.

Additional tests inject failure at the final waiter deletion and an
Agent status mutation between observation and the recovery transaction,
requiring full rollback/CAS rejection. **Four pairs of independent
native Windows recovery subprocesses** race the same orphan queue ticket;
one—and only one—`stopped_without_dispatch` audit is committed in each
round, with no Provider request.

Typecheck/build and packaged Job smoke passed (`activeProcesses=0`,
`modelRequests=0`). Full `pnpm test`:
**415 cases / 407 passed / 8 skipped / 0 failed** across 107 test
files, no timeout, source SHA-256 unchanged. Receipt:

`releases/test-receipts/2026-10-14T10-19-37-563Z-0c1ff304-cc22-402f-b638-95df29b9b323.json`.

**Still blocked:** No automatic startup scanner, no safe cross-OS-reboot
rehydration of queued sessions, no authorized real reboot experiment, no
multi-hour stress soak or real Codex/Claude/OpenCode/Pi end-to-end
Turn/Resume coverage, and no Stage 5 service separation, shadow
migration, controlled production enablement or rollback drill. A
potentially dispatched/armed execution must still use the Stage 3
Windows Job/Claim recovery path, not the queue-ticket cleanup path.
