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

The daemon is started on demand and may exit after its active turns, clients,
and warm runtime idle periods have ended. Users do not need to manage it during
normal operation. Diagnostic commands may inspect or stop it when debugging
startup, process, or cleanup problems.
