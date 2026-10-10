#!/usr/bin/env sh
# Only needed on networks where npm must go through an HTTPS proxy with its own CA
# (e.g. the sandbox this was developed in). On a normal laptop: docker compose up --build
set -eu
CA=${NPM_CA_FILE:-/root/.ccr/agent-proxy-ca.crt}
docker build --network host --build-arg HTTPS_PROXY="${HTTPS_PROXY}" --build-arg NPM_CA="$(cat "$CA")" -t facilitygrid-backend .
docker build --network host --build-arg HTTPS_PROXY="${HTTPS_PROXY}" --build-arg NPM_CA="$(cat "$CA")" -t facilitygrid-web -f apps/web/Dockerfile .
