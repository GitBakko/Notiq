Write-Host "--- Resolving Failed Migration ---" -ForegroundColor Cyan
Write-Host "Attempts to mark the failed '20251204135754_add_notifications' migration as rolled back."
Write-Host "This allows the patched migration to be re-applied."

npx prisma migrate resolve --rolled-back "20251204135754_add_notifications"

if ($LASTEXITCODE -eq 0) {
    Write-Host "Success! You can now run init-prod.ps1 again." -ForegroundColor Green
} else {
    Write-Host "Error: Failed to resolve migration." -ForegroundColor Red
}
