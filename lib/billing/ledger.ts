/**
 * 결제 장부 — 화면(/receipts)에 보여 줄 한 줄짜리 결제 기록.
 *
 * 출처가 둘이다.
 *   1. `data/billing/receipts.json`       파서가 읽은 것 (Anthropic·OpenAI·Stripe 계열)
 *   2. `data/billing/other-payments.json` 정해진 양식이 없어 메일을 직접 읽고 옮긴 것
 *      (토스페이먼츠·Google·이니시스 등). 2026-10-02 수집.
 *
 * 둘을 **같은 분류 기준**으로 접는다 — 종류(크레딧/정기결제/…) × 카드 × 분야.
 *
 * ⚠️ 달러와 원화를 환산해 더하지 않는다. 환율을 지어내면 합계가 조용히 틀린다.
 */

import type { ChargeKind, Receipt } from "./types";

// ---------------------------------------------------------------- 분류

export type LedgerKind = "credit" | "subscription" | "usage" | "one_time" | "refund" | "failed";

export const KIND_LABEL: Record<LedgerKind, string> = {
  credit: "크레딧 (선불)",
  subscription: "정기결제",
  usage: "후불 사용료",
  one_time: "일회성",
  refund: "환불",
  failed: "실패",
};

/** 합계·카드표에 들어가는 종류. 실패는 나간 돈이 아니라 경보다. */
export const SPEND_KINDS: LedgerKind[] = ["credit", "subscription", "usage", "one_time", "refund"];

export type Category = "AI" | "클라우드·인프라" | "도메인" | "SaaS·도구" | "개발자 등록" | "세금" | "기타";

/** 벤더 이름(소문자) 일부 → 분야. 위에서부터 먼저 걸리는 것. */
const CATEGORY_RULES: [RegExp, Category][] = [
  [/anthropic|openai|deep ?infra|openrouter|perplexity|meshy|hanabi|supertone|vooster/, "AI"],
  [/google cloud|neon|vercel|스마일서브/, "클라우드·인프라"],
  [/hosting\.kr|메가존/, "도메인"],
  [/gamma|framer|미리캔버스|아임웹|imweb/, "SaaS·도구"],
  [/apple|play console|chrome web store/, "개발자 등록"],
  [/국세|지방세|인터넷지로/, "세금"],
];

export function categoryOf(vendor: string): Category {
  const v = vendor.toLowerCase();
  return CATEGORY_RULES.find(([re]) => re.test(v))?.[1] ?? "기타";
}

// ---------------------------------------------------------------- 한 줄

export type LedgerEntry = {
  id: string;
  /** 결제일 yyyy-mm-dd */
  date: string;
  vendor: string;
  category: Category;
  kind: LedgerKind;
  item: string;
  /** 환불은 음수. 실패 건은 금액이 메일에 없으면 null. */
  amount: number | null;
  currency: string;
  /**
   * 카드 끝 4자리. 끝자리가 없으면 결제 수단 설명 ("신한 (끝자리 미표기)", "Link" …).
   * 정말 모르면 "미표기".
   */
  payment: string;
  /** 끝 4자리를 아는 카드인지. 카드별 표에서 묶는 기준이 다르다. */
  isCard: boolean;
  receiptNo: string | null;
  /** parser = 테스트가 붙은 파서 / manual = 메일을 읽고 옮긴 것 (원본 대조 권장) */
  source: "parser" | "manual";
  messageId: string;
  flags: string[];
  /** 있으면 합계에서 뺀다. 지우지는 않는다 — 왜 뺐는지가 남아야 한다. */
  excludeReason: string | null;
};

const PARSER_KIND: Record<ChargeKind, LedgerKind | null> = {
  prepaid_topup: "credit",
  subscription: "subscription",
  api_usage: "usage",
  credit_note: "refund",
  failed: "failed",
  unknown: null,
};

/** 파서 영수증 → 장부. `unknown` 은 flag 를 달아 일회성으로 둔다 (넘겨짚지 않는다는 표시). */
export function fromReceipt(r: Receipt): LedgerEntry {
  const kind = PARSER_KIND[r.kind];
  const payment = r.cardLast4 ?? (r.paymentMethod && r.paymentMethod !== "-" ? r.paymentMethod : "미표기");
  return {
    id: `p:${r.sourceMessageId}`,
    date: r.paidOn,
    vendor: r.vendor,
    category: categoryOf(r.vendor),
    kind: kind ?? "one_time",
    item: r.lineItem ?? "",
    amount: r.amount,
    currency: r.currency,
    payment,
    isCard: r.cardLast4 !== null,
    receiptNo: r.receiptNumber ?? r.invoiceNumber,
    source: "parser",
    messageId: r.sourceMessageId,
    flags: kind ? [] : ["종류 미분류"],
    excludeReason: null,
  };
}

/** `other-payments.json` 의 한 건. 수집할 때 메일에 적힌 것만 옮겼다. */
export type ManualPayment = {
  messageId: string;
  date: string;
  vendor: string | null;
  merchantViaPG?: string | null;
  item?: string | null;
  kind: string;
  amount: number | null;
  currency: string | null;
  cardLast4?: string | null;
  cardIssuer?: string | null;
  approvalNumber?: string | null;
  receiptNumber?: string | null;
  paymentOverride?: string | null;
  flags?: string[];
  excludeReason?: string | null;
};

const MANUAL_KIND: Record<string, LedgerKind> = {
  subscription: "subscription",
  credit_or_prepaid: "credit",
  usage: "usage",
  one_time: "one_time",
  refund: "refund",
  failed: "failed",
};

export function fromManual(m: ManualPayment): LedgerEntry {
  const kind = MANUAL_KIND[m.kind];
  // PG 를 거친 결제는 실제 가맹점 이름이 "토스페이먼츠 → 메가존(주)" 처럼 온다. 뒤쪽이 가맹점이다.
  const vendor = (m.merchantViaPG?.split("→").pop() ?? m.vendor ?? "(미상)").trim();
  const payment =
    m.paymentOverride ??
    m.cardLast4 ??
    (m.cardIssuer ? `${m.cardIssuer} (끝자리 미표기)` : "미표기");
  // 수집 당시 환불을 양수로 적은 건이 섞여 있다. 환불은 항상 음수로 맞춘다.
  const amount =
    m.amount === null ? null : kind === "refund" ? -Math.abs(m.amount) : m.amount;
  return {
    id: `m:${m.messageId}:${m.kind}`,
    date: m.date.slice(0, 10),
    vendor,
    category: categoryOf(`${m.vendor ?? ""} ${m.merchantViaPG ?? ""}`),
    kind: kind ?? "one_time",
    item: m.item ?? "",
    amount,
    currency: m.currency ?? "KRW",
    payment,
    isCard: Boolean(m.cardLast4) && !m.paymentOverride,
    receiptNo: m.approvalNumber ?? m.receiptNumber ?? null,
    source: "manual",
    messageId: m.messageId,
    flags: [...(m.flags ?? []), ...(kind ? [] : ["종류 미분류"])],
    excludeReason: m.excludeReason ?? null,
  };
}

/** 최신순. 같은 날이면 벤더 이름순 — 화면이 새로고침마다 흔들리지 않게. */
export function buildLedger(receipts: Receipt[], manual: ManualPayment[]): LedgerEntry[] {
  return [...receipts.map(fromReceipt), ...manual.map(fromManual)].sort(
    (a, b) => b.date.localeCompare(a.date) || a.vendor.localeCompare(b.vendor),
  );
}

// ---------------------------------------------------------------- 집계

/** 합계에 넣는 건인지. 실패·제외 표시·금액 없음은 뺀다. */
export function counts(e: LedgerEntry): boolean {
  return SPEND_KINDS.includes(e.kind) && e.excludeReason === null && e.amount !== null;
}

/** 통화별 합. 키는 통화 코드. */
export type Money = Record<string, number>;

function add(m: Money, currency: string, n: number) {
  m[currency] = (m[currency] ?? 0) + n;
}

export type CardRow = {
  payment: string;
  isCard: boolean;
  byKind: Partial<Record<LedgerKind, Money>>;
  total: Money;
  vendors: string[];
  count: number;
  first: string;
  last: string;
};

/** "어느 카드로 무엇을 냈나". 결제 수단 × 종류. */
export function byPayment(entries: LedgerEntry[]): CardRow[] {
  const rows = new Map<string, CardRow & { vendorSet: Set<string> }>();
  for (const e of entries) {
    if (!counts(e)) continue;
    let row = rows.get(e.payment);
    if (!row) {
      row = {
        payment: e.payment,
        isCard: e.isCard,
        byKind: {},
        total: {},
        vendors: [],
        vendorSet: new Set(),
        count: 0,
        first: e.date,
        last: e.date,
      };
      rows.set(e.payment, row);
    }
    add((row.byKind[e.kind] ??= {}), e.currency, e.amount!);
    add(row.total, e.currency, e.amount!);
    row.vendorSet.add(e.vendor);
    row.count++;
    if (e.date < row.first) row.first = e.date;
    if (e.date > row.last) row.last = e.date;
  }
  return [...rows.values()]
    .map(({ vendorSet, ...r }) => ({ ...r, vendors: [...vendorSet].sort() }))
    .sort((a, b) => Number(b.isCard) - Number(a.isCard) || b.count - a.count);
}

export type MonthRow = { month: string; byKind: Partial<Record<LedgerKind, Money>>; total: Money; failed: number };

/** 월 × 종류. 최신 달이 위. */
export function byMonth(entries: LedgerEntry[]): MonthRow[] {
  const rows = new Map<string, MonthRow>();
  for (const e of entries) {
    const month = e.date.slice(0, 7);
    let row = rows.get(month);
    if (!row) {
      row = { month, byKind: {}, total: {}, failed: 0 };
      rows.set(month, row);
    }
    if (e.kind === "failed") {
      row.failed++;
      continue;
    }
    if (!counts(e)) continue;
    add((row.byKind[e.kind] ??= {}), e.currency, e.amount!);
    add(row.total, e.currency, e.amount!);
  }
  return [...rows.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** 종류별 통화 합 — 화면 맨 위 숫자. */
export function totalsByKind(entries: LedgerEntry[]): Partial<Record<LedgerKind, Money>> {
  const out: Partial<Record<LedgerKind, Money>> = {};
  for (const e of entries) if (counts(e)) add((out[e.kind] ??= {}), e.currency, e.amount!);
  return out;
}
