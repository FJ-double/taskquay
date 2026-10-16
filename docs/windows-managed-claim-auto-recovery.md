# Windows managed Claim automatic recovery

The managed Windows execution path now performs a bounded, evidence-gated
recovery pass after startup (2 seconds) and every 30 seconds thereafter.
This recovery loop is **only active when** the separately staged
`TASKQUAY_EXPERIMENTAL_MANAGED_WINDOWS_COMMANDS=1` feature is enabled.
The default legacy command path is unchanged. Do not enable the staged runner
on a live host without its independent release acceptance.

## What the heartbeat does

- The managed owner writes a heartbeat every 30 seconds.
- An owner with less than 95 seconds of heartbeat silence is **not examined**
  for automatic release.
- Silence of 95 seconds only triggers native Windows identity inspection. It
  never deletes a Claim or implies that child processes have exited.
- Native evidence must establish the **same boot**, exact prior Owner and
  Runner identities are absent/reused, and the exact named Windows Job is
  absent. A Job still active, empty but present, or unqueryable is insufficient.
- Prior-boot candidates remain quarantined until reboot-identity recovery has
  its own field validation. Legacy and service Claims are not auto-released.

## Release protocol

The daemon scans at most 25 records per pass with a persistent in-memory keyset
cursor, wrapping after the final page. For an eligible managed command/agent:

1. Read the stale heartbeat and durable execution/Claim identity.
2. Verify the native OS state outside the SQLite transaction.
3. Re-read the heartbeat and compare Owner identity, execution generation and
   state version under a single `BEGIN IMMEDIATE` transaction.
4. Atomically persist `interrupted` and native exit evidence, reconcile
   any exact linked command or Agent receipt, release the exact Claim and
   mark the old Owner dead. A failed ledger or compare-and-swap rolls back
   the **entire** transaction; no Claim is dropped.
5. Report recovery outcomes in diagnostics without replaying any command.

This is not a generic `heartbeat TTL` unlock mechanism. If proof is missing
or a Job assignment/closure has failed on the legacy execution path, the Claim
must remain held for explicit reconciliation. Never remove SQLite Claim rows
or Git metadata guards to bypass the recovery protocol.

## Validation

See `src/windows-recovery-sweep.test.ts` for stale/recent heartbeat, active
Owner/Job, missing proof, old boot and heartbeat-race coverage. See
`src/windows-recovery-sweep-integration.test.ts` for a genuine disposable
Windows Job whose Owner is terminated and subsequently recovered by the
managed daemon's automatic startup timer. Existing
`src/windows-recovery-concurrency.test.ts` covers multiple recovery
processes racing to release the same proven-dead Claim.
