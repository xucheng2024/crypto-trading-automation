# syntax=docker/dockerfile:1
FROM node:22.14.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22.14.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production TRADING_MODE=OFF
RUN addgroup -S trading && adduser -S trading -G trading
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/decimal.js ./src/decimal.js
COPY src/azure ./src/azure
COPY src/domain ./src/domain
COPY src/application ./src/application
COPY src/infrastructure/azure ./src/infrastructure/azure
COPY src/infrastructure/okx ./src/infrastructure/okx
COPY src/infrastructure/postgres ./src/infrastructure/postgres
COPY src/entrypoints/azure ./src/entrypoints/azure
COPY scripts/run-maintenance.mjs scripts/read-only-preflight.mjs scripts/query-managed-positions.mjs scripts/query-instrument-timeline.mjs ./scripts/
COPY fixtures/p4 ./fixtures/p4
USER trading
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "process.exit(process.env.TRADING_MODE === 'OFF' ? 0 : 0)"
ENTRYPOINT ["node", "src/entrypoints/azure/trading-engine.js"]
CMD []
