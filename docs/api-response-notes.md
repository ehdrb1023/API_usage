# API 응답 구조 정리

> **검증 상태: 공식 문서 기준 (실제 응답 미검증)**
> `.env` 가 아직 없어 실제 호출을 하지 못했습니다. 아래 필드 표는 각 벤더의 공식 API 레퍼런스에서
> 확인한 스키마입니다. 키를 채우고 `bash scripts/fetch_all.sh` 를 돌린 뒤,
> 실제 응답과 다른 부분을 이 문서에 반영해야 합니다.
> 스크립트 자체는 문서 스키마대로 응답하는 목 서버로 검증 완료 (페이지네이션·403 경로 포함).

출처:
- [Anthropic — Get Messages Usage Report](https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-messages-usage-report)
- [Anthropic — Get Cost Report](https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-cost-report)
- [Vercel — List FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)
- [Vercel changelog — Access billing usage and cost data via API (2026-02-19)](https://vercel.com/changelog/access-billing-usage-cost-data-api)

---

## 0. 세 API 한눈에 비교

| | Anthropic Usage | Anthropic Cost | Vercel FOCUS Charges |
|---|---|---|---|
| 경로 | `GET /v1/organizations/usage_report/messages` | `GET /v1/organizations/cost_report` | `GET /v1/billing/charges` |
| 인증 | `x-api-key` (Admin 키) | `x-api-key` (Admin 키) | `Authorization: Bearer` |
| 응답 형식 | JSON | JSON | **JSONL** (`application/jsonl`) |
| 비용(USD) 필드 | ❌ 없음 (토큰 수만) | ✅ `amount` (**센트 단위 문자열**) | ✅ `BilledCost` / `EffectiveCost` (USD number) |
| 시간 단위 | 1m / 1h / 1d | **1d 만** | 1d 고정 |
| 최대 범위 | 1d 기준 31버킷 | 문서상 명시 없음 | **1년** |
| 페이지네이션 | 커서 (`next_page`) | 커서 (`next_page`) | **없음** (전량 스트리밍) |
| 플랜 제약 | 조직 Admin 키 필요 | 조직 Admin 키 필요 | Owner/Member/Developer/Security/Billing/Enterprise Viewer 역할 |

---

## 1. Anthropic — Messages Usage Report

`GET https://api.anthropic.com/v1/organizations/usage_report/messages`

### 요청

| 파라미터 | 필수 | 값 | 비고 |
|---|---|---|---|
| `starting_at` | ✅ | RFC 3339 | UTC 기준 분/시/일 시작점으로 스냅됨 |
| `ending_at` | | RFC 3339 | 이 시각 **이전에 끝나는** 버킷만 반환 |
| `bucket_width` | | `1d` \| `1h` \| `1m` | |
| `limit` | | number | `1d`: 기본 7 / **최대 31**<br>`1h`: 기본 24 / 최대 168<br>`1m`: 기본 60 / 최대 1440 |
| `group_by[]` | | `model`, `api_key_id`, `workspace_id`, `account_id`, `service_account_id`, `service_tier`, `context_window`, `inference_geo`, `speed` | `speed` 는 `fast-mode-2026-02-01` 베타 헤더 필요 |
| `page` | | string | 이전 응답의 `next_page` |
| 필터류 | | `models[]`, `api_key_ids[]`, `workspace_ids[]`, `account_ids[]`, `service_tiers[]`, `context_window[]`, `inference_geos[]` | |

헤더: `x-api-key`, `anthropic-version: 2023-06-01`

### 응답 구조

```
{ data: [ { starting_at, ending_at, results: [...] } ], has_more, next_page }
```

`results[]` 필드:

| 필드 | 타입 | 의미 |
|---|---|---|
| `uncached_input_tokens` | number | 캐시 미적용 입력 토큰 |
| `cache_creation.ephemeral_5m_input_tokens` | number | 5분 캐시 **생성** 입력 토큰 |
| `cache_creation.ephemeral_1h_input_tokens` | number | 1시간 캐시 **생성** 입력 토큰 |
| `cache_read_input_tokens` | number | 캐시 **읽기** 입력 토큰 |
| `output_tokens` | number | 출력 토큰 |
| `server_tool_use.web_search_requests` | number | 웹 검색 요청 수 (토큰 아님) |
| `model` | string\|null | `group_by[]=model` 없으면 null |
| `api_key_id` | string\|null | Console 사용분은 null |
| `workspace_id` | string\|null | 기본 워크스페이스는 null |
| `account_id` / `service_account_id` | string\|null | 비-OAuth / 비-OIDC 요청은 null |
| `service_tier` | enum\|null | `standard`, `batch`, `flex`, `flex_discount`, `priority`, `priority_on_demand` |
| `context_window` | enum\|null | `0-200k`, `200k-1M` |
| `inference_geo` | enum\|null | `global`, `us`, `not_available` |

**토큰 수는 어디에 있나** → 위 5개 필드의 합이 총 토큰. 단일 "total_tokens" 필드는 **없으므로 대시보드에서 직접 합산**해야 합니다.

```
총 입력 = uncached_input_tokens
        + cache_creation.ephemeral_5m_input_tokens
        + cache_creation.ephemeral_1h_input_tokens
        + cache_read_input_tokens
총 토큰 = 총 입력 + output_tokens
```

### 주의점

- `group_by` 를 지정하지 않으면 해당 필드는 전부 `null` 로 오고 결과가 1건으로 뭉칩니다.
  `group_by[]` 를 늘릴수록 `results[]` 행 수가 조합만큼 늘어납니다.
- 사용량이 없는 구간도 버킷은 반환됩니다 (`results: []`). 그래프에서 0으로 처리하면 됩니다.
- **비용은 여기 없습니다.** 토큰 수뿐이라 금액은 cost_report 를 써야 합니다.

---

## 2. Anthropic — Cost Report

`GET https://api.anthropic.com/v1/organizations/cost_report`

### 요청

| 파라미터 | 필수 | 값 | 비고 |
|---|---|---|---|
| `starting_at` | ✅ | RFC 3339 | |
| `ending_at` | | RFC 3339 | |
| `bucket_width` | | **`1d` 만** | usage_report 와 달리 시간/분 단위 불가 |
| `group_by[]` | | **`description`, `workspace_id` 만** | usage_report 보다 선택지가 훨씬 적음 |
| `limit` / `page` | | | 커서 페이지네이션 동일 |

### 응답 구조

`data[].results[]` 필드:

| 필드 | 타입 | 의미 |
|---|---|---|
| **`amount`** | **string** | **비용. 최소 통화 단위(센트)의 decimal 문자열** |
| `currency` | string | 현재 항상 `"USD"` |
| `cost_type` | enum\|null | `tokens`, `web_search`, `code_execution`, `session_usage` |
| `description` | string\|null | 예: `"Claude Sonnet 4 Usage - Input Tokens"` |
| `token_type` | enum\|null | `uncached_input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens` |
| `model` | string\|null | 비-토큰 비용이면 null |
| `service_tier` | enum\|null | `standard`, `batch` |
| `context_window` | enum\|null | `0-200k`, `200k-1M` |
| `workspace_id` | string\|null | 기본 워크스페이스는 null |

### ⚠️ 가장 중요한 함정: `amount` 단위

`amount` 는 **숫자가 아니라 문자열**이고, **달러가 아니라 센트**입니다.

```
"123.45"  →  $1.2345   (달러 아님!)
```

Grafana 에서 반드시 두 단계를 거쳐야 합니다.
1. 문자열 → 숫자 캐스팅 (Infinity 컬럼 타입을 `number` 로 지정)
2. **100 으로 나누기** (Infinity UQL 또는 Grafana `Add field from calculation` 트랜스폼)

이걸 빠뜨리면 대시보드 금액이 **100배**로 표시됩니다.

또한 `cost_type` 이 `null` 인 행(= `group_by=description` 미지정 시)과 지정 시 행이 섞이지 않도록,
합계를 낼 때 `group_by` 조합을 고정해두는 편이 안전합니다.

---

## 3. Vercel — FOCUS billing charges

`GET https://api.vercel.com/v1/billing/charges`

2026-02-19 changelog 에서 공개된 엔드포인트가 맞습니다. FOCUS v1.3 오픈 표준 포맷입니다.

### 요청

| 파라미터 | 필수 | 값 | 비고 |
|---|---|---|---|
| `from` | ✅ | ISO 8601 UTC | **포함**(inclusive) |
| `to` | ✅ | ISO 8601 UTC | **제외**(exclusive) |
| `teamId` | | string | 팀 스코프 |
| `slug` | | string | `teamId` 대신 팀 slug 로도 지정 가능 |

- 헤더: `Authorization: Bearer <token>`, 선택적으로 `Accept-Encoding: gzip`
- 1일 granularity, **최대 범위 1년**
- 필요 역할: Owner / Member / Developer / Security / Billing / Enterprise Viewer

### ✅ 실제 "비용(원가)" 필드가 있습니다

1차 조사에서는 Vercel 에 공개 청구 API 가 없다고 봤는데, **틀렸습니다.** 이 엔드포인트에는
정식 비용 필드가 두 개 있습니다.

| 필드 | 타입 | 의미 |
|---|---|---|
| **`BilledCost`** | number | **청구서의 기준이 되는 금액.** 대시보드 "실제 지불액"은 이 필드 |
| **`EffectiveCost`** | number | 할인·선결제 크레딧 상각을 반영한 **상각 원가**. FinOps 관점의 실질 원가 |
| `BillingCurrency` | string | `USD` 고정 |

두 값은 다를 수 있습니다. 크레딧으로 커버된 사용량은 `BilledCost > 0` 이어도 `EffectiveCost = 0`
이 될 수 있으므로, **"청구액" 패널은 `BilledCost`, "원가 배분" 패널은 `EffectiveCost`** 로 나누는 게 맞습니다.

### 사용량 필드

| 필드 | 타입 | 의미 |
|---|---|---|
| `ConsumedQuantity` | number\|null | 소비량. 측정 가능한 소비가 없는 charge 는 null |
| `ConsumedUnit` | string\|null | 소비량 단위 (예: GB-hours, requests) |
| `PricingQuantity` | number | 과금 계산에 쓰인 수량 |
| `PricingUnit` | string | 과금 단위 (예: million requests) |
| `PricingCategory` | enum | `Standard`, `Committed`, `Dynamic`, `Other` |

`ConsumedQuantity` 와 `PricingQuantity` 는 **단위가 다릅니다** (예: 250,000 requests vs 0.25 million
requests). 사용량 그래프를 그릴 때 어느 쪽 단위로 통일할지 먼저 정해야 합니다.

### 분류 / 메타 필드

| 필드 | 타입 | 의미 |
|---|---|---|
| `ChargeCategory` | enum | `Usage`, `Purchase`, `Credit`, `Adjustment`, `Tax` |
| `ChargePeriodStart` / `ChargePeriodEnd` | string | 시작 포함 / 끝 제외 (ISO 8601 UTC) |
| `ServiceName` | string | 서비스 표시명 (예: Fluid Compute, Edge Requests) |
| `ServiceCategory` | enum | `Compute`, `Networking`, `Storage`, `Web`, `AI and Machine Learning` 등 |
| `ServiceProviderName` | string | 제공자 |
| `RegionId` / `RegionName` | string | 리전 |
| **`Tags`** | object | **`ProjectId`, `ProjectName` 이 여기 들어 있음** |

**프로젝트별 비용을 보려면 `Tags.ProjectName` 으로 그룹핑**해야 합니다. 최상위에 project 필드가
따로 있는 게 아니라 `Tags` 객체 안에 중첩되어 있다는 점에 주의.

### ⚠️ 합계를 낼 때

`ChargeCategory` 에 `Credit`, `Tax`, `Adjustment` 가 섞여 들어옵니다. "사용량 비용"만 보려면
`ChargeCategory == "Usage"` 로 필터해야 하고, "실제 청구 총액"을 보려면 전부 더해야 합니다.
두 숫자는 다릅니다.

---

## 4. 페이지네이션 정리

| API | 방식 | 처리 |
|---|---|---|
| Anthropic (둘 다) | 커서 | `has_more == true` 이면 `next_page` 를 `page` 파라미터로 재요청. `fetch_*.sh` 가 루프로 처리해 `data` 배열을 병합 저장 |
| Vercel | 없음 | JSONL 스트림으로 전량 반환. `-N` 으로 버퍼링 끄고 받음 |

Anthropic 은 `limit` 상한(1d 기준 31버킷)이 있어서 **30일 조회 시에도 한 페이지에 들어갈 수
있지만**, 90일 대시보드를 만들면 반드시 여러 페이지가 됩니다. 스크립트는 이미 루프를 돌립니다.

---

## 5. Grafana Infinity 연동 시 반영해야 할 것

문서 조사 단계에서 드러난, 대시보드 설계에 직접 영향을 주는 항목입니다.

1. **Anthropic `amount` 를 100 으로 나눌 것.** 안 하면 100배. 컬럼 타입도 string → number 캐스팅 필요.
2. **Vercel 응답은 JSONL 이라 Infinity 의 기본 JSON 파서로 바로 안 읽힙니다.**
   현재 스크립트는 `vercel_usage.json` (배열 변환본)을 함께 저장합니다. Infinity 를 API 에
   직결하려면 UQL 로 라인 분해가 되는지 검증하거나, 스크립트를 주기 실행해 변환된 JSON 을
   정적 파일로 서빙하는 쪽이 확실합니다.
3. **Infinity 커서 페이지네이션 지원 여부는 실측 필요.** Infinity 에 pagination 기능이 있지만
   Anthropic 의 opaque 커서 방식과 맞는지 확인되지 않았습니다. 안 되면 스크립트 선실행 방식으로.
4. **Anthropic 총 토큰은 5개 필드 합산.** 단일 total 필드 없음.
5. **Vercel 프로젝트 그룹핑은 `Tags.ProjectName` (중첩 경로).**
6. **두 벤더의 시간축 정렬.** Anthropic 은 버킷 `starting_at`(포함)/`ending_at`(제외),
   Vercel 은 `ChargePeriodStart`(포함)/`ChargePeriodEnd`(제외). 규칙이 같아서 그대로 맞물립니다.
   단 대시보드 타임존을 UTC 로 두거나, `Asia/Seoul` 로 볼 거면 일 경계가 9시간 밀린다는 점을 표기할 것.

---

## 6. 남은 검증 항목 (실제 키 확보 후)

- [ ] Anthropic Admin 키로 200 응답 확인, 실제 `results[]` 필드가 문서와 일치하는지
- [ ] `amount` 가 정말 센트인지 Console 청구액과 대조
- [ ] Vercel 토큰 플랜 확인 — Hobby 플랜이면 `/v1/billing/charges` 가 빈 응답 또는 403 일 가능성
- [ ] Vercel `ConsumedUnit` 실제 값 목록 수집 (단위 통일 기준 정하기용)
- [ ] Supabase Management API — 이번 작업 범위 밖. 사용량 엔드포인트 존재 여부 미확인 상태
