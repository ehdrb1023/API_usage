/**
 * Supabase Management API 클라이언트.
 *
 *   GET /v1/projects                                             — 프로젝트 전량
 *   GET /v1/organizations                                        — 조직 목록
 *   GET /v1/organizations/{slug}                                 — 조직 상세(plan)
 *   GET /v1/projects/{ref}/analytics/endpoints/usage.api-counts  — 요청 수 시계열
 *   GET /v1/projects/{ref}/billing/addons                        — 애드온 + **단가**
 *
 * 근거: 2026-08-25 에 받은 공식 OpenAPI 스펙 `GET https://api.supabase.com/api/v1-json`.
 * 인증: `Authorization: Bearer <Personal Access Token>` (`sbp_...`).
 *
 * ────────────────────────────────────────────────────────────────────────
 * 여러 계정을 동시에 본다 — Anthropic·Vercel 클라이언트와 다른 점
 * ────────────────────────────────────────────────────────────────────────
 * Supabase 의 Personal Access Token 은 **한 사람의 계정에 묶입니다.** 조직을 넘나드는
 * 건 되지만(한 토큰으로 그 사람이 속한 모든 조직이 보임), 계정을 넘나드는 건 안 됩니다.
 * 그래서 계정이 여러 개면 **토큰도 그 수만큼** 필요하고, 이 클라이언트는 토큰 목록을
 * 받아 각각 따로 호출한 뒤 합칩니다.
 *
 *   .env:  SUPABASE_ACCESS_TOKENS=회사=sbp_aaa...,개인=sbp_bbb...
 *
 * 한 계정이 죽어도 나머지는 살립니다 (`SupabaseAccountSnapshot.error`).
 *
 * ⚠️ Management API 는 사용자당 분당 60요청 제한이 있습니다. 프로젝트 하나에 2요청
 *    (usage + addons) 이 들어가므로 계정당 프로젝트가 30개를 넘으면 429 가 납니다.
 *    아래에서 동시요청 4개로 제한하고 429 는 Retry-After 만큼 한 번 재시도합니다.
 */

import {
  ApiClientError,
  MissingCredentialError,
  type FetchLike,
  type SupabaseAddonsResponse,
  type SupabaseOrganization,
  type SupabaseOrganizationDetail,
  type SupabaseProject,
  type SupabaseSelectedAddon,
  type SupabaseUsageApiCount,
  type SupabaseUsageApiCountResponse,
  type SupabaseUsageInterval,
} from "./types";

export const DEFAULT_SUPABASE_API_BASE = "https://api.supabase.com";

/** 동시 요청 상한. 분당 60요청 제한(사용자당)에 맞춘 값. */
const CONCURRENCY = 4;

// ============================================================================
// 계정 (= 토큰) 해석
// ============================================================================

export interface SupabaseAccount {
  /** 화면·로그에 뜨는 이름. `.env` 에서 `라벨=토큰` 으로 지정. */
  label: string;
  token: string;
}

export interface SupabaseClientOptions {
  /** 없으면 `SUPABASE_ACCESS_TOKENS` → `SUPABASE_ACCESS_TOKEN` 을 읽습니다. */
  accounts?: SupabaseAccount[];
  /** 없으면 `process.env.SUPABASE_API_BASE` → "https://api.supabase.com". */
  baseUrl?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * `.env.example` 이 넣어 둔 자리표시자를 진짜 토큰으로 착각하지 않기 위한 검사.
 *
 * `sbp_xxxxxxxx...` / `sbp_yyyy...` 처럼 **같은 글자가 8번 넘게 반복**되는 값은
 * "아직 안 채웠다" 는 뜻입니다. 이걸 걸러 내지 않으면 401 을 받고 나서야 원인을 알게
 * 되는데, 그 에러 메시지는 "토큰이 만료됐다" 로 읽혀서 엉뚱한 곳을 뒤지게 됩니다.
 *
 * 8번으로 끊은 건 실제 토큰을 자리표시자로 오인하지 않기 위해서입니다. 진짜 PAT 은
 * 40자 랜덤이라 같은 글자가 8번 연속될 확률이 사실상 없습니다.
 */
function isPlaceholderToken(token: string): boolean {
  return /^sbp_(.)\1{7,}$/i.test(token);
}

/**
 * `SUPABASE_ACCESS_TOKENS` 파싱.
 *
 * 형식: 쉼표(또는 줄바꿈)로 구분한 `라벨=토큰` 목록. 라벨 구분자는 `=` 와 `:` 둘 다 받고,
 * **맨 앞에 나오는 것 하나만** 구분자로 씁니다 (토큰 자체에는 둘 다 들어가지 않습니다).
 * 라벨을 생략하면 "계정 1", "계정 2" 로 번호를 붙입니다.
 *
 *   회사=sbp_aaa, 개인=sbp_bbb     → [{회사, sbp_aaa}, {개인, sbp_bbb}]
 *   sbp_aaa,sbp_bbb               → [{계정 1, ...}, {계정 2, ...}]
 */
export function parseSupabaseAccounts(raw: string): SupabaseAccount[] {
  const accounts: SupabaseAccount[] = [];
  const usedLabels = new Set<string>();

  const entries = raw
    .split(/[,\n]/)
    .map((e) => e.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const colon = entry.indexOf(":");
    const sep =
      eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);

    let label = sep === -1 ? "" : entry.slice(0, sep).trim();
    const token = (sep === -1 ? entry : entry.slice(sep + 1)).trim();

    if (!token) continue;
    if (!label) label = `계정 ${accounts.length + 1}`;

    // 라벨이 겹치면 표에서 두 계정이 한 줄로 합쳐져 버린다. 뒤에 번호를 붙여 떼어 둔다.
    if (usedLabels.has(label)) {
      let n = 2;
      while (usedLabels.has(`${label} (${n})`)) n++;
      label = `${label} (${n})`;
    }
    usedLabels.add(label);

    accounts.push({ label, token });
  }

  return accounts;
}

/**
 * 환경변수 → 계정 목록. 하나도 못 찾으면 여기서 끊습니다.
 *
 * `SUPABASE_ACCESS_TOKENS`(복수)가 있으면 그걸 쓰고, 없으면 기존
 * `SUPABASE_ACCESS_TOKEN`(단수)를 계정 하나로 취급합니다 — 단수 쪽 라벨은
 * `SUPABASE_ACCOUNT_LABEL` 로 정할 수 있고 기본값은 "기본 계정" 입니다.
 */
export function resolveSupabaseAccounts(
  options: SupabaseClientOptions = {},
): SupabaseAccount[] {
  if (options.accounts?.length) return options.accounts;

  const multi = (process.env.SUPABASE_ACCESS_TOKENS ?? "").trim();
  if (multi) {
    const parsed = parseSupabaseAccounts(multi).filter(
      (a) => !isPlaceholderToken(a.token),
    );
    if (parsed.length) return parsed;
  }

  const single = (process.env.SUPABASE_ACCESS_TOKEN ?? "").trim();
  if (single && !isPlaceholderToken(single)) {
    return [
      {
        label: (process.env.SUPABASE_ACCOUNT_LABEL ?? "").trim() || "기본 계정",
        token: single,
      },
    ];
  }

  throw new MissingCredentialError(
    "SUPABASE_ACCESS_TOKENS",
    "Supabase 토큰이 .env 에 없습니다 (자리표시자 sbp_xxxx... 는 없는 것으로 칩니다).\n" +
      "https://supabase.com/dashboard/account/tokens 에서 Personal Access Token 을 발급하세요.\n" +
      "  · 계정 하나:  SUPABASE_ACCESS_TOKEN=sbp_...\n" +
      "  · 계정 여럿:  SUPABASE_ACCESS_TOKENS=회사=sbp_aaa...,개인=sbp_bbb...\n" +
      "토큰은 계정(사람) 단위입니다 — 계정이 3개면 토큰도 3개를 각각 로그인해서 발급해야 합니다.",
  );
}

function resolveBaseUrl(options: SupabaseClientOptions): string {
  return (
    options.baseUrl ??
    process.env.SUPABASE_API_BASE ??
    DEFAULT_SUPABASE_API_BASE
  );
}

function resolveFetch(options: SupabaseClientOptions): FetchLike {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new MissingCredentialError(
      "fetch",
      "전역 fetch를 찾을 수 없습니다. Node 18+ 에서 실행하거나 options.fetch 를 넘겨 주세요.",
    );
  }
  return fetchImpl;
}

// ============================================================================
// 공통 GET
// ============================================================================

function hintForStatus(status: number, accountLabel: string): string | undefined {
  if (status === 401) {
    return (
      `[${accountLabel}] 토큰이 유효하지 않거나 만료됐습니다. ` +
      "https://supabase.com/dashboard/account/tokens 에서 재발급하세요."
    );
  }
  if (status === 403) {
    return (
      `[${accountLabel}] 토큰은 유효하지만 이 조직·프로젝트에 접근 권한이 없습니다. ` +
      "그 조직에 속한 계정의 토큰인지 확인하세요 (토큰은 계정 단위라 다른 계정 소유 " +
      "프로젝트는 보이지 않습니다)."
    );
  }
  if (status === 404) {
    return `[${accountLabel}] 프로젝트 ref 가 잘못됐거나 이미 삭제된 프로젝트입니다.`;
  }
  if (status === 429) {
    return (
      `[${accountLabel}] Management API 요청 한도(사용자당 분당 60회)를 넘었습니다. ` +
      "프로젝트 수가 많으면 잠시 뒤 다시 시도하세요."
    );
  }
  return undefined;
}

/**
 * 429 한 번은 조용히 넘긴다 — 프로젝트가 많으면 분당 한도에 걸리는 게 정상 동작에
 * 가깝고, 여기서 죽으면 계정 전체 데이터가 날아간다. `Retry-After` 를 존중하되
 * 최대 30초까지만 기다린다(그 이상은 페이지 렌더가 멈춘 것처럼 보인다).
 */
const MAX_RETRY_WAIT_MS = 30_000;

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  const ms = Number.isFinite(seconds) ? seconds * 1000 : 2000;
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

async function supabaseGet<T>(
  account: SupabaseAccount,
  pathname: string,
  options: SupabaseClientOptions,
  search?: Record<string, string>,
): Promise<T> {
  const fetchImpl = resolveFetch(options);
  const url = new URL(pathname, resolveBaseUrl(options));
  for (const [k, v] of Object.entries(search ?? {})) url.searchParams.set(k, v);

  const send = () =>
    fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${account.token}`,
        accept: "application/json",
      },
      signal: options.signal,
      cache: "no-store",
    });

  let response = await send();

  if (response.status === 429) {
    await new Promise((r) => setTimeout(r, retryAfterMs(response)));
    response = await send();
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "<본문 읽기 실패>");
    throw new ApiClientError({
      vendor: "supabase",
      status: response.status,
      body,
      url: url.toString(),
      hint: hintForStatus(response.status, account.label),
    });
  }

  return (await response.json()) as T;
}

// ============================================================================
// 개별 엔드포인트
// ============================================================================

export async function fetchSupabaseOrganizations(
  account: SupabaseAccount,
  options: SupabaseClientOptions = {},
): Promise<SupabaseOrganization[]> {
  return supabaseGet<SupabaseOrganization[]>(account, "/v1/organizations", options);
}

/** 목록 응답에는 `plan` 이 없어서 조직마다 한 번 더 부릅니다. */
export async function fetchSupabaseOrganization(
  account: SupabaseAccount,
  slug: string,
  options: SupabaseClientOptions = {},
): Promise<SupabaseOrganizationDetail> {
  return supabaseGet<SupabaseOrganizationDetail>(
    account,
    `/v1/organizations/${encodeURIComponent(slug)}`,
    options,
  );
}

/** 토큰이 접근 가능한 **모든 조직의** 프로젝트가 한 번에 옵니다 (페이지네이션 없음). */
export async function fetchSupabaseProjects(
  account: SupabaseAccount,
  options: SupabaseClientOptions = {},
): Promise<SupabaseProject[]> {
  return supabaseGet<SupabaseProject[]>(account, "/v1/projects", options);
}

/**
 * 프로젝트 요청 수 시계열.
 *
 * ⚠️ `from`/`to` 가 없습니다. `interval` 만으로 "지금 기준 최근 얼마" 가 정해지고,
 *    그게 며칠인지는 스펙에 안 적혀 있습니다. 실제 응답의 `timestamp` 범위를 보고
 *    docs/api-clients-status.md 에 적어 두세요.
 */
export async function fetchSupabaseProjectUsage(
  account: SupabaseAccount,
  ref: string,
  interval: SupabaseUsageInterval = "1day",
  options: SupabaseClientOptions = {},
): Promise<SupabaseUsageApiCount[]> {
  const res = await supabaseGet<SupabaseUsageApiCountResponse>(
    account,
    `/v1/projects/${encodeURIComponent(ref)}/analytics/endpoints/usage.api-counts`,
    options,
    { interval },
  );
  return res.result ?? [];
}

/** 애드온 + 단가. 금액이 나오는 **유일한** 엔드포인트입니다. */
export async function fetchSupabaseProjectAddons(
  account: SupabaseAccount,
  ref: string,
  options: SupabaseClientOptions = {},
): Promise<SupabaseSelectedAddon[]> {
  const res = await supabaseGet<SupabaseAddonsResponse>(
    account,
    `/v1/projects/${encodeURIComponent(ref)}/billing/addons`,
    options,
  );
  return res.selected_addons ?? [];
}

// ============================================================================
// 계정 단위로 묶어 가져오기
// ============================================================================

export interface SupabaseProjectSnapshot {
  ref: string;
  name: string;
  organization_slug?: string;
  region: string;
  status: string;
  created_at: string;
  usage: SupabaseUsageApiCount[];
  addons: SupabaseSelectedAddon[];
  /** 이 프로젝트만 조회에 실패했을 때의 사유. 나머지 프로젝트는 정상 표시됩니다. */
  error?: string;
}

export interface SupabaseAccountSnapshot {
  label: string;
  organizations: SupabaseOrganizationDetail[];
  projects: SupabaseProjectSnapshot[];
  /** 계정 전체가 실패했을 때(토큰 만료 등). 다른 계정은 정상 표시됩니다. */
  error?: string;
}

export interface SupabaseRawSnapshot {
  accounts: SupabaseAccountSnapshot[];
}

/** 동시 실행 수를 묶어 두는 최소한의 풀. 분당 60요청 제한 때문에 필요하다. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return results;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 계정 하나의 전체 스냅샷.
 *
 * 프로젝트 하나가 실패해도(일시정지·삭제 중·권한 없음) 그 프로젝트에만 `error` 를 달고
 * 나머지는 그대로 돌려줍니다. 사용량 화면은 "일부라도 보이는 것" 이 "아무것도 안 보이는 것"
 * 보다 낫기 때문입니다.
 */
export async function fetchSupabaseAccountSnapshot(
  account: SupabaseAccount,
  options: SupabaseClientOptions = {},
): Promise<SupabaseAccountSnapshot> {
  const [orgList, projects] = await Promise.all([
    fetchSupabaseOrganizations(account, options),
    fetchSupabaseProjects(account, options),
  ]);

  // plan 은 단건 조회에만 있다. 실패해도 조직 이름은 살린다.
  const organizations = await mapWithConcurrency(orgList, CONCURRENCY, async (org) => {
    try {
      return await fetchSupabaseOrganization(account, org.slug, options);
    } catch {
      return org as SupabaseOrganizationDetail;
    }
  });

  const snapshots = await mapWithConcurrency(projects, CONCURRENCY, async (p) => {
    const base: SupabaseProjectSnapshot = {
      ref: p.ref,
      name: p.name,
      organization_slug: p.organization_slug,
      region: p.region,
      status: p.status,
      created_at: p.created_at,
      usage: [],
      addons: [],
    };

    // 일시정지(INACTIVE)·삭제된 프로젝트는 analytics 가 404/403 을 낸다. 굳이 부르지 않는다.
    if (p.status === "INACTIVE" || p.status === "REMOVED") {
      return { ...base, error: `프로젝트 상태가 ${p.status} 라 사용량 조회를 건너뛰었습니다.` };
    }

    const [usage, addons] = await Promise.all([
      fetchSupabaseProjectUsage(account, p.ref, "1day", options).catch((e) => {
        base.error = message(e);
        return [] as SupabaseUsageApiCount[];
      }),
      fetchSupabaseProjectAddons(account, p.ref, options).catch(() => {
        // 애드온 조회 실패는 비용 추정만 못 하는 것이라 사용량 표시를 막지 않는다.
        return [] as SupabaseSelectedAddon[];
      }),
    ]);

    return { ...base, usage, addons };
  });

  return { label: account.label, organizations, projects: snapshots };
}

/**
 * 모든 계정. 계정 하나가 통째로 실패해도(토큰 만료 등) 나머지는 살립니다.
 * 전부 실패하면 첫 에러를 그대로 던집니다 — 그때는 화면에 사유가 보여야 하기 때문입니다.
 */
export async function fetchAllSupabaseAccounts(
  options: SupabaseClientOptions = {},
): Promise<SupabaseRawSnapshot> {
  const accounts = resolveSupabaseAccounts(options);

  const results = await Promise.all(
    accounts.map(async (account): Promise<SupabaseAccountSnapshot> => {
      try {
        return await fetchSupabaseAccountSnapshot(account, options);
      } catch (error) {
        return {
          label: account.label,
          organizations: [],
          projects: [],
          error: message(error),
        };
      }
    }),
  );

  if (results.length > 0 && results.every((r) => r.error)) {
    throw new Error(
      `Supabase 계정 ${results.length}개가 모두 실패했습니다.\n` +
        results.map((r) => `  · ${r.label}: ${r.error}`).join("\n"),
    );
  }

  return { accounts: results };
}
