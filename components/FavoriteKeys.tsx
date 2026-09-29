"use client";

import type { BreakdownRow } from "@/lib/analytics";
import { RANGES, sliceRange } from "@/lib/analytics";
import { formatDateShort, formatMetric, formatUsd } from "@/lib/format";
import type { KeyLocationsView, RangeId, ServiceSeries } from "@/lib/types";

/** 즐겨찾기가 없을 때 대신 보여 줄 비용 상위 키 수. */
export const DEFAULT_TOP = 5;

type Props = {
  series: ServiceSeries;
  range: RangeId;
  /** 보조 축(키별) 집계 — 이미 비용 내림차순이다. */
  rows: BreakdownRow[];
  favoriteIds: string[];
  locations?: KeyLocationsView;
  selectedKey: string | null;
  onToggleFavorite: (keyId: string) => void;
  onSelect: (keyId: string | null) => void;
};

/**
 * 화면 맨 위 "즐겨찾기 키". 별표한 키를 비용 순으로 카드로 모은다.
 * 별표한 게 없으면 **이번 구간 비용 상위 5개**를 대신 보여 준다.
 *
 * 즐겨찾기한 키가 이 구간에 안 쓰였어도 카드는 남긴다 ($0) — "안 쓰고 있다" 도 추적 대상이다.
 */
export default function FavoriteKeys({
  series,
  range,
  rows,
  favoriteIds,
  locations,
  selectedKey,
  onToggleFavorite,
  onSelect,
}: Props) {
  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? "";
  const hasFavorites = favoriteIds.length > 0;
  const primary = series.metricSpecs.find((m) => m.key === series.primaryMetric);

  const byKey = new Map(rows.map((r) => [r.key, r]));
  const cards: BreakdownRow[] = hasFavorites
    ? favoriteIds
        .map(
          (id) =>
            byKey.get(id) ?? {
              key: id,
              label: labelOf(series, id) ?? id,
              costUsd: 0,
              costShare: 0,
              metrics: {},
            },
        )
        .sort((a, b) => b.costUsd - a.costUsd)
    : rows.slice(0, DEFAULT_TOP);

  const inRange = sliceRange(series.points, range);

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">
          {hasFavorites ? "즐겨찾기 키" : `비용 상위 ${DEFAULT_TOP}개 키`}
        </h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {rangeLabel} 기준 ·{" "}
          {hasFavorites
            ? "아래 표의 ☆ 로 추가·해제"
            : "아래 표에서 ☆ 를 누르면 그 키들만 여기 모입니다"}
        </p>
      </div>

      {cards.length === 0 ? (
        <p className="card p-4 text-sm" style={{ color: "var(--text-muted)" }}>
          이 구간에 사용된 키가 없습니다.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((row) => {
            const daily = inRange.map(
              (p) => p.altItems?.find((i) => i.key === row.key)?.costUsd ?? 0,
            );
            const lastUsed = lastUsedDate(series, row.key);
            const where = locations?.byKey[row.key]?.locations[0];
            const favored = favoriteIds.includes(row.key);
            const selected = selectedKey === row.key;
            return (
              <article
                key={row.key}
                className="card cursor-pointer p-4 transition-colors"
                style={{
                  outline: selected ? "2px solid var(--series-1)" : undefined,
                }}
                onClick={() => onSelect(selected ? null : row.key)}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium" title={row.title ?? row.key}>
                    {row.label}
                  </p>
                  <StarButton
                    on={favored}
                    label={row.label}
                    onClick={() => onToggleFavorite(row.key)}
                  />
                </div>
                <p className="mt-1 text-xl font-semibold tracking-tight">
                  {formatUsd(row.costUsd)}
                  <span className="ml-1.5 text-xs font-normal" style={{ color: "var(--text-muted)" }}>
                    {(row.costShare * 100).toFixed(1)}%
                  </span>
                </p>
                <Sparkline values={daily} />
                <dl className="mt-2 grid grid-cols-2 gap-x-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                  <dt style={{ color: "var(--text-muted)" }}>{primary?.label ?? "사용량"}</dt>
                  <dd className="tabular text-right">
                    {primary ? formatMetric(row.metrics[primary.key] ?? 0, primary) : "-"}
                  </dd>
                  <dt style={{ color: "var(--text-muted)" }}>마지막 사용</dt>
                  <dd className="tabular text-right">{lastUsed ? formatDateShort(lastUsed) : "기록 없음"}</dd>
                  {locations && (
                    <>
                      <dt style={{ color: "var(--text-muted)" }}>사용처</dt>
                      <dd className="truncate text-right" title={where?.domains.join("\n")}>
                        {where ? where.project : "미확인"}
                      </dd>
                    </>
                  )}
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 표와 카드가 같이 쓰는 별표. 행 클릭(선택)으로 번지지 않게 전파를 끊는다. */
export function StarButton({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `${label} 즐겨찾기 해제` : `${label} 즐겨찾기`}
      title={on ? "즐겨찾기 해제" : "즐겨찾기"}
      className="shrink-0 cursor-pointer text-base leading-none"
      style={{ color: on ? "var(--series-4)" : "var(--text-muted)" }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="mt-2 h-8" />;
  const max = Math.max(...values, 0);
  const w = 100;
  const h = 32;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = max > 0 ? h - 2 - (v / max) * (h - 4) : h - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="mt-2 h-8 w-full"
      role="img"
      aria-label="일별 비용 추이"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--series-1)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 전 구간에서 이 키가 마지막으로 비용·사용량이 잡힌 날. */
function lastUsedDate(series: ServiceSeries, keyId: string): string | null {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const item = series.points[i].altItems?.find((x) => x.key === keyId);
    if (item && (item.costUsd > 0 || Object.values(item.metrics).some((v) => v > 0))) {
      return series.points[i].date;
    }
  }
  return null;
}

/** 이 구간에 안 쓰인 즐겨찾기 키의 이름 — 다른 날짜의 항목에서 찾는다. */
function labelOf(series: ServiceSeries, keyId: string): string | undefined {
  for (const p of series.points) {
    const item = p.altItems?.find((x) => x.key === keyId);
    if (item) return item.label;
  }
  return undefined;
}
