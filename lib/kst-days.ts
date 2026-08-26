/**
 * 1시간 버킷 → **KST 하루**. 대시보드의 "하루" 가 정의되는 곳이다.
 *
 * ── 왜 재구성이 필요한가 ──────────────────────────────────────────────────
 * AI 벤더가 주는 하루는 전부 UTC 자정 기준이다. 한국에서 보면 오전 9시에 날짜가
 * 바뀌는 셈이라, "오늘 얼마 썼나" 를 보려는 사람에게는 하루가 어긋나 있다.
 *
 * 두 리포트의 시간 해상도가 달라서 처리도 갈린다. (Anthropic·OpenAI 둘 다 같다)
 *   사용량(토큰)  `bucket_width=1h` 지원 → **정확히 재구성된다**
 *                 KST 자정 = UTC 15:00 **정각**이라 시간 버킷 경계와 딱 맞는다
 *   비용          **1d(UTC) 뿐** → 자를 방법이 없다. 그래서 단가를 역산해
 *                 (`lib/token-rates.ts`) KST 실측 토큰에 곱한다
 *
 * ⚠️ 그 결과 **화면의 비용은 전부 추정치다.** hold-out 검증에서 Anthropic 오차는
 *    ±0.1% 였지만 청구서와 소수점까지 같지는 않다. 정확한 청구액은 벤더 콘솔의
 *    비용 리포트가 정답이고, 그건 UTC 하루 기준이다.
 *    KST 로 보는 대가가 이것이다 — 둘 다 가질 수는 없다.
 *
 * ⚠️ 이 파일에 **벤더 이름이 나오면 안 된다.** 벤더별 응답 해석은 어댑터의 일이고,
 *    여기는 "시간 버킷을 KST 날짜로 접는다" 는 규칙 하나만 갖는다.
 */

import type { CostRow, DayRows, UsageRow } from "@/lib/adapters/core";
import { kstDayOf } from "@/lib/kst";
import { computeRates, estimateCostRows, type TokenRates } from "@/lib/token-rates";

/** 사용량 1시간 버킷. `startedAt` 은 벤더가 준 UTC 시각(ISO). */
export type HourBucket = {
  startedAt: string;
  usage: UsageRow[];
};

/** 벤더 실측 비용 하루치 (UTC 자정 기준). **단가 역산에만** 쓰고 화면에는 안 나간다. */
export type CostDay = {
  /** UTC 날짜 (YYYY-MM-DD). 단가는 날짜 구분이 필요 없어서 참고용이다. */
  date: string;
  cost: CostRow[];
};

export type KstDaysInput = {
  hourly: HourBucket[];
  cost: CostDay[];
};

export type KstDaysResult = {
  /** KST 날짜 오름차순. 비용은 단가 × 토큰으로 채운 추정치다. */
  days: DayRows[];
  /**
   * 역산한 단가. 미니 위젯이 "KST 오늘" 을 1분마다 다시 계산할 때 재사용한다 —
   * 여기서 한 번 구해 캐시에 실어 보내면 분당 벤더 호출이 그만큼 줄어든다.
   */
  rates: TokenRates;
};

/**
 * 시간 버킷을 KST 날짜로 접고, 비용은 단가 × 토큰으로 채운다.
 *
 * 단가는 **실측 비용에서만** 뽑는다 (`input.cost`). 재구성된 추정 비용으로 다시
 * 단가를 구하면 순환이 되어 오차가 눈덩이처럼 커진다 — 그래서 이 함수는 원본
 * 비용 리포트를 반드시 함께 받는다.
 */
export function buildKstDays(input: KstDaysInput): KstDaysResult {
  // 단가 역산은 날짜 정렬이 필요 없다. 시간 버킷 전체 합 : 비용 전체 합이면 된다.
  // 그래서 사용량과 비용을 그냥 같은 배열에 나란히 넣어 넘긴다.
  const rates = computeRates([
    ...input.hourly.map((h) => ({ date: h.startedAt, usage: h.usage, cost: [] })),
    ...input.cost.map((c) => ({ date: c.date, usage: [], cost: c.cost })),
  ]);

  const byDate = new Map<string, UsageRow[]>();
  for (const bucket of input.hourly) {
    const date = kstDayOf(bucket.startedAt);
    const list = byDate.get(date);
    if (list) list.push(...bucket.usage);
    else byDate.set(date, [...bucket.usage]);
  }

  const days = [...byDate.keys()].sort().map((date) => {
    const usage = byDate.get(date)!;
    return { date, usage, cost: estimateCostRows(usage, rates) };
  });

  return { days, rates };
}

/**
 * "KST 오늘" 하루를 만든다. 미니 위젯 전용 경로 — 시간 버킷이 오늘 것뿐이라
 * 접을 것도 없지만, 날짜를 **호출자가 정한 KST 날짜로 못 박는다**.
 *
 * 진행 중인 시간 버킷이 KST 자정 직후일 때 `buildKstDays` 를 쓰면 버킷이 하나도
 * 없어서 빈 배열이 나오고, 화면에 "오늘" 줄 자체가 사라진다. 0 이라도 오늘 줄은
 * 있어야 하므로 이 함수는 **날짜를 먼저 정하고** 거기에 사용량을 붓는다.
 */
export function buildKstToday(
  date: string,
  usage: UsageRow[],
  rates: TokenRates,
): DayRows {
  return { date, usage, cost: estimateCostRows(usage, rates) };
}
