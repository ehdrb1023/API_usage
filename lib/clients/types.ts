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
   * ✅ 2026-08-14 실제 응답으로 검증 — **센트가 맞습니다.** usage_report 의 토큰 수와
   *    나눠 단가를 역산하면 /100 했을 때만 공시 단가와 정확히 일치합니다:
   *      claude-haiku-4-5  uncached input  2,919,015 tok / "291.9015" → $1.00/MTok
   *      claude-sonnet-5   uncached input  1,143,691 tok / "228.7382" → $2.00/MTok (인트로 단가)
   *      claude-sonnet-5   cache read      1,913,996 tok / "38.2799"  → $0.20/MTok (입력가의 10%)
   *      claude-opus-4-8   uncached input  2,268,678 tok / "1134.3390" → $5.00/MTok
   *    /100 을 빼면 각각 $100·$200·$500/MTok 이 되어 존재하지 않는 단가가 됩니다.
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

// ============================================================================
// Anthropic — List API Keys
// ============================================================================

/**
 * ✅ 2026-08-14 실제 응답으로 검증 — 31개 키 중 active 28 / archived 3.
 * `inactive` 는 문서에만 있고 이번 조직에는 없었습니다(값 자체는 유효).
 */
export type AnthropicApiKeyStatus = "active" | "inactive" | "archived";

export interface AnthropicApiKey {
  id: string;
  type: "api_key";
  /** 콘솔에서 붙인 이름. 조직 안에서 **유일하지 않습니다** (같은 이름의 키가 여럿 존재). */
  name: string;
  /** 기본 워크스페이스는 null. */
  workspace_id: string | null;
  created_at: string;
  created_by: { id: string; type: string };
  /** 예: "sk-ant-api03-hqL...kQAA". 이름이 겹칠 때 사람이 구분하는 용도. */
  partial_key_hint: string | null;
  /** 새 값이 추가될 수 있어 열어 둡니다. */
  status: AnthropicApiKeyStatus | (string & {});

  /**
   * ✅ 2026-08-14 실측 — 문서 스키마 예시에는 없지만 실제로 내려옵니다.
   * 만료 설정이 없으면 null.
   */
  expires_at?: string | null;
  principal?: unknown;
}

/**
 * ⚠️ usage/cost 리포트와 **페이지네이션 방식이 다릅니다.**
 * 리포트는 `page`/`next_page` 커서, 이쪽은 `after_id`/`before_id` + `last_id` 입니다.
 */
export interface AnthropicApiKeysResponse {
  data: AnthropicApiKey[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export interface AnthropicListApiKeysParams {
  /** 기본 20 / 최대 1000. */
  limit?: number;
  /** 이 id **다음** 페이지부터. 직전 응답의 `last_id` 를 넘깁니다. */
  after_id?: string;
  before_id?: string;
  status?: AnthropicApiKeyStatus;
  workspace_id?: string;
  created_by_user_id?: string;
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

/**
 * ✅ 2026-08-14 실제 응답으로 검증 — **FOCUS 표준 enum 이 아니라 Vercel 자체 분류**였습니다.
 *    문서의 "AI and Machine Learning" / "Compute" / "Storage" 같은 값은 하나도 오지 않고,
 *    아래 15종이 옵니다. 8,708건 중 8건은 이 필드가 아예 없습니다(구독 항목).
 *    새 값이 추가될 수 있으므로 `(string & {})` 로 열어 둡니다.
 */
export type VercelServiceCategory =
  | "AI Tokens"
  | "Build & Deploy"
  | "Content, Caching & Optimization"
  | "Flat Rate Hidden"
  | "KMS"
  | "Observability"
  | "Queues"
  | "Sandbox"
  | "Services"
  | "Subscription Licenses"
  | "VCR"
  | "Vercel Connect"
  | "Vercel Delivery Network"
  | "Vercel Functions"
  | "Web Application Firewall"
  | (string & {});

/**
 * FOCUS 스펙상 `Tags` 는 `additionalProperties: string` 인 자유 형식 맵이고,
 * 문서 설명에 "Vercel ProjectId / ProjectName 정보를 담는다" 고만 적혀 있습니다.
 *
 * ✅ 2026-08-14 실제 응답으로 검증 — 키 이름은 `ProjectId` / `ProjectName` 이 맞습니다.
 *    다만 **항상 오지는 않습니다**: 8,708건 중 2,108건(24%)은 `Tags` 가 `{}` 였고,
 *    이 몫이 프로젝트별 집계에서 "(프로젝트 미지정)" 으로 잡혀 비용 1위였습니다.
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
   * ✅ 2026-08-14 검증 — `PricingQuantity` 와 단위가 다른 정도가 아니라 **성격이 다릅니다**.
   *    `PricingUnit` 이 전부 `"USD"` 로 오고 `PricingQuantity` 는 금액(대부분 0)이었습니다.
   *    사용량은 `ConsumedQuantity` + `ConsumedUnit` 만 보면 됩니다.
   *    정수가 아닐 수 있습니다 (예: Edge Requests 4940.98 Requests — 일 경계 안분).
   */
  ConsumedQuantity: number | null;
  /**
   * ✅ 2026-08-14 실제 응답으로 검증 — 실제로 오는 값은 21종입니다:
   *    minute / hour / gigabyte / gigabyte-hour / gigabyte-month /
   *    Invocations / Requests / Execution Units / Reads / Writes / Operations /
   *    Units / Transformations / Creations / Events / Data Points / Traces /
   *    Projects / Seats / Credits, 그리고 구독 항목은 null.
   *    지표 매핑은 lib/adapters/vercel.ts 의 UNIT_TO_METRIC 참고.
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
