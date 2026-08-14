#!/usr/bin/env bash
# Anthropic Admin API — Messages Usage Report (지난 7일, 1일 단위)
#
#   GET https://api.anthropic.com/v1/organizations/usage_report/messages
#   헤더: x-api-key, anthropic-version
#   페이지네이션: has_more=true 이면 next_page 를 page 파라미터로 재요청
#
# 출력: responses/anthropic_usage.json
#   페이지가 여러 개면 각 페이지 data 배열을 이어붙여 하나의 객체로 저장한다.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
require_vars ANTHROPIC_ADMIN_KEY ANTHROPIC_API_VERSION
API_BASE="${ANTHROPIC_API_BASE:-https://api.anthropic.com}"

mkdir -p "$RESPONSE_DIR"
OUT="$RESPONSE_DIR/anthropic_usage.json"

STARTING_AT="$(iso_days_ago 7)"
ENDING_AT="$(iso_today)"

CURL_CFG="$(make_curl_config \
  "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  "anthropic-version: $ANTHROPIC_API_VERSION" \
  "accept: application/json")"
trap 'rm -f "$CURL_CFG"' EXIT

log "Anthropic Usage Report"
log "  기간: $STARTING_AT ~ $ENDING_AT (bucket_width=1d)"
log "  키:   ANTHROPIC_ADMIN_KEY=$(masked ANTHROPIC_ADMIN_KEY)"

TMP_PAGES="$(mktemp -d)"
trap 'rm -f "$CURL_CFG"; rm -rf "$TMP_PAGES"' EXIT

page_token=""
page_num=0

while :; do
  page_num=$((page_num + 1))
  body="$TMP_PAGES/page_$page_num.json"

  # limit: bucket_width=1d 는 기본 7 / 최대 31.
  args=(
    --data-urlencode "starting_at=$STARTING_AT"
    --data-urlencode "ending_at=$ENDING_AT"
    --data-urlencode "bucket_width=1d"
    --data-urlencode "limit=31"
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
meta="$(printf '{"starting_at":"%s","ending_at":"%s","bucket_width":"1d","endpoint":"/v1/organizations/usage_report/messages"}' \
        "$STARTING_AT" "$ENDING_AT")"
buckets="$(python3 "$JSON_PY" merge-pages "$OUT" "$meta" "$TMP_PAGES"/page_*.json)"

log "  저장: responses/anthropic_usage.json ($buckets buckets, $page_num page)"
