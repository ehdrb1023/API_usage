#!/usr/bin/env bash
# 공통 유틸 — 각 fetch 스크립트에서 source 해서 사용.
#
# 보안 원칙:
#   1. 키 값은 .env 에서만 읽는다.
#   2. 키를 curl 명령행 인자로 넘기지 않는다 (`ps` 로 다른 프로세스에서 보임).
#      → mktemp(0600) 로 만든 curl config 파일에 헤더를 넣고 --config 로 전달, 종료 시 삭제.
#   3. 로그·파일명·에러 출력 어디에도 키 값을 찍지 않는다. 마스킹만 출력.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
RESPONSE_DIR="$REPO_ROOT/responses"
JSON_PY="$REPO_ROOT/scripts/_json.py"

# JSON 처리는 python3 표준 라이브러리로 한다 (jq 미설치 환경 대응).
command -v python3 >/dev/null 2>&1 || { echo "python3 가 필요합니다." >&2; exit 1; }

log()  { printf '  %s\n' "$*" >&2; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf '  x %s\n' "$*" >&2; exit 1; }

# .env 를 source 하지 않고 KEY=VALUE 행만 파싱한다 (임의 코드 실행 방지).
load_env() {
  [ -f "$ENV_FILE" ] || die ".env 파일이 없습니다: $ENV_FILE  (cp .env.example .env 후 값을 채우세요)"
  local line key val
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    export "$key=$val"
  done < "$ENV_FILE"
}

# 값은 절대 찍지 않고, 비어 있는지만 확인한다.
require_vars() {
  local missing=() v
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then missing+=("$v"); fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die ".env 에 값이 비어 있습니다: ${missing[*]}"
  fi
}

# 디버깅용 마스킹 표시 — 앞 3글자 + 길이만.
masked() {
  local v="${!1:-}"
  if [ -z "$v" ]; then printf '(empty)'; else printf '%s***(len=%d)' "${v:0:3}" "${#v}"; fi
}

# UTC ISO8601. GNU date 우선, 실패 시 BSD date.
iso_days_ago() {
  local n="$1"
  date -u -d "${n} days ago" +%Y-%m-%dT00:00:00Z 2>/dev/null \
    || date -u -v-"${n}"d +%Y-%m-%dT00:00:00Z
}
iso_today() {
  date -u -d "today" +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u +%Y-%m-%dT00:00:00Z
}

# 헤더를 담은 0600 임시 curl config 파일을 만든다. 인자: 헤더 문자열들.
# 경로를 stdout 으로 반환. 호출자는 CURL_CFG 를 trap 으로 정리할 것.
make_curl_config() {
  local cfg h
  cfg="$(mktemp "${TMPDIR:-/tmp}/curlcfg.XXXXXXXX")"
  chmod 600 "$cfg"
  for h in "$@"; do
    printf 'header = "%s"\n' "${h//\"/\\\"}" >> "$cfg"
  done
  printf 'silent\nshow-error\n' >> "$cfg"
  printf '%s\n' "$cfg"
}

# GET 요청. 본문은 $3 에 저장, HTTP 상태코드를 stdout 으로 반환.
http_get() {
  local cfg="$1" url="$2" out="$3"
  curl --config "$cfg" \
       --get \
       --max-time 60 \
       --write-out '%{http_code}' \
       --output "$out" \
       "$url"
}

# 4xx/5xx 응답 본문을 그대로 출력한다. Anthropic/OpenAI 에러 본문에는 키가 포함되지 않는다.
report_http_error() {
  local code="$1" body_file="$2" which_key="$3" hint="$4"
  warn "HTTP $code — 요청 실패"
  warn "확인할 키: $which_key"
  warn "$hint"
  printf '\n----- 응답 본문 (원문 그대로) -----\n' >&2
  cat "$body_file" >&2
  printf '\n-----------------------------------\n\n' >&2
}
