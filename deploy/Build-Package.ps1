#Requires -Version 5.1
<#
.SYNOPSIS
    Notiq - build & packaging LOCALE per il deploy in produzione.

.DESCRIPTION
    Da eseguire sulla macchina di sviluppo (root del repo).
    Compila frontend + backend, prepara il pacchetto di deploy e lo comprime
    in _deploy\notiq-v<versione>-full-<timestamp>.zip.

    Il pacchetto contiene:
      backend\dist, backend\prisma, package.json, package-lock.json, prisma.config.js
      frontend\dist  (contenuto da specchiare nella RADICE del sito IIS)
      Deploy-Server.ps1  (lo script lato server viaggia dentro il pacchetto)

    NON include backend\.env: i segreti restano sul server.

.PARAMETER SkipBuild
    Ricompone il pacchetto usando le build esistenti, senza ricompilare.

.PARAMETER RepoRoot
    Root del repository. Default: cartella padre di questo script (deploy\..).

.PARAMETER KeepStage
    Non eliminare la cartella di staging dopo lo zip (debug).

.EXAMPLE
    .\deploy\Build-Package.ps1

.EXAMPLE
    .\deploy\Build-Package.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$RepoRoot,
    [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($n, $total, $msg) { Write-Host "[$n/$total] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)               { Write-Host "      OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg)            { Write-Host "      WARN: $msg" -ForegroundColor Yellow }

# robocopy ritorna 0-7 = successo, >=8 = errore reale
function Invoke-Robocopy {
    param([string]$Source, [string]$Dest, [string[]]$Extra)
    $args = @($Source, $Dest) + $Extra + @('/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy fallito ($Source -> $Dest), exit $LASTEXITCODE" }
    $global:LASTEXITCODE = 0
}

# --- Risoluzione percorsi ---
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot   = (Resolve-Path $RepoRoot).Path
$Frontend   = Join-Path $RepoRoot 'frontend'
$Backend    = Join-Path $RepoRoot 'backend'
$DeployDir  = Join-Path $RepoRoot '_deploy'
$ServerScript = Join-Path $PSScriptRoot 'Deploy-Server.ps1'

if (-not (Test-Path $Frontend)) { throw "frontend non trovato in $RepoRoot" }
if (-not (Test-Path $Backend))  { throw "backend non trovato in $RepoRoot" }

$pkgJson = Get-Content (Join-Path $Frontend 'package.json') -Raw | ConvertFrom-Json
$Version = $pkgJson.version
$Stamp   = Get-Date -Format 'yyyyMMdd_HHmmss'
$StageName = "notiq-v$Version-$Stamp"
$Stage   = Join-Path $DeployDir $StageName
$ZipPath = Join-Path $DeployDir "notiq-v$Version-full-$Stamp.zip"

Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host " Notiq - Build & Package  (v$Version)" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""

# --- Pre-flight git ---
try {
    $dirty = git -C $RepoRoot status --porcelain 2>$null
    if ($dirty) { Write-Warn2 "working tree non pulito - stai impacchettando modifiche non committate" }
} catch { Write-Warn2 "git non disponibile - salto il check working tree" }

$total = 5

# --- 1. Build ---
if ($SkipBuild) {
    Write-Step 1 $total "Build SALTATA (-SkipBuild)"
} else {
    Write-Step 1 $total "Build frontend (npm run build)..."
    Push-Location $Frontend
    try { npm run build; if ($LASTEXITCODE -ne 0) { throw "build frontend fallita (exit $LASTEXITCODE)" } }
    finally { Pop-Location }
    Write-Ok "frontend\dist pronto"

    Write-Step 1 $total "Build backend (npm run build)..."
    Push-Location $Backend
    try { npm run build; if ($LASTEXITCODE -ne 0) { throw "build backend fallita (exit $LASTEXITCODE)" } }
    finally { Pop-Location }
    Write-Ok "backend\dist pronto"
}

# --- 2. Verifica output ---
Write-Step 2 $total "Verifica artefatti build..."
$feIndex = Join-Path $Frontend 'dist\index.html'
$beEntry = Join-Path $Backend 'dist\app.js'
if (-not (Test-Path $feIndex)) { throw "manca $feIndex - esegui senza -SkipBuild" }
if (-not (Test-Path $beEntry)) { throw "manca $beEntry - esegui senza -SkipBuild" }
Write-Ok "frontend\dist\index.html + backend\dist\app.js presenti"

# --- 3. Staging pacchetto ---
Write-Step 3 $total "Staging in $StageName ..."
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $Stage 'backend') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Stage 'frontend') -Force | Out-Null

# Backend: dist + prisma (cartelle) + file singoli necessari a npm ci / prisma
Invoke-Robocopy (Join-Path $Backend 'dist')   (Join-Path $Stage 'backend\dist')   @('/E')
Invoke-Robocopy (Join-Path $Backend 'prisma') (Join-Path $Stage 'backend\prisma') @('/E')
foreach ($f in 'package.json', 'package-lock.json', 'prisma.config.js') {
    $src = Join-Path $Backend $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $Stage 'backend') -Force }
    else { Write-Warn2 "$f non trovato nel backend - lo salto" }
}

# Frontend: contenuto di dist (da specchiare nella radice IIS lato server)
Invoke-Robocopy (Join-Path $Frontend 'dist') (Join-Path $Stage 'frontend\dist') @('/E')

# Script lato server dentro il pacchetto
if (Test-Path $ServerScript) { Copy-Item $ServerScript $Stage -Force }
else { Write-Warn2 "Deploy-Server.ps1 non trovato - il pacchetto non lo includera'" }
Write-Ok "staging completato"

# --- 4. Zip ---
Write-Step 4 $total "Compressione -> $(Split-Path $ZipPath -Leaf) ..."
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $ZipPath -CompressionLevel Optimal
if (-not $KeepStage) { Remove-Item $Stage -Recurse -Force }
Write-Ok "zip creato"

# --- 5. Riepilogo ---
Write-Step 5 $total "Riepilogo"
$zi   = Get-Item $ZipPath
$hash = (Get-FileHash $ZipPath -Algorithm SHA256).Hash
$sizeMB = [math]::Round($zi.Length / 1MB, 2)
Write-Host ""
Write-Host "  Pacchetto : $($zi.FullName)"
Write-Host "  Versione  : $Version"
Write-Host "  Dimensione: $sizeMB MB"
Write-Host "  SHA256    : $hash"
Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host " Prossimi passi (manuali):" -ForegroundColor Magenta
Write-Host "  1. Copia lo zip sul server (E:\www\Notiq\_incoming\)"
Write-Host "  2. Estrai lo zip in una cartella temporanea"
Write-Host "  3. Esegui: .\Deploy-Server.ps1 -PackageDir <cartella-estratta>"
Write-Host "     (prima in -DryRun per verifica)"
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""
