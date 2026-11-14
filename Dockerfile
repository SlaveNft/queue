# syntax=docker/dockerfile:1
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/ledger/package.json packages/ledger/package.json
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV QUEUE_PORT=8789
ENV QUEUE_HOST=0.0.0.0
ENV QUEUE_DB_PATH=/data/queue.db
# Safe default: the image serves the console read-only until an operator token
# is supplied. `docker run -e QUEUE_READ_ONLY=0 -e QUEUE_OPERATOR_TOKEN=…` opts in.
ENV QUEUE_READ_ONLY=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/core ./packages/core
COPY --from=build /app/packages/ledger ./packages/ledger
COPY --from=build /app/data ./data
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8789/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "-w", "@queue/server", "run", "start"]
