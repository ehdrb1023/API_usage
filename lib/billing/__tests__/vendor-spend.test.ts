/**
 * lib/billing/vendor-spend.ts 유닛 테스트.
 *
 * 여기서 지키려는 규칙은 셋이다.
 *   1. **실패한 결제를 지출로 세지 않는다** — 실제 데이터에 나가지도 않은 $500 이 있다
 *   2. **수기 값과 영수증을 더하지 않는다** — 더하면 그 벤더만 두 배가 된다
 *   3. **목록에 없는 벤더를 조용히 버리지 않는다** — 그게 "모르게 새는 비용" 이고,
 *      이 표가 애초에 찾으려던 대상이다
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildVendorSpend,
  matchVendorId,
  totalSpend,
} from "@/lib/billing/vendor-spend";
import type { Receipt } from "@/lib/billing/types";
import type { Vendor } from "@/lib/vendors";

const VENDORS = [
  { id: "claude", label: "Claude", domain: "anthropic.com", tier: "primary", paid: "yes", usageApi: "admin-api", billing: "receipt+api", keys: [] },
  { id: "gpt", label: "GPT", domain: "openai.com", tier: "primary", paid: "yes", usageApi: "admin-api", billing: "receipt+api", keys: [] },
  { id: "toss", label: "Toss Payments", domain: "tosspayments.com", tier: "grouped", paid: "yes", usageApi: "none", billing: "receipt", keys: [] },
  { id: "solapi", label: "Solapi (문자·알림톡)", domain: "solapi.com", tier: "grouped", paid: "yes", usageApi: "none", billing: "receipt", keys: [] },
] as Vendor[];

function receipt(vendor: string, kind: Receipt["kind"], paidOn: string, amount: number): Receipt {
  return {
    vendor, kind, paidOn, amount, currency: "USD",
    receiptNumber: null, invoiceNumber: null, lineItem: null,
    periodStart: null, periodEnd: null, cardLast4: null, paymentMethod: null,
    sourceMailbox: "x@y.z", sourceMessageId: "m", sourceSender: "s",
    sourceSubject: "t", attachments: [],
  } as Receipt;
}

describe("matchVendorId", () => {
  it("라벨·id·도메인 앞자리로 잇는다", () => {
    assert.equal(matchVendorId("Claude", VENDORS), "claude");
    assert.equal(matchVendorId("toss", VENDORS), "toss");
    // 영수증에는 "Anthropic" 으로 오는데 우리 id 는 "claude" 다. 도메인이 잇는 자리.
    assert.equal(matchVendorId("Anthropic", VENDORS), "claude");
    assert.equal(matchVendorId("OpenAI", VENDORS), "gpt");
  });

  it("법인 접미사와 기호를 무시한다", () => {
    assert.equal(matchVendorId("Toss Payments Inc.", VENDORS), "toss");
    assert.equal(matchVendorId("  TOSS-PAYMENTS  ", VENDORS), "toss");
  });

  it("모르는 이름은 null 이다", () => {
    assert.equal(matchVendorId("Deep Infra Inc.", VENDORS), null);
    assert.equal(matchVendorId("", VENDORS), null);
  });
});

describe("buildVendorSpend", () => {
  const RECEIPTS = [
    receipt("Anthropic", "subscription", "2026-09-05", 200),
    receipt("Anthropic", "prepaid_topup", "2026-09-20", 100),
    receipt("Anthropic", "credit_note", "2026-09-21", -1.5),
    receipt("OpenAI", "prepaid_topup", "2026-08-31", 30), // 지난달
    receipt("Deep Infra Inc.", "prepaid_topup", "2026-09-10", 5), // 목록에 없음
  ];

  it("같은 달 영수증만 벤더별로 더한다", () => {
    const s = buildVendorSpend(RECEIPTS, VENDORS, {}, "2026-09");
    assert.equal(s.byVendorId.claude, 298.5); // 200 + 100 - 1.5
    assert.equal(s.byVendorId.gpt, undefined); // 8월분은 빠진다
  });

  /** 나가지도 않은 돈을 지출로 세면 안 된다. */
  it("실패한 결제는 합계에서 뺀다", () => {
    const withFailed = [...RECEIPTS, receipt("Anthropic", "failed", "2026-09-11", 500)];
    const s = buildVendorSpend(withFailed, VENDORS, {}, "2026-09");
    assert.equal(s.byVendorId.claude, 298.5);
  });

  it("판정 못 한 종류(unknown)도 세지 않는다", () => {
    const s = buildVendorSpend(
      [receipt("Anthropic", "unknown", "2026-09-11", 77)],
      VENDORS, {}, "2026-09",
    );
    assert.equal(s.byVendorId.claude, undefined);
  });

  /** 이 표가 찾으려던 대상. 조용히 버리면 존재 자체를 모르게 된다. */
  it("목록에 없는 벤더는 따로 담아 돌려준다", () => {
    const s = buildVendorSpend(RECEIPTS, VENDORS, {}, "2026-09");
    assert.deepEqual(s.unregistered, [{ name: "Deep Infra Inc.", amount: 5 }]);
  });

  it("수기 값은 영수증이 없는 벤더만 채운다", () => {
    const manual = { "2026-09": { toss: 12.3, solapi: 4.1 } };
    const s = buildVendorSpend(RECEIPTS, VENDORS, manual, "2026-09");
    assert.equal(s.byVendorId.toss, 12.3);
    assert.equal(s.byVendorId.solapi, 4.1);
    assert.deepEqual(s.manualIds.sort(), ["solapi", "toss"]);
  });

  /** 두 출처를 더하면 그 벤더만 두 배가 된다. */
  it("영수증이 있으면 수기 값을 무시하고 알려준다", () => {
    const manual = { "2026-09": { claude: 999 } };
    const s = buildVendorSpend(RECEIPTS, VENDORS, manual, "2026-09");
    assert.equal(s.byVendorId.claude, 298.5, "수기 값이 영수증을 덮었거나 더해졌다");
    assert.deepEqual(s.overridden, ["claude"]);
    assert.deepEqual(s.manualIds, []);
  });

  it("다른 달의 수기 값은 안 쓴다", () => {
    const manual = { "2026-08": { toss: 12.3 } };
    const s = buildVendorSpend(RECEIPTS, VENDORS, manual, "2026-09");
    assert.equal(s.byVendorId.toss, undefined);
  });

  it("망가진 금액은 건너뛴다", () => {
    const s = buildVendorSpend(
      [receipt("Toss Payments", "api_usage", "2026-09-02", NaN)],
      VENDORS,
      { "2026-09": { solapi: Number.POSITIVE_INFINITY } },
      "2026-09",
    );
    assert.equal(s.byVendorId.toss, undefined);
    assert.equal(s.byVendorId.solapi, undefined);
  });

  it("영수증이 없으면 빈 결과다", () => {
    const s = buildVendorSpend([], VENDORS, {}, "2026-09");
    assert.deepEqual(s.byVendorId, {});
    assert.equal(totalSpend(s), 0);
  });
});

describe("totalSpend", () => {
  it("등록·미등록을 모두 더한다", () => {
    const s = buildVendorSpend(
      [
        receipt("Anthropic", "subscription", "2026-09-05", 200),
        receipt("Deep Infra Inc.", "prepaid_topup", "2026-09-10", 5),
      ],
      VENDORS,
      { "2026-09": { toss: 10 } },
      "2026-09",
    );
    // 200 (영수증) + 10 (수기) + 5 (미등록) — 나간 돈은 전부 센다.
    assert.equal(totalSpend(s), 215);
  });
});
