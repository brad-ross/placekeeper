$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Source installation requires Node.js 24 or newer and the Visual Studio C++ build tools. Run this script from Developer PowerShell.'
}
& node (Join-Path $PSScriptRoot 'packaging/desktop/source-install.mjs') @args
exit $LASTEXITCODE
