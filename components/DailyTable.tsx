"use client";

import { isSpike } from "@/lib/analytics";
import { formatMetric, formatPct, formatUsd } from "@/lib/format";
import type { DailyPoint, ServiceSeries } from "@/lib/types";

type Props = {
  series: ServiceSeries;
  points: DailyPoint[];
  deltas: Map<string, number | null>;
};

/**
 * 라인 차트와 같은 데이터를 표로도 제공한다 (차트를 읽을 수 없는 경우의 대체 경로).
 * 급증일은 색만이 아니라 "급증" 라벨과 ▲ 기호를 함께 붙여 표시한다.
 */
export default function DailyTable({ series, points, deltas }: Props) {
  const primarySpec =
    series.metricSpecs.find((m) => m.key === series.primaryMetric) ??
    series.metricSpecs[0];

  const rowsDesc = [...points].reverse();

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">일별 상세</h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          최신순 · 차트와 동일한 데이터
        </p>
      </div>

      <div className="max-h-80 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0" style={{ background: "var(--surface-1)" }}>
            <tr className="text-left text-xs" style={{ color: "var(--text-secondary)" }}>
              <th scope="col" className="px-2 py-2 font-medium">날짜</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">비용</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">전일 대비</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                {primarySpec.label}
              </th>
            </tr>
          </thead>
          <tbody>
            {rowsDesc.map((p) => {
              const delta = deltas.get(p.date) ?? null;
              const spike = isSpike(delta);
              return (
                <tr
                  key={p.date}
                  className="border-t"
                  style={{
                    borderColor: "var(--border)",
                    background: spike ? "color-mix(in srgb, var(--status-critical) 8%, transparent)" : undefined,
                  }}
                >
                  <th
                    scope="row"
                    className="tabular px-2 py-2 text-left font-normal"
                    style={{ color: spike ? "var(--status-critical)" : undefined }}
                  >
                    {p.date}
                  </th>
                  <td
                    className="tabular px-2 py-2 text-right"
                    style={{
                      color: spike ? "var(--status-critical)" : undefined,
                      fontWeight: spike ? 600 : 400,
                    }}
                  >
                    {formatUsd(p.costUsd)}
                  </td>
                  <td
                    className="tabular px-2 py-2 text-right"
                    style={{
                      color: spike
                        ? "var(--status-critical)"
                        : delta != null && delta < 0
                          ? "var(--delta-down-good)"
                          : "var(--text-secondary)",
                      fontWeight: spike ? 600 : 400,
                    }}
                  >
                    {delta == null ? (
                      "—"
                    ) : (
                      <>
                        <span aria-hidden="true">{delta > 0 ? "▲" : "▼"} </span>
                        {formatPct(delta)}
                        {spike && <span className="ml-1 text-xs">급증</span>}
                      </>
                    )}
                  </td>
                  <td
                    className="tabular px-2 py-2 text-right"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {formatMetric(p.metrics[primarySpec.key] ?? 0, primarySpec)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
