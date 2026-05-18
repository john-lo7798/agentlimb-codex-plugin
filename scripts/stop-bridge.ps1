$script = Join-Path $PSScriptRoot 'stop-bridge.mjs'
node $script @args
exit $LASTEXITCODE
