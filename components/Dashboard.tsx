"use client";

import { useMemo, useState } from "react";

import BreakdownTable from "@/components/BreakdownTable";
import DailyTable from "@/components/DailyTable";
import RangePicker from "@/components/RangePicker";
import ServiceTabs from "@/components/ServiceTabs";
import StatCards from "@/components/StatCards";
import TrendChart from "@/components/TrendChart";
import {
  anchorDate,
  computeBreakdown,
  computeDeltas,
  computeKpis,
  rangeBounds,
  sliceRange,
} from "@/lib/analytics";
import { formatDateLong } from "@/lib/format";
import type { RangeId, ServiceId, ServiceSeries } from "@/lib/types";

type Props = {
  series: ServiceSeries[];
  mode: "mock" | "api";
};

export default function Dashboard({ series, mode }: Props) {
  const [service, setService] = useState<ServiceId>("claude");
  const [range, setRange] = useState<RangeId>("30d");

  const active = series.find((s) => s.service === service) ?? series[0];

  const view = useMemo(() => {
    const anchor = anchorDate(active.points);
    return {
      anchor,
      bounds: rangeBounds(anchor, range),
      points: sliceRange(active.points, range),
      // 구간 첫날도 정확히 비교되도록 전체 시계열로 계산한 뒤 조회한다
      deltas: computeDeltas(active.points),
      kpis: computeKpis(active, range),
      breakdown: computeBreakdown(active, range),
    };
  }, [active, range]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">API 비용 대시보드</h1>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            기준일 {view.anchor ? formatDateLong(view.anchor) : "-"} · UTC
          </p>
        </div>
        {mode === "mock" && (
          <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            목업 데이터입니다. 실제 API 연동 시 필드명 확인 필요 —{" "}
            <code>.env</code> 의 <code>DATA_SOURCE=api</code> 로 바꾸면 실 API 를 호출합니다.
          </p>
        )}
      </header>

      {/* 필터는 차트 위 한 줄에 모은다 */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <ServiceTabs
          services={series}
          value={service}
          onChange={(next) => setService(next)}
        />
        <RangePicker value={range} onChange={setRange} />
      </div>

      <StatCards series={active} kpis={view.kpis} range={range} anchor={view.anchor} />

      <div className="mt-6">
        <TrendChart
          points={view.points}
          deltas={view.deltas}
          serviceLabel={active.label}
          bounds={view.bounds}
        />
      </div>

      <div className="mt-6">
        <BreakdownTable series={active} rows={view.breakdown} range={range} />
      </div>

      <div className="mt-6">
        <DailyTable series={active} points={view.points} deltas={view.deltas} />
      </div>

      <footer
        className="mt-8 border-t pt-4 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        비용은 USD 기준. 날짜는 UTC 일 경계이며 KST 와 9시간 차이가 납니다.
        {active.service === "claude" && " Claude 비용은 cost_report 의 센트 단위 값을 USD 로 변환한 값입니다."}
        {active.service === "vercel" && " Vercel 비용은 BilledCost(청구 기준액) 합계입니다."}
      </footer>
    </main>
  );
}
