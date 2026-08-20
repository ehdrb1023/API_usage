/**
 * lib/analytics.ts 유닛 테스트 — 순수 함수라 네트워크·파일을 타지 않습니다.
 *
 * 초점은 "서비스별 사용량 표에서 키를 하나 고르면" 벌어지는 일입니다:
 *   이미 받아 둔 altItems 만으로 그 키의 시계열을 만들고, 급증일을 다시 계산합니다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BreakdownItem, DailyPoint, ServiceSeries } from "@/lib/types";

import {
  computeDeltas,
  computeKpis,
  filterSeriesByAltKey,
  findAltItemLabel,
  isSpike,
  sliceRange,
} from "../analytics";

// ---------------------------------------------------------------- 목 헬퍼

/** 하루치 키별 비용 → DailyPoint. metrics 는 totalTokens 하나만 쓴다. */
function day(
  date: string,
  perKey: Record<string, { cost: number; tokens: number; label?: string }>,
): DailyPoint {
  const altItems: BreakdownItem[] = Object.entries(perKey).map(([key, v]) => ({
    key,
    label: v.label ?? key,
    costUsd: v.cost,
    metrics: { totalTokens: v.tokens },
  }));

  return {
    date,
    costUsd: altItems.reduce((s, i) => s + i.costUsd, 0),
    metrics: {
      totalTokens: altItems.reduce((s, i) => s + i.metrics.totalTokens, 0),
    },
    // 모델별 축은 이 테스트의 관심사가 아니라 하루 합계 한 줄로 둔다.
    items: [
      {
        key: "model",
        label: "model",
        costUsd: altItems.reduce((s, i) => s + i.costUsd, 0),
        metrics: {
          totalTokens: altItems.reduce((s, i) => s + i.metrics.totalTokens, 0),
        },
      },
    ],
    altItems,
  };
}

function makeSeries(points: DailyPoint[]): ServiceSeries {
  return {
    service: "claude",
    label: "Claude",
    breakdownLabel: "모델",
    dayBoundary: { label: "UTC", note: "" },
    primaryMetric: "totalTokens",
    metricSpecs: [{ key: "totalTokens", label: "총 토큰", format: "tokens" }],
    points,
    source: "api",
    altBreakdown: { label: "서비스" },
  };
}

const A = "apikey_A";
const B = "apikey_B";

// ---------------------------------------------------------------- 필터링

describe("filterSeriesByAltKey — 이미 받은 데이터에서 키 하나만 뽑기", () => {
  const series = makeSeries([
    day("2026-08-01", { [A]: { cost: 10, tokens: 100 }, [B]: { cost: 90, tokens: 900 } }),
    day("2026-08-02", { [A]: { cost: 20, tokens: 200 }, [B]: { cost: 80, tokens: 800 } }),
  ]);

  it("그 키의 비용·토큰만 남긴다", () => {
    const only = filterSeriesByAltKey(series, A);

    assert.deepEqual(
      only.points.map((p) => p.costUsd),
      [10, 20],
    );
    assert.deepEqual(
      only.points.map((p) => p.metrics.totalTokens),
      [100, 200],
    );
  });

  it("모든 키의 필터 결과를 더하면 전체 합계와 같다", () => {
    const sum = (s: ServiceSeries) => s.points.reduce((t, p) => t + p.costUsd, 0);

    assert.equal(
      sum(filterSeriesByAltKey(series, A)) + sum(filterSeriesByAltKey(series, B)),
      sum(series),
    );
  });

  it("그 키를 안 쓴 날도 0 으로 남긴다 (날짜를 건너뛰면 전일 대비가 어긋난다)", () => {
    const gapped = makeSeries([
      day("2026-08-01", { [A]: { cost: 10, tokens: 100 } }),
      day("2026-08-02", { [B]: { cost: 90, tokens: 900 } }), // A 사용 없음
      day("2026-08-03", { [A]: { cost: 30, tokens: 300 } }),
    ]);

    const only = filterSeriesByAltKey(gapped, A);

    assert.equal(only.points.length, 3);
    assert.deepEqual(
      only.points.map((p) => p.costUsd),
      [10, 0, 30],
    );
    // 0 인 날도 metrics 키가 살아 있어야 표·차트가 undefined 를 만나지 않는다.
    assert.equal(only.points[1].metrics.totalTokens, 0);
  });

  it("원본 시리즈를 건드리지 않는다", () => {
    const before = series.points.map((p) => p.costUsd);
    filterSeriesByAltKey(series, A);

    assert.deepEqual(
      series.points.map((p) => p.costUsd),
      before,
    );
  });

  it("없는 키를 넘기면 전 구간 0 (빈 차트)", () => {
    const only = filterSeriesByAltKey(series, "apikey_없음");

    assert.deepEqual(
      only.points.map((p) => p.costUsd),
      [0, 0],
    );
  });
});

// ------------------------------------------------------------------ 급증일

describe("급증일은 선택된 키 기준으로 다시 계산된다", () => {
  // 전체는 200 → 200 으로 변화가 없지만, A 는 100 → 130 (+30%) 으로 급증한다.
  const series = makeSeries([
    day("2026-08-01", { [A]: { cost: 100, tokens: 1 }, [B]: { cost: 100, tokens: 1 } }),
    day("2026-08-02", { [A]: { cost: 130, tokens: 1 }, [B]: { cost: 70, tokens: 1 } }),
  ]);

  it("전체 합계 기준으로는 급증일이 없다", () => {
    const deltas = computeDeltas(series.points);

    assert.equal(deltas.get("2026-08-02"), 0);
    assert.equal(isSpike(deltas.get("2026-08-02")), false);
  });

  it("A 기준으로는 급증일이다", () => {
    const deltas = computeDeltas(filterSeriesByAltKey(series, A).points);

    assert.ok(Math.abs((deltas.get("2026-08-02") ?? 0) - 0.3) < 1e-9);
    assert.equal(isSpike(deltas.get("2026-08-02")), true);
  });

  it("B 기준으로는 오히려 감소한 날이다", () => {
    const deltas = computeDeltas(filterSeriesByAltKey(series, B).points);

    assert.ok((deltas.get("2026-08-02") ?? 0) < 0);
    assert.equal(isSpike(deltas.get("2026-08-02")), false);
  });

  it("KPI 의 급증일 수도 키 기준으로 바뀐다", () => {
    assert.equal(computeKpis(series, "30d").spikeCount, 0);
    assert.equal(computeKpis(filterSeriesByAltKey(series, A), "30d").spikeCount, 1);
  });
});

// ------------------------------------------------------------------ 기간 필터

describe("기간 필터는 키를 선택한 상태에서도 그대로 작동한다", () => {
  // 8/01 ~ 8/10, A 는 매일 $1 / B 는 매일 $9
  const points = Array.from({ length: 10 }, (_, i) =>
    day(`2026-08-${String(i + 1).padStart(2, "0")}`, {
      [A]: { cost: 1, tokens: 10 },
      [B]: { cost: 9, tokens: 90 },
    }),
  );
  const series = makeSeries(points);

  it("7일 구간은 선택 전후로 같은 날짜를 자른다", () => {
    const all = sliceRange(series.points, "7d").map((p) => p.date);
    const only = sliceRange(filterSeriesByAltKey(series, A).points, "7d").map(
      (p) => p.date,
    );

    assert.deepEqual(only, all);
    assert.equal(only.length, 7);
  });

  it("구간 합계도 그 키 몫만 잡힌다", () => {
    const only = sliceRange(filterSeriesByAltKey(series, A).points, "7d");

    assert.equal(only.reduce((s, p) => s + p.costUsd, 0), 7); // $1 × 7일
  });

  it("일평균 KPI 도 키 기준으로 계산된다", () => {
    assert.equal(computeKpis(series, "7d").avgDailyCostUsd, 10);
    assert.equal(computeKpis(filterSeriesByAltKey(series, A), "7d").avgDailyCostUsd, 1);
  });
});

// ------------------------------------------------------------------- 라벨

describe("findAltItemLabel", () => {
  it("표시 이름을 찾아 준다 (차트 제목용)", () => {
    const series = makeSeries([
      day("2026-08-01", { [A]: { cost: 1, tokens: 1, label: "삼성전자-테스트" } }),
    ]);

    assert.equal(findAltItemLabel(series, A), "삼성전자-테스트");
  });

  it("지금 기간에 없어도 전 구간을 뒤져 찾는다", () => {
    const series = makeSeries([
      day("2026-08-01", { [A]: { cost: 1, tokens: 1, label: "옛 거래처" } }),
      day("2026-08-02", { [B]: { cost: 1, tokens: 1 } }),
    ]);

    assert.equal(findAltItemLabel(series, A), "옛 거래처");
  });

  it("아예 없는 키면 undefined", () => {
    const series = makeSeries([day("2026-08-01", { [A]: { cost: 1, tokens: 1 } })]);

    assert.equal(findAltItemLabel(series, "apikey_없음"), undefined);
  });
});
