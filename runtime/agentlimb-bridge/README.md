# AgentLimb Bridge Runtime

This folder is the Bridge runtime bundled inside the AgentLimb Codex plugin.

It is not tied to a fixed install location. In normal plugin usage, start and stop it through the plugin root scripts:

```powershell
cd <agentlimb-plugin-root>
& ".\scripts\start-bridge.cmd" --session-id $env:CODEX_THREAD_ID
& ".\scripts\status.cmd"
& ".\scripts\stop-bridge.cmd"
```

## Requirements

- Node.js 18.2 or newer
- Chrome with the AgentLimb extension installed or loaded

For normal use, install AgentLimb from the Chrome Web Store. Use a local unpacked extension copy only for development, offline inspection, or version-pinned testing; the plugin repository does not need to track that copy.

## Run Directly

From this runtime directory:

```powershell
node .\kernel\bridge\mvp\run-server.js
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:7791/api/mvp/status
```

## CLI Examples

From the plugin root:

```powershell
$cli = ".\runtime\agentlimb-bridge\bin\agentlimb.mjs"
node $cli status
node $cli start --session-id $env:CODEX_THREAD_ID --name "Codex" --type "codex"
node $cli call --session-id $env:CODEX_THREAD_ID --tool tabs_context --params "{}"
```

## Optional Windows Install

Do not run persistent install by default.

Only run this when the user explicitly wants Native Messaging registration or autostart:

```powershell
cd <agentlimb-plugin-root>\runtime\agentlimb-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

If you are using a local unpacked extension, copy its ID from `chrome://extensions` and rerun:

```powershell
.\scripts\install.ps1 -ExtensionId <your-extension-id>
```

The installer creates:

- `~\.agentlimb\bin\agentlimb.cmd`
- a Scheduled Task named `AgentLimb Bridge`
- a Chrome Native Messaging host named `com.agentlimb.bridge`

The Bridge listens only on `127.0.0.1:7791` by default. HTTP requests without an `Origin` header are treated as local CLI traffic; browser requests are accepted only from Chrome extension origins or localhost origins.
