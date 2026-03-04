#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AHA_CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$AHA_CLI_DIR/.." && pwd)"

PRD_PATH="${PRD_PATH:-$ROOT_DIR/ralph/prd.json}"
ASK_OUTPUT="${ASK_OUTPUT:-$ROOT_DIR/用户访谈/自动生成_ASK用户旅程访谈.md}"
RUN_COMPOSE="${RUN_COMPOSE:-0}"
GENERATE_ASK="${GENERATE_ASK:-1}"
RUN_INTERVIEW="${RUN_INTERVIEW:-1}"

echo "== V1/V2 Closed Loop Validation =="
echo "root: $ROOT_DIR"

echo
echo "[1/4] aha-cli typecheck"
( cd "$AHA_CLI_DIR" && yarn typecheck )

echo
echo "[2/4] aha-cli compose + rating command tests"
( cd "$AHA_CLI_DIR" && ./node_modules/.bin/tsx --env-file .env.integration-test ./node_modules/.bin/vitest run src/commands/teams.compose.test.ts src/commands/rating.test.ts )

echo
echo "[3/4] happy-server critical tests"
( cd "$ROOT_DIR/happy-server" && yarn test sources/modules/teamComposition.spec.ts sources/app/api/routes/roleRoutes.spec.ts )

echo
echo "[4/4] kanban sync tests"
( cd "$ROOT_DIR/kanban" && yarn test sources/sync/settings.spec.ts sources/sync/apiGithub.spec.ts )

if [[ "$GENERATE_ASK" == "1" ]]; then
  echo
  echo "[5/5] generate local ASK interview report"
  (
    cd "$AHA_CLI_DIR" && \
    PRD_PATH="$PRD_PATH" \
    ASK_OUTPUT="$ASK_OUTPUT" \
    ./node_modules/.bin/tsx scripts/generate_local_ask_report.ts
  )
fi

if [[ "$RUN_COMPOSE" == "1" ]]; then
  echo
  echo "[optional] generate ASK interview via teams compose (remote API)"
  ( cd "$AHA_CLI_DIR" && ./bin/aha.mjs teams compose --prd "$PRD_PATH" --target wow --mode multi --ask-output "$ASK_OUTPUT" )
fi

if [[ "$RUN_INTERVIEW" == "1" ]]; then
  echo
  echo "[optional] generate log-driven user interview"
  if [[ -x "$ROOT_DIR/node_modules/.bin/tsx" ]]; then
    "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/scripts/user-interview.ts" --outputDir="$ROOT_DIR/用户访谈" --format=md
  else
    echo "skip: tsx not found at $ROOT_DIR/node_modules/.bin/tsx"
  fi
fi

echo
echo "All checks finished."
