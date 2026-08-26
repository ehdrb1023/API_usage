/**
 * lib/token-rates.ts 유닛 테스트 — 순수 함수라 네트워크를 타지 않습니다.
 *
 * 핵심 검증 세 가지:
 *   1. 역산한 단가가 **공시 단가와 일치**하는가
 *   2. 단가 → 추정 비용 → 집계를 왕복해도 금액이 보존되는가
 *   3. 벤더 금액 단위 변환이 어댑터 경계에서 끝나는가
 *      (Anthropic 센트 문자열 → USD. 이 환산 실수는 100배 오차다)
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANTHROPIC_BUILD,
  toCostRows,
  toDayRows,
  toUsageRows,
  type AnthropicRaw,
  type UsageResult,
} from "@/lib/adapters/anthropic";
import { buildDailyPoints } from "@/lib/adapters/core";
import { computeRates, estimateCostRows, rateFor } from "@/lib/token-rates";

const MTOK = 1_000_000;

/** 토큰 4종을 다 채운 usage 결과 한 줄. */
function usage(model: string, apiKeyId: string | null, tokens: Partial<{
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}>): UsageResult {
  return {
    model,
    api_key_id: apiKeyId,
    uncached_input_tokens: tokens.input ?? 0,
    cache_read_input_tokens: tokens.cacheRead ?? 0,
    cache_creation: {
      ephemeral_5m_input_tokens: tokens.cacheWrite ?? 0,
      ephemeral_1h_input_tokens: 0,
    },
    output_tokens: tokens.output ?? 0,
  };
}

/** cost_report 는 **센트 문자열**이다. $2.00 = "200". */
function cost(model: string, tokenType: string, usd: number) {
  return {
    amount: String(usd * 100),
    currency: "USD",
    model,
    description: null,
    token_type: tokenType,
  };
}

/**
 * 하루치 원본. sonnet-5 를 실제 공시 단가로 깔아 둔다.
 *   uncached input  $3.00/MTok
 *   cache read      $0.30/MTok
 *   output          $15.00/MTok
 */
function dailyRaw(): AnthropicRaw {
  return {
    usage_report: {
      data: [
        {
          starting_at: "2026-08-24T00:00:00Z",
          ending_at: "2026-08-25T00:00:00Z",
          results: [
            usage("claude-sonnet-5", "key_a", {
              input: 2 * MTOK,
              cacheRead: 10 * MTOK,
              output: 1 * MTOK,
            }),
            usage("claude-haiku-4-5", "key_b", { input: 5 * MTOK }),
          ],
        },
      ],
    },
    cost_report: {
      data: [
        {
          starting_at: "2026-08-24T00:00:00Z",
          ending_at: "2026-08-25T00:00:00Z",
          results: [
            cost("claude-sonnet-5", "uncached_input_tokens", 6),
            cost("claude-sonnet-5", "cache_read_input_tokens", 3),
            cost("claude-sonnet-5", "output_tokens", 15),
            cost("claude-haiku-4-5", "uncached_input_tokens", 5),
          ],
        },
      ],
    },
  };
}

/** 어댑터를 통과시킨 하루치. 여기서 센트가 이미 USD 로 바뀐다. */
const dailyDays = () => toDayRows(dailyRaw());

describe("computeRates", () => {
  it("모델·토큰 종류별 단가를 공시 단가 그대로 역산한다", () => {
    const rates = computeRates(dailyDays());

    assert.equal(rateFor(rates, "claude-sonnet-5", "uncached_input_tokens") * MTOK, 3);
    assert.equal(rateFor(rates, "claude-sonnet-5", "cache_read_input_tokens") * MTOK, 0.3);
    assert.equal(rateFor(rates, "claude-sonnet-5", "output_tokens") * MTOK, 15);
    assert.equal(rateFor(rates, "claude-haiku-4-5", "uncached_input_tokens") * MTOK, 1);
  });

  it("처음 보는 모델은 같은 토큰 종류의 가중평균으로 떨어진다", () => {
    const rates = computeRates(dailyDays());
    // uncached input 은 sonnet 2M($6) + haiku 5M($5) = 7M / $11
    const fallback = rateFor(rates, "claude-opus-9", "uncached_input_tokens");
    assert.ok(Math.abs(fallback * MTOK - 11 / 7) < 1e-9);
  });

  it("토큰 종류까지 처음 보면 전체 블렌디드로 떨어진다", () => {
    const rates = computeRates(dailyDays());
    // 총 비용 $29 / 총 토큰 18M
    const blended = rateFor(rates, "claude-opus-9", "web_search_requests");
    assert.ok(Math.abs(blended * MTOK - 29 / 18) < 1e-9);
  });

  it("토큰이 아닌 비용은 단가에서 빼고 비중만 기록한다", () => {
    const raw = dailyRaw();
    raw.cost_report.data[0].results.push({
      amount: "100", // $1
      currency: "USD",
      model: null,
      description: "Web Search",
      token_type: null,
    });

    const rates = computeRates(toDayRows(raw));
    // 단가는 그대로여야 한다 — $1 이 토큰 단가에 섞이면 안 된다.
    assert.equal(rateFor(rates, "claude-sonnet-5", "output_tokens") * MTOK, 15);
    assert.ok(Math.abs(rates.nonTokenShare - 1 / 30) < 1e-9);
  });

  it("원본이 비면 단가가 0 이고 days 가 0 이다 (추정 불가 신호)", () => {
    const rates = computeRates([]);
    assert.equal(rates.days, 0);
    assert.equal(rates.blended, 0);
  });
});

describe("어댑터 경계의 금액 단위 변환", () => {
  it("Anthropic 센트 문자열은 어댑터에서 USD 가 된다 (100배 오차 방지)", () => {
    const rows = toCostRows([cost("claude-sonnet-5", "output_tokens", 15)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usd, 15);
  });
});

describe("estimateCostRows", () => {
  it("같은 사용량을 넣으면 원래 비용이 그대로 복원된다", () => {
    const raw = dailyRaw();
    const rates = computeRates(toDayRows(raw));
    const rows = estimateCostRows(toUsageRows(raw.usage_report.data[0].results), rates);

    const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
    assert.ok(Math.abs(totalUsd - 29) < 1e-6);
  });

  it("추정 비용을 집계에 태우면 모델별·키별 두 축에 같은 금액이 들어간다", () => {
    const rates = computeRates(dailyDays());
    const usageRows = toUsageRows([
      usage("claude-sonnet-5", "key_a", { output: 2 * MTOK }), // $15/MTok × 2
    ]);

    const point = buildDailyPoints(
      [{ date: "2026-08-25", usage: usageRows, cost: estimateCostRows(usageRows, rates) }],
      ANTHROPIC_BUILD,
    )[0];

    assert.equal(point.date, "2026-08-25");
    assert.ok(Math.abs(point.costUsd - 30) < 1e-6);
    assert.equal(point.metrics.outputTokens, 2 * MTOK);
    // 키별 축에도 같은 금액이 안분돼야 한다 (키가 하나뿐이니 전액).
    assert.equal(point.altItems?.length, 1);
    assert.ok(Math.abs((point.altItems?.[0].costUsd ?? 0) - 30) < 1e-6);
  });

  it("모델을 모르는 사용분은 비용을 만들지 않는다 (토큰 수에는 남는다)", () => {
    const rates = computeRates(dailyDays());
    const rows = estimateCostRows(
      toUsageRows([{ ...usage("x", null, { output: MTOK }), model: null }]),
      rates,
    );
    assert.equal(rows.length, 0);
  });
});
