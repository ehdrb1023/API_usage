"use client";

import type { BreakdownRow } from "@/lib/analytics";
import { RANGES } from "@/lib/analytics";
import { formatMetric, formatPct, formatUsd } from "@/lib/format";
import type { RangeId, ServiceSeries } from "@/lib/types";

type Props = {
  series: ServiceSeries;
  rows: BreakdownRow[];
  range: RangeId;
};

/**
 * 카테고리 슬롯은 고정 순서로 배정한다. 절대 순환시키지 않는다.
 * 4번째부터는 새 색을 만들지 않고 muted 로 떨군다.
 */
const SERIES_SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const slotColor = (i: number) => SERIES_SLOTS[i] ?? "var(--text-muted)";

export default function BreakdownTable({ series, rows, range }: Props) {
  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? "";
  const total = rows.reduce((s, r) => s + r.costUsd, 0);

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">{series.breakdownLabel}별 사용량</h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {rangeLabel} 합계
        </p>
      </div>

      <div className="-mx-4 overflow-x-auto sm:mx-0">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr
              className="text-left text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              <th scope="col" className="px-4 py-2 font-medium sm:px-2">
                {series.breakdownLabel}
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                비용
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                비중
              </th>
              {series.metricSpecs.map((m) => (
                <th key={m.key} scope="col" className="px-2 py-2 text-right font-medium">
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.key}
                className="border-t"
                style={{ borderColor: "var(--border)" }}
              >
                <th scope="row" className="px-4 py-2.5 text-left font-normal sm:px-2">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ background: slotColor(i) }}
                    />
                    <span className="truncate">{row.label}</span>
                  </span>
                </th>
                <td className="tabular px-2 py-2.5 text-right font-medium">
                  {formatUsd(row.costUsd)}
                </td>
                <td
                  className="tabular px-2 py-2.5 text-right"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {(row.costShare * 100).toFixed(1)}%
                </td>
                {series.metricSpecs.map((m) => (
                  <td
                    key={m.key}
                    className="tabular px-2 py-2.5 text-right"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {formatMetric(row.metrics[m.key] ?? 0, m)}
                  </td>
                ))}
              </tr>
            ))}

            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={3 + series.metricSpecs.length}
                  className="px-2 py-8 text-center text-sm"
                  style={{ color: "var(--text-muted)" }}
                >
                  이 구간에 데이터가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr
                className="border-t"
                style={{ borderColor: "var(--axis)" }}
              >
                <th scope="row" className="px-4 py-2.5 text-left font-semibold sm:px-2">
                  합계
                </th>
                <td className="tabular px-2 py-2.5 text-right font-semibold">
                  {formatUsd(total)}
                </td>
                <td className="tabular px-2 py-2.5 text-right" style={{ color: "var(--text-secondary)" }}>
                  {formatPct(1).replace("+", "")}
                </td>
                {series.metricSpecs.map((m) => (
                  <td
                    key={m.key}
                    className="tabular px-2 py-2.5 text-right font-medium"
                  >
                    {formatMetric(
                      rows.reduce((s, r) => s + (r.metrics[m.key] ?? 0), 0),
                      m,
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
