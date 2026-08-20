"use client";

import type { BreakdownRow } from "@/lib/analytics";
import { RANGES } from "@/lib/analytics";
import { formatMetric, formatPct, formatUsd } from "@/lib/format";
import type { RangeId, ServiceSeries } from "@/lib/types";

type Props = {
  series: ServiceSeries;
  rows: BreakdownRow[];
  range: RangeId;
  /** 제목·첫 컬럼의 축 이름. 기본은 `series.breakdownLabel`. */
  axisLabel?: string;
  /** 표 하단 각주. 안분 추정치 같은 단서를 여기 적는다. */
  note?: string;
  /** 지금 선택된 행의 key. `onSelect` 가 있을 때만 의미가 있다. */
  selectedKey?: string | null;
  /**
   * 넘기면 행이 클릭 가능해진다. 같은 행을 다시 누르면 `null` 로 해제된다.
   * 넘기지 않으면 지금까지처럼 정적인 표로 남는다 (모델별 표가 그렇다).
   */
  onSelect?: (key: string | null) => void;
};

/**
 * 카테고리 슬롯은 고정 순서로 배정한다. 절대 순환시키지 않는다.
 * 4번째부터는 새 색을 만들지 않고 muted 로 떨군다.
 */
const SERIES_SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const slotColor = (i: number) => SERIES_SLOTS[i] ?? "var(--text-muted)";

export default function BreakdownTable({
  series,
  rows,
  range,
  axisLabel,
  note,
  selectedKey = null,
  onSelect,
}: Props) {
  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? "";
  const axis = axisLabel ?? series.breakdownLabel;
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  const selectable = typeof onSelect === "function";

  /** 같은 행을 다시 누르면 해제. */
  const toggle = (key: string) => onSelect?.(selectedKey === key ? null : key);

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">{axis}별 사용량</h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {rangeLabel} 합계
          {selectable && " · 행을 클릭하면 그 키만 차트로"}
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
                {axis}
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
            {rows.map((row, i) => {
              const selected = selectable && selectedKey === row.key;
              return (
              <tr
                key={row.key}
                className={`border-t${selectable ? " cursor-pointer" : ""}`}
                onClick={selectable ? () => toggle(row.key) : undefined}
                style={{
                  borderColor: "var(--border)",
                  background: selected
                    ? "color-mix(in srgb, var(--series-1) 14%, transparent)"
                    : undefined,
                }}
              >
                <th scope="row" className="px-4 py-2.5 text-left font-normal sm:px-2">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ background: slotColor(i) }}
                    />
                    {/*
                      키보드 접근 경로. 행 전체에도 onClick 이 있어서 마우스는 어디를 눌러도
                      되지만, 클릭이 두 번 세어지지 않도록 여기서 전파를 끊는다.
                      title 에는 전체 api_key_id — config/client-keys.json 에 옮겨 적을 때 쓴다.
                    */}
                    {selectable ? (
                      <button
                        type="button"
                        className="truncate text-left"
                        style={{ fontWeight: selected ? 600 : undefined }}
                        title={row.title}
                        aria-pressed={selected}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(row.key);
                        }}
                      >
                        {row.label}
                      </button>
                    ) : (
                      <span className="truncate" title={row.title}>
                        {row.label}
                      </span>
                    )}
                    {row.badge && (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none"
                        style={{
                          border: "1px solid var(--border)",
                          color: "var(--text-muted)",
                        }}
                      >
                        {row.badge}
                      </span>
                    )}
                    {row.hint && (
                      // 이름을 못 찾았거나 같은 이름의 키가 여럿일 때만 붙는다.
                      <span
                        className="shrink-0 truncate text-[11px]"
                        style={{ color: "var(--text-muted)" }}
                        title={row.hint}
                      >
                        {row.hint}
                      </span>
                    )}
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
              );
            })}

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

      {note && (
        <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
          {note}
        </p>
      )}
    </section>
  );
}
