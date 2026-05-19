# AgentLimb Bridge Runtime

This folder is the Bridge runtime bundled inside the AgentLimb Codex plugin.

It is not tied to a fixed install location. In normal plugin usage, prefer the plugin MCP tools. For manual fallback, start and stop it through the plugin root scripts.

Windows:

```powershell
cd <agentlimb-plugin-root>
& ".\scripts\start-bridge.cmd" --session-id $env:CODEX_THREAD_ID
& ".\scripts\status.cmd"
& ".\scripts\stop-bridge.cmd"
```

macOS/Linux:

```sh
cd <agentlimb-plugin-root>
sh ./scripts/start-bridge.sh --session-id "$CODEX_THREAD_ID"
sh ./scripts/status.sh
sh ./scripts/stop-bridge.sh
```

## Requirements

- Node.js 18.2 or newer
- Chrome with the AgentLimb extension installed or loaded

For normal use, install AgentLimb from the Chrome Web Store. Use a local unpacked extension copy only for development, offline inspection, or version-pinned testing; the plugin repository does not need to track that copy.

## Run Directly

From this runtime directory:

Windows:

```powershell
node .\kernel\bridge\mvp\run-server.js
```

macOS/Linux:

```sh
node ./kernel/bridge/mvp/run-server.js
```

Verify:

Windows:

```powershell
Invoke-RestMethod http://127.0.0.1:7791/api/mvp/status
```

macOS/Linux:

```sh
curl -fsS http://127.0.0.1:7791/api/mvp/status
```

## CLI Examples

From the plugin root.

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

## Optional Persistent Install

Do not run persistent install by default.

Only run this when the user explicitly wants Native Messaging registration or autostart.

Windows:

```powershell
cd <agentlimb-plugin-root>\runtime\agentlimb-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

If you are using a local unpacked extension, copy its ID from `chrome://extensions` and rerun:

```powershell
.\scripts\install.ps1 -ExtensionId <your-extension-id>
```

The Windows installer creates:

- `~\.agentlimb\bin\agentlimb.cmd`
- a Scheduled Task named `AgentLimb Bridge`
- a Chrome Native Messaging host named `com.agentlimb.bridge`

macOS/Linux:

```sh
cd <agentlimb-plugin-root>/runtime/agentlimb-bridge
sh ./scripts/install.sh
```

If you are using a local unpacked extension, copy its ID from `chrome://extensions` and rerun:

```sh
sh ./scripts/install.sh --extension-id <your-extension-id>
```

The macOS/Linux installer creates `~/.agentlimb/bin/agentlimb`, a Chrome Native Messaging host, and a platform autostart entry when supported.

The Bridge listens only on `127.0.0.1:7791` by default. HTTP requests without an `Origin` header are treated as local CLI traffic; browser requests are accepted only from Chrome extension origins or localhost origins.
