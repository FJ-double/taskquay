# Local Agent Profiles and Minimal CLI Plan

## Goal

Add local coding-agent delegation to DevSpace without forcing the supervising
model to stream or reason over raw provider CLI output.

The model-facing surface should stay small:

```bash
devspace agents ls
devspace agents run <profile-or-id> "<prompt>"
devspace agents show <id>
```

Everything richer, including JSON output, explicit workspace ids, logs, stop,
diagnostics, and future MCP tools, can exist as implementation details or
advanced commands but should not be taught in the default skill.

## Principles

- DevSpace owns the stable agent handle. Provider session ids are stored as
  metadata and aliases, not exposed as the primary handle.
- Agent profiles describe roles. Provider configuration describes how to launch
  or connect to a harness.
- Prefer first-class adapters for popular harnesses. Keep CLI as a fallback for
  custom or unsupported local agents.
- Do not infer changed files, tests, or diffs in v1. Show only status and the
  agent final response or latest known response.
- Keep raw provider transcripts out of the default model context. Store them for
  debugging and expose them only through explicit advanced commands.

## Agent Profiles

Profiles should be markdown files with frontmatter plus an instruction body.
The frontmatter is for discovery and routing. The body is the worker prompt
prefix used internally when DevSpace launches the profile.

Default profile locations:

- Global: `~/.devspace/agents/*.md`
- Project: `.devspace/agents/*.md`

Packaged examples should remain inert templates.

Minimal profile shape:

```md
---
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.4
mode: review
permissions:
  edit: deny
  bash: deny
disabled: false
---

You are a read-only reviewer. Do not edit files.
Focus on correctness, security, test gaps, and maintainability.
Cite files and return concise findings.
```

For v1, avoid profile fields such as `workspace.mode`, `writeMode`,
`runtime.maxTurns`, or `output`. They add routing complexity without improving
the model-facing workflow.

## Provider Configuration

Provider configuration is separate from profiles.

Profiles can say:

```yaml
provider: codex
model: gpt-5.4
```

DevSpace resolves the provider backend internally:

1. SDK or app-server adapter when available.
2. ACP adapter when available.
3. CLI adapter as fallback.

Future custom provider config can support:

```json
{
  "agents": {
    "providers": {
      "my-acp-agent": {
        "extends": "acp",
        "label": "My ACP Agent",
        "command": ["my-agent", "acp"]
      },
      "legacy-agent": {
        "backend": "cli",
        "label": "Legacy Agent",
        "command": ["legacy-agent", "run"]
      }
    }
  }
}
```

The existing CLI-oriented example profiles should be reworked into role
profiles. Command templates should move to provider config or CLI fallback
adapter tests.

## `open_workspace` Exposure

When local agents are enabled, `open_workspace` should expose a compact agent
catalog next to skills.

Structured output should include:

```json
{
  "agents": [
    {
      "name": "reviewer",
      "description": "Read-only reviewer for bugs, security risks, and missing tests.",
      "provider": "codex",
      "model": "gpt-5.4",
      "mode": "review",
      "permissions": {
        "edit": "deny",
        "bash": "deny"
      }
    }
  ]
}
```

Model-readable text should stay terse:

```text
Available local agents: reviewer, implementer.
Use the local-agent-delegation skill before delegating work.
```

Do not include the full profile body in `open_workspace`; the body can be read
or used internally only when the profile is launched.

## Skill Guidance

The local-agent-delegation skill should teach only:

```bash
devspace agents ls
devspace agents run <profile-or-id> "<prompt>"
devspace agents show <id>
```

Rules for the model:

- Use local agents only when the user asks for delegation, second opinion,
  parallel work, named local agent usage, or a task clearly benefits from a
  configured specialist.
- Pick a profile by `description` and `permissions`.
- Do not silently delegate normal coding tasks.
- Use `run <profile> "<prompt>"` to start a new agent.
- Use `run <id> "<prompt>"` to send a follow-up to an existing agent.
- Use `show <id>` to get status and the latest/final response.
- Review the worker's answer before presenting it as verified.

## CLI Behavior

### `devspace agents ls`

Lists available profiles and active agents for the current DevSpace workspace.

Workspace scoping should resolve in this order:

1. `DEVSPACE_WORKSPACE_ID`, injected by DevSpace process tools when available.
2. Current working directory.
3. Advanced hidden `--workspace-id` flag, not taught in the skill.

### `devspace agents run <profile-or-id> "<prompt>"`

If the first argument matches an existing DevSpace agent id or provider session
alias, send a follow-up. Otherwise, treat it as a profile name and create a new
agent.

Default output should be compact text:

```text
agt_123 running reviewer
```

Keep `--json` available for tests, scripts, and future MCP wrappers, but do not
mention it in the skill.

### `devspace agents show <id>`

Shows agent status and response.

Default behavior:

- If idle or done, return immediately with the latest response.
- If running, wait up to 15 seconds.
- If it finishes within that window, print the final response.
- If still running, print compact status and tell the model to call `show`
  again later.
- If waiting for permission, errored, or stopped, print that state.

Example while running:

```text
agt_123 running reviewer
No final response yet. Call `devspace agents show agt_123` again later.
```

Example when done:

```text
agt_123 idle reviewer
The likely issue is in src/foo.ts...
```

Hidden advanced options can include `--no-wait`, `--timeout <duration>`,
`--json`, and `--logs`, but they should not be part of the default skill.

## Runtime Storage

Store a DevSpace-owned session record:

```ts
interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  backend: "auto" | "sdk" | "app-server" | "acp" | "cli";
  providerSessionId?: string;
  status: "starting" | "running" | "idle" | "error" | "stopped";
  latestResponse?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

Raw event streams and verbose logs should be stored separately and omitted from
default command output.

## Adapter Plan

Start with a small provider-neutral interface:

```ts
interface LocalAgentRuntime {
  provider: string;
  backend: string;
  start(input: StartAgentInput): Promise<AgentTurnResult>;
  followUp(input: FollowUpAgentInput): Promise<AgentTurnResult>;
  status?(id: string): Promise<AgentStatus>;
  cancel?(id: string): Promise<void>;
}
```

Initial adapters:

1. Codex SDK/app-server adapter using the existing `local-agent-runtime.ts`
   direction.
2. CLI fallback adapter for custom profiles and unsupported harnesses.
3. ACP adapter after the CLI/profile flow is stable.

Later adapters can cover Claude Code SDK, OpenCode SDK/server, Pi RPC/SDK, and
other harness-specific APIs.

## Implementation Phases

### Phase 1: Profile Catalog

- Add profile loader for global and project profile directories.
- Validate minimal frontmatter.
- Add `agents` to `open_workspace` structured output when local agents are
  enabled.
- Update docs and tests.

### Phase 2: Minimal CLI

- Add `devspace agents ls`.
- Add local agent records in state storage.
- Add `run` and `show` command skeletons with mocked/runtime-injected adapter
  tests.
- Inject `DEVSPACE_WORKSPACE_ID` and `DEVSPACE_WORKSPACE_ROOT` into DevSpace
  process tool environments.

### Phase 3: Runtime Adapters

- Wire Codex SDK/app-server adapter.
- Wire CLI fallback adapter.
- Keep provider logs out of default output.

### Phase 4: Skill and Examples

- Rewrite `local-agent-delegation` skill around the three commands.
- Rework packaged examples into role profiles, not CLI command templates.
- Document provider config and CLI fallback separately.

### Phase 5: Future MCP Tools

Add MCP tools only after the CLI/runtime boundary is stable:

- `spawn_agent`
- `show_agent`
- `run_agent`
- `list_agents`

These should call the same runtime implementation as the CLI.
