/**
 * OpenAI Admin API 클라이언트 — 조직 단위 토큰 사용량 / 비용.
 *
 *   GET /v1/organization/usage/completions   토큰 수 (비용 없음)
 *   GET /v1/organization/costs               비용 (토큰 수 없음)
 *   GET /v1/organization/projects            프로젝트 id → 이름
 *
 * 인증: `Authorization: Bearer <Admin 키>`
 *   ⚠️ 반드시 **Admin 키**(`sk-admin-…`)여야 합니다. 일반 프로젝트 키(`sk-proj-…`)로는
 *      401/403 이 납니다. Platform → Settings → Organization → Admin keys
 *      (조직 Owner 권한 필요)
 *
 * ⚠️⚠️ **이 클라이언트는 실 키로 검증되지 않았습니다.** 경로·파라미터·응답 필드가
 *      전부 공개 문서 기준입니다. 첫 200 응답을 받으면
 *      `docs/openai-integration.md` 의 체크리스트를 위에서부터 지워 주세요.
 *
 * 아직 실제 키가 없어도 import 는 안전합니다. 키 검사는 **함수 호출 시점**에만
 * 일어나고, 없으면 무엇을 어디에 넣어야 하는지 알려주는 에러를 던집니다.
 */

import {
  ApiClientError,
  MissingCredentialError,
  type FetchLike,
  type OpenAiCostBucket,
  type OpenAiCostsParams,
  type OpenAiCostsResponse,
  type OpenAiListProjectApiKeysParams,
  type OpenAiListProjectsParams,
  type OpenAiProject,
  type OpenAiProjectApiKey,
  type OpenAiProjectApiKeysResponse,
  type OpenAiProjectsResponse,
  type OpenAiUsageBucket,
  type OpenAiUsageParams,
  type OpenAiUsageResponse,
} from "./types";

/** ⚠️ **단수** organization 이다. Anthropic 의 organizations 와 헷갈리지 말 것. */
export const OPENAI_USAGE_COMPLETIONS_PATH = "/v1/organization/usage/completions";
export const OPENAI_COSTS_PATH = "/v1/organization/costs";
export const OPENAI_PROJECTS_PATH = "/v1/organization/projects";

/** ⚠️ 프로젝트마다 따로 두드려야 한다. 조직 전체를 한 번에 주는 경로는 없다. */
export const openAiProjectApiKeysPath = (projectId: string): string =>
  `/v1/organization/projects/${encodeURIComponent(projectId)}/api_keys`;

export const DEFAULT_OPENAI_API_BASE = "https://api.openai.com";

/** 커서 루프가 폭주하지 않도록 하는 안전장치. */
const MAX_PAGES = 50;

/** projects 는 기본 20건이라 그대로 두면 조용히 잘린다. */
const PROJECTS_PAGE_LIMIT = 100;

export interface OpenAiClientOptions {
  /** 없으면 `process.env.OPENAI_ADMIN_KEY`. */
  adminKey?: string;
  /** 없으면 `process.env.OPENAI_API_BASE` → "https://api.openai.com". */
  baseUrl?: string;
  /** 조직이 여럿인 계정이면 필요. `process.env.OPENAI_ORG_ID`. */
  orgId?: string;
  /** 테스트에서 목 응답을 주입할 때 사용. 기본은 전역 fetch. */
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** `.env.example` 의 자리표시자(sk-admin-xxxxxxxx…)를 진짜 키로 오인하지 않도록. */
const PLACEHOLDER_PATTERN = /x{8,}/i;

interface ResolvedOpenAiConfig {
  adminKey: string;
  baseUrl: string;
  orgId?: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

/**
 * 키가 **쓸 수 있는 상태인지**만 본다. 던지지 않는다.
 * `lib/services.ts` 가 GPT 탭을 켤지 말지 판단하는 데 쓴다.
 */
export function hasOpenAiCredentials(): boolean {
  const key = (process.env.OPENAI_ADMIN_KEY ?? "").trim();
  return key !== "" && !PLACEHOLDER_PATTERN.test(key);
}

/**
 * 환경변수 → 설정. 키가 없거나 자리표시자 그대로면 여기서 끊는다.
 */
export function resolveOpenAiConfig(
  options: OpenAiClientOptions = {},
): ResolvedOpenAiConfig {
  const adminKey = (options.adminKey ?? process.env.OPENAI_ADMIN_KEY ?? "").trim();

  if (!adminKey) {
    throw new MissingCredentialError(
      "OPENAI_ADMIN_KEY",
      "OPENAI_ADMIN_KEY가 .env에 없습니다. " +
        "Platform → Settings → Organization → Admin keys 에서 조직 Owner 권한으로 " +
        "Admin 키(sk-admin-...)를 발급해 `.env` 에 OPENAI_ADMIN_KEY=... 로 넣어 주세요. " +
        "(.env.example 참고 / 프로젝트 키 sk-proj-... 로는 호출되지 않습니다)",
    );
  }

  if (PLACEHOLDER_PATTERN.test(adminKey)) {
    throw new MissingCredentialError(
      "OPENAI_ADMIN_KEY",
      "OPENAI_ADMIN_KEY가 .env.example 의 자리표시자 값 그대로입니다. " +
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
    baseUrl: options.baseUrl ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE,
    orgId: options.orgId ?? process.env.OPENAI_ORG_ID ?? undefined,
    fetchImpl,
    signal: options.signal,
  };
}

function buildHeaders(config: ResolvedOpenAiConfig): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.adminKey}`,
    accept: "application/json",
  };
  // 계정이 조직 하나뿐이면 없어도 된다. 여럿이면 없을 때 엉뚱한 조직이 잡힌다.
  if (config.orgId) headers["openai-organization"] = config.orgId;
  return headers;
}

/**
 * 쿼리스트링 조립.
 *
 * ⚠️ 배열 파라미터 표기가 **Anthropic 과 다를 수 있다.** Anthropic 은 `group_by[]=model`
 *    (대괄호)이고, OpenAI 문서 예시는 `group_by=model&group_by=project_id` (반복)로
 *    보인다. 여기서는 **반복** 형태를 쓴다 — 400 이 나면 여기부터 의심할 것.
 *    (docs/openai-integration.md 체크리스트 2번)
 */
function buildQuery(params: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        query.append(key, String(item));
      }
      continue;
    }

    if (typeof value === "boolean") {
      query.set(key, value ? "true" : "false");
      continue;
    }

    query.set(key, String(value));
  }

  return query;
}

function hintForStatus(status: number): string | undefined {
  if (status === 401) {
    return "키가 유효하지 않습니다. 프로젝트 키(sk-proj-...)가 아니라 Admin 키(sk-admin-...)인지 확인하세요.";
  }
  if (status === 403) {
    return "키는 유효하지만 조직 사용량/비용 조회 권한이 없습니다. 조직 Owner 권한으로 발급한 Admin 키가 필요합니다.";
  }
  if (status === 404) {
    return "경로를 확인하세요. OpenAI 는 /v1/organization (단수) 입니다 — Anthropic 의 /v1/organizations (복수) 와 다릅니다.";
  }
  if (status === 429) {
    return "레이트리밋입니다. 잠시 후 재시도하거나 조회 구간을 좁히세요.";
  }
  return undefined;
}

async function getJson<T>(
  path: string,
  params: Record<string, unknown>,
  config: ResolvedOpenAiConfig,
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
      vendor: "openai",
      status: response.status,
      body: await response.text().catch(() => "<본문 읽기 실패>"),
      url: url.toString(),
      hint: hintForStatus(response.status),
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    });
  }

  return (await response.json()) as T;
}

/** `retry-after` 는 초 단위 정수 또는 HTTP-date. 실무에서는 전자만 온다. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

// ---------------------------------------------------------------- 단일 페이지

/** GET /v1/organization/usage/completions — 한 페이지. */
export async function fetchOpenAiUsage(
  params: OpenAiUsageParams,
  options: OpenAiClientOptions = {},
): Promise<OpenAiUsageResponse> {
  return getJson<OpenAiUsageResponse>(
    OPENAI_USAGE_COMPLETIONS_PATH,
    { ...params },
    resolveOpenAiConfig(options),
  );
}

/** GET /v1/organization/costs — 한 페이지. */
export async function fetchOpenAiCosts(
  params: OpenAiCostsParams,
  options: OpenAiClientOptions = {},
): Promise<OpenAiCostsResponse> {
  return getJson<OpenAiCostsResponse>(
    OPENAI_COSTS_PATH,
    { ...params },
    resolveOpenAiConfig(options),
  );
}

// ---------------------------------------------------------------- 전체 페이지

async function collectAll<TBucket>(
  path: string,
  params: Record<string, unknown>,
  config: ResolvedOpenAiConfig,
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
    `OpenAI ${path}: 페이지가 ${MAX_PAGES}개를 넘었습니다. ` +
      `조회 구간(start_time/end_time)을 좁히세요.`,
  );
}

/** usage/completions 를 커서 페이지네이션으로 끝까지 긁어 버킷 배열로 합친다. */
export async function fetchAllOpenAiUsageBuckets(
  params: OpenAiUsageParams,
  options: OpenAiClientOptions = {},
): Promise<OpenAiUsageBucket[]> {
  return collectAll<OpenAiUsageBucket>(
    OPENAI_USAGE_COMPLETIONS_PATH,
    { ...params },
    resolveOpenAiConfig(options),
  );
}

/** costs 를 커서 페이지네이션으로 끝까지 긁어 버킷 배열로 합친다. */
export async function fetchAllOpenAiCostBuckets(
  params: OpenAiCostsParams,
  options: OpenAiClientOptions = {},
): Promise<OpenAiCostBucket[]> {
  return collectAll<OpenAiCostBucket>(
    OPENAI_COSTS_PATH,
    { ...params },
    resolveOpenAiConfig(options),
  );
}

// ---------------------------------------------------------------- 프로젝트 목록

/**
 * GET /v1/organization/projects — 전체.
 *
 * ⚠️ 리포트 두 개와 **페이지네이션 방식이 다르다.** `page`/`next_page` 커서가 아니라
 *    `after` + `last_id` 다 (Anthropic 의 api_keys 와 같은 구조).
 *
 * ⚠️ `include_archived` 를 켜 둔다. 과거 사용량에는 지금 보관된 프로젝트도 등장하고,
 *    빼면 그 몫이 통째로 "미등록" 으로 뜬다. Anthropic 쪽에서 실제로 겪은 문제다.
 */
export async function fetchAllOpenAiProjects(
  params: OpenAiListProjectsParams = {},
  options: OpenAiClientOptions = {},
): Promise<OpenAiProject[]> {
  const config = resolveOpenAiConfig(options);
  const projects: OpenAiProject[] = [];
  let after: string | undefined = params.after;

  for (let i = 0; i < MAX_PAGES; i++) {
    const body: OpenAiProjectsResponse = await getJson<OpenAiProjectsResponse>(
      OPENAI_PROJECTS_PATH,
      { limit: PROJECTS_PAGE_LIMIT, include_archived: true, ...params, after },
      config,
    );

    const page = body.data ?? [];
    projects.push(...page);

    const nextAfter = body.last_id ?? page[page.length - 1]?.id;
    if (!body.has_more || !nextAfter) return projects;
    after = nextAfter;
  }

  throw new Error(`OpenAI ${OPENAI_PROJECTS_PATH}: 페이지가 ${MAX_PAGES}개를 넘었습니다.`);
}

// ------------------------------------------------------- 프로젝트별 API 키 목록

/** 프로젝트 하나의 API 키 전부. */
export async function fetchAllOpenAiProjectApiKeys(
  projectId: string,
  params: OpenAiListProjectApiKeysParams = {},
  options: OpenAiClientOptions = {},
): Promise<OpenAiProjectApiKey[]> {
  const config = resolveOpenAiConfig(options);
  const path = openAiProjectApiKeysPath(projectId);
  const keys: OpenAiProjectApiKey[] = [];
  let after: string | undefined = params.after;

  for (let i = 0; i < MAX_PAGES; i++) {
    const body: OpenAiProjectApiKeysResponse = await getJson<OpenAiProjectApiKeysResponse>(
      path,
      { limit: PROJECTS_PAGE_LIMIT, ...params, after },
      config,
    );

    const page = body.data ?? [];
    keys.push(...page);

    const nextAfter = body.last_id ?? page[page.length - 1]?.id;
    if (!body.has_more || !nextAfter) return keys;
    after = nextAfter;
  }

  throw new Error(`OpenAI ${path}: 페이지가 ${MAX_PAGES}개를 넘었습니다.`);
}

// ---------------------------------------------------------------- 유틸

/** ISO 문자열 → unix 초. OpenAI 는 시각을 정수로만 받는다. */
export function toUnixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}
