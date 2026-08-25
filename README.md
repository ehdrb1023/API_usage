# API 비용 대시보드

Claude(Anthropic Admin API) 와 Vercel 의 사용량·비용을 한 화면에서 본다.
지금은 **목업 데이터**로 동작하며, 환경변수 하나로 실제 API 로 전환된다.

## 실행

```bash
npm install
npm run dev      # http://localhost:3000
```

API 키 없이 바로 뜬다 (`.env` 의 `DATA_SOURCE=mock` 이 기본값).

## 미니 위젯 — 항상 켜두는 "오늘 얼마 썼나"

```bash
npm run dev      # 데이터 서버
npm run mini     # 오른쪽 아래에 항상 위 고정된 작은 창이 뜬다 (Windows)
```

`/mini` 는 **1분마다** 갱신되고, 무엇을 띄울지는 직접 고른다. 고르는 창은 두 곳에서
같은 컴포넌트로 뜬다 — 대시보드 상단 **⚙ 미니 창 항목** 버튼, 그리고 미니 창의 ⚙.
API 키가 30개를 넘어가면 큰 화면에서 고르는 쪽이 훨씬 편해서 대시보드에도 달았다.

한 줄 = **(서비스, 항목, 지표)** 조합이다.
- 항목: `전체` / 모델 하나(`claude-opus-5`) / API 키 하나(거래처별) / Vercel 프로젝트 하나
- 지표: 비용 · 총 토큰 · 입력 · 캐시 읽기 · 출력 … (그 서비스가 가진 무엇이든)

목록에는 **오늘 사용량이 0인 키·모델도 나온다.** 지금 안 쓰는 거래처를 미리 걸어 두고
언제 쓰기 시작하는지 보는 게 이 위젯의 용도라서다 (`오늘 0` 배지가 붙는다).

선택은 브라우저(localStorage)에만 저장되고 `storage` 이벤트로 창 사이를 넘나든다 —
대시보드에서 체크하면 열려 있는 미니 창이 그 자리에서 바뀐다.

Claude 만 **한국시간 자정 리셋**이다. 세 벤더의 하루 경계가 서로 다르고, 그건
데이터 쪽에서 정해진다:

| 서비스 | 하루 경계 | 갱신 | 비고 |
| --- | --- | --- | --- |
| Claude | **KST 자정** | 1분 | 토큰은 실측, 비용은 단가 역산 추정 (실측 오차 ±0.1%) |
| Vercel | 미 태평양시 자정 (KST 16시) | 하루 1회 | charge 자체가 PT 로 끊겨 나와 KST 로 자를 수 없다 |
| Supabase | UTC 자정 (KST 9시) | 하루 1회 | 사용량 버킷이 1일 단위 고정 |

KST 가 아닌 줄에는 `PT` / `UTC` 배지가 붙는다. 창 띄우기·자동 시작·왜 트레이
아이콘이 아닌지는 `scripts/mini/README.md` 참고.

### Claude 만 KST 로 자를 수 있는 이유

`usage_report` 는 `bucket_width=1h` 를 지원하고 **KST 자정은 UTC 15:00 정각**이라
시간 버킷 경계와 정확히 맞는다. 그래서 토큰은 오차 없이 재구성된다.
반면 `cost_report` 는 **1일 단위밖에 없다.** 그래서 최근 며칠의 (비용 ÷ 토큰) 으로
모델·토큰 종류별 단가를 역산해 KST 실측 토큰에 곱한다 (`lib/anthropic-rates.ts`).
하루를 빼고 맞히는 hold-out 검증에서 7일 모두 오차 ±0.1% 안에 들었다.

### ⚠️ Admin API 는 시간당 90회다

2026-08-25 실측 — `anthropic-ratelimit-requests-limit: 90`, 리셋 주기 약 1시간.
미니 위젯이 60초마다 폴링하면 **60회/시간**을 쓴다. 한 곳에서만 돌면 들어가지만,
로컬 개발 서버와 배포본이 **같은 Admin 키로 동시에** 돌면 120회가 되어 429 가 난다.

두 가지로 대응한다.

1. `.env` 의 `LIVE_REFRESH_SECONDS` 로 주기를 늘린다 (기본 60, 최소 30).
   클라이언트 폴링 주기도 이 값을 따라간다 — 서버가 스냅샷에 실어 보낸다.
2. 그래도 429 가 나면 **직전 값을 계속 보여준다** (`lib/vendor-fallback.ts`).
   화면 상단에 `갱신 지연` 배지가 붙고, `retry-after` 동안은 아예 재시도하지 않는다.
   실패를 캐싱하지 않는 `unstable_cache` 특성상, 이 제동이 없으면 매 요청이 429 를
   다시 만들어 리밋이 영영 안 풀린다.

## 목업 ↔ 실제 API 전환

`.env` 의 값 하나만 바꾸면 된다.

```bash
DATA_SOURCE=mock   # mock/*.json 사용 (기본)
DATA_SOURCE=api    # 실제 API 호출
```

분기는 **`lib/data-source.ts` 한 파일**에만 있다. 목업 파일이 실제 응답 스키마
그대로 생겼기 때문에 두 경로가 같은 어댑터를 타고, 화면 코드는 전혀 바뀌지 않는다.

`api` 로 두고 키가 없으면 화면이 깨지는 대신 무엇이 비었는지 알려주는 에러 페이지가 뜬다.

## 구조

```
mock/                      목업 데이터 (실제 API 스키마와 동일한 모양)
  anthropic-usage.json       usage_report + cost_report
  vercel-usage.json          FOCUS v1.3 billing charges

config/
  client-keys.json         ★ 서비스별 표 표시 이름 (api_key_id → 이름). 팀이 직접 관리
  README.md                  ↑ 작성법·우선순위·api_key_id 확인 방법

lib/
  data-source.ts           ★ 목업/실API 스위치 — 교체 지점은 여기 하나
  live.ts                  /mini 용 "오늘" 스냅샷 (서비스마다 하루 경계가 다르다)
  live-types.ts            /mini 가 주고받는 모양 (클라이언트도 import)
  mini-storage.ts          표시 항목 저장 (localStorage = 원본, 창 사이 동기화)
  vendor-fallback.ts       429 때 직전 값 유지 + retry-after 만큼 재시도 중단
  kst.ts                   KST 하루 경계 계산 (서버 로컬 타임존을 타지 않는다)
  anthropic-rates.ts       cost_report 1d → 단가 역산 → KST 하루 비용 추정
  client-keys.ts           config/client-keys.json 로더 (벤더 클라이언트 아님)
  adapters/anthropic.ts    Anthropic 응답 → 정규화 모델
  adapters/vercel.ts       Vercel 응답    → 정규화 모델
  analytics.ts             기간 슬라이스, MoM, 급증일 판정
  types.ts                 UI 가 보는 정규화 모델
  format.ts                숫자·통화·날짜 포맷

components/                탭 · 기간선택 · 카드 · 라인차트 · 표
  MiniWidget.tsx           /mini 본체 — 1분 폴링 + 창 크기에 맞춰 커지는 레이아웃
  WidgetPicker.tsx         표시 항목 선택창 (대시보드 모달 · 미니 창 오버레이 공용)
app/api/live/route.ts      /mini 가 폴링하는 JSON
scripts/mini/              미니 창 띄우기 (앱 모드 + 항상 위 고정)
scripts/gen_mock.py        목업 재생성 (시드 고정, 결정적)
scripts/fetch_*.sh         실제 API 응답을 responses/ 에 떠보는 CLI
docs/api-response-notes.md 두 API 의 실제 응답 구조 정리
```

## 화면에서 할 수 있는 것

- **탭** — Claude / Vercel. **기간** — 7일 / 30일 / 이번 달.
- **서비스별 사용량 표의 행을 클릭**하면 위쪽 카드·차트·일별 상세가 그 API 키
  하나만의 수치로 바뀐다. 급증일(전일 대비 +20%)도 그 키 기준으로 다시 계산된다 —
  전체 합계로는 안 보이던 급증이 특정 거래처에서만 잡히는 경우가 있다.
  같은 행을 다시 누르거나 **"전체 보기로 돌아가기"** 를 누르면 해제된다.
  이때 **API 를 다시 부르지 않는다** — `usage_report` 를 이미 `group_by[]=api_key_id`
  로 받아 뒀으므로 메모리에 있는 데이터를 거르기만 한다 (`filterSeriesByAltKey`).
- 모델별·서비스별 두 표는 키를 선택해도 **전체 기준**을 유지한다. 키×모델 교차표는
  만들지 않기 때문이다 (선택 중에는 화면에 그렇게 적힌다).

## 데이터에서 주의할 점

세 가지는 실제 API 로 넘어갈 때도 그대로 유효하다.

1. **Anthropic `cost_report.amount` 는 센트 단위 문자열이다.** `"123.45"` = $1.2345.
   `lib/adapters/anthropic.ts` 에서 100 으로 나눈다. 빠뜨리면 금액이 100배가 된다.
2. **Anthropic 에는 `total_tokens` 필드가 없다.** 입력 + 캐시읽기 + 캐시생성 + 출력을
   직접 합산한다.
3. **Vercel 의 프로젝트는 `Tags.ProjectName` 에 중첩되어 있다.** 최상위 필드가 아니다.

본문 대시보드의 날짜는 전부 벤더 기준일이다 (Claude·Supabase 는 UTC, Vercel 은 PT).
KST 로 끊어 보고 싶으면 미니 위젯(`/mini`) 쪽을 쓴다 — 위 표 참고.

## 목업 데이터

`2026-07-01 ~ 2026-08-14` (45일). 30일보다 길게 만든 이유는 **전월 동기 대비**를
계산하려면 전월 같은 기간(7/1–7/14)이 필요하기 때문이다.

재생성:

```bash
python3 scripts/gen_mock.py
```

시드가 고정되어 있어 매번 같은 값이 나온다. 전일 대비 +20% 이상 급증하는 날이
의도적으로 섞여 있다 (빨간색 강조 확인용).
