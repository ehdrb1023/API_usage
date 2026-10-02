/**
 * lib/billing/ledger.ts 유닛 테스트.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildLedger,
  byMonth,
  byPayment,
  categoryOf,
  fromManual,
  fromReceipt,
  totalsByKind,
  type ManualPayment,
} from "../ledger";
import type { Receipt } from "../types";

const receipt = (over: Partial<Receipt>): Receipt => ({
  vendor: "Anthropic",
  kind: "subscription",
  paidOn: "2026-09-20",
  amount: 200,
  currency: "USD",
  receiptNumber: null,
  invoiceNumber: null,
  lineItem: "Max plan - 20x",
  periodStart: null,
  periodEnd: null,
  cardLast4: null,
  paymentMethod: null,
  sourceMailbox: "a@b.com",
  sourceMessageId: "m1",
  sourceSender: "invoice+statements@mail.anthropic.com",
  sourceSubject: "",
  attachments: [],
  ...over,
});

const manual = (over: Partial<ManualPayment>): ManualPayment => ({
  messageId: "x1",
  date: "2026-09-09T01:07:51Z",
  vendor: "메가존(주) (hosting.kr)",
  merchantViaPG: "토스페이먼츠 → 메가존(주) (hosting.kr)",
  item: "도메인 등록",
  kind: "one_time",
  amount: 15400,
  currency: "KRW",
  cardLast4: null,
  cardIssuer: "신한",
  ...over,
});

describe("파서 영수증 → 장부", () => {
  it("선불 충전은 크레딧, 카드 끝자리를 결제 수단으로 쓴다", () => {
    const e = fromReceipt(receipt({ kind: "prepaid_topup", cardLast4: "4411" }));
    assert.equal(e.kind, "credit");
    assert.equal(e.payment, "4411");
    assert.equal(e.isCard, true);
  });

  it("카드가 아닌 수단(Link)은 수단 이름으로 남긴다", () => {
    const e = fromReceipt(receipt({ paymentMethod: "Link" }));
    assert.equal(e.payment, "Link");
    assert.equal(e.isCard, false);
  });

  it("**종류를 못 가른 건은 넘겨짚지 않고 표시를 단다**", () => {
    const e = fromReceipt(receipt({ kind: "unknown" }));
    assert.deepEqual(e.flags, ["종류 미분류"]);
  });
});

describe("수동 기록 → 장부", () => {
  it("PG 를 거친 결제는 실제 가맹점 이름을 쓴다", () => {
    assert.equal(fromManual(manual({})).vendor, "메가존(주) (hosting.kr)");
  });

  it("끝자리 없는 카드는 발급사로 묶는다", () => {
    const e = fromManual(manual({}));
    assert.equal(e.payment, "신한 (끝자리 미표기)");
    assert.equal(e.isCard, false);
  });

  it("**환불은 양수로 적혀 와도 음수로 맞춘다**", () => {
    assert.equal(fromManual(manual({ kind: "refund", amount: 50000 })).amount, -50000);
    assert.equal(fromManual(manual({ kind: "refund", amount: -50000 })).amount, -50000);
  });

  it("결제 수단을 덮어쓴 건(포인트·계좌)은 카드로 세지 않는다", () => {
    const e = fromManual(manual({ cardLast4: "1234", paymentOverride: "네이버페이 포인트" }));
    assert.equal(e.payment, "네이버페이 포인트");
    assert.equal(e.isCard, false);
  });
});

describe("분야", () => {
  it("벤더 이름으로 가른다", () => {
    assert.equal(categoryOf("Anthropic"), "AI");
    assert.equal(categoryOf("Google Cloud Platform & APIs"), "클라우드·인프라");
    assert.equal(categoryOf("토스페이먼츠 → 메가존(주) (hosting.kr)"), "도메인");
    assert.equal(categoryOf("(주)카카오"), "기타");
  });
});

describe("집계", () => {
  const ledger = buildLedger(
    [
      receipt({ kind: "prepaid_topup", amount: 100, cardLast4: "4411", sourceMessageId: "a" }),
      receipt({ kind: "subscription", amount: 200, cardLast4: "8745", sourceMessageId: "b" }),
      receipt({ kind: "failed", amount: 200, sourceMessageId: "c" }),
    ],
    [
      manual({ messageId: "d", amount: 15400 }),
      manual({ messageId: "e", amount: 100, excludeReason: "자사 결제 테스트" }),
    ],
  );

  it("**달러와 원화를 섞지 않는다**", () => {
    const t = totalsByKind(ledger);
    assert.deepEqual(t.credit, { USD: 100 });
    assert.deepEqual(t.one_time, { KRW: 15400 });
  });

  it("실패와 제외 표시 건은 합계에서 빠진다", () => {
    const t = totalsByKind(ledger);
    assert.equal(t.failed, undefined);
    assert.equal(t.one_time?.KRW, 15400);
  });

  it("카드별로 종류를 갈라 보여 준다 — 끝자리를 아는 카드가 위", () => {
    const rows = byPayment(ledger);
    assert.equal(rows[0].isCard, true);
    const c4411 = rows.find((r) => r.payment === "4411")!;
    assert.deepEqual(c4411.byKind.credit, { USD: 100 });
    assert.equal(c4411.byKind.subscription, undefined);
  });

  it("월별 표는 실패 건수를 따로 센다", () => {
    const [sep] = byMonth(ledger);
    assert.equal(sep.month, "2026-09");
    assert.equal(sep.failed, 1);
    assert.deepEqual(sep.total, { USD: 300, KRW: 15400 });
  });
});
