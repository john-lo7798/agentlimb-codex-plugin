# AgentLimb Codex Plugin

This repository packages AgentLimb for Codex.

AgentLimb itself is the upstream Chrome extension and browser automation project:

- Upstream repository: https://github.com/hooosberg/AgentLimb
- Chrome Web Store: https://chromewebstore.google.com/detail/agentlimb/hldldfepjhljhbcneojddjkkodkjglof

This tree adds the Codex-facing package: a plugin manifest, a Codex skill, temporary start/status/stop helpers, and a bundled local Bridge runtime. The plugin source is portable and can live anywhere your Codex environment loads local plugins from; commands should derive paths from the script location or use `<agentlimb-plugin-root>`, not a maintainer's personal install path.

## What It Provides

- A Codex plugin manifest in `.codex-plugin/plugin.json`.
- A Codex skill in `skills/agentlimb/SKILL.md`.
- A self-contained local Bridge runtime in `runtime/agentlimb-bridge`.
- Temporary helper scripts in `scripts`.
- An ignored optional local extension directory at `agentlimb-chrome-v0.1.4` for development, offline inspection, or version-pinned testing.

Normal users should install the AgentLimb extension from the Chrome Web Store. This plugin repository does not need to track the Chrome extension source.

Default behavior is temporary startup only:

- No default Native Messaging install.
- No default Windows Scheduled Task.
- No default autostart.
- No bundled user-specific marketplace or install-path assumptions.

The Codex plugin starts the Bridge on demand at `127.0.0.1:7791`, talks to the AgentLimb extension in the user's real Chrome Profile, and releases its session lease when the browser task is complete.

## Directory Layout

```text
agentlimb/
├─ .codex-plugin\              # Codex plugin manifest
├─ skills\agentlimb\           # Codex skill used when AgentLimb is invoked
├─ scripts\                    # temporary start/status/stop helpers
├─ runtime\agentlimb-bridge\   # self-contained Bridge runtime
├─ agentlimb-chrome-v0.1.4\    # optional local unpacked extension, ignored by git
├─ AGENTS.md                   # maintenance instructions for this repository
├─ LICENSE
├─ PRIVACY_POLICY.md
└─ README.md
```

The current Bridge source for this plugin is:

```text
runtime\agentlimb-bridge
```

There is no separate root-level `agentlimb-bridge` source directory.

## Recommended Setup

1. Install AgentLimb from the Chrome Web Store:

```text
https://chromewebstore.google.com/detail/agentlimb/hldldfepjhljhbcneojddjkkodkjglof
```

2. Open the AgentLimb side panel in the Chrome Profile Codex should control.
3. Install this repository as a local Codex plugin.
4. Ask Codex to use AgentLimb. The plugin should start the local Bridge temporarily and connect to the active side panel.

A Chrome Profile with the side panel closed is treated as suspended. If multiple Profiles are active, the caller should choose a target Profile instead of letting Codex guess.

## Install As A Local Codex Plugin

Copy or clone this folder as one plugin directory named `agentlimb` in the plugin location used by your Codex environment.

The plugin root must contain:

```text
.codex-plugin\plugin.json
skills\agentlimb\SKILL.md
runtime\agentlimb-bridge\
scripts\
```

If your Codex environment uses a local marketplace file, register this plugin with a local source that points to the copied `agentlimb` folder. Keep the installation policy optional:

```json
{
  "name": "agentlimb",
  "source": {
    "source": "local",
    "path": "./plugins/agentlimb"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Productivity"
}
```

Do not mark it as installed by default unless you intentionally want that behavior.

## Chrome Extension

AgentLimb requires the Chrome extension plus the local Bridge.

Preferred path:

1. Install AgentLimb from the Chrome Web Store.
2. Open the extension side panel.
3. Keep the side panel open in each Chrome Profile that should participate.

Development or offline path:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select:

```text
<agentlimb-plugin-root>\agentlimb-chrome-v0.1.4
```

Keep any unpacked extension copy local. The `agentlimb-chrome-v0.1.4` directory is ignored by git, does not auto-update from the Chrome Web Store, and may have a different extension ID.

## Temporary Bridge Startup

Run commands from the plugin root:

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

Prefer the `.cmd` helpers. The `.ps1` helpers are kept only for compatibility because some endpoint protection tools may remove or block PowerShell scripts.

## CLI

Run from the plugin root:

```powershell
$cli = ".\runtime\agentlimb-bridge\bin\agentlimb.mjs"

node $cli status
node $cli start --session-id $env:CODEX_THREAD_ID --name "Codex" --type "codex"
node $cli call --session-id $env:CODEX_THREAD_ID --tool tabs_context --params "{}"
```

For multiple Chrome Profiles, discover profiles first:

```powershell
Invoke-WebRequest http://127.0.0.1:7791/api/mvp/extensions -UseBasicParsing
```

Then pass an explicit target:

```powershell
node $cli start --session-id $env:CODEX_THREAD_ID --target "Profile-b83324" --name "Codex" --type "codex"
node $cli call --session-id $env:CODEX_THREAD_ID --target "Profile-b83324" --tool tabs_context --params "{}"
```

## Multi-Codex Window Isolation

The plugin runtime supports v1 isolation:

- Each Codex window uses a distinct `sessionId`.
- Default session files live in `%TEMP%\agentlimb-sessions\<sessionId>.json`.
- The Bridge owner/lease marker lives in `%TEMP%\agentlimb-bridge-owner.json`.
- One Chrome Profile can be controlled by only one Codex session at a time.
- Different Codex sessions can control different Chrome Profiles concurrently.
- A busy target returns `PROFILE_BUSY`.
- Multiple active Profiles without a target returns `TARGET_REQUIRED`.
- `complete` releases the current session's Profile lock and lease.
- If the plugin started the Bridge temporarily, it auto-stops only when no active leases or queued/claimed work remain.

v1 does not support two Codex windows controlling different tabs inside the same Chrome Profile. That requires extension-side per-session tab/window isolation.

## Optional Persistent Install

Do not run persistent install by default.

Only run this when the user explicitly wants Native Messaging registration or autostart:

```powershell
cd <agentlimb-plugin-root>\runtime\agentlimb-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

If you are using a local unpacked extension and it has a different extension ID, copy the ID from `chrome://extensions`:

```powershell
.\scripts\install.ps1 -ExtensionId <your-extension-id>
```

## Security Notes

- The Bridge listens on `127.0.0.1:7791`.
- Browser actions run in the user's real logged-in Chrome Profile.
- The Chrome extension has broad permissions, including page access, debugger access, and `<all_urls>`.
- Keep Bridge startup temporary unless persistent setup is explicitly intended.
- Load only trusted builds of this plugin and extension.

## Development Workflow

Make changes directly in this repository.

After runtime or script changes, validate:

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

If startup policy, paths, session isolation, Profile locks, auto-stop, or Chrome extension loading changes, update these files together:

```text
README.md
AGENTS.md
skills\agentlimb\SKILL.md
```
