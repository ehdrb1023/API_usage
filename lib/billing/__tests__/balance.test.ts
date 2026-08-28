/**
 * lib/billing/balance.ts — 선불 잔액 추정 테스트.
 *
 * 품목은 2026-08-27 에 실제로 받은 영수증에서 그대로 가져온 것이다.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { daysRemaining, pocketOf, prepaidBalance, topupWindows } from "../balance";
import type { Receipt } from "../types";

const topup = (vendor: string, paidOn: string, amount: number, lineItem: string): Receipt => ({
  vendor,
  kind: "prepaid_topup",
  paidOn,
  amount,
  currency: "USD",
  receiptNumber: `${vendor}-${paidOn}-${amount}`,
  invoiceNumber: null,
  lineItem,
  periodStart: null,
  periodEnd: null,
  cardLast4: null,
  paymentMethod: null,
  sourceMailbox: "a@b.com",
  sourceMessageId: `${vendor}-${paidOn}`,
  sourceSender: "x@y.com",
  sourceSubject: "",
  attachments: [],
});

describe("주머니 판정 — 합치면 안 되는 두 곳", () => {
  it("**API 크레딧과 구독 초과분을 가른다** (실측 품목)", () => {
    assert.equal(pocketOf("One-time credit purchase"), "api");
    assert.equal(pocketOf("Prepaid extra usage, Individual plan"), "plan");
  });

  it('"plan" 이 들어 있으면 구독 쪽이다 — 순서를 잘못 두면 API 로 샌다', () => {
    // "Prepaid" 도 들어 있어서 API 규칙을 먼저 보면 잘못 잡힌다.
    assert.equal(pocketOf("Prepaid extra usage, Individual plan"), "plan");
    assert.equal(pocketOf("Max plan - 20x"), "plan");
  });

  it("나머지 실측 품목", () => {
    assert.equal(pocketOf("API credit top-up"), "api");
    assert.equal(pocketOf("Prepayment"), "api");
    // ⚠️ classifyKind 에만 넣고 여기 빠뜨려서 "미상" 으로 샜던 적이 있다.
    assert.equal(pocketOf("Auto-recharge credits"), "api");
  });

  it("못 가르면 unknown — 넘겨짚지 않는다", () => {
    assert.equal(pocketOf("Something new"), "unknown");
    assert.equal(pocketOf(null), "unknown");
  });
});

describe("충전 창", () => {
  const windows = topupWindows([
    topup("Anthropic", "2026-07-08", 200, "Prepaid extra usage, Individual plan"),
    topup("Anthropic", "2026-07-31", 500, "One-time credit purchase"),
    topup("OpenAI", "2026-07-28", 10, "API credit top-up"),
    topup("OpenAI", "2026-08-03", 10, "API credit top-up"),
    topup("OpenAI", "2026-08-13", 10, "API credit top-up"),
  ]);

  it("**같은 벤더라도 주머니가 다르면 따로 센다**", () => {
    const anthropic = windows.filter((w) => w.vendor === "Anthropic");
    assert.equal(anthropic.length, 2);
    assert.equal(anthropic.find((w) => w.pocket === "api")!.toppedUp, 500);
    assert.equal(anthropic.find((w) => w.pocket === "plan")!.toppedUp, 200);
  });

  it("충전을 합치고 **가장 이른 날**을 시작점으로 잡는다", () => {
    const openai = windows.find((w) => w.vendor === "OpenAI")!;
    assert.equal(openai.toppedUp, 30);
    assert.equal(openai.count, 3);
    // 소진은 이 날부터 세야 한다. 그 전에 쓴 건 이 돈이 아니다.
    assert.equal(openai.since, "2026-07-28");
  });

  it("선불이 아닌 영수증은 무시한다", () => {
    const subs: Receipt = { ...topup("Anthropic", "2026-08-16", 200, "Max plan - 20x"), kind: "subscription" };
    assert.equal(topupWindows([subs]).length, 0);
  });
});

describe("잔액", () => {
  const windows = topupWindows([
    topup("Anthropic", "2026-07-31", 500, "One-time credit purchase"),
    topup("Anthropic", "2026-07-08", 200, "Prepaid extra usage, Individual plan"),
    topup("Deep Infra Inc.", "2026-08-08", 5, "Prepayment"),
  ]);

  const rows = prepaidBalance(windows, { Anthropic: 346.74 });

  it("API 주머니는 넣은 돈에서 쓴 돈을 뺀다", () => {
    const api = rows.find((r) => r.vendor === "Anthropic" && r.pocket === "api")!;
    assert.equal(api.spent, 346.74);
    assert.equal(api.balance, 153.26);
  });

  it("**구독 주머니는 소진을 알 수 없다 — 0 이 아니라 null 이다**", () => {
    const plan = rows.find((r) => r.vendor === "Anthropic" && r.pocket === "plan")!;
    // Claude Code 사용분은 Admin API 에 안 잡힌다. 0 으로 두면
    // "$200 이 그대로 남아 있다" 는 틀린 말이 된다.
    assert.equal(plan.spent, null);
    assert.equal(plan.balance, null);
  });

  it("**조회 API 가 없는 벤더도 null 이다**", () => {
    const di = rows.find((r) => r.vendor === "Deep Infra Inc.")!;
    // spentByVendor 에 키가 아예 없다 → 모른다.
    assert.equal(di.spent, null);
  });

  it("시작 잔액을 모른다는 사실을 항상 달고 다닌다", () => {
    for (const r of rows) assert.equal(r.openingUnknown, true);
  });
});

describe("남은 기간 어림", () => {
  const [row] = prepaidBalance(
    topupWindows([topup("Anthropic", "2026-07-31", 500, "One-time credit purchase")]),
    { Anthropic: 300 },
  );

  it("하루 소진 속도로 나눈다", () => {
    // 7/31~8/30 = 30일에 $300 → 하루 $10. 남은 $200 → 20일.
    assert.equal(daysRemaining(row, "2026-08-30"), 20);
  });

  it("**소진이 0 이면 '무한' 이라고 하지 않는다**", () => {
    const [zero] = prepaidBalance(
      topupWindows([topup("X", "2026-08-01", 100, "API credit top-up")]),
      { X: 0 },
    );
    assert.equal(daysRemaining(zero, "2026-08-30"), null);
  });

  it("잔액을 모르면 null", () => {
    const [unknown] = prepaidBalance(
      topupWindows([topup("Y", "2026-08-01", 100, "Prepaid extra usage, plan")]),
      {},
    );
    assert.equal(daysRemaining(unknown, "2026-08-30"), null);
  });
});
