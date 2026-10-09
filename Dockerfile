# Backend image: the api, the worker and the one-shot migrator share it.
# The optional npm_ca secret lets the build trust a TLS-intercepting proxy CA;
# without it (the normal case) npm uses the public registry as usual.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=secret,id=npm_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca \
    npm ci --no-audit --no-fund -w @fg/shared -w @fg/api -w @fg/worker --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN npm run build:backend

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=secret,id=npm_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca \
    npm ci --no-audit --no-fund --omit=dev -w @fg/shared -w @fg/api -w @fg/worker
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY db db
ENV MIGRATIONS_DIR=/app/db/migrations
USER node
CMD ["node", "apps/api/dist/main.js"]
