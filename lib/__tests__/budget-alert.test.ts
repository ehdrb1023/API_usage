/**
 * lib/budget-alert.ts 유닛 테스트 — 순수 판정, 네트워크·Blob 없음.
 *
 * 지키려는 것:
 *   1. 단계가 오를 때만 메시지가 생긴다
 *   2. 같은 단계 유지는 메시지 없음
 *   3. 주의·위험 → 0 회복은 "돌아왔습니다" 한 건
 *   4. 미설정(unconfigured) 카드는 알림 대상이 아니다
 *   5. 본문에 키 값이 아니라 금액·퍼센트만
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BudgetCard } from "@/lib/budget";
import { describeCard, planSweep } from "@/lib/budget-alert";

function card(over: Partial<BudgetCard> = {}): BudgetCard {
  return {
    id: "claude",
    label: "Claude (Anthropic)",
    unit: "USD",
    todaySpend: 1,
    monthSpend: 85,
    remaining: 15,
    monthlyBudget: 100,
    budgetPct: 0.85,
    runwayDays: 5,
    level: 1,
    mode: "manual",
    manualAt: "2026-10-01",
    ...over,
  };
}

describe("planSweep", () => {
  it("단계가 오르면 메시지 1건", () => {
    const plan = planSweep([card({ level: 2 })], { claude: 1 });
    assert.equal(plan.raised.length, 1);
    assert.equal(plan.messages.length, 1);
    assert.equal(plan.messages[0].tone, "warn");
    assert.equal(plan.nextState.claude, 2);
  });

  it("같은 단계 유지는 조용", () => {
    const plan = planSweep([card({ level: 1 })], { claude: 1 });
    assert.equal(plan.raised.length, 0);
    assert.equal(plan.messages.length, 0);
  });

  it("처음 보는 카드도 0보다 높으면 알린다", () => {
    const plan = planSweep([card({ level: 3 })], {});
    assert.equal(plan.raised.length, 1);
    assert.equal(plan.messages[0].tone, "critical");
  });

  it("주의에서 정상으로 돌아오면 회복 한 건", () => {
    const plan = planSweep([card({ level: 0 })], { claude: 2 });
    assert.equal(plan.recovered.length, 1);
    assert.equal(plan.messages.length, 1);
    assert.equal(plan.messages[0].tone, "recovered");
    assert.equal(plan.nextState.claude, 0);
  });

  it("알림(1)에서 정상으로 내려오면 회복 알림은 없다", () => {
    const plan = planSweep([card({ level: 0 })], { claude: 1 });
    assert.equal(plan.recovered.length, 0);
    assert.equal(plan.messages.length, 0);
  });

  it("미설정 카드는 단계 0 으로만 기록하고 알리지 않는다", () => {
    const plan = planSweep(
      [card({ level: 3, unconfigured: "키 없음" })],
      { claude: 0 },
    );
    assert.equal(plan.raised.length, 0);
    assert.equal(plan.nextState.claude, 0);
  });
});

describe("describeCard", () => {
  it("금액·퍼센트·러너웨이만, 키 값 없음", () => {
    const s = describeCard(card());
    assert.match(s, /\$85\.00/);
    assert.match(s, /85%/);
    assert.match(s, /5일 뒤 바닥/);
    assert.doesNotMatch(s, /sk-/);
  });

  it("원화 카드는 원 표기", () => {
    const s = describeCard(
      card({ id: "solapi", unit: "KRW", remaining: 8000, monthSpend: null, monthlyBudget: null, budgetPct: null, runwayDays: null }),
    );
    assert.match(s, /8,000원/);
  });
});
