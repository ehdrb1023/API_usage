/**
 * 예산·러너웨이 알림 판정 — "단계가 오를 때만" 보낸다.
 *
 * linktalk-error-alerts/lib/key-watch 의 sweepKeys 와 같은 규칙:
 *   - 직전 단계보다 올라간 카드만 모아 한 번 보낸다.
 *   - 주의·위험이었다가 0 으로 돌아온 카드는 "돌아왔습니다" 를 한 번.
 *   - 본문에 키 값·조직 식별자는 없다. 금액·퍼센트·며칠만.
 *
 * 전송 자체는 lib/notify, 기록은 lib/budget-snapshot. 여기는 판정만 — 순수하게 둬서 테스트한다.
 */

import type { BudgetCard, BudgetUnit } from "@/lib/budget";
import type { AlertState } from "@/lib/budget-snapshot";
import type { KeyLevel } from "@/lib/key-levels";
import type { NotifyField, NotifyTone } from "@/lib/notify";

function money(v: number, unit: BudgetUnit): string {
  if (unit === "KRW") return `${Math.round(v).toLocaleString("ko-KR")}원`;
  return `$${v.toFixed(2)}`;
}

/** 카드 한 장을 알림 한 줄로. 금액·퍼센트·러너웨이만. */
export function describeCard(c: BudgetCard): string {
  const parts: string[] = [];
  if (c.monthSpend != null && c.monthlyBudget != null) {
    parts.push(
      `이번 달 ${money(c.monthSpend, c.unit)} / 예산 ${money(c.monthlyBudget, c.unit)}` +
        (c.budgetPct != null ? ` (${Math.round(c.budgetPct * 100)}%)` : ""),
    );
  } else if (c.monthSpend != null) {
    parts.push(`이번 달 ${money(c.monthSpend, c.unit)}`);
  }
  if (c.remaining != null) parts.push(`잔액 어림 ${money(c.remaining, c.unit)}`);
  if (c.runwayDays != null) parts.push(`약 ${c.runwayDays}일 뒤 바닥`);
  return parts.join(" · ") || "값 없음";
}

const toneFor = (level: KeyLevel): NotifyTone =>
  level >= 3 ? "critical" : level === 2 ? "warn" : "info";

const titleFor = (level: KeyLevel): string =>
  level >= 3
    ? "예산·잔액 위험 — 곧 바닥"
    : level === 2
      ? "예산·잔액 주의 — 충전·한도 점검"
      : "예산·잔액 알림";

export type SweepPlan = {
  /** 단계가 오른 카드. 있으면 묶어 한 건 보낸다. */
  raised: BudgetCard[];
  /** 회복한 카드. */
  recovered: BudgetCard[];
  /** 저장할 새 단계 기록. */
  nextState: AlertState;
  /** 보낼 메시지(없으면 빈 배열). notify 에 그대로 넘긴다. */
  messages: { title: string; tone: NotifyTone; fields: NotifyField[] }[];
};

/**
 * 직전 기록과 이번 카드로 보낼 것을 정한다. 순수 함수 — I/O 없음.
 */
export function planSweep(cards: BudgetCard[], prev: AlertState): SweepPlan {
  const nextState: AlertState = { ...prev };
  const raised: BudgetCard[] = [];
  const recovered: BudgetCard[] = [];

  for (const c of cards) {
    // 설정이 없어 비어 있는 카드는 알림 대상이 아니다 — 단계 0 으로만 기록.
    const before = prev[c.id] ?? 0;
    const now: KeyLevel = c.unconfigured ? 0 : c.level;
    if (now > before) raised.push(c);
    if (now === 0 && before >= 2) recovered.push(c);
    nextState[c.id] = now;
  }

  const messages: SweepPlan["messages"] = [];
  if (raised.length) {
    const worst = raised.reduce<KeyLevel>((a, c) => (c.level > a ? c.level : a), 0);
    messages.push({
      title: titleFor(worst),
      tone: toneFor(worst),
      fields: raised.map((c) => ({ name: c.label, value: describeCard(c) })),
    });
  }
  if (recovered.length) {
    messages.push({
      title: "예산·잔액 다시 정상",
      tone: "recovered",
      fields: recovered.map((c) => ({ name: c.label, value: describeCard(c) })),
    });
  }

  return { raised, recovered, nextState, messages };
}
