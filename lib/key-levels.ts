/**
 * 예산·잔액 단계 계산 — 순수 함수. 0=괜찮음, 1=알림, 2=주의, 3=위험.
 *
 * linktalk-error-alerts/lib/key-levels.ts 에서 옮겨 왔다 (2026-10-25). 이 파일은
 * 어떤 서버 모듈도 import 하지 않는다 — 테스트와 화면·크론 어디서나 쓰도록 순수하게 둔다.
 *
 * 임계값은 작업 지시 그대로: 예산 80/95/100%, 러너웨이 14/7/3일.
 */

export type KeyLevel = 0 | 1 | 2 | 3;

const DAY_MS = 86_400_000;

export function daysUntil(at: number, now = Date.now()): number {
  return Math.floor((at - now) / DAY_MS);
}

/** 잔액 단계. warn 아래면 알림, 절반 아래면 주의, 바닥(warn 의 10%)이면 위험. */
export function balanceLevel(balance: number, warn: number): KeyLevel {
  if (!(warn > 0)) return 0;
  if (balance <= warn * 0.1) return 3;
  if (balance < warn * 0.5) return 2;
  if (balance < warn) return 1;
  return 0;
}

/** 잔액이 이 속도로 며칠 버티는가. 쓰지 않았으면 null. */
export function daysOfRunway(remaining: number, perDay: number): number | null {
  if (!(perDay > 0)) return null;
  return Math.max(0, Math.floor(remaining / perDay));
}

/** 남은 날로 올리는 단계 — 퍼센트가 넉넉해도 빨리 쓰면 미리 울립니다. 14·7·3일. */
export function runwayLevel(days: number | null): KeyLevel {
  if (days == null) return 0;
  if (days <= 3) return 3;
  if (days <= 7) return 2;
  if (days <= 14) return 1;
  return 0;
}

/** 월 예산 대비 쓴 비율. 80%·95%·100%. */
export function budgetLevel(spent: number, budget: number): KeyLevel {
  if (!(budget > 0)) return 0;
  const pct = spent / budget;
  if (pct >= 1) return 3;
  if (pct >= 0.95) return 2;
  if (pct >= 0.8) return 1;
  return 0;
}

export const maxLevel = (...xs: KeyLevel[]): KeyLevel =>
  xs.reduce<KeyLevel>((a, b) => (b > a ? b : a), 0);
