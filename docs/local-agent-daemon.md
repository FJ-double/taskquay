# Local agent daemon

Local agent execution is owned by an on-demand `devspace-agentd` process, not
by the MCP server and not by an individual CLI invocation. The daemon is an
internal implementation detail: the normal workflow remains:

```text
devspace agents run/show/ls
          │
          ▼
    devspace-agentd
          │
          ├── LocalAgentManager
          ├── LocalAgentStore
          ├── LocalAgentRuntimePool
          └── provider runtimes
```

The CLI starts the daemon automatically when an agent command needs it. The
MCP server can use the same local client when an MCP operation needs agent
functionality, but `devspace serve` is not required for local-agent execution.
The daemon is scoped to one DevSpace `stateDir`, so one SQLite store and one
runtime owner serve all clients using that configuration.

Communication uses a private Unix domain socket on Linux/macOS or a named pipe
on Windows. The endpoint is not exposed through the public MCP HTTP port.
Provider session identifiers and logical agent records are durable; live
provider runtimes are disposable and may be recreated after a daemon restart.

The daemon state directory contains the socket or pipe identity, an atomic
lock, a PID marker, and diagnostic logs. A second client cannot start another
daemon for the same state directory. Stale lock and socket files are recovered
only after the recorded PID is no longer alive.

The daemon is started on demand and may exit after its active turns, clients,
and warm runtime idle periods have ended. Users do not need to manage it during
normal operation. Diagnostic commands are available for startup, process, and
cleanup problems:

```bash
devspace agents daemon status
devspace agents daemon stop
devspace agents daemon logs
```

Shutdown gives active turns a bounded graceful window. If that window expires,
the process exits with active records left durable; the next daemon startup
reconciles stale `starting` and `running` records to `error` without discarding
their `providerSessionId` or `latestResponse`.
