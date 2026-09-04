# PROJECT — 자동 감지 (2026-08-26, 갱신 2026-09-03 `/adopt`)

## 범위 (2026-09-03 확정 — `docs/project/BRIEF.md` §3)
**조직 전체 API/SaaS 지출**을 다룬다. 2026-08-26 의 "AI API 만" 결정은 대체됐다.

- **실시간 조회(Admin API)**: Claude **계정 3개** + GPT. 실키 검증 완료
  (Claude 2026-08-14 / GPT 2026-08-27)
  Admin 키는 발급한 조직 하나만 본다 → 계정마다 탭이 따로다 (`lib/accounts.ts`).
  키가 없는 계정은 탭 자체가 안 뜬다. **다른 계정 키로 폴백하지 않는다** —
  그러면 남의 조직 숫자가 그 탭에 뜬다
- **영수증·수기**: 나머지 벤더 전부 (`config/vendors.json` 25곳,
  `lib/billing/vendor-spend.ts`). Toss·Supabase·Vercel 등
- **하지 않는 것**: 인프라 벤더의 **사용량 API** 연동. 2026-08-26 에 삭제했고
  되살리지 않는다 — 지출만 본다

## 스택
- 런타임/언어: Node (버전 미고정 — `.nvmrc`·`engines` 없음) / TypeScript 5 (`strict: true`, `target: ES2017`)
- 패키지매니저: npm (`package-lock.json` 단독)
- 프레임워크: Next.js 16.3.1 App Router (`app/`, `next.config.ts` 빈 설정) + React 19.2.8
- UI: Tailwind CSS v4 (`@tailwindcss/postcss`), recharts 3.10
- DB·ORM: 없음. 외부 AI API(Anthropic Admin, OpenAI Admin) 조회 전용
- 테스트: `node --test` + 커스텀 TS 로더 (`lib/clients/__tests__/ts-resolve.mjs`). 프레임워크 미도입
- 린트/포맷: ESLint 9 flat config (`eslint-config-next`). 포매터 없음
- 배포: **Vercel 운영 중** — `kimlawtechs-projects/api-usage` (`.vercel/project.json`).
  Git 연동이라 **`main` 푸시 = 프로덕션 자동 배포**. `vercel.json`·`.github/` 가 없다고
  "배포 안 됨" 으로 읽지 말 것 (2026-09-04 에 실제로 그 착각을 했다).
  프로덕션은 Vercel 배포 보호(SSO) 뒤에 있다 — 지출 대시보드라 그래야 한다.
  환경변수는 Vercel Settings 에 별도로 있다. `.env` 와 동기화되지 않는다

## 구조
- `src/` 없음 — 루트 레벨 layer-first
  - `app/` 라우트 (`page.tsx`, `mini/page.tsx`, `api/live/route.ts`)
  - `components/` 프레젠테이션 컴포넌트 9개 (평면)
  - `lib/` — **3층으로 갈려 있다. 이 경계가 이 프로젝트의 핵심 규칙이다**
    1. **벤더 중립**: `kst.ts`, `kst-days.ts`, `token-rates.ts`, `adapters/core.ts`
       → 집계·안분·KST 접기·단가 역산. **벤더 이름이 나오면 안 된다**
    2. **벤더별**: `adapters/{anthropic,openai}.ts`(변환만), `clients/{anthropic,openai}.ts`(HTTP)
    3. **조립**: `services.ts`(레지스트리), `data-source.ts`(캐시·mock 분기),
       `live.ts`·`live-range.ts`(미니 위젯 스냅샷·구간 합산), `vendor-fallback.ts`(429 폴백)
    4. **서버 전용 fs 접근** (2026-08~09 추가, 위 3층 어디에도 정확히 안 맞는다 — U9):
       `billing/`(영수증 파싱·JSON 저장소·벤더 월지출·선불 잔액), `quota.ts`(구독 한도 잔량),
       `vendors.ts`(벤더 레지스트리), `client-keys.ts`(표시 이름),
       `accounts.ts`(Claude 계정 레지스트리), `budget.ts`(월 예산 = 종량제 막대의 분모)
       → **클라이언트 컴포넌트에서 import 금지.** 타입은 `live-types.ts` 경유
  - `config/` 표시 이름 매핑 + 벤더 레지스트리 + 수기 월비용 + 결제 메일함 설정,
    `mock/` 목업, `responses/`(gitignore) API 덤프, `data/billing/`(gitignore) **실 결제내역**,
    `scripts/` 덤프·QA·영수증 수집 스크립트, `docs/` 조사·검증 노트
- path alias: `@/*` → `./*` (루트 기준)
- 네이밍: 컴포넌트 `PascalCase.tsx` / lib 모듈 `kebab-case.ts` /
  테스트 `<dir>/__tests__/<모듈>.test.ts` / 스크립트 `snake_case` / 주석·문서 한국어

## 명령어
- dev `npm run dev` · build `npm run build` · start `npm start` · lint `npm run lint`
- 미니 창 `npm run mini`
- test **npm script 없음** — `node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**/__tests__/*.test.ts"`
- typecheck **없음** — `npx tsc --noEmit`
- 목업 재생성 `python3 scripts/gen_mock.py`

## 절대 규칙 (어기면 조용히 틀린 숫자가 나온다)
1. **하루는 KST 자정.** 모든 서비스가 같다. 1시간 버킷을 안 주는 벤더를 추가하면
   전제가 깨지므로 `DayBoundary.label` 을 다르게 주고 경고 배너를 되살릴 것.
2. **금액 환산은 어댑터 경계에서 끝낸다.** Anthropic 센트 문자열 / OpenAI USD 실수.
   `CostRow.usd` 로 넘어간 뒤에는 언제나 USD.
3. **과금 축(token_type)과 화면 지표를 합치지 말 것.** 캐시 생성 5m/1h 는 단가가
   2배 차이인데 화면에는 한 줄로 합쳐 보인다.
4. **집계 로직을 벤더 파일에 다시 쓰지 말 것.** `adapters/core.ts` 한 곳만 쓴다.
5. **`.env` 에 코드가 안 읽는 변수를 남기지 말 것.** 확인:
   `grep -rhoE "process\.env\.[A-Z_0-9]+" lib app components | sort -u`

## 규칙 예외
하네스 기본값과 다른 기존 관례. **기존 관례를 따른다.**
- 패키지매니저: pnpm 권장 → 실제 **npm**
- 구조: `src/` 하위 → 실제 **루트 레벨**
- 테스트: Vitest+Playwright 권장 → 실제 **node:test + 자체 TS 로더**.
  E2E 는 `scripts/qa/dashboard-buttons.mjs` (Playwright, **프로젝트 의존성 아님** —
  설치법은 `scripts/qa/README.md`)
- 검증: Zod 권장 → 미도입. 어댑터에서 수동 파싱·폴백
- `AGENTS.md`의 Next.js 경고: 학습 데이터와 다를 수 있으므로 코드 작성 전
  `node_modules/next/dist/docs/` 해당 가이드 확인

## 미확인 / 남은 일
- ~~GPT 실키 검증~~ **완료 2026-08-27.** hold-out 15일 합계 오차 0.68%,
  키별 안분 오차 -0.00%. 절차는 `docs/openai-integration.md`
- 배포 대상 — **Vercel 프로젝트 링크됨**: `api-usage`
  (`.vercel/project.json`, team `kimlawtech's projects`). 도메인 정책은
  `docs/subdomain-runbook.md` (`speciai.kr` 서브도메인, **무인증 공개 결정**)
- CI 없음 — 타입·테스트·린트 게이트가 전부 로컬 수동. `npm test`·typecheck 스크립트도 없음
- Node 버전 미고정 (`.nvmrc`·`engines` 부재)
- **근거 불명 31건** → `docs/retro/UNKNOWN-2026-09-03.md`. `/maintain` 첫 입력
- **ADR 8건 역작성** → `docs/adr/ADR-001~008`. 비가역 1 / 반가역 7
- **BRIEF** → `docs/project/BRIEF.md`. `[확인필요]` 3건이 열려 있다 (승인 전)
- `scripts/fetch_*.sh` 는 **앱 경로가 아니다** (덤프 도구). 조회 파라미터도 다르고
  `responses/` 를 읽는 코드는 없다. 각 스크립트 헤더에 명시해 둠
- `responses/vercel_charges.json` (4.8MB) — 범위 밖이 된 옛 덤프. 지워도 된다
