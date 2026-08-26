#!/usr/bin/env bash
# OpenAI Admin API — 사용량 / 비용 / 프로젝트 원문 덤프
#
# ⚠️⚠️ **이 스크립트의 목적은 원문을 눈으로 보는 것이다.** 지금 lib/clients/openai.ts
#      전체가 공개 문서 기준이고 실응답으로 검증되지 않았다. 실 Admin 키가 생기면
#      **가장 먼저** 이걸 돌려 responses/ 에 원문을 떨구고,
#      docs/openai-integration.md 체크리스트를 위에서부터 지워 나갈 것.
#
#   GET /v1/organization/usage/completions   (bucket_width=1d, 페이지 커서 page/next_page)
#   GET /v1/organization/costs               (bucket_width=1d, 같은 커서)
#   GET /v1/organization/projects            (after/last_id 방식 — 위 둘과 다름)
#
# ⚠️ 경로가 **단수** organization 이다. Anthropic 은 organizations (복수).
#    404 가 나면 여기부터 의심할 것.
# ⚠️ 시각이 **unix 초 정수**다. ISO 문자열을 넣으면 400 이 난다.
#
# 출력:
#   responses/openai_usage.json
#   responses/openai_costs.json
#   responses/openai_projects.json
#
# 환경변수:
#   DAYS  조회 일수 (기본 7)

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
require_vars OPENAI_ADMIN_KEY
API_BASE="${OPENAI_API_BASE:-https://api.openai.com}"

mkdir -p "$RESPONSE_DIR"

DAYS="${DAYS:-7}"
# GNU date 우선, 실패 시 BSD date. unix 초로 받는다.
START_TIME="$(date -u -d "${DAYS} days ago 00:00" +%s 2>/dev/null \
  || date -u -v-"${DAYS}"d -v0H -v0M -v0S +%s)"
END_TIME="$(date -u +%s)"

HEADERS=("Authorization: Bearer $OPENAI_ADMIN_KEY" "accept: application/json")
# 조직이 여럿인 계정에서 이걸 빼면 엉뚱한 조직이 잡힌다.
[ -n "${OPENAI_ORG_ID:-}" ] && HEADERS+=("OpenAI-Organization: $OPENAI_ORG_ID")

CURL_CFG="$(make_curl_config "${HEADERS[@]}")"
TMP_PAGES="$(mktemp -d)"
trap 'rm -f "$CURL_CFG"; rm -rf "$TMP_PAGES"' EXIT

log "OpenAI Admin API"
log "  기간: $START_TIME ~ $END_TIME (unix 초, ${DAYS}일)"
log "  키:   OPENAI_ADMIN_KEY=$(masked OPENAI_ADMIN_KEY)"

HINT="이 엔드포인트는 조직 Admin 키(sk-admin-...)가 필요합니다. 프로젝트 키(sk-proj-...)로는 401/403 이 납니다. 404 면 경로를 확인하세요 — OpenAI 는 /v1/organization (단수) 입니다."

# ---------------------------------------------------------------- 커서 페이지

# $1 이름, $2 경로, $3 출력파일, 나머지: 추가 쿼리 인자
fetch_cursor() {
  local name="$1" path="$2" out="$3"; shift 3
  local extra=("$@")
  local dir="$TMP_PAGES/$name"
  mkdir -p "$dir"

  local page_token="" page_num=0 body code has_more

  while :; do
    page_num=$((page_num + 1))
    body="$dir/page_$page_num.json"

    local args=(
      --data-urlencode "start_time=$START_TIME"
      --data-urlencode "end_time=$END_TIME"
      --data-urlencode "bucket_width=1d"
    )
    args+=("${extra[@]}")
    [ -n "$page_token" ] && args+=(--data-urlencode "page=$page_token")

    code="$(curl --config "$CURL_CFG" --get --max-time 60 \
            "${args[@]}" \
            --write-out '%{http_code}' --output "$body" \
            "$API_BASE$path")"

    if [ "$code" != "200" ]; then
      report_http_error "$code" "$body" "OPENAI_ADMIN_KEY (.env)" "$HINT"
      return 1
    fi

    log "  $name page $page_num 수신 OK"
    IFS=$'\t' read -r has_more page_token < <(python3 "$JSON_PY" page-info "$body")
    [ "$has_more" = "true" ] && [ -n "$page_token" ] || break
  done

  local meta
  meta="$(printf '{"start_time":%s,"end_time":%s,"bucket_width":"1d","endpoint":"%s","note":"unverified - see docs/openai-integration.md"}' \
          "$START_TIME" "$END_TIME" "$path")"
  local n
  n="$(python3 "$JSON_PY" merge-pages "$out" "$meta" "$dir"/page_*.json)"
  log "  저장: $(basename "$out") ($n buckets, $page_num page)"
}

# ⚠️ 배열 파라미터 표기가 Anthropic 과 다를 수 있다. 여기서는 반복 형태를 쓴다
#    (group_by=model&group_by=project_id). 400 이 나면 group_by[] 로 바꿔 볼 것.
#    lib/clients/openai.ts 의 buildQuery 와 같은 선택이어야 한다.
fetch_cursor usage /v1/organization/usage/completions \
  "$RESPONSE_DIR/openai_usage.json" \
  --data-urlencode "limit=31" \
  --data-urlencode "group_by=model" \
  --data-urlencode "group_by=project_id" \
  || exit 1

# ⚠️ costs 의 limit 기본값은 7 이다. 그대로 두면 8일째부터 조용히 잘린다.
fetch_cursor costs /v1/organization/costs \
  "$RESPONSE_DIR/openai_costs.json" \
  --data-urlencode "limit=180" \
  --data-urlencode "group_by=line_item" \
  --data-urlencode "group_by=project_id" \
  || exit 1

# ---------------------------------------------------------------- 프로젝트 목록

# ⚠️ 리포트 둘과 페이지네이션 방식이 다르다 — page/next_page 가 아니라 after/last_id.
PROJ_DIR="$TMP_PAGES/projects"
mkdir -p "$PROJ_DIR"
after=""
page_num=0

while :; do
  page_num=$((page_num + 1))
  body="$PROJ_DIR/page_$page_num.json"

  args=(--data-urlencode "limit=100" --data-urlencode "include_archived=true")
  [ -n "$after" ] && args+=(--data-urlencode "after=$after")

  code="$(curl --config "$CURL_CFG" --get --max-time 60 \
          "${args[@]}" \
          --write-out '%{http_code}' --output "$body" \
          "$API_BASE/v1/organization/projects")"

  if [ "$code" != "200" ]; then
    report_http_error "$code" "$body" "OPENAI_ADMIN_KEY (.env)" "$HINT"
    exit 1
  fi

  log "  projects page $page_num 수신 OK"
  IFS=$'\t' read -r has_more after < <(python3 "$JSON_PY" keys-page-info "$body")
  [ "$has_more" = "true" ] && [ -n "$after" ] || break
done

meta='{"endpoint":"/v1/organization/projects","include_archived":true,"limit":100}'
count="$(python3 "$JSON_PY" merge-key-pages "$RESPONSE_DIR/openai_projects.json" "$meta" "$PROJ_DIR"/page_*.json)"
log "  저장: openai_projects.json ($count projects, $page_num page)"
