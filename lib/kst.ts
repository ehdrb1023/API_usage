/**
 * 한국 시간(KST) 기준 "오늘" 계산.
 *
 * KST 는 UTC+9 **고정**이다 — 서머타임이 없다(1988년 이후). 그래서 오프셋을
 * 상수로 두어도 안전하고, `Intl` 없이 밀리초 덧셈만으로 정확하다.
 *
 * ⚠️ 서버 로컬 타임존에 절대 의존하지 않는다. 배포처(Vercel)는 UTC 로 돌고
 *    개발 머신은 KST 라, `new Date().getDate()` 같은 걸 쓰면 두 환경이 다르게
 *    동작한다. 여기서는 전부 UTC 산술로만 처리한다.
 *
 * KST 자정은 UTC 15:00 정각이라 **시간 버킷 경계와 정확히 맞아떨어진다**.
 * Anthropic usage_report 의 `bucket_width=1h` 버킷을 그대로 주워 담으면
 * KST 하루가 오차 없이 재구성된다는 뜻이다 (30분 오프셋 타임존이면 불가능했다).
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 지금 시각의 KST 날짜 (YYYY-MM-DD). */
export function kstDay(now: Date = new Date()): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 지금 시각의 KST 시:분 (HH:MM). */
export function kstTime(now: Date = new Date()): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(11, 16);
}

/** KST 날짜의 00:00 에 해당하는 UTC 순간. */
export function kstDayStart(kstDate: string): Date {
  return new Date(Date.parse(`${kstDate}T00:00:00Z`) - KST_OFFSET_MS);
}

/**
 * "KST 오늘" 을 시간 버킷으로 조회하기 위한 구간.
 *
 * `ending_at` 은 **다음 정시로 올림**한다. Anthropic 은 구간을 UTC 시각 경계로
 * 스냅하는데, 내림하면 진행 중인 현재 시간대가 통째로 빠져서 "실시간" 이 아니라
 * "최대 59분 전" 이 된다.
 */
export function kstTodayWindow(now: Date = new Date()): {
  date: string;
  from: string;
  to: string;
  /** 이 구간에 들어가는 1시간 버킷 수 (1~24). */
  hours: number;
} {
  const date = kstDay(now);
  const from = kstDayStart(date);
  const to = new Date(Math.ceil(now.getTime() / HOUR_MS) * HOUR_MS);
  const hours = Math.max(1, Math.round((to.getTime() - from.getTime()) / HOUR_MS));

  return { date, from: from.toISOString(), to: to.toISOString(), hours };
}

/** 2026-08-25 → 8월 25일 (화) */
export function formatKstDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const w = ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${w})`;
}

/** UTC 시각(ISO)이 KST 로 몇 월 며칠인지. 1시간 버킷을 KST 날짜로 접을 때 쓴다. */
export function kstDayOf(iso: string): string {
  return kstDay(new Date(iso));
}
