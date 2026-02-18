const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');

// Ensure we are in the root (assuming script is in ROOT/scripts/)
const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');

console.log(`Starting Deployment Packager...`);
console.log(`Root Dir: ${ROOT_DIR}`);
console.log(`Release Dir: ${RELEASE_DIR}`);

// Cleanup Release Dir
if (fs.existsSync(RELEASE_DIR)) {
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(RELEASE_DIR);

const exec = (cmd, cwd) => {
  console.log(`Running: ${cmd} in ${cwd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
};

async function createZip(zipName, addContent) {
  const outPath = path.join(RELEASE_DIR, zipName);
  const output = fs.createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      console.log(`Created ${zipName}: ${archive.pointer()} bytes`);
      resolve();
    });
    archive.on('error', reject);
    archive.pipe(output);
    addContent(archive);
    archive.finalize();
  });
}

async function main() {
  try {
    // 1. Build Frontend
    console.log('\n--- Building Frontend ---');
    // Ensure deps are installed mostly for safety, but usually dev env has them.
    exec('npm install && npm run build', path.join(ROOT_DIR, 'frontend'));

    // 2. Build Backend
    console.log('\n--- Building Backend ---');
    exec('npm install && npm run build', path.join(ROOT_DIR, 'backend'));

    // 3. Zip Frontend
    console.log('\n--- Zipping Frontend ---');
    await createZip('frontend.zip', (archive) => {
      const feDist = path.join(ROOT_DIR, 'frontend', 'dist');
      archive.directory(feDist, false); // put content of dist at root of zip
    });

    // 4. Zip Backend
    console.log('\n--- Zipping Backend ---');
    await createZip('backend.zip', (archive) => {
      const beDir = path.join(ROOT_DIR, 'backend');
      archive.directory(path.join(beDir, 'dist'), 'dist');
      archive.directory(path.join(beDir, 'prisma'), 'prisma');
      archive.file(path.join(beDir, 'package.json'), { name: 'package.json' });
      archive.file(path.join(beDir, 'package-lock.json'), { name: 'package-lock.json' });
      // EXCLUDING .env explicitly by not adding it
    });

    // 5. Generate Scripts
    console.log('\n--- Generating Deployment Scripts ---');

    const readmeContent = `
DEPLOYMENT INSTRUCTIONS
=======================

1. REQUIREMENTS
   - Node.js (v18+)
   - PostgreSQL Database
   - Reverse Proxy (Nginx/Apache/IIS) for serving frontend and proxying /api AND /uploads to backend.
   - NOTE: If using IIS, ensure "Application Request Routing" (ARR) and "URL Rewrite" modules are installed and Proxy is enabled.

2. FRONTEND
   - Extract 'frontend.zip' to your web server root (e.g., /var/www/notiq).
   - Configure your web server to serve index.html for all non-file routes (SPA Fallback).

3. BACKEND
   - Extract 'backend.zip' to your application directory (e.g. /opt/notiq-api).
   - Create a '.env' file in this directory. See ENV VARIABLES below.
   - Run the initialization script 'init-prod.sh' (Linux) or 'init-prod.ps1' (Windows).
     This will:
       - Install dependencies.
       - Apply database migrations.
       - Allow you to create a SuperAdmin.
   - Start the application using a process manager like PM2:
     pm2 start dist/index.js --name "notiq-api"

4. ENV VARIABLES (.env)
   Create a .env file with the following keys:

   # Server
   PORT=3000
   NODE_ENV=production
   
   # Database
   DATABASE_URL="postgresql://user:password@localhost:5432/notiq_db?schema=public"
   
   # Security
   JWT_SECRET="YOUR_LONG_RANDOM_SECRET_KEY"
   
   # Invitation Configuration
   # Enable to restrict registration to invited users only
   INVITATION_SYSTEM_ENABLED="true" 
   
   # Email Service (SMTP) - Optional but recommended for verification
   SMTP_HOST="smtp.example.com"
   SMTP_PORT=587
   SMTP_USER="user"
   SMTP_PASS="password"
   SMTP_FROM="noreply@notiq.ai"
   
   # Frontend URL (for CORS and Email Links)
   FRONTEND_URL="https://your-domain.com"
`;

    fs.writeFileSync(path.join(RELEASE_DIR, 'README_DEPLOY.txt'), readmeContent.trim());

    // Linux Init Script
    const shScript = `
#!/bin/bash
set -e # Exit on error

echo "--- Notiq Production Initialization ---"

echo "1. Installing Dependencies..."
npm install --production

echo "2. Cleaning and Generating Prisma Client..."
rm -rf node_modules/.prisma
npx prisma generate

echo "3. Synching Database Schema (Force)..."
npx prisma db push --accept-data-loss

echo "4. Checking & Patching Database Schema..."
if [ -f "dist/scripts/emergency-fix-db.js" ]; then
    node dist/scripts/emergency-fix-db.js
else
    echo "Warning: emergency-fix-db script not found."
fi

echo "5. SuperAdmin Configuration"
echo "Would you like to seed the SuperAdmin user? (y/n)"
read -r response
if [[ "$response" =~ ^([yY][eE][sS]|[yY])+$ ]]
then
    if [ -f "dist/scripts/create-superadmin.js" ]; then
        node dist/scripts/create-superadmin.js
    else
        echo "Warning: create-superadmin script not found."
    fi
fi

echo "6. Database Reset (Optional)"
echo "Would you like to reset the database (KEEPING SuperAdmin)? (y/n)"
read -r response
if [[ "$response" =~ ^([yY][eE][sS]|[yY])+$ ]]
then
    if [ -f "dist/scripts/reset-db-except-superadmin.js" ]; then
        node dist/scripts/reset-db-except-superadmin.js
    else
        echo "Warning: reset-db script not found."
    fi
fi

echo "--- Initialization Complete ---"
echo "You can now start the server with: pm2 start dist/index.js --name notiq-api"
`;
    fs.writeFileSync(path.join(RELEASE_DIR, 'init-prod.sh'), shScript.trim());

    // Windows Init Script
    const psScript = `
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
`;
    fs.writeFileSync(path.join(RELEASE_DIR, 'init-prod.ps1'), psScript.trim());

    console.log('\nSUCCESS! Release package generated in "release/" directory.');

  } catch (err) {
    console.error('Packaging Failed:', err);
    process.exit(1);
  }
}

main();
