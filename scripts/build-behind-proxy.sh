#!/usr/bin/env sh
# Only needed on networks where npm must go through an HTTPS proxy with its own CA
# (e.g. the sandbox this was developed in). On a normal laptop: docker compose up --build
set -eu
CA=${NPM_CA:-/root/.ccr/ca-bundle.crt}
docker build --network host --build-arg HTTPS_PROXY="${HTTPS_PROXY}" --secret id=npm_ca,src="$CA" -t facilitygrid-backend .
docker build --network host --build-arg HTTPS_PROXY="${HTTPS_PROXY}" --secret id=npm_ca,src="$CA" -t facilitygrid-web -f apps/web/Dockerfile .
