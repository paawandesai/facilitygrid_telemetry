# Built from the repo root: docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_CA=""
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN if [ -n "$NPM_CA" ]; then printf '%s\n' "$NPM_CA" > /tmp/npm-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.pem; fi; \
    npm ci --no-audit --no-fund -w @fg/shared -w @fg/web --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @fg/shared && npm run build -w @fg/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
