---
name: subagents
description: Delegate coding tasks to user-configured DevSpace subagents.
---

# Subagents

Use this skill when the user explicitly asks to delegate work to another coding
agent, use a named subagent, get a second opinion, compare approaches, or run
a subagent-like workflow.

Do not use subagents silently. Tell the user when another subagent is
being used.

## Core commands

Use only these commands for normal delegation:

```bash
devspace agents targets
devspace agents ls
devspace agents run <profile-or-provider> "<prompt>"
devspace agents continue <id> "<prompt>"
devspace agents show <id>
```

`targets` shows the providers and profiles available for the current project.
Use an agent or profile already presented by DevSpace. If you do not know which
ones are available, run `devspace agents targets` before delegating.

`ls` shows existing subagent sessions for the current project. DevSpace selects
the project from the command environment. Use the returned `agt_...` ID with
`continue`. Provider session IDs cannot replace DevSpace agent IDs.

`run <profile> "<prompt>"` starts a new configured profile and prints a
DevSpace agent id.

`run <provider> "<prompt>"` starts an enabled provider when no configured
profile is needed. Run `targets` if you do not know which providers are enabled.

`continue <id> "<prompt>"` sends a follow-up to an existing agent. Do not use
`run <id>` for continuation.

Continuation supports the same per-turn model and effort overrides:

```bash
devspace agents continue <id> --model <model> "<prompt>"
devspace agents continue <id> --effort <level> "<prompt>"
```

`show <id>` prints status and the latest response. If the agent is still
running, `show` waits briefly. If there is still no final response, call `show`
again later.

Use DevSpace commands for delegation instead of calling provider commands
directly. DevSpace manages execution and continuation for you.

## Choosing a profile

Choose from the profiles DevSpace has already presented. If no catalog is
visible, run `devspace agents targets`. Use the profile name with
`devspace agents run`. If no profile fits, use an enabled provider from the
same result.

Profiles may declare a model and optional effort level. To override the
configured/default provider model or effort level for a run, pass `--model`
or `--effort`:

```bash
devspace agents run <profile-or-provider> --model <model> "<prompt>"
devspace agents run <profile-or-provider> --effort <level> "<prompt>"
```

Use `--effort` only when the user asks for a specific reasoning depth or when
the task clearly needs a different effort than the configured profile default.
Effort values are provider-specific. Use a value supported by the selected
provider. DevSpace does not translate values between providers.

Good delegation targets:

- `reviewer`: second opinion, bug risk, security risk, test gaps.
- `explorer`: read-only codebase investigation.
- `implementer`: focused implementation when the user asked for delegation.

Do not delegate ordinary coding work just because a profile exists. Use normal
DevSpace tools unless the user asked for delegation, another agent's opinion,
parallel work, or a named subagent.

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

Never hide that a subagent was used.
