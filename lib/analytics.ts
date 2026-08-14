import type { DailyPoint, RangeId, ServiceSeries } from "@/lib/types";

/** 전일 대비 이만큼 이상 오르면 빨간색으로 강조한다. */
export const SPIKE_THRESHOLD = 0.2;

export const RANGES: { id: RangeId; label: string }[] = [
  { id: "7d", label: "7일" },
  { id: "30d", label: "30일" },
  { id: "mtd", label: "이번 달" },
];

/**
 * "오늘"을 시스템 시계가 아니라 데이터의 마지막 날로 잡는다.
 * 목업이든 실 API 든 최신 버킷이 기준이 되므로, 데이터가 하루 늦게 집계돼도
 * 화면이 빈 구간을 보여주지 않는다.
 */
export function anchorDate(points: DailyPoint[]): string {
  return points.length ? points[points.length - 1].date : "";
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 선택 구간의 [시작, 끝] 날짜 (양끝 포함). */
export function rangeBounds(anchor: string, range: RangeId): [string, string] {
  if (!anchor) return ["", ""];
  if (range === "mtd") return [`${anchor.slice(0, 7)}-01`, anchor];
  const days = range === "7d" ? 7 : 30;
  return [addDays(anchor, -(days - 1)), anchor];
}

export function sliceRange(points: DailyPoint[], range: RangeId): DailyPoint[] {
  const [from, to] = rangeBounds(anchorDate(points), range);
  return points.filter((p) => p.date >= from && p.date <= to);
}

/**
 * 전일 대비 증가율. 구간 첫날도 제대로 비교되도록 **전체 시계열** 기준으로 계산한 뒤
 * 화면 구간만 잘라 쓴다. 구간 안에서만 계산하면 첫날은 항상 비교 대상이 없어진다.
 */
export function computeDeltas(points: DailyPoint[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (let i = 0; i < points.length; i++) {
    const prev = i > 0 ? points[i - 1].costUsd : null;
    const cur = points[i].costUsd;
    out.set(points[i].date, prev && prev > 0 ? (cur - prev) / prev : null);
  }
  return out;
}

export function isSpike(delta: number | null | undefined): boolean {
  return delta != null && delta >= SPIKE_THRESHOLD;
}

export type Kpis = {
  /** 이번 달 1일 ~ anchor 누적 비용 */
  mtdCostUsd: number;
  /** 전월 같은 기간(1일 ~ 같은 일자) 누적 비용 */
  prevMonthSamePeriodUsd: number;
  /** 전월 동기 대비 증감률. 전월 데이터가 없으면 null */
  momPct: number | null;
  /** 선택 구간의 일평균 대표 사용량 */
  avgDailyPrimary: number;
  /** 선택 구간의 일평균 비용 */
  avgDailyCostUsd: number;
  /** 선택 구간에서 전일 대비 20% 이상 오른 날 수 */
  spikeCount: number;
  /** 전월 동기 구간이 실제로 데이터에 존재하는지 */
  hasPrevMonth: boolean;
};

export function computeKpis(series: ServiceSeries, range: RangeId): Kpis {
  const points = series.points;
  const anchor = anchorDate(points);
  const inRange = sliceRange(points, range);
  const deltas = computeDeltas(points);

  const monthPrefix = anchor.slice(0, 7);
  const dayOfMonth = Number(anchor.slice(8, 10));

  // 전월 같은 일자까지. 예: 8/14 기준이면 7/1 ~ 7/14
  const [py, pm] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7))];
  const prev = new Date(Date.UTC(py, pm - 2, 1));
  const prevPrefix = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;

  let mtdCostUsd = 0;
  let prevMonthSamePeriodUsd = 0;
  let hasPrevMonth = false;

  for (const p of points) {
    if (p.date.startsWith(monthPrefix)) {
      mtdCostUsd += p.costUsd;
    } else if (p.date.startsWith(prevPrefix)) {
      hasPrevMonth = true;
      if (Number(p.date.slice(8, 10)) <= dayOfMonth) {
        prevMonthSamePeriodUsd += p.costUsd;
      }
    }
  }

  const momPct =
    hasPrevMonth && prevMonthSamePeriodUsd > 0
      ? (mtdCostUsd - prevMonthSamePeriodUsd) / prevMonthSamePeriodUsd
      : null;

  const n = inRange.length || 1;
  const avgDailyPrimary =
    inRange.reduce((s, p) => s + (p.metrics[series.primaryMetric] ?? 0), 0) / n;
  const avgDailyCostUsd = inRange.reduce((s, p) => s + p.costUsd, 0) / n;
  const spikeCount = inRange.filter((p) => isSpike(deltas.get(p.date))).length;

  return {
    mtdCostUsd,
    prevMonthSamePeriodUsd,
    momPct,
    avgDailyPrimary,
    avgDailyCostUsd,
    spikeCount,
    hasPrevMonth,
  };
}

export type BreakdownRow = {
  key: string;
  label: string;
  costUsd: number;
  costShare: number;
  metrics: Record<string, number>;
};

/** 선택 구간의 모델별 / 프로젝트별 합계. */
export function computeBreakdown(
  series: ServiceSeries,
  range: RangeId,
): BreakdownRow[] {
  const acc = new Map<string, BreakdownRow>();
  let total = 0;

  for (const p of sliceRange(series.points, range)) {
    for (const item of p.items) {
      let row = acc.get(item.key);
      if (!row) {
        row = { key: item.key, label: item.label, costUsd: 0, costShare: 0, metrics: {} };
        acc.set(item.key, row);
      }
      row.costUsd += item.costUsd;
      total += item.costUsd;
      for (const [k, v] of Object.entries(item.metrics)) {
        row.metrics[k] = (row.metrics[k] ?? 0) + v;
      }
    }
  }

  return [...acc.values()]
    .map((r) => ({ ...r, costShare: total > 0 ? r.costUsd / total : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd);
}
