/**
 * Anthropic Admin API / Vercel Billing API 의 **요청·응답 타입**.
 *
 * 출처 (2026-08-14 기준 공식 레퍼런스):
 *  - GET /v1/organizations/usage_report/messages
 *    https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-messages-usage-report
 *  - GET /v1/organizations/cost_report
 *    https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-cost-report
 *  - GET /v1/billing/charges  (FOCUS v1.3)
 *    https://vercel.com/docs/rest-api/billing/list-focus-billing-charges
 *    https://vercel.com/changelog/access-billing-usage-cost-data-api  (2026-02-19 공개)
 *
 * ⚠️ 로 표시된 항목은 **문서에는 있으나 실제 응답으로 아직 검증하지 못한 부분**입니다.
 *    키를 넣고 첫 200 응답을 받은 뒤 docs/api-clients-status.md 체크리스트를 따라
 *    하나씩 지워 주세요.
 */

// ============================================================================
// 공통 에러
// ============================================================================

/** 키·설정이 없어서 **요청을 보내기도 전에** 실패한 경우. */
export class MissingCredentialError extends Error {
  readonly envVar: string;

  constructor(envVar: string, message: string) {
    super(message);
    this.name = "MissingCredentialError";
    this.envVar = envVar;
  }
}

/** 요청은 나갔지만 2xx 가 아닌 응답이 온 경우. */
export class ApiClientError extends Error {
  readonly vendor: "anthropic" | "vercel";
  readonly status: number;
  /** 응답 본문 원문 (JSON 파싱 실패 대비해 문자열로 보관). */
  readonly body: string;
  /** 쿼리스트링까지 포함한 요청 URL. 키는 헤더로만 보내므로 여기 노출되지 않습니다. */
  readonly url: string;

  constructor(args: {
    vendor: "anthropic" | "vercel";
    status: number;
    body: string;
    url: string;
    hint?: string;
  }) {
    const hint = args.hint ? `\n힌트: ${args.hint}` : "";
    super(
      `${args.vendor} API 호출 실패 (HTTP ${args.status}) — ${args.url}\n` +
        `응답: ${args.body.slice(0, 500)}${hint}`,
    );
    this.name = "ApiClientError";
    this.vendor = args.vendor;
    this.status = args.status;
    this.body = args.body;
    this.url = args.url;
  }
}

/** 테스트에서 갈아끼울 수 있도록 fetch 를 좁게 타이핑. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

// ============================================================================
// Anthropic — 공통 enum
// ============================================================================

export type AnthropicContextWindow = "0-200k" | "200k-1M";

export type AnthropicInferenceGeo = "global" | "us" | "not_available";

/** usage_report 쪽 티어. cost_report 는 standard/batch 두 개뿐이라 별도 타입. */
export type AnthropicServiceTier =
  | "standard"
  | "batch"
  | "flex"
  | "flex_discount"
  | "priority"
  | "priority_on_demand";

/** `speeds` 필터·`group_by=speed` 는 `fast-mode-2026-02-01` 베타 헤더 필요. */
export type AnthropicSpeed = "fast" | "standard";

export type AnthropicUsageBucketWidth = "1d" | "1h" | "1m";

export type AnthropicUsageGroupBy =
  | "account_id"
  | "api_key_id"
  | "context_window"
  | "inference_geo"
  | "model"
  | "service_account_id"
  | "service_tier"
  | "speed"
  | "workspace_id";

/** cost_report 는 group_by 선택지가 두 개뿐입니다 (usage_report 와 다름). */
export type AnthropicCostGroupBy = "description" | "workspace_id";

/** 두 리포트가 공유하는 페이지네이션 봉투. */
export interface AnthropicPaginatedReport<TBucket> {
  /** 오래된 버킷부터. 사용량이 0인 구간도 `results: []` 로 포함됩니다. */
  data: TBucket[];
  has_more: boolean;
  /** `has_more === false` 면 null. 다음 요청의 `page` 파라미터로 넘깁니다. */
  next_page: string | null;
}

// ============================================================================
// Anthropic — Messages Usage Report
// ============================================================================

export interface AnthropicCacheCreation {
  ephemeral_5m_input_tokens: number;
  ephemeral_1h_input_tokens: number;
}

export interface AnthropicServerToolUse {
  /** 토큰이 아니라 **요청 건수**입니다. 토큰 합계에 더하면 안 됩니다. */
  web_search_requests: number;
}

/**
 * 버킷 하나 안의 사용량 한 줄.
 *
 * `group_by[]` 로 지정하지 않은 축은 전부 `null` 로 오고, 결과가 한 줄로 뭉칩니다.
 * 지정한 축의 조합 수만큼 줄이 늘어납니다.
 *
 * ⚠️ 단일 `total_tokens` 필드는 **없습니다.** 총 토큰은 직접 합산해야 합니다:
 *    uncached_input_tokens
 *  + cache_creation.ephemeral_5m_input_tokens
 *  + cache_creation.ephemeral_1h_input_tokens
 *  + cache_read_input_tokens
 *  + output_tokens
 */
export interface AnthropicUsageResult {
  uncached_input_tokens: number;
  cache_creation: AnthropicCacheCreation;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use: AnthropicServerToolUse;

  /** `group_by[]=model` 없으면 null. */
  model: string | null;
  /** Console(웹)에서 쓴 사용분은 null. */
  api_key_id: string | null;
  /** 기본 워크스페이스는 null. */
  workspace_id: string | null;
  /** 비-OAuth 요청은 null. */
  account_id: string | null;
  /** 비-OIDC-federation 요청은 null. */
  service_account_id: string | null;
  service_tier: AnthropicServiceTier | null;
  context_window: AnthropicContextWindow | null;
  inference_geo: AnthropicInferenceGeo | null;

  /**
   * ⚠️ 실제 응답으로 검증 필요 — `group_by[]=speed` 는 문서의 group_by 목록에는
   * 있지만 응답 스키마 예시에는 이 필드가 나오지 않습니다. 베타 헤더
   * `fast-mode-2026-02-01` 를 붙여 호출해 보고, 키가 실제로 오는지 확인할 것.
   */
  speed?: AnthropicSpeed | null;
}

export interface AnthropicUsageBucket {
  /** 포함(inclusive), RFC 3339. */
  starting_at: string;
  /** 제외(exclusive), RFC 3339. */
  ending_at: string;
  results: AnthropicUsageResult[];
}

export type AnthropicUsageReportResponse =
  AnthropicPaginatedReport<AnthropicUsageBucket>;

export interface AnthropicUsageReportParams {
  /** 필수. RFC 3339. UTC 기준 분/시/일 시작점으로 스냅됩니다. */
  starting_at: string;
  ending_at?: string;
  bucket_width?: AnthropicUsageBucketWidth;
  /** 1d: 기본 7 / 최대 31, 1h: 기본 24 / 최대 168, 1m: 기본 60 / 최대 1440. */
  limit?: number;
  /** 이전 응답의 `next_page`. */
  page?: string;
  group_by?: AnthropicUsageGroupBy[];
  models?: string[];
  api_key_ids?: string[];
  workspace_ids?: string[];
  account_ids?: string[];
  service_account_ids?: string[];
  service_tiers?: AnthropicServiceTier[];
  context_window?: AnthropicContextWindow[];
  inference_geos?: AnthropicInferenceGeo[];
  /** `fast-mode-2026-02-01` 베타 헤더 필요. */
  speeds?: AnthropicSpeed[];
}

// ============================================================================
// Anthropic — Cost Report
// ============================================================================

export type AnthropicCostType =
  | "tokens"
  | "web_search"
  | "code_execution"
  | "session_usage";

export type AnthropicTokenType =
  | "uncached_input_tokens"
  | "output_tokens"
  | "cache_read_input_tokens"
  | "cache_creation.ephemeral_5m_input_tokens"
  | "cache_creation.ephemeral_1h_input_tokens";

/** cost_report 의 티어는 usage_report 보다 좁습니다. */
export type AnthropicCostServiceTier = "standard" | "batch";

export interface AnthropicCostResult {
  /**
   * ⚠️ 가장 흔한 함정 — **숫자가 아니라 문자열**, **달러가 아니라 최소 통화 단위(센트)** 입니다.
   *    "123.45" === $1.2345.  100 으로 나누지 않으면 금액이 100배가 됩니다.
   *    `centsStringToUsd()` (lib/clients/anthropic.ts) 를 쓰세요.
   *
   * ⚠️ 실제 응답으로 검증 필요 — 센트 단위라는 점은 문서 기준입니다.
   *    첫 호출 뒤 Console 청구 화면 금액과 반드시 대조할 것.
   */
  amount: string;
  /** 현재 항상 "USD". */
  currency: string;

  /** `group_by[]=description` 없으면 null. */
  cost_type: AnthropicCostType | null;
  /** 예: "Claude Sonnet 4 Usage - Input Tokens". group_by 없으면 null. */
  description: string | null;
  /** 비-토큰 비용이거나 group_by=description 이 없으면 null. */
  token_type: AnthropicTokenType | null;
  model: string | null;
  service_tier: AnthropicCostServiceTier | null;
  context_window: AnthropicContextWindow | null;
  inference_geo: AnthropicInferenceGeo | null;
  /** 기본 워크스페이스는 null. */
  workspace_id: string | null;
}

export interface AnthropicCostBucket {
  starting_at: string;
  ending_at: string;
  results: AnthropicCostResult[];
}

export type AnthropicCostReportResponse =
  AnthropicPaginatedReport<AnthropicCostBucket>;

export interface AnthropicCostReportParams {
  /** 필수. RFC 3339. */
  starting_at: string;
  ending_at?: string;
  /** usage_report 와 달리 `1d` 만 지원합니다. */
  bucket_width?: "1d";
  limit?: number;
  page?: string;
  group_by?: AnthropicCostGroupBy[];
}

/** Anthropic 표준 에러 봉투. */
export interface AnthropicErrorResponse {
  type: "error";
  error: {
    type: string;
    message: string;
  };
  request_id?: string;
}

// ============================================================================
// Vercel — FOCUS v1.3 billing charges
// ============================================================================

export type VercelChargeCategory =
  | "Usage"
  | "Purchase"
  | "Credit"
  | "Adjustment"
  | "Tax";

export type VercelPricingCategory =
  | "Standard"
  | "Committed"
  | "Dynamic"
  | "Other";

export type VercelServiceCategory =
  | "AI and Machine Learning"
  | "Analytics"
  | "Business Applications"
  | "Compute"
  | "Databases"
  | "Developer Tools"
  | "Identity"
  | "Integration"
  | "Internet of Things"
  | "Management and Governance"
  | "Media"
  | "Migration"
  | "Mobile"
  | "Multicloud"
  | "Networking"
  | "Other"
  | "Security"
  | "Storage"
  | "Web";

/**
 * FOCUS 스펙상 `Tags` 는 `additionalProperties: string` 인 자유 형식 맵이고,
 * 문서 설명에 "Vercel ProjectId / ProjectName 정보를 담는다" 고만 적혀 있습니다.
 *
 * ⚠️ 실제 응답으로 검증 필요 — 키 이름이 정확히 `ProjectId` / `ProjectName` 인지,
 *    그리고 항상 존재하는지(팀·플랜에 따라 빠질 수 있음)를 확인할 것.
 *    프로젝트별 비용 집계는 최상위 필드가 아니라 이 중첩 경로를 씁니다.
 */
export interface VercelChargeTags {
  ProjectId?: string;
  ProjectName?: string;
  [key: string]: string | undefined;
}

/**
 * JSONL 한 줄 = charge 한 건.
 *
 * FOCUS v1.3 필수 필드(문서의 `required` 배열)는 non-optional 로,
 * 그 외는 optional 로 두었습니다.
 */
export interface VercelFocusCharge {
  /** 청구서의 기준이 되는 금액 (USD). "실제 지불액" 패널은 이 필드. */
  BilledCost: number;
  /** 할인·선결제 크레딧 상각을 반영한 상각 원가 (USD). FinOps 관점의 실질 원가. */
  EffectiveCost: number;
  /** ISO 4217. 현재 "USD" 고정. */
  BillingCurrency: "USD";
  PricingCurrency: "USD";

  ChargeCategory: VercelChargeCategory;
  /** 포함(inclusive), ISO 8601 UTC. */
  ChargePeriodStart: string;
  /** 제외(exclusive), ISO 8601 UTC. */
  ChargePeriodEnd: string;

  /**
   * 소비량. 측정 가능한 소비가 없는 charge 는 null.
   *
   * ⚠️ `PricingQuantity` 와 **단위가 다릅니다** (예: 250,000 requests vs
   *    0.25 million requests). 사용량 그래프는 어느 쪽으로 통일할지 먼저 정할 것.
   */
  ConsumedQuantity: number | null;
  /**
   * ⚠️ 실제 응답으로 검증 필요 — 실제로 오는 단위 문자열 목록(build-minutes,
   *    invocations, GB-hours …)이 문서에 열거되어 있지 않습니다. 값 목록을 수집해
   *    docs/api-response-notes.md 에 적어 둘 것.
   */
  ConsumedUnit: string | null;

  PricingQuantity: number;
  PricingUnit: string;
  PricingCategory: VercelPricingCategory;

  /** 예: "Fluid Compute", "Edge Requests". */
  ServiceName: string;
  ServiceProviderName: string;
  /** 스펙상 required 가 아님 — 없을 수 있습니다. */
  ServiceCategory?: VercelServiceCategory;

  /** 스펙상 required 가 아님. 예: "icn1". */
  RegionId?: string;
  /** 스펙상 required 가 아님. 예: "Seoul". */
  RegionName?: string;

  Tags: VercelChargeTags;
}

export interface VercelBillingChargesParams {
  /** 필수. 포함(inclusive), ISO 8601 UTC. */
  from: string;
  /** 필수. 제외(exclusive), ISO 8601 UTC. 최대 조회 범위는 1년. */
  to: string;
  /** 팀 스코프. 없으면 토큰의 개인 스코프로 조회됩니다. */
  teamId?: string;
  /** `teamId` 대신 팀 slug 로도 지정 가능. 둘 다 주면 둘 다 전송됩니다. */
  slug?: string;
}
