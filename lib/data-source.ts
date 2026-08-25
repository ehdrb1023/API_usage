import { promises as fs } from "node:fs";
import path from "node:path";

import { unstable_cache } from "next/cache";

import {
  ANTHROPIC_METRICS,
  ANTHROPIC_PRIMARY_METRIC,
  adaptAnthropic,
  type AnthropicRaw,
} from "@/lib/adapters/anthropic";
import {
  VERCEL_METRICS,
  VERCEL_PRIMARY_METRIC,
  adaptVercel,
  type VercelRaw,
} from "@/lib/adapters/vercel";
import {
  fetchAllAnthropicApiKeys,
  fetchAllAnthropicCostBuckets,
  fetchAllAnthropicUsageBuckets,
} from "@/lib/clients/anthropic";
import {
  SUPABASE_METRICS,
  SUPABASE_PRIMARY_METRIC,
  adaptSupabase,
  type SupabaseRaw,
} from "@/lib/adapters/supabase";
import { fetchAllSupabaseAccounts } from "@/lib/clients/supabase";
import { fetchVercelBillingCharges } from "@/lib/clients/vercel";
import { loadClientKeyNames } from "@/lib/client-keys";
import type { DayBoundary, ServiceId, ServiceSeries } from "@/lib/types";

/**
 * 일 경계는 벤더가 정하는 것이라 어댑터 바깥(여기)에 상수로 둔다.
 *
 * Vercel 은 2026-08-14 응답 8,708건이 **전부** `ChargePeriodStart`/`End` 가
 * `07:00:00.000Z` 였다. 07:00Z 자정 = UTC−7 = 2026년 8월의 America/Los_Angeles(PDT).
 *
 * ⚠️ 확보한 데이터가 4일치(08-10~08-13)뿐이고 전부 서머타임 기간이라,
 *    겨울(PST, UTC−8)에 08:00Z 로 바뀌는지는 확인하지 못했다. 11월 이후 응답에서
 *    `ChargePeriodStart` 시각을 다시 확인할 것. 바뀐다면 이 라벨을 고정 문구가 아니라
 *    응답에서 계산하도록 바꿔야 한다.
 */
const DAY_BOUNDARIES: Record<ServiceId, DayBoundary> = {
  claude: {
    label: "UTC",
    note: "Claude 는 UTC 자정(KST 오전 9시) 기준으로 하루를 끊습니다.",
  },
  vercel: {
    label: "미 태평양시 (UTC−7)",
    note:
      "Vercel 은 미 태평양시 자정(= 07:00 UTC, KST 오후 4시) 기준으로 하루를 끊습니다. " +
      "서머타임 해제 시 UTC−8 로 바뀔 수 있습니다 (미확인).",
  },
  supabase: {
    label: "UTC",
    note:
      "Supabase 사용량 버킷은 UTC 자정(KST 오전 9시) 기준입니다. " +
      "다만 청구 주기는 조직마다 가입일 기준이라 달력 월과 다를 수 있습니다.",
  },
};

/**
 * ★ 목업 ↔ 실제 API 스위치는 여기 한 곳뿐이다.
 *
 *   .env 의  DATA_SOURCE=mock   → mock/*.json 을 읽는다 (기본값)
 *            DATA_SOURCE=api    → 실제 API 를 호출한다
 *
 * 어느 쪽이든 같은 어댑터를 타고 같은 ServiceSeries 가 나오므로, 화면 코드는
 * 전혀 손대지 않아도 된다. 목업 파일이 실제 응답 스키마 그대로 생겼기 때문에
 * 가능한 구조다.
 *
 * 서버에서만 실행된다 (fs 접근 + API 키). 클라이언트 컴포넌트에서 import 금지.
 */

export type DataSourceMode = "mock" | "api";

export function getDataSourceMode(): DataSourceMode {
  return process.env.DATA_SOURCE === "api" ? "api" : "mock";
}

export async function getServiceSeries(service: ServiceId): Promise<ServiceSeries> {
  const mode = getDataSourceMode();
  if (service === "claude") return getClaude(mode);
  if (service === "vercel") return getVercel(mode);
  return getSupabase(mode);
}

/**
 * 화면에 띄울 서비스. 여기서 빼면 탭·데이터·API 호출이 통째로 빠진다.
 *
 * ✅ 2026-08-25 "vercel" 잠금 해제. 8/20 에 잠근 사유(`BilledCost` 가 전부 0.00)는
 *    데이터 문제가 아니라 **필드 선택 문제**였다. Pro 플랜은 포함분이라
 *    `PricingCategory: "Committed"` 로 잡히고 `BilledCost` 가 0 이 된다. 실제 원가는
 *    `EffectiveCost` 에만 있고 어댑터는 이미 그쪽을 쓴다 (lib/adapters/vercel.ts).
 *    같은 날 재확인: 8/17~8/23 charge 12,726건, EffectiveCost 합계 $21.91,
 *    날짜별로 $1.94~$5.24 정상 계상.
 */
const ENABLED_SERVICES: ServiceId[] = ["claude", "vercel", "supabase"];

/**
 * 한 서비스가 죽어도 나머지 탭은 살린다.
 *
 * 2026-08-25 에 Supabase 를 켜면서 필요해졌다. Supabase 토큰만 아직 안 넣은 상태라도
 * Claude·Vercel 탭은 멀쩡해야 하는데, `Promise.all` 은 하나만 던져도 전부 날린다.
 * 대신 실패한 서비스는 **빈 탭 + 사유** 로 남긴다 — 탭을 통째로 감추면 "왜 없지" 가
 * 되고, 페이지를 죽이면 멀쩡한 두 서비스까지 못 본다.
 *
 * 전부 실패하면 그대로 던진다. 그때는 app/page.tsx 의 에러 화면이 사유를 보여준다.
 */
export async function getAllSeries(): Promise<ServiceSeries[]> {
  const results = await Promise.all(
    ENABLED_SERVICES.map(async (service) => {
      try {
        return await getServiceSeries(service);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[data-source] ${service} 조회 실패 — 빈 탭으로 표시합니다.`, message);
        return { service, error: message };
      }
    }),
  );

  const failures = results.filter(
    (r): r is { service: ServiceId; error: string } => "error" in r,
  );
  if (failures.length === ENABLED_SERVICES.length) {
    throw new Error(
      failures.map((f) => `[${f.service}] ${f.error}`).join("\n\n"),
    );
  }

  return results.map((r) =>
    "error" in r ? emptySeries(r.service, r.error) : r,
  );
}

/** 조회에 실패한 서비스의 자리. 지표 정의가 없으므로 표·차트는 비어 있고 사유만 뜬다. */
function emptySeries(service: ServiceId, error: string): ServiceSeries {
  return {
    service,
    label: SERVICE_LABELS[service],
    breakdownLabel: "항목",
    dayBoundary: DAY_BOUNDARIES[service],
    primaryMetric: "requests",
    metricSpecs: [],
    points: [],
    source: getDataSourceMode(),
    note: `${SERVICE_LABELS[service]} 데이터를 불러오지 못했습니다.\n${error}`,
  };
}

const SERVICE_LABELS: Record<ServiceId, string> = {
  claude: "Claude",
  vercel: "Vercel",
  supabase: "Supabase",
};

// ---------------------------------------------------------------- Claude

async function getClaude(mode: DataSourceMode): Promise<ServiceSeries> {
  // 표시 이름 매핑은 목업/실API 어느 쪽이든 똑같이 적용한다 (표시 문제일 뿐이라).
  const [raw, clientKeyNames] = await Promise.all([
    mode === "mock"
      ? readMock<AnthropicRaw>("anthropic-usage.json")
      : fetchAnthropicCached(utcDay()),
    loadClientKeyNames(),
  ]);

  return {
    service: "claude",
    label: "Claude",
    breakdownLabel: "모델",
    dayBoundary: DAY_BOUNDARIES.claude,
    primaryMetric: ANTHROPIC_PRIMARY_METRIC,
    metricSpecs: ANTHROPIC_METRICS,
    points: adaptAnthropic(raw, { clientKeyNames }),
    source: mode,
    note:
      mode === "mock"
        ? "목업 데이터입니다. 실제 API 연동 시 필드명 확인 필요."
        : undefined,
    altBreakdown: {
      label: "서비스",
      notice:
        "이 표는 API 키 기준으로 나뉩니다. 키를 새로 만들거나 이름을 바꾼 시점 이후의 " +
        "데이터부터 정확하게 구분됩니다.",
      note:
        "cost_report 는 api_key_id 로 나눌 수 없어(group_by 는 description·workspace_id 뿐), " +
        "키별 비용은 같은 날·같은 모델·같은 토큰 종류의 토큰 수 비율로 안분한 추정치입니다. " +
        "토큰 수는 usage_report 실측값입니다. " +
        "표시 이름은 config/client-keys.json 에서 바꿀 수 있습니다 (작성법은 config/README.md).",
    },
  };
}

/**
 * Anthropic Admin API 두 엔드포인트를 커서 페이지네이션으로 전부 긁어온다.
 *
 * 키 검사 · 헤더 · 페이지 루프 · 에러 메시지는 lib/clients/anthropic.ts 가 맡는다.
 * 여기서는 조회 파라미터를 정하고 어댑터가 먹는 모양으로 감싸기만 한다.
 */
async function fetchAnthropic(): Promise<AnthropicRaw> {
  const { from, to } = fetchWindow();

  // bucket_width=1d 는 최대 31버킷/페이지라, 45일치는 반드시 2페이지 이상이 된다.
  const [usage, cost, apiKeys] = await Promise.all([
    fetchAllAnthropicUsageBuckets({
      starting_at: from,
      ending_at: to,
      bucket_width: "1d",
      limit: 31,
      // 키별(서비스별) 집계를 하려면 api_key_id 가 반드시 있어야 한다.
      group_by: ["model", "api_key_id", "workspace_id"],
    }),
    // ⚠️ cost_report 는 description / workspace_id 만 group_by 가능하다.
    //    api_key_id 를 넣으면 400 이 난다 (2026-08-14 실측). 키별 비용은
    //    어댑터에서 토큰 비율로 안분한다.
    fetchAllAnthropicCostBuckets({
      starting_at: from,
      ending_at: to,
      bucket_width: "1d",
      limit: 31,
      group_by: ["description", "workspace_id"],
    }),
    // 과거 사용량에는 지금 비활성인 키도 나오므로 status 필터를 걸지 않는다.
    fetchAnthropicKeyNames(),
  ]);

  return {
    usage_report: { data: usage },
    cost_report: { data: cost },
    api_keys: apiKeys,
  };
}

/**
 * 키 id → 이름 매핑. 이름 조회는 **부가 정보**라, 실패해도 대시보드 전체를 죽이지 않고
 * 빈 목록으로 넘긴다 (표에는 "(알 수 없는 키)" + id 로 뜬다).
 */
async function fetchAnthropicKeyNames() {
  try {
    return await fetchAllAnthropicApiKeys();
  } catch (error) {
    console.warn(
      "[data-source] List API Keys 실패 — 키 이름 없이 id 로 표시합니다.",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// ---------------------------------------------------------------- Vercel

/**
 * ⚠️ Vercel 만 **캐시에 넣는 값이 다르다** — 원본이 아니라 어댑터를 통과시킨 결과다.
 *
 * 2026-08-25 실측: 조회 구간(전월 1일~오늘)의 charge 원본이 **24.5MB** 였고,
 * `unstable_cache` 는 2MB 를 넘으면 저장을 거부한다
 * (`items over 2MB can not be cached`). 그 거부가 unhandledRejection 으로 터지면서
 * 매 요청마다 24MB 를 다시 받아 첫 페이지 로드가 14.5초 걸렸다.
 *
 * charge 는 하루에 수천 건이지만 날짜×프로젝트로 접고 나면 수십 줄이라, 어댑터를
 * 먼저 태우면 캐시에 들어가는 양이 1/100 이하로 줄어든다. 원본을 캐싱할 이유가
 * 없었던 것뿐이다(원본을 다시 볼 일이 있으면 scripts/fetch_vercel_usage.sh 를 쓴다).
 */
async function getVercel(mode: DataSourceMode): Promise<ServiceSeries> {
  const points =
    mode === "mock"
      ? adaptVercel(await readMock<VercelRaw>("vercel-usage.json"))
      : await fetchVercelPointsCached(utcDay());

  return {
    service: "vercel",
    label: "Vercel",
    breakdownLabel: "프로젝트",
    dayBoundary: DAY_BOUNDARIES.vercel,
    primaryMetric: VERCEL_PRIMARY_METRIC,
    metricSpecs: VERCEL_METRICS,
    points,
    source: mode,
    note:
      mode === "mock"
        ? "목업 데이터입니다. 실제 API 연동 시 필드명 확인 필요."
        : undefined,
  };
}

/**
 * Vercel 은 페이지네이션이 없다. 클라이언트가 JSONL 을 한 번에 받아 파싱해 준다.
 * teamId 는 VERCEL_TEAM_ID 에서 클라이언트가 알아서 집어간다.
 */
async function fetchVercel(): Promise<VercelRaw> {
  const { from, to } = fetchWindow();

  return { charges: await fetchVercelBillingCharges({ from, to }) };
}

// ---------------------------------------------------------------- Supabase

/**
 * Supabase 는 앞의 둘과 성격이 다르다 — 청구 금액 API 가 없어서 `costUsd` 가 추정치다.
 * 그 사실을 `note` 로 화면에 못 박아 둔다. 자세한 계산 근거는 어댑터 상단 주석 참고.
 */
async function getSupabase(mode: DataSourceMode): Promise<ServiceSeries> {
  const raw =
    mode === "mock"
      ? await readMock<SupabaseRaw>("supabase-usage.json")
      : await fetchSupabaseCached(utcDay());

  return {
    service: "supabase",
    label: "Supabase",
    breakdownLabel: "프로젝트",
    dayBoundary: DAY_BOUNDARIES.supabase,
    primaryMetric: SUPABASE_PRIMARY_METRIC,
    metricSpecs: SUPABASE_METRICS,
    points: adaptSupabase(raw),
    source: mode,
    note:
      (mode === "mock" ? "목업 데이터입니다. " : "") +
      "Supabase 공개 API 에는 청구 금액 엔드포인트가 없습니다. 표의 비용은 " +
      "조직 플랜 요금 + 프로젝트 애드온 정액을 일할 계산한 **추정치**이며, " +
      "무료 한도를 넘긴 종량 과금(대역폭·저장용량·MAU 등)은 빠져 있습니다. " +
      "정확한 청구액은 Supabase 대시보드에서 확인하세요.",
    altBreakdown: {
      label: "계정",
      notice:
        "Supabase 토큰은 계정(사람) 단위라, 계정마다 발급한 토큰을 따로 호출해 합칩니다. " +
        "여기 없는 계정은 .env 의 SUPABASE_ACCESS_TOKENS 에 토큰이 안 들어간 것입니다.",
      note: "프로젝트 표와 같은 하루를 계정 축으로 쪼갠 것이라 합계는 서로 같습니다.",
    },
  };
}

/**
 * 계정 여러 개를 동시에 훑는다. 계정 하나가 실패해도 나머지는 살아서 온다
 * (클라이언트가 `error` 를 스냅샷에 담아 준다).
 */
async function fetchSupabase(): Promise<SupabaseRaw> {
  return fetchAllSupabaseAccounts();
}

// ---------------------------------------------------------------- 캐시

/**
 * 캐시 키로 쓸 UTC 날짜(YYYY-MM-DD).
 *
 * 두 벤더 모두 **하루치가 확정된 뒤에야** 그 날짜 버킷을 돌려준다. 그래서 갱신 주기를
 * "마지막 호출로부터 24시간" 같은 타이머로 잡으면 확정 시점과 어긋나 최대 하루를
 * 헛돈다. 날짜 문자열을 인자로 넘기면 `unstable_cache` 가 이걸 키에 포함하므로,
 * UTC 자정이 지나는 순간 자동으로 캐시 미스가 나고 그때 한 번만 새로 받는다.
 */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * ⚠️ 캐싱 범위를 **벤더 API 호출로만** 좁힌 것은 의도적이다.
 *
 * 페이지 전체를 캐싱하면 `config/client-keys.json` 을 고쳐도 하루 동안 반영되지
 * 않는다. 그 파일은 "저장하고 새로고침하면 바로 보인다" 가 전제라(lib/client-keys.ts
 * 주석 참고) 캐시 밖에 두어야 한다. 무거운 건 어차피 네트워크 쪽이다.
 *
 * `revalidate` 는 날짜 키가 안 바뀌는 동안의 상한선일 뿐이다. 실제 갱신 시점은
 * 위 `utcDay()` 가 정한다.
 */
const DAY_SECONDS = 24 * 60 * 60;

const fetchAnthropicCached = unstable_cache(
  async (_utcDay: string) => fetchAnthropic(),
  ["anthropic-raw"],
  { revalidate: DAY_SECONDS, tags: ["usage", "usage:claude"] },
);

/**
 * 캐시 키 이름이 `vercel-points` 인 것은 실수가 아니다 — 원본이 아니라 어댑터 결과를
 * 담는다는 뜻이다. 이유는 위 getVercel 주석 참고 (2MB 제한).
 */
const fetchVercelPointsCached = unstable_cache(
  async (_utcDay: string) => adaptVercel(await fetchVercel()),
  ["vercel-points"],
  { revalidate: DAY_SECONDS, tags: ["usage", "usage:vercel"] },
);

/**
 * Supabase 는 프로젝트 수 × 2 만큼 요청이 나가고 분당 60요청 제한이 있어서,
 * 캐시가 앞의 둘보다 더 중요하다. 날짜 키 방식은 동일하다.
 */
const fetchSupabaseCached = unstable_cache(
  async (_utcDay: string) => fetchSupabase(),
  ["supabase-raw"],
  { revalidate: DAY_SECONDS, tags: ["usage", "usage:supabase"] },
);

// ---------------------------------------------------------------- 공통

async function readMock<T>(file: string): Promise<T> {
  const p = path.join(process.cwd(), "mock", file);
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}

/**
 * 조회 구간. 전월 동기 대비를 계산하려면 이번 달 + 전월 전체가 필요하므로
 * 전월 1일부터 오늘까지 받는다.
 */
function fetchWindow() {
  const now = new Date();
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0),
  );
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return { from: from.toISOString(), to: to.toISOString() };
}

// ---------------------------------------------------------------- 실시간(KST)

/**
 * 미니 위젯(/mini)이 쓰는 진입점들.
 *
 * 본문 대시보드는 "확정된 하루" 를 보여주므로 하루 단위 캐시로 충분하지만,
 * 미니 위젯은 **진행 중인 KST 오늘**을 1분 간격으로 본다. 캐시 수명이 달라서
 * 호출 경로를 따로 둔다. 자세한 배경은 lib/live.ts 주석 참고.
 */

/** 단가 역산용 원본(UTC 하루 단위). 하루 캐시를 그대로 재사용한다. */
export async function getAnthropicRaw(): Promise<AnthropicRaw> {
  const mode = getDataSourceMode();
  return mode === "mock"
    ? readMock<AnthropicRaw>("anthropic-usage.json")
    : fetchAnthropicCached(utcDay());
}

/**
 * 캐시 키로 쓸 UTC 분(YYYY-MM-DDTHH:MM).
 *
 * `revalidate` 초를 쓰지 않고 분 문자열을 키에 넣는 이유는 `utcDay()` 와 같다 —
 * "마지막 호출 + N초" 는 탭이 여러 개면 갱신 시점이 제각각이 된다. 분이 바뀌는
 * 순간에만 미스가 나게 하면 탭이 몇 개든 벤더 호출은 분당 1회로 고정된다.
 */
export function utcMinute(now: Date = new Date()): string {
  return now.toISOString().slice(0, 16);
}

/**
 * KST 오늘 구간의 1시간 버킷. `group_by` 에 api_key_id 가 들어가야 키별로 쪼갤 수 있다.
 *
 * 한 페이지 최대 168버킷이라 24시간은 언제나 1페이지지만, 커서 루프를 쓰는 쪽이
 * 안전하다(진행 중 버킷 포함 여부가 바뀌어도 상관없다).
 */
async function fetchAnthropicHourly(from: string, to: string) {
  return fetchAllAnthropicUsageBuckets({
    starting_at: from,
    ending_at: to,
    bucket_width: "1h",
    limit: 24,
    group_by: ["model", "api_key_id"],
  });
}

const fetchAnthropicHourlyCached = unstable_cache(
  async (_utcMinute: string, from: string, to: string) =>
    fetchAnthropicHourly(from, to),
  ["anthropic-hourly"],
  // 분 문자열이 키에 들어가므로 이 값은 상한선일 뿐이다.
  { revalidate: 120, tags: ["usage", "usage:claude", "live"] },
);

export async function getAnthropicHourly(from: string, to: string) {
  return fetchAnthropicHourlyCached(utcMinute(), from, to);
}
