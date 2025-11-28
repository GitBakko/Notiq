$ErrorActionPreference = "Stop"

Write-Host "Starting Backend..." -ForegroundColor Green
$backendProcess = Start-Process -FilePath "npm.cmd" -ArgumentList "run dev" -WorkingDirectory "backend" -PassThru -NoNewWindow

Write-Host "Starting Frontend..." -ForegroundColor Green
$frontendProcess = Start-Process -FilePath "npm.cmd" -ArgumentList "run dev" -WorkingDirectory "frontend" -PassThru -NoNewWindow

# Wait for services to start (adjust time as needed)
Start-Sleep -Seconds 10

try {
    Write-Host "Running E2E Tests..." -ForegroundColor Cyan
    Set-Location "frontend"
    npx playwright test
}
catch {
    Write-Host "Tests Failed!" -ForegroundColor Red
    $global:LastExitCode = 1
}
finally {
    Write-Host "Stopping Services..." -ForegroundColor Yellow
    Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $frontendProcess.Id -Force -ErrorAction SilentlyContinue
    
    # Kill any lingering node processes started by npm (Windows specific)
    # Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
