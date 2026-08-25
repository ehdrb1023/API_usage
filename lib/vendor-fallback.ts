/**
 * 벤더 호출이 막혔을 때 **직전 값을 계속 보여주기** 위한 얇은 층.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * Anthropic Admin API 의 usage_report / cost_report 는 **시간당 90회**다
 * (2026-08-25 실측: `anthropic-ratelimit-requests-limit: 90`). 미니 위젯은 분당
 * 1회 폴링하므로 60회/시간을 쓴다 — 한 곳에서만 돌면 들어가지만, 로컬 개발 서버와
 * 배포본이 동시에 돌면 120회가 되어 바로 429 가 난다.
 *
 * 그때 화면이 통째로 "조회 실패" 가 되면 안 된다. 1분 전 값은 여전히 유용하고,
 * 실제로 바뀐 것도 거의 없다. 그래서 직전 성공값을 들고 있다가 **오래된 값임을
 * 표시하며** 계속 내보낸다.
 *
 * 또한 429 를 받으면 `retry-after` 만큼은 아예 두드리지 않는다. 안 그러면 요청마다
 * 다시 시도해서 리밋이 영영 안 풀린다 (`unstable_cache` 는 실패를 캐싱하지 않는다).
 *
 * ⚠️ 이 상태는 **프로세스 메모리**다. Vercel 서버리스에서는 인스턴스마다 따로 있고
 *    인스턴스가 죽으면 사라진다. 그래도 같은 인스턴스가 연속 요청을 받는 동안은
 *    유효해서, 폭주를 막는 데는 충분하다. 인스턴스 간 공유는 `unstable_cache`
 *    (성공값 한정) 가 맡는다.
 */

import { ApiClientError } from "@/lib/clients/types";

export type Fresh<T> = {
  value: T;
  /** 이 값을 벤더에서 실제로 받아온 시각 (epoch ms). */
  at: number;
  /** true 면 지금 호출이 실패해서 예전 값을 대신 내보낸 것. */
  stale: boolean;
  /** stale 일 때의 사유 (에러 메시지). */
  reason?: string;
};

/** 429 가 아닌 실패는 짧게만 쉰다 — 일시적 네트워크 오류일 수 있다. */
const DEFAULT_BACKOFF_SECONDS = 30;
/** `retry-after` 가 터무니없이 길게 와도 여기서 끊는다. */
const MAX_BACKOFF_SECONDS = 15 * 60;

/**
 * @param now 시계. 테스트에서 백오프 경과를 앞당기려고 주입한다 — 이것 말고는
 *            `Date.now()` 를 흉내 낼 방법이 없고, 이 로직은 시간이 전부다.
 */
export function createStaleFallback<T>(now: () => number = Date.now) {
  let last: { value: T; at: number } | null = null;
  let blockedUntil = 0;
  let lastError: unknown = null;

  return async function run(fetcher: () => Promise<T>): Promise<Fresh<T>> {
    // 쉬는 중이면 **호출 자체를 하지 않는다.** 들고 있는 값이 없어도 마찬가지다 —
    // 여기서 다시 두드리면 429 를 하나 더 쌓을 뿐이고, 그만큼 리밋이 늦게 풀린다.
    if (now() < blockedUntil) {
      if (last) {
        return { value: last.value, at: last.at, stale: true, reason: message(lastError) };
      }
      throw lastError ?? new Error("호출을 잠시 쉬는 중입니다.");
    }

    try {
      const value = await fetcher();
      last = { value, at: now() };
      blockedUntil = 0;
      lastError = null;
      return { value, at: last.at, stale: false };
    } catch (error) {
      lastError = error;
      blockedUntil = now() + backoffSeconds(error) * 1000;

      // 들고 있는 값이 없으면 숨길 게 없다. 그대로 던져서 사유를 보여 준다.
      if (!last) throw error;
      return { value: last.value, at: last.at, stale: true, reason: message(error) };
    }
  };
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error === null || error === undefined ? "알 수 없는 오류" : String(error);
}

function backoffSeconds(error: unknown): number {
  if (error instanceof ApiClientError && error.status === 429) {
    return Math.min(error.retryAfterSeconds ?? 60, MAX_BACKOFF_SECONDS);
  }
  return DEFAULT_BACKOFF_SECONDS;
}
