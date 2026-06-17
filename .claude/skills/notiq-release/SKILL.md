---
name: notiq-release
description: Cut a new Notiq version — bump version, update changelog, commit and tag. Use when the user asks to release, bump the version, or prepare a new app version. Frontend package.json is the single source of truth.
disable-model-invocation: true
---

# Notiq — Release / Version Bump

## Source of truth
- **`frontend/package.json` `version`** is the single source of truth, imported by `frontend/src/data/changelog.ts`.
- **`backend/package.json` stays at `1.7.3`** by convention — do NOT bump it.

## Steps
1. Decide bump (semver): patch = fix, minor = feature, major = breaking.
2. Edit `frontend/package.json` → `version`.
3. Update **`frontend/src/data/changelog.ts`** — add a new entry (version, date, EN + IT highlights). This drives the in-app "What's New".
4. If user-facing strings were added: confirm keys exist in **both** `frontend/src/locales/en.json` AND `it.json`.
5. Sync project memory: update the "Current version" line in `MEMORY.md` / project-status note.
6. Commit + tag:
   ```bash
   git add -A
   git commit -m "release: v<version> — <summary>"
   git tag v<version>
   git push && git push --tags
   ```

## After release
- Build the deploy package locally: `.\deploy\Build-Package.ps1` (reads the new version from `frontend/package.json`).
- To deploy the new version to production, use the **notiq-deploy** skill (`Deploy-Server.ps1` on the server).
- Suggest re-running relevant E2E specs (`frontend/e2e/`) for touched flows before deploy.
