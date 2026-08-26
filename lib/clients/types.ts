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
  readonly vendor: "anthropic" | "openai" | "vercel" | "supabase";
  readonly status: number;
  /** 응답 본문 원문 (JSON 파싱 실패 대비해 문자열로 보관). */
  readonly body: string;
  /** 쿼리스트링까지 포함한 요청 URL. 키는 헤더로만 보내므로 여기 노출되지 않습니다. */
  readonly url: string;
  /**
   * 429 응답의 `retry-after` (초). 다시 두드려도 되는 시점을 알려면 이게 필요합니다.
   * 없으면 undefined — 헤더를 안 주는 벤더도 있습니다.
   *
   * ⚠️ Anthropic Admin API 의 usage_report / cost_report 는 **시간당 90회**입니다
   *    (2026-08-25 실측: `anthropic-ratelimit-requests-limit: 90`, 리셋 ~1시간).
   *    분당 1회로 폴링하면 60회/시간이라, 같은 조직 키로 도는 인스턴스가 둘이면
   *    바로 넘깁니다.
   */
  readonly retryAfterSeconds?: number;

  constructor(args: {
    vendor: "anthropic" | "openai" | "vercel" | "supabase";
    status: number;
    body: string;
    url: string;
    hint?: string;
    retryAfterSeconds?: number;
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
    this.retryAfterSeconds = args.retryAfterSeconds;
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

// ============================================================================
// Supabase — Management API
// ============================================================================

/**
 * 아래 타입은 **2026-08-25 에 받은 공식 OpenAPI 스펙**(`GET https://api.supabase.com/api/v1-json`,
 * 경로 115개)에서 그대로 옮겼습니다. 문서 페이지가 아니라 스펙 원본이라 필드명·enum 은
 * 정확하지만, **실제 응답으로는 아직 검증하지 못했습니다** (토큰이 없어서).
 * 첫 200 응답을 받으면 docs/api-clients-status.md 체크리스트를 갱신하세요.
 *
 * ⚠️ 가장 중요한 한계 — **금액(USD)을 주는 엔드포인트가 없습니다.**
 *    스펙 115개 경로 중 usage/billing/cost 계열은 아래가 전부이고, 그 어디에도
 *    "이번 달 얼마" 에 해당하는 값이 없습니다. 대시보드의 Usage & Billing 화면은
 *    공개 API 가 아닌 내부 `platform/` API 를 씁니다.
 *    따라서 이 서비스의 `costUsd` 는 **고정비 기반 추정치**입니다
 *    (lib/adapters/supabase.ts 의 주석 참고).
 */

/** `GET /v1/organizations` — 목록에는 plan 이 없습니다. plan 은 slug 단건 조회에만. */
export interface SupabaseOrganization {
  /** @deprecated slug 를 쓰세요. */
  id: string;
  slug: string;
  name: string;
}

/** `GET /v1/organizations/{slug}` — 목록 응답과 달리 `plan` 이 있습니다. */
export interface SupabaseOrganizationDetail extends SupabaseOrganization {
  plan?: "free" | "pro" | "team" | "enterprise" | "platform";
}

export type SupabaseProjectStatus =
  | "INACTIVE"
  | "ACTIVE_HEALTHY"
  | "ACTIVE_UNHEALTHY"
  | "COMING_UP"
  | "UNKNOWN"
  | "GOING_DOWN"
  | "INIT_FAILED"
  | "REMOVED"
  | "RESTORING"
  | "UPGRADING"
  | "PAUSING"
  | (string & {});

/** `GET /v1/projects` — 토큰이 접근 가능한 **모든 조직의** 프로젝트가 한 번에 옵니다. */
export interface SupabaseProject {
  /** 20자 프로젝트 ref. 다른 모든 엔드포인트의 경로 파라미터. */
  ref: string;
  name: string;
  organization_slug?: string;
  /** @deprecated organization_slug 를 쓰세요. */
  organization_id?: string;
  region: string;
  created_at: string;
  status: SupabaseProjectStatus;
}

/**
 * `GET /v1/projects/{ref}/analytics/endpoints/usage.api-counts?interval=1day`
 *
 * ⚠️ **from/to 파라미터가 없습니다.** `interval`(15min·30min·1hr·3hr·1day·3day·7day)만
 *    받고, 조회 구간은 API 가 정합니다. 즉 임의 과거 구간을 다시 불러올 수 없고
 *    "지금 기준 최근 N일" 만 볼 수 있습니다. 정확히 며칠치가 오는지는 실제 응답으로
 *    확인해야 합니다 (스펙에 명시가 없음).
 */
export type SupabaseUsageInterval =
  | "15min"
  | "30min"
  | "1hr"
  | "3hr"
  | "1day"
  | "3day"
  | "7day";

export interface SupabaseUsageApiCount {
  /** 버킷 시작 시각 (UTC). */
  timestamp: string;
  total_auth_requests: number;
  total_realtime_requests: number;
  total_rest_requests: number;
  total_storage_requests: number;
}

export interface SupabaseUsageApiCountResponse {
  result: SupabaseUsageApiCount[];
  error?: unknown;
}

/**
 * `GET /v1/projects/{ref}/billing/addons`
 *
 * ✅ 여기가 **유일하게 금액이 나오는 곳**입니다. `variant.price.amount` 에 실제
 *    단가가 들어 있어서 컴퓨트 인스턴스·PITR·IPv4 같은 고정비는 하드코딩 없이
 *    API 값 그대로 쓸 수 있습니다. 다만 조직 플랜 요금(Pro $25 등)은 여기 없습니다.
 */
export type SupabaseAddonType =
  | "custom_domain"
  | "compute_instance"
  | "pitr"
  | "ipv4"
  | "auth_mfa_phone"
  | "auth_mfa_web_authn"
  | "log_drain"
  | "etl_pipeline"
  | (string & {});

export interface SupabaseAddonPrice {
  description?: string;
  /** fixed = 정액, usage = 사용량 과금(금액을 여기서 알 수 없음). */
  type: "fixed" | "usage";
  interval: "monthly" | "hourly";
  amount: number;
}

export interface SupabaseAddonVariant {
  /** 예: "ci_micro", "pitr_7", "ipv4_default". */
  id: string;
  name: string;
  price?: SupabaseAddonPrice;
}

export interface SupabaseSelectedAddon {
  type: SupabaseAddonType;
  variant: SupabaseAddonVariant;
}

export interface SupabaseAddonsResponse {
  selected_addons: SupabaseSelectedAddon[];
  available_addons?: unknown[];
}

/** Supabase 표준 에러 봉투. */
export interface SupabaseErrorResponse {
  message?: string;
  error?: string;
  /** 일부 엔드포인트는 이 형태로 옵니다. */
  msg?: string;
}

// ============================================================================
// OpenAI — Admin 사용량 / 비용
// ============================================================================
//
// ⚠️⚠️ 이 블록 전체가 **공개 문서 기준이고 실응답으로 검증되지 않았습니다.**
//      실 키가 생기면 docs/openai-integration.md 의 순서대로 확인하세요.
//
// Anthropic 과 헷갈리기 쉬운 차이 세 가지:
//   1. 경로가 **단수** — /v1/organization/… (Anthropic 은 organizations)
//   2. 시각이 **unix 초 정수** — start_time=1756080000 (Anthropic 은 ISO 문자열)
//   3. 금액이 **USD 실수** — amount.value (Anthropic 은 센트 문자열)

/** usage/completions 는 세 해상도를 다 지원한다 (Anthropic 과 같다). */
export type OpenAiBucketWidth = "1m" | "1h" | "1d";

/** costs 는 **1d 뿐**이다. 그래서 KST 하루 비용은 단가 역산이 필요하다. */
export type OpenAiCostBucketWidth = "1d";

export type OpenAiUsageGroupBy =
  | "project_id"
  | "user_id"
  | "api_key_id"
  | "model"
  | "batch";

/** ⚠️ costs 는 model 로 group_by 할 수 없다. Anthropic cost_report 와 같은 제약. */
export type OpenAiCostGroupBy = "project_id" | "line_item";

export interface OpenAiPage<TBucket> {
  object: "page";
  data: TBucket[];
  has_more: boolean;
  /** 다음 페이지 커서. `page` 파라미터로 되돌려 보낸다. */
  next_page: string | null;
}

export interface OpenAiUsageResult {
  object: "organization.usage.completions.result";
  /** ⚠️ `input_cached_tokens` 를 **포함한** 총 입력. 어댑터에서 빼서 정규화한다. */
  input_tokens: number;
  input_cached_tokens?: number;
  output_tokens: number;
  num_model_requests?: number;
  project_id?: string | null;
  user_id?: string | null;
  api_key_id?: string | null;
  model?: string | null;
  batch?: boolean | null;
}

export interface OpenAiUsageBucket {
  object: "bucket";
  /** unix 초. */
  start_time: number;
  end_time: number;
  results: OpenAiUsageResult[];
}

export type OpenAiUsageResponse = OpenAiPage<OpenAiUsageBucket>;

export interface OpenAiUsageParams {
  /** unix 초. **필수.** */
  start_time: number;
  end_time?: number;
  bucket_width?: OpenAiBucketWidth;
  group_by?: OpenAiUsageGroupBy[];
  project_ids?: string[];
  api_key_ids?: string[];
  models?: string[];
  /** 버킷 개수. 1h 는 최대 168(=7일)로 알려져 있으나 ⚠️ 미검증. */
  limit?: number;
  page?: string;
}

export interface OpenAiCostAmount {
  /** ⚠️ **USD 실수.** 100 으로 나누지 말 것. */
  value: number;
  currency: string;
}

export interface OpenAiCostResult {
  object: "organization.costs.result";
  amount: OpenAiCostAmount;
  /** 예: "gpt-4o-2024-08-06, input". ⚠️ 실제 형식 미검증. */
  line_item?: string | null;
  project_id?: string | null;
}

export interface OpenAiCostBucket {
  object: "bucket";
  start_time: number;
  end_time: number;
  results: OpenAiCostResult[];
}

export type OpenAiCostsResponse = OpenAiPage<OpenAiCostBucket>;

export interface OpenAiCostsParams {
  start_time: number;
  end_time?: number;
  bucket_width?: OpenAiCostBucketWidth;
  group_by?: OpenAiCostGroupBy[];
  project_ids?: string[];
  /** ⚠️ 기본 7 / 최대 180 으로 알려져 있다. 기본값이면 8일째부터 조용히 잘린다. */
  limit?: number;
  page?: string;
}

export type OpenAiProjectStatus = "active" | "archived";

export interface OpenAiProject {
  id: string;
  object: "organization.project";
  name: string;
  created_at: number;
  archived_at?: number | null;
  status: OpenAiProjectStatus;
}

export interface OpenAiProjectsResponse {
  object: "list";
  data: OpenAiProject[];
  first_id?: string | null;
  last_id?: string | null;
  has_more: boolean;
}

/** ⚠️ 프로젝트 목록은 리포트와 **페이지네이션 방식이 다르다** (after + limit). */
export interface OpenAiListProjectsParams {
  limit?: number;
  after?: string;
  /** 보관된 프로젝트도 포함할지. 과거 사용량에는 보관된 프로젝트도 나온다. */
  include_archived?: boolean;
}

/** OpenAI 표준 에러 봉투. */
export interface OpenAiErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}
