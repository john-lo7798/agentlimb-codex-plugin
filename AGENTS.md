# AgentLimb Project Instructions

## Project Shape

This repository is a portable Codex plugin source tree for AgentLimb. It should be suitable for publishing and should not depend on a maintainer's personal install path.

Do not hard-code user-specific paths such as a particular Windows username or local project directory in plugin docs, skill instructions, or runtime behavior. Use:

```text
<agentlimb-plugin-root>
```

or commands that derive paths from the script location.

## Important Directories

```text
.codex-plugin\              Codex plugin manifest
skills\agentlimb\           AgentLimb Codex skill
scripts\                    temporary start/status/stop helpers
runtime\agentlimb-bridge\   self-contained Bridge runtime used by the plugin
agentlimb-chrome-v0.1.4\    optional local unpacked Chrome extension copy, ignored by git
```

There is no separate root-level `agentlimb-bridge` development source. The runtime under `runtime\agentlimb-bridge` is the current Bridge source for this plugin.

## Default Policy

- Use temporary startup only.
- Do not run `runtime\agentlimb-bridge\scripts\install.ps1` unless the user explicitly asks for persistent install, Native Messaging registration, or autostart.
- Do not create Windows Scheduled Tasks by default.
- Prefer the Chrome Web Store extension for normal use; keep `agentlimb-chrome-v0.1.4` local and ignored unless the user explicitly asks to version an extension snapshot.
- Do not modify the Chrome extension unless the user asks for browser-extension changes.
- Prefer `.cmd` helper scripts over `.ps1` helper scripts because endpoint protection software may remove or block PowerShell scripts.
- Do not add marketplace files or personal install-target paths to this repository unless the user explicitly asks for a distribution example.

## Runtime Commands

Run from the plugin root:

```powershell
cd <agentlimb-plugin-root>
& ".\scripts\status.cmd"
& ".\scripts\start-bridge.cmd" --session-id $env:CODEX_THREAD_ID
& ".\scripts\stop-bridge.cmd"
```

Bridge URL:

```text
http://127.0.0.1:7791
```

Logs:

```text
%TEMP%\agentlimb-bridge.log
%TEMP%\agentlimb-bridge.err.log
```

CLI from the plugin root:

```powershell
$cli = ".\runtime\agentlimb-bridge\bin\agentlimb.mjs"
node $cli status
node $cli start --session-id $env:CODEX_THREAD_ID --name "Codex" --type "codex"
node $cli call --session-id $env:CODEX_THREAD_ID --tool tabs_context --params "{}"
```

The helper scripts infer their plugin root from their own location. Keep that property when editing them.

## Session And Multi-Window Rules

- Every Codex window should use a distinct `sessionId`.
- Prefer `AGENTLIMB_SESSION_ID` or `CODEX_THREAD_ID` when available.
- Default session files live under `%TEMP%\agentlimb-sessions\<sessionId>.json`.
- The plugin owner/lease marker is `%TEMP%\agentlimb-bridge-owner.json`.
- `complete` releases the current session's lease and Profile lock.
- A plugin-started Bridge should auto-stop only when there are no active leases and no queued or claimed work.
- If the Bridge was already online before the plugin touched it, the plugin must not claim ownership or stop it automatically.

Chrome Profile isolation v1:

- Same Chrome Profile: only one Codex session may control it at a time.
- Different Chrome Profiles: multiple Codex sessions may run concurrently.
- Busy target returns `PROFILE_BUSY`; do not switch profiles automatically.
- Multiple active profiles without a target returns `TARGET_REQUIRED`; ask/infer the intended profile and retry with `--target`.
- Suspended target returns `TARGET_SUSPENDED`; ask the user to resume that profile's side panel.

## Browser Task Discipline

When this plugin is used for a real browser mission:

1. Check/start the Bridge temporarily.
2. Use one `sessionId` for `start`, all `call` operations, and `complete`.
3. Use `--target` whenever more than one Chrome Profile is active or the user names a profile.
4. Observe with `tabs_context`, `page_snapshot`, or targeted `javascript_eval` before browser writes.
5. Refresh snapshots after navigation or form submission; old `refId` values are invalid.
6. Close every real task with `muscle_commit`, then `task_complete` or `task_fail`, then `complete`.

Do not issue `task_plan`, browser probes, navigation, `task_complete`, or `task_fail` just to test setup when the user has not given a real browser mission.

## Validation

After runtime or script changes, run:

```powershell
Get-Content -Raw ".\.codex-plugin\plugin.json" | ConvertFrom-Json | Out-Null

node --check ".\scripts\start-bridge.mjs"
node --check ".\scripts\status.mjs"
node --check ".\scripts\stop-bridge.mjs"
node --check ".\runtime\agentlimb-bridge\bin\agentlimb.mjs"
node --check ".\runtime\agentlimb-bridge\bin\native-host.mjs"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\client.js"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\server.js"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\store.js"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\terminal-client.mjs"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\plugin-lease.mjs"
```

## Documentation Maintenance

If paths, startup policy, session isolation, Profile locks, auto-stop, or Chrome extension loading changes, update these files together:

```text
README.md
AGENTS.md
skills\agentlimb\SKILL.md
```
