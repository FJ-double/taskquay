# Setup Guide

This guide covers both remote MCP hosts and local coding harnesses using
DevSpace in local projects.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local DevSpace server, only when a
  remote MCP host will connect

DevSpace does not create the public tunnel for you. Remote MCP users can use
Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or their own HTTPS reverse
proxy.

## Install And Configure

Run:

```bash
npx @waishnav/devspace init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through DevSpace. Keep this
narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Usage And Subagents

Setup asks independently whether a remote MCP host will connect and whether a
local coding harness will use DevSpace subagents. It then detects the supported
providers and asks which ones DevSpace may launch. These choices are persisted
as provider objects under `subagents` in `~/.devspace/config.json`.

For a local harness, setup prints this command instead of modifying harness
directories itself:

```bash
npx skills add Waishnav/devspace --skill subagent-delegation --global
```

The Skills CLI asks which installed harnesses should receive the skill. The
skill uses `devspace agents targets`, `run`, `continue`, `show`, and `ls`; these
commands start DevSpace's local agent daemon as needed and do not require
`devspace serve`.

### Public Base URL For Remote MCP

Start your tunnel or reverse proxy before entering this value. Point the tunnel
at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

Skip remote MCP access during setup for a local-harness-only configuration; no
public URL is required.

## Start The Server

Run:

```bash
npx @waishnav/devspace serve
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable public URL, persist it:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, DevSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx @waishnav/devspace doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing DevSpace itself instead of using the published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.
