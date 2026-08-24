"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { SPIKE_THRESHOLD, isSpike } from "@/lib/analytics";
import {
  formatDateLong,
  formatDateShort,
  formatPct,
  formatTokens,
  formatUsd,
  formatUsdAxis,
} from "@/lib/format";
import type { DailyPoint } from "@/lib/types";

type Props = {
  points: DailyPoint[];
  deltas: Map<string, number | null>;
  /**
   * 차트가 지금 무엇을 보여주는지. 기본은 서비스명("Claude"), 표에서 키를 선택하면
   * 그 키의 표시 이름("삼성전자-테스트")이 들어온다.
   */
  subjectLabel: string;
  bounds: [string, string];
  /** Claude에서는 비용 선 대신 모델/API 키별 토큰 누적 막대를 그린다. */
  usageBreakdown?: boolean;
  breakdownLabel?: string;
  metricKey?: string;
};

type Row = {
  date: string;
  cost: number;
  delta: number | null;
  spike: boolean;
};

const BAR_COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
];

export default function TrendChart({
  points,
  deltas,
  subjectLabel,
  bounds,
  usageBreakdown = false,
  breakdownLabel = "모델",
  metricKey = "totalTokens",
}: Props) {
  if (usageBreakdown) {
    return (
      <UsageBarChart
        points={points}
        subjectLabel={subjectLabel}
        bounds={bounds}
        breakdownLabel={breakdownLabel}
        metricKey={metricKey}
      />
    );
  }

  const rows: Row[] = points.map((p) => {
    const delta = deltas.get(p.date) ?? null;
    return { date: p.date, cost: p.costUsd, delta, spike: isSpike(delta) };
  });

  const spikeCount = rows.filter((r) => r.spike).length;

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">{subjectLabel} 일별 비용 추이</h2>
        <p className="text-xs tabular" style={{ color: "var(--text-muted)" }}>
          {bounds[0]} ~ {bounds[1]}
        </p>
      </div>

      {/* 색만으로 의미를 전달하지 않도록, 강조 규칙을 글로도 적는다 */}
      <p className="mb-3 flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
        <span
          aria-hidden="true"
          className="inline-block size-2 rounded-full"
          style={{ background: "var(--status-critical)" }}
        />
        전일 대비 +{Math.round(SPIKE_THRESHOLD * 100)}% 이상 급증한 날
        {spikeCount > 0 ? ` — 이 구간에 ${spikeCount}일` : " — 이 구간에는 없음"}
      </p>

      <div style={{ width: "100%", height: 300 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid
              vertical={false}
              stroke="var(--grid)"
              strokeDasharray="0"
            />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateShort}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={formatUsdAxis}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={58}
            />
            <Tooltip
              cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
              content={<ChartTooltip />}
            />
            <Line
              type="monotone"
              dataKey="cost"
              name="일별 비용"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={<SpikeDot />}
              activeDot={{
                r: 4,
                fill: "var(--series-1)",
                stroke: "var(--surface-1)",
                strokeWidth: 2,
              }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

type UsageSeries = { key: string; dataKey: string; label: string; color: string };
type UsageRow = { date: string; [dataKey: string]: string | number };

function UsageBarChart({
  points,
  subjectLabel,
  bounds,
  breakdownLabel,
  metricKey,
}: {
  points: DailyPoint[];
  subjectLabel: string;
  bounds: [string, string];
  breakdownLabel: string;
  metricKey: string;
}) {
  const totals = new Map<string, { label: string; value: number }>();
  for (const point of points) {
    for (const item of point.items) {
      const current = totals.get(item.key) ?? { label: item.label, value: 0 };
      current.value += item.metrics[metricKey] ?? 0;
      totals.set(item.key, current);
    }
  }

  const series: UsageSeries[] = [...totals.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .map(([key, item], index) => ({
      key,
      dataKey: `usage_${index}`,
      label: item.label,
      color: BAR_COLORS[index % BAR_COLORS.length],
    }));

  const seriesByKey = new Map(series.map((item) => [item.key, item]));
  const rows: UsageRow[] = points.map((point) => {
    const row: UsageRow = { date: point.date };
    for (const item of series) row[item.dataKey] = 0;
    for (const item of point.items) {
      const definition = seriesByKey.get(item.key);
      if (definition) row[definition.dataKey] = item.metrics[metricKey] ?? 0;
    }
    return row;
  });

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h2 className="text-sm font-semibold">{subjectLabel} 일별 토큰 사용량</h2>
          <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            {breakdownLabel}별 누적 막대
          </p>
        </div>
        <p className="text-xs tabular" style={{ color: "var(--text-muted)" }}>
          {bounds[0]} ~ {bounds[1]}
        </p>
      </div>

      <div style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="0" />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateShort}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={formatTokens}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={58}
            />
            <Tooltip cursor={{ fill: "var(--hover)" }} content={<UsageTooltip />} />
            {series.map((item) => (
              <Bar
                key={item.key}
                dataKey={item.dataKey}
                name={item.label}
                stackId="tokens"
                fill={item.color}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {series.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
          {series.map((item) => (
            <span key={item.key} className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-sm" style={{ background: item.color }} />
              <span style={{ color: "var(--text-secondary)" }}>{item.label}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function UsageTooltip({
  active,
  label,
  payload,
}: {
  active?: boolean;
  label?: string;
  payload?: { name?: string; value?: number; color?: string }[];
}) {
  if (!active || !payload?.length || !label) return null;
  const visible = payload.filter((item) => (item.value ?? 0) > 0).reverse();
  const total = visible.reduce((sum, item) => sum + (item.value ?? 0), 0);

  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-lg"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        color: "var(--text-primary)",
      }}
    >
      <p className="mb-1.5" style={{ color: "var(--text-secondary)" }}>
        {formatDateLong(label)}
      </p>
      {visible.map((item) => (
        <div key={item.name} className="flex min-w-44 items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-sm" style={{ background: item.color }} />
            {item.name}
          </span>
          <strong className="tabular">{formatTokens(item.value ?? 0)}</strong>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between gap-4 border-t pt-1.5" style={{ borderColor: "var(--border)" }}>
        <span>합계</span>
        <strong className="tabular">{formatTokens(total)}</strong>
      </div>
    </div>
  );
}

/** 급증일에만 점을 찍는다. 나머지 날은 선만 남긴다. */
function SpikeDot(props: { cx?: number; cy?: number; payload?: Row }) {
  const { cx, cy, payload } = props;
  if (!payload?.spike || cx == null || cy == null) return <g />;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill="var(--status-critical)"
      stroke="var(--surface-1)"
      strokeWidth={2}
    />
  );
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: Row }[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;

  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-lg"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        color: "var(--text-primary)",
      }}
    >
      <p style={{ color: "var(--text-secondary)" }}>{formatDateLong(row.date)}</p>
      <p className="mt-1 text-sm font-semibold tabular">{formatUsd(row.cost)}</p>
      {row.delta != null && (
        <p
          className="mt-0.5 tabular"
          style={{
            color: row.spike
              ? "var(--status-critical)"
              : row.delta > 0
                ? "var(--text-secondary)"
                : "var(--delta-down-good)",
            fontWeight: row.spike ? 600 : 400,
          }}
        >
          <span aria-hidden="true">{row.delta > 0 ? "▲" : "▼"} </span>
          전일 대비 {formatPct(row.delta)}
          {row.spike && " · 급증"}
        </p>
      )}
    </div>
  );
}
