# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY extension/package.json extension/
RUN npm ci --workspace server --include-workspace-root=false --ignore-scripts=false
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
RUN npm run build -w server && npm prune --omit=dev --workspace server

FROM node:20-bookworm-slim
ENV NODE_ENV=production DATABASE_PATH=/data/postmark.db PORT=8787
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
