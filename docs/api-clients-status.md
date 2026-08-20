# API 클라이언트 준비 상태

> **한 줄 요약:** `lib/clients/` 에 Anthropic Admin API·Vercel Billing API 클라이언트를
> 타입·에러 처리·테스트까지 갖춰 넣어 뒀고, **2026-08-14 실제 키로 4개 엔드포인트 모두
> 200 을 받아 §3 체크리스트를 대부분 소진했습니다.** `lib/data-source.ts` 도 이 클라이언트로
> 교체 완료. 남은 미검증 항목은 §3 에 `⚠️` 로 남아 있습니다.
>
> 작성일 2026-08-14 · 실키 검증 2026-08-14 · 스키마 출처는 각 파일 상단 주석 참고

---

## 1. 무엇이 준비됐나

| 파일 | 내용 |
|---|---|
| `lib/clients/types.ts` | 두 API의 요청·응답 타입 전부. 불확실한 필드는 `⚠️ 실제 응답으로 검증 필요` 주석. 공통 에러 클래스 `MissingCredentialError` / `ApiClientError` 포함 |
| `lib/clients/anthropic.ts` | `usage_report/messages` + `cost_report` + `api_keys` 호출. 커서 페이지네이션(리포트)·`after_id` 페이지네이션(키 목록), 베타 헤더, 센트→USD 변환 |
| `lib/clients/vercel.ts` | `/v1/billing/charges` (FOCUS v1.3 JSONL) 호출. 구간 검증, JSONL 파싱, 일별/프로젝트별 집계 |
| `lib/clients/__tests__/anthropic.test.ts` | 27개 케이스 (목 응답) |
| `lib/adapters/__tests__/anthropic.test.ts` | 13개 케이스 — 표시 이름 우선순위·겹침 구분자·두 축 합계 일치 |
| `lib/__tests__/analytics.test.ts` | 15개 케이스 — 키별 시계열 필터, 키 기준 급증일 재계산, 기간 필터 유지 |
| `lib/clients/__tests__/vercel.test.ts` | 20개 케이스 (목 응답) |
| `lib/clients/__tests__/ts-resolve.mjs` | `node --test` 가 확장자 없는 상대 import 를 해석하게 해 주는 훅 (테스트 전용) |

### 확정된 엔드포인트

| | Anthropic Usage | Anthropic Cost | Vercel FOCUS Charges |
|---|---|---|---|
| 경로 | `GET /v1/organizations/usage_report/messages` | `GET /v1/organizations/cost_report` | `GET /v1/billing/charges` |
| 인증 헤더 | `x-api-key` + `anthropic-version` | 동일 | `Authorization: Bearer` |
| 응답 형식 | JSON | JSON | **JSONL** (`application/jsonl`) |
| 비용 필드 | ❌ 없음 (토큰만) | ✅ `amount` (**센트 단위 문자열**) | ✅ `BilledCost` / `EffectiveCost` (USD number) |
| 페이지네이션 | 커서 (`next_page`) | 커서 (`next_page`) | **없음** (전량 스트림) |
| 시간 단위 | `1d` / `1h` / `1m` | **`1d` 만** | 1일 고정 |
| 최대 범위 | 1d 기준 31버킷/페이지 | 명시 없음 | **1년** |

네 번째 엔드포인트 `GET /v1/organizations/api_keys` (List API Keys) 는 위 표에 넣지
않았습니다 — 사용량·비용 리포트가 아니라 **`api_key_id` → 이름·상태 매핑**만 주는
보조 엔드포인트이고, 페이지네이션도 `after_id`/`last_id` 로 혼자 다릅니다.
"서비스별 사용량" 표가 이걸 씁니다 (§3-7).

Vercel 엔드포인트는 2026-02-19 changelog
["Access billing usage and cost data via API"](https://vercel.com/changelog/access-billing-usage-cost-data-api)
로 공개된 정식 API 가 맞고, 스펙은
[List FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)
레퍼런스로 필드 단위까지 대조했습니다. CLI 대응물은 `vercel usage --from … --to …` 입니다.

### 설계 원칙 (키가 없어도 안전한 이유)

- **import 는 부작용이 없습니다.** 키 검사는 **함수를 호출하는 순간**에만 일어납니다.
  지금 상태에서 `import` 만 해도 아무것도 터지지 않습니다.
- 키가 없으면 `MissingCredentialError` 를 던지고, 메시지에 **어떤 변수를 어디서 발급해
  어디에 넣어야 하는지**를 적어 둡니다. 예:
  `"ANTHROPIC_ADMIN_KEY가 .env에 없습니다. Console → Settings → Admin keys 에서 …"`
- `.env.example` 자리표시자(`sk-ant-admin01-xxxxxxxx…`)를 진짜 키로 오인하지 않습니다.
- 키가 없으면 **네트워크 호출 자체를 하지 않습니다** (테스트로 고정).
- 키는 헤더로만 보냅니다. 에러 메시지에 URL 이 찍혀도 키는 새지 않습니다 (테스트로 고정).
- `options.fetch` 로 fetch 를 갈아끼울 수 있어 테스트가 네트워크를 타지 않습니다.

### 사용 예

```ts
import {
  fetchAllAnthropicCostBuckets,
  fetchAllAnthropicUsageBuckets,
  centsStringToUsd,
} from "@/lib/clients/anthropic";
import { fetchVercelBillingCharges, sumChargesByDay } from "@/lib/clients/vercel";

// Anthropic — 페이지네이션까지 알아서
const usage = await fetchAllAnthropicUsageBuckets({
  starting_at: "2026-07-01T00:00:00Z",
  ending_at: "2026-08-01T00:00:00Z",
  bucket_width: "1d",
  limit: 31,
  group_by: ["model", "api_key_id", "workspace_id"],
});

const cost = await fetchAllAnthropicCostBuckets({
  starting_at: "2026-07-01T00:00:00Z",
  bucket_width: "1d",
  group_by: ["description", "workspace_id"], // cost_report 는 이 둘만 가능
});
const usd = centsStringToUsd(cost[0].results[0].amount); // "123.45" → 1.2345

// Vercel — 페이지네이션 없음, 한 번에 전량
const charges = await fetchVercelBillingCharges({
  from: "2026-07-01T00:00:00Z", // 포함
  to: "2026-08-01T00:00:00Z",   // 제외
});
const daily = sumChargesByDay(charges, { onlyUsage: true });
```

### 테스트 실행

```bash
node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**/__tests__/*.test.ts"
```

현재 **79 pass / 0 fail**. 별도 테스트 프레임워크를 설치하지 않고 Node 22 내장
`node:test` + 타입 스트리핑만 씁니다 (`package.json` 은 건드리지 않았습니다 —
`"test"` 스크립트로 등록하고 싶으면 위 명령을 그대로 넣으면 됩니다).

---

## 2. 아직 안 한 것 (의도적으로)

- ~~**`lib/data-source.ts` 는 그대로입니다.**~~ → **2026-08-14 교체 완료.**
  `fetchAnthropic()` 은 `fetchAllAnthropicUsageBuckets()` / `fetchAllAnthropicCostBuckets()`,
  `fetchVercel()` 은 `fetchVercelBillingCharges()` 를 부릅니다. 인라인 fetch·`requireEnv()` 제거.
- **재시도(429/5xx 백오프)는 없습니다.** 대시보드가 하루 몇 번 부르는 수준이라 우선
  뺐습니다. 필요해지면 `getJson()` 한 곳만 감싸면 됩니다.
- **Supabase 클라이언트는 없습니다.** 요청 범위 밖입니다.

---

## 3. 실제 키 연동 시 확인 체크리스트

키를 `.env` 에 넣은 직후 위에서부터 순서대로 확인하세요.
`⚠️` 표시된 항목은 코드 주석에도 같은 표시가 붙어 있습니다 — 확인이 끝나면 주석도 지워 주세요.

**2026-08-14 실키 검증 결과를 반영했습니다.** `[x]` = 실제 응답으로 확인,
`[ ]` = 아직 미확인(사유는 항목에 적음).

### 3-1. 공통

- [x] `.env` 에 값을 채웠고 `.env` 가 **커밋되지 않았는지** (`.gitignore` 에 등록돼 있음)
- [x] Next.js 서버 컴포넌트/라우트 핸들러에서만 import 하는지 — `lib/data-source.ts` 는
      `app/page.tsx`(서버 컴포넌트)에서만 import 됩니다
- [x] 첫 호출 응답 원문을 `responses/` 에 떨궈 두기 — `anthropic_usage.json`(81KB),
      `anthropic_cost.json`(126KB), `anthropic_api_keys.json`(31개 키),
      `vercel_charges.json`(4.8MB, **내용은 JSONL**).
      `responses/*.json` 은 `.gitignore` 대상이라 커밋되지 않습니다.
      키 목록만 다시 뜨려면 `bash scripts/fetch_anthropic_api_keys.sh`
- [x] 두 벤더의 일 경계 표기 — **둘이 서로 다릅니다.** Anthropic 버킷은 `00:00:00Z`(UTC 자정),
      Vercel `ChargePeriodStart`/`End` 는 8,708건 **전부** `07:00:00.000Z`(= UTC−7 자정,
      미 태평양시)였고 구간 길이는 정확히 24시간입니다. 화면 수정 완료 —
      헤더 배지가 탭별로 `UTC` / `미 태평양시 (UTC−7)` 로 바뀌고, 각주에는 탭별 상세를
      적었습니다 (`lib/types.ts` 의 `DayBoundary`, `lib/data-source.ts` 의 `DAY_BOUNDARIES`).
      "두 탭을 같은 날짜로 비교하지 말라"는 경고는 처음에 각주에 뒀다가
      **탭 바로 아래 배너로 옮겼습니다** — 스크린샷으로 재어 보니 각주 위치는
      Vercel 탭 기준 5.1화면을 스크롤해야 보였고, 정작 오해가 생기는 지점은
      탭 전환 직후 상단이기 때문입니다. 두 서비스의 `dayBoundary.label` 이
      서로 다를 때만 렌더링됩니다
      ⚠️ 확보한 데이터가 4일치(08-10~08-13)뿐이고 전부 서머타임 기간이라
      **겨울에 UTC−8(08:00Z)로 바뀌는지는 미확인**입니다. 11월 이후 재확인 필요

### 3-2. Anthropic Admin API

- [x] 키가 **Admin 키(`sk-ant-admin...`)** 인지 — `sk-ant-admin01-...` 확인
- [x] 두 엔드포인트에서 **200** — usage_report / cost_report 모두 200
- [x] ⚠️→✅ **`amount` 가 정말 센트인지** — **센트가 맞습니다.** Console 청구 화면 대신
      usage_report 토큰 수로 단가를 역산해 공시가와 대조했습니다:
      haiku-4-5 입력 $1.00/MTok, sonnet-5 입력 $2.00/MTok(인트로가), sonnet-5 캐시읽기
      $0.20/MTok(입력가의 10%), opus-4-8 입력 $5.00/MTok — 전부 `/100` 했을 때만 일치.
      (Console 청구 화면과의 최종 대조는 아직 — 하지만 4개 모델·3개 토큰종류가 공시가에
      정확히 떨어지므로 실질 확정)
- [x] ⚠️→✅ **배열 쿼리 파라미터 `group_by[]`** — 정상 동작. usage 185행 전부 `model`/`api_key_id`
      채워짐, cost 415행 전부 `description` 채워짐. `[]` 유지
- [ ] ⚠️ **`speed` 필드** — 미확인. 이번 호출에 `fast-mode-2026-02-01` 베타 헤더를 붙이지
      않았습니다. 필요해지면 별도 확인
- [x] `results[]` 필드명이 `types.ts` 와 일치 — `cache_creation.ephemeral_5m/1h_input_tokens`
      중첩 두 필드 포함 확인
- [x] **총 토큰은 5개 필드 합산** — 단일 `total_tokens` 필드 없음 재확인
- [x] 90일 이상… 이 아니라 **45일 조회로 다중 페이지 확인** — 31버킷/페이지라 45일이면
      2페이지가 되고, `collectAll()` 이 `next_page`(`page_MjAyNi0wOC0wMVQ...`)를 따라가
      44일치를 이어붙였습니다
- [x] ⚠️→✅ `cost_report` 의 `group_by` 가 `description`/`workspace_id` **둘뿐**인지 —
      **둘뿐입니다.** `group_by[]=api_key_id` 를 넣으면 400 이 납니다:
      `"group_by: Invalid group_by[]: \"api_key_id\". Valid options are \"description\", \"workspace_id\""`
      (`description` 과 함께 넣어도 동일). → **키별 비용은 API 로 직접 받을 수 없습니다.**
      §3-7 참고
- [x] **List API Keys 200** — `GET /v1/organizations/api_keys` 로 31개 키 수신
      (active 28 / archived 3, `has_more: false`). §3-7 참고

### 3-3. Vercel Billing API

- [x] 토큰 scope 가 **조회하려는 팀**으로 잡혀 있는지 — `team_C0AdBRy...` 로 200
- [x] 역할 확인 — 403 없이 조회됨
- [x] **플랜 확인** — Hobby 가 아니라 **Pro** (`ServiceName: "Pro"` 구독 항목이 옵니다).
      빈 배열이 아니라 8,708건
- [x] 응답 `content-type` 이 `application/jsonl` 인지, 한 줄 = charge 1건인지 — 확인
- [x] ⚠️→✅ **`Tags.ProjectId` / `Tags.ProjectName` 키 이름** — 정확합니다. 다만 **8,708건 중
      2,108건(24%)은 `Tags` 가 `{}`** 라서 "(프로젝트 미지정)" 이 비용 1위(40.6%)로 잡힙니다.
      키 이름 문제가 아니라 Vercel 이 태그를 안 붙이는 charge 가 원래 있는 것
- [x] ⚠️→✅ **`ConsumedUnit` 실제 값 목록 수집** — 21종 확인, `types.ts` 주석에 기록.
      `minute / hour / gigabyte / gigabyte-hour / gigabyte-month / Invocations / Requests /
      Execution Units / Reads / Writes / Operations / Units / Transformations / Creations /
      Events / Data Points / Traces / Projects / Seats / Credits` + null(구독 항목).
      지표 매핑은 `lib/adapters/vercel.ts` 의 `SERVICE_TO_METRIC` / `UNIT_TO_METRIC`
- [x] ⚠️→✅ `ConsumedQuantity` vs `PricingQuantity` — **단위가 다른 게 아니라 성격이 다릅니다.**
      `PricingUnit` 이 전부 `"USD"`, `PricingQuantity` 는 금액(대부분 0)입니다.
      사용량은 `ConsumedQuantity` 기준으로 확정. 정수가 아닐 수 있음(일 경계 안분)
- [x] ⚠️→✅ `RegionId` / `RegionName` / `ServiceCategory` 존재율 — **항상 오지 않습니다.**
      RegionId·RegionName 91.5%, ServiceCategory 99.9%. `types.ts` optional 유지가 맞습니다.
      추가 발견: **`ServiceCategory` 는 FOCUS 표준 enum 이 아니라 Vercel 자체 15종**이었습니다
      (`Build & Deploy`, `Vercel Functions`, `Observability` …). `types.ts` 수정 완료
- [x] **합계 기준 확정** — 이번 응답은 8,708건 **전부 `ChargeCategory: "Usage"`** 였습니다.
      `Credit` / `Tax` / `Adjustment` 는 한 건도 오지 않아 두 숫자가 현재는 동일합니다
- [x] `BilledCost` 와 `EffectiveCost` 가 갈리는지 — **크게 갈립니다.** `PricingCategory` 가
      8,692건 `Committed`(선결제 포함분)라 `BilledCost` 는 합계 $0.0000000002,
      `EffectiveCost` 는 $9.57. **대시보드는 `EffectiveCost` 로 확정** (BilledCost 로는
      실사용이 전부 $0.00 으로 보임)
- [x] 1년 초과 요청이 클라이언트에서 막히는지 — `assertValidRange()` 가 `RangeError`.
      348일(2025-09-01~2026-08-15) 요청은 실제 API 도 200
- [x] **조회 가능 구간** — 이 계정의 청구 데이터는 **2026-08-10 부터**만 존재합니다.
      데이터가 하나도 없는 구간을 요청하면 빈 배열이 아니라
      **HTTP 404 `{"error":{"code":"costs_not_found","message":"Costs not found"}}`** 가 옵니다.
      `from` 을 아무리 앞당겨도 반환 범위는 08-10~08-13 로 동일하고, 늘어나는 건 0원 행뿐입니다
      (from=08-01 → 7,552행 / 07-01 → 8,708행 / 2025-09-01 → 9,200행, EffectiveCost 합은 셋 다 $9.57)
- [x] **404 `costs_not_found` 는 빈 배열로 처리** — 진짜 에러가 아니라 "그 기간엔 데이터가 없다"
      는 뜻이라, `fetchVercelBillingCharges()` 가 예외 대신 `[]` 를 돌려줍니다.
      상태 코드만 보지 않고 **`error.code` 까지 확인**합니다(`isCostsNotFound`) — 다른 이유의
      404 는 그대로 던집니다. 안전한 판별인 근거: **잘못된 teamId·토큰은 404 가 아니라
      403 `forbidden`** 으로 옵니다 (실측). 회귀 테스트 4개 추가

### 3-4. 검증 후 정리

- [x] `types.ts` 의 `⚠️ 실제 응답으로 검증 필요` 주석을 확인된 것부터 제거 —
      `amount`(센트), `Tags`, `ConsumedUnit`, `ConsumedQuantity`, `ServiceCategory`,
      `buildQuery` 의 `group_by[]` 주석 갱신 완료. `speed` 만 `⚠️` 로 남김
- [ ] 실제 응답 1건씩을 `mock/*.json` 에 반영 (지금 목업은 문서 스키마 기준 추정치).
      **추가로: 목업 usage 는 `api_key_id` 가 전부 null** 이라 `DATA_SOURCE=mock` 에서는
      "서비스별 사용량" 표가 `(콘솔 직접 사용)` 한 줄로만 나옵니다. 표가 고장 난 게 아니라
      목업에 키가 없는 것입니다. `scripts/gen_mock.py` 가 키를 몇 개 섞어 주도록 고치면
      목업에서도 표가 보입니다.
      특히 목업 Vercel 은 `ServiceName` 이 `Build Execution` / `Fluid Compute` 처럼
      **실제로 존재하지 않는 이름**이라 매핑 검증에 쓸 수 없습니다
- [ ] `docs/api-response-notes.md` 의 "남은 검증 항목" 체크박스와 이 문서를 동기화
- [x] `lib/data-source.ts` 를 이 클라이언트로 교체 (§2 참고)

### 3-5. 확정: `cost_report.amount` 는 **센트**입니다

> 이 항목은 한 번 "USD 아니냐" 는 문제 제기가 있었던 곳이라, 근거를 재현 가능한 형태로 남겨 둡니다.
> **결론: 센트가 맞고 `centsStringToUsd()`(÷100)를 유지해야 합니다.**

Console 청구 화면 대신 **API 응답 두 개를 교차 검증**했습니다. `cost_report` 에는
`model` 과 `token_type` 이 함께 오므로, 같은 날·같은 모델·같은 토큰 종류를
`usage_report` 의 토큰 수와 맞춰 **단가를 역산**할 수 있습니다.

| 날짜 | 모델 | token_type | 토큰 수 | `amount` 원문 | ÷100 (센트 해석) | 그대로 (USD 해석) |
|---|---|---|---:|---|---|---|
| 07-21 | claude-haiku-4-5 | uncached_input | 2,919,015 | `"291.9015"` | **$1.00 / MTok** | $100 / MTok |
| 07-31 | claude-sonnet-5 | uncached_input | 1,143,691 | `"228.7382"` | **$2.00 / MTok** | $200 / MTok |
| 07-01 | claude-sonnet-5 | cache_read | 1,913,996 | `"38.2799"` | **$0.20 / MTok** | $20 / MTok |
| 07-19 | claude-opus-4-8 | uncached_input | 2,268,678 | `"1134.3390"` | **$5.00 / MTok** | $500 / MTok |

센트 해석의 값이 공시 단가와 **정확히** 일치합니다 — Haiku 4.5 입력 $1, Opus 4.8 입력 $5,
Sonnet 5 입력은 2026-08-31 까지 적용되는 인트로 단가 $2, 캐시 읽기는 입력가의 10%인 $0.20.
서로 다른 4개 모델과 3종의 토큰 타입이 전부 딱 떨어지므로 우연이 아닙니다.
USD 해석이 맞으려면 $500/MTok 짜리 모델이 존재해야 합니다.

규모로도 확인됩니다: 7월 한 달 `amount` 합계가 8,352.53 → 센트로 **$83.53**,
USD 로 읽으면 $8,352. 대시보드에 찍히는 8월 누적은 $87.58 입니다.

재현 명령:

재현 시 주의: **양쪽 다 먼저 합산해야 합니다.** `group_by[]` 에 `workspace_id` 가 있고
`description` 이 컨텍스트 윈도우·서비스 티어별로 갈리기 때문에, 같은 (날짜, 모델, token_type)
조합이 `cost_report` 에서 여러 행으로 쪼개져 옵니다. 한 행만 집어 비교하면 단가가
공시가보다 작게 나옵니다.

```bash
# responses/anthropic_{usage,cost}.json 을 받아 둔 상태에서
python3 - <<'PY'
import json, collections
u = json.load(open("responses/anthropic_usage.json"))
c = json.load(open("responses/anthropic_cost.json"))

TOK = {  # cost_report 의 token_type → usage_report 필드 경로
    "uncached_input_tokens":     lambda r: r["uncached_input_tokens"],
    "cache_read_input_tokens":   lambda r: r["cache_read_input_tokens"],
    "output_tokens":             lambda r: r["output_tokens"],
}

usage = collections.Counter()   # (날짜, 모델, token_type) → 토큰 수
for b in u["data"]:
    for r in b["results"]:
        for tt, pick in TOK.items():
            usage[(b["starting_at"][:10], r["model"], tt)] += pick(r)

cost = collections.defaultdict(float)   # 같은 키 → amount 합
for b in c["data"]:
    for r in b["results"]:
        if r["cost_type"] != "tokens" or r["token_type"] not in TOK: continue
        cost[(b["starting_at"][:10], r["model"], r["token_type"])] += float(r["amount"])

print(f"{'모델':28} {'token_type':26} {'토큰':>12} {'amount':>11} {'÷100':>11} {'그대로':>11}")
for key, amt in sorted(cost.items()):
    tok = usage[key]
    if tok < 1_000_000: continue          # 단가가 또렷하게 보이는 큰 건만
    date, model, tt = key
    print(f"{model:28} {tt:26} {tok:12,} {amt:11.4f} "
          f"{amt/100/tok*1e6:9.2f}/M {amt/tok*1e6:9.2f}/M")
PY
```

`÷100` 열이 공시 단가($1 / $2 / $5 / 캐시읽기 $0.20)에 떨어지고, `그대로` 열은
그 100배가 되어 존재하지 않는 단가가 나오는 것을 확인하면 됩니다.

### 3-6. 실키 검증에서 새로 드러난 것 (2026-08-14)

- **Vercel 지표 매핑이 거의 비어 있었습니다.** `SERVICE_TO_METRIC` 에 5종만 있었고 그중
  2종(`Build Execution`, `Fluid Compute`)은 실재하지 않는 이름이라, 8,708건 중 5,804건이
  미분류였습니다. 실제 61종을 전부 매핑하고 `ConsumedUnit` 기반 폴백을 추가해 99.7% 로
  올렸습니다. 남은 28건은 구독료·좌석 수처럼 사용량이 아닌 항목이라 **의도적으로** 뺐습니다.
- **`buildMinutes` 가 항상 0 이었던 이유** — 실제 이름은 `Build CPU Minutes` 입니다.
  30일 기준 1,372분이 잡히고, 이게 EffectiveCost 최대 항목($4.73)입니다.
- **지표는 `ConsumedUnit` 이 같은 것끼리만 묶었습니다.** 분·시간·GB·건수를 한 칸에 더하면
  숫자가 의미를 잃습니다. `gigabyte` 만 전송(`bandwidthGb`)과 저장(`storageGb`)으로 갈라
  손으로 분류했고, 새 `gigabyte` 서비스는 폴백이 받지 않고 일부러 누락시킵니다.

### 3-7. 서비스(API 키)별 집계 — 무엇이 실측이고 무엇이 추정인지

거래처에 내준 서비스가 키를 따로 쓰고 있어서 **키 = 서비스** 로 놓고 쪼갠 표
("서비스별 사용량")를 Claude 탭에 추가했습니다. 두 리포트의 능력이 달라서
**토큰은 실측, 비용은 안분 추정**입니다. 이 비대칭이 이 표의 유일한 함정입니다.

| | 키별로 나눌 수 있나 | 근거 |
|---|---|---|
| `usage_report` (토큰) | ✅ `group_by[]=api_key_id` | 2026-08-14 실측. 185행 전부 `api_key_id` 채워짐 |
| `cost_report` (비용) | ❌ **불가** | `group_by` 는 `description`/`workspace_id` 뿐. `api_key_id` 는 400 |

그래서 `lib/adapters/anthropic.ts` 가 비용을 이렇게 안분합니다:

1. `cost_report` 한 줄은 (날짜, 모델, `token_type`) 단위로 옵니다.
2. 같은 (날짜, 모델, `token_type`) 조합의 **토큰 수 비율**로 키들에 나눕니다.
3. 그 조합에 토큰이 없으면 (날짜, 모델) → (날짜) 순으로 넓혀 잡고,
   그래도 못 붙이면 `(키 배분 불가)` 행으로 따로 뺍니다.

**단가는 (모델 × 토큰 종류) 안에서 일정하므로 오차는 작습니다.** 다만 0 은 아닙니다 —
`service_tier`(standard/batch)나 `context_window`(0-200k/200k-1M)가 키마다 다르면
같은 조합 안에서도 단가가 갈리는데, `usage_report` 를 그 축까지 group_by 하지 않고 있어
그만큼은 뭉뚱그려집니다. 더 정확히 하려면 `group_by` 에
`service_tier`·`context_window` 를 추가하고 안분 키를 그만큼 늘리면 됩니다
(행 수가 늘어 페이지가 더 나뉩니다).

화면에서 키 하나를 골라 차트를 좁히는 기능(서비스별 표 행 클릭)도 **API 를 다시 부르지
않습니다.** `usage_report` 를 이미 `group_by[]=api_key_id` 로 받아 두었고 어댑터가 그것을
날짜별 `altItems` 로 펼쳐 두므로, `filterSeriesByAltKey()` 가 메모리에서 해당 키 행만
꺼내 시계열을 다시 만듭니다. 그 키를 안 쓴 날은 **0 으로 채웁니다** — 날짜를 건너뛰면
전일 대비(급증일) 계산이 어긋나기 때문입니다.

검증: 2026-07 전체(31일) 기준 **모델별 축과 키별 축의 합계가 소수점까지 일치**합니다
($83.525260 / 25,187,200 토큰, 차이 −2.8e−14 = 부동소수점 오차). 안분은 총액을
바꾸지 않고 나누기만 합니다.

#### 표시 이름은 3순위로 정해집니다

| 순위 | 출처 | 비고 |
|---|---|---|
| 1 | `config/client-keys.json` | 팀이 직접 관리. 코드 수정 없이 이 파일만 고치면 됩니다 (`lib/client-keys.ts` 가 요청마다 다시 읽음) |
| 2 | Console 에 등록된 키 이름 | 1순위 매핑이 없을 때 |
| 3 | 키 앞자리 (`apikey_01CUM5RWc…`) | 둘 다 없을 때. `미등록` 배지가 붙고, 전체 id 는 라벨 툴팁에 들어갑니다 |

파일이 없거나 JSON 문법이 틀리면 **매핑 전체를 무시하고 2순위로 되돌아갑니다** —
대시보드는 정상 동작하고, 원인은 서버 콘솔에 `[client-keys]` 로 찍힙니다.
빈 객체(`{}`)일 때 화면이 매핑 도입 전과 **바이트 단위로 동일**한 것을 확인했습니다.

#### 키 이름 매핑에서 드러난 것

- **키 이름은 유일하지 않습니다.** 31개 중 `speciai.team` 이라는 이름의 **active 키가
  두 개**(`apikey_018PUjgp…`, `apikey_0138Xv5o…`), `marketing` 계열은 대소문자·오타
  변형까지 5개(`martketing` / `MARKETING` / `Marketing`(archived) / `marketing`(archived) /
  `marketing`)입니다. 그래서 표는 **이름이 아니라 `api_key_id` 로 묶고**, 이름이 겹치는
  키에만 `partial_key_hint`(`sk-ant-api03-jef...KgAA`)를 옆에 작게 붙입니다.
  이름으로 묶었다면 서로 다른 거래처의 사용량이 한 줄로 합쳐졌을 겁니다.
  겹침 판정은 **매핑을 적용한 뒤의 최종 이름** 기준이라, `config/client-keys.json` 에서
  서로 다른 이름을 달아 주면 구분자가 사라집니다 (반대로 두 키에 같은 별칭을 달면 붙습니다)
- **`status` 필터를 걸면 안 됩니다.** 과거 사용량에는 지금 `archived` 인 키도 나옵니다
  (예: `speciai.agent`). `fetchAllAnthropicApiKeys()` 는 필터 없이 전부 받아오고,
  비활성 키는 이름을 그대로 보여주되 `비활성` 배지를 붙입니다.
- **`expires_at` 은 문서 스키마 예시에 없는데 실제로는 옵니다** (만료 없으면 null).
  `types.ts` 에 optional 로 넣어 뒀습니다.
- 2026-07 데이터에서 사용된 키 15개는 **전부 이름이 조회됐습니다** — `(알 수 없는 키)`
  0건, `(콘솔 직접 사용)`(= `api_key_id: null`) 0건. 이름 조회에 실패하는 경로는
  코드에는 있지만 이번 데이터로는 재현되지 않았습니다
- **페이지네이션 방식이 리포트와 다릅니다.** 리포트는 `page`/`next_page` 커서,
  키 목록은 `after_id` + `last_id` + `has_more` 입니다. 기본 `limit` 이 20 이라
  그대로 두면 21번째 키부터 조용히 사라집니다 — 클라이언트가 100 으로 올려 보냅니다
  (이번 조직은 31개라 1페이지에 끝나 `has_more: true` 경로는 **실응답으로는 미검증**,
  목 응답 테스트로만 고정)
