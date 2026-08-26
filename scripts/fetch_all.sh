#!/usr/bin/env bash
# 모든 벤더 엔드포인트를 호출해 responses/ 에 원문을 저장한다.
# 하나가 실패해도 나머지는 계속 시도하고, 마지막에 요약을 출력한다.
#
# ⚠️ **이 스크립트는 앱이 쓰는 조회 경로가 아니다.** 원문을 눈으로 보기 위한 덤프
#    도구다. 앱의 정본 조회 경로는 lib/clients/*.ts + lib/services.ts 이고,
#    responses/ 를 읽는 코드는 하나도 없다. 조회 파라미터도 서로 다르다 —
#    각 스크립트 헤더의 경고를 읽을 것.
#
# ⚠️ **개발 서버를 끄고 돌릴 것.** Anthropic Admin API 는 시간당 90회인데
#    `next dev` + 미니 위젯 폴링이 이미 60회/시간을 쓴다. 겹치면 429 가 나고,
#    원인이 스크립트인지 앱인지 구분되지 않는다.
#
# 환경변수:
#   DAYS  조회 일수 (기본 7) — 모든 하위 스크립트에 전달된다

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v python3 >/dev/null 2>&1 || { echo "python3 가 필요합니다." >&2; exit 1; }

declare -a RESULTS=()

run() {
  local name="$1" script="$2"
  echo
  echo "=== $name ==="
  if bash "$HERE/$script"; then
    RESULTS+=("OK   $name")
  else
    RESULTS+=("FAIL $name")
  fi
}

run "Anthropic Usage"    fetch_anthropic_usage.sh
run "Anthropic Cost"     fetch_anthropic_cost.sh
run "Anthropic API Keys" fetch_anthropic_api_keys.sh

# OPENAI_ADMIN_KEY 가 비어 있으면 건너뛴다 — 아직 안 붙인 벤더가 매번 FAIL 로
# 뜨면 진짜 실패와 구분이 안 된다. (앱의 탭 표시 규칙과 같은 원칙)
if grep -qE '^OPENAI_ADMIN_KEY=.+' "$HERE/../.env" 2>/dev/null; then
  run "OpenAI (미검증)" fetch_openai.sh
else
  echo
  echo "=== OpenAI ==="
  echo "  건너뜀 — .env 의 OPENAI_ADMIN_KEY 가 비어 있습니다." >&2
  RESULTS+=("SKIP OpenAI (키 없음)")
fi

echo
echo "=== 요약 ==="
printf '  %s\n' "${RESULTS[@]}"

# 실패가 하나라도 있으면 non-zero
printf '%s\n' "${RESULTS[@]}" | grep -q '^FAIL' && exit 1
exit 0
