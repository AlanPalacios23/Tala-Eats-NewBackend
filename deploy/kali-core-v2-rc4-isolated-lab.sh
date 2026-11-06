#!/usr/bin/env bash
# Tala Eats Core v2 RC4: Kali isolated offline QA environment only.
# Never uses or modifies LIVE PostgreSQL, PM2, Redis, Nginx or tunnels.
set -Eeuo pipefail
umask 077

BRANCH="release/core-v2-rc4-kali-isolated-stage"
PG_CONTAINER="tala-corev2-rc4-pg16-lab"
PG_VOLUME="tala_corev2_rc4_pgdata_lab"
LABEL="com.talaeats.env=core-v2-rc4-lab"
APPROVAL="I_APPROVE_CORE_V2_RC4_ISOLATED_LAB_ONLY"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
EVIDENCE="${HOME}/tala-core-v2-rc4-evidence"
ACTION="${1:---plan}"
log(){ printf '%s\n' "$*"; }
die(){ printf 'RC4_BLOCKED: %s\n' "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "MISSING_TOOL_$1"; }
owned_container(){
  local value
  value="$(docker inspect -f '{{index .Config.Labels "com.talaeats.env"}}' "$PG_CONTAINER" 2>/dev/null || true)"
  [[ "$value" == "core-v2-rc4-lab" ]] || die "CONTAINER_NOT_OURS"
}
base_check(){
  need git; need docker; need openssl; need awk
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null || die "NO_GIT_TREE"
  local origin
  origin="$(git -C "$ROOT" remote get-url origin)"
  case "$origin" in
    "https://github.com/AlanPalacios23/Tala-Eats-NewBackend.git"|"https://github.com/AlanPalacios23/Tala-Eats-NewBackend"|"git@github.com:AlanPalacios23/Tala-Eats-NewBackend.git") ;;
    *) die "UNTRUSTED_REPOSITORY_ORIGIN" ;;
  esac
  [[ "$(git -C "$ROOT" branch --show-current)" == "$BRANCH" ]] || die "WRONG_BRANCH"
  docker info >/dev/null 2>&1 || die "DOCKER_ACCESS_REQUIRED"
}
plan(){
  log "RC4_STAGING_PLAN_ONLY=TRUE"
  log "REPOSITORY=$ROOT"
  log "SOURCE_BRANCH=$BRANCH"
  log "TARGET=ISOLATED_POSTGRES16_AND_NODE24_OFFLINE_TESTS"
  log "NETWORK=NONE_FOR_POSTGRES_AND_TESTS"
  log "PUBLIC_PORTS=0"
  log "PRODUCTION_MUTATIONS=0"
  log "STRIPE_LIVE=DISABLED"
  log "PAYMENTS_TEST_MODE=MOCKED_ONLY"
  log "COMMERCIAL_GATEWAY=NOT_ENABLED"
  log "STAGE_CONTAINER=$PG_CONTAINER"
  log "STAGE_VOLUME=$PG_VOLUME"
  log "EVIDENCE_DIR=$EVIDENCE"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker ps --filter "name=^/${PG_CONTAINER}$" --format 'EXISTING_STAGE_CONTAINER={{.Names}} STATUS={{.Status}}'
  else log "DOCKER_NOT_AVAILABLE_OR_NOT_AUTHORIZED"; fi
  if git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1; then
    log "CHECKOUT_SHA=$(git -C "$ROOT" rev-parse HEAD)"
  fi
  log "NEXT=REVIEW_PLAN_AND_RUN_WITH_EXACT_SHA"
}
cleanup(){
  [[ "${2:-}" == "$APPROVAL" ]] || die "EXPLICIT_LAB_APPROVAL_REQUIRED"
  base_check
  if docker container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    owned_container
    docker rm -f "$PG_CONTAINER" >/dev/null
  fi
  if docker volume inspect "$PG_VOLUME" >/dev/null 2>&1; then
    local label
    label="$(docker volume inspect -f '{{index .Labels "com.talaeats.env"}}' "$PG_VOLUME")"
    [[ "$label" == "core-v2-rc4-lab" ]] || die "VOLUME_NOT_OURS"
    docker volume rm "$PG_VOLUME" >/dev/null
  fi
  log "RC4_ONLY_LAB_CONTAINER_AND_VOLUME_REMOVED=TRUE"
}
apply(){
  [[ $# -eq 3 && "${3:-}" == "$APPROVAL" ]] || die "NEED_SHA_AND_LAB_APPROVAL"
  local expected="$2"
  [[ "$expected" =~ ^[0-9a-f]{40}$ ]] || die "INVALID_SHA"
  base_check
  [[ "$(git -C "$ROOT" rev-parse HEAD)" == "$expected" ]] || die "SHA_NOT_PINNED"
  [[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || die "DIRTY_TRACKED_TREE"
  [[ -z "${DATABASE_URL:-}" && -z "${STRIPE_SECRET_KEY:-}" && -z "${STRIPE_LIVE_SECRET_KEY:-}" ]] || die "LIVE_ENV_PRESENT"
  [[ ! -f "$ROOT/.env" ]] || die "ROOT_ENV_FILE_PRESENT"
  docker container inspect "$PG_CONTAINER" >/dev/null 2>&1 && die "LAB_CONTAINER_ALREADY_EXISTS"
  docker volume inspect "$PG_VOLUME" >/dev/null 2>&1 && die "LAB_VOLUME_ALREADY_EXISTS"
  local available
  available="$(df -Pk "$HOME" | awk 'END {print $4}')"
  [[ "$available" =~ ^[0-9]+$ && "$available" -ge 6291456 ]] || die "LESS_THAN_6_GIB_FREE"
  mkdir -p "$EVIDENCE"
  chmod 700 "$EVIDENCE"
  local report
  report="$(mktemp "$EVIDENCE/rc4-${expected:0:12}-XXXXXX.log")"
  exec > >(tee -a "$report") 2>&1
  log "RC4_LAB_AUDIT_START"
  log "COMMIT=$expected"
  log "LOG_FILE=$report"
  log "STAGING_NETWORK=NO_NETWORK_EGRESS_DURING_TEST"
  log "LIVE_SERVER_UNTOUCHED=TRUE"
  docker image inspect node:24-bookworm >/dev/null 2>&1 || docker pull node:24-bookworm
  docker image inspect postgres:16-alpine >/dev/null 2>&1 || docker pull postgres:16-alpine
  log "INSTALLING_SOURCE_DEPENDENCIES_IN_SEPARATE_BUILDER"
  docker run --rm --network bridge --cpus=2 --memory=4g \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
    -v "$ROOT:/workspace" -w /workspace node:24-bookworm \
    bash -euo pipefail -c '
      node modules/integration/scripts/verify-snapshots.mjs
      node --test tests/release-gates.test.mjs
      npm install --ignore-scripts --no-audit --no-fund
      for module in finance users notifications restaurants locations payments security analytics integration; do
        npm --prefix "modules/$module" install --ignore-scripts --no-audit --no-fund
      done
    '
  local password
  password="$(openssl rand -hex 24)"
  docker volume create --label "$LABEL" "$PG_VOLUME" >/dev/null
  docker run -d --name "$PG_CONTAINER" --label "$LABEL" \
    --network none --cpus=1 --memory=1024m \
    --mount "type=volume,src=$PG_VOLUME,dst=/var/lib/postgresql/data" \
    -e POSTGRES_USER=integration_ci -e POSTGRES_DB=tala_core_v2_test \
    -e "POSTGRES_PASSWORD=$password" postgres:16-alpine >/dev/null
  local ready=0
  for _ in $(seq 1 45); do
    if docker exec "$PG_CONTAINER" pg_isready -q -U integration_ci -d tala_core_v2_test; then ready=1; break; fi
    sleep 2
  done
  [[ "$ready" -eq 1 ]] || die "STAGING_POSTGRES_NOT_READY"
  log "POSTGRES_ISOLATED_READY=TRUE"
  declare -A dbs=(
    [finance]=tala_finance_v2_test
    [users]=tala_users_v2_test
    [notifications]=tala_notifications_v2_test
    [restaurants]=tala_restaurants_v2_test
    [locations]=tala_locations_v2_test
    [payments]=tala_payments_v2_test
    [security]=tala_security_v2_test
    [analytics]=tala_analytics_v2_test
    [integration]=tala_integration_v2_test
  )
  for module in finance users notifications restaurants locations payments security analytics integration; do
    local db="${dbs[$module]}"
    docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U integration_ci \
      -d tala_core_v2_test -c "CREATE DATABASE $db"
    for sql in "$ROOT/modules/$module/migrations/"*.sql; do
      log "MIGRATION_LAB_ONLY=$module/$(basename "$sql")"
      docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 \
        -U integration_ci -d "$db" < "$sql"
    done
  done
  log "MIGRATION_LAB_ONLY=M6_STOCK_HOLD_EXTENSION"
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U integration_ci \
    -d tala_restaurants_v2_test < "$ROOT/modules/integration/m6-extension/008_order_stock_holds.sql"
  for sql in "$ROOT/migrations/"*.sql; do
    log "MIGRATION_LAB_ONLY=CORE/$(basename "$sql")"
    docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 \
      -U integration_ci -d tala_core_v2_test < "$sql"
  done
  log "RUNNING_TEN_DOMAIN_QA_WITH_NO_EXTERNAL_NETWORK"
  local baseurl="postgresql://integration_ci:$password@127.0.0.1:5432"
  docker run --rm --network "container:$PG_CONTAINER" \
    --cpus=2 --memory=4g --user "$(id -u):$(id -g)" \
    --env NODE_ENV=test --env CI=true \
    --env CORE_V2_INTEGRATION_RUNTIME=isolated-lab \
    --env CORE_V2_WRITES_ENABLED=false \
    --env CORE_V2_INTEGRATION_WRITES_ENABLED=false \
    --env CORE_V2_INTEGRATION_LIVE_PAYMENTS_ENABLED=false \
    --env CORE_V2_INTEGRATION_PAYOUTS_ENABLED=false \
    --env CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED=false \
    --env "PG_CI_URL=$baseurl/tala_core_v2_test" \
    --env "CORE_CI_URL=$baseurl/tala_core_v2_test" \
    --env "FINANCE_CI_URL=$baseurl/tala_finance_v2_test" \
    --env "USERS_CI_URL=$baseurl/tala_users_v2_test" \
    --env "NOTIFICATIONS_CI_URL=$baseurl/tala_notifications_v2_test" \
    --env "RESTAURANTS_CI_URL=$baseurl/tala_restaurants_v2_test" \
    --env "LOCATIONS_CI_URL=$baseurl/tala_locations_v2_test" \
    --env "PAYMENTS_CI_URL=$baseurl/tala_payments_v2_test" \
    --env "SECURITY_CI_URL=$baseurl/tala_security_v2_test" \
    --env "ANALYTICS_CI_URL=$baseurl/tala_analytics_v2_test" \
    --env "INTEGRATION_CI_URL=$baseurl/tala_integration_v2_test" \
    -e HOME=/tmp -v "$ROOT:/workspace" -w /workspace node:24-bookworm \
    bash -euo pipefail -c '
      npm --prefix modules/integration run probe:imports
      npm run check
      for module in finance users notifications restaurants locations payments security analytics; do
        npm --prefix "modules/$module" run check
      done
      (cd modules/finance && node --test tests/*.test.mjs)
      npm --prefix modules/integration run check
      node scripts/verify-core-v2-preprod.mjs
    '
  log "RC4_TEN_MODULE_LAB_TESTS=PASS"
  log "STRIPE_TEST_REMOTE=NOT_PERFORMED"
  log "LIVE_RELEASE=NO_GO"
  log "STAGE_DB_REMAINS_PRIVATE_AND_UNEXPOSED=TRUE"
}
case "$ACTION" in
  --plan) [[ $# -eq 1 ]] || die "PLAN_TAKES_NO_ARGUMENTS"; plan ;;
  --apply) apply "$@" ;;
  --status)
    base_check
    owned_container
    docker ps --filter "name=^/${PG_CONTAINER}$" --format 'LAB_CONTAINER={{.Names}} STATUS={{.Status}}'
    docker exec "$PG_CONTAINER" pg_isready -U integration_ci -d tala_core_v2_test || true
    ;;
  --stop)
    [[ "${2:-}" == "$APPROVAL" ]] || die "EXPLICIT_LAB_APPROVAL_REQUIRED"
    base_check; owned_container; docker stop "$PG_CONTAINER" >/dev/null
    log "RC4_ONLY_LAB_CONTAINER_STOPPED=TRUE"
    ;;
  --cleanup) cleanup "$@" ;;
  *) die "USAGE: --plan | --apply SHA I_APPROVE_CORE_V2_RC4_ISOLATED_LAB_ONLY | --status | --stop TOKEN | --cleanup TOKEN" ;;
esac
