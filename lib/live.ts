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
  ANTHROPIC_PRIMARY_METRIC,
  adaptAnthropic,
  type AnthropicRaw,
  type UsageResult,
} from "@/lib/adapters/anthropic";
import { SUPABASE_METRICS, SUPABASE_PRIMARY_METRIC } from "@/lib/adapters/supabase";
import { VERCEL_METRICS, VERCEL_PRIMARY_METRIC } from "@/lib/adapters/vercel";
import { computeTokenRates, estimateCostResults } from "@/lib/anthropic-rates";
import { loadClientKeyNames } from "@/lib/client-keys";
import type { Fresh } from "@/lib/vendor-fallback";
import {
  getAnthropicHourly,
  getAnthropicRaw,
  getDataSourceMode,
  getServiceSeries,
  liveRefreshSeconds,
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
    // 폴링 주기를 클라이언트가 정하면 서버 캐시 구간과 어긋난다. 서버가 정해 준다.
    refreshSeconds: liveRefreshSeconds(),
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
      primaryMetric: COST_METRIC_KEY,
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
  const refreshSeconds = liveRefreshSeconds();

  const [dailyFresh, clientKeyNames] = await Promise.all([
    getAnthropicRaw(),
    loadClientKeyNames(),
  ]);
  const daily = dailyFresh.value;
  const rates = computeTokenRates(daily);

  const hourly =
    mode === "mock"
      ? ({
          value: mockHourlyStandIn(daily),
          at: Date.now(),
          stale: false,
        } as Fresh<unknown>)
      : ((await getAnthropicHourly(window.from, window.to)) as Fresh<unknown>);

  const usageResults =
    mode === "mock"
      ? (hourly.value as UsageResult[])
      : (hourly.value as { results: UsageResult[] }[]).flatMap((b) => b.results);


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

  /**
   * 선택창에는 **오늘 안 쓴 키·모델도** 떠야 한다. 지금 0 인 거래처를 골라 두고
   * 언제 쓰기 시작하는지 보는 게 이 위젯의 용도 중 하나이기 때문이다.
   * 그래서 조회 구간 전체에서 한 번이라도 등장한 항목을 0 으로 채워 붙인다.
   */
  const history = adaptAnthropic(daily, { clientKeyNames });
  const metricKeys = ANTHROPIC_METRICS.map((m) => m.key);

  return {
    id: "claude",
    label: "Claude",
    date: window.date,
    boundary: "KST",
    boundaryNote: `한국시간 ${window.date} 00:00 부터 지금까지 (매일 자정 리셋)`,
    freshness: hourly.stale
      ? `갱신 실패 — ${new Date(hourly.at).toISOString().slice(11, 16)}Z 값입니다. ` +
        `사유: ${hourly.reason ?? "알 수 없음"}`
      : `${refreshSeconds}초마다 갱신 · 토큰은 실측, 비용은 추정`,
    stale: hourly.stale,
    asOf: new Date(hourly.at).toISOString(),
    primaryMetric: ANTHROPIC_PRIMARY_METRIC,
    metricSpecs: [
      { ...COST_SPEC, estimated: true },
      ...toLiveSpecs(ANTHROPIC_METRICS),
    ],
    groups: [
      totalGroup(point),
      {
        key: "model",
        label: "모델별",
        entries: withCatalog(entries(point?.items), catalog(history, "items"), metricKeys),
      },
      {
        key: "key",
        label: "API 키별",
        entries: withCatalog(entries(point?.altItems), catalog(history, "altItems"), metricKeys),
      },
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
  {
    boundary: string;
    boundaryNote: string;
    freshness: string;
    specs: MetricSpec[];
    primary: string;
  }
> = {
  vercel: {
    boundary: "PT",
    boundaryNote:
      "Vercel 은 미 태평양시 자정(KST 오후 4시)에 하루가 바뀝니다. KST 하루로 자를 수 없습니다.",
    freshness: "하루 1회 갱신 (원본 charge 가 커서 분당 호출 불가)",
    specs: VERCEL_METRICS,
    primary: VERCEL_PRIMARY_METRIC,
  },
  supabase: {
    boundary: "UTC",
    boundaryNote:
      "Supabase 사용량 버킷은 UTC 자정(KST 오전 9시) 기준이며 1일 단위로만 나옵니다.",
    freshness: "하루 1회 갱신 · 비용은 플랜 요금 일할 추정치",
    specs: SUPABASE_METRICS,
    primary: SUPABASE_PRIMARY_METRIC,
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

  const metricKeys = meta.specs.map((m) => m.key);
  const groups: LiveGroup[] = [
    totalGroup(point),
    {
      key: "project",
      label: `${series.breakdownLabel}별`,
      entries: withCatalog(
        entries(point?.items),
        catalog(series.points, "items"),
        metricKeys,
      ),
    },
  ];
  if (series.points.some((p) => p.altItems?.length)) {
    groups.push({
      key: "alt",
      label: `${series.altBreakdown?.label ?? "보조"}별`,
      entries: withCatalog(
        entries(point?.altItems),
        catalog(series.points, "altItems"),
        metricKeys,
      ),
    });
  }

  return {
    id,
    label: series.label,
    date: point?.date ?? "",
    boundary: meta.boundary,
    boundaryNote: meta.boundaryNote,
    freshness: meta.freshness,
    primaryMetric: meta.primary,
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
    badge: item.badge,
    metrics: { ...item.metrics, [COST_METRIC_KEY]: item.costUsd },
  }));
}

/** 조회 구간 전체에서 한 번이라도 등장한 항목 목록 (중복 제거, 라벨은 첫 등장 기준). */
function catalog(
  points: DailyPoint[],
  axis: "items" | "altItems",
): LiveEntry[] {
  const seen = new Map<string, LiveEntry>();
  for (const p of points) {
    for (const item of p[axis] ?? []) {
      if (seen.has(item.key)) continue;
      seen.set(item.key, {
        id: item.key,
        label: item.label,
        hint: item.hint,
        badge: item.badge,
        metrics: {},
      });
    }
  }
  return [...seen.values()];
}

/**
 * 오늘 값이 있는 항목을 먼저, 오늘 0 인 항목을 뒤에 붙인다.
 *
 * 뒤쪽은 지표를 전부 0 으로 채운다 — `undefined` 로 두면 미니 창이 "—" 를 띄우는데,
 * "오늘 아직 안 씀" 과 "그런 항목이 없음" 은 다른 얘기다. $0.00 이라고 적어야 맞다.
 */
function withCatalog(
  today: LiveEntry[],
  all: LiveEntry[],
  metricKeys: string[],
): LiveEntry[] {
  const have = new Set(today.map((e) => e.id));
  const zeros = Object.fromEntries([
    [COST_METRIC_KEY, 0],
    ...metricKeys.map((k) => [k, 0] as const),
  ]);

  const idle = all
    .filter((e) => !have.has(e.id))
    .map((e) => ({ ...e, idle: true, metrics: { ...zeros } }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));

  return [...today, ...idle];
}
