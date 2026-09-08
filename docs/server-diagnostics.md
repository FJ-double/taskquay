# Diagnosing a missing server or connector 502

## Process failures and lost results (2026-09-08)

Previously, managed commands and tracked tool failures called `endOperation`
without evidence, so the default empty array was persisted. A failed status was
not a durable exit-code record. Historical empty evidence cannot be recovered
by this change and is not backfilled with guesses.

New managed command completions persist bounded, versioned metadata inside the
existing evidence reference: server PID, process session ID, exit code, signal,
elapsed time, cumulative decoded-output byte count, and safe error fingerprints
and stack locations when a spawn/process error exists. No command, output body,
environment, credential or raw exception message is copied into this evidence.
Exit zero is process evidence only, not deployment or business acceptance.
Tracked tool exceptions and `isError` results also receive nonempty failure
evidence; an `isError` result does not itself explain the underlying cause.

The server records `process_started`, `process_start_failed`, `process_error`,
`process_finished`, `process_output_consumed` and `process_accounting_failed`
through the existing rotating diagnostics sink. Workspace, work-run, operation
and process-session IDs correlate lifecycle and output consumption with MCP
exchange logs. Output-consumption events include returned byte count and
truncation, not text. Recording failures must not prevent process exit or claim
release. Logging respects the existing level and retention limits.

Command responses now include operation/work-run IDs in text and structured
content. `work_task snapshot` exposes active child counts and recommends
`reconcile_and_finish_work` when a still-open run has no active managed children.
These counts describe the ledger, not arbitrary OS processes or untracked work;
the existing finish-time claim checks remain authoritative. Top-level runs are
not automatically marked completed or failed when one child fails.

After a missing response, first inspect the existing run (`snapshot`, then bounded
`history`) and existing agent/process state. Retry transient read-only status
requests in a bounded fashion; do not use a model polling loop. Retry a mutation
only after reconciling side effects and establishing it is safe. Neither a 502,
an HTTP 200, a tool error, nor an unknown process handle proves that work did not
execute. Empty-input `write_stdin` does not restart the process but drains output;
repeating a lost poll cannot replay its text. Nonempty input must not be resent
blindly. DevSpace does not automatically retry commands or model work.

Terminal evidence survives normal result consumption and process-session expiry,
but command output is still in-memory and consumptive. Hard termination or a
database failure can still leave incomplete accounting. There is no new durable
stdout journal, delivery acknowledgement, tunnel repair or automatic acceptance.
Read-only diagnostics of an old run cannot reconstruct its original missing output.

Regression coverage in `src/process-evidence.test.ts` exercises an unpolled
yielded failure, spawn failure, redaction, correlation IDs, claim release,
nonfatal logging errors, tracked exceptions/results and pending run reconciliation.
An injected accounting failure also verifies completion and claim release.

Validation: 53 tests in nine files passed serially (receipt
`2026-09-08T00-04-42-959Z-5ef32cb6-fafc-4b23-bb33-5f1e3bc560b2`), followed by
whole-project type checking and isolated backend compilation. The initial
sandboxed Windows interrupt test failed; the final isolated run with process
permissions passed. Existing MCP tests validate response schemas; no config
schema changed. On 2026-09-08 the backend was deployed with the old dist backed
up, without a live clean/build or UI rebuild. Before restart, managed claims,
waiters, active operations/executions and pending HTTP requests were zero. The
new server PID was 1120; local health returned `ok: true` and `/console/` returned
200 without a redirect. Remote host delivery and a real deployment were not
replayed or verified by this rollout. No historical task status was rewritten.

A connector 502 is not proof that a provider or worker failed. Check the local
`/healthz` endpoint and listener first, then compare server and tunnel timestamps.
A tunnel `initialize` error with `failure_source=connect`,
`transport_error_kind=dial` and `upstream_response_received=false` means it did
not receive an MCP response. Do not replay writes or start replacement workers
until their actual state is reconciled. Tunnel readiness alone is not evidence
that the local server is still reachable.

## Lifecycle evidence

Both `devspace serve` and the direct server entry point install diagnostics after
configuration loads. Events go to the existing stdout/stderr logger and a
synchronously appended `<stateDir>/logs/server-diagnostics.jsonl`. The file
rotates at 1 MiB to `.jsonl.1`, retaining one backup (approximately 2 MiB total).
This is best-effort append, not an fsync durability guarantee or audit journal.
Ordinary redirected stdout/stderr retention is unchanged. Use one serving process
per state directory; concurrent writers to the diagnostic file are not coordinated.

- `server_starting`, `server_listening`: distinguish initialization from a bound listener.
- Every event includes a random instance ID, PID, parent PID and monotonic uptime.
- `server_heartbeat` every 30 seconds: RSS, heap use, event-loop delay, pending HTTP
  count and oldest pending request age. This timer does not keep a process alive.
- `server_request_started/finished/aborted`: correlate MCP request lifetimes even
  when a response never finishes. All HTTP requests contribute to heartbeat counts.
  These request IDs belong to diagnostics, not the connector's upstream request IDs.
- `server_signal_received`, shutdown stage events and a 10-second shutdown waiting
  event: identify requested shutdown versus cleanup/draining that has not completed.
- `server_startup_failed`, `server_http_error`, `server_uncaught_exception`,
  `server_before_exit`, `server_exit`: narrow startup, bind, fatal and normal exit paths.

Logging respects `logging.level`; request details also respect `logging.requests`.
Use `info` to retain heartbeats and lifecycle events. Error summaries contain only
a bounded code, message fingerprint and up to eight basename/line/column locations:
no raw error message, stack text, environment, arguments, headers, query strings,
request body, credentials or task contents are added. Existing Node fatal-error
stderr behavior is preserved; review and redact original stderr before sharing it.
If file writes fail, a single `server_diagnostics_write_failed` event is attempted
on stderr; diagnostics do not replace the original failure or prevent startup.

## Limits and interpretation

The uncaught-exception monitor does not suppress Node's default crash behavior.
No unhandled-rejection handler is added. A hard Windows process termination,
SIGKILL, power loss or native abort may leave no exit event. A last heartbeat
without shutdown/exit evidence narrows the interval but does not identify who
killed the process. A blocked event loop cannot emit its heartbeat while blocked.
Failures before configuration/diagnostics installation still rely on stderr.
These changes do not add a supervisor, restart a service or repair tunnel state.

During the 2026-09-06 investigation, the last observed server HTTP log was
22:22:40 +08:00; the inspected tunnel log recorded connection-level 502s from
22:40:54 +08:00. Later checks found no listener on 7676 and no serving Node process.
No matching Windows application crash event was found. The process's exit cause
remains unknown; these observations must not be relabeled as a provider failure.

Deterministic tests cover request completion/abort, secret exclusion, rotation,
write failure, child-process natural/fatal/rejection/HTTP-error exits and shutdown
ordering. Source validation is not live activation; deploy and start the candidate
separately before expecting these events from an existing installation.

In this checkout, broader server tests and whole-project type checking were
blocked by missing installed `@modelcontextprotocol/server` and
`@modelcontextprotocol/node` packages already declared in `package.json`.
This is a separate source-installation finding, not proof of the earlier live
process's exit cause. During the subsequently authorized rollout, a frozen-lockfile
install restored the missing packages without changing the manifests or lockfile.
All 31 selected server, modern MCP, diagnostics and shutdown tests passed, followed
by whole-project type checking and an isolated production build. The candidate was
deployed on 2026-09-06; local health and console endpoints returned successfully.
No task was replayed and no tunnel configuration was changed.
