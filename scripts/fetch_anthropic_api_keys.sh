#!/usr/bin/env bash
# Anthropic Admin API — List API Keys (조직 전체, 상태 무관)
#
#   GET https://api.anthropic.com/v1/organizations/api_keys
#   헤더: x-api-key, anthropic-version
#   페이지네이션: ⚠️ 리포트 두 개와 **방식이 다르다**.
#                 page/next_page 가 아니라 after_id + last_id + has_more.
#
# 출력: responses/anthropic_api_keys.json
#   대시보드의 "서비스별 사용량" 표가 api_key_id → 이름을 붙일 때 쓰는 목록이다.
#   표에 이름 대신 "(알 수 없는 키)" 가 뜨면 이 원문부터 확인할 것.
#
# ⚠️ status 필터는 일부러 걸지 않는다. 과거 사용량에는 지금 archived/inactive 인 키도
#    등장하므로, 필터를 걸면 그 몫이 통째로 "(알 수 없는 키)" 가 된다.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
require_vars ANTHROPIC_ADMIN_KEY ANTHROPIC_API_VERSION
API_BASE="${ANTHROPIC_API_BASE:-https://api.anthropic.com}"

mkdir -p "$RESPONSE_DIR"
OUT="$RESPONSE_DIR/anthropic_api_keys.json"

CURL_CFG="$(make_curl_config \
  "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  "anthropic-version: $ANTHROPIC_API_VERSION" \
  "accept: application/json")"
trap 'rm -f "$CURL_CFG"' EXIT

log "Anthropic List API Keys"
log "  키:   ANTHROPIC_ADMIN_KEY=$(masked ANTHROPIC_ADMIN_KEY)"

TMP_PAGES="$(mktemp -d)"
trap 'rm -f "$CURL_CFG"; rm -rf "$TMP_PAGES"' EXIT

after_id=""
page_num=0

while :; do
  page_num=$((page_num + 1))
  body="$TMP_PAGES/page_$page_num.json"

  # limit: 기본 20 / 최대 1000. 기본값이면 21번째 키부터 조용히 잘린다.
  args=(--data-urlencode "limit=100")
  [ -n "$after_id" ] && args+=(--data-urlencode "after_id=$after_id")

  code="$(curl --config "$CURL_CFG" --get --max-time 60 \
          "${args[@]}" \
          --write-out '%{http_code}' --output "$body" \
          "$API_BASE/v1/organizations/api_keys")"

  if [ "$code" != "200" ]; then
    report_http_error "$code" "$body" \
      "ANTHROPIC_ADMIN_KEY (.env)" \
      "이 엔드포인트는 조직 Admin 키(sk-ant-admin...)가 필요합니다. 일반 API 키(sk-ant-api...)로는 401/403이 납니다. Console → Settings → Admin keys 에서 조직 Owner 권한으로 발급하세요."
    exit 1
  fi

  log "  page $page_num 수신 OK"

  IFS=$'\t' read -r has_more after_id < <(python3 "$JSON_PY" keys-page-info "$body")
  [ "$has_more" = "true" ] && [ -n "$after_id" ] || break
done

meta="$(printf '{"endpoint":"/v1/organizations/api_keys","status_filter":null,"limit":100}')"
count="$(python3 "$JSON_PY" merge-key-pages "$OUT" "$meta" "$TMP_PAGES"/page_*.json)"

log "  저장: responses/anthropic_api_keys.json ($count keys, $page_num page)"
