/**
 * lib/billing/parse-receipt.ts 유닛 테스트.
 *
 * 본문은 **2026-08-27 에 실제 받은 메일에서 그대로 떠 온 것**이다. 손으로 지어낸
 * 샘플로 테스트하면 파서가 아니라 내 상상을 검증하게 된다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyKind, matchRule, parseMail, type RawMail } from "../parse-receipt";
import { validateBillingConfig } from "../sources";
import { receiptKey, type Receipt } from "../types";

const CONFIG = validateBillingConfig({
  mailboxes: [{ address: "speciai250331@gmail.com", active: true }],
  vendorRules: [
    {
      vendor: "Anthropic",
      senderPattern: "^invoice\\+statements@mail\\.anthropic\\.com$",
      template: "stripe-receipt",
    },
    {
      vendor: "Anthropic",
      senderPattern: "^failed-payments@mail\\.anthropic\\.com$",
      template: "anthropic-failed",
      kind: "failed",
    },
    {
      vendor: "OpenAI",
      senderPattern: "^noreply@tm\\.openai\\.com$",
      template: "openai-notice",
    },
    {
      vendor: null,
      senderPattern: "^invoice\\+statements(\\+acct_[A-Za-z0-9]+)?@stripe\\.com$",
      template: "stripe-receipt",
    },
  ],
});

const mail = (over: Partial<RawMail>): RawMail => ({
  messageId: "m1",
  sender: "invoice+statements@mail.anthropic.com",
  subject: "",
  date: "2026-08-16T09:10:08Z",
  plaintextBody: "",
  mailbox: "speciai250331@gmail.com",
  ...over,
});

const must = (r: ReturnType<typeof parseMail>): Receipt => {
  assert.equal(r.ok, true, r.ok ? "" : `파싱 실패: ${r.reason}`);
  return (r as { ok: true; receipt: Receipt }).receipt;
};

// ── 실제 본문 ────────────────────────────────────────────────────────────

/** 2026-08-16 Anthropic — Max 구독. */
const ANTHROPIC_SUBSCRIPTION = `Anthropic, PBC (https://www.anthropic.com/)

Anthropic, PBC

Receipt from Anthropic, PBC $200.00 Paid August 16, 2026 (invoice illustration [https://stripe-images.s3.amazonaws.com/emails/invoices_invoice_illustration.png]) Download invoice (https://pay.stripe.com/invoice/acct_1MExQ9BjIQrRQnux/live_x/pdf?s=em) Download receipt (https://dashboard.stripe.com/receipts/invoices/y/pdf?s=em) Receipt number 2070-4164-2450 Invoice number ITRMHVSC-0017 Payment method Link

Receipt #2070-4164-2450 Aug 16–Sep 16, 2026 Max plan - 20x Qty 1 $200.00 Total $200.00 Amount paid $200.00 Questions? Visit our support site (https://support.anthropic.com/).

Powered by stripe logo (https://stripe.com)`;

/** 2026-08-08 Deep Infra — Stripe 재판매사, 카드 결제, 선불. */
const DEEPINFRA_PREPAY = `Deep Infra Inc. (http://deepinfra.com)

Deep Infra Inc.

Receipt from Deep Infra Inc. $5.00 Paid August 8, 2026 (invoice illustration [x]) Download invoice (https://pay.stripe.com/invoice/z/pdf?s=em) Receipt number 2978-7957 Invoice number ECORE5KG-0001 Payment method - 4411

Receipt #2978-7957 Prepayment Qty 1 $5.00 Total $5.00 Amount paid $5.00 Questions? Contact us at stripe@deepinfra.com

Powered by stripe logo (https://stripe.com)`;

/** 2026-08-13 OpenAI — API 크레딧 충전. 영수증 번호가 없다. */
const OPENAI_TOPUP = ` Your OpenAI API account has been funded

| |

| Hi speciai, We charged $10.00 to your credit card ending in 4411 to fund your OpenAI API credit balance. You may review your billing history[](http://url3243.email.openai.com/ls/click?upn=x) at any time. |

| You received this email because you have a paid account with OpenAI Organization: speciai (org-MJ44dGHKfhIhWYyFW8V7hzpK) |`;

// ─────────────────────────────────────────────────────────────────────────

describe("보낸사람 → 규칙", () => {
  it("Anthropic 과 Stripe 재판매사를 구분한다", () => {
    assert.equal(matchRule("invoice+statements@mail.anthropic.com", CONFIG)?.vendor, "Anthropic");
    // Stripe 는 vendor 가 null — 업체 이름은 본문에서 읽어야 한다.
    assert.equal(
      matchRule("invoice+statements+acct_1M7T5mAfqHmFttwV@stripe.com", CONFIG)?.vendor,
      null,
    );
  });

  it('"이름" <주소> 형태에서도 주소를 뽑아낸다', () => {
    assert.equal(
      matchRule('"OpenAI" <noreply@tm.openai.com>', CONFIG)?.vendor,
      "OpenAI",
    );
  });

  it("모르는 보낸사람은 결제 메일이 아니다", () => {
    assert.equal(matchRule("friend@example.com", CONFIG), null);
    const r = parseMail(mail({ sender: "friend@example.com" }), CONFIG);
    assert.equal(r.ok, false);
  });
});

describe("Stripe 영수증 — Anthropic 구독", () => {
  const r = must(
    parseMail(
      mail({
        plaintextBody: ANTHROPIC_SUBSCRIPTION,
        subject: "Your receipt from Anthropic, PBC #2070-4164-2450",
        attachments: ["Invoice-ITRMHVSC-0017.pdf", "Receipt-2070-4164-2450.pdf"],
      }),
      CONFIG,
    ),
  );

  it("금액·결제일을 본문에서 읽는다 (메일 수신일이 아니다)", () => {
    assert.equal(r.amount, 200);
    assert.equal(r.currency, "USD");
    assert.equal(r.paidOn, "2026-08-16");
  });

  it("영수증·인보이스 번호를 뽑는다", () => {
    assert.equal(r.receiptNumber, "2070-4164-2450");
    assert.equal(r.invoiceNumber, "ITRMHVSC-0017");
  });

  it("요금제로 분류한다 — 이게 API 와 갈리는 지점이다", () => {
    assert.equal(r.kind, "subscription");
    assert.equal(r.lineItem, "Max plan - 20x");
  });

  it("구독 기간을 읽고, 시작 쪽 빠진 연도를 끝에서 빌려 온다", () => {
    assert.equal(r.periodStart, "2026-08-16");
    assert.equal(r.periodEnd, "2026-09-16");
  });

  it("Link 결제는 카드가 아니므로 cardLast4 가 null 이다", () => {
    assert.equal(r.paymentMethod, "Link");
    assert.equal(r.cardLast4, null);
  });

  it("증빙 첨부 파일명을 남긴다", () => {
    assert.deepEqual(r.attachments, [
      "Invoice-ITRMHVSC-0017.pdf",
      "Receipt-2070-4164-2450.pdf",
    ]);
  });
});

describe("Stripe 영수증 — Deep Infra (재판매사)", () => {
  const r = must(
    parseMail(
      mail({
        sender: "invoice+statements+acct_1M7T5mAfqHmFttwV@stripe.com",
        subject: "Your receipt from Deep Infra Inc. #2978-7957",
        plaintextBody: DEEPINFRA_PREPAY,
      }),
      CONFIG,
    ),
  );

  it("규칙에 vendor 가 없으면 본문에서 업체명을 읽는다", () => {
    assert.equal(r.vendor, "Deep Infra Inc.");
  });

  it("카드 끝 4자리를 뽑는다", () => {
    assert.equal(r.cardLast4, "4411");
  });

  it("선불 충전으로 분류한다 (구독이 아니다)", () => {
    assert.equal(r.kind, "prepaid_topup");
    assert.equal(r.lineItem, "Prepayment");
  });

  it("기간이 없는 영수증은 기간이 null 이다", () => {
    assert.equal(r.periodStart, null);
    assert.equal(r.periodEnd, null);
  });
});

describe("OpenAI 충전 알림", () => {
  const r = must(
    parseMail(
      mail({
        sender: "noreply@tm.openai.com",
        subject: "Your OpenAI API account has been funded",
        date: "2026-08-13T05:43:34Z",
        plaintextBody: OPENAI_TOPUP,
      }),
      CONFIG,
    ),
  );

  it("금액과 카드 4자리를 읽는다", () => {
    assert.equal(r.amount, 10);
    assert.equal(r.cardLast4, "4411");
  });

  it("영수증 번호가 없어서 대체 키로 떨어진다", () => {
    assert.equal(r.receiptNumber, null);
    assert.equal(receiptKey(r), "OpenAI:fallback:2026-08-13:10:4411");
  });

  it("금액이 없는 알림(로그인·구독 안내)은 영수증으로 만들지 않는다", () => {
    const res = parseMail(
      mail({
        sender: "noreply@tm.openai.com",
        subject: "New sign-in to your OpenAI account",
        plaintextBody: "We noticed a new sign-in to your OpenAI account.",
      }),
      CONFIG,
    );
    assert.equal(res.ok, false);
  });
});

describe("결제 실패", () => {
  it("제목에서 금액을 읽고 failed 로 고정한다", () => {
    const r = must(
      parseMail(
        mail({
          sender: "failed-payments@mail.anthropic.com",
          subject: "$500.00 payment to Anthropic, PBC was unsuccessful",
          plaintextBody: "We weren't able to charge the credit card you provided.",
        }),
        CONFIG,
      ),
    );
    assert.equal(r.kind, "failed");
    assert.equal(r.amount, 500);
  });
});

describe("중복 판정 키", () => {
  it("**메일함이 달라도 같은 영수증은 같은 키다**", () => {
    const base = mail({
      plaintextBody: ANTHROPIC_SUBSCRIPTION,
      subject: "Your receipt from Anthropic, PBC #2070-4164-2450",
    });
    const a = must(parseMail(base, CONFIG));
    const b = must(
      parseMail({ ...base, mailbox: "새주소@gmail.com", messageId: "m2" }, CONFIG),
    );

    // 메일함을 갈아타는 동안 같은 영수증이 두 곳에 들어와도 두 번 계상되면 안 된다.
    assert.notEqual(a.sourceMailbox, b.sourceMailbox);
    assert.equal(receiptKey(a), receiptKey(b));
  });
});

describe("종류 판정", () => {
  it("요금제·API·충전을 가른다", () => {
    assert.equal(classifyKind("Max plan - 20x"), "subscription");
    assert.equal(classifyKind("ChatGPT Pro subscription"), "subscription");
    assert.equal(classifyKind("Prepayment"), "prepaid_topup");
    assert.equal(classifyKind("API credit top-up"), "prepaid_topup");
    assert.equal(classifyKind("Claude API usage"), "api_usage");
  });

  it("**못 가르면 unknown 이다** — 넘겨짚지 않는다", () => {
    // 넘겨짚어 api_usage 로 떨어뜨리면 요금제 합계가 조용히 작아진다.
    assert.equal(classifyKind("Something entirely new"), "unknown");
    assert.equal(classifyKind(null), "unknown");
  });
});
