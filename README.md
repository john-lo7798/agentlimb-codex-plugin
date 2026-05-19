# AgentLimb Codex Plugin

This repository packages AgentLimb for Codex.

AgentLimb itself is the upstream Chrome extension and browser automation project:

- Upstream repository: [hooosberg/AgentLimb](https://github.com/hooosberg/AgentLimb)
- Chrome Web Store: [AgentLimb](https://chromewebstore.google.com/detail/agentlimb/hldldfepjhljhbcneojddjkkodkjglof)

This tree adds the Codex-facing package: a plugin manifest, a Codex skill, a Codex-managed MCP entrypoint, temporary start/status/stop helpers, and a bundled local Bridge runtime.

## What It Provides

- A Codex plugin manifest in `.codex-plugin/plugin.json`.
- A Codex skill in `skills/agentlimb/SKILL.md`.
- A Codex-managed MCP server in `runtime/agentlimb-bridge/mcp/server.mjs`.
- A self-contained local Bridge runtime in `runtime/agentlimb-bridge`.
- Temporary helper scripts in `scripts`.

Default behavior is temporary startup only:

- No default Native Messaging install.
- No default Windows Scheduled Task.
- No default autostart.
- No bundled user-specific marketplace or install-path assumptions.

The Codex plugin starts the Bridge on demand at `127.0.0.1:7791`, talks to the AgentLimb extension in the user's real Chrome Profile, and releases its session lease when the browser task is complete. In Codex sandbox mode, the MCP server is the preferred entrypoint because Codex manages that process lifecycle and the Bridge stays under the same foreground process tree for the whole browser task.

## Directory Layout

```text
agentlimb/
├─ .codex-plugin\              # Codex plugin manifest
├─ .mcp.json                   # MCP server registration
├─ skills\agentlimb\           # Codex skill used when AgentLimb is invoked
├─ scripts\                    # temporary start/status/stop helpers
├─ runtime\agentlimb-bridge\   # self-contained Bridge runtime
├─ AGENTS.md                   # maintenance instructions for this repository
├─ LICENSE
└─ README.md
```

The current Bridge source for this plugin is:

```text
runtime\agentlimb-bridge
```

There is no separate root-level `agentlimb-bridge` source directory.

## Recommended Setup

1. Install [AgentLimb from the Chrome Web Store](https://chromewebstore.google.com/detail/agentlimb/hldldfepjhljhbcneojddjkkodkjglof).

2. Open the AgentLimb side panel in the Chrome Profile Codex should control.
3. Install this repository as a local Codex plugin.
4. Ask Codex to use AgentLimb. Codex should use the plugin MCP tools first, start the local Bridge temporarily, and connect to the active side panel.

A Chrome Profile with the side panel closed is treated as suspended. If multiple Profiles are active, the caller should choose a target Profile instead of letting Codex guess.

## Install As A Local Codex Plugin

Copy or clone this repository as one plugin directory named `agentlimb` in the local marketplace layout used by your Codex environment:

```text
<marketplace-root>\
├─ .agents\plugins\marketplace.json
└─ plugins\agentlimb\
```

For example:

```powershell
cd <marketplace-root>\plugins
git clone https://github.com/john-lo7798/agentlimb-codex-plugin.git agentlimb
```

On macOS/Linux:

```sh
cd <marketplace-root>/plugins
git clone https://github.com/john-lo7798/agentlimb-codex-plugin.git agentlimb
```

The plugin root must contain:

```text
.codex-plugin\plugin.json
skills\agentlimb\SKILL.md
runtime\agentlimb-bridge\
scripts\
```

Register this plugin in `<marketplace-root>\.agents\plugins\marketplace.json` with a local source that points to the copied `agentlimb` folder. Keep the installation policy optional:

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

Then add that local marketplace to Codex:

```powershell
codex plugin marketplace add <marketplace-root>
```

Do not mark it as installed by default unless you intentionally want that behavior. After the marketplace is added, install or enable `agentlimb` from Codex if your Codex UI does not enable available plugins automatically.

## Chrome Extension

AgentLimb requires the Chrome extension plus the local Bridge.

Preferred path:

1. Install AgentLimb from the Chrome Web Store.
2. Open the extension side panel.
3. Keep the side panel open in each Chrome Profile that should participate.

Development or offline path:

If you need to test an unpacked extension build, use a separate local checkout or build output from the upstream AgentLimb extension project.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select your local unpacked AgentLimb extension directory.

Keep any unpacked extension copy local. It does not auto-update from the Chrome Web Store and may have a different extension ID.

## MCP Tool Flow

When available, Codex should use the plugin's MCP tools instead of shelling out to separate helper commands for each browser step:

```text
agentlimb_status
agentlimb_start
agentlimb_call
agentlimb_finish
agentlimb_abort
```

`agentlimb_start` attaches to an already-running Bridge without taking ownership. If the Bridge is offline, the MCP server starts it as a non-detached child process, verifies `/api/mvp/status`, writes the owner marker, and keeps it alive for subsequent MCP calls. `agentlimb_finish` commits or discards muscle memory, updates the side panel task state, completes the terminal task, releases Profile locks and leases, and stops the Bridge only when this MCP server started it and it is idle.

## Temporary Bridge Startup

Prefer the MCP tools for normal Codex browser tasks. The helper scripts remain useful as a fallback and for manual diagnostics. In sandboxed Codex environments, do not rely on a standalone helper invocation to keep a detached Bridge alive across later shell commands; use the MCP flow or run the full browser task in one command lifecycle.

Run commands from the plugin root.

Windows:

```powershell
cd <agentlimb-plugin-root>
& ".\scripts\status.cmd"
& ".\scripts\start-bridge.cmd" --session-id $env:CODEX_THREAD_ID
& ".\scripts\stop-bridge.cmd"
```

macOS/Linux:

```sh
cd <agentlimb-plugin-root>
sh ./scripts/status.sh
sh ./scripts/start-bridge.sh --session-id "$CODEX_THREAD_ID"
sh ./scripts/stop-bridge.sh
```

Bridge URL:

```text
http://127.0.0.1:7791
```

Logs and owner markers use Node's `os.tmpdir()` for the current platform. Common locations:

```text
Windows:     %TEMP%\agentlimb-bridge.log
Windows:     %TEMP%\agentlimb-bridge.err.log
macOS/Linux: /tmp/agentlimb-bridge.log or the system temporary directory
macOS/Linux: /tmp/agentlimb-bridge.err.log or the system temporary directory
```

Session and lease files are stored next to those logs, for example `%TEMP%\agentlimb-bridge-owner.json` on Windows or `/tmp/agentlimb-bridge-owner.json` on many macOS/Linux systems.

`start-bridge.cmd` and `start-bridge.sh` wait for `/api/mvp/status`, then verify the started Bridge pid survives a short post-start window before writing the owner marker and reporting success. `status.cmd` and `status.sh` report a stale owner marker when it points to a pid that is no longer alive.

On Windows, prefer the `.cmd` helpers when a shell fallback is needed. The `.ps1` helpers are kept only for compatibility because some endpoint protection tools may remove or block PowerShell scripts.

## CLI

Run from the plugin root.

Windows:

```powershell
$cli = ".\runtime\agentlimb-bridge\bin\agentlimb.mjs"

node $cli status
node $cli start --session-id $env:CODEX_THREAD_ID --name "Codex" --type "codex"
node $cli call --session-id $env:CODEX_THREAD_ID --tool tabs_context --params "{}"
```

macOS/Linux:

```sh
cli="./runtime/agentlimb-bridge/bin/agentlimb.mjs"

node "$cli" status
node "$cli" start --session-id "${CODEX_THREAD_ID:-agentlimb-manual}" --name "Codex" --type "codex"
node "$cli" call --session-id "${CODEX_THREAD_ID:-agentlimb-manual}" --tool tabs_context --params "{}"
```

For multiple Chrome Profiles, discover profiles first:

```powershell
Invoke-WebRequest http://127.0.0.1:7791/api/mvp/extensions -UseBasicParsing
```

On macOS/Linux:

```sh
curl -fsS http://127.0.0.1:7791/api/mvp/extensions
```

Then pass an explicit target:

```powershell
node $cli start --session-id $env:CODEX_THREAD_ID --target "Profile-b83324" --name "Codex" --type "codex"
node $cli call --session-id $env:CODEX_THREAD_ID --target "Profile-b83324" --tool tabs_context --params "{}"
```

On macOS/Linux:

```sh
node "$cli" start --session-id "${CODEX_THREAD_ID:-agentlimb-manual}" --target "Profile-b83324" --name "Codex" --type "codex"
node "$cli" call --session-id "${CODEX_THREAD_ID:-agentlimb-manual}" --target "Profile-b83324" --tool tabs_context --params "{}"
```

## Multi-Codex Window Isolation

The plugin runtime supports v1 isolation:

- Each Codex window uses a distinct `sessionId`.
- Default session files live under Node's `os.tmpdir()`, for example `%TEMP%\agentlimb-sessions\<sessionId>.json` on Windows or `/tmp/agentlimb-sessions/<sessionId>.json` on many macOS/Linux systems.
- The Bridge owner/lease marker lives under Node's `os.tmpdir()`, for example `%TEMP%\agentlimb-bridge-owner.json` on Windows or `/tmp/agentlimb-bridge-owner.json` on many macOS/Linux systems.
- One Chrome Profile can be controlled by only one Codex session at a time.
- Different Codex sessions can control different Chrome Profiles concurrently.
- A busy target returns `PROFILE_BUSY`.
- Multiple active Profiles without a target returns `TARGET_REQUIRED`.
- `complete` releases the current session's Profile lock and lease.
- If the plugin started the Bridge temporarily, it auto-stops only when no active leases or queued/claimed work remain.

v1 does not support two Codex windows controlling different tabs inside the same Chrome Profile. That requires extension-side per-session tab/window isolation.

## Optional Persistent Install

Do not run persistent install by default.

Only run this when the user explicitly wants Native Messaging registration or autostart.

Windows:

```powershell
cd <agentlimb-plugin-root>\runtime\agentlimb-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

If you are using a local unpacked extension and it has a different extension ID, copy the ID from `chrome://extensions`:

```powershell
.\scripts\install.ps1 -ExtensionId <your-extension-id>
```

macOS/Linux:

```sh
cd <agentlimb-plugin-root>/runtime/agentlimb-bridge
sh ./scripts/install.sh
```

If you are using a local unpacked extension and it has a different extension ID, copy the ID from `chrome://extensions`:

```sh
sh ./scripts/install.sh --extension-id <your-extension-id>
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
Get-Content -Raw ".\.mcp.json" | ConvertFrom-Json | Out-Null

node --check ".\scripts\start-bridge.mjs"
node --check ".\scripts\status.mjs"
node --check ".\scripts\stop-bridge.mjs"
node --check ".\runtime\agentlimb-bridge\mcp\server.mjs"
node --check ".\runtime\agentlimb-bridge\bin\agentlimb.mjs"
node --check ".\runtime\agentlimb-bridge\bin\native-host.mjs"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\run-server.js"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\client.js"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\server.js"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\store.js"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\terminal-client.mjs"
node --check ".\runtime\agentlimb-bridge\kernel\bridge\mvp\plugin-lease.mjs"
```

If `sh` is available, also validate the macOS/Linux wrappers:

```sh
sh -n ./scripts/status.sh
sh -n ./scripts/start-bridge.sh
sh -n ./scripts/stop-bridge.sh
```

If startup policy, paths, session isolation, Profile locks, auto-stop, or Chrome extension loading changes, update these files together:

```text
README.md
AGENTS.md
skills\agentlimb\SKILL.md
```
