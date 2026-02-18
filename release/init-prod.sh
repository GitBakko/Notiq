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