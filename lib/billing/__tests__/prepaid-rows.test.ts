/**
 * 선불 잔액 판정 테스트.
 *
 * 이 모듈의 값어치는 잔액 뺄셈이 아니라 **"이 숫자를 내보내도 되는가"** 판정에 있다.
 * 그래서 테스트도 거기에 몰려 있다 — 잘못 통과하면 "다 썼는데 여유 있다" 가
 * 화면에 뜬다.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TopupWindow } from "../balance";
import { buildPrepaidRows, selectTopups, type Coverage } from "../prepaid-rows";
import type { ChargeKind, Receipt } from "../types";

function win(over: Partial<TopupWindow> = {}): TopupWindow {
  return {
    vendor: "OpenAI",
    pocket: "api",
    toppedUp: 30,
    since: "2026-07-28",
    count: 3,
    ...over,
  };
}

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    vendor: "OpenAI",
    kind: "prepaid_topup" as ChargeKind,
    paidOn: "2026-08-13",
    amount: 10,
    currency: "USD",
    receiptNumber: null,
    invoiceNumber: null,
    lineItem: "API credit top-up",
    periodStart: null,
    periodEnd: null,
    cardLast4: "4411",
    paymentMethod: null,
    sourceMailbox: "a@b.c",
    sourceMessageId: `m-${over.paidOn ?? "2026-08-13"}-${over.amount ?? 10}`,
    sourceSender: "noreply@tm.openai.com",
    sourceSubject: "funded",
    attachments: [],
    ...over,
  };
}

describe("buildPrepaidRows — 잔액을 내놓는 경우", () => {
  it("창 전체를 덮은 조회면 잔액과 남은 일수를 낸다", () => {
    const cov: Coverage = { from: "2026-07-28", spent: 27.05 };
    const [row] = buildPrepaidRows([win()], [cov], "2026-09-04");

    assert.equal(row.balanceUnknownReason, null);
    assert.equal(row.balance, 2.95);
    assert.equal(row.coverageComplete, true);
    // 38일간 $27.05 → 하루 $0.712 → $2.95 는 약 4일치.
    assert.equal(row.daysLeft, 4);
  });

  it("조회 시작일이 첫 충전보다 앞서도 창 전체를 덮은 것으로 본다", () => {
    const cov: Coverage = { from: "2026-07-01", spent: 27.05 };
    const [row] = buildPrepaidRows([win()], [cov], "2026-09-04");

    assert.equal(row.coverageComplete, true);
    assert.equal(row.balance, 2.95);
  });
});

describe("buildPrepaidRows — 잔액을 못 내놓는 네 경우", () => {
  it("구독 초과분은 조회값이 있어도 쓰지 않는다", () => {
    // Admin API 는 이 주머니를 못 본다. 조회값을 넘겨도 반영되면 안 된다.
    const cov: Coverage = { from: "2026-07-08", spent: 999 };
    const [row] = buildPrepaidRows(
      [win({ vendor: "Anthropic", pocket: "plan", toppedUp: 200, since: "2026-07-08" })],
      [cov],
      "2026-09-04",
    );

    assert.equal(row.spent, null);
    assert.equal(row.balance, null);
    assert.match(row.balanceUnknownReason ?? "", /구독 초과분/);
  });

  it("조회 API 를 안 붙인 벤더는 사유에 벤더명을 적는다", () => {
    const [row] = buildPrepaidRows(
      [win({ vendor: "Deep Infra Inc.", toppedUp: 5, since: "2026-08-08" })],
      [null],
      "2026-09-04",
    );

    assert.equal(row.balance, null);
    assert.match(row.balanceUnknownReason ?? "", /Deep Infra Inc\./);
  });

  it("조회 구간이 첫 충전 앞을 못 덮으면 잔액을 내지 않는다", () => {
    // 여기서 부분 조회값을 잔액에 쓰면 6·7월에 쓴 돈이 빠져 잔액이 부풀려진다.
    const cov: Coverage = { from: "2026-08-01", spent: 12.5 };
    const [row] = buildPrepaidRows([win()], [cov], "2026-09-04");

    assert.equal(row.coverageComplete, false);
    assert.equal(row.balance, null);
    assert.equal(row.spentInCoverage, 12.5, "부분 지출은 그래도 보여 준다");
    assert.match(row.balanceUnknownReason ?? "", /2026-08-01 부터만/);
  });

  it("잔액이 음수면 시작 잔액이 있었다는 뜻으로 처리하고 남은 일수를 세지 않는다", () => {
    // 실측: Anthropic 충전 $611.09 / 조회된 소진 $618.09.
    const cov: Coverage = { from: "2026-06-04", spent: 618.09 };
    const [row] = buildPrepaidRows(
      [win({ vendor: "Anthropic", toppedUp: 611.09, since: "2026-06-04" })],
      [cov],
      "2026-09-04",
    );

    assert.equal(row.openingImplied, true);
    assert.equal(
      row.daysLeft,
      null,
      "음수 잔액으로 세면 '약 0일'(= 지금 바닥)이 되는데 근거가 없다",
    );
    assert.match(row.balanceUnknownReason ?? "", /이전에 남아 있던 잔액/);
  });
});

describe("buildPrepaidRows — 조용한 어긋남 방지", () => {
  it("창과 조회 결과의 개수가 다르면 던진다", () => {
    // 짝이 어긋나면 A 벤더의 잔액에 B 벤더의 소진이 붙는다. 조용히 맞추지 않는다.
    assert.throws(
      () => buildPrepaidRows([win(), win({ vendor: "Anthropic" })], [null], "2026-09-04"),
      /개수가 다릅니다/,
    );
  });

  it("조회 실패(null)와 지출 0 을 구분한다", () => {
    const failed = buildPrepaidRows([win()], [null], "2026-09-04")[0];
    const zero = buildPrepaidRows([win()], [{ from: "2026-07-28", spent: 0 }], "2026-09-04")[0];

    assert.equal(failed.balance, null, "실패는 잔액을 못 낸다");
    assert.equal(zero.balance, 30, "지출 0 은 전액 남은 것이다");
    // 지출이 0 이면 소진 속도를 모르므로 남은 일수는 '무한'이 아니라 null 이다.
    assert.equal(zero.daysLeft, null);
  });

  it("openingUnknown 은 언제나 붙어 있다", () => {
    const [row] = buildPrepaidRows([win()], [{ from: "2026-07-28", spent: 1 }], "2026-09-04");
    assert.equal(row.openingUnknown, true);
  });
});

describe("selectTopups", () => {
  it("충전 영수증만 최신순으로 고른다", () => {
    const rows = selectTopups([
      receipt({ paidOn: "2026-08-03", amount: 10 }),
      receipt({ paidOn: "2026-08-16", amount: 200, kind: "subscription" }),
      receipt({ paidOn: "2026-08-13", amount: 10 }),
      receipt({ paidOn: "2026-07-31", amount: 500, kind: "failed" }),
    ]);

    assert.deepEqual(
      rows.map((r) => r.paidOn),
      ["2026-08-13", "2026-08-03"],
    );
  });
});
