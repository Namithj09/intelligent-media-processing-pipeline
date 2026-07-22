#!/usr/bin/env bash
# scripts/test-local.sh — quick local smoke test.
#
# Assumes the server is running on http://localhost:3000 and that
# scripts/seed.ts has been run (or any image has been uploaded).
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"

echo "== health =="
curl -fsS "$BASE/api/health" | tee /dev/stderr
echo

echo "== list jobs =="
curl -fsS "$BASE/api/images" | tee /dev/stderr
echo

JOB_ID=$(curl -fsS "$BASE/api/images" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);const p=j.jobs.find(x=>x.status==='completed');console.log(p?p.id:(j.jobs[0]&&j.jobs[0].id)||'')})")
if [ -z "$JOB_ID" ]; then
  echo "no jobs yet — run scripts/seed.ts first"
  exit 1
fi

echo "== job $JOB_ID =="
curl -fsS "$BASE/api/jobs/$JOB_ID" | tee /dev/stderr
echo

echo "== stats =="
curl -fsS "$BASE/api/stats" | tee /dev/stderr
echo
