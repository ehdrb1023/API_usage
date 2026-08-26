#!/usr/bin/env bash
# Anthropic Admin API — Messages Usage Report
#
#   GET https://api.anthropic.com/v1/organizations/usage_report/messages
#   헤더: x-api-key, anthropic-version
#   페이지네이션: has_more=true 이면 next_page 를 page 파라미터로 재요청
#
# 출력: responses/anthropic_usage.json
#   페이지가 여러 개면 각 페이지 data 배열을 이어붙여 하나의 객체로 저장한다.
#
# ⚠️ **이 덤프는 앱이 실제로 받는 응답이 아니다.**
#    기본값은 "지난 7일 / 1일 버킷" 이라 원문을 눈으로 보기 좋은 형태다.
#    앱(lib/services.ts)은 KST 하루를 맞추려고 "전월 1일~지금 / 1시간 버킷" 을 받는다.
#    앱과 같은 조건을 재현하려면:  BUCKET_WIDTH=1h DAYS=60 bash scripts/fetch_anthropic_usage.sh
#    (1h 는 페이지가 8개쯤 되어 쿼터를 그만큼 더 먹는다 — 아래 경고 참고)
#
# ⚠️ 이 엔드포인트는 **시간당 90회** 다. `next dev` 를 켜 둔 채로 돌리면
#    미니 위젯 폴링(기본 60회/시간)과 합쳐져 429 가 난다. 개발 서버를 끄고 돌릴 것.
#
# 환경변수:
#   DAYS          조회 일수 (기본 7)
#   BUCKET_WIDTH  1d | 1h | 1m (기본 1d)

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
require_vars ANTHROPIC_ADMIN_KEY ANTHROPIC_API_VERSION
API_BASE="${ANTHROPIC_API_BASE:-https://api.anthropic.com}"

mkdir -p "$RESPONSE_DIR"
OUT="$RESPONSE_DIR/anthropic_usage.json"

DAYS="${DAYS:-7}"
BUCKET_WIDTH="${BUCKET_WIDTH:-1d}"
# 1h 는 페이지당 최대 168버킷(=7일), 1d 는 31버킷.
case "$BUCKET_WIDTH" in
  1h) PAGE_LIMIT=168 ;;
  1m) PAGE_LIMIT=1440 ;;
  *)  PAGE_LIMIT=31 ;;
esac

STARTING_AT="$(iso_days_ago "$DAYS")"
ENDING_AT="$(iso_today)"

CURL_CFG="$(make_curl_config \
  "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  "anthropic-version: $ANTHROPIC_API_VERSION" \
  "accept: application/json")"
trap 'rm -f "$CURL_CFG"' EXIT

log "Anthropic Usage Report"
log "  기간: $STARTING_AT ~ $ENDING_AT (bucket_width=$BUCKET_WIDTH, ${DAYS}일)"
log "  키:   ANTHROPIC_ADMIN_KEY=$(masked ANTHROPIC_ADMIN_KEY)"

TMP_PAGES="$(mktemp -d)"
trap 'rm -f "$CURL_CFG"; rm -rf "$TMP_PAGES"' EXIT

page_token=""
page_num=0

while :; do
  page_num=$((page_num + 1))
  body="$TMP_PAGES/page_$page_num.json"

  # limit: 기본값(7)이면 8번째 버킷부터 조용히 잘린다. 해상도별 최대치를 쓴다.
  args=(
    --data-urlencode "starting_at=$STARTING_AT"
    --data-urlencode "ending_at=$ENDING_AT"
    --data-urlencode "bucket_width=$BUCKET_WIDTH"
    --data-urlencode "limit=$PAGE_LIMIT"
    --data-urlencode "group_by[]=model"
    --data-urlencode "group_by[]=api_key_id"
    --data-urlencode "group_by[]=workspace_id"
  )
  [ -n "$page_token" ] && args+=(--data-urlencode "page=$page_token")

  code="$(curl --config "$CURL_CFG" --get --max-time 60 \
          "${args[@]}" \
          --write-out '%{http_code}' --output "$body" \
          "$API_BASE/v1/organizations/usage_report/messages")"

  if [ "$code" != "200" ]; then
    report_http_error "$code" "$body" \
      "ANTHROPIC_ADMIN_KEY (.env)" \
      "이 엔드포인트는 조직 Admin 키(sk-ant-admin...)가 필요합니다. 일반 API 키(sk-ant-api...)로는 401/403이 납니다. Console → Settings → Admin keys 에서 조직 Owner 권한으로 발급하세요."
    exit 1
  fi

  log "  page $page_num 수신 OK"

  IFS=$'\t' read -r has_more page_token < <(python3 "$JSON_PY" page-info "$body")
  [ "$has_more" = "true" ] && [ -n "$page_token" ] || break
done

# 모든 페이지의 data 를 이어붙인다.
meta="$(printf '{"starting_at":"%s","ending_at":"%s","bucket_width":"%s","endpoint":"/v1/organizations/usage_report/messages"}' \
        "$STARTING_AT" "$ENDING_AT" "$BUCKET_WIDTH")"
buckets="$(python3 "$JSON_PY" merge-pages "$OUT" "$meta" "$TMP_PAGES"/page_*.json)"

log "  저장: responses/anthropic_usage.json ($buckets buckets, $page_num page)"
