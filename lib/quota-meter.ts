/**
 * 미터기 — **"지금 이 속도면 언제 막히나".**
 *
 * 보드(`quota-board.ts`)가 "무엇을 얼마나 썼나" 라면 여기는 "앞으로 얼마 남았나" 다.
 * 운전 중 계기판처럼 곁눈질로 읽는 값만 낸다.
 *
 * ── 창 길이는 가정이다 ────────────────────────────────────────────────────
 * 벤더는 `resets_at`(끝나는 시각)만 주고 창이 몇 시간짜리인지는 안 준다. 경과 시간을
 * 알아야 속도가 나오므로 5시간·168시간을 **가정**한다. 실측으로 맞았지만 벤더가
 * 바꾸면 틀린다. 그래서 모르는 종류의 창은 `null` 을 돌려주고 **속도를 안 그린다** —
 * 아무 값이나 채워 넣으면 틀린 계기판이 되는데, 그건 계기판이 없는 것보다 나쁘다.
 *
 * 순수 함수다. fs·네트워크 없음.
 */

/** 창 종류 → 길이(ms). 여기 없는 종류는 속도를 계산하지 않는다. */
const WINDOW_MS: Record<string, number> = {
  session: 5 * 60 * 60 * 1000,
  weekly_all: 7 * 24 * 60 * 60 * 1000,
  weekly_scoped: 7 * 24 * 60 * 60 * 1000,
};

export type Burn = {
  /** 창이 끝나기까지 남은 시간(ms). */
  remainingMs: number;
  /** 창이 시작한 뒤 흐른 시간(ms). */
  elapsedMs: number;
  /** 시간당 몇 %p 태우고 있나 — 창 시작부터의 평균이다. */
  percentPerHour: number;
  /**
   * 이 속도면 100% 에 닿는 시각. 리셋 전에 안 닿으면 `null`.
   * `null` 이 "여유 있음" 이고, 값이 있으면 그때 막힌다는 뜻이다.
   */
  exhaustAt: Date | null;
};

/**
 * 소진 속도. 계산할 수 없으면 `null` — 창 길이를 모르거나, 아직 시간이 안 흘렀거나,
 * 리셋 시각이 없는 경우다. **0 을 돌려주지 않는다.** 0%/h 는 "안 쓰고 있다" 는
 * 뜻이고, "모른다" 와 섞이면 계기판이 거짓말을 한다.
 */
export function burnRate(
  kind: string,
  usedPercent: number,
  resetsAt: string | null,
  now: Date = new Date(),
): Burn | null {
  const windowMs = WINDOW_MS[kind];
  if (!windowMs || !resetsAt) return null;

  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return null;

  const remainingMs = end - now.getTime();
  const elapsedMs = windowMs - remainingMs;
  // 창이 방금 리셋됐으면 나눌 시간이 없다. 1분은 지나야 속도라 부를 수 있다.
  if (elapsedMs < 60_000) return null;

  const percentPerHour = usedPercent / (elapsedMs / 3_600_000);

  let exhaustAt: Date | null = null;
  if (percentPerHour > 0) {
    const hoursLeft = (100 - usedPercent) / percentPerHour;
    const at = now.getTime() + hoursLeft * 3_600_000;
    // 리셋 뒤에 닿는 건 안 닿는 것이다 — 그전에 0 으로 돌아간다.
    if (at < end) exhaustAt = new Date(at);
  }

  return { remainingMs, elapsedMs, percentPerHour, exhaustAt };
}

/** `3h 14m` · `6d 3h` · `12m`. 계기판이라 두 자리까지만 쓴다. */
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * 곁눈질용 신호등.
 *
 * 남은 시간보다 먼저 바닥나면 위험이다. 퍼센트 자체가 아니라 **리셋까지 버티는지**로
 * 가른다 — 90% 를 썼어도 10분 뒤 리셋이면 문제가 아니고, 40% 여도 리셋이 5일
 * 남았는데 3시간 만에 40% 를 태웠으면 문제다.
 */
export function severity(burn: Burn | null, now: Date = new Date()): "ok" | "warn" | "danger" {
  // 리셋 전에 안 바닥나면 아무 문제 없다. 퍼센트가 높아도 마찬가지다.
  if (!burn || !burn.exhaustAt) return "ok";
  if (burn.remainingMs <= 0) return "ok";
  // 남은 창 시간 중 얼마나 버티나. 절반도 못 버티면 위험.
  const ratio = (burn.exhaustAt.getTime() - now.getTime()) / burn.remainingMs;
  return ratio < 0.5 ? "danger" : "warn";
}
