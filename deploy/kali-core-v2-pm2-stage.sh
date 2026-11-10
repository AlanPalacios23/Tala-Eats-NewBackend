#!/usr/bin/env bash
# RC5: ONE reusable checkout, PM2-only staging; disposable PostgreSQL 18 QA.
# NEVER touches original PM2_HOME, PostgreSQL 18 LIVE or Cloudflare/Nginx.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RELEASE_BRANCH="release/core-v2-rc5-pm2-single-stage"
CRECE_BRANCH="feat/core-v2-crece-fundadores-lab-20261108"
APP="tala-core-v2-stage"
STAGE_PORT=18286
STAGE_PM2_HOME="$HOME/.pm2-tala-core-v2-stage"
EVIDENCE_DIR="$HOME/tala-core-v2-evidence"
LAB_TOKEN="I_APPROVE_CORE_V2_PM2_ISOLATED_STAGE_ONLY"
LAB_DIR=""
LAB_RUNNING=0
PG_BIN="/usr/lib/postgresql/18/bin"
PG_PORT=18432

fail(){ printf 'RC5_DENIED=%s\n' "$*" >&2; exit 1; }
require(){ command -v "$1" >/dev/null || fail "MISSING_$1"; }
assert_source(){
  require git; require node
  [[ "$(node -p 'process.versions.node.split(".")[0]')" == "24" ]] ||
    fail "NODE_24_REQUIRED"
  local active_branch
  active_branch="$(git -C "$ROOT" branch --show-current)"
  case "$active_branch" in
    "$RELEASE_BRANCH"|"$CRECE_BRANCH") ;;
    *) fail "WRONG_BRANCH" ;;
  esac
  local origin
  origin="$(git -C "$ROOT" remote get-url origin)"
  case "$origin" in
    "https://github.com/AlanPalacios23/Tala-Eats-NewBackend.git"|"https://github.com/AlanPalacios23/Tala-Eats-NewBackend"|"git@github.com:AlanPalacios23/Tala-Eats-NewBackend.git") ;;
    *) fail "WRONG_REPOSITORY" ;;
  esac
  [[ ! -f "$ROOT/.env" ]] || fail "ROOT_ENV_PRESENT"
  [[ -z "${DATABASE_URL:-}" && -z "${STRIPE_SECRET_KEY:-}" &&
     -z "${STRIPE_WEBHOOK_SECRET:-}" && -z "${STRIPE_LIVE_SECRET_KEY:-}" ]] ||
     fail "NO_LIVE_CREDENTIALS_IN_STAGE"
}
assert_sha(){
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || fail "SHA_REQUIRED"
  [[ "$(git -C "$ROOT" rev-parse HEAD)" == "$1" ]] || fail "SHA_NOT_PINNED"
  [[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] ||
    fail "TRACKED_TREE_DIRTY"
}
approve(){
  [[ "${1:-}" == "$LAB_TOKEN" ]] || fail "EXPLICIT_APPROVAL_REQUIRED"
}
plan(){
  echo "RC5_SINGLE_CHECKOUT=$ROOT"
  echo "REPOSITORY_BRANCH=$(git -C "$ROOT" branch --show-current 2>/dev/null || echo UNKNOWN)"
  echo "AUTHORIZED_BRANCHES=$RELEASE_BRANCH OR $CRECE_BRANCH"
  echo "PROCESS_MANAGER=PM2"
  echo "PM2_NAMESPACE=$STAGE_PM2_HOME"
  echo "STAGE_PROCESS=$APP"
  echo "STAGE_HTTP=127.0.0.1:$STAGE_PORT"
  echo "STAGE_COMMERCIAL_ENDPOINTS=DISABLED"
  echo "POSTGRES_TESTS=EPHEMERAL_LOCAL_PG18_NO_LIVE_DB"
  echo "POSTGRES_TEST_PORT=127.0.0.1:$PG_PORT"
  echo "TEST_DB_LIFETIME=ONLY_DURING_TEST"
  echo "CONTAINERS=NONE"
  echo "NEW_BACKEND_COPIES=NONE"
  echo "LIVE_PM2_CHANGES=NONE"
  echo "EVIDENCE=$EVIDENCE_DIR"
  echo "SHA=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo UNKNOWN)"
}
install_dependencies(){
  require npm
  (cd "$ROOT" && npm install --ignore-scripts --no-audit --no-fund)
  for module in finance users notifications restaurants locations payments security analytics integration; do
    npm --prefix "$ROOT/modules/$module" install --ignore-scripts --no-audit --no-fund
  done
}
cleanup_lab(){
  local status=$?
  trap - EXIT
  if [[ "$LAB_RUNNING" == 1 && -n "$LAB_DIR" ]]; then
    if "$PG_BIN/pg_ctl" -D "$LAB_DIR/data" -m fast -w stop >/dev/null 2>&1; then
      LAB_RUNNING=0
    else
      echo 'RC5_WARNING=TEMP_POSTGRES_STOP_FAILED_CLUSTER_PRESERVED' >&2
      LAB_DIR=""
    fi
  fi
  if [[ -n "$LAB_DIR" && -f "$LAB_DIR/RC5_TEMP_CLUSTER_ONLY" &&
        "$LAB_DIR" == "$HOME/.cache/tala-corev2-pg18."* &&
        ! -L "$LAB_DIR" ]]; then
    rm -rf -- "$LAB_DIR"
    echo 'RC5_TEMP_POSTGRES_CLUSTER_CLEANED=TRUE'
  elif [[ -n "$LAB_DIR" ]]; then
    echo 'RC5_WARNING=UNRECOGNIZED_TEMP_DIR_NOT_DELETED' >&2
  fi
  exit "$status"
}
test_modules(){
  assert_source
  assert_sha "$1"
  approve "$2"
  for bin in initdb pg_ctl psql pg_isready; do
    [[ -x "$PG_BIN/$bin" ]] || fail "POSTGRES18_BIN_MISSING_$bin"
  done
  require openssl; require curl; require npm
  [[ "$("$PG_BIN/postgres" --version)" == *"PostgreSQL) 18."* ]] ||
    fail "POSTGRES18_REQUIRED"
  [[ "$("$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" 2>&1 || true)" != *"accepting connections"* ]] ||
    fail "TEMP_POSTGRES_PORT_IN_USE"
  mkdir -p "$HOME/.cache" "$EVIDENCE_DIR"
  chmod 700 "$EVIDENCE_DIR"
  LAB_DIR="$(mktemp -d "$HOME/.cache/tala-corev2-pg18.XXXXXXXX")"
  touch "$LAB_DIR/RC5_TEMP_CLUSTER_ONLY"
  mkdir -m 700 "$LAB_DIR/run"
  trap cleanup_lab EXIT
  local logfile
  logfile="$(mktemp "$EVIDENCE_DIR/rc5-qa-${1:0:12}-XXXXXXXX.log")"
  exec > >(tee -a "$logfile") 2>&1
  echo "RC5_QA_GIT_SHA=$1"
  echo "RC5_LOGFILE=$logfile"
  echo "RC5_LIVE_POSTGRES_UNTOUCHED=TRUE"
  node "$ROOT/modules/integration/scripts/verify-snapshots.mjs"
  node --test "$ROOT/tests/release-gates.test.mjs"
  install_dependencies
  local pgpass
  pgpass="$(openssl rand -hex 24)"
  printf '%s\n' "$pgpass" > "$LAB_DIR/password"
  "$PG_BIN/initdb" -D "$LAB_DIR/data" --username=integration_ci \
    --pwfile="$LAB_DIR/password" --auth-host=scram-sha-256 \
    --auth-local=scram-sha-256 --no-instructions >/dev/null
  "$PG_BIN/pg_ctl" -D "$LAB_DIR/data" -l "$LAB_DIR/server.log" \
    -o "-c listen_addresses=127.0.0.1 -p $PG_PORT -c unix_socket_directories=$LAB_DIR/run -c max_connections=150" \
    -w start >/dev/null
  LAB_RUNNING=1
  export PGHOST=127.0.0.1 PGPORT="$PG_PORT" PGUSER=integration_ci PGPASSWORD="$pgpass"
  local rooturl="postgresql://integration_ci:$pgpass@127.0.0.1:$PG_PORT"
  local database module sql
  declare -A DB=(
    [finance]=tala_finance_v2_test [users]=tala_users_v2_test
    [notifications]=tala_notifications_v2_test
    [restaurants]=tala_restaurants_v2_test
    [locations]=tala_locations_v2_test
    [payments]=tala_payments_v2_test
    [security]=tala_security_v2_test
    [analytics]=tala_analytics_v2_test
    [integration]=tala_integration_v2_test
  )
  for module in finance users notifications restaurants locations payments security analytics integration; do
    database="${DB[$module]}"
    "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $database"
    for sql in "$ROOT/modules/$module/migrations/"*.sql; do
      echo "RC5_TEMP_MIGRATION=$module/$(basename "$sql")"
      "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d "$database" -f "$sql"
    done
  done
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d tala_restaurants_v2_test \
    -f "$ROOT/modules/integration/m6-extension/008_order_stock_holds.sql"
  # The root M1 database MUST exist before root migrations are applied.
  # All DBs belong to the fresh PostgreSQL 18 instance on loopback :18432.
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d postgres \
    -c "CREATE DATABASE tala_core_v2_test"
  for sql in "$ROOT/migrations/"*.sql; do
    echo "RC5_TEMP_MIGRATION=core/$(basename "$sql")"
    "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d tala_core_v2_test -f "$sql"
  done
  export NODE_ENV=test CORE_V2_INTEGRATION_RUNTIME=isolated-lab
  export CORE_V2_WRITES_ENABLED=false CORE_V2_INTEGRATION_WRITES_ENABLED=false
  export CORE_V2_INTEGRATION_LIVE_PAYMENTS_ENABLED=false
  export CORE_V2_INTEGRATION_PAYOUTS_ENABLED=false
  export CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED=false
  export PG_CI_URL="$rooturl/tala_core_v2_test"
  export CORE_CI_URL="$rooturl/tala_core_v2_test"
  export FINANCE_CI_URL="$rooturl/tala_finance_v2_test"
  export USERS_CI_URL="$rooturl/tala_users_v2_test"
  export NOTIFICATIONS_CI_URL="$rooturl/tala_notifications_v2_test"
  export RESTAURANTS_CI_URL="$rooturl/tala_restaurants_v2_test"
  export LOCATIONS_CI_URL="$rooturl/tala_locations_v2_test"
  export PAYMENTS_CI_URL="$rooturl/tala_payments_v2_test"
  export SECURITY_CI_URL="$rooturl/tala_security_v2_test"
  export ANALYTICS_CI_URL="$rooturl/tala_analytics_v2_test"
  export INTEGRATION_CI_URL="$rooturl/tala_integration_v2_test"
  (cd "$ROOT" &&
    npm --prefix modules/integration run probe:imports &&
    npm run check &&
    for module in finance users notifications restaurants locations payments security analytics; do
      echo "RC5_MODULE_TEST=$module"
      npm --prefix "modules/$module" run check
    done &&
    (cd modules/finance && node --test tests/*.test.mjs) &&
    npm --prefix modules/integration run check &&
    node scripts/verify-core-v2-preprod.mjs)
  echo "RC5_ALL_10_MODULE_LAB_SUITES=PASS"
  echo "RC5_STRIPE_TEST_REMOTE=NOT_TESTED"
  echo "RC5_LIVE_RELEASE=NO_GO"
}
pm2_env(){
  export PM2_HOME="$STAGE_PM2_HOME"
  mkdir -p "$PM2_HOME"
  chmod 700 "$PM2_HOME"
}
start_stage(){
  assert_source; assert_sha "$1"; approve "$2"
  require pm2; require curl; require npm
  [[ -f "$ROOT/modules/integration/node_modules/tsx/dist/cli.mjs" ]] ||
    fail "RUN_TEST_TO_INSTALL_DEPENDENCIES_FIRST"
  if curl --noproxy '*' -fsS --connect-timeout 1 \
      "http://127.0.0.1:$STAGE_PORT/v2/health" >/dev/null 2>&1; then
    fail "HTTP_PORT_ALREADY_SERVING"
  fi
  pm2_env
  if pm2 describe "$APP" >/dev/null 2>&1; then fail "STAGE_ALREADY_RUNNING"; fi
  export NODE_ENV=test CORE_V2_INTEGRATION_RUNTIME=isolated-lab
  export CORE_V2_WRITES_ENABLED=false CORE_V2_INTEGRATION_WRITES_ENABLED=false
  export CORE_V2_INTEGRATION_LIVE_PAYMENTS_ENABLED=false
  export CORE_V2_INTEGRATION_PAYOUTS_ENABLED=false
  export CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED=false
  pm2 start "$ROOT/modules/integration/node_modules/tsx/dist/cli.mjs" \
    --name "$APP" --cwd "$ROOT" --interpreter "$(command -v node)" \
    -- scripts/pm2-core-v2-stage.ts
  local ok=0
  for _ in $(seq 1 20); do
    if curl --noproxy '*' -sf --connect-timeout 1 \
      "http://127.0.0.1:$STAGE_PORT/v2/health" | grep -q '"domainsLoaded":10'; then
      ok=1;break
    fi
    sleep 1
  done
  if [[ "$ok" != 1 ]]; then
    pm2 delete "$APP" >/dev/null 2>&1 || true
    fail "STAGE_GATEWAY_HEALTH_FAILED"
  fi
  local http
  http="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$STAGE_PORT/v2/ready")"
  [[ "$http" == 503 ]] || fail "STAGE_WRONGLY_ASSERTS_READY"
  http="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$STAGE_PORT/api/v2/orders")"
  [[ "$http" == 503 ]] || fail "STAGE_WRONGLY_EXPOSES_BUSINESS"
  echo "RC5_PM2_LOOPBACK_STAGE=PASS"
  echo "RC5_LIVE_RELEASE=NO_GO"
}
status_stage(){
  require pm2
  export PM2_HOME="$STAGE_PM2_HOME"
  if [[ -d "$STAGE_PM2_HOME" ]]; then pm2 describe "$APP" || true
  else echo "RC5_STAGE_PM2=NOT_STARTED"; fi
  if command -v curl >/dev/null; then
    curl --noproxy '*' --silent --max-time 2 \
      "http://127.0.0.1:$STAGE_PORT/v2/health" || true
    echo
  fi
}
stop_stage(){
  approve "$1";require pm2
  export PM2_HOME="$STAGE_PM2_HOME"
  [[ -d "$STAGE_PM2_HOME" ]] || fail "STAGE_PM2_NOT_FOUND"
  pm2 delete "$APP" || fail "NO_STAGE_TO_DELETE"
  echo "RC5_ONLY_NAMED_STAGE_PROCESS_STOPPED=TRUE"
}
case "${1:---plan}" in
  --plan) plan ;;
  --test) [[ $# -eq 3 ]] || fail "USAGE_TEST_SHA_APPROVAL";test_modules "$2" "$3" ;;
  --start) [[ $# -eq 3 ]] || fail "USAGE_START_SHA_APPROVAL";start_stage "$2" "$3" ;;
  --status) status_stage ;;
  --stop) [[ $# -eq 2 ]] || fail "USAGE_STOP_APPROVAL";stop_stage "$2" ;;
  *) fail "USAGE=--plan|--test SHA TOKEN|--start SHA TOKEN|--status|--stop TOKEN" ;;
esac
