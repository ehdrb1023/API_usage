/**
 * lib/anthropic-kst.ts 유닛 테스트 — 순수 함수라 네트워크를 타지 않습니다.
 *
 * 지키려는 것:
 *   1. UTC 15:00 버킷은 **다음 KST 날짜**로 넘어간다 (하루 경계가 여기다)
 *   2. 단가는 **실측 cost_report** 에서만 뽑는다 (재구성한 추정치로 되먹이면 순환)
 *   3. 재구성해도 구간 전체 비용 합계는 보존된다
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adaptAnthropic, type UsageResult } from "@/lib/adapters/anthropic";
import { buildKstDays } from "@/lib/anthropic-kst";

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

function hour(startingAt: string, results: UsageResult[]) {
  return { starting_at: startingAt, results };
}

/** sonnet-5 출력 토큰 $15/MTok 을 깔아 둔다 (센트 문자열). */
function costDay(date: string, usd: number) {
  return {
    starting_at: `${date}T00:00:00Z`,
    ending_at: `${date}T00:00:00Z`,
    results: [
      {
        amount: String(usd * 100),
        currency: "USD",
        model: "claude-sonnet-5",
        description: null,
        token_type: "output_tokens",
      },
    ],
  };
}

describe("buildKstDays", () => {
  it("UTC 15:00 을 경계로 KST 날짜가 넘어간다", () => {
    const { raw } = buildKstDays({
      hourly: [
        hour("2026-08-24T14:00:00Z", [usage("claude-sonnet-5", "key_a", 1 * MTOK)]),
        hour("2026-08-24T15:00:00Z", [usage("claude-sonnet-5", "key_a", 2 * MTOK)]),
        hour("2026-08-25T14:00:00Z", [usage("claude-sonnet-5", "key_a", 4 * MTOK)]),
      ],
      // 실측 비용: 총 7M 출력 토큰에 $105 → $15/MTok
      cost: [costDay("2026-08-24", 105)],
    });

    const points = adaptAnthropic(raw);
    assert.deepEqual(
      points.map((p) => p.date),
      ["2026-08-24", "2026-08-25"],
    );
    // 14:00Z 만 24일에 남고, 15:00Z 부터는 25일로 넘어간다.
    assert.equal(points[0].metrics.outputTokens, 1 * MTOK);
    assert.equal(points[1].metrics.outputTokens, 6 * MTOK);
  });

  it("KST 로 다시 나눠도 구간 전체 비용은 보존된다", () => {
    const { raw } = buildKstDays({
      hourly: [
        hour("2026-08-24T14:00:00Z", [usage("claude-sonnet-5", "key_a", 1 * MTOK)]),
        hour("2026-08-24T15:00:00Z", [usage("claude-sonnet-5", "key_a", 2 * MTOK)]),
        hour("2026-08-25T14:00:00Z", [usage("claude-sonnet-5", "key_a", 4 * MTOK)]),
      ],
      cost: [costDay("2026-08-24", 105)],
    });

    const points = adaptAnthropic(raw);
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
    const { raw } = buildKstDays({ hourly: [], cost: [] });
    assert.equal(raw.usage_report.data.length, 0);
    assert.equal(raw.cost_report.data.length, 0);
  });

  it("API 키 목록을 그대로 실어 보낸다 (키 이름 매핑에 필요)", () => {
    const { raw } = buildKstDays({
      hourly: [],
      cost: [],
      apiKeys: [{ id: "apikey_1", name: "brief", status: "active" }],
    });
    assert.equal(raw.api_keys?.[0].name, "brief");
  });
});
