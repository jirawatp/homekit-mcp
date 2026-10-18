# syntax=docker/dockerfile:1
# Exact Node release + Debian distribution; pass a reviewed registry digest through
# NODE_IMAGE for byte-for-byte base-image pinning (see docs/docker.md).
ARG NODE_IMAGE=node:22.23.3-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV npm_config_audit=false npm_config_fund=false
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY config/mock.json ./config/mock.json
RUN npm run build && node --test dist/test/*.test.js

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
ENV npm_config_audit=false npm_config_fund=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=96
WORKDIR /app
COPY --from=production-dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist/src ./dist/src
COPY --chown=1000:1000 package.json ./package.json
COPY --chown=1000:1000 config/mock.json ./config/mock.json
USER 1000:1000
ENTRYPOINT ["node", "dist/src/index.js"]
CMD ["--mode", "mock", "--config", "/app/config/mock.json"]
