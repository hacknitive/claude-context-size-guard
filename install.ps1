# claude-context-size-guard — install shim (PowerShell).
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "claude-context-size-guard: node is required (Node.js 18+)"
  exit 1
}
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
& node (Join-Path $dir 'bin/install.js') @args
exit $LASTEXITCODE
