/**
 * Anthropic Admin API 클라이언트 — 조직 단위 토큰 사용량 / 비용.
 *
 *   GET /v1/organizations/usage_report/messages   토큰 수 (비용 없음)
 *   GET /v1/organizations/cost_report             비용 (토큰 수 없음)
 *
 * 인증: `x-api-key: <Admin 키>` + `anthropic-version` 헤더.
 *   ⚠️ 반드시 **Admin 키**(`sk-ant-admin...`)여야 합니다.
 *      일반 API 키(`sk-ant-api...`)로는 401/403 이 납니다.
 *      Console → Settings → Admin keys (조직 Owner 권한 필요)
 *
 * 아직 실제 키가 없어도 import 는 안전합니다. 키 검사는 **함수 호출 시점**에만
 * 일어나고, 없으면 무엇을 어디에 넣어야 하는지 알려주는 에러를 던집니다.
 */

import {
  ApiClientError,
  MissingCredentialError,
  type AnthropicApiKey,
  type AnthropicApiKeysResponse,
  type AnthropicCostBucket,
  type AnthropicCostReportParams,
  type AnthropicCostReportResponse,
  type AnthropicListApiKeysParams,
  type AnthropicUsageBucket,
  type AnthropicUsageReportParams,
  type AnthropicUsageReportResponse,
  type FetchLike,
} from "./types";

export const ANTHROPIC_USAGE_REPORT_PATH =
  "/v1/organizations/usage_report/messages";
export const ANTHROPIC_COST_REPORT_PATH = "/v1/organizations/cost_report";
export const ANTHROPIC_API_KEYS_PATH = "/v1/organizations/api_keys";

export const DEFAULT_ANTHROPIC_API_BASE = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_API_VERSION = "2023-06-01";

/** 커서 루프가 폭주하지 않도록 하는 안전장치. 1d 기준 31버킷 × 50 = 4년치. */
const MAX_PAGES = 50;

export interface AnthropicClientOptions {
  /** 없으면 `process.env.ANTHROPIC_ADMIN_KEY`. */
  adminKey?: string;
  /** 없으면 `process.env.ANTHROPIC_API_VERSION` → "2023-06-01". */
  apiVersion?: string;
  /** 없으면 `process.env.ANTHROPIC_API_BASE` → "https://api.anthropic.com". */
  baseUrl?: string;
  /** 베타 헤더. 예: ["fast-mode-2026-02-01"] (group_by=speed 에 필요). */
  betas?: string[];
  /** 테스트에서 목 응답을 주입할 때 사용. 기본은 전역 fetch. */
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** `.env.example` 의 자리표시자(sk-ant-admin01-xxxxxxxx…)를 진짜 키로 오인하지 않도록. */
const PLACEHOLDER_PATTERN = /x{8,}/i;

interface ResolvedAnthropicConfig {
  adminKey: string;
  apiVersion: string;
  baseUrl: string;
  betas: string[];
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

/**
 * 환경변수 → 설정. 키가 없거나 자리표시자 그대로면 여기서 끊습니다.
 * export 되어 있으므로 "지금 호출 가능한 상태인지"만 미리 확인할 수도 있습니다.
 */
export function resolveAnthropicConfig(
  options: AnthropicClientOptions = {},
): ResolvedAnthropicConfig {
  const adminKey = (options.adminKey ?? process.env.ANTHROPIC_ADMIN_KEY ?? "").trim();

  if (!adminKey) {
    throw new MissingCredentialError(
      "ANTHROPIC_ADMIN_KEY",
      "ANTHROPIC_ADMIN_KEY가 .env에 없습니다. " +
        "Console → Settings → Admin keys 에서 조직 Owner 권한으로 Admin 키(sk-ant-admin...)를 발급해 " +
        "`.env` 에 ANTHROPIC_ADMIN_KEY=... 로 넣어 주세요. " +
        "(.env.example 참고 / 일반 API 키 sk-ant-api... 로는 호출되지 않습니다)",
    );
  }

  if (PLACEHOLDER_PATTERN.test(adminKey)) {
    throw new MissingCredentialError(
      "ANTHROPIC_ADMIN_KEY",
      "ANTHROPIC_ADMIN_KEY가 .env.example 의 자리표시자 값 그대로입니다. " +
        "실제 Admin 키로 바꿔 주세요.",
    );
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new MissingCredentialError(
      "fetch",
      "전역 fetch를 찾을 수 없습니다. Node 18+ 에서 실행하거나 options.fetch 를 넘겨 주세요.",
    );
  }

  return {
    adminKey,
    apiVersion:
      options.apiVersion ??
      process.env.ANTHROPIC_API_VERSION ??
      DEFAULT_ANTHROPIC_API_VERSION,
    baseUrl:
      options.baseUrl ?? process.env.ANTHROPIC_API_BASE ?? DEFAULT_ANTHROPIC_API_BASE,
    betas: options.betas ?? [],
    fetchImpl,
    signal: options.signal,
  };
}

function buildHeaders(config: ResolvedAnthropicConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": config.adminKey,
    "anthropic-version": config.apiVersion,
    accept: "application/json",
  };
  if (config.betas.length > 0) {
    headers["anthropic-beta"] = config.betas.join(",");
  }
  return headers;
}

/**
 * 쿼리스트링 조립.
 *
 * ✅ 2026-08-14 실제 응답으로 검증 — 대괄호 접미사(`group_by[]=model`) 형태가 정상 동작합니다.
 *    usage_report 185행 전부 `model` / `api_key_id` 가 채워져 왔고, cost_report 415행도
 *    `description` 이 채워져 왔습니다. `[]` 를 뗄 필요 없습니다.
 */
function buildQuery(params: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        query.append(`${key}[]`, String(item));
      }
      continue;
    }

    query.set(key, String(value));
  }

  return query;
}

function hintForStatus(status: number): string | undefined {
  if (status === 401) {
    return "키가 유효하지 않습니다. 일반 API 키(sk-ant-api...)가 아니라 Admin 키(sk-ant-admin...)인지 확인하세요.";
  }
  if (status === 403) {
    return "키는 유효하지만 조직 사용량/비용 조회 권한이 없습니다. 조직 Owner 권한으로 발급한 Admin 키가 필요합니다.";
  }
  if (status === 429) {
    return "레이트리밋입니다. 잠시 후 재시도하거나 조회 구간을 좁히세요.";
  }
  return undefined;
}

async function getJson<T>(
  path: string,
  params: Record<string, unknown>,
  config: ResolvedAnthropicConfig,
): Promise<T> {
  const url = new URL(path, config.baseUrl);
  url.search = buildQuery(params).toString();

  const response = await config.fetchImpl(url, {
    method: "GET",
    headers: buildHeaders(config),
    signal: config.signal,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new ApiClientError({
      vendor: "anthropic",
      status: response.status,
      body: await response.text().catch(() => "<본문 읽기 실패>"),
      url: url.toString(),
      hint: hintForStatus(response.status),
    });
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------- 단일 페이지

/**
 * GET /v1/organizations/usage_report/messages — 한 페이지.
 *
 * `bucket_width=1d` 기준 한 페이지에 최대 31버킷이므로 30일 조회는 보통 1페이지,
 * 90일 조회는 반드시 여러 페이지가 됩니다. 전 구간이 필요하면
 * `fetchAllAnthropicUsageBuckets()` 를 쓰세요.
 */
export async function fetchAnthropicUsageReport(
  params: AnthropicUsageReportParams,
  options: AnthropicClientOptions = {},
): Promise<AnthropicUsageReportResponse> {
  const config = resolveAnthropicConfig(options);
  return getJson<AnthropicUsageReportResponse>(
    ANTHROPIC_USAGE_REPORT_PATH,
    { ...params },
    config,
  );
}

/** GET /v1/organizations/cost_report — 한 페이지. */
export async function fetchAnthropicCostReport(
  params: AnthropicCostReportParams,
  options: AnthropicClientOptions = {},
): Promise<AnthropicCostReportResponse> {
  const config = resolveAnthropicConfig(options);
  return getJson<AnthropicCostReportResponse>(
    ANTHROPIC_COST_REPORT_PATH,
    { ...params },
    config,
  );
}

// ---------------------------------------------------------------- 전체 페이지

async function collectAll<TBucket>(
  path: string,
  params: Record<string, unknown>,
  config: ResolvedAnthropicConfig,
): Promise<TBucket[]> {
  const buckets: TBucket[] = [];
  let page: string | undefined = params.page as string | undefined;

  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await getJson<{
      data: TBucket[];
      has_more: boolean;
      next_page: string | null;
    }>(path, { ...params, page }, config);

    buckets.push(...(body.data ?? []));

    if (!body.has_more || !body.next_page) return buckets;
    page = body.next_page;
  }

  throw new Error(
    `Anthropic ${path}: 페이지가 ${MAX_PAGES}개를 넘었습니다. ` +
      `조회 구간(starting_at/ending_at)을 좁히세요.`,
  );
}

/** usage_report 를 커서 페이지네이션으로 끝까지 긁어 버킷 배열로 합칩니다. */
export async function fetchAllAnthropicUsageBuckets(
  params: AnthropicUsageReportParams,
  options: AnthropicClientOptions = {},
): Promise<AnthropicUsageBucket[]> {
  const config = resolveAnthropicConfig(options);
  return collectAll<AnthropicUsageBucket>(
    ANTHROPIC_USAGE_REPORT_PATH,
    { ...params },
    config,
  );
}

/** cost_report 를 커서 페이지네이션으로 끝까지 긁어 버킷 배열로 합칩니다. */
export async function fetchAllAnthropicCostBuckets(
  params: AnthropicCostReportParams,
  options: AnthropicClientOptions = {},
): Promise<AnthropicCostBucket[]> {
  const config = resolveAnthropicConfig(options);
  return collectAll<AnthropicCostBucket>(
    ANTHROPIC_COST_REPORT_PATH,
    { ...params },
    config,
  );
}

// ---------------------------------------------------------------- API 키 목록

/** api_keys 는 기본 20건이라 그대로 두면 조용히 잘립니다. 페이지당 최대치 근처로 올려 둡니다. */
const API_KEYS_PAGE_LIMIT = 100;

/**
 * GET /v1/organizations/api_keys — 한 페이지.
 *
 * ⚠️ 리포트 두 개와 **페이지네이션 방식이 다릅니다.** `page`/`next_page` 커서가 아니라
 *    `after_id` + `last_id` 입니다. 전체가 필요하면 `fetchAllAnthropicApiKeys()` 를 쓰세요.
 */
export async function fetchAnthropicApiKeys(
  params: AnthropicListApiKeysParams = {},
  options: AnthropicClientOptions = {},
): Promise<AnthropicApiKeysResponse> {
  const config = resolveAnthropicConfig(options);
  return getJson<AnthropicApiKeysResponse>(
    ANTHROPIC_API_KEYS_PATH,
    { ...params },
    config,
  );
}

/**
 * api_keys 를 `after_id` 로 끝까지 넘겨 전체 목록을 만듭니다.
 *
 * `status` 를 넘기지 않으면 **archived/inactive 키까지 전부** 옵니다. 과거 사용량에는
 * 지금 비활성인 키도 등장하므로, 이름 매핑 용도라면 필터를 걸지 마세요.
 */
export async function fetchAllAnthropicApiKeys(
  params: AnthropicListApiKeysParams = {},
  options: AnthropicClientOptions = {},
): Promise<AnthropicApiKey[]> {
  const config = resolveAnthropicConfig(options);
  const keys: AnthropicApiKey[] = [];
  let afterId: string | undefined = params.after_id;

  for (let i = 0; i < MAX_PAGES; i++) {
    const body: AnthropicApiKeysResponse = await getJson<AnthropicApiKeysResponse>(
      ANTHROPIC_API_KEYS_PATH,
      { limit: API_KEYS_PAGE_LIMIT, ...params, after_id: afterId },
      config,
    );

    const page = body.data ?? [];
    keys.push(...page);

    // last_id 가 비면 마지막 항목 id 로 대신한다. 둘 다 없으면 여기서 끊어야
    // 같은 페이지를 무한히 다시 받는 일이 없다.
    const nextAfter = body.last_id ?? page[page.length - 1]?.id;
    if (!body.has_more || !nextAfter) return keys;
    afterId = nextAfter;
  }

  throw new Error(
    `Anthropic ${ANTHROPIC_API_KEYS_PATH}: 페이지가 ${MAX_PAGES}개를 넘었습니다.`,
  );
}

// ---------------------------------------------------------------- 유틸

/**
 * cost_report 의 `amount` (센트 단위 decimal **문자열**) → USD 숫자.
 *
 *   centsStringToUsd("123.45") === 1.2345
 *
 * 이 변환을 빠뜨리면 대시보드 금액이 100배로 표시됩니다.
 */
export function centsStringToUsd(amount: string): number {
  // Number("") === 0 이라 빈 문자열이 조용히 $0 으로 둔갑한다. 명시적으로 막는다.
  const cents = amount.trim() === "" ? Number.NaN : Number(amount);
  if (!Number.isFinite(cents)) {
    throw new TypeError(
      `cost_report.amount 를 숫자로 읽을 수 없습니다: ${JSON.stringify(amount)}`,
    );
  }
  return cents / 100;
}

/**
 * usage_report 한 줄의 총 토큰. 단일 `total_tokens` 필드가 없어서 직접 합산합니다.
 * `server_tool_use.web_search_requests` 는 토큰이 아니므로 제외합니다.
 */
export function sumUsageTokens(result: {
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  output_tokens: number;
}): number {
  return (
    result.uncached_input_tokens +
    result.cache_read_input_tokens +
    result.cache_creation.ephemeral_5m_input_tokens +
    result.cache_creation.ephemeral_1h_input_tokens +
    result.output_tokens
  );
}
