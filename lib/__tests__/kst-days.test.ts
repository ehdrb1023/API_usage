/**
 * lib/kst-days.ts 유닛 테스트 — 순수 함수라 네트워크를 타지 않습니다.
 *
 * 지키려는 것:
 *   1. UTC 15:00 버킷은 **다음 KST 날짜**로 넘어간다 (하루 경계가 여기다)
 *   2. 단가는 **실측 비용** 에서만 뽑는다 (재구성한 추정치로 되먹이면 순환)
 *   3. 재구성해도 구간 전체 비용 합계는 보존된다
 *   4. KST 오늘은 사용량이 비어도 하루가 사라지지 않는다
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANTHROPIC_BUILD,
  toCostRows,
  toUsageRows,
  type UsageResult,
} from "@/lib/adapters/anthropic";
import { buildDailyPoints } from "@/lib/adapters/core";
import { buildKstDays, buildKstToday } from "@/lib/kst-days";

const MTOK = 1_000_000;

function usage(model: string, apiKeyId: string, output: number): UsageResult {
  return {
    model,
    api_key_id: apiKeyId,
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: output,
  };
}

function hour(startedAt: string, results: UsageResult[]) {
  return { startedAt, usage: toUsageRows(results) };
}

/** sonnet-5 출력 토큰 $15/MTok 을 깔아 둔다 (원본은 센트 문자열). */
function costDay(date: string, usd: number) {
  return {
    date,
    cost: toCostRows([
      {
        amount: String(usd * 100),
        currency: "USD",
        model: "claude-sonnet-5",
        description: null,
        token_type: "output_tokens",
      },
    ]),
  };
}

const THREE_HOURS = [
  hour("2026-08-24T14:00:00Z", [usage("claude-sonnet-5", "key_a", 1 * MTOK)]),
  hour("2026-08-24T15:00:00Z", [usage("claude-sonnet-5", "key_a", 2 * MTOK)]),
  hour("2026-08-25T14:00:00Z", [usage("claude-sonnet-5", "key_a", 4 * MTOK)]),
];

describe("buildKstDays", () => {
  it("UTC 15:00 을 경계로 KST 날짜가 넘어간다", () => {
    // 실측 비용: 총 7M 출력 토큰에 $105 → $15/MTok
    const { days } = buildKstDays({
      hourly: THREE_HOURS,
      cost: [costDay("2026-08-24", 105)],
    });

    const points = buildDailyPoints(days, ANTHROPIC_BUILD);
    assert.deepEqual(
      points.map((p) => p.date),
      ["2026-08-24", "2026-08-25"],
    );
    // 14:00Z 만 24일에 남고, 15:00Z 부터는 25일로 넘어간다.
    assert.equal(points[0].metrics.outputTokens, 1 * MTOK);
    assert.equal(points[1].metrics.outputTokens, 6 * MTOK);
  });

  it("KST 로 다시 나눠도 구간 전체 비용은 보존된다", () => {
    const { days } = buildKstDays({
      hourly: THREE_HOURS,
      cost: [costDay("2026-08-24", 105)],
    });

    const points = buildDailyPoints(days, ANTHROPIC_BUILD);
    const total = points.reduce((s, p) => s + p.costUsd, 0);
    assert.ok(Math.abs(total - 105) < 1e-6, `합계 ${total}`);
    // 날짜별로도 단가 × 토큰이 맞아야 한다.
    assert.ok(Math.abs(points[0].costUsd - 15) < 1e-6);
    assert.ok(Math.abs(points[1].costUsd - 90) < 1e-6);
  });

  it("단가는 실측 비용에서만 뽑는다 — 추정치를 되먹이지 않는다", () => {
    const source = {
      hourly: [hour("2026-08-24T14:00:00Z", [usage("claude-sonnet-5", "key_a", MTOK)])],
      cost: [costDay("2026-08-24", 15)],
    };
    const first = buildKstDays(source);
    // 같은 입력으로 다시 돌려도 단가가 흔들리면 안 된다 (순환 참조 회귀 방지).
    const second = buildKstDays(source);
    assert.deepEqual(first.rates.byModelTokenType, second.rates.byModelTokenType);
    assert.equal(
      first.rates.byModelTokenType["claude-sonnet-5\toutput_tokens"] * MTOK,
      15,
    );
  });

  it("사용량이 없으면 빈 시리즈다 (버킷을 지어내지 않는다)", () => {
    const { days } = buildKstDays({ hourly: [], cost: [] });
    assert.equal(days.length, 0);
  });
});

describe("buildKstToday", () => {
  it("사용량이 비어도 오늘 하루는 남는다 (KST 자정 직후)", () => {
    const { rates } = buildKstDays({
      hourly: THREE_HOURS,
      cost: [costDay("2026-08-24", 105)],
    });

    const point = buildDailyPoints(
      [buildKstToday("2026-08-26", [], rates)],
      ANTHROPIC_BUILD,
    )[0];

    // 자정 직후에 "오늘" 줄이 통째로 사라지면 미니 위젯이 빈 화면이 된다.
    assert.equal(point.date, "2026-08-26");
    assert.equal(point.costUsd, 0);
    assert.equal(point.metrics.totalTokens, 0);
  });

  it("오늘 사용량에 하루 캐시의 단가를 그대로 곱한다", () => {
    const { rates } = buildKstDays({
      hourly: THREE_HOURS,
      cost: [costDay("2026-08-24", 105)],
    });

    const today = buildKstToday(
      "2026-08-26",
      toUsageRows([usage("claude-sonnet-5", "key_a", 3 * MTOK)]),
      rates,
    );
    const point = buildDailyPoints([today], ANTHROPIC_BUILD)[0];

    assert.ok(Math.abs(point.costUsd - 45) < 1e-6, `비용 ${point.costUsd}`);
  });
});
