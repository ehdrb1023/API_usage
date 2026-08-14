"use client";

import type { Kpis } from "@/lib/analytics";
import { RANGES } from "@/lib/analytics";
import { formatMetric, formatPct, formatUsd } from "@/lib/format";
import type { RangeId, ServiceSeries } from "@/lib/types";

type Props = {
  series: ServiceSeries;
  kpis: Kpis;
  range: RangeId;
  anchor: string;
};

function Card({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub: React.ReactNode;
  valueColor?: string;
}) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
        {label}
      </p>
      <p
        className="mt-1.5 text-2xl font-semibold tracking-tight"
        style={{ color: valueColor ?? "var(--text-primary)" }}
      >
        {value}
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        {sub}
      </p>
    </div>
  );
}

export default function StatCards({ series, kpis, range, anchor }: Props) {
  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? "";
  const monthNum = anchor ? Number(anchor.slice(5, 7)) : 0;
  const dayNum = anchor ? Number(anchor.slice(8, 10)) : 0;
  const prevMonthNum = monthNum === 1 ? 12 : monthNum - 1;

  const primarySpec =
    series.metricSpecs.find((m) => m.key === series.primaryMetric) ??
    series.metricSpecs[0];

  // 비용이 오르는 건 나쁜 방향이므로 상승=빨강, 하락=초록.
  const momColor =
    kpis.momPct == null
      ? undefined
      : kpis.momPct > 0
        ? "var(--delta-up-bad)"
        : "var(--delta-down-good)";

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card
        label="이번 달 누적 비용"
        value={formatUsd(kpis.mtdCostUsd)}
        sub={`${monthNum}월 1–${dayNum}일`}
      />

      <Card
        label="전월 동기 대비"
        value={kpis.momPct == null ? "—" : formatPct(kpis.momPct)}
        valueColor={momColor}
        sub={
          kpis.momPct == null ? (
            "전월 데이터 없음"
          ) : (
            <>
              <span aria-hidden="true">{kpis.momPct > 0 ? "▲" : "▼"} </span>
              {prevMonthNum}월 1–{dayNum}일 {formatUsd(kpis.prevMonthSamePeriodUsd)}
            </>
          )
        }
      />

      <Card
        label={`일평균 사용량 (${primarySpec.label})`}
        value={formatMetric(kpis.avgDailyPrimary, primarySpec)}
        sub={`${rangeLabel} 기준 · 일평균 ${formatUsd(kpis.avgDailyCostUsd)}`}
      />

      <Card
        label="급증일"
        value={`${kpis.spikeCount}일`}
        valueColor={kpis.spikeCount > 0 ? "var(--status-critical)" : undefined}
        sub={`${rangeLabel} 중 전일 대비 +20% 이상`}
      />
    </div>
  );
}
