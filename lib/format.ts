import type { MetricFormat, MetricSpec } from "@/lib/types";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatUsd(v: number): string {
  return usd.format(v);
}

/** 축 눈금용 — 소수점 없이 $60, $1,234 처럼 짧게. */
export function formatUsdAxis(v: number): string {
  return usdCompact.format(v);
}

/** 토큰처럼 자릿수가 큰 값. 1.2M / 345.6K */
export function formatTokens(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

export function formatCount(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}

export function formatDecimal(v: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export function formatMetric(v: number, spec: MetricSpec): string {
  const body = formatByType(v, spec.format);
  return spec.unit ? `${body} ${spec.unit}` : body;
}

function formatByType(v: number, f: MetricFormat): string {
  switch (f) {
    case "usd":
      return formatUsd(v);
    case "tokens":
      return formatTokens(v);
    case "count":
      return formatCount(v);
    case "decimal":
      return formatDecimal(v);
  }
}

/** +12.3% / -4.0% */
export function formatPct(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

/** 2026-08-14 → 8/14 */
export function formatDateShort(iso: string): string {
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

/** 2026-08-14 → 2026년 8월 14일 (목) */
export function formatDateLong(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const w = ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${w})`;
}
