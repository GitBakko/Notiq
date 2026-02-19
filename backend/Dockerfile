# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.js ./prisma.config.js
COPY --from=builder /app/config.json ./config.json

RUN npx prisma generate

# Expose port
EXPOSE 3001

# Start command (includes migration)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/app.js"]
