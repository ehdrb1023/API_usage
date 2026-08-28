/**
 * 선불 잔액 추정 — "얼마 넣었고 얼마 남았나".
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * 선불로 넣은 돈은 **나간 시점과 쓰는 시점이 다르다.** 7월에 $500 을 넣고 8월에
 * $346 을 태우면, 8월 지출은 $0 인데 잔액은 줄고 있다. 잔액을 안 보면 언제 또
 * 넣어야 하는지 알 수 없고, 실제로 이 계정은 2026-07 에 결제 실패로 구독이
 * 정지된 적이 있다.
 *
 * ── ⚠️ 주머니가 두 개다. 절대 합치지 말 것 ────────────────────────────────
 * 2026-08-27 실측으로 Anthropic 선불이 **서로 다른 두 곳**으로 들어가는 걸 확인했다.
 *
 *   "One-time credit purchase"             $500  → API 크레딧
 *   "Prepaid extra usage, Individual plan" $200  → 구독(Individual plan) 초과 사용분
 *
 * 앞엣것은 API 키 트래픽을 태우고, 뒤엣것은 claude.ai·Claude Code 를 태운다.
 * **Admin API 는 앞엣것만 본다.** 그래서 `plan` 주머니는 넣은 돈만 알 수 있고
 * 얼마나 썼는지는 알 방법이 없다 — 그 사실을 `spent: null` 로 드러낸다.
 * 합쳐서 하나의 잔액으로 만들면 조용히 틀린 숫자가 된다.
 *
 * ── ⚠️ 이건 추정이다 ──────────────────────────────────────────────────────
 * **시작 잔액을 모른다.** 메일함에서 보이는 첫 충전 이전에 남아 있던 돈은 알 수
 * 없으므로, 여기 나오는 잔액은 "첫 충전 이후로 넣은 돈 − 그 뒤로 쓴 돈" 이다.
 * 이전 잔액이 있었다면 실제 잔액은 더 많다. `openingUnknown` 으로 표시한다.
 */

import type { Receipt } from "./types";

/** 선불이 들어가는 주머니. */
export type Pocket =
  /** API 키 트래픽을 태운다. Admin API 로 소진을 볼 수 있다. */
  | "api"
  /** 구독 초과 사용분(claude.ai·Claude Code). **소진을 볼 방법이 없다.** */
  | "plan"
  /** 품목만으로 못 가름. 사람이 봐야 한다. */
  | "unknown";

/**
 * 품목 → 주머니.
 *
 * ⚠️ 순서가 중요하다. `"Prepaid extra usage, Individual plan"` 은 "plan" 과
 *    "prepaid" 를 둘 다 갖고 있다. 구독 쪽을 먼저 걸러야 API 크레딧으로
 *    잘못 분류되지 않는다.
 */
export function pocketOf(lineItem: string | null): Pocket {
  const t = (lineItem ?? "").toLowerCase();
  if (!t.trim()) return "unknown";

  // 구독 초과분이 먼저다 (위 주석 참고).
  if (/extra usage|\bplan\b|seat|구독/.test(t)) return "plan";
  if (
    /credit purchase|credit top-?up|api credit|prepayment|credit balance|recharge|충전/.test(t)
  ) {
    return "api";
  }
  return "unknown";
}

/** 한 벤더·한 주머니의 충전 창(窓). 소진을 조회할 구간을 caller 에게 알려 준다. */
export type TopupWindow = {
  vendor: string;
  pocket: Pocket;
  /** 이 구간에 넣은 돈 합계. */
  toppedUp: number;
  /** 처음 충전한 날 (ISO yyyy-mm-dd). **여기부터 소진을 세야 한다.** */
  since: string;
  /** 충전 건수. */
  count: number;
};

/**
 * 영수증에서 충전 창을 뽑는다.
 *
 * caller 는 각 창의 `since` 부터 지금까지의 API 지출을 벤더 API 로 조회해
 * `prepaidBalance()` 에 넘긴다. 그래야 "충전 이전에 쓴 돈" 이 잔액에서
 * 잘못 빠지지 않는다.
 */
export function topupWindows(receipts: Receipt[]): TopupWindow[] {
  const byKey = new Map<string, TopupWindow>();

  for (const r of receipts) {
    if (r.kind !== "prepaid_topup") continue;
    const pocket = pocketOf(r.lineItem);
    const key = `${r.vendor}\t${pocket}`;

    let w = byKey.get(key);
    if (!w) {
      w = { vendor: r.vendor, pocket, toppedUp: 0, since: r.paidOn, count: 0 };
      byKey.set(key, w);
    }
    w.toppedUp += r.amount;
    w.count++;
    if (r.paidOn < w.since) w.since = r.paidOn;
  }

  return [...byKey.values()].sort(
    (a, b) => a.vendor.localeCompare(b.vendor) || a.pocket.localeCompare(b.pocket),
  );
}

export type BalanceRow = TopupWindow & {
  /**
   * `since` 이후 API 로 쓴 돈. **`null` 이면 알 수 없다는 뜻이다** — 0 이 아니다.
   * `plan` 주머니와 조회 API 가 없는 벤더(Deep Infra 등)가 여기 해당한다.
   */
  spent: number | null;
  /** `toppedUp - spent`. spent 를 모르면 null. */
  balance: number | null;
  /**
   * **시작 잔액을 모른다.** 첫 충전 이전에 남아 있던 돈은 볼 수 없으므로
   * 실제 잔액은 이 값 이상이다. 언제나 true — 잊지 말라고 필드로 남긴다.
   */
  openingUnknown: true;
};

/**
 * 잔액을 맞춰 본다.
 *
 * @param spentByVendor 벤더 → `since` 이후 API 지출(USD). 조회할 수 없는 벤더는
 *                      **키를 아예 넣지 말 것.** 0 을 넣으면 "안 썼다" 가 되어
 *                      잔액이 실제보다 많아 보인다.
 */
export function prepaidBalance(
  windows: TopupWindow[],
  spentByVendor: Record<string, number>,
): BalanceRow[] {
  return windows.map((w) => {
    // `plan` 주머니는 Admin API 에 안 잡힌다. 조회값이 있어도 쓰면 안 된다.
    const measurable = w.pocket === "api";
    const spent = measurable && w.vendor in spentByVendor ? spentByVendor[w.vendor] : null;

    return {
      ...w,
      spent,
      balance: spent === null ? null : round(w.toppedUp - spent),
      openingUnknown: true,
    };
  });
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * 한 달에 얼마나 태우는지로 남은 기간을 어림한다.
 * 잔액을 모르거나 소진이 0 이면 null — "무한" 이라고 하지 않는다.
 */
export function daysRemaining(row: BalanceRow, asOf: string): number | null {
  if (row.balance === null || row.spent === null || row.spent <= 0) return null;

  const days = daysBetween(row.since, asOf);
  if (days <= 0) return null;

  const perDay = row.spent / days;
  if (perDay <= 0) return null;
  return Math.max(0, Math.floor(row.balance / perDay));
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
