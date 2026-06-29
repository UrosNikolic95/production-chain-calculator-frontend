#!/usr/bin/env bash
set -eu

# Pull the latest code and force the working tree to match origin/main
git fetch origin
git reset --hard origin/main

# Build the app (static output lands in dist/production-chain-calculator-frontend/browser)
npm ci
npm run build
