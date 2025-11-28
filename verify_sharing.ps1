$ErrorActionPreference = "Stop"

Write-Host "Starting Backend..." -ForegroundColor Green
$backendProcess = Start-Process -FilePath "npm.cmd" -ArgumentList "run dev" -WorkingDirectory "backend" -PassThru -NoNewWindow

Write-Host "Starting Frontend..." -ForegroundColor Green
$frontendProcess = Start-Process -FilePath "npm.cmd" -ArgumentList "run dev" -WorkingDirectory "frontend" -PassThru -NoNewWindow

# Wait for services to start
Start-Sleep -Seconds 10

try {
    Write-Host "Running Sharing E2E Test..." -ForegroundColor Cyan
    Set-Location "frontend"
    npx playwright test e2e/sharing.spec.ts
}
catch {
    Write-Host "Tests Failed!" -ForegroundColor Red
    $global:LastExitCode = 1
}
finally {
    Write-Host "Stopping Services..." -ForegroundColor Yellow
    Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $frontendProcess.Id -Force -ErrorAction SilentlyContinue
}
