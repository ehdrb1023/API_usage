"use client";

import { useMemo, useState } from "react";

import BreakdownTable from "@/components/BreakdownTable";
import DailyTable from "@/components/DailyTable";
import RangePicker from "@/components/RangePicker";
import ServiceTabs, {
  PREPAID_TAB,
  VENDORS_TAB,
  type TabValue,
} from "@/components/ServiceTabs";
import StatCards from "@/components/StatCards";
import UsageBar from "@/components/UsageBar";
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
import type { Budget } from "@/lib/budget";
import { formatDateLong, formatUsd } from "@/lib/format";
import type { RangeId, ServiceId, ServiceSeries } from "@/lib/types";

type Props = {
  series: ServiceSeries[];
  mode: "mock" | "api";
  /**
   * 탭 아래에 붙일 내용. "그 외 API" 목록이 여기로 들어온다.
   *
   * 왜 props 로 받나: 그 목록은 `config/vendors.json` 을 fs 로 읽는 **서버 컴포넌트**라
   * "use client" 인 이 파일 안에서 직접 import 할 수 없다. 슬롯만 열어 두고
   * `app/page.tsx` 가 끼워 넣는다.
   */
  children?: React.ReactNode;
  /**
   * "선불 잔액" 탭에 붙일 내용. `children` 과 같은 이유로 슬롯이다 —
   * 영수증을 fs 로 읽고 벤더 API 를 부르는 서버 컴포넌트다.
   */
  prepaid?: React.ReactNode;
  /** "그 외 API" 탭에 표시할 벤더 수. 0 이면 탭이 안 뜬다. */
  vendorCount?: number;
  /** "선불 잔액" 탭에 표시할 주머니 수. 0 이면 탭이 안 뜬다. */
  prepaidCount?: number;
  /**
   * 서비스별 월 예산 대비 사용률. 예산이 없으면 `usedPercent` 가 null 이고
   * 막대 대신 "기준 없음" 이 뜬다 (`lib/budget.ts`).
   */
  budgets?: Budget[];
  /**
   * 구독 한도 카드. `children` 과 같은 이유로 슬롯이다 — 홈 디렉토리의 자격증명을
   * fs 로 읽는 서버 컴포넌트라 "use client" 인 이 파일에서 직접 못 만든다.
   * 자격증명이 없는 기기(배포본)에서는 null 로 온다.
   */
  quota?: React.ReactNode;
};

export default function Dashboard({
  series,
  mode,
  children,
  prepaid,
  vendorCount = 0,
  prepaidCount = 0,
  budgets = [],
  quota,
}: Props) {
  /** 탭. 서비스 id 이거나 목록 화면(VENDORS_TAB·PREPAID_TAB) 이다. */
  const [tab, setTab] = useState<TabValue>("claude");
  // 아래 계산은 전부 실제 서비스 기준이다. 벤더 탭일 때는 직전 서비스를 그대로 둔다
  // (탭을 오갈 때 차트가 초기화되지 않게).
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
  const activeBudget = budgets.find((b) => b.service === active.service);

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

      {/* 계정 단위 값이라 서비스 탭 밖에 둔다. "언제 막히나" 가 가장 급한 신호다. */}
      {quota && <div className="mb-6">{quota}</div>}

      {/* 필터는 차트 위 한 줄에 모은다 */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <ServiceTabs
          services={series}
          value={tab}
          vendorCount={vendorCount}
          prepaidCount={prepaidCount}
          onChange={(next) => {
            setTab(next);
            // 목록 탭은 서비스가 아니다. 직전 서비스를 그대로 둬야 돌아왔을 때
            // 차트가 초기화되지 않는다.
            if (next !== VENDORS_TAB && next !== PREPAID_TAB) setService(next);
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

      {tab === VENDORS_TAB ? (
        // 그 외 API 는 시계열이 없다 — 목록만 그리고 차트·표는 건너뛴다.
        children
      ) : tab === PREPAID_TAB ? (
        // 선불 잔액도 시계열이 아니다. 영수증과 잔액만 그린다.
        prepaid
      ) : (
        <>
      <StatCards series={active} kpis={view.kpis} range={range} anchor={view.anchor} />

      {/* 예산 대비 사용률. 분모는 config/budgets.json 에서 온다 — 없으면 "기준 없음". */}
      {activeBudget && (
        <div className="card mt-4 p-4">
          <UsageBar
            usedPercent={activeBudget.usedPercent}
            label={`${active.label} · 이번 달 예산`}
            detail={
              activeBudget.budgetUsd === null
                ? formatUsd(activeBudget.spentUsd)
                : `${formatUsd(activeBudget.spentUsd)} / ${formatUsd(activeBudget.budgetUsd)}`
            }
            emptyHint={`이번 달 ${formatUsd(activeBudget.spentUsd)} 썼습니다. Admin API 는 상한을 주지 않으므로 config/budgets.json 의 monthlyUsd.${activeBudget.service} 에 월 예산을 적으면 막대가 나옵니다.`}
          />
        </div>
      )}


      <div className="mt-6">
        <TrendChart
          points={view.points}
          deltas={view.deltas}
          // 키를 고르면 제목이 그 키 이름으로 바뀐다 (config/client-keys.json 우선순위 그대로).
          subjectLabel={view.focusLabel ?? active.label}
          bounds={view.bounds}
          // 두 서비스 모두 모델별 사용량을 주므로 막대로 쌓는다.
          // (예전엔 GPT 가 미검증이라 Claude 만 켜 뒀는데, 2026-08-27 실키 검증으로 풀렸다)
          usageBreakdown
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

        </>
      )}

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
