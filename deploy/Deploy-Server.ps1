#Requires -Version 5.1
<#
.SYNOPSIS
    Notiq - deploy lato SERVER (notiq.epartner.it, IIS + pm2).

.DESCRIPTION
    Da eseguire SUL SERVER di produzione dopo aver estratto il pacchetto
    prodotto da Build-Package.ps1. Esegue, in ordine e con fail-fast:

      1. Pre-flight  (pacchetto valido, .env presente, pg_dump e pm2 sul PATH)
      2. Backup DB   (pg_dump -Fc del Postgres di produzione)   <-- rete di sicurezza
      3. Backup app  (dist/prisma/.env backend + frontend completo)
      4. Stop backend (pm2 stop)
      5. Deploy backend (robocopy /MIR dist+prisma, copia file singoli)
      6. Deploy frontend (robocopy /MIR del CONTENUTO di dist nella radice IIS)
      7. npm ci --omit=dev + prisma generate + prisma migrate deploy
      8. Start backend (pm2 restart)
      9. Verifica

    Server multi-sito (~30 siti IIS): tocca SOLO E:\www\Notiq.
    backend\.env NON viene mai sovrascritto (resta quello del server).

.PARAMETER PackageDir
    Cartella del pacchetto estratto (contiene backend\ e frontend\).

.PARAMETER BackendRoot   Default E:\www\Notiq\backend
.PARAMETER FrontendRoot  Default E:\www\Notiq\frontend  (RADICE del sito IIS)
.PARAMETER BackupRoot    Default E:\www\Notiq           (dove finisce _backup_<ts>)
.PARAMETER Pm2Name       Default notiq-backend
.PARAMETER SkipDbBackup  Salta il pg_dump (sconsigliato).
.PARAMETER DryRun        Stampa le azioni senza eseguire quelle distruttive.

.EXAMPLE
    .\Deploy-Server.ps1 -PackageDir C:\temp\notiq-v1.10.2-20260617_120000 -DryRun
.EXAMPLE
    .\Deploy-Server.ps1 -PackageDir C:\temp\notiq-v1.10.2-20260617_120000
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageDir,
    [string]$BackendRoot  = 'E:\www\Notiq\backend',
    [string]$FrontendRoot = 'E:\www\Notiq\frontend',
    [string]$BackupRoot   = 'E:\www\Notiq',
    [string]$Pm2Name      = 'notiq-backend',
    [switch]$SkipDbBackup,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($n, $msg) { Write-Host "[$n/9] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)       { Write-Host "      OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg)    { Write-Host "      WARN: $msg" -ForegroundColor Yellow }
function Write-Dry($msg)      { Write-Host "      [DRY-RUN] $msg" -ForegroundColor DarkGray }

function Invoke-Robocopy {
    param([string]$Source, [string]$Dest, [string[]]$Extra)
    if ($DryRun) { Write-Dry "robocopy $Source -> $Dest $($Extra -join ' ')"; return }
    $args = @($Source, $Dest) + $Extra + @('/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy fallito ($Source -> $Dest), exit $LASTEXITCODE" }
    $global:LASTEXITCODE = 0
}

function Invoke-Native {
    param([scriptblock]$Block, [string]$Label)
    if ($DryRun) { Write-Dry $Label; return }
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "$Label fallito (exit $LASTEXITCODE)" }
}

$PackageDir = (Resolve-Path $PackageDir).Path
$Stamp     = Get-Date -Format 'yyyyMMdd_HHmmss'
$BackupDir = Join-Path $BackupRoot "_backup_$Stamp"

Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host " Notiq - Deploy Server" -ForegroundColor Magenta
if ($DryRun) { Write-Host " *** DRY-RUN: nessuna azione distruttiva ***" -ForegroundColor Yellow }
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""

# --- 1. Pre-flight ---
Write-Step 1 "Pre-flight..."
$pkgBackendDist  = Join-Path $PackageDir 'backend\dist'
$pkgFrontendDist = Join-Path $PackageDir 'frontend\dist'
$envFile         = Join-Path $BackendRoot '.env'
if (-not (Test-Path $pkgBackendDist))  { throw "pacchetto invalido: manca $pkgBackendDist" }
if (-not (Test-Path $pkgFrontendDist)) { throw "pacchetto invalido: manca $pkgFrontendDist" }
if (-not (Test-Path $envFile))         { throw "manca $envFile sul server - crealo prima del deploy" }
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue))      { throw "pm2 non trovato sul PATH" }
if (-not $SkipDbBackup -and -not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    throw "pg_dump non trovato sul PATH (usa -SkipDbBackup per saltare, sconsigliato)"
}
Write-Ok "pacchetto valido, .env presente, pm2/pg_dump disponibili"

if ($DryRun) { Write-Dry "mkdir $BackupDir" } else { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }

# --- 2. Backup DB (pg_dump) ---
Write-Step 2 "Backup database (pg_dump)..."
if ($SkipDbBackup) {
    Write-Warn2 "backup DB SALTATO (-SkipDbBackup)"
} else {
    $envText = Get-Content $envFile -Raw
    $m = [regex]::Match($envText, 'DATABASE_URL\s*=\s*"?(?<url>postgres(?:ql)?://[^"\r\n]+)"?')
    if (-not $m.Success) { throw "DATABASE_URL non trovato/parsabile in $envFile" }
    $u = [regex]::Match($m.Groups['url'].Value,
        '://(?<user>[^:]+):(?<pass>[^@]+)@(?<host>[^:/]+):(?<port>\d+)/(?<db>[^?]+)')
    if (-not $u.Success) { throw "DATABASE_URL in formato inatteso (atteso user:pass@host:port/db)" }
    $dbUser = [Uri]::UnescapeDataString($u.Groups['user'].Value)
    $dbPass = [Uri]::UnescapeDataString($u.Groups['pass'].Value)
    $dbHost = $u.Groups['host'].Value
    $dbPort = $u.Groups['port'].Value
    $dbName = $u.Groups['db'].Value
    $dumpFile = Join-Path $BackupDir "db_${dbName}_$Stamp.dump"
    Write-Host "      target: $dbUser@${dbHost}:$dbPort/$dbName -> $(Split-Path $dumpFile -Leaf)"
    if ($DryRun) {
        Write-Dry "pg_dump -Fc -h $dbHost -p $dbPort -U $dbUser -d $dbName -f <dump>"
    } else {
        $env:PGPASSWORD = $dbPass
        try {
            pg_dump -h $dbHost -p $dbPort -U $dbUser -d $dbName -Fc -f $dumpFile
            if ($LASTEXITCODE -ne 0) { throw "pg_dump fallito (exit $LASTEXITCODE)" }
        } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
        $dumpMB = [math]::Round((Get-Item $dumpFile).Length / 1MB, 2)
        Write-Ok "dump DB creato ($dumpMB MB)"
    }
}

# --- 3. Backup app ---
Write-Step 3 "Backup applicazione corrente..."
Invoke-Robocopy (Join-Path $BackendRoot 'dist')   (Join-Path $BackupDir 'backend\dist')   @('/E')
Invoke-Robocopy (Join-Path $BackendRoot 'prisma') (Join-Path $BackupDir 'backend\prisma') @('/E')
if (-not $DryRun) {
    Copy-Item $envFile (Join-Path $BackupDir 'backend\.env') -Force
    $bePkg = Join-Path $BackendRoot 'package.json'
    if (Test-Path $bePkg) { Copy-Item $bePkg (Join-Path $BackupDir 'backend\package.json') -Force }
}
Invoke-Robocopy $FrontendRoot (Join-Path $BackupDir 'frontend') @('/E', '/XD', (Join-Path $FrontendRoot 'node_modules'))
Write-Ok "backup app in $BackupDir"

# --- 4. Stop backend ---
Write-Step 4 "Stop backend (pm2 stop $Pm2Name)..."
if ($DryRun) { Write-Dry "pm2 stop $Pm2Name" }
else { pm2 stop $Pm2Name; Write-Ok "backend fermato (o gia' fermo)" }

# --- 5. Deploy backend ---
Write-Step 5 "Deploy backend..."
# /MIR su dist e prisma: rispecchia esattamente il pacchetto (rimuove file orfani)
Invoke-Robocopy $pkgBackendDist                       (Join-Path $BackendRoot 'dist')   @('/MIR')
Invoke-Robocopy (Join-Path $PackageDir 'backend\prisma') (Join-Path $BackendRoot 'prisma') @('/MIR')
if (-not $DryRun) {
    foreach ($f in 'package.json', 'package-lock.json', 'prisma.config.js') {
        $src = Join-Path $PackageDir "backend\$f"
        if (Test-Path $src) { Copy-Item $src $BackendRoot -Force }
    }
} else { Write-Dry "copy package.json/package-lock.json/prisma.config.js -> $BackendRoot" }
Write-Ok "backend aggiornato (.env preservato)"

# --- 6. Deploy frontend ---
Write-Step 6 "Deploy frontend (mirror contenuto dist nella radice IIS)..."
# /XF preserva web.config (IIS rewrite, incl. /chat-ws) e il web.config.bak manuale
Invoke-Robocopy $pkgFrontendDist $FrontendRoot @('/MIR', '/XF', 'web.config', 'web.config.bak')
Write-Ok "frontend specchiato in $FrontendRoot"

# --- 7. Install + Prisma ---
Write-Step 7 "npm ci + prisma generate + migrate deploy..."
Push-Location $BackendRoot
try {
    Invoke-Native { npm ci --omit=dev }       'npm ci --omit=dev'
    Invoke-Native { npx prisma generate }     'prisma generate'
    Invoke-Native { npx prisma migrate deploy } 'prisma migrate deploy'
} finally { Pop-Location }
Write-Ok "dipendenze + client Prisma + migration applicate"

# --- 8. Start backend ---
Write-Step 8 "Start backend (pm2 restart $Pm2Name)..."
if ($DryRun) { Write-Dry "pm2 restart $Pm2Name (start se assente)" }
else {
    pm2 restart $Pm2Name
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "pm2 restart fallito, provo start..."
        Push-Location $BackendRoot
        try { pm2 start dist/app.js --name $Pm2Name } finally { Pop-Location }
    }
    pm2 save | Out-Null
    Write-Ok "backend avviato"
}

# --- 9. Verifica ---
Write-Step 9 "Verifica..."
if (-not $DryRun) {
    pm2 status $Pm2Name
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:3001/health' -UseBasicParsing -TimeoutSec 8
        Write-Ok "backend health HTTP $($r.StatusCode)"
    } catch { Write-Warn2 "health check locale non riuscito: $($_.Exception.Message)" }
}
Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host " Deploy completato. Verifiche manuali:" -ForegroundColor Magenta
Write-Host "  - https://notiq.epartner.it  (SPA + asset aggiornati)"
Write-Host "  - curl -sI https://notiq.epartner.it/sw.js  (last-modified fresco)"
Write-Host "  - Login, crea nota (sync), Vault, condivisione (email), Kanban, Chat"
Write-Host "  - pm2 logs $Pm2Name --lines 50"
Write-Host "  Backup di questo deploy: $BackupDir"
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""
