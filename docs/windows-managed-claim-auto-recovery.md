# Windows managed Claim automatic recovery

Windows x64 tracks commands with a Windows Job by default. After the shell
exits, a live Job member retains the claim even if all output is closed.
When the command tree has ended, output can drain for up to three seconds.
If an independent process still holds an output handle, Taskquay disconnects
the pipe and marks the output truncated. That process can keep running.

The server runs a bounded command recovery pass about two seconds after startup.
The 30-second background cycle checks stale managed owners and legacy commands.
The scoped MCP tool `recover_tasks` and the local console's recovery action
can also check a claim immediately, including while normal workspace calls
are blocked.

## What the heartbeat does

- The managed owner writes a heartbeat every 30 seconds.
- The periodic managed scan waits for 95 seconds of heartbeat silence.
  Startup and explicit scoped recovery can check Windows identity immediately.
- Silence of 95 seconds only triggers native Windows identity inspection. It
  never deletes a Claim or implies that child processes have exited.
- On the same boot, an armed command requires the exact prior owner and runner
  identities and their named Windows Job to be gone. A command with a durable
  pre-arm marker and a verified dead owner can be recovered before dispatch.
- Startup and scoped recovery can also use the kernel boot identity to verify
  a reboot. An old command without Job metadata requires previous-boot
  evidence, an absent owner PID, and an unambiguous ledger association.
  Agent and service claims keep their existing recovery rules.

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

When the operating-system evidence or ledger association is inconclusive,
the claim remains held and the recovery result gives a reason. Recovery
settles the interrupted operation as failed and closes its work run if it
has no other active or unresolved work.

## Validation

See `src/windows-recovery-sweep.test.ts` for stale/recent heartbeat, active
Owner/Job, missing proof, old boot and heartbeat-race coverage. See
`src/windows-recovery-sweep-integration.test.ts` for a genuine disposable
Windows Job whose Owner is terminated and subsequently recovered by the
managed daemon's automatic startup timer. Existing
`src/windows-recovery-concurrency.test.ts` covers multiple recovery
processes racing to release the same proven-dead Claim.
