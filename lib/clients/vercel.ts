/**
 * Vercel Billing API 클라이언트 — FOCUS v1.3 청구 데이터.
 *
 *   GET /v1/billing/charges?from=<ISO>&to=<ISO>[&teamId=…|&slug=…]
 *
 * 2026-02-19 changelog "Access billing usage and cost data via API" 로 공개된
 * 정식 엔드포인트입니다. 웹 검색 + 공식 레퍼런스로 확인한 사실:
 *   - 응답은 **JSONL** (`application/jsonl`) — 한 줄에 charge 1건, 스트리밍
 *   - FOCUS v1.3 오픈 표준 스키마 (BilledCost / EffectiveCost 로 실제 USD 금액)
 *   - 1일 granularity, 최대 조회 범위 **1년**
 *   - **페이지네이션 없음** — 전량 스트림
 *   - `from` 포함(inclusive) / `to` 제외(exclusive)
 *   - `Accept-Encoding: gzip` 으로 압축 수신 가능
 *   - 필요 역할: Owner / Member / Developer / Security / Billing / Enterprise Viewer
 *   - CLI 대응물: `vercel usage --from … --to …`
 *
 * 출처:
 *   https://vercel.com/changelog/access-billing-usage-cost-data-api
 *   https://vercel.com/docs/rest-api/billing/list-focus-billing-charges
 *
 * 인증: `Authorization: Bearer <VERCEL_API_TOKEN>`
 */

import {
  ApiClientError,
  MissingCredentialError,
  type FetchLike,
  type VercelBillingChargesParams,
  type VercelFocusCharge,
} from "./types";

export const VERCEL_BILLING_CHARGES_PATH = "/v1/billing/charges";
export const DEFAULT_VERCEL_API_BASE = "https://api.vercel.com";

/** 문서상 최대 조회 범위 1년. 윤년 여유로 366일. */
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface VercelClientOptions {
  /** 없으면 `process.env.VERCEL_API_TOKEN`. */
  apiToken?: string;
  /** 없으면 `process.env.VERCEL_API_BASE` → "https://api.vercel.com". */
  baseUrl?: string;
  /** 파라미터에 teamId/slug 가 없을 때 쓸 기본값. 없으면 `process.env.VERCEL_TEAM_ID`. */
  teamId?: string;
  /** 테스트에서 목 응답을 주입할 때 사용. 기본은 전역 fetch. */
  fetch?: FetchLike;
  signal?: AbortSignal;
}

interface ResolvedVercelConfig {
  apiToken: string;
  baseUrl: string;
  teamId?: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

/**
 * 환경변수 → 설정. 토큰이 없으면 여기서 끊습니다.
 * `VERCEL_TEAM_ID` 는 개인 스코프 조회도 가능하므로 **필수가 아닙니다.**
 */
export function resolveVercelConfig(
  options: VercelClientOptions = {},
): ResolvedVercelConfig {
  const apiToken = (options.apiToken ?? process.env.VERCEL_API_TOKEN ?? "").trim();

  if (!apiToken) {
    throw new MissingCredentialError(
      "VERCEL_API_TOKEN",
      "VERCEL_API_TOKEN이 .env에 없습니다. " +
        "Vercel Dashboard → Account Settings → Tokens 에서 토큰을 발급해 " +
        "`.env` 에 VERCEL_API_TOKEN=... 로 넣어 주세요. " +
        "팀 청구 데이터를 볼 거면 토큰 scope 를 해당 Team 으로 지정하고 " +
        "VERCEL_TEAM_ID 도 함께 채우세요. (.env.example 참고)",
    );
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new MissingCredentialError(
      "fetch",
      "전역 fetch를 찾을 수 없습니다. Node 18+ 에서 실행하거나 options.fetch 를 넘겨 주세요.",
    );
  }

  const teamId = (options.teamId ?? process.env.VERCEL_TEAM_ID ?? "").trim();

  return {
    apiToken,
    baseUrl: options.baseUrl ?? process.env.VERCEL_API_BASE ?? DEFAULT_VERCEL_API_BASE,
    teamId: teamId || undefined,
    fetchImpl,
    signal: options.signal,
  };
}

function assertValidRange(from: string, to: string): void {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);

  if (!Number.isFinite(fromMs)) {
    throw new TypeError(`from 이 ISO 8601 문자열이 아닙니다: ${JSON.stringify(from)}`);
  }
  if (!Number.isFinite(toMs)) {
    throw new TypeError(`to 가 ISO 8601 문자열이 아닙니다: ${JSON.stringify(to)}`);
  }
  if (toMs <= fromMs) {
    throw new RangeError(
      `to 는 from 보다 뒤여야 합니다 (from 포함 / to 제외). from=${from}, to=${to}`,
    );
  }
  if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) {
    throw new RangeError(
      `Vercel /v1/billing/charges 는 최대 1년까지만 조회할 수 있습니다. ` +
        `요청 범위: ${from} ~ ${to}`,
    );
  }
}

/**
 * "조회 구간에 청구 데이터가 아직 없음" 을 뜻하는 404 인지 판별한다.
 *
 * 2026-08-14 실측: 데이터가 존재하지 않는 구간을 조회하면 빈 배열이 아니라
 *   HTTP 404 `{"error":{"code":"costs_not_found","message":"Costs not found"}}`
 * 가 온다. 이건 에러가 아니라 "그 기간엔 아무 일도 없었다" 는 뜻이므로 빈 배열로 돌린다.
 *
 * 상태 코드만 보지 않고 **`error.code` 까지 확인**한다. 잘못된 teamId·토큰은
 * 404 가 아니라 403 `forbidden` 으로 오는 것을 확인했지만(그래서 여기 걸리지 않는다),
 * 앞으로 다른 이유의 404 가 생겼을 때 그것까지 조용히 삼키지 않기 위해서다.
 */
function isCostsNotFound(status: number, body: string): boolean {
  if (status !== 404) return false;
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code === "costs_not_found";
  } catch {
    return false;
  }
}

function hintForStatus(status: number): string | undefined {
  if (status === 401) {
    return "토큰이 유효하지 않거나 만료됐습니다. Vercel Dashboard → Account Settings → Tokens 에서 재발급하세요.";
  }
  if (status === 403) {
    return (
      "토큰은 유효하지만 해당 팀의 청구 데이터 조회 권한이 없습니다. " +
      "Owner / Member / Developer / Security / Billing / Enterprise Viewer 역할이 필요하며, " +
      "토큰 scope 가 다른 팀으로 잡혀 있지 않은지 확인하세요."
    );
  }
  if (status === 404) {
    return (
      "조회 구간에 데이터가 없다는 404(`costs_not_found`)는 위에서 빈 배열로 처리하므로, " +
      "여기까지 온 404 는 다른 원인입니다. 경로나 API 버전을 확인하세요. " +
      "(잘못된 teamId·토큰은 404 가 아니라 403 으로 옵니다)"
    );
  }
  if (status === 400) {
    return "from/to 형식(ISO 8601 UTC)이나 조회 범위(최대 1년)를 확인하세요.";
  }
  return undefined;
}

/**
 * JSONL 본문 → charge 배열.
 *
 * 빈 줄은 건너뜁니다. 한 줄이라도 JSON 파싱에 실패하면 **몇 번째 줄인지 알려주고**
 * 던집니다 (조용히 버리면 금액이 소리 없이 비게 됩니다).
 * 스트림을 직접 다루거나 파일로 떨궈 둔 JSONL 을 파싱할 때도 재사용할 수 있게 export 합니다.
 */
export function parseFocusChargesJsonl(text: string): VercelFocusCharge[] {
  const charges: VercelFocusCharge[] = [];

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      charges.push(JSON.parse(line) as VercelFocusCharge);
    } catch (cause) {
      throw new SyntaxError(
        `Vercel JSONL ${i + 1}번째 줄을 파싱하지 못했습니다: ${line.slice(0, 200)}`,
        { cause },
      );
    }
  }

  return charges;
}

/**
 * GET /v1/billing/charges — 지정 구간의 charge 전량.
 *
 * 페이지네이션이 없으므로 이 한 번의 호출이 전부입니다.
 *
 * ⚠️ 합계를 낼 때: `ChargeCategory` 에 `Credit` / `Tax` / `Adjustment` 가 섞여 옵니다.
 *    "사용량 비용"만 보려면 `ChargeCategory === "Usage"` 로 필터하고,
 *    "실제 청구 총액"을 보려면 전부 더해야 합니다. 두 숫자는 다릅니다.
 *
 * ⚠️ 무료 Hobby 플랜은 청구 항목이 없어 빈 배열이 정상입니다 (에러가 아님).
 *
 * ⚠️ 빈 배열이 나오는 경우가 하나 더 있습니다 — 조회 구간에 청구 데이터가 아직
 *    존재하지 않으면 API 가 404 `costs_not_found` 를 주는데, 이건 에러가 아니므로
 *    여기서 빈 배열로 바꿔 돌려줍니다 (`isCostsNotFound`). 그 외 404 는 그대로 던집니다.
 */
export async function fetchVercelBillingCharges(
  params: VercelBillingChargesParams,
  options: VercelClientOptions = {},
): Promise<VercelFocusCharge[]> {
  const config = resolveVercelConfig(options);
  assertValidRange(params.from, params.to);

  const url = new URL(VERCEL_BILLING_CHARGES_PATH, config.baseUrl);
  url.searchParams.set("from", params.from);
  url.searchParams.set("to", params.to);

  const teamId = params.teamId ?? config.teamId;
  if (teamId) url.searchParams.set("teamId", teamId);
  if (params.slug) url.searchParams.set("slug", params.slug);

  const response = await config.fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      accept: "application/jsonl",
    },
    signal: config.signal,
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<본문 읽기 실패>");

    // 데이터가 아직 없는 구간 → 에러가 아니라 빈 결과.
    if (isCostsNotFound(response.status, body)) return [];

    throw new ApiClientError({
      vendor: "vercel",
      status: response.status,
      body,
      url: url.toString(),
      hint: hintForStatus(response.status),
    });
  }

  return parseFocusChargesJsonl(await response.text());
}

// ---------------------------------------------------------------- 유틸

/**
 * charge 배열을 하루 단위(`ChargePeriodStart` 의 날짜)로 접어 금액을 합칩니다.
 *
 * `BilledCost`(청구 기준액)와 `EffectiveCost`(크레딧·할인 반영 상각 원가)는
 * 다를 수 있으므로 둘 다 따로 합산해 돌려줍니다.
 */
export function sumChargesByDay(
  charges: VercelFocusCharge[],
  options: { onlyUsage?: boolean } = {},
): Array<{ date: string; billedCost: number; effectiveCost: number }> {
  const byDate = new Map<string, { billedCost: number; effectiveCost: number }>();

  for (const charge of charges) {
    if (options.onlyUsage && charge.ChargeCategory !== "Usage") continue;

    // ISO 8601 UTC 의 날짜 부분. 대시보드 타임존을 Asia/Seoul 로 볼 거면
    // 일 경계가 9시간 밀린다는 점을 화면에 표기할 것.
    const date = charge.ChargePeriodStart.slice(0, 10);

    const bucket = byDate.get(date) ?? { billedCost: 0, effectiveCost: 0 };
    bucket.billedCost += charge.BilledCost;
    bucket.effectiveCost += charge.EffectiveCost;
    byDate.set(date, bucket);
  }

  return [...byDate.entries()]
    .map(([date, sums]) => ({ date, ...sums }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 프로젝트별 합계.
 *
 * ⚠️ 프로젝트 정보는 최상위 필드가 아니라 `Tags.ProjectName` 에 **중첩**되어 있습니다.
 *    태그가 비어 있는 charge 는 "(프로젝트 미분류)" 로 모읍니다.
 */
export function sumChargesByProject(
  charges: VercelFocusCharge[],
  options: { onlyUsage?: boolean } = {},
): Array<{ project: string; billedCost: number; effectiveCost: number }> {
  const byProject = new Map<string, { billedCost: number; effectiveCost: number }>();

  for (const charge of charges) {
    if (options.onlyUsage && charge.ChargeCategory !== "Usage") continue;

    const project = charge.Tags?.ProjectName ?? "(프로젝트 미분류)";

    const bucket = byProject.get(project) ?? { billedCost: 0, effectiveCost: 0 };
    bucket.billedCost += charge.BilledCost;
    bucket.effectiveCost += charge.EffectiveCost;
    byProject.set(project, bucket);
  }

  return [...byProject.entries()]
    .map(([project, sums]) => ({ project, ...sums }))
    .sort((a, b) => b.billedCost - a.billedCost);
}
