# 대시보드 버튼 QA

화면의 **모든 버튼을 실제 브라우저로 눌러 보고** 상태가 바뀌는지 확인합니다.
28개 항목 — 탭·기간·미니 창 항목 모달(접기/검색/칩/기본값/새 창/닫기)·표에서 키 선택·
`/mini`·창 간 storage 동기화·런타임 에러.

## 왜 별도인가 — 프로젝트 의존성이 아니다

Playwright 는 브라우저 바이너리까지 200MB 가 넘어서 `package.json` 에 넣지 않았습니다.
이 프로젝트의 단위 테스트(`node --test`)와 성격이 다릅니다 — 그쪽은 순수 함수를 보고,
이쪽은 **띄워 놓고 눌러 봐야만** 알 수 있는 것을 봅니다.

한 번 설치하면 계속 씁니다:

```bash
mkdir -p /tmp/qa && cd /tmp/qa && npm init -y
PLAYWRIGHT_BROWSERS_PATH=/tmp/qa/browsers npm i playwright
PLAYWRIGHT_BROWSERS_PATH=/tmp/qa/browsers npx playwright install chromium-headless-shell
```

## 돌리기

```bash
npm run dev                      # 다른 창에서 먼저

cd /tmp/qa
PLAYWRIGHT_BROWSERS_PATH=/tmp/qa/browsers \
  node /경로/API_usage/scripts/qa/dashboard-buttons.mjs
```

`QA_BASE` 로 주소를 바꿀 수 있습니다 (기본 `http://localhost:3000`).

## 알아 둘 것

- **동시에 두 벌 돌리지 마세요.** 같은 dev 서버를 두 브라우저가 두드리면 타임아웃이
  나고, 그게 앱 버그처럼 보입니다. 실제로 한 번 속았습니다.
- 탭은 `role="tab"` 입니다 (`role="button"` 이 아님 — `components/ServiceTabs.tsx`).
  `getByRole("button")` 으로 찾으면 0개가 나옵니다.
- 항목 선택은 체크박스가 아니라 `.wp-chip` 버튼(`aria-pressed`)입니다. 유일한
  체크박스인 "지표 전체" 는 컴포넌트 state 라 localStorage 를 건드리지 않습니다.
- `DATA_SOURCE=api` 로 돌리면 Anthropic Admin API 쿼터(시간당 90회)를 씁니다.
  반복해서 돌릴 거면 `DATA_SOURCE=mock` 이 안전합니다.

## 이 QA 가 실제로 잡은 것

`WidgetPicker` 가 대시보드에서 **영영 "목록을 불러오는 중…" 에서 멈추던 버그**
(2026-08-27). `useRef` 로 "딱 한 번만 fetch" 를 막아 뒀는데, StrictMode 가 이펙트를
실행→정리→재실행 시키면서 첫 응답은 정리 단계에 버려지고 재실행은 ref 에 걸려
되돌아나갔습니다. 미니 창은 스냅샷을 props 로 받아 이 경로를 안 타서 증상이
대시보드에만 났습니다 — 눌러 보지 않으면 못 찾는 종류입니다.
