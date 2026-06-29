#!/usr/bin/env bash
set -euo pipefail

docker build -t pcc-frontend .
docker rm -f pcc-frontend 2>/dev/null || true
docker run -d --rm -p 8080:80 --name pcc-frontend pcc-frontend
