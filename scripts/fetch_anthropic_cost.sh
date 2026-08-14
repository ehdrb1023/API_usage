#!/usr/bin/env bash
# Anthropic Admin API — Cost Report (지난 7일, 1일 단위)
#
#   GET https://api.anthropic.com/v1/organizations/cost_report
#   헤더: x-api-key, anthropic-version
#   bucket_width 는 "1d" 만 지원.
#   group_by 는 description / workspace_id 만 지원 (usage_report 와 다름).
#
# ⚠️ amount 필드는 "최소 통화 단위(센트)"의 decimal 문자열이다.
#    "123.45" USD == $1.2345. 대시보드에서 반드시 100 으로 나눌 것.
#
# 출력: responses/anthropic_cost.json

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
require_vars ANTHROPIC_ADMIN_KEY ANTHROPIC_API_VERSION
API_BASE="${ANTHROPIC_API_BASE:-https://api.anthropic.com}"

mkdir -p "$RESPONSE_DIR"
OUT="$RESPONSE_DIR/anthropic_cost.json"

STARTING_AT="$(iso_days_ago 7)"
ENDING_AT="$(iso_today)"

CURL_CFG="$(make_curl_config \
  "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  "anthropic-version: $ANTHROPIC_API_VERSION" \
  "accept: application/json")"
TMP_PAGES="$(mktemp -d)"
trap 'rm -f "$CURL_CFG"; rm -rf "$TMP_PAGES"' EXIT

log "Anthropic Cost Report"
log "  기간: $STARTING_AT ~ $ENDING_AT (bucket_width=1d)"
log "  키:   ANTHROPIC_ADMIN_KEY=$(masked ANTHROPIC_ADMIN_KEY)"

page_token=""
page_num=0

while :; do
  page_num=$((page_num + 1))
  body="$TMP_PAGES/page_$page_num.json"

  args=(
    --data-urlencode "starting_at=$STARTING_AT"
    --data-urlencode "ending_at=$ENDING_AT"
    --data-urlencode "bucket_width=1d"
    --data-urlencode "limit=31"
    --data-urlencode "group_by[]=description"
    --data-urlencode "group_by[]=workspace_id"
  )
  [ -n "$page_token" ] && args+=(--data-urlencode "page=$page_token")

  code="$(curl --config "$CURL_CFG" --get --max-time 60 \
          "${args[@]}" \
          --write-out '%{http_code}' --output "$body" \
          "$API_BASE/v1/organizations/cost_report")"

  if [ "$code" != "200" ]; then
    report_http_error "$code" "$body" \
      "ANTHROPIC_ADMIN_KEY (.env)" \
      "cost_report 는 usage_report 와 동일하게 조직 Admin 키가 필요합니다. 403 이면 키는 유효하나 해당 조직의 billing 조회 권한이 없는 경우이니 Owner 계정으로 발급한 Admin 키인지 확인하세요."
    exit 1
  fi

  log "  page $page_num 수신 OK"

  IFS=$'\t' read -r has_more page_token < <(python3 "$JSON_PY" page-info "$body")
  [ "$has_more" = "true" ] && [ -n "$page_token" ] || break
done

meta="$(printf '{"starting_at":"%s","ending_at":"%s","bucket_width":"1d","endpoint":"/v1/organizations/cost_report","amount_units":"lowest currency unit (cents) as decimal string - divide by 100 for USD"}' \
        "$STARTING_AT" "$ENDING_AT")"
buckets="$(python3 "$JSON_PY" merge-pages "$OUT" "$meta" "$TMP_PAGES"/page_*.json)"

log "  저장: responses/anthropic_cost.json ($buckets buckets, $page_num page)"
