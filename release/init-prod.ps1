$ErrorActionPreference = "Stop"

Write-Host "--- Notiq Production Initialization ---" -ForegroundColor Cyan

Write-Host "1. Installing Dependencies..." -ForegroundColor Green
npm install --production

Write-Host "2. Cleaning and Generating Prisma Client..." -ForegroundColor Green
if (Test-Path "node_modules/.prisma") {
    Remove-Item -Path "node_modules/.prisma" -Recurse -Force
}
npx prisma generate

Write-Host "3. Synching Database Schema (Force)..." -ForegroundColor Green
npx prisma db push --accept-data-loss

Write-Host "4. Checking & Patching Database Schema..." -ForegroundColor Green
if (Test-Path "dist/scripts/emergency-fix-db.js") {
    node dist/scripts/emergency-fix-db.js
} else {
    Write-Warning "emergency-fix-db script not found."
}

Write-Host "5. SuperAdmin Configuration" -ForegroundColor Green
$response = Read-Host "Would you like to seed the SuperAdmin user? (y/n)"
if ($response -match "^[yY]") {
    if (Test-Path "dist/scripts/create-superadmin.js") {
        node dist/scripts/create-superadmin.js
    } else {
        Write-Warning "create-superadmin script not found."
    }
}

Write-Host "6. Database Reset (Optional)" -ForegroundColor Green
$response = Read-Host "Would you like to reset the database (KEEPING SuperAdmin)? (y/n)"
if ($response -match "^[yY]") {
    if (Test-Path "dist/scripts/reset-db-except-superadmin.js") {
        node dist/scripts/reset-db-except-superadmin.js
    } else {
        Write-Warning "reset-db script not found."
    }
}

Write-Host "--- Initialization Complete ---" -ForegroundColor Cyan
Write-Host "You can now start the server."