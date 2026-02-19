# Notiq Deployment Checklist (Windows Server 2019 + IIS)

This checklist guides you through deploying Notiq on Windows Server 2019 using IIS.

## 1. Server Prerequisites

- [X] **Node.js**: Install the latest LTS version of Node.js (v18+).
- [X] **PostgreSQL**: Install PostgreSQL for Windows (v14+).
- [X] **IIS Web Server**: Ensure IIS is enabled via Server Manager.
- [ ] **IIS Modules**:
    - [X] **URL Rewrite Module**: Download and install (essential for SPA and Reverse Proxy).
    - [X] **Application Request Routing (ARR)**: Download and install (essential for Reverse Proxy).
- [X] **PM2**: Install PM2 globally to manage the backend process:
    ```powershell
    npm install -g pm2
    npm install -g pm2-windows-startup
    pm2-startup install
    ```

## 2. Database Setup

- [X] Create a new database (e.g., `notiq_prod`).
- [X] Create a user with access to this database.

## 3. Backend Deployment

The backend will run as a local service on port 3001, managed by PM2. IIS will reverse-proxy requests from `/api` to this service.

1.  [X] **Prepare Files**: Copy the `backend` folder to the server (e.g., `C:\inetpub\wwwroot\notiq\backend`).
2.  [X] **Install Dependencies**:
    ```powershell
    cd C:\inetpub\wwwroot\notiq\backend
    # Install ALL dependencies (including dev) to allow building
    # Use --include=dev to ensure devDeps are installed even if NODE_ENV=production
    npm ci --include=dev
    ```
3.  [X] **Build**:
    ```powershell
    # Generate Prisma Client (fixes Permission error)
    npx prisma generate
    # Build TypeScript
    npm run build
    # (Optional) Remove dev dependencies after build to save space
    npm prune --production
    ```
4.  [X] **Configure Environment**:
    - Create a `.env` file in the `backend` folder:
      ```env
      PORT=3001
      DATABASE_URL=postgresql://user:password@localhost:5432/notiq_prod
      JWT_SECRET=your_secure_secret
      CORS_ORIGIN=https://your-domain.com
      ```
5.  [X] **Database Migration**:
    ```powershell
    npx prisma migrate deploy
    ```
6.  [X] **Start Service**:
    ```powershell
    pm2 start dist/app.js --name notiq-backend
    pm2 save
    ```

## 4. Frontend Deployment

The frontend will be served as static files by IIS.

1.  [ ] **Build Locally** (or on server if dev tools installed):
    - **CRITICAL**: Ensure `.env.production` exists in `frontend` with the correct API URL (use `/api` if using Reverse Proxy on same domain, or full URL if different):
      ```env
      # If using IIS Reverse Proxy (Recommended):
      VITE_API_URL=/api
      # WebSocket URL for collaboration (Hocuspocus)
      # If using Reverse Proxy for WS (requires additional config) or direct port:
      # For now, assuming direct connection to port 1234 (ensure firewall allows it)
      # OR if you proxy /ws to 1234:
      VITE_WS_URL=ws://your-domain.com:1234
      # If testing locally on server:
      # VITE_WS_URL=ws://localhost:1234
      ```
    - **IMPORTANT**: You MUST run `npm run build` AFTER creating/modifying `.env.production`. The variables are baked into the build.
    - Run build:
      ```powershell
      cd frontend
      npm run build
      ```
2.  [ ] **Deploy Files**:
    - Copy the contents of `frontend/dist` to a folder on the server (e.g., `C:\inetpub\wwwroot\notiq\frontend`).
    - **Verify**: Ensure `web.config` is present in this folder (it handles SPA routing).

## 5. IIS Configuration

1.  [ ] **Create Website**:
    - Open IIS Manager.
    - Add Website -> Name: `Notiq`, Physical Path: `C:\inetpub\wwwroot\notiq\frontend`, Port: 80 (or 443 for HTTPS).
2.  [ ] **Configure Reverse Proxy (for API)**:
    - Open the `Notiq` website in IIS.
    - Open **URL Rewrite**.
    - Click **Add Rule(s)...** -> **Reverse Proxy**.
    - If prompted to enable proxy functionality, click OK.
    - In "Inbound Rules", enter server name: `localhost:3001`.
    - Check "Enable SSL Offloading" if using HTTPS.
    - Click OK.
    - **Edit the Rule**:
        - Double click the created rule.
        - Change **Pattern** to: `^api/(.*)`
        - Change **Rewrite URL** to: `http://localhost:3001/api/{R:1}`
        - This ensures only requests starting with `/api/` go to the backend.
    - **Add Rule for Uploads** (Optional, if images are 404):
        - Create another Reverse Proxy rule.
        - Pattern: `^uploads/(.*)`
        - Rewrite URL: `http://localhost:3001/uploads/{R:1}`
    - **Add Rule for WebSockets (Hocuspocus)**:
        - **Prerequisite**: Ensure "WebSocket Protocol" is installed in IIS (Server Manager -> Add Roles and Features -> Web Server -> Application Development -> WebSocket Protocol). **Restart IIS after installing this role.**
        - Create another Reverse Proxy rule.
        - Pattern: `^ws` (or `^collaboration` if you prefer a prefix)
        - Rewrite URL: `http://localhost:1234` (IIS handles the WS upgrade automatically)
        - **Important**: In `.env.production`, set `VITE_WS_URL=wss://your-domain.com/ws` (note the `wss://` for HTTPS and `/ws` path).
        - **Firewall**: Ensure port 1234 is NOT blocked by firewall if you are connecting directly, but since we are proxying via IIS (port 80/443), port 1234 only needs to be open locally.
3.  [ ] **MIME Types**:
    - Ensure the following are added to MIME Types in IIS (Site or Server level):
        - `.webp` -> `image/webp`
        - `.woff2` -> `font/woff2`
        - `.webmanifest` -> `application/manifest+json` (Fixes 404 on manifest)
        - `.json` -> `application/json`

## 6. Verification

- [ ] Navigate to `http://your-domain.com` (or localhost).
- [ ] Verify the app loads (Frontend).
- [ ] Try to Login/Signup (Tests Backend API connection).
- [ ] Refresh a page (Tests SPA `web.config` rewrite).

## 7. HTTPS (Recommended)

- [ ] Use **Win-ACME** (Let's Encrypt for Windows) to automatically generate and bind an SSL certificate to your IIS site.
