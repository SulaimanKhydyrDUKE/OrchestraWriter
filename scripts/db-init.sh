#!/usr/bin/env bash
# Creates all tables (schema/ then migrations/) and runs seeds/ against the DB in .env.
# Re-runnable: already-applied schema files are skipped; seeds are written to be idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run db:migrate
npm run db:seed
