# Local agent profile schema

DevSpace local agent profiles are user-owned markdown files with YAML
frontmatter. They describe *roles* such as reviewer, explorer, or implementer.
Provider configuration describes how DevSpace talks to the underlying harness.

Profiles are discovered from:

- `~/.devspace/agents/*.md`
- `.devspace/agents/*.md`

Packaged files under `examples/agents/` are starter templates only.

## Minimal shape

```md
---
schema: devspace-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
backend: auto
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

## Frontmatter fields

### `schema`

Optional schema identifier:

```yaml
schema: devspace-agent/v1
```

### `name`

Stable profile identifier shown to the model and accepted by:

```bash
devspace agents run <name> "<prompt>"
```

Use lowercase kebab-case names.

### `description`

Required short purpose. This is exposed by `open_workspace` and
`devspace agents ls` so the supervising model can choose the right profile.

### `provider`

Required local agent family or provider id.

Examples:

```yaml
provider: codex
provider: claude
provider: opencode
provider: cursor
provider: pi
provider: copilot
```

### `backend`

Optional execution backend.

```yaml
backend: auto
backend: codex-sdk
backend: acp
backend: cli
```

`auto` is the normal value. DevSpace resolves the best available adapter for
the provider. CLI fallback profiles can set `backend: cli` and provide
`command`.

Current support is intentionally narrow: Codex profiles use the Codex SDK, and
other providers should include a `command` until their ACP or SDK adapters are
wired.

### `command`

Optional command string for `backend: cli` fallback profiles. DevSpace passes
the full worker prompt on stdin and captures stdout as the response.

```yaml
backend: cli
command: "my-agent run --no-color"
```

Prefer built-in provider adapters or ACP when available.

### `model`

Optional provider model id or alias.

```yaml
model: gpt-5.4
model: sonnet
```

### `mode`

Optional provider or role mode label.

```yaml
mode: review
mode: implement
```

### `permissions`

Optional model-facing permission hints.

```yaml
permissions:
  edit: deny
  bash: deny
```

Supported values are `allow`, `ask`, and `deny`. DevSpace exposes these hints in
the compact agent catalog. Provider adapters may also map them to native sandbox
or approval settings.

### `disabled`

Optional boolean. Disabled profiles are not exposed.

```yaml
disabled: true
```

## Markdown body

The body is the profile prompt prefix DevSpace prepends when launching that
profile. It is not included in `open_workspace` by default.

Recommended body content:

- When to use this profile.
- What the worker must not do.
- Output format.
- Review or testing expectations.

## Model-facing workflow

The local-agent skill teaches only:

```bash
devspace agents ls
devspace agents run <profile-or-id> "<prompt>"
devspace agents show <id>
```

`open_workspace` exposes compact profile metadata:

```json
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
```

The full profile body stays out of the model context until DevSpace launches the
profile.

## Current non-goals

- Inferring changed files, tests, or diffs from worker output.
- Exposing raw provider transcripts by default.
- Teaching the model provider-specific CLIs.
- First-class MCP agent tools. Future tools should wrap the same runtime used by
  `devspace agents`.
