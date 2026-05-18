$script = Join-Path $PSScriptRoot 'start-bridge.mjs'
node $script @args
exit $LASTEXITCODE
