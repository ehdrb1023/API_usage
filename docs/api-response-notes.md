# API 응답 구조 정리

> **범위: AI API 만.** 2026-08-26 에 Vercel·Supabase(인프라 비용) 절을 삭제했습니다.
> 이 대시보드는 Claude·GPT 등 AI API 비용만 다룹니다.
>
> **검증 상태**
> - Anthropic — ✅ 2026-08-14 실키로 검증 완료
> - OpenAI — ⚠️ **공개 문서 기준, 실응답 미검증.** 확인 절차는 `docs/openai-integration.md`

출처:
- [Anthropic — Get Messages Usage Report](https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-messages-usage-report)
- [Anthropic — Get Cost Report](https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-cost-report)
- [OpenAI — Usage API](https://platform.openai.com/docs/api-reference/usage)

---

## 0. 네 엔드포인트 한눈에 비교

**같은 모양의 제약이 두 벤더에 똑같이 있다** — 사용량은 시간 단위로 쪼갤 수 있지만
비용은 하루(UTC) 단위뿐이고, 비용을 키/프로젝트·모델로 나눌 수 없다.
그래서 KST 하루 비용은 두 벤더 모두 **단가 역산**으로 만든다 (`lib/token-rates.ts`).

| | Anthropic Usage | Anthropic Cost | OpenAI Usage | OpenAI Costs |
|---|---|---|---|---|
| 경로 | `/v1/organizations/usage_report/messages` | `/v1/organizations/cost_report` | `/v1/organization/usage/completions` | `/v1/organization/costs` |
| | 복수 organizations | 복수 | **단수** organization | **단수** |
| 인증 | `x-api-key` (Admin) | `x-api-key` (Admin) | `Authorization: Bearer` (Admin) | 같음 |
| 시각 표기 | ISO8601 문자열 | ISO8601 | **unix 초 정수** | **unix 초** |
| 비용 필드 | ❌ (토큰만) | ✅ `amount` — **센트 문자열** | ❌ (토큰만) | ✅ `amount.value` — **USD 실수** |
| 시간 단위 | 1m / 1h / **1d** | **1d 만** | 1m / 1h / 1d | **1d 만** |
| 모델별 비용 | — | ❌ (group_by 불가) | — | ❌ (line_item 뿐) |
| 키/프로젝트별 비용 | — | ❌ (workspace_id 뿐) | — | ✅ project_id |
| 페이지네이션 | 커서 `next_page` | 커서 | 커서 `next_page` | 커서 |
| 검증 | ✅ 2026-08-14 | ✅ | ⚠️ 미검증 | ⚠️ 미검증 |

⚠️ **가장 잘 틀리는 세 가지** (두 벤더를 나란히 만질 때):
> 1. 금액 단위가 **반대**다 — Anthropic 센트 문자열 / OpenAI USD 실수
> 2. 경로 단·복수가 다르다 — `organizations` / `organization`
> 3. OpenAI `input_tokens` 는 `input_cached_tokens` 를 **포함**한다.
>    Anthropic `uncached_input_tokens` 는 캐시를 **뺀** 값이다.
>    (`lib/adapters/openai.ts` 가 빼서 뜻을 맞춘다)

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

## 3. OpenAI — Usage / Costs

⚠️ **아래 전체가 미검증입니다.** 실 키가 생기면 `bash scripts/fetch_openai.sh` 로 원문을
떠서 `docs/openai-integration.md` 체크리스트를 지우고, 다른 부분을 여기 반영하세요.

### 요청

```
GET https://api.openai.com/v1/organization/usage/completions
  ?start_time=1787529600        # unix 초 (필수)
  &end_time=1787616000
  &bucket_width=1h              # 1m | 1h | 1d
  &group_by=model&group_by=project_id
  &limit=168
Authorization: Bearer sk-admin-...
```

```
GET https://api.openai.com/v1/organization/costs
  ?start_time=...&bucket_width=1d
  &group_by=line_item&group_by=project_id
  &limit=180                    # ⚠️ 기본값 7 — 그대로 두면 8일째부터 잘린다
```

### 응답 구조 (문서 기준)

```jsonc
{
  "object": "page",
  "data": [{
    "object": "bucket",
    "start_time": 1787529600,   // unix 초
    "end_time": 1787616000,
    "results": [{
      "object": "organization.usage.completions.result",
      "input_tokens": 10000000,        // ⚠️ input_cached_tokens 포함
      "input_cached_tokens": 4000000,
      "output_tokens": 1000000,
      "num_model_requests": 300,
      "project_id": "proj_...",
      "api_key_id": null,
      "model": "gpt-5"
    }]
  }],
  "has_more": false,
  "next_page": null
}
```

costs 의 결과 행:

```jsonc
{
  "object": "organization.costs.result",
  "amount": { "value": 12.5, "currency": "usd" },   // ⚠️ USD 실수. 100 으로 나누지 말 것
  "line_item": "gpt-5, output",                     // ⚠️ 실제 형식 미검증
  "project_id": "proj_..."
}
```

### 주의점

1. **`line_item` 형식이 파서의 전제다.** `lib/adapters/openai.ts` 의 `parseLineItem` 이
   `"모델명, 종류"` 로 가정하고 모델·토큰 종류를 뽑는다. 못 뽑으면 단가가 블렌디드
   하나로 떨어져 모델별 비용이 부정확해지는데, **화면에는 그럴듯한 숫자가 그대로 뜬다.**
   틀려도 티가 안 나므로 원문 확인이 반드시 필요하다.
2. **조직 전체 API 키를 나열하는 엔드포인트가 없다.** 프로젝트별로만 조회된다.
   그래서 보조 축이 API 키가 아니라 **프로젝트**다.
3. **보관된 프로젝트도 받아야 한다.** `include_archived=true` 를 빼면 과거 사용량 중
   보관된 프로젝트 몫이 통째로 "미등록" 으로 뜬다 (Anthropic 의 archived 키에서 실제로 겪은 문제).

---

## 4. 페이지네이션 정리

| 엔드포인트 | 방식 | 처리 |
|---|---|---|
| Anthropic usage/cost | 커서 | `has_more == true` 이면 `next_page` 를 `page` 로 재요청 |
| Anthropic api_keys | **after_id** | `last_id`(없으면 마지막 항목 id)를 `after_id` 로 재요청 |
| OpenAI usage/costs | 커서 | Anthropic 리포트와 같은 `has_more`/`next_page` |
| OpenAI projects | **after** | `last_id` 를 `after` 로 재요청 |

**두 벤더 모두 목록 엔드포인트만 방식이 다르다.** 리포트 코드를 복사해 목록에 쓰면
21번째 항목부터 조용히 사라진다. 구현은 `lib/clients/*.ts` 에 각각 있고,
스크립트 쪽은 `scripts/_json.py` 의 `page-info` / `keys-page-info` 로 갈린다.

`limit` 기본값도 함정이다 — Anthropic api_keys 는 20, OpenAI costs 는 7이다.
안 올리면 잘린 줄도 모른다.

---

## 5. 남은 검증 항목

Anthropic 은 2026-08-14 에 끝났습니다. 남은 것은 OpenAI 뿐이고,
순서와 확인 방법은 **`docs/openai-integration.md`** 에 있습니다.
