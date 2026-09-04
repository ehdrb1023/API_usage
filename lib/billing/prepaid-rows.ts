/**
 * 선불 잔액 — **판정 부분만.** 네트워크·캐시가 없어 그대로 테스트할 수 있다.
 *
 * 소진액을 어디서 가져오는지는 `prepaid.ts` 가 안다. 여기는 그 결과(`Coverage`)를
 * 받아 **"이 숫자를 화면에 내보내도 되는가"** 만 판정한다. 층을 가른 이유가 그것이다 —
 * 이 판정이 이 기능의 전부인데 `next/cache` 를 함께 import 하면 테스트에서 못 부른다.
 *
 * ── 잔액을 숫자로 못 내놓는 네 경우 ────────────────────────────────────────
 * 1. 구독 초과분(`plan`)      — Admin API 장부에 아예 안 올라간다
 * 2. 조회 API 없는 벤더        — Deep Infra 등
 * 3. 조회 구간이 첫 충전 앞을 못 덮음 — 그 앞에 쓴 돈이 빠져 잔액이 부풀려진다
 * 4. 잔액이 음수              — 첫 충전 이전 잔액으로 쓴 것 (`openingImplied`)
 *
 * 넷 다 `balanceUnknownReason` 한 필드로 모은다. 화면이 갈래마다 문구를 지어내면
 * 서로 다른 말을 하게 된다.
 */

import type { ServiceId } from "@/lib/types";

import { daysRemaining, prepaidBalance, type BalanceRow, type TopupWindow } from "./balance";
import type { Receipt } from "./types";

/**
 * 영수증의 벤더명 → 사용량 조회 서비스.
 *
 * **여기 없는 벤더는 소진을 셀 수 없다.** 억지로 0 을 넣지 말 것 — `balance.ts`
 * 주석대로 "안 썼다" 가 되어 잔액이 부풀려진다.
 *
 * ⚠️ **영수증에는 계정 정보가 없다.** 결제 메일은 "Anthropic" 이라고만 하고 어느
 *    조직인지 말해 주지 않는다. 그래서 첫 계정(`claude`)으로 본다. Claude 계정을
 *    여럿 쓰면서 둘 이상에 선불을 충전하면 이 잔액은 첫 계정 기준이 되므로,
 *    그때는 영수증에 계정을 실을 방법부터 만들어야 한다 (지금은 방법이 없다).
 */
export const VENDOR_SERVICE: Record<string, ServiceId> = {
  Anthropic: "claude",
  OpenAI: "gpt",
};

/** 소진 조회 결과. `from` 은 **실제로** 조회된 시작일이다. null 이면 못 조회했다. */
export type Coverage = { from: string; spent: number } | null;

export type PrepaidRow = BalanceRow & {
  /** 최근 소진 속도로 어림한 남은 일수. 모르면 null — "무한" 이라고 하지 않는다. */
  daysLeft: number | null;
  /**
   * 소진을 실제로 셀 수 있었던 시작일. `since` 와 같거나 앞이면 창 전체를 봤다는 뜻.
   * null 이면 아예 못 봤다.
   */
  coverageFrom: string | null;
  /** `coverageFrom <= since`. false 면 아래 `spentInCoverage` 는 하한이다. */
  coverageComplete: boolean;
  /**
   * 조회된 구간 안에서만 센 지출. 창을 못 덮었어도 보여 준다 — "모름" 한 마디보다
   * "8/1부터 $12 썼고 그 앞은 모름" 이 판단에 쓸모 있다.
   */
  spentInCoverage: number | null;
  /**
   * **잔액이 음수로 나왔다** = 본 소진이 확인된 충전보다 많다.
   *
   * 계산이 틀린 게 아니라 `openingUnknown` 의 증거다. 이때 `balance` 를 그대로 띄우면
   * "-$7 남음" 이라는 말이 안 되는 숫자가 나간다.
   */
  openingImplied: boolean;
  /** 잔액을 숫자로 못 내놓는 이유. **null 이면 `balance` 를 믿고 써도 된다.** */
  balanceUnknownReason: string | null;
};

export type PrepaidView = {
  rows: PrepaidRow[];
  /** 충전 영수증만 골라 최신순으로. 표의 원본이다. */
  topups: Receipt[];
  /** 기준일 (KST, YYYY-MM-DD). */
  asOf: string;
};

/**
 * 창 + 소진 조회 결과 → 화면 행.
 *
 * @param coverages `windows` 와 **같은 순서**여야 한다. 길이가 다르면 짝이 어긋난
 *                  잔액이 나가므로 던진다 — 조용히 맞추면 틀린 숫자가 된다.
 */
export function buildPrepaidRows(
  windows: TopupWindow[],
  coverages: Coverage[],
  asOf: string,
): PrepaidRow[] {
  if (windows.length !== coverages.length) {
    throw new Error(
      `창(${windows.length})과 소진 조회(${coverages.length})의 개수가 다릅니다`,
    );
  }

  /**
   * `prepaidBalance()` 에는 **창 전체를 덮은 것만** 넘긴다. 부분 조회값을 넘기면
   * 잔액이 실제보다 많아 보이는데, 그게 이 화면에서 제일 위험한 오작동이다
   * (다 썼는데 여유 있다고 표시된다).
   */
  const spentByVendor: Record<string, number> = {};
  windows.forEach((w, i) => {
    const c = coverages[i];
    if (c && c.from <= w.since) spentByVendor[w.vendor] = c.spent;
  });

  return prepaidBalance(windows, spentByVendor).map((base, i) => {
    const c = coverages[i];
    const openingImplied = base.balance !== null && base.balance < 0;

    return {
      ...base,
      // 음수 잔액으로 남은 일수를 세면 `Math.max(0, …)` 때문에 "약 0일" 이 된다.
      // 근거 없이 "지금 바닥" 이라고 말하는 셈이라 아예 세지 않는다.
      daysLeft: openingImplied ? null : daysRemaining(base, asOf),
      coverageFrom: c?.from ?? null,
      coverageComplete: c !== null && c.from <= base.since,
      spentInCoverage: c?.spent ?? null,
      openingImplied,
      balanceUnknownReason: unknownReason(base, c, openingImplied),
    };
  });
}

/** 충전 영수증만, 최신순. */
export function selectTopups(receipts: Receipt[]): Receipt[] {
  return receipts
    .filter((r) => r.kind === "prepaid_topup")
    .sort((a, b) => b.paidOn.localeCompare(a.paidOn));
}

/** 왜 잔액을 못 내놓는지 — 사람이 읽고 조치할 수 있는 문장으로. */
function unknownReason(
  row: BalanceRow,
  coverage: Coverage,
  openingImplied: boolean,
): string | null {
  if (row.spent === null) {
    if (row.pocket === "plan") {
      return "구독 초과분은 Admin API 장부에 안 올라갑니다. 넣은 돈만 알 수 있습니다.";
    }
    if (row.pocket === "unknown") {
      return "품목만으로 어느 주머니인지 못 갈랐습니다. 영수증 품목을 확인하세요.";
    }
    if (!(row.vendor in VENDOR_SERVICE)) {
      return `${row.vendor} 는 사용량 조회 API 를 붙이지 않았습니다.`;
    }
    if (coverage === null) {
      return "소진 조회가 실패했습니다. 잠시 후 다시 열어 보세요.";
    }
    return `조회가 ${coverage.from} 부터만 됩니다. 첫 충전(${row.since}) 앞을 못 봤습니다.`;
  }

  if (openingImplied) {
    return (
      `확인된 충전(${money(row.toppedUp)})보다 쓴 돈(${money(row.spent)})이 많습니다. ` +
      `첫 충전(${row.since}) 이전에 남아 있던 잔액으로 쓴 부분이라 지금 잔액은 알 수 없습니다.`
    );
  }

  return null;
}

/** 사유 문장에 끼울 금액. 화면 포맷(`lib/format.ts`)과 달리 문장용이라 단순하게. */
function money(n: number): string {
  return `$${n.toFixed(2)}`;
}
