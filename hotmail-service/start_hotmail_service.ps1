$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "[hotmail-service] working dir: $scriptDir"
Write-Host "[hotmail-service] starting on http://127.0.0.1:8001"

python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
