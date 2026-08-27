/**
 * AI API 벤더의 **요청·응답 타입**. 이 대시보드는 AI API 비용만 다룬다.
 *
 * 출처:
 *  Anthropic (2026-08-14 실키로 검증 완료)
 *   - GET /v1/organizations/usage_report/messages
 *     https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-messages-usage-report
 *   - GET /v1/organizations/cost_report
 *     https://platform.claude.com/docs/en/api/admin-api/usage-cost/get-cost-report
 *   - GET /v1/organizations/api_keys
 *
 *  OpenAI (⚠️ **공개 문서 기준 · 실응답 미검증**)
 *   - GET /v1/organization/usage/completions
 *   - GET /v1/organization/costs
 *   - GET /v1/organization/projects
 *     https://platform.openai.com/docs/api-reference/usage
 *
 * ⚠️ 로 표시된 항목은 **문서에는 있으나 실제 응답으로 아직 검증하지 못한 부분**입니다.
 *    Anthropic 은 docs/api-clients-status.md, OpenAI 는 docs/openai-integration.md
 *    체크리스트를 따라 하나씩 지워 주세요.
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
  readonly vendor: "anthropic" | "openai";
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
    vendor: "anthropic" | "openai";
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
  /** ✅ 2026-08-27 실측: `input_cached_tokens` 를 **포함한** 총 입력이 맞다. */
  input_tokens: number;
  input_cached_tokens?: number;
  /**
   * ✅ 실측 확인 — 캐시를 뺀 입력을 **벤더가 직접 준다.**
   * `input_tokens - input_cached_tokens` 와 값이 같다 (27444-8448=18996).
   * 직접 빼는 것보다 이 값을 쓰는 편이 안전하다.
   */
  input_uncached_tokens?: number;
  /** 캐시 **생성**. 캐시 읽기(`input_cached_tokens`)와 단가가 다르다. */
  input_cache_write_tokens?: number;
  output_tokens: number;
  num_model_requests?: number;

  /**
   * ── 모달리티별 내역 ──────────────────────────────────────────────────
   * ⚠️ **입력 쪽 모달리티 필드는 캐시를 제외한 값이다** (2026-08-27 실측:
   *    gpt-5.6-terra 가 input 27444 / cached 8448 인데 text+image+audio 합이
   *    18996 = uncached 와 일치). 캐시분은 `input_cached_*_tokens` 에 따로 있다.
   *
   * costs 의 `line_item` 이 "gpt-image-1 image, output" 처럼 모달리티까지 나눠서
   * 오기 때문에, 단가를 제대로 붙이려면 사용량도 같은 축으로 쪼개야 한다.
   */
  input_text_tokens?: number;
  input_image_tokens?: number;
  input_audio_tokens?: number;
  input_cached_text_tokens?: number;
  input_cached_image_tokens?: number;
  input_cached_audio_tokens?: number;
  output_text_tokens?: number;
  output_image_tokens?: number;
  output_audio_tokens?: number;
  service_tier?: string | null;
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
  /**
   * ✅ 2026-08-27 실측 형식: `"<모델>[ <모달리티>], <방향>"`
   *
   *   "gpt-5.6-terra, output"                  모달리티 없음(텍스트 전용 모델)
   *   "gpt-5.6-terra, cached input"            캐시 읽기
   *   "gpt-5.6-terra, cache writes"            캐시 **생성** — 단가가 다르다
   *   "gpt-image-1 image, output"              모달리티가 모델명 뒤에 붙는다
   *   "gpt-image-2-2026-04-21 text, input"     날짜가 붙기도 한다
   *   "whisper"                                쉼표 없음 + quantity_unit 이 초 단위
   */
  line_item?: string | null;
  project_id?: string | null;
  /** ✅ 문서에 없지만 `group_by=api_key_id` 가 실제로 동작한다 (2026-08-27 실측). */
  api_key_id?: string | null;
  /**
   * ✅ 실측 확인 — **과금 수량을 같이 준다.** 단가 = amount.value / quantity 로
   * 바로 나오므로 역산 정확도가 크게 올라간다.
   */
  quantity?: number;
  /** "tokens" | "duration_seconds" … ⚠️ 토큰이 아닌 항목이 섞여 온다 (whisper). */
  quantity_unit?: string | null;
  project_name?: string | null;
  organization_id?: string | null;
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

/**
 * GET /v1/organization/projects/{project_id}/api_keys 의 한 건.
 *
 * ⚠️ OpenAI 는 **조직 전체 API 키를 한 번에 주는 엔드포인트가 없다.** 프로젝트를
 *    먼저 나열하고 프로젝트마다 이 경로를 다시 두드려야 전체 키 이름이 모인다.
 *    (Anthropic 은 `/v1/organizations/api_keys` 하나로 끝난다 — 다른 점이다.)
 */
export interface OpenAiProjectApiKey {
  object: "organization.project.api_key";
  id: string;
  name: string | null;
  /** 예: "sk-...def". 마스킹된 값이라 화면에 띄워도 된다. */
  redacted_value?: string | null;
  created_at: number;
  owner?: {
    type?: string;
    user?: { id?: string; name?: string } | null;
    service_account?: { id?: string; name?: string } | null;
  } | null;
}

export interface OpenAiProjectApiKeysResponse {
  object: "list";
  data: OpenAiProjectApiKey[];
  first_id?: string | null;
  last_id?: string | null;
  has_more: boolean;
}

/** 프로젝트 목록과 같은 after + limit 방식이다. */
export interface OpenAiListProjectApiKeysParams {
  limit?: number;
  after?: string;
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
