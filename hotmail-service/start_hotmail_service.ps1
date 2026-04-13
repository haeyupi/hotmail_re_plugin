$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "[hotmail-service] working dir: $scriptDir"
Write-Host "[hotmail-service] starting on http://127.0.0.1:8001"

function Clear-Port8001 {
    $listeners = Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue
    if (-not $listeners) {
        return
    }

    $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($owningPid in $pids) {
        try {
            Write-Host "[hotmail-service] clearing port 8001, stopping PID $owningPid ..."
            Stop-Process -Id $owningPid -Force -ErrorAction Stop
        } catch {
            throw "Failed to stop PID ${owningPid} on port 8001: $($_.Exception.Message)"
        }
    }

    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 300
        $stillListening = Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue
        if (-not $stillListening) {
            Write-Host "[hotmail-service] port 8001 cleared"
            return
        }
    } while ((Get-Date) -lt $deadline)

    $remaining = $stillListening | Select-Object -ExpandProperty OwningProcess -Unique
    throw "Port 8001 is still occupied after cleanup attempt. Remaining PID(s): $($remaining -join ', ')"
}

Clear-Port8001

python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
