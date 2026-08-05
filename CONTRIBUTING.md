# Contributing to OffdisVM

Thanks for wanting to help! OffdisVM is a Node.js console that drives VirtualBox through the Main API (PowerShell COM bridge), with YouTube live-chat command control. This guide covers local setup, testing, and submitting changes.

## Table of contents

- [Project layout](#project-layout)
- [Requirements](#requirements)
- [Local setup](#local-setup)
- [Running the app](#running-the-app)
- [Running tests](#running-tests)
- [Development workflow](#development-workflow)
- [Coding conventions](#coding-conventions)
- [Submitting a pull request](#submitting-a-pull-request)
- [Reporting bugs](#reporting-bugs)

## Project layout

```
src/bridge.mjs       Node <-> PowerShell bridge (spawns + JSON over stdio)
src/bridge.ps1       PowerShell COM host for the VirtualBox Main API
src/cli.mjs          Interactive console, chat command handling, exec engine
src/livechat.mjs     YouTube live-chat poll loop (uses vendored client)
src/log.mjs          Session logging + colored console output
src/prompt.mjs       Terminal readline/rendering
src/scancodes.mjs    Key name -> PS/2 scancode mapping + text-to-codes
src/settings.json    Runtime config (gitignored)
macros/              Chat/CLI macro files (run via !import)
mjsTester/           Hand-rolled stress/integration tests (ad-hoc runners)
modern-youtubechat/  Vendored YouTube live-chat client (dist/)
logs/                Automatic session logs (gitignored)
```

## Requirements

- **Windows** (the bridge uses PowerShell + the VirtualBox COM API)
- **VirtualBox 7.x** — default install at `C:\Program Files\Oracle\VirtualBox`
- **Node.js 18+**

## Local setup

1. Clone the repo:

   ```
   git clone https://github.com/SynacNipo/Offdis-VM.git
   cd Offdis-VM
   ```

2. **No `npm install` is needed** — the project has no `node_modules` and that's intentional; keep it that way.

3. Create a VirtualBox VM if you don't have one (any OS; `Windows-7-7601` is used in examples and some tests).

4. If needed, copy `src/settings.json` to tune config. This file is gitignored, so keep any local tweaks out of commits.

## Running the app

```
npm start          # or: node src/cli.mjs
```

At the prompt, `!` is optional for exec commands (`key enter` = `!key enter`); chat always requires it. See `README.md` and the [wiki](https://github.com/SynacNipo/Offdis-VM/wiki) for the full command reference.

## Running tests

There is no formal test framework — `mjsTester/` holds small ad-hoc Node scripts that exercise the real bridge against a running VM. They're meant to be run manually against a live VM.

Run one with:

```
node mjsTester/TestKeyboard.mjs        # key/type/char throughput
node mjsTester/TypeTest.mjs            # typing correctness
node mjsTester/TestRestartRevert.mjs   # restart / revert flows
node mjsTester/TestLive.mjs            # live chat wiring
node mjsTester/LiveStress.mjs <videoId> [seconds] [vmName]   # live throughput under load
```

**Important:** because these drive a real VM, they may reset, restart, or otherwise disturb the guest. Don't run them against a VM you care about, and expect the VM to be powered on and reachable.

Before submitting a change, at minimum:

- Run `node --check src/*.mjs` to confirm your JS parses.
- If you touched `src/bridge.ps1`, parse-check the PowerShell (see below).
- If your change affects live behavior, run the relevant `mjsTester/` script against a throwaway VM.

### HTTP / parse smoke check (PowerShell 5.1)

```
$e = $null
[void][System.Management.Automation.Language.Parser]::ParseInput((Get-Content src/bridge.ps1 -Raw), [ref]$null, [ref]$e)
$e | ForEach-Object { $_.Message }
```

An empty output means `bridge.ps1` parses cleanly.

## Development workflow

1. Cut a branch off `main`:

   ```
   git checkout -b fix/your-feature
   ```

2. Make focused commits with clear messages (see [commit style](#coding-conventions)).

3. Rebase on latest `main` before opening a PR to keep history clean.

## Coding conventions

- **ESM only.** Import/export (`import`/`export`), never `require`. Node 18+.
- **No npm packages / no `node_modules`.** Don't add dependencies; if you think one is unavoidable, open an issue first so we can discuss it.
- **No code comments unless they add real value.** Prefer self-explanatory names; use a short comment only for a non-obvious why (the codebase already does this, e.g. scancode/PS2 caveats).
- **Match existing style:** 2-space indent, lowercase functions, `Single quotes` for strings, `const` by default.
- **Bridge protocol:** add any new op in `src/bridge.ps1` (the `switch ($op)` block) and call it from `src/cli.mjs` via `bridge.call('op', { args })`. Keep the JSON payloads simple.
- **Settings:** new tunables go in `src/settings.json` and are read defensively with a default (e.g. `settings.mouse?.maxMs ?? 10000`).

### Commit messages

Concise, imperative, and descriptive — one line is preferred:

```
Add !mouse direction drift with a time limit
Exempt moderators from the chat rate limit
Fix cursor going off-screen on !mouse drift
```

## Submitting a pull request

1. **Push your branch** and open a PR against `main` with `gh pr create` or the GitHub web UI.
2. In the PR description, summarize:
   - What changed and why.
   - Any new chat commands, bridge ops, or settings (and their defaults).
   - How you tested (which `mjsTester/` script, against what VM).
   - Whether the change is backward-compatible.
3. Link any related issue by number (e.g. `Closes #12`).
4. Keep the PR small and reviewable. If it's a big feature, split it into logical commits.

## Reporting bugs

Open an issue at https://github.com/SynacNipo/Offdis-VM/issues with:

- The exact command or chat message that failed.
- A snippet of the console log (sessions auto-save to `logs/`).
- Your VirtualBox version and VM/guest OS.
- The bridge error text, if any.

> [!NOTE]
> This project was developed with the assistance of AI. All scripts are fine-tuned and contain no malicious intent of any kind.
