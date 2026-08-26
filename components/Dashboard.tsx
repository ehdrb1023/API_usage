"use client";

import { useMemo, useState } from "react";

import BreakdownTable from "@/components/BreakdownTable";
import DailyTable from "@/components/DailyTable";
import RangePicker from "@/components/RangePicker";
import ServiceTabs from "@/components/ServiceTabs";
import StatCards from "@/components/StatCards";
import TrendChart from "@/components/TrendChart";
import WidgetPicker from "@/components/WidgetPicker";
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
  /**
   * 미니 창(/mini)에 띄울 항목 고르기. 대시보드에서 고르는 이유는 화면이 넓어서다 —
   * API 키가 30개 넘는데 미니 창 안에서 고르는 건 고문이다. 고른 값은 localStorage 를
   * 거쳐 열려 있는 미니 창에 그대로 반영된다.
   */
  const [showWidgetPicker, setShowWidgetPicker] = useState(false);

  const active = series.find((s) => s.service === service) ?? series[0];

  const view = useMemo(() => {
    const anchor = anchorDate(active.points);
    // 보조 축이 없는 탭(조회 실패한 빈 탭)에서는 선택이 의미가 없다.
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowWidgetPicker(true)}
            className="cursor-pointer rounded-lg px-3.5 py-1.5 text-sm transition-colors"
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
            }}
          >
            <span aria-hidden="true">⚙ </span>
            미니 창 항목
          </button>
          <RangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {showWidgetPicker && (
        <div
          className="wp-modal"
          role="dialog"
          aria-modal="true"
          aria-label="미니 창 표시 항목"
          onClick={(e) => {
            // 바깥을 눌러 닫는다. 안쪽 클릭이 올라온 것과 구분해야 한다.
            if (e.target === e.currentTarget) setShowWidgetPicker(false);
          }}
        >
          <WidgetPicker onClose={() => setShowWidgetPicker(false)} />
        </div>
      )}

      {/*
        예전에는 여기에 "서비스마다 일 경계가 다릅니다" 경고 배너가 있었다.
        Vercel(미 태평양시)·Supabase(UTC)를 함께 보던 때의 이야기고, AI API 만
        다루기로 하면서 **모든 탭이 KST 자정 기준**이 되어 배너가 필요 없어졌다.

        ⚠️ 1시간 버킷을 안 주는 벤더를 추가하면 그 전제가 깨진다. 그때는 이 배너를
           되살릴 것 — 기준이 다른데 같은 날짜로 보이면 조용히 틀린 비교가 된다.
           (판단 근거는 lib/types.ts 의 DayBoundary 주석)
      */}

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
          usageBreakdown={active.service === "claude"}
          breakdownLabel={view.focusKey ? active.altBreakdown?.label : active.breakdownLabel}
          metricKey={active.primaryMetric}
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

        {/*
          벤더별 주의문·미검증 경고·조회 실패 사유가 전부 note 로 온다
          (조립은 lib/data-source.ts 의 composeNote).
          줄바꿈을 살려야 실패 사유(발급 절차)가 읽힌다.
        */}
        {active.note && (
          <p className="mt-2 whitespace-pre-line">{active.note}</p>
        )}
      </footer>
    </main>
  );
}
