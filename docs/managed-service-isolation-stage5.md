# Stage 5 (partial): Persistent service ownership and Windows Job separation

Date: 2026-10-14. **Isolated Taskquay source-snapshot only. All new features
OFF in real Taskquay; no user-owned service, port, listener or production
state database touched. Disposable Windows services were started only
inside isolated temporary test directories.**

## Delivered

- v20 SQLite migration adds `managed_service_reservations`, a durable
  namespace for services with unique **service key, TCP port and state
  directory** across active services. Reservations are NOT Agent
  `execution_claims` and NEVER count toward four concurrent Agent slots.
  The registry stores the exact Owner ID, Owner generation and associated
  `managed_executions(kind='service')` ID. A different Owner may not silently
  adopt a service started by a previous generation.
- `ManagedServiceReservations.reserve` transactionally records service
  configuration and a **never-dispatched** execution identity, without
  launching any process, opening a port or invoking a model. The service
  data directory must exist and remain disjoint from the source checkout.
  SQLite unique conflicts roll back execution identity and audit writes.
- `confirmRunning` accepts a service only when its managed execution has
  been armed and moved to `running`, and the native Windows observer
  independently confirms the specific Owner and Runner creation identities,
  matching OS Boot ID and an **active named Windows Job**. Native reads
  precede SQLite IMMEDIATE CAS verification. Synthetic OS evidence is
  permitted ONLY under the Node test runner.
- `finalizeExited` never terminates a process. It requires an already
  committed terminal/released service execution with Job-empty evidence,
  same native Boot identity, terminated Runner and absent exact named Job.
  It then changes ONLY the matching service reservation to `released`
  atomically, freeing that port and state root for reuse. A running,
  unqueryable or still-existing Job prevents release. There is no
  lease-TTL deletion of live service reservations.
- Fixed a cross-version safety issue in the **legacy coordinator enqueue**
  path: its TTL sweep now deletes only `owner_generation IS NULL`
  legacy waiters. It cannot silently remove orphaned v19 managed waiting
  tickets before native Owner recovery.

## Actual isolated verification

`src/managed-fair-queue.test.ts` performs 24 separate FIFO rounds of
20 Agent reservations/releases each (**480 admissions and releases**),
with four global slots max and no remaining claims/tickets. It also
verifies legacy enqueue/acquire cannot TTL-delete a managed orphan ticket.

`src/managed-service-reservations.test.ts` checks:

- Two persistent service reservations do not consume any of four Agent
  capacity slots; service port/state-root/name conflicts fail atomically.
- Service state folders cannot overlap their worktree; wrong Owner is
  rejected; state writes fail closed under injected SQLite failures.
- A service cannot enter running without real armed Job evidence; it
  cannot free its port until a matching terminal/empty native Job proof.
- **Real Windows native test:** starts an independent long-running
  command service under one Windows Job and a short Agent under another
  Job. After the Agent exits and releases its claim, the native observer
  still sees the service Job alive. The service is then explicitly stopped,
  Job processes verified gone, and its service reservation released.
  Windows may need a brief bounded wait after job cancellation before
  named Job absence is independently observable; the proof requirement
  is **not** weakened.

All test commands are model-free and run in disposable temporary dirs.

## Remaining gaps; do not enable in production

The isolation primitive now includes an opt-in loopback service launcher,
native Job ownership and on-demand identity-checked health verification,
but it is NOT a production service supervisor. Multi-service restart,
independent process ownership, crash reconciliation, shadow migration,
backups, reversible cutover, real Windows reboot validation and
multi-hour live soak remain release blockers. Merely reserving a port
still does not mean that an OS socket has been bound.

Default safety posture: no daemon startup hook, no unconditional owner
adoption, no automatic claim/port unlock on heartbeat timeout, no
model call replay, no production database writes, no actual user process
termination.

## Same-source Git worktree concurrency (2026-10-14)

The full-suite stress run exposed a pre-existing intermittent Windows
Git worktree creation failure: two concurrent worktree creates for the
same repository competed over `.git/worktrees/*/commondir`. This was
unrelated to service reservations but relevant to four parallel Agents.
`src/git-worktrees.ts` now serializes **only Git metadata creation**
for the same resolved source root within one Node daemon instance,
not the independent Agent tasks after worktree creation.
`src/workspace-conversation.test.ts` adds eight simultaneous
worktree opens for the same repository and verifies eight distinct
complete worktree contexts. The focused worktree/Agent/service suite
passed. This in-process lock has since been supplemented with a
native Windows named mutex for separate daemons in one logon session.
The original per-process guard still prevents same-event-loop stalls.

## Verification ledger — 2026-10-14

Full `pnpm test` passed: **425 tests / 417 passed / 8 skipped /
0 failed**, 108 files. Test process exit code 0, source SHA-256 unchanged,
no timeout, no interruption. Receipt:

`releases/test-receipts/2026-10-14T11-22-57-397Z-2289e95d-8c56-42f9-afd6-24e3677aed74.json`.

`pnpm typecheck`, `pnpm build`, `git diff --check` and packaged
native Job smoke passed (`PACKAGED_PROVIDER_JOB_OK`,
`activeProcesses:0`, `modelRequests:0`). The build warns about
large UI chunks but succeeds. Live checkout HEAD was unchanged at
`00dcb20`.

The *first* full suite during this stage had an intermittent failure
in the pre-existing concurrent worktree metadata test (Git could not
read its new worktree `commondir`). It was investigated, the same-repo
in-process creation guard added, the eight-worktree stress test added,
and the **whole** suite rerun cleanly. No result was omitted.

**Remaining mandatory gates:** Actual service launcher and supervised
Job ownership, real socket bind/health checks, cross-daemon worktree
metadata arbitration, boot-restart tests on a machine authorized to
reboot, long-duration live-runtime soak, migration and backup rehearsal,
observability, feature flag safe defaults, staged production cutover and
rollback drill. No production code, SQLite, running MCP/agentd or service
configuration was modified.

## 2026-10-14: Loopback service launcher and cross-process Git mutex

The isolated snapshot now has an explicit ManagedServiceSupervisor
for a caller-registered native Windows Owner, with start, checkHealth
and stop methods. This implementation:

- Restricts the service to 127.0.0.1. It preflights the requested local
  TCP port and refuses an existing unrelated listener before reserving
  any service state.
- Assigns the bootstrap to its own Windows Job and persists the exact
  OS identity BEFORE dispatching a service command.
- Passes a cryptographically random per-launch health token only to
  that service. The service must answer GET /healthz with HTTP 200 and
  a matching X-Taskquay-Health-Token response header. A healthy-looking
  response from another process is not enough for confirmation.
- Uses native Job status in on-demand health checks. Stop verifies the
  precise Job disappeared and the original process exited before
  releasing the service state and port. A failed or uncertain native
  observation retains the reservation; a later explicit stop may
  recheck its existing exit proof.
- Fails closed for an externally occupied port, incorrect health token,
  an invalid Owner identity, or an attempt to bind publicly.

Real Windows tests exercised a working disposable HTTP service, its
healthy shutdown, the failed-health cleanup boundary, an unrelated
listener that must not be terminated, and forbidden public bind.
The compiled distribution was independently tested with the
scripts/test-managed-service-packaged.mjs smoke:
PACKAGED_MANAGED_SERVICE_OK, released service state, zero active
Jobs, zero model requests, and no remote network calls.

The source-specific Git worktree metadata lock now also uses the
Windows kernel named mutex in src/windows-git-metadata-mutex.ts,
asynchronously polled with a bounded waiting budget. Three
independent Windows Node processes successfully took the same mutex
without overlapping their Git metadata critical sections; a separate
process holding the mutex caused another timed-out process to fail
without stealing it. An abandoned mutex fails closed rather than
claiming the previous Git operation was safely completed.
Cross-Windows-session, cross-machine and post-abandonment reconciliation
are NOT solved by this first native implementation.

Full test suite: **431 total / 423 passed / 8 skipped / 0 failed**
across 110 files, test exit code 0, unchanged source SHA-256, no
timeout or interruption. Receipt:
releases/test-receipts/2026-10-14T11-47-15-819Z-2d720c82-d85b-4530-9e9a-10143aa00e2f.json

Still release-blocking: actual separate supervisor process ownership,
multi-service restart, periodic/persisted health monitoring, crashed
Owner revalidation, abandoned Git metadata reconciliation, approved
OS reboot testing, live long-duration soak, backup/restore migration,
controlled production enablement and rollback. None was attempted
on production Taskquay; the experimental feature stays disabled.

## 2026-10-14: independent process, periodic health journal and fail-closed recovery view

**Still isolated test-only; no startup registration, Windows service
installation, task scheduler job or live daemon replacement was made.**

- Migration **v21** adds `managed_service_health_journal`: ordered append-only
  service observations tied to exact Owner ID and generation.
- `src/managed-service-health-monitor.ts` records healthy, unhealthy or
  probe-error outcomes, with bounded read-only pagination. It verifies the
  service remains running under the same Owner generation immediately
  before appending. It coalesces concurrent probes and does **not**
  release a Job, free ports, relaunch commands or replay model requests.
  Errors and sensitive exception contents are not persisted in notes.
- `src/managed-service-host-fixture.ts` is an **explicit test-only
  standalone Windows Node process**. Its own Coordinator and Owner lease
  hold the service Job, while the separate Agent coordinator only uses
  the shared SQLite state. The host samples health periodically and
  keeps running after its initiating client's stdin closes.
- Real Windows tests verify: original Agent Claim release does not stop
  the independently owned service; native Job and health records remain
  present while the supervisor lives; a forced supervisor termination
  closes its Job but **does not silently mark the persistent service
  reservation released**, and does not restart the command.
- `src/managed-service-recovery-view.ts` provides strictly **read-only**
  native identity checks and a bounded scan of active service records.
  A verified running Owner and Job appear as `active`; exact original
  Owner and Job absence is classified `orphan_review` requiring
  explicit reconciliation. A prior Boot or ambiguous native probe is
  quarantined. No automatic resource unlock is exposed.
- Additional fault injection proves an HTTP health check failure and
  a SQLite health-journal insert failure preserve the running reservation;
  concurrent probes commit at most one health entry. A Windows
  TerminateProcess is not conflated with successful graceful STOP.

Full regression after these changes: **436 total / 428 passed / 8
skipped / 0 failed**, 111 test files, source hash unchanged, exit 0,
no timeout. Receipt:
`releases/test-receipts/2026-10-14T12-23-11-842Z-96c4eb59-8fa6-44a3-be76-be3d70294e83.json`.
Typecheck, build, git diff check and packaged service Job smoke passed:
`PACKAGED_MANAGED_SERVICE_OK` (Job closed, registered state released,
zero model requests, no external network). Production checkout HEAD
remained `00dcb20`.

**Unfinished before production:** A hardened independently installed and
managed supervisor (the standalone host is currently a test fixture),
full non-test startup/configuration and ACLs, multi-service concurrency
and restart policy, OS authenticated operator control, crashed-Owner
recovery actions based on preserved native proofs, prior-Boot identity
validation, real multi-hour soak, backup/shadow migrations, staging
release and rollback drill. Feature activation stays OFF.

## 2026-10-14: experimental control hardening and bounded health alerts

**No production service was launched or modified.** All new operational
controls below belong to the isolated, explicitly test-gated host fixture.

- The native same-Windows-session Owner singleton
  (src/managed-service-owner-singleton.ts) hashes the canonical state
  directory into a Windows named mutex. Starting a second host against
  that directory fails closed while the first host still holds its Job.
  It never steals the mutex on timeout, and an abandoned owner is treated
  as requiring reconciliation, not as automatic permission to restart.
- The explicit test-only local control
  (src/managed-service-local-control.ts) uses a random Windows named-pipe
  name and a separate 256-bit, constant-time checked capability token.
  The bounded single-request protocol supports STATUS, HEALTH and STOP.
  A bad token is rejected before STOP can reach the native Job. A
  disconnected controller socket does not terminate the service.
  Current STATUS is read from SQLite, not the stale creation snapshot.
  Control capabilities are sent only through the test harness's private
  spawn stream and are never persisted in SQLite or service logs.
- **Security limitation:** Windows default named-pipe DACL was NOT
  independently audited for cross-account access. The 256-bit token is
  not a substitute for verified OS ACL enforcement or a production
  operator-authorized installation. Never expose this prototype as a
  production remote-management API.
- src/managed-service-launch-config.ts enforces an explicit testOnly
  marker and environment flag, realpath-validated isolated temp roots,
  disjoint checkout/state/work directories, strict known properties,
  valid port and service name, and an exact single Node script command
  beneath the disposable checkout. It rejects arbitrary shell chaining
  or a non-temporary production workspace.
- readServiceHealthAlert derives a bounded, restart-safe alert from the
  persistent health journal: three consecutive unhealthy/probe_error
  samples trigger an alert, a subsequent healthy sample clears it.
  This is a **queryable alert state**, not an external paging service.
  Neither alerting nor probe failure changes service reservations,
  process ownership, Job lifetime, or the four-Agent capacity.

Native Windows tests proved the wrong token cannot STOP a service, an
authorized STOP releases exactly that service after Job-exit evidence,
second-owner mutex admission is refused, and the isolated config blocks
production-like paths and unapproved commands. Alert failure/recovery
and no-resource-mutation cases were tested as well.

Still release-blocked: independent production host packaging, verified
Windows pipe/registry/file ACLs, secure config/secret delivery, operator
identity authorization, multi-service lifecycle policy, manual recovery
and rollback, live multi-hour soak and approved OS-reboot tests.

## 2026-10-14: single-owner mutex, capability-checked control and test-only configuration

**Snapshot/test mode only. No Windows service was registered and no live
Taskquay daemon or user service was restarted.**

- src/managed-service-owner-singleton.ts holds a native Windows named
  mutex for the canonical state directory. A second host is refused
  while the original host runs. An abandoned mutex is not interpreted
  as proof that database service reservations may be reused.
- src/managed-service-local-control.ts is an ephemeral Windows named
  pipe with a random pipe name and separate 256-bit capability token.
  It handles one bounded request per connection (STATUS, HEALTH or STOP).
  The token is verified in constant time; an unauthorized STOP leaves
  the service Job running. A legitimate STOP follows the existing
  native Job-exit proof path. STATUS reads CURRENT SQLite state rather
  than the original reservation snapshot. This interface is only
  enabled in the disposable test host.
- **Important limitation**: Windows named-pipe default DACL / separate
  account access has not been audited. A capability token is not a
  substitute for OS-level operator authorization. No production
  management endpoint has been enabled.
- src/managed-service-launch-config.ts validates explicit testOnly
  marker and environment gating, realpath-checked temporary
  directories, disjoint checkout/state/data directories, allowed
  properties, and exact single-script Node command. A user production
  checkout or arbitrary shell command is rejected before any Job
  reservation or launch.
- readServiceHealthAlert derives a queryable three-consecutive-failures
  alert state from the existing durable v21 health journal. Healthy
  samples reset it. No automatic termination, restart, Claim release
  or external notification occurs based only on an HTTP failure.

Native focused tests confirmed wrong-token STOP rejection, authenticated
STATUS/HEALTH/STOP, same-state duplicate-owner rejection, production-
like config refusal and persistent-failure alert thresholds, while
retaining old Owner crash and service-job isolation checks.

Full regression after all changes: **440 total / 432 passed / 8 skipped /
0 failed**, across 112 test files. Exit code 0, no timeout,
source SHA-256 unchanged during tests. Receipt:

releases/test-receipts/2026-10-14T12-48-11-385Z-eee7f8a1-60a5-4482-9625-7995a83145bc.json

pnpm typecheck, pnpm build, git diff --check and packaged Windows service
smoke all passed (PACKAGED_MANAGED_SERVICE_OK, released service state,
zero running Job members and model/remote requests). The production
checkout HEAD remained 00dcb20, unmodified.

**Still required before Stage 5 completion**: actual production
supervisor executable/installer and distinct service account,
verified Windows named-pipe/file/process ACLs, safe credential
delivery, operator identity and policy authorization, external
alert delivery, independent multi-service restart/failure policies,
native crash/orphan evidence reconciler, true Windows OS-reboot
identity check, multi-hour live soak, shadow migration/backup and
tested rollback. Test-only controls must NOT be promoted by merely
removing the environment gate.

## 2026-10-14: native ACL inspection and durable Git metadata crash quarantine

The ACL investigation used **read-only native Windows security descriptor
queries** on disposable named pipes and temporary directories. No user
accounts, security descriptors, persistent services or production files
were modified:

- \`scripts/probe-windows-pipe-acl.ps1\` uses the native Windows
  \`GetSecurityInfo\` API against a live pipe handle (kernel object
  semantics), then converts its DACL to SDDL. The disposable default
  pipe showed Allow/Read entries for **Everyone and Anonymous**.
  A second test inspected the **actual experimental Node control pipe**
  and verified it cannot pass an exclusive-access assessment.
- \`src/windows-service-security-audit.ts\` conservatively screens
  broad Allow ACEs and deliberately does NOT return a production
  authorization verdict from lexical SDDL alone. Native effective
  access under independent restricted user tokens, service-account
  impersonation, integrity levels, and ACL-at-pipe-creation enforcement
  remain untested. The current named-pipe interface remains **test-only
  and production-disabled**. Its 256-bit token reduces unauthorized
  command risk but is no replacement for file/pipe ACLs.
- \`scripts/probe-windows-state-acl.ps1\` examines only disposable
  directories under the Windows temporary root. On this host, sample
  temp directories inherit Allow ACEs for other account/group SIDs;
  their effective cross-account access is **unverified**. Do not
  place long-lived control secrets or production service databases
  in a directory without a verified restricted DACL.

The named Git mutex also had a subtle crash window: an abandoned mutex
is flagged only to the first waiter; a second waiter may subsequently
acquire the same kernel object normally. It is therefore insufficient
to reject \`WAIT_ABANDONED\` only once.

- \`src/windows-git-metadata-mutex.ts\` now writes and fsyncs a durable
  \`taskquay-metadata-operation.pending\` marker in the Git common
  directory **before** a protected mutation. The marker is removed
  only if the callback succeeds; an exception or force-killed native
  owner leaves it intact. On mutex abandonment, a missing marker is
  created before releasing the abandoned ownership, when possible.
- **Any subsequent acquisition sees the marker and fails closed**,
  even if the kernel mutex is free. There is no automatic unlock API.
  Operator review must precede future mutation, and no production
  repository was accessed by the crash tests.
- \`src/git-metadata-recovery-inspection.ts\` performs bounded, strictly
  read-only verification of \`git worktree list --porcelain\` and Git
  worktree \`commondir\` / \`gitdir\` backlinks. It reports missing
  pointers, prunable entries and pending markers, but cannot run
  \`git worktree prune\`, \`repair\`, or remove locks. A clean report
  is NOT automatic approval to delete an existing quarantine marker.

Native Windows test cases force-killed only disposable Git mutex holder
processes, proved the immediate waiter rejects abandoned ownership,
then proved a **second retry is also rejected by the persisted marker**.
Read-only inspection detected deliberately corrupted metadata without
repairing it. The old independent-worktree concurrency tests passed.

**Outstanding release gates:** The native pipe/file ACLs must be
actively restricted and tested under different security principals;
the marker write must be proven on every supported crash/volume type;
explicit manual repair/release policy, OS reboot tests, production
shadow migration, long-duration soak and reversible canary rollout
remain missing. The live Taskquay/MCP/agentd stay untouched.

## 2026-10-14: native anonymous-principal ACL proof (disposable only)

The new `scripts/test-windows-anonymous-service-acl.ps1` creates a
disposable private directory and Windows named pipe. It protects the
directory from inherited broad Allow ACEs, allowing the exact current
user SID, SYSTEM and built-in Administrators. It creates the pipe
using `NamedPipeServerStreamAcl.Create`, supplying a restricted
`PipeSecurity` descriptor **at the time of kernel object creation**,
not after a public listener can be opened.

A native `ImpersonateAnonymousToken` OS impersonation was used to
attempt real access via `CreateFileW` and the Windows filesystem:
the anonymous principal received error 5 (access denied) for the pipe
and could not read the private file. The authorized launching user
could access both. The test does not set a production ACL or create
a user/service account, and cleans up its temporary files and pipe.
It establishes an actual kernel access check for the anonymous SID,
**not** full ordinary cross-account, service-account, restricted-token,
or integrity-level policy verification.

`src/windows-service-security-audit.test.ts` now runs this proof as
part of the test suite (focused native test 1/1 passed). The full
source-snapshot suite passed **445/445 outcomes: 437 passed, 8 skipped,
0 failed** across 113 files. Exit 0, complete output receipt, identical
source hash before/after, no timeout:

Build, typecheck, diff check and isolated packaged service smoke also
passed (`PACKAGED_MANAGED_SERVICE_OK`, released state, no active Job,
zero model/remote calls). Production checkout remained at `00dcb20`.

`releases/test-receipts/2026-10-14T13-53-27-717Z-fb3d4418-d178-4de9-a4de-6b11248b6941.json`.

**The existing Node-managed service pipe remains on its default
DACL and is NOT promoted.** Integration of a creation-time-secured
pipe backend and test of a real second ordinary principal are the
next necessary steps. Production and all real service data remain
untouched.

## 2026-10-14: test-only restricted-control pipe broker integration

Subsequent to the earlier anonymous-only proof, the disposable service
host's `ManagedServiceLocalControl` now uses a PowerShell 7 child broker
(`scripts/windows-service-control-broker.ps1`) instead of
`node:net.createServer`. This broker creates a named pipe with
`NamedPipeServerStreamAcl.Create`, an explicit DACL granting the current
Owner SID, SYSTEM and local Administrators, and **no post-bind ACL
replacement race**. The broker is assigned to an independent
`KILL_ON_JOB_CLOSE` Windows Job before it gets the GO command. Native
OS ACLs gate pipe access, and the Node Owner separately authenticates
the request's 256-bit per-launch token before allowing STATUS, HEALTH
or STOP. Production activation is still expressly disabled.

The real experimental control endpoint denies both the native anonymous
principal and a newly derived Windows restricted token at `CreateFileW`
(ERROR_ACCESS_DENIED = 5). The disposable reference pipe also proves
that the same unrestricted launch account is allowed. This does **not**
prove access boundaries against a separate ordinary user, true service
account, all integrity levels, or broker restart/recovery policies.

Testing discovered a real Windows PowerShell issue: disposing the
StreamWriter for a client which opened the pipe then disconnected
without sending bytes raises `Pipe is broken`; it previously terminated
the broker. The cleanup now catches this expected broken-client case,
preserves the service Job, and lets a subsequent STATUS succeed. Native
test coverage was expanded accordingly. Authenticated STATUS, HEALTH,
STOP, incorrect-token STOP rejection, service-job separation, singleton
and the real native ACL checks all passed: **9/9 focused tests**.

Full `pnpm test` passed **447 total / 439 passed / 8 skipped / 0
failed**, 113 files, exit 0, before/after SHA-256 identical, no timeout.
Receipt:
`releases/test-receipts/2026-10-14T14-46-33-651Z-ec2eb3e9-b3c9-49a5-bf98-bdc0c8fd4991.json`.
`pnpm typecheck`, `pnpm build`, `git diff --check` and packaged
managed-service smoke passed (released, inactive Job, zero model and
remote requests). Live source checkout HEAD stayed `00dcb20`.

**Remaining:** independent cross-account security principal acceptance,
production-grade operator credential delivery, state/data directory
enforcement for the actual service, broker crash restart guarantees,
explicit Git metadata recovery approval and audit, shadow database
migration/backup/rollback, multi-hour soak, real reboot validation and
reversible production cutover. No production service or database touched.

## 2026-10-14: explicit Git quarantine manual approval (disposable repositories only)

New `git-metadata-manual-recovery.ts` adds a test-only operator-driven
release path for Git metadata crash markers. It requires a deliberate
review affirmation, reviewer identity, ticket, reason and **exact
SHA-256 of the existing marker**. The target must be a canonicalized
disposable temp repository with its Git common directory inside that
repository; production paths and normal unattended daemons are
disallowed. The operation acquires the **same native Windows kernel
mutex name as worktree metadata writes** and refuses a busy or
abandoned mutex. Under the acquired mutex, it repeats bounded read-only
worktree and commondir/gitdir backlink inspection. Any anomalies other
than the expected pending marker block release.

Before changing the guard file, an independent JSON approval record is
created via exclusive create and `fsync`. The unchanged original marker
is then renamed within the same Git common-dir volume to a dedicated
audit archive. The original bytes remain available for review; no Git
prune/repair, TTL unlock or agent replay occurs. Audit failure keeps
the marker and prevents admission. The file audit is a disposable
test proof, **not** production-grade independent operator auth,
append-only/tamper-proof storage or cross-filesystem crash durability.

Windows native and regression test **10/10 passed**, including wrong
approval/hash, broken Git metadata, live mutex contention, audit write
failure, non-disposable path rejection and verified release/admission.
The full `pnpm test` suite passed **452 total / 444 passed / 8 skipped
/ 0 failed** across 114 files, exit code 0, identical before/after
source SHA-256, no interruption or timeout. Receipt:
`releases/test-receipts/2026-10-14T15-18-06-148Z-0c5595c1-8350-4c6d-b989-17bdecbd7564.json`.
Typecheck, build, diff check and packaged Windows service smoke passed
(Job inactive, zero model/remote requests). Production still off.

Next evidence gate: an entirely disposable SQLite source backup, v17
to latest shadow migration, integrity checks, injected-failure rollback
and restoration rehearsal. Live Taskquay services and state stay untouched.

## 2026-10-14: disposable v17-to-v21 SQLite backup, shadow migration and rollback

The isolated source snapshot now includes a strictly test-gated fixture
for creating a real version-17 SQLite schema (`createTestOnlyVersion17Fixture`);
it rejects in-memory, nonempty or non-temporary databases. The normal
`migrateDatabase` entry point retains its exact production behavior.
The new `src/db/shadow-migration-rehearsal.test.ts` creates a
disposable v17 source with one workspace, one legacy execution claim and
one FIFO waiter. A read-only source handle runs better-sqlite3's SQLite
online Backup API. Only a separately copied shadow DB receives the
v18-to-v21 migration.

All 21 schema history records are checked, as are unchanged row counts,
old `execution_id=NULL`, the nullable waiter expiry after v18,
`integrity_check=ok` and zero `foreign_key_check` failures. The
original source's and backup's SHA-256 hashes remain identical before
and after migrating the shadow. A deliberately incompatible version-17
shadow migration entry forces failure; the test asserts the source and
backup are untouched and that restoring from the backup produces
byte-for-byte identical data and the original v17 schema.

Focused tests **4/4 passed**. The full suite passed **455 total /
447 passed / 8 skipped / 0 failed** across 115 files, exit 0,
before/after source SHA-256 identical, no timeout or interruption.
Receipt:
`releases/test-receipts/2026-10-14T15-29-38-910Z-6fd06dbb-0901-4561-8ae3-2fb4c330cc8d.json`.
Build, typecheck, diff check and packaged Job smoke passed (no active
Job, zero model/remote calls).

Limitations: this was a synthetic v17 fixture, not real production data;
the procedure does not yet cover a multi-hour WAL workload, secure
off-machine backup retention, production operator permission checks or
actual cutover and rollback. Live Taskquay state/services are untouched.

## 2026-10-14: bounded continuous native Windows FIFO / service / WAL soak

Added `scripts/run-isolated-soak.ts`, an explicit Windows-only,
time-bounded infrastructure soak runner. All work uses random disposable
Temp roots. Two native managed-Owner SQLite connections maintain the
same WAL state while synthetic Agent admission tickets exercise
work-conserving 4-claim FIFO fairness. A second OS process owns each
disposable loopback service/Windows Job; client stdin is disconnected
without stopping it, while private authenticated STATUS/HEALTH/STOP
is repeatedly exercised. Native WAL `BEGIN IMMEDIATE` contention
must yield SQLITE_BUSY for another connection; integrity and foreign
keys are periodically checked. No model/provider process is launched.

The initial 30-second tests revealed an intermittent true control
availability failure: after several clients connected to a native
pipe and immediately closed without a command, Windows could invalidate
its asynchronous server handle. The broker's subsequent
`WaitForConnection` threw an IOException (pipe being closed);
the separate service host was alive while the control endpoint
had disappeared (ENOENT). Broker handling now recognizes only native
I/O/disposed-handle failures, disposes the invalid instance and
recreates the replacement with the same **creation-time restricted
DACL**, rejecting other failures. An additional native regression
does four sequential abrupt disconnects, STATUS after each, confirms
the service Job stays active, and checks real anonymous access denial
on the recovered pipe. Nine Windows service/security focused tests pass.

The independent 120-second bounded soak completed successfully in
122.91 seconds: **360 FIFO rounds; 2160 synthetic admissions; 1800
FIFO non-barging checks; maximum four simultaneous claims; 90 verified
WAL SQLITE_BUSY denials and integrity samples; 120 health polls;
1074 persisted service health journal records; 24 client-drop/recoveries;
two independently started and stopped native Job-owned service
supervisors; zero remaining claims/waiters; final DB integrity `ok`.**
Observed test runner RSS peak: about 193 MB; maximum measured
WAL file: about 4.19 MB. The entire disposable tree was cleaned.
The standalone fsync'd test receipt includes the selected source
manifest hash and is at:
`releases/soak-receipts/2026-10-14T15-51-40-430Z-30658eb4-9f1e-42a8-9ef9-daa69ee2e643.json`.

Final regression `pnpm test`: **455 total, 447 pass, 8 skip,
0 fail** across 115 files; exit 0, stable before/after SHA-256,
no timeout or interruption. Receipt:
`releases/test-receipts/2026-10-14T15-55-50-674Z-d4194d83-37fa-4409-80f7-ca36182251de.json`.
Build, typecheck, diff check and packaged service Job smoke passed;
zero remote/model activity. This is NOT real 4-Provider concurrency
nor a multi-hour production-style soak: extended continuous uptime,
separate Windows identities/ACLs, broker crash restart, full reboot,
real workload and production rollback remain mandatory release gates.

## 2026-10-15: independently segmented soak, strict cumulative receipts

Enhanced the native synthetic Windows soak runner with periodic memory,
heap and WAL-size observations, checked SQLite PASSIVE checkpoints and
synthetic queue-to-admission p50/p95/p99/max latency. New helper
`src/isolated-soak-summary.ts` and the explicit receipt-only CLI
`scripts/summarize-isolated-soaks.ts` aggregate 2–24 successful
non-overlapping completed segments, requiring matching selected-source
fingerprints, zero resource residuals, zero checkpoint failures and
no remote/model activity. The report labels the summed durations
as **separate disposable test segments, never continuous uptime**.
Summary contract tests passed 2/2.

Two segments of the same tested version passed: 60 seconds requested /
63.24 actual and 120 requested / 122.92 actual. Cumulative measured
186.16 seconds across 540 FIFO rounds, 3,240 synthetic admissions,
2,700 FIFO non-barging assertions, 135 native WAL writer contention
denials, 36 abrupt client disconnect recoveries, four exited Job-managed
service supervisors, 0 residual claims/waiters, and all 36 checkpoint
samples returned busy=0. Worst segment synthetic FIFO p95=8.744 ms,
maximum wait=27.361 ms; max sampled host RSS around 169 MiB and
WAL around 4.00 MiB. Resource sampling cannot establish multi-hour
memory leak behavior. Cumulative receipt:
`releases/soak-receipts/cumulative-2026-10-14T16-11-59-080Z-5803dbee-b3f2-4dcf-83d9-c2e737e8e234.json`.

The first all-suite verification caught a previously latent test
fixture race: after authorized STOP, the `stopChild()` cleanup could
write to already closing stdin and produce uncaught `EPIPE`.
That full suite had 457 tests, 448 passed, 1 failed, 8 skipped;
the failure receipt was retained. Fixed the fixture-only cleanup
to avoid repeated STOP writes and handle the stream closing race
without modifying release logic. Focused reproduction passed 5/5
independent invocations. The final full suite passed **457 total /
449 pass / 8 skip / 0 fail**, 116 files, exit code 0,
stable before/after source fingerprint, no timeout or interruption:
`releases/test-receipts/2026-10-14T16-19-01-662Z-981596c4-b4c1-413a-b8c9-1c19e689e1d0.json`.
Typecheck, build, git diff check and packaged native Job smoke passed.

The longer-term gates still include multiple hours of independent
segments, one truly uninterrupted multi-hour instance, ordinary
cross-account Windows ACL verification, actual Provider concurrency,
controlled OS reboot and reversible production deployment. No live
Taskquay/MCP/agentd or real state was touched.
