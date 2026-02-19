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