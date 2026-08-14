#!/usr/bin/env bash
# 세 API 를 모두 호출해 responses/ 에 저장한다.
# 하나가 실패해도 나머지는 계속 시도하고, 마지막에 요약을 출력한다.

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

run "Anthropic Usage" fetch_anthropic_usage.sh
run "Anthropic Cost"  fetch_anthropic_cost.sh
run "Vercel Billing"  fetch_vercel_usage.sh

echo
echo "=== 요약 ==="
printf '  %s\n' "${RESULTS[@]}"

# 실패가 하나라도 있으면 non-zero
printf '%s\n' "${RESULTS[@]}" | grep -q '^FAIL' && exit 1
exit 0
