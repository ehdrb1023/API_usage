# AI API 비용 대시보드

Claude(Anthropic Admin API)의 사용량·비용을 **한국시간 기준으로** 한 화면에서 본다.
GPT(OpenAI)는 자리가 마련돼 있고 키만 넣으면 켜진다.
지금은 **목업 데이터**로 동작하며, 환경변수 하나로 실제 API 로 전환된다.

> **범위: AI API 만.** 2026-08-26 에 Vercel·Supabase(인프라 비용) 연동을 전부 걷어냈다.
> 배경과 되살리는 방법은 `docs/api-clients-status.md` §3-3 / §3-8.

## 실행

```bash
npm install
npm run dev      # http://localhost:3000
```

API 키 없이 바로 뜬다 (`.env` 의 `DATA_SOURCE=mock` 이 기본값).

```bash
# 타입 검사 · 테스트 (package.json 에 스크립트로 등록돼 있지 않다)
npx tsc --noEmit
node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**/__tests__/*.test.ts"
npm run lint
```

## 미니 위젯 — 항상 켜두는 "오늘 얼마 썼나"

```bash
npm run dev      # 데이터 서버
npm run mini     # 오른쪽 아래에 항상 위 고정된 작은 창이 뜬다 (Windows)
```

`/mini` 는 **1분마다** 갱신되고, 무엇을 띄울지는 직접 고른다. 고르는 창은 두 곳에서
같은 컴포넌트로 뜬다 — 대시보드 상단 **⚙ 미니 창 항목** 버튼, 그리고 미니 창의 ⚙.
API 키가 30개를 넘어가면 큰 화면에서 고르는 쪽이 훨씬 편해서 대시보드에도 달았다.

한 줄 = **(서비스, 항목, 지표)** 조합이다.
- 항목: `전체` / 모델 하나(`claude-opus-5`) / API 키 하나(거래처별) — Claude·GPT 모두 키 단위
- 지표: 비용 · 총 토큰 · 입력 · 캐시 읽기 · 출력 · 요청 …

목록에는 **오늘 사용량이 0인 키·모델도 나온다.** 지금 안 쓰는 거래처를 미리 걸어 두고
언제 쓰기 시작하는지 보는 게 이 위젯의 용도라서다 (`오늘 0` 배지가 붙는다).

선택은 브라우저(localStorage)에만 저장되고 `storage` 이벤트로 창 사이를 넘나든다 —
대시보드에서 체크하면 열려 있는 미니 창이 그 자리에서 바뀐다.

창 띄우기·자동 시작·왜 트레이 아이콘이 아닌지는 `scripts/mini/README.md` 참고.

## 하루 경계 — **전부 KST**

대시보드와 미니 창 양쪽 모두, **모든 탭이 한국시간 자정에 하루가 바뀐다.**

예전에는 벤더마다 달랐다 (Claude KST / Vercel 미 태평양시 / Supabase UTC). 같은
"8월 13일" 이 탭마다 다른 24시간을 가리켜서 화면에 경고 배너까지 달아야 했다.
AI API 만 다루기로 하면서 그 문제가 사라졌다 — Anthropic·OpenAI 둘 다 사용량을
1시간 버킷으로 주기 때문이다.

| | 하루 경계 | 갱신 | 근거 |
| --- | --- | --- | --- |
| Claude | **KST 자정** | 대시보드 하루 1회 / 미니 창 1분 | `usage_report` 가 `bucket_width=1h` 지원 |
| GPT | **KST 자정** | 동일 | `usage/completions` 가 `bucket_width=1h` 지원 ⚠️ 미검증 |

> ⚠️ 1시간 버킷을 지원하지 않는 벤더를 추가하면 이 전제가 깨진다.
> 그때는 KST 라고 우기지 말고 `DayBoundary.label` 을 다르게 주고 경고 배너를 되살릴 것
> (`components/Dashboard.tsx` 에 그 자리와 이유가 주석으로 남아 있다).

### KST 로 자를 수 있는 이유 — 그리고 그 대가

**KST 자정은 UTC 15:00 정각**이라 시간 버킷 경계와 딱 맞는다. 그래서 1시간 버킷을
주워 담으면 **토큰은 오차 없이** 재구성된다 (30분 오프셋 타임존이면 불가능했다).

문제는 비용이다. 비용 리포트는 **두 벤더 모두 1일(UTC) 단위밖에 없어서** KST 로
자를 방법이 아예 없다. 그래서 같은 구간의 (비용 ÷ 토큰) 으로 모델·토큰 종류별 단가를
역산해 KST 실측 토큰에 곱한다.

```
1시간 버킷 ──┐
             ├─▶ lib/kst-days.ts ──▶ DayRows(KST) ──▶ lib/adapters/core.ts ──▶ 화면
UTC 하루 비용 ┘        │
                       └─▶ lib/token-rates.ts (단가 역산)
```

⚠️ **그 결과 화면의 비용은 전부 추정치다.** Claude 쪽 정확도는 두 방향으로 확인했다.

- 하루를 빼고 그 하루를 맞히는 hold-out 검증 7일 — 전부 오차 ±0.1% 이내
- 2026-08-25 실측, 8/12~8/24 구간 — 실제 `cost_report` 합계 $187.21 vs
  KST 재구성 합계 $187.21 (**오차 0.00%**). 날짜별로는 당연히 옮겨간다:
  8/21 이 UTC $25.39 → KST $18.61, 8/22 가 UTC $1.60 → KST $8.69.

GPT 쪽은 **아직 같은 검증을 못 했다** (`docs/openai-integration.md` §2).

소수점까지 정확한 청구액이 필요하면 벤더 콘솔의 비용 리포트가 정답이고,
그건 UTC 하루 기준이다. **둘 다 가질 수는 없다.**

조회 비용: 1시간 버킷은 페이지당 168개(=7일)라 두 달 구간이 8페이지, 총 0.38MB,
페이지당 1.5초다 (2026-08-25 Anthropic 실측). 하루 1회 캐시되므로 첫 로드만 ~15초, 이후 0.3초.

### ⚠️ Admin API 는 시간당 90회다 (Anthropic)

2026-08-25 실측 — `anthropic-ratelimit-requests-limit: 90`, 리셋 주기 약 1시간.
미니 위젯이 60초마다 폴링하면 **60회/시간**을 쓴다. 한 곳에서만 돌면 들어가지만,
로컬 개발 서버와 배포본이 **같은 Admin 키로 동시에** 돌면 120회가 되어 429 가 난다.

두 가지로 대응한다.

1. `.env` 의 `LIVE_REFRESH_SECONDS` 로 주기를 늘린다 (기본 60, 최소 30).
   클라이언트 폴링 주기도 이 값을 따라간다 — 서버가 스냅샷에 실어 보낸다.
2. 그래도 429 가 나면 **직전 값을 계속 보여준다** (`lib/vendor-fallback.ts`).
   화면에 `갱신 실패` 문구가 붙고, `retry-after` 동안은 아예 재시도하지 않는다.
   실패를 캐싱하지 않는 `unstable_cache` 특성상, 이 제동이 없으면 매 요청이 429 를
   다시 만들어 리밋이 영영 안 풀린다.

쿼터는 **벤더별로 따로 센다.** GPT 탭을 켠다고 Claude 쿼터가 줄지는 않는다.
OpenAI 쪽 한도는 아직 실측하지 못했다.

## 목업 ↔ 실제 API 전환

`.env` 의 값 하나만 바꾸면 된다.

```bash
DATA_SOURCE=mock   # mock/*.json 사용 (기본)
DATA_SOURCE=api    # 실제 API 호출
```

분기는 **`lib/data-source.ts` 한 파일**에만 있다. 목업 파일이 실제 응답 스키마
그대로 생겼기 때문에 두 경로가 같은 어댑터를 타고, 화면 코드는 전혀 바뀌지 않는다.

`api` 로 두고 키가 없으면 화면이 깨지는 대신 무엇이 비었는지 알려주는 에러 페이지가 뜬다.

## GPT(OpenAI) 를 켜려면

`.env` 에 `OPENAI_ADMIN_KEY=sk-admin-…` 를 넣으면 **탭이 자동으로 켜진다.**
비워 두면 탭이 아예 안 뜬다 (안 붙인 벤더가 "조회 실패" 로 떠 있으면 진짜 장애와
구분이 안 되기 때문).

⚠️ 켜기 전에 **`docs/openai-integration.md` 의 체크리스트를 먼저 돌릴 것.**
경로·파라미터·응답 필드가 전부 공개 문서 기준이고 실응답으로 검증되지 않았다.
이 연동의 위험은 "에러가 난다" 가 아니라 **틀린 채로 그럴듯한 숫자가 뜨는 것**이다.
검증 전까지는 화면 각주에 그 경고가 그대로 나온다.

## 벤더를 하나 더 붙이려면

`lib/services.ts` 에 `ServiceDefinition` 하나를 추가하면 끝난다.
집계·안분·KST 접기·단가 역산·캐시·실패 격리는 전부 공통 코드가 한다.

1. `lib/adapters/<vendor>.ts` — 벤더 원본 → `UsageRow` / `CostRow` **변환만**
2. `lib/clients/<vendor>.ts` — HTTP 호출 + 페이지네이션
3. `lib/services.ts` 에 정의 추가 (탭 문구·지표·조회 파라미터·활성 조건)
4. `lib/types.ts` 의 `ServiceId` 에 id 추가
5. `scripts/gen_mock.py` 에 목업 생성 추가

**집계 로직을 벤더 파일에 다시 쓰지 말 것.** 그러면 "한 탭은 맞는데 다른 탭은
합계가 안 맞는" 상태가 된다.

## 구조

```
mock/                      목업 데이터 (실제 API 스키마와 동일한 모양)
  anthropic-usage.json       usage_report + cost_report + api_keys
  openai-usage.json          usage + costs + projects (⚠️ 미검증 스키마)

config/
  client-keys.json         ★ 보조 축 표시 이름 (api_key_id·project_id → 이름). 팀이 직접 관리
  README.md                  ↑ 작성법·우선순위·id 확인 방법

lib/
  services.ts              ★ 서비스 레지스트리 — 벤더를 추가하는 곳은 여기 하나
  data-source.ts           ★ 목업/실API 스위치 + 캐시 + 실패 격리
  live.ts                  /mini 용 "오늘"(KST) 스냅샷
  live-types.ts            /mini 가 주고받는 모양 (클라이언트도 import)
  mini-storage.ts          표시 항목 저장 (localStorage = 원본, 창 사이 동기화)
  vendor-fallback.ts       429 때 직전 값 유지 + retry-after 만큼 재시도 중단

  ── 벤더 중립 (여기에 벤더 이름이 나오면 안 된다) ──
  kst.ts                   KST 시각·조회 구간 계산 (서버 로컬 타임존을 타지 않는다)
  kst-days.ts              1시간 버킷 → KST 하루 재구성
  token-rates.ts           UTC 하루 비용 → 단가 역산 → KST 비용 추정
  adapters/core.ts         2축 집계 · 키 표시 이름 · 비용 안분

  ── 벤더별 (변환만) ──
  adapters/anthropic.ts    Anthropic 응답 → 공통 모델  (센트 → USD)
  adapters/openai.ts       OpenAI 응답    → 공통 모델  (USD 그대로, 캐시 입력 분리)
  clients/anthropic.ts     Admin API 호출 + 커서/after_id 페이지네이션
  clients/openai.ts        Admin API 호출  ⚠️ 실키 미검증
  clients/types.ts         요청·응답 타입

  client-keys.ts           config/client-keys.json 로더 (벤더 클라이언트 아님)
  analytics.ts             기간 슬라이스, MoM, 급증일 판정
  types.ts                 UI 가 보는 정규화 모델
  format.ts                숫자·통화·날짜 포맷

components/                탭 · 기간선택 · 카드 · 라인차트 · 표
  MiniWidget.tsx           /mini 본체 — 1분 폴링 + 창 크기에 맞춰 커지는 레이아웃
  WidgetPicker.tsx         표시 항목 선택창 (대시보드 모달 · 미니 창 오버레이 공용)
app/api/live/route.ts      /mini 가 폴링하는 JSON

scripts/mini/              미니 창 띄우기 (앱 모드 + 항상 위 고정)
scripts/gen_mock.py        목업 재생성 (시드 고정, 결정적)
scripts/fetch_*.sh         벤더 응답 원문을 responses/ 에 떠보는 CLI  ⚠️ 아래 주의

docs/api-response-notes.md 응답 구조 정리 (벤더 비교표 포함)
docs/api-clients-status.md 클라이언트 준비 상태 · Anthropic 실키 검증 기록
docs/openai-integration.md ★ GPT 실키 붙일 때 하는 일 (체크리스트)
```

### ⚠️ `scripts/fetch_*.sh` 는 앱이 쓰는 경로가 아니다

원문을 눈으로 보기 위한 **덤프 도구**다. 앱의 정본 조회 경로는
`lib/clients/*.ts` + `lib/services.ts` 이고, `responses/` 를 읽는 코드는 하나도 없다.

조회 파라미터도 서로 다르다 — 스크립트 기본값은 "지난 7일 / 1일 버킷"(읽기 좋으라고),
앱은 "전월 1일~지금 / **1시간** 버킷"(KST 를 맞추려고)이다.
앱과 같은 조건을 재현하려면:

```bash
BUCKET_WIDTH=1h DAYS=60 bash scripts/fetch_anthropic_usage.sh
```

**개발 서버를 끄고 돌릴 것.** 안 그러면 미니 위젯 폴링과 쿼터가 겹쳐 429 가 나고,
원인이 스크립트인지 앱인지 구분되지 않는다.

## 화면에서 할 수 있는 것

- **탭** — Claude / GPT(키가 있을 때). **기간** — 7일 / 30일 / 이번 달.
- **보조 축 표(서비스별·프로젝트별)의 행을 클릭**하면 위쪽 카드·차트·일별 상세가
  그 항목 하나만의 수치로 바뀐다. 급증일(전일 대비 +20%)도 그 기준으로 다시 계산된다 —
  전체 합계로는 안 보이던 급증이 특정 거래처에서만 잡히는 경우가 있다.
  같은 행을 다시 누르거나 **"전체 보기로 돌아가기"** 를 누르면 해제된다.
  이때 **API 를 다시 부르지 않는다** — 사용량을 이미 `api_key_id`(GPT 는 `project_id`)
  로 받아 뒀으므로 메모리에 있는 데이터를 거르기만 한다 (`filterSeriesByAltKey`).
- 모델별·보조축별 두 표는 항목을 선택해도 **전체 기준**을 유지한다.
  키×모델 교차표는 만들지 않기 때문이다 (선택 중에는 화면에 그렇게 적힌다).

## 데이터에서 주의할 점

두 벤더를 나란히 만질 때 **가장 잘 틀리는 세 가지**. 전부 어댑터 경계에서 흡수하므로,
`lib/adapters/core.ts` 로 넘어간 뒤에는 신경 쓸 필요가 없다.

1. **금액 단위가 서로 반대다.**
   Anthropic `cost_report.amount` 는 **센트 문자열** (`"123.45"` = $1.2345),
   OpenAI `costs.amount.value` 는 **USD 실수**. 각각 `toCostRows()` 에서 끝낸다.
   섞으면 100배 차이가 난다.
2. **"입력 토큰" 의 뜻이 서로 다르다.**
   Anthropic `uncached_input_tokens` 는 캐시 읽기를 **뺀** 값,
   OpenAI `input_tokens` 는 캐시를 **포함한** 총 입력이다.
   `lib/adapters/openai.ts` 에서 빼서 뜻을 맞춘다 — 안 맞추면 두 탭의 "총 토큰" 이
   다른 뜻이 되고 GPT 쪽이 캐시만큼 부풀려진다.
3. **총 토큰 필드가 없다.** 두 벤더 모두 직접 합산한다.
   합산 대상은 `BuildOptions.totalOf` 로 정한다 — GPT 의 `requests`(요청 수)처럼
   토큰이 아닌 지표가 여기 들어가면 조용히 틀린 숫자가 된다.

그 밖에:

- **비용 리포트를 키/프로젝트로 나눌 수 없다** (두 벤더 공통).
  그래서 보조 축 비용은 같은 (날짜·모델·토큰 종류)의 토큰 수 비율로 **안분한 추정치**다.
  토큰 수는 실측이다.
- **경로 단·복수가 다르다.** Anthropic `/v1/organizations/…`, OpenAI `/v1/organization/…`.
- **시각 표기가 다르다.** Anthropic ISO8601 문자열, OpenAI unix 초 정수.

## 목업 데이터

`2026-07-01 ~ 2026-08-14` (45일). 30일보다 길게 만든 이유는 **전월 동기 대비**를
계산하려면 전월 같은 기간(7/1–7/14)이 필요하기 때문이다.

재생성:

```bash
python3 scripts/gen_mock.py
```

시드가 고정되어 있어 매번 같은 값이 나온다. 전일 대비 +20% 이상 급증하는 날이
의도적으로 섞여 있다 (빨간색 강조 확인용). API 키 4개(활성 3 · archived 1)와
프로젝트 3개가 섞여 있어 보조 축 표·비용 안분·비활성 배지까지 목업으로 확인된다.

⚠️ 목업 버킷은 UTC 하루 그대로다. 화면의 하루는 KST 지만, 목업은 배치를 보기 위한
것이라 1시간 버킷까지 만들지 않는다. **KST 재구성은 실 API 경로에서만 일어난다.**
