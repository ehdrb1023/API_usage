# API 클라이언트 준비 상태

> **한 줄 요약:** `lib/clients/` 에 Anthropic Admin API·Vercel Billing API 클라이언트를
> 타입·에러 처리·테스트까지 갖춰 넣어 뒀습니다. 실제 키는 아직 없고, 모든 검증은
> 목(mock) 응답 기준입니다. 키가 생기면 아래 §3 체크리스트만 따라가면 됩니다.
>
> 작성일 2026-08-14 · 스키마 출처는 각 파일 상단 주석 참고

---

## 1. 무엇이 준비됐나

| 파일 | 내용 |
|---|---|
| `lib/clients/types.ts` | 두 API의 요청·응답 타입 전부. 불확실한 필드는 `⚠️ 실제 응답으로 검증 필요` 주석. 공통 에러 클래스 `MissingCredentialError` / `ApiClientError` 포함 |
| `lib/clients/anthropic.ts` | `usage_report/messages` + `cost_report` 호출. 커서 페이지네이션, 베타 헤더, 센트→USD 변환 |
| `lib/clients/vercel.ts` | `/v1/billing/charges` (FOCUS v1.3 JSONL) 호출. 구간 검증, JSONL 파싱, 일별/프로젝트별 집계 |
| `lib/clients/__tests__/anthropic.test.ts` | 21개 케이스 (목 응답) |
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
node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/clients/__tests__/*.test.ts"
```

현재 **41 pass / 0 fail**. 별도 테스트 프레임워크를 설치하지 않고 Node 22 내장
`node:test` + 타입 스트리핑만 씁니다 (`package.json` 은 건드리지 않았습니다 —
`"test"` 스크립트로 등록하고 싶으면 위 명령을 그대로 넣으면 됩니다).

---

## 2. 아직 안 한 것 (의도적으로)

- **`lib/data-source.ts` 는 그대로입니다.** 거기에 이미 인라인 fetch 구현이 따로 있고,
  이번 작업 범위가 `lib/clients/` + `docs/` 로 한정돼 있어 건드리지 않았습니다.
  키 검증이 끝나면 `lib/data-source.ts` 의 `fetchAnthropic()` / `fetchVercel()` 을
  이 클라이언트 호출로 갈아끼우는 게 다음 단계입니다 (중복 제거 + 에러 메시지 개선).
- **재시도(429/5xx 백오프)는 없습니다.** 대시보드가 하루 몇 번 부르는 수준이라 우선
  뺐습니다. 필요해지면 `getJson()` 한 곳만 감싸면 됩니다.
- **Supabase 클라이언트는 없습니다.** 요청 범위 밖입니다.

---

## 3. 실제 키 연동 시 확인 체크리스트

키를 `.env` 에 넣은 직후 위에서부터 순서대로 확인하세요.
`⚠️` 표시된 항목은 코드 주석에도 같은 표시가 붙어 있습니다 — 확인이 끝나면 주석도 지워 주세요.

### 3-1. 공통

- [ ] `.env` 에 값을 채웠고 `.env` 가 **커밋되지 않았는지** (`.gitignore` 에 등록돼 있음)
- [ ] Next.js 서버 컴포넌트/라우트 핸들러에서만 import 하는지 (**클라이언트 컴포넌트 금지** — 키가 번들에 들어감)
- [ ] 첫 호출 응답 원문을 `responses/` 에 떨궈 두고 `docs/api-response-notes.md` 와 대조
- [ ] 두 벤더의 일 경계가 모두 UTC 라는 점 (대시보드를 `Asia/Seoul` 로 보면 9시간 밀림) 화면에 표기

### 3-2. Anthropic Admin API

- [ ] 키가 **Admin 키(`sk-ant-admin...`)** 인지 — 일반 API 키(`sk-ant-api...`)로는 401/403.
      조직 **Owner** 권한으로 Console → Settings → Admin keys 에서 발급
- [ ] 두 엔드포인트에서 **200** 이 오는지 (401/403 이면 위 항목부터 다시)
- [ ] ⚠️ **`amount` 가 정말 센트인지** — `centsStringToUsd()` 로 변환한 값을
      Console 청구 화면 금액과 대조. 100배 차이가 나면 이 함수부터 의심할 것
- [ ] ⚠️ **배열 쿼리 파라미터가 `group_by[]` 로 먹히는지** — 공식 문서는 파라미터 이름을
      `group_by` 로 적고 있어 대괄호 형태만 확인된 상태가 아닙니다.
      `group_by` 를 걸었는데 `results[]` 가 한 줄로 뭉쳐 오면 `buildQuery()` 에서 `[]` 를 떼고 재시도
      (`lib/clients/anthropic.ts` 의 `buildQuery`)
- [ ] ⚠️ **`speed` 필드** — `group_by[]=speed` + `anthropic-beta: fast-mode-2026-02-01` 로 호출했을 때
      `results[]` 에 `speed` 키가 실제로 오는지 (문서의 응답 스키마에는 없음).
      안 오면 `AnthropicUsageResult.speed` 를 지울 것
- [ ] `results[]` 의 나머지 필드명이 `types.ts` 와 일치하는지 (특히 `cache_creation` 중첩 두 필드)
- [ ] **총 토큰은 5개 필드 합산**이라는 점 재확인 — 단일 `total_tokens` 필드는 없음.
      `sumUsageTokens()` 사용
- [ ] 90일 이상 조회로 **다중 페이지**를 실제로 태워 보기 (1d 기준 31버킷/페이지)
- [ ] `cost_report` 의 `group_by` 는 `description` / `workspace_id` **둘뿐**임을 확인
      (usage_report 감각으로 `model` 을 넣으면 400)

### 3-3. Vercel Billing API

- [ ] 토큰 scope 가 **조회하려는 팀**으로 잡혀 있는지 (Account Settings → Tokens)
- [ ] 역할이 Owner / Member / Developer / Security / Billing / Enterprise Viewer 중 하나인지
      (아니면 403)
- [ ] **플랜 확인** — 무료 Hobby 플랜은 청구 항목이 없어 **빈 배열이 정상**입니다.
      0건이 왔을 때 "에러"로 오해하지 말 것 (Pro/Enterprise 팀 대상 API)
- [ ] 응답 `content-type` 이 정말 `application/jsonl` 인지, 한 줄 = charge 1건인지
- [ ] ⚠️ **`Tags.ProjectId` / `Tags.ProjectName` 키 이름이 정확한지** — FOCUS 스펙상 `Tags` 는
      자유 형식 맵이고 문서 설명에만 언급돼 있습니다. 프로젝트별 집계가 전부
      "(프로젝트 미분류)" 로 떨어지면 실제 키 이름부터 확인
      (`sumChargesByProject()` 가 이 경로를 씁니다)
- [ ] ⚠️ **`ConsumedUnit` 실제 값 목록 수집** — 문서에 열거돼 있지 않습니다.
      나오는 값(build-minutes / invocations / GB-hours …)을 모아
      `docs/api-response-notes.md` 에 적고, 사용량 그래프 단위 기준을 정할 것
- [ ] ⚠️ `ConsumedQuantity` 와 `PricingQuantity` 의 **단위가 다름** (예: 250,000 requests vs
      0.25 million requests). 어느 쪽으로 통일할지 결정
- [ ] ⚠️ `RegionId` / `RegionName` / `ServiceCategory` 는 FOCUS `required` 가 아닙니다 —
      실제로 항상 오는지 확인하고, 온다면 `types.ts` 에서 optional 을 떼도 됨
- [ ] **합계 기준 확정** — `ChargeCategory` 에 `Credit` / `Tax` / `Adjustment` 가 섞여 옵니다.
      "사용량 비용"(`onlyUsage: true`)과 "실제 청구 총액"(전부 합산)은 **다른 숫자**입니다.
      어떤 패널이 어느 쪽인지 정할 것
- [ ] `BilledCost` 와 `EffectiveCost` 가 실제로 갈리는 케이스(크레딧 사용분)가 있는지 확인.
      "청구액" 패널 = `BilledCost`, "원가 배분" 패널 = `EffectiveCost`
- [ ] 1년 초과 요청이 클라이언트에서 막히는지 (막습니다 — `RangeError`), 그리고 실제 API 도
      같은 제한인지

### 3-4. 검증 후 정리

- [ ] `types.ts` 의 `⚠️ 실제 응답으로 검증 필요` 주석을 확인된 것부터 제거
- [ ] 실제 응답 1건씩을 `mock/*.json` 에 반영 (지금 목업은 문서 스키마 기준 추정치)
- [ ] `docs/api-response-notes.md` 의 "남은 검증 항목" 체크박스와 이 문서를 동기화
- [ ] `lib/data-source.ts` 를 이 클라이언트로 교체 (§2 참고)
