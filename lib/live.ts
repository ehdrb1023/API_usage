/**
 * 미니 위젯(/mini)이 1분마다 받아 가는 "오늘" 스냅샷.
 *
 * ── 세 서비스의 "오늘" 이 서로 다르다 ──────────────────────────────────────
 *   Claude    KST 오늘 (00:00 KST = 15:00 UTC). 1시간 버킷을 모아 정확히 재구성.
 *   Vercel    미 태평양시 오늘. charge 자체가 PT 자정으로 끊겨 나와서 KST 로 자를
 *             방법이 없다. 억지로 환산하는 대신 PT 기준임을 화면에 적는다.
 *   Supabase  UTC 오늘. 사용량 버킷이 1day 고정이라 역시 자를 수 없다.
 *
 * 세 개를 전부 "KST 오늘" 이라고 우기는 편이 화면은 깔끔하지만, 그건 없는 정확도를
 * 지어내는 것이다. 각 줄에 기준을 배지로 달아 두고 무엇이 KST 인지 명시한다.
 *
 * ── 갱신 주기도 서로 다르다 ────────────────────────────────────────────────
 *   Claude    1분. usage_report 는 진행 중인 시간 버킷도 돌려준다.
 *   Vercel    하루 1회. 원본 charge 가 조회 구간에서 24MB 라 분당 호출은 불가능하고,
 *             애초에 하루 단위로만 갱신된다.
 *   Supabase  하루 1회. 분당 60요청 제한 + 1day 버킷.
 *
 * 서버 전용이다 (API 키·fs). 클라이언트에서 import 금지 — 타입은 lib/live-types.ts.
 */

import {
  ANTHROPIC_METRICS,
  adaptAnthropic,
  type AnthropicRaw,
  type UsageResult,
} from "@/lib/adapters/anthropic";
import { SUPABASE_METRICS } from "@/lib/adapters/supabase";
import { VERCEL_METRICS } from "@/lib/adapters/vercel";
import { computeTokenRates, estimateCostResults } from "@/lib/anthropic-rates";
import { loadClientKeyNames } from "@/lib/client-keys";
import {
  getAnthropicHourly,
  getAnthropicRaw,
  getDataSourceMode,
  getServiceSeries,
} from "@/lib/data-source";
import { kstDay, kstTime, kstTodayWindow } from "@/lib/kst";
import {
  COST_METRIC_KEY,
  type LiveEntry,
  type LiveGroup,
  type LiveMetricSpec,
  type LiveService,
  type LiveSnapshot,
} from "@/lib/live-types";
import type { BreakdownItem, DailyPoint, MetricSpec, ServiceId } from "@/lib/types";

const COST_SPEC: LiveMetricSpec = {
  key: COST_METRIC_KEY,
  label: "비용",
  format: "usd",
};

export async function getLiveSnapshot(now: Date = new Date()): Promise<LiveSnapshot> {
  const [claude, vercel, supabase] = await Promise.all([
    guard("claude", "Claude", () => getClaudeLive(now)),
    guard("vercel", "Vercel", () => getVendorDayLive("vercel")),
    guard("supabase", "Supabase", () => getVendorDayLive("supabase")),
  ]);

  return {
    updatedAt: now.toISOString(),
    kstDate: kstDay(now),
    kstTime: kstTime(now),
    source: getDataSourceMode(),
    services: [claude, vercel, supabase],
  };
}

/** 한 서비스가 죽어도 나머지 줄은 계속 보여야 한다 (getAllSeries 와 같은 원칙). */
async function guard(
  id: ServiceId,
  label: string,
  build: () => Promise<LiveService>,
): Promise<LiveService> {
  try {
    return await build();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[live] ${id} 조회 실패`, message);
    return {
      id,
      label,
      date: "",
      boundary: "—",
      boundaryNote: "",
      freshness: "",
      metricSpecs: [COST_SPEC],
      groups: [],
      error: message,
    };
  }
}

// ---------------------------------------------------------------- Claude (KST)

/**
 * KST 오늘 = 1시간 버킷을 모은 것. 비용만 단가 역산으로 얹는다.
 *
 * 시간 버킷을 **cost_report 모양과 함께 하나의 하루 버킷으로 위조해서**
 * 기존 `adaptAnthropic()` 에 그대로 통과시킨다. 모델별 집계·키별 비용 안분·
 * 키 이름 매핑이 전부 거기 있어서, KST 전용 집계 코드를 새로 쓰면 같은 로직이
 * 두 벌이 되고 둘이 어긋나기 시작한다.
 */
async function getClaudeLive(now: Date): Promise<LiveService> {
  const window = kstTodayWindow(now);
  const mode = getDataSourceMode();

  const [daily, clientKeyNames] = await Promise.all([
    getAnthropicRaw(),
    loadClientKeyNames(),
  ]);
  const rates = computeTokenRates(daily);

  const usageResults =
    mode === "mock"
      ? mockHourlyStandIn(daily)
      : (await getAnthropicHourly(window.from, window.to)).flatMap(
          (b) => b.results as UsageResult[],
        );

  const synthetic: AnthropicRaw = {
    // starting_at 의 앞 10글자가 곧 날짜다 — KST 날짜를 그대로 박아 넣는다.
    usage_report: {
      data: [
        {
          starting_at: `${window.date}T00:00:00Z`,
          ending_at: `${window.date}T23:59:59Z`,
          results: usageResults,
        },
      ],
    },
    cost_report: {
      data: [
        {
          starting_at: `${window.date}T00:00:00Z`,
          ending_at: `${window.date}T23:59:59Z`,
          results: estimateCostResults(usageResults, rates),
        },
      ],
    },
    api_keys: daily.api_keys,
  };

  const point = adaptAnthropic(synthetic, { clientKeyNames })[0];

  return {
    id: "claude",
    label: "Claude",
    date: window.date,
    boundary: "KST",
    boundaryNote: `한국시간 ${window.date} 00:00 부터 지금까지 (매일 자정 리셋)`,
    freshness: "1분마다 갱신 · 토큰은 실측, 비용은 추정",
    metricSpecs: [
      { ...COST_SPEC, estimated: true },
      ...toLiveSpecs(ANTHROPIC_METRICS),
    ],
    groups: [
      totalGroup(point),
      { key: "model", label: "모델별", entries: entries(point?.items) },
      { key: "key", label: "API 키별", entries: entries(point?.altItems) },
    ],
  };
}

/**
 * 목업 모드용. mock/anthropic-usage.json 에는 시간 버킷이 없으니 **가장 최근 날짜**의
 * 일 버킷을 "오늘" 인 척 쓴다. 화면 배치를 보려고 있는 경로라 정확도는 상관없다.
 */
function mockHourlyStandIn(raw: AnthropicRaw): UsageResult[] {
  const buckets = raw.usage_report?.data ?? [];
  const last = buckets[buckets.length - 1];
  return (last?.results ?? []) as UsageResult[];
}

// ---------------------------------------------- Vercel · Supabase (벤더 기준일)

const VENDOR_DAY: Record<
  "vercel" | "supabase",
  { boundary: string; boundaryNote: string; freshness: string; specs: MetricSpec[] }
> = {
  vercel: {
    boundary: "PT",
    boundaryNote:
      "Vercel 은 미 태평양시 자정(KST 오후 4시)에 하루가 바뀝니다. KST 하루로 자를 수 없습니다.",
    freshness: "하루 1회 갱신 (원본 charge 가 커서 분당 호출 불가)",
    specs: VERCEL_METRICS,
  },
  supabase: {
    boundary: "UTC",
    boundaryNote:
      "Supabase 사용량 버킷은 UTC 자정(KST 오전 9시) 기준이며 1일 단위로만 나옵니다.",
    freshness: "하루 1회 갱신 · 비용은 플랜 요금 일할 추정치",
    specs: SUPABASE_METRICS,
  },
};

async function getVendorDayLive(id: "vercel" | "supabase"): Promise<LiveService> {
  const series = await getServiceSeries(id);
  if (series.points.length === 0 && series.note) {
    throw new Error(series.note);
  }

  // points 는 날짜 오름차순이라 마지막이 "오늘"(벤더 기준일)이다.
  const point = series.points[series.points.length - 1];
  const meta = VENDOR_DAY[id];

  const groups: LiveGroup[] = [
    totalGroup(point),
    {
      key: "project",
      label: `${series.breakdownLabel}별`,
      entries: entries(point?.items),
    },
  ];
  if (point?.altItems?.length) {
    groups.push({
      key: "alt",
      label: `${series.altBreakdown?.label ?? "보조"}별`,
      entries: entries(point.altItems),
    });
  }

  return {
    id,
    label: series.label,
    date: point?.date ?? "",
    boundary: meta.boundary,
    boundaryNote: meta.boundaryNote,
    freshness: meta.freshness,
    metricSpecs: [
      { ...COST_SPEC, estimated: id === "supabase" },
      ...toLiveSpecs(meta.specs),
    ],
    groups,
  };
}

// ---------------------------------------------------------------- 공통 변환

function toLiveSpecs(specs: MetricSpec[]): LiveMetricSpec[] {
  return specs.map((s) => ({
    key: s.key,
    label: s.label,
    format: s.format,
    unit: s.unit,
  }));
}

function totalGroup(point: DailyPoint | undefined): LiveGroup {
  return {
    key: "total",
    label: "전체",
    entries: [
      {
        id: "total",
        label: "전체",
        metrics: { ...(point?.metrics ?? {}), [COST_METRIC_KEY]: point?.costUsd ?? 0 },
      },
    ],
  };
}

function entries(items: BreakdownItem[] | undefined): LiveEntry[] {
  return (items ?? []).map((item) => ({
    id: item.key,
    label: item.label,
    hint: item.hint,
    metrics: { ...item.metrics, [COST_METRIC_KEY]: item.costUsd },
  }));
}
