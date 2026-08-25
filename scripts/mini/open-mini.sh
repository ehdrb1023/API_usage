#!/usr/bin/env bash
# WSL 에서 Windows 쪽 PowerShell 을 불러 미니 위젯 창을 띄운다.
#
#   ./scripts/mini/open-mini.sh                       localhost:3000/mini (dev 서버 필요)
#   ./scripts/mini/open-mini.sh https://…/mini        배포본 (서버 불필요)
#
# 창 크기·위치를 바꾸려면 mini-window.ps1 의 param 기본값을 고치거나
# 아래 EXTRA 에 -Width 320 -Y -400 처럼 넘긴다.
set -euo pipefail

cd "$(dirname "$0")/../.."

URL="${1:-http://localhost:3000/mini}"
shift || true

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "powershell.exe 를 찾지 못했습니다. WSL 밖(순수 리눅스)이라면 브라우저에서 $URL 을 직접 여세요." >&2
  exit 1
fi

PS1_PATH="$(wslpath -w scripts/mini/mini-window.ps1)"
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS1_PATH" -Url "$URL" "$@"
