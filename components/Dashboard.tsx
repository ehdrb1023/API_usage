"use client";

import { useMemo, useState } from "react";

import BreakdownTable from "@/components/BreakdownTable";
import DailyTable from "@/components/DailyTable";
import RangePicker from "@/components/RangePicker";
import ServiceTabs from "@/components/ServiceTabs";
import StatCards from "@/components/StatCards";
import TrendChart from "@/components/TrendChart";
import {
  BREAKDOWN_AXES,
  anchorDate,
  computeBreakdown,
  computeDeltas,
  computeKpis,
  filterSeriesByAltKey,
  findAltItemLabel,
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
  /** 서비스별 표에서 선택한 API 키. null 이면 전체 합계를 본다. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const active = series.find((s) => s.service === service) ?? series[0];

  const view = useMemo(() => {
    const anchor = anchorDate(active.points);
    // 보조 축이 없는 서비스(Vercel)로 넘어가면 선택은 의미가 없다.
    const focusKey = active.altBreakdown ? selectedKey : null;
    /**
     * 선택된 키가 있으면 KPI·차트·일별 상세만 그 키 기준으로 다시 계산한다.
     * 이미 받아 둔 데이터를 걸러 쓸 뿐이라 API 재호출이 없다.
     * 아래 두 표(모델별·서비스별)는 전체 기준을 유지한다.
     */
    const focused = focusKey ? filterSeriesByAltKey(active, focusKey) : active;

    return {
      anchor,
      // 구간은 선택과 무관하게 전체 시계열 기준으로 잡아야 축이 흔들리지 않는다.
      bounds: rangeBounds(anchor, range),
      points: sliceRange(focused.points, range),
      // 구간 첫날도 정확히 비교되도록 전체 시계열로 계산한 뒤 조회한다
      deltas: computeDeltas(focused.points),
      kpis: computeKpis(focused, range),
      breakdown: computeBreakdown(active, range),
      // 보조 축(Claude = API 키별). 설정이 없는 서비스는 빈 배열이라 표를 안 그린다.
      altBreakdown: active.altBreakdown
        ? computeBreakdown(active, range, BREAKDOWN_AXES.alt)
        : [],
      focusKey,
      focusLabel: focusKey ? findAltItemLabel(active, focusKey) : undefined,
    };
  }, [active, range, selectedKey]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">API 비용 대시보드</h1>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            기준일 {view.anchor ? formatDateLong(view.anchor) : "-"} ·{" "}
            <span title={active.dayBoundary.note}>{active.dayBoundary.label}</span> 기준
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
          onChange={(next) => {
            setService(next);
            // 키는 서비스마다 다르므로 탭을 옮기면 선택을 푼다.
            setSelectedKey(null);
          }}
        />
        <RangePicker value={range} onChange={setRange} />
      </div>

      {/*
        일 경계 경고는 KPI·차트 **위**에 둔다. 각주에 두면 Vercel 탭 기준 5화면을
        스크롤해야 보이는데, 정작 오해가 생기는 지점은 탭을 전환한 직후 상단이다.
        두 서비스의 기준이 실제로 다를 때만 띄운다.
      */}
      {new Set(series.map((s) => s.dayBoundary.label)).size > 1 && (
        <div
          role="note"
          className="mb-6 flex gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs"
          style={{
            borderColor: "var(--status-critical)",
            background: "color-mix(in srgb, var(--status-critical) 7%, transparent)",
            color: "var(--text-secondary)",
          }}
        >
          <span aria-hidden="true" style={{ color: "var(--status-critical)" }}>
            ⚠
          </span>
          <p>
            <strong style={{ color: "var(--text-primary)" }}>
              두 서비스는 일 경계가 다릅니다
            </strong>{" "}
            —{" "}
            {series.map((s, i) => (
              <span key={s.service}>
                {i > 0 && " · "}
                {s.label} {s.dayBoundary.label}
              </span>
            ))}
            . 같은 날짜라도 가리키는 24시간이 7시간 어긋나므로, 두 탭의 일별 수치를 같은
            하루로 놓고 비교하지 마세요.
          </p>
        </div>
      )}

      {/* 키 기준 집계의 한계는 표를 보기 전에 알아야 해서 상단에 둔다. */}
      {active.altBreakdown?.notice && !view.focusKey && (
        <p
          role="note"
          className="mb-6 text-xs"
          style={{ color: "var(--text-secondary)" }}
        >
          {active.altBreakdown.notice}
        </p>
      )}

      {/*
        선택 중일 때는 "지금 화면의 어디까지가 이 키 기준인지"를 먼저 알려 준다.
        카드·차트·일별 상세만 좁혀지고 아래 두 표는 전체 기준이라, 안 적으면 오해가 생긴다.
      */}
      {view.focusKey && (
        <div
          role="status"
          className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3.5 py-2.5 text-xs"
          style={{
            borderColor: "var(--series-1)",
            background: "color-mix(in srgb, var(--series-1) 8%, transparent)",
            color: "var(--text-secondary)",
          }}
        >
          <p>
            <strong style={{ color: "var(--text-primary)" }}>
              {view.focusLabel ?? view.focusKey}
            </strong>{" "}
            하나만 보고 있습니다 — 아래 카드·차트·일별 상세는 이 키 기준입니다.
            모델별·서비스별 표는 전체 기준 그대로입니다.
          </p>
          <button
            type="button"
            className="shrink-0 rounded-md px-2.5 py-1 font-medium"
            style={{
              border: "1px solid var(--border)",
              background: "var(--surface-1)",
              color: "var(--text-primary)",
            }}
            onClick={() => setSelectedKey(null)}
          >
            <span aria-hidden="true">✕</span> 전체 보기로 돌아가기
          </button>
        </div>
      )}

      <StatCards series={active} kpis={view.kpis} range={range} anchor={view.anchor} />

      <div className="mt-6">
        <TrendChart
          points={view.points}
          deltas={view.deltas}
          // 키를 고르면 제목이 그 키 이름으로 바뀐다 (config/client-keys.json 우선순위 그대로).
          subjectLabel={view.focusLabel ?? active.label}
          bounds={view.bounds}
        />
      </div>

      <div className="mt-6">
        <BreakdownTable series={active} rows={view.breakdown} range={range} />
      </div>

      {active.altBreakdown && (
        <div className="mt-6">
          <BreakdownTable
            series={active}
            rows={view.altBreakdown}
            range={range}
            axisLabel={active.altBreakdown.label}
            note={active.altBreakdown.note}
            selectedKey={view.focusKey}
            onSelect={setSelectedKey}
          />
        </div>
      )}

      <div className="mt-6">
        <DailyTable series={active} points={view.points} deltas={view.deltas} />
      </div>

      {/* 일 경계 경고는 상단 배너로 옮겼다. 여기엔 탭별 상세만 남긴다. */}
      <footer
        className="mt-8 border-t pt-4 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        비용은 USD 기준. {active.dayBoundary.note}
        {active.service === "claude" && " Claude 비용은 cost_report 의 센트 단위 값을 USD 로 변환한 값입니다."}
        {active.service === "vercel" && " Vercel 비용은 EffectiveCost(크레딧·할인 반영 실질 원가) 합계입니다. Committed 플랜은 BilledCost 가 0 으로 잡혀 실사용이 보이지 않습니다."}
      </footer>
    </main>
  );
}
