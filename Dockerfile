# Backend image: the api, the worker and the one-shot migrator share it.
# The optional NPM_CA build arg (a PEM string) lets npm trust a TLS-intercepting
# proxy CA; without it (the normal case) npm uses the public registry as usual.
# No BuildKit-only syntax, so the classic builder works too.
FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_CA=""
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN if [ -n "$NPM_CA" ]; then printf '%s\n' "$NPM_CA" > /tmp/npm-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.pem; fi; \
    npm ci --no-audit --no-fund -w @fg/shared -w @fg/api -w @fg/worker --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN npm run build:backend

FROM node:22-alpine
WORKDIR /app
ARG NPM_CA=""
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN if [ -n "$NPM_CA" ]; then printf '%s\n' "$NPM_CA" > /tmp/npm-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.pem; fi; \
    npm ci --no-audit --no-fund --omit=dev -w @fg/shared -w @fg/api -w @fg/worker
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY db db
ENV MIGRATIONS_DIR=/app/db/migrations
USER node
CMD ["node", "apps/api/dist/main.js"]
