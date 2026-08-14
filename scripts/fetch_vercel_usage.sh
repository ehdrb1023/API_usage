#!/usr/bin/env bash
# Vercel REST API — FOCUS billing charges (지난 7일)
#
# 2026-02-19 changelog "Access billing usage and cost data via API" 로 공개된 엔드포인트.
#   GET https://api.vercel.com/v1/billing/charges?from=<ISO>&to=<ISO>&teamId=<id>
#   인증: Authorization: Bearer <token>
#   응답: FOCUS v1.3 스키마의 JSONL (application/jsonl) — 한 줄에 charge 1건, 스트리밍
#   from = 포함(inclusive), to = 제외(exclusive), 1일 granularity, 최대 1년 범위
#   페이지네이션 없음 — 스트림으로 전량 반환 (Accept-Encoding: gzip 으로 압축 가능)
#   권한: Owner / Member / Developer / Security / Billing / Enterprise Viewer 역할
#
# 출력:
#   responses/vercel_usage.jsonl  — 원본 JSONL 그대로
#   responses/vercel_usage.json   — 위를 배열로 감싼 것 (요청하신 파일명)

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
require_vars VERCEL_API_TOKEN
API_BASE="${VERCEL_API_BASE:-https://api.vercel.com}"

mkdir -p "$RESPONSE_DIR"
OUT_JSONL="$RESPONSE_DIR/vercel_usage.jsonl"
OUT_JSON="$RESPONSE_DIR/vercel_usage.json"

FROM="$(iso_days_ago 7)"
TO="$(iso_today)"

CURL_CFG="$(make_curl_config \
  "Authorization: Bearer $VERCEL_API_TOKEN" \
  "Accept: application/jsonl")"
trap 'rm -f "$CURL_CFG"' EXIT

log "Vercel FOCUS billing charges"
log "  기간: $FROM ~ $TO (from=inclusive, to=exclusive)"
log "  키:   VERCEL_API_TOKEN=$(masked VERCEL_API_TOKEN)"

args=(
  --data-urlencode "from=$FROM"
  --data-urlencode "to=$TO"
)
if [ -n "${VERCEL_TEAM_ID:-}" ]; then
  args+=(--data-urlencode "teamId=$VERCEL_TEAM_ID")
  log "  팀:   VERCEL_TEAM_ID=$(masked VERCEL_TEAM_ID)"
else
  warn "VERCEL_TEAM_ID 가 비어 있습니다 — 개인 계정 스코프로 요청합니다."
  warn "팀 리소스를 보려면 .env 에 VERCEL_TEAM_ID 를 채우거나 토큰 scope 를 팀으로 지정하세요."
fi

# -N: 스트리밍 버퍼 끄기 (JSONL 스트림)
code="$(curl --config "$CURL_CFG" --get -N --max-time 120 \
        "${args[@]}" \
        --write-out '%{http_code}' --output "$OUT_JSONL" \
        "$API_BASE/v1/billing/charges")"

if [ "$code" != "200" ]; then
  report_http_error "$code" "$OUT_JSONL" \
    "VERCEL_API_TOKEN / VERCEL_TEAM_ID (.env)" \
    "401 = 토큰이 유효하지 않거나 만료. 403 = 토큰은 유효하지만 해당 팀 청구 데이터 조회 권한이 없음 (Owner/Billing 등의 역할 필요, 또는 토큰 scope 가 다른 팀으로 잡혀 있음). 404 = teamId 오류. Vercel Dashboard → Account Settings → Tokens 에서 scope 를 해당 팀으로 지정해 재발급하세요."
  rm -f "$OUT_JSONL"
  exit 1
fi

# JSONL → JSON 배열 (Infinity 데이터소스는 JSONL 을 직접 파싱하지 못하므로 배열 형태도 함께 보관)
records="$(python3 "$JSON_PY" jsonl-to-json "$OUT_JSONL" "$OUT_JSON")"
log "  수신 OK — $records 개 charge 레코드"

if [ "$records" -eq 0 ]; then
  warn "레코드가 0건입니다. 해당 기간에 청구 항목이 없거나(무료 Hobby 플랜), 팀 스코프가 맞지 않을 수 있습니다."
  warn "Vercel 청구 데이터 API 는 Pro/Enterprise 팀 대상입니다 — Hobby 플랜이면 빈 응답이 정상입니다."
fi

log "  저장: responses/vercel_usage.jsonl, responses/vercel_usage.json"
