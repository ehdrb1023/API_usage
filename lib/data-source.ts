import { promises as fs } from "node:fs";
import path from "node:path";

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
  return service === "claude" ? getClaude(mode) : getVercel(mode);
}

/**
 * 화면에 띄울 서비스. 여기서 빼면 탭·데이터·API 호출이 통째로 빠진다.
 *
 * ⚠️ 2026-08-20 현재 "vercel" 을 잠가 둔 상태다. Billing API 가 8/15~8/19 구간
 *    charge 를 1만 건 넘게 돌려주면서 `BilledCost` 는 전부 0.00 으로만 찍힌다.
 *    원인 확인 전까지 0원짜리 표를 띄우지 않는다.
 *    되살리려면 아래 배열에 "vercel" 을 다시 넣기만 하면 된다.
 */
const ENABLED_SERVICES: ServiceId[] = ["claude"];

export async function getAllSeries(): Promise<ServiceSeries[]> {
  return Promise.all(ENABLED_SERVICES.map(getServiceSeries));
}

// ---------------------------------------------------------------- Claude

async function getClaude(mode: DataSourceMode): Promise<ServiceSeries> {
  // 표시 이름 매핑은 목업/실API 어느 쪽이든 똑같이 적용한다 (표시 문제일 뿐이라).
  const [raw, clientKeyNames] = await Promise.all([
    mode === "mock"
      ? readMock<AnthropicRaw>("anthropic-usage.json")
      : fetchAnthropic(),
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

async function getVercel(mode: DataSourceMode): Promise<ServiceSeries> {
  const raw =
    mode === "mock"
      ? await readMock<VercelRaw>("vercel-usage.json")
      : await fetchVercel();

  return {
    service: "vercel",
    label: "Vercel",
    breakdownLabel: "프로젝트",
    dayBoundary: DAY_BOUNDARIES.vercel,
    primaryMetric: VERCEL_PRIMARY_METRIC,
    metricSpecs: VERCEL_METRICS,
    points: adaptVercel(raw),
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
