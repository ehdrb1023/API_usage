"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { SPIKE_THRESHOLD, isSpike } from "@/lib/analytics";
import { formatDateLong, formatPct, formatUsd, formatUsdAxis, formatDateShort } from "@/lib/format";
import type { DailyPoint } from "@/lib/types";

type Props = {
  points: DailyPoint[];
  deltas: Map<string, number | null>;
  serviceLabel: string;
  bounds: [string, string];
};

type Row = {
  date: string;
  cost: number;
  delta: number | null;
  spike: boolean;
};

export default function TrendChart({ points, deltas, serviceLabel, bounds }: Props) {
  const rows: Row[] = points.map((p) => {
    const delta = deltas.get(p.date) ?? null;
    return { date: p.date, cost: p.costUsd, delta, spike: isSpike(delta) };
  });

  const spikeCount = rows.filter((r) => r.spike).length;

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">{serviceLabel} 일별 비용 추이</h2>
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
