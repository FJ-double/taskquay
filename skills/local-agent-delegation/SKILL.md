---
name: local-agent-delegation
description: Delegate coding tasks to user-configured DevSpace local agents.
---

# Local Agent Delegation

Use this skill when the user explicitly asks to delegate work to another coding
agent, use a named local agent, get a second opinion, compare approaches, or run
a subagent-like workflow.

Do not use local agents silently. Tell the user when another local agent is
being used.

## Core commands

Use only these commands for normal delegation:

```bash
devspace agents ls
devspace agents run <profile-or-id> "<prompt>"
devspace agents show <id>
```

`ls` shows configured profiles and active agents for the current workspace.

`run <profile> "<prompt>"` starts a new agent and prints a DevSpace agent id.

`run <id> "<prompt>"` sends a follow-up to an existing agent.

`show <id>` prints status and the latest response. If the agent is still
running, `show` waits briefly. If there is still no final response, call `show`
again later.

Do not run provider CLIs such as `codex`, `claude`, `opencode`, `pi`,
`cursor-agent`, or `copilot` directly unless you are explicitly debugging
DevSpace agent integration.

## Choosing a profile

Use `devspace agents ls` and choose by profile name, description, provider, and
model when present.

Good delegation targets:

- `reviewer`: second opinion, bug risk, security risk, test gaps.
- `explorer`: read-only codebase investigation.
- `implementer`: focused implementation when the user asked for delegation.

Do not delegate ordinary coding work just because a profile exists. Use normal
DevSpace tools unless the user asked for delegation, another agent's opinion,
parallel work, or a named local agent.

## Worker prompts

Agents start with only the prompt you send plus their configured profile
instructions. Make prompts self-contained.

Implementation prompt shape:

```text
Goal:
<clear goal>

Context:
<repo/module/user constraints>

Relevant files:
<paths and why they matter>

Acceptance criteria:
- <criterion>

Rules:
- Keep changes focused.
- Do not perform unrelated refactors.
- Report blockers clearly.
```

Read-only investigation prompt shape:

```text
Question:
<specific question>

Scope:
<files/directories/modules to inspect>

Rules:
- Do not modify files.
- Cite relevant file paths and symbols.
- Separate facts from guesses.
```

## After the worker responds

Always review the result before presenting it as verified.

For write-capable tasks, inspect changed files and run or explain relevant
tests. For read-only tasks, verify that important claims are supported by repo
evidence.

Be transparent in the final response:

```text
I used <profile>. It reported <summary>. I verified <checks>. Remaining risk:
<risk or none>.
```

Never hide that a local agent was used.
