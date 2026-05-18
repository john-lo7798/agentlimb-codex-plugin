---
name: agentlimb
description: Use when the user asks Codex to use AgentLimb, control Chrome, automate a real browser, operate a website in their logged-in local Chrome profile, use a browser extension or side panel, start or check the AgentLimb bridge, or work with AgentLimb muscle memory. This plugin packages a self-contained local bridge runtime and keeps startup temporary by default.
---

# AgentLimb

AgentLimb lets Codex control the user's real Chrome browser through a local Bridge and the AgentLimb Chrome extension.

For normal setup, the user should install AgentLimb from the Chrome Web Store and open the extension side panel. Local unpacked extension builds are for development, offline inspection, or version-pinned testing, and are not tracked by this plugin repository.

## When to use AgentLimb

Use AgentLimb by default when the user's request requires acting in their local Chrome browser instead of browsing the public web from Codex. This includes tasks that mention:

- controlling Chrome, the browser, a tab, a page, or a web app
- using the user's logged-in session, cookies, admin console, dashboard, inbox, store backend, or private website
- clicking, filling forms, uploading/downloading through a website, collecting data from the visible page, or completing a workflow in Chrome
- choosing or coordinating Chrome Profiles, side panels, or browser extension state
- saving or using AgentLimb muscle memory

Do not use AgentLimb for ordinary public web research, static codebase work, or setup checks when the user has not given a real browser mission.

## Runtime docs source

Do not copy Chrome side-panel generated prompts or hard-code a static tool catalog into this skill. The runtime is the source of truth:

- Tool names, descriptions, and parameter schemas live in `runtime/agentlimb-bridge/kernel/control/host/tools.js`.
- Runtime behavior rules live in `runtime/agentlimb-bridge/kernel/prompt/rules.js`.
- Connection protocol examples live in `runtime/agentlimb-bridge/kernel/prompt/protocol.js`.

When the Bridge is online and exact tool details are needed, read:

```text
http://127.0.0.1:7791/api/mvp/docs/tools
http://127.0.0.1:7791/api/mvp/docs/tools/<tool_name>
http://127.0.0.1:7791/api/mvp/docs/rules
http://127.0.0.1:7791/api/mvp/docs/protocol
```

Use those docs to resolve uncertainty about available tools, arguments, or current runtime rules. Keep examples in this skill aligned with the portable Codex plugin flow, not with a maintainer's installed CLI path or a persistent Scheduled Task setup.

## Default policy

- Default to temporary startup only.
- Do not run `runtime/agentlimb-bridge/scripts/install.ps1` unless the user explicitly asks for persistent install, Native Messaging registration, or autostart.
- Do not create Windows Scheduled Tasks by default.
- Prefer the Chrome Web Store extension for normal browser tasks; use a local unpacked extension only when the user is testing a specific local extension copy.
- Use smart auto-stop: if this plugin started the Bridge for the task, the plugin runtime stops it after `complete`; if the Bridge was already online before startup, leave it running.
- Use one isolated AgentLimb session per Codex thread. Prefer `AGENTLIMB_SESSION_ID` or `CODEX_THREAD_ID` when available; otherwise create one once per task and reuse it for `start`, every `call`, and `complete`.
- In multi-profile Chrome setups, prefer an explicit `--target "<profile label or extension id>"`. Do not let two Codex sessions control the same Chrome Profile at the same time.
- Do not start a browser task just to test setup unless the user gave an actual browser mission.
- Never assume a fixed user directory for this plugin.

## Resolve paths

Set `$pluginRoot` to the installed AgentLimb plugin root, which is the directory containing `.codex-plugin\plugin.json`.

If Codex exposes this skill file path, derive the plugin root by removing `\skills\agentlimb\SKILL.md` from that path. If not, use the current plugin root known to the session or an explicit `AGENTLIMB_PLUGIN_ROOT` environment variable if the user has set one.

Use these variables after resolving the root:

```powershell
$pluginRoot = "<agentlimb-plugin-root>"
$cli = Join-Path $pluginRoot "runtime\agentlimb-bridge\bin\agentlimb.mjs"
$statusScript = Join-Path $pluginRoot "scripts\status.cmd"
$startScript = Join-Path $pluginRoot "scripts\start-bridge.cmd"
$stopScript = Join-Path $pluginRoot "scripts\stop-bridge.cmd"
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

## Startup

Always check Bridge status first:

```powershell
& $statusScript
```

If the Bridge is offline, start it temporarily:

```powershell
$sessionId = if ($env:AGENTLIMB_SESSION_ID) { $env:AGENTLIMB_SESSION_ID } elseif ($env:CODEX_THREAD_ID) { $env:CODEX_THREAD_ID } else { "codex-" + [guid]::NewGuid().ToString("N") }
& $startScript --session-id $sessionId
```

Stop the temporary Bridge when cleanup is needed:

```powershell
& $stopScript
```

Stop only when this plugin owns the current Bridge process and no other Codex session still has a lease:

```powershell
& $stopScript --owned-only --session-id $sessionId
```

Prefer `.cmd` wrappers if endpoint protection software removes or blocks PowerShell scripts.

## Browser task flow

When the user gives a real browser mission:

1. Ensure the Chrome extension is installed or loaded, enabled, and its side panel is online.
2. Resolve `$pluginRoot`, `$cli`, `$statusScript`, `$startScript`, and `$stopScript`.
3. Ensure the Bridge is online using `status.cmd`, then `start-bridge.cmd` if needed.
4. Start a terminal session:

```powershell
node $cli start --session-id $sessionId --name "Codex" --type "codex"
```

5. Use `call --session-id $sessionId --tool <tool_name> --params '<JSON>'` for browser operations.
6. Before ending a real task, call `muscle_commit`, then `task_complete` or `task_fail`, then `complete`.
7. The plugin runtime's `complete` command releases the current session's Profile lock and lease, then runs smart auto-stop. As a cleanup fallback, run `stop-bridge.cmd --owned-only --session-id $sessionId`.

When several Chrome Profiles are online, discover them first:

```powershell
Invoke-WebRequest http://127.0.0.1:7791/api/mvp/extensions -UseBasicParsing
```

Then pass the chosen profile on `start` and every `call`:

```powershell
node $cli start --session-id $sessionId --target "Profile-b83324" --name "Codex" --type "codex"
node $cli call --session-id $sessionId --target "Profile-b83324" --tool tabs_context --params "{}"
```

If a call fails with `PROFILE_BUSY`, that Profile is locked by another Codex session; do not switch profiles automatically unless the user asks. If a call fails with `TARGET_REQUIRED`, multiple active Profiles are online and the command must be repeated with an explicit `--target`.

Do not issue `task_plan`, `task_complete`, `task_fail`, navigation, snapshots, or browser probes when there is no actual mission.

## Browser operation discipline

- Observe before acting. Before any click, type, key, drag, form write, or other page mutation, inspect the current page with `page_snapshot`, `tabs_context`, or a targeted `javascript_eval`.
- Before using a `refId`, refresh the current page snapshot. After navigation, form submission, `Enter` inside a form, or a link that changes pages, old `refId` values are invalid.
- If a tool reports a stale ref, immediately call `page_snapshot` again and retry with the new ref.
- `computer.key` and `computer.type` without a target act on the focused element. Click or otherwise focus the element first.
- If `navigate("back")` returns `navigationType:"back_close_tab"`, the new tab was closed and focus returned to the opener; do not call `forward` after that.
- `wait("page_contains", text)` is preferred over repeated snapshots when waiting for text or navigation results.
- For screenshots, set `includeData:true` only when the image data is actually needed.

## Required task closure

Every real browser mission must close in this order:

1. Commit or discard muscle memory:

```powershell
node $cli call --session-id $sessionId --tool muscle_commit --params '{"status":"success","verification":"<how you verified>"}'
```

Use `status:"failed"` when the task failed and candidates should be discarded. Use `status:"partial"` when useful work was completed but the task is incomplete. Use `status:"manual"` mid-task when the user says to save something or when a selector/workflow is worth preserving immediately.

2. Push the side-panel terminal state:

```powershell
node $cli call --session-id $sessionId --tool task_complete --params '{"summary":"<one-line result>"}'
```

On failure:

```powershell
node $cli call --session-id $sessionId --tool task_fail --params '{"reason":"<failure reason>","stepIndex":0}'
```

3. End the terminal session and release this session's Profile lock and lease:

```powershell
node $cli complete --session-id $sessionId --task-id "<task.id>" --ok true --output "<result summary>"
```

During the task, use `task_plan` once at the logical workflow level and call `task_step_done` whenever a logical step finishes. Keep plans to 2-5 meaningful steps, not one step per browser tool call.

If `muscle_commit(success|partial)` is blocked with `muscle_remember_recommended`, call `muscle_remember` with reusable selectors, workflow notes, or a short explanation of why nothing reusable was learned, then retry the commit.

## Multi-profile rules

- A Chrome Profile with its side panel closed is suspended. If `TARGET_SUSPENDED` is returned for a targeted profile, tell the user that profile is suspended and ask them to resume it; do not silently pick another profile.
- For a side-effecting targeted call, verify with the same `--target`. Never use another Profile's `tabs_context`, snapshot, or result as evidence that the targeted Profile succeeded.
- For broad multi-profile missions, discover profiles through `http://127.0.0.1:7791/api/mvp/extensions`, then dispatch explicit targeted calls. Summarize targeted, skipped, busy, or suspended profiles at the end.
- Muscle memory is shared by domain across local profiles under `~/Desktop/AgentLimb-muscle`; do not try to copy muscle files between profiles.

## Failure recovery

- `extensionOffline:true`: ask the user to make sure Chrome is open, the extension is enabled, and the side panel is active, then rerun `start`.
- Repeated tool failures: take a screenshot or run a targeted `javascript_eval` to inspect actual page state before retrying.
- `TARGET_REQUIRED`: repeat the command with an explicit `--target`.
- `PROFILE_BUSY`: wait for that session to finish or ask the user whether to choose a different Profile.
- `TARGET_SUSPENDED`: ask the user to resume that Profile in the side panel before retrying.

## Safety notes

- The Bridge listens on `127.0.0.1:7791`.
- The Chrome extension has broad browser permissions, including page access and debugger access.
- Keep the Bridge temporary unless the user explicitly wants persistent setup.
- Treat browser actions as acting in the user's real logged-in Chrome profile.
