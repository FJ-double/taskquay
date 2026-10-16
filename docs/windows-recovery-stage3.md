# Stage 3 — Windows identity and evidence-gated claim recovery (2026-10-14)

## Scope and safety

Implemented **only** inside the local source snapshot (`<source-snapshot>`).
No production daemon calls the verifier, no periodic recovery scan exists,
and no real Taskquay database or live process was modified or terminated.
The experimental managed Provider/command gates remain OFF.

## Trust rules

The following are **not proof** of a dead execution:

- Missing heartbeat, timeout, an aging claim, or a dead PID alone
- Matching Windows PID and creation timestamp alone (an exited process may
  remain queryable while another process holds a handle)
- A different boot timestamp by itself (clock adjustment is possible)
- A different Boot GUID by itself; unverified runtime-generated IDs
- A named Job whose query fails, which is still present even with zero
  active members, or a stopped/starting execution with no durable armed Job
- A callback error or a Provider result without the corresponding Job proof

`windowsProcessIdentityStatus` reads both native **creation and exit**
FILETIMEs. Live matching identity requires creation time match AND zero
exit FILETIME; a different creation time or nonzero exit FILETIME means the
original process is gone. A failed or access-denied process query is
**unknown**, never presumed dead.

`windows-recovery-observer.ts` requires a specific
`managed_executions` row linked to exactly one owner-generation identity
and claim. It validates the persisted full Job name
(`Local\\taskquay-job-<UUID>`), runner PID, runner creation time,
armed evidence and matching owner/runner kernel Boot ID. It checks:

1. For the **same boot**, original Owner and Runner must both be absent or
   have different native creation identities, and opening the **exact
   named Job** with only `JOB_OBJECT_QUERY` rights must return Windows
   object-not-found. Job query permission errors are quarantined.
2. For a **prior boot**, both kernel Boot GUID AND full NT BootTime must
   differ; either field alone changing is quarantined. A real across-reboot
   validation has NOT yet been completed, so production enablement remains
   forbidden.
3. If an old Owner identity is still running, return `active`; if any
   evidence is incomplete, inconsistent or unqueryable, return
   `quarantine`. A `starting` execution with no armed Job is **never**
   automatically released, even if its original Owner was forcibly exited.

These checks return a **candidate**, not authorization to replay paid
inference or change the Provider's recorded historical outcome.

## Atomic guarded recovery

`windows-recovery-transaction.ts` exposes an internal, default
**read-only** `inspectManagedRecovery(sqlite, executionId)` API. Only when
explicitly called with `{apply:true}` and native evidence (or with an
injected synthetic probe **inside Node's test runner**) can it commit.
It never runs automatically at daemon startup.

After observing Windows state **outside** any SQLite transaction, an
`IMMEDIATE` transaction rechecks every persisted snapshot field,
version, owner generation, exact claim identity and exactly-one-claim
cardinality. It:

- Marks an interrupted nonterminal execution `terminal/interrupted`
  (never claims to have obtained a lost successful Provider result).
- Records `job_empty_verified` or `prior_boot_verified` evidence and
  transitions resources to `released` with an immutable audit trail.
- For an Agent, updates the WorkLedger receipt if unfinished and fences the
  LocalAgentStore session as `reconcile_required`. The original
  `provider_session_id` remains available for **manual observation**,
  not unverified automatic continuation.
- Removes **only** the matching claim and marks its original Owner dead.
  No `taskkill` by name/PID or unrelated claim modifications.

If the final claim deletion fails, ALL state changes roll back. A stale
expected version is rejected; a repeated recovery cannot delete another
claim. No operation restarts the Provider or replays any model request.

## Actual isolated Windows verification

- `provider-owner-crash.test.ts`: creates three disposable owner processes
  with temporary SQLite and Windows Job containers. Termination occurs only
  for the **fixture owner**, at (a) admitted-before-fork, (b) armed-before-GO,
  and (c) running. It confirms original claims remain immediately after
  owner death, and the kernel kills Job descendants.
- Native read-only observation returns `quarantine` for admitted-before-fork
  (no Job proof), and a `candidate` for the two Job-armed crash cases.
- The tests inject a SQLite `BEFORE DELETE` abort: recovery rolls back
  release and keeps the original claim. After removing the injected error,
  exact proof permits a one-time release; repeat calls return `not_found`.
- `windows-recovery-observer.test.ts`: checks live owner, live runner,
  uncertain process, present/active/unknown Job, unverified boot, GUID-only
  and timestamp-only drift, and missing armed information all fail closed.
- `local-agent-managed-turn.test.ts`: a **test-only simulated observation**
  checks that claim deletion, Agent `reconcile_required` and WorkLedger
  unknown-outcome status commit together. This is not a live owner recovery.

**Tests:** `pnpm typecheck` passed, **17/17 targeted tests** passed.
`pnpm test` full suite passed **379 total / 371 passed / 8 skipped /
0 failed**, 102 test files, source hash unchanged, no timeout.

Receipt:
`releases/test-receipts/2026-10-14T08-36-53-694Z-62df3bf3-e39a-41d9-a345-5d2dca0e73ca.json`.

`pnpm build` and compiled packaged Provider Job smoke passed:
`PACKAGED_PROVIDER_JOB_OK`, `activeProcesses:0`, `modelRequests:0`.

## Still not production ready

1. **No real reboot validation:** test before and after a controlled OS
   restart on an isolated machine, proving the loader GUID and BootTime
   change as expected. Do not reboot the user's active machine here.
2. **No automatic scanner or owner-lease lifecycle:** implement heartbeat,
   CAS reacquisition, collision resistance, and precise backoff without
   killing live tasks. Current successful tests are explicit offline calls.
3. **No full Provider lifecycle signoff:** Codex metadata handshake passed;
   Claude/OpenCode/Pi SDK imports alone are NOT Turn/resume proof.
4. **No four-way fair FIFO queue, long-lived-service isolation, migration
   rehearsal, production shadow verification, or rollback cutover.**

Keep default-off flags and the production repository unchanged.

## 2026-10-14: bounded recovery scans, Owner lease and two-process CAS

The isolated `source-snapshot` now includes:

- `src/managed-owner-lease.ts`: an explicit **owner-generation heartbeat**
  (30-second interval, 95-second maximum silence before refreshing at new
  admission). The timer is unref'd and stopped during managed Agent/command
  shutdown. A failed SQLite write, missing owner, wrong PID, mismatched
  generation, or dead owner **fails closed for NEW admissions**. A stopped
  timer never marks an owner dead or releases its Job/claim; in-flight work
  is not killed because a heartbeat is missed.
- `src/provider-managed-dispatch.ts` and `src/process-sessions.ts`:
  start that lease only for the **opt-in managed experimental path**, verify
  it before admission and stop it at manager shutdown. The legacy nonmanaged
  path remains unchanged and production experimental flags remain OFF.
- `src/windows-recovery-scanner.ts`: a bounded, paginated
  **observe-only** scan by exact managed execution ID and optionally exact
  checkout root. Maximum 100 records per call; at least 60 seconds of
  silence before expensive OS queries. Fresh heartbeats defer observation,
  but **staleness alone never qualifies a claim for release**. The scanner
  returns structured `heartbeat_recent`, `active`, `candidate`,
  `quarantine` or `invalid_record` states and has **no recovery-apply
  method or write-side SQL**.
- `src/windows-recovery-race-worker.ts` and
  `src/windows-recovery-concurrency.test.ts`: two independent disposable
  Windows recovery processes race to apply **native** OS evidence against
  the SAME owner-crash fixture's temporary SQLite database. Exactly one
  process commits a release; the other sees no claim or a CAS conflict.
  Exactly one release audit is recorded. No synthetic PID/Job probe is
  used in the competing recovery subprocesses.

Additional tests:

- `src/managed-owner-lease.test.ts`: exact generation heartbeat, stop
  semantics, intentionally dead owner, injected SQLite heartbeat failure
  followed by matching-owner recheck, and silence revalidation.
- `src/windows-recovery-scanner.test.ts`: SQLite `query_only=ON`
  read-only observation, bounded keyset pagination, recent heartbeat
  deferral, exact root scope and invalid cursor/limit rejection.

**Verification:** all **8 new targeted tests passed**. Combined real
managed Agent, owner-crash, scanner and lease regression **18/18 passed**.
`pnpm typecheck`, `pnpm build` passed. Full suite:
**387 tests / 379 passed / 8 skipped / 0 failed**, 105 files, source hash
unchanged throughout; receipt:

`releases/test-receipts/2026-10-14T08-56-30-979Z-09b8fc8f-12d8-4766-91c9-1035612fe750.json`.

Packaged Windows Job smoke: `PACKAGED_PROVIDER_JOB_OK`,
`activeProcesses:0`, `modelRequests:0`.

**Release blockers remain:** This is NOT an automatically running
recovery scanner and contains no startup hook or scheduler. The read-only
scanner must not be confused with the separate explicit `apply:true`
recovery transaction. The native Boot ID still lacks **across-real-reboot**
validation, and randomized owner/OS contention has not yet undergone
production-like soak testing. Stage 4 four-agent FIFO, Stage 5 service
isolation and staged deployment have not started. Live Taskquay remains
unchanged, with all new protections disabled in production.

## 2026-10-14 native recovery race repetition

The temporary Windows owner-crash recovery test now runs **six separate
rounds**. In each round, a disposable owner is terminated after durable Job
arming, its Job subprocess disappears, and two separate recovery processes
race against the same exact Claim. Exactly one of the two processes commits
the resource release and one audit entry. **6/6 passed**, with no model
calls. This is repeated concurrency verification, not a multi-hour soak
or real OS reboot validation.

Full regression: **402 tests, 394 passed, 8 skipped, 0 failed**,
106 files. Receipt:
`releases/test-receipts/2026-10-14T09-23-59-830Z-aacf0a75-1130-4395-be47-eb9132bc7de0.json`.
