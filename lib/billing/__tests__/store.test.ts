/**
 * lib/billing/store.ts — 저장소·집계 테스트.
 *
 * 파일을 실제로 쓰는 부분은 임시 디렉터리에서 돌린다. `data/` 는 실제 결제
 * 내역이 들어가는 곳이라 테스트가 건드리면 안 된다.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  byCard,
  loadReceipts,
  mergeReceipts,
  mergeUnparsed,
  monthlySummary,
  type Card,
} from "../store";
import type { Receipt } from "../types";

const receipt = (over: Partial<Receipt>): Receipt => ({
  vendor: "Anthropic",
  kind: "subscription",
  paidOn: "2026-08-16",
  amount: 200,
  currency: "USD",
  receiptNumber: null,
  invoiceNumber: null,
  lineItem: null,
  periodStart: null,
  periodEnd: null,
  cardLast4: null,
  paymentMethod: null,
  sourceMailbox: "a@b.com",
  sourceMessageId: "m1",
  sourceSender: "invoice@anthropic.com",
  sourceSubject: "",
  attachments: [],
  ...over,
});

const tmpRoots: string[] = [];
async function tmpRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "billing-test-"));
  tmpRoots.push(dir);
  return dir;
}
after(async () => {
  for (const d of tmpRoots) await fs.rm(d, { recursive: true, force: true });
});

describe("저장 · 중복 제거", () => {
  it("파일이 없으면 빈 배열이다 (아직 안 모은 정상 상태)", async () => {
    assert.deepEqual(await loadReceipts(await tmpRoot()), []);
  });

  it("같은 영수증 번호는 두 번 들어가지 않는다", async () => {
    const root = await tmpRoot();
    const r = receipt({ receiptNumber: "2070-4164-2450" });

    const first = await mergeReceipts([r], root);
    assert.equal(first.added, 1);

    const second = await mergeReceipts([r], root);
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.total, 1);
  });

  it("**메일함이 달라도 같은 영수증은 한 건이다**", async () => {
    const root = await tmpRoot();
    const base = receipt({ receiptNumber: "R-1" });

    await mergeReceipts([base], root);
    // 주소를 갈아타는 동안 같은 영수증이 새 메일함으로도 들어온 상황.
    const res = await mergeReceipts(
      [{ ...base, sourceMailbox: "새주소@gmail.com", sourceMessageId: "m2" }],
      root,
    );

    // 여기서 두 건이 되면 그 달 지출이 두 배로 잡힌다.
    assert.equal(res.added, 0);
    assert.equal(res.total, 1);
  });

  it("결제일 순으로 정렬해 둔다", async () => {
    const root = await tmpRoot();
    await mergeReceipts(
      [
        receipt({ receiptNumber: "c", paidOn: "2026-08-20" }),
        receipt({ receiptNumber: "a", paidOn: "2026-06-01" }),
        receipt({ receiptNumber: "b", paidOn: "2026-07-15" }),
      ],
      root,
    );
    const rows = await loadReceipts(root);
    assert.deepEqual(rows.map((r) => r.paidOn), ["2026-06-01", "2026-07-15", "2026-08-20"]);
  });

  it("처음 보는 카드는 알려만 주고 **자동으로 만들지 않는다**", async () => {
    const root = await tmpRoot();
    const res = await mergeReceipts([receipt({ receiptNumber: "x", cardLast4: "4411" })], root);
    // 카드 이름은 추측할 수 없다. 사람이 붙여야 한다.
    assert.deepEqual(res.newCards, ["4411"]);
  });

  it("못 읽은 메일도 같은 메시지는 한 번만 쌓인다", async () => {
    const root = await tmpRoot();
    const m = {
      messageId: "u1",
      mailbox: "a@b.com",
      sender: "x@y.com",
      subject: "?",
      date: "2026-08-01",
      reason: "형식 모름",
    };
    assert.equal(await mergeUnparsed([m], root), 1);
    assert.equal(await mergeUnparsed([m], root), 0);
  });
});

describe("월별 집계 — 요금제 vs API", () => {
  const rows = monthlySummary([
    receipt({ kind: "subscription", paidOn: "2026-08-16", amount: 200 }),
    receipt({ kind: "api_usage", paidOn: "2026-08-20", amount: 30 }),
    receipt({ kind: "prepaid_topup", paidOn: "2026-08-13", amount: 10, vendor: "OpenAI" }),
    receipt({ kind: "credit_note", paidOn: "2026-08-05", amount: -50 }),
    receipt({ kind: "failed", paidOn: "2026-08-01", amount: 500 }),
    receipt({ kind: "unknown", paidOn: "2026-08-02", amount: 7 }),
  ]);

  const anthropic = rows.find((r) => r.vendor === "Anthropic")!;
  const openai = rows.find((r) => r.vendor === "OpenAI")!;

  it("요금제와 API 를 갈라 센다 — 이게 이 기능의 존재 이유다", () => {
    assert.equal(anthropic.subscription, 200);
    assert.equal(anthropic.apiUsage, 30);
  });

  it("**선불 충전은 API 사용액과 합치지 않는다**", () => {
    // $10 을 충전해 석 달에 걸쳐 쓰면 충전한 달에 통째로 잡힌다.
    // 현금흐름으로는 맞지만 "이 달에 얼마나 썼나" 의 답은 아니다.
    assert.equal(openai.prepaidTopup, 10);
    assert.equal(openai.apiUsage, 0);
  });

  it("환불은 음수로 합계를 깎는다", () => {
    assert.equal(anthropic.creditNote, -50);
    assert.equal(anthropic.total, 200 + 30 - 50);
  });

  it("**결제 실패는 합계에서 뺀다** (나간 돈이 아니라 경보다)", () => {
    assert.equal(anthropic.failedCount, 1);
    assert.ok(!String(anthropic.total).includes("500"));
  });

  it("못 가른 건은 합계에 안 넣고 개수만 센다", () => {
    assert.equal(anthropic.unknownCount, 1);
    // 넘겨짚어 어딘가에 넣으면 조용히 틀린다.
    assert.equal(anthropic.subscription + anthropic.apiUsage, 230);
  });

  it("최신 달이 위로 온다", () => {
    const r = monthlySummary([
      receipt({ paidOn: "2026-06-01", receiptNumber: "a" }),
      receipt({ paidOn: "2026-08-01", receiptNumber: "b" }),
    ]);
    assert.equal(r[0].month, "2026-08");
  });
});

describe("카드별 집계", () => {
  const cards: Card[] = [{ last4: "4411", label: "법인 신한" }];

  it("카드 이름을 붙여 합산한다", () => {
    const out = byCard(
      [
        receipt({ kind: "prepaid_topup", amount: 10, cardLast4: "4411", receiptNumber: "a" }),
        receipt({ kind: "prepaid_topup", amount: 5, cardLast4: "4411", receiptNumber: "b" }),
      ],
      cards,
    );
    assert.equal(out[0].label, "법인 신한");
    assert.equal(out[0].total, 15);
    assert.equal(out[0].count, 2);
  });

  it("카드가 아닌 수단(Link)도 따로 묶어 준다", () => {
    const out = byCard(
      [receipt({ amount: 200, cardLast4: null, paymentMethod: "Link", receiptNumber: "c" })],
      cards,
    );
    assert.equal(out[0].last4, "(Link)");
  });

  it("실패·미상은 카드 합계에 안 들어간다", () => {
    const out = byCard(
      [receipt({ kind: "failed", amount: 500, cardLast4: "4411", receiptNumber: "d" })],
      cards,
    );
    assert.equal(out.length, 0);
  });
});
