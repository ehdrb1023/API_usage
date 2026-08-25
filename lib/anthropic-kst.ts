/**
 * Anthropic 사용량·비용을 **KST 하루** 단위로 재구성한다.
 *
 * ── 왜 재구성이 필요한가 ──────────────────────────────────────────────────
 * Anthropic 이 주는 하루는 UTC 자정 기준이다. 한국에서 보면 오전 9시에 날짜가
 * 바뀌는 셈이라, "오늘 얼마 썼나" 를 보려는 사람에게는 하루가 어긋나 있다.
 *
 * 두 리포트의 시간 해상도가 달라서 처리도 갈린다.
 *   usage_report (토큰)  `bucket_width=1h` 지원 → **정확히 재구성된다**.
 *                        KST 자정 = UTC 15:00 정각이라 시간 버킷 경계와 맞는다.
 *   cost_report  (비용)  **1d(UTC) 뿐** → 자를 방법이 없다. 그래서 단가를 역산해
 *                        (lib/anthropic-rates.ts) KST 실측 토큰에 곱한다.
 *
 * ⚠️ 그 결과 **화면의 Claude 비용은 전부 추정치가 된다.** hold-out 검증에서 오차는
 *    ±0.1% 였지만(README 참고) 청구서와 소수점까지 같지는 않다. 정확한 청구액은
 *    Console 의 cost_report 값이 정답이고, 그건 UTC 하루 기준이다.
 *    KST 로 보는 대가가 이것이다 — 둘 다 가질 수는 없다.
 */

import type {
  AnthropicApiKeyMeta,
  AnthropicRaw,
  CostResult,
  UsageResult,
} from "@/lib/adapters/anthropic";
import {
  computeTokenRates,
  estimateCostResults,
  type TokenRates,
} from "@/lib/anthropic-rates";
import { kstDayOf } from "@/lib/kst";

type HourBucket = { starting_at: string; results: UsageResult[] };
type CostBucket = { starting_at: string; ending_at: string; results: CostResult[] };

export type AnthropicKstSource = {
  /** 1시간 버킷 (UTC 시각). KST 날짜로 접을 원본. */
  hourly: HourBucket[];
  /** UTC 하루 단위 비용. 단가 역산에만 쓰고 화면에는 직접 안 나간다. */
  cost: CostBucket[];
  apiKeys?: AnthropicApiKeyMeta[];
};

export type AnthropicKstResult = {
  /** KST 하루 버킷으로 다시 짠 것. `adaptAnthropic` 이 그대로 먹는다. */
  raw: AnthropicRaw;
  /**
   * 역산한 단가. 미니 위젯이 "KST 오늘" 을 1분마다 다시 계산할 때 재사용한다 —
   * 여기서 한 번 구해 캐시에 실어 보내면 분당 호출이 그만큼 줄어든다.
   */
  rates: TokenRates;
};

/**
 * 시간 버킷 → KST 하루 버킷. 비용은 단가 × 토큰으로 채운다.
 *
 * 단가는 **실측 비용에서** 뽑는다 (`cost` 인자). 재구성된 추정 비용으로 다시 단가를
 * 구하면 순환이 되어 오차가 눈덩이처럼 커진다 — 그래서 이 함수는 원본 cost_report 를
 * 반드시 함께 받는다.
 */
export function buildKstDays(source: AnthropicKstSource): AnthropicKstResult {
  // 단가 역산은 날짜 구분이 필요 없다. 시간 버킷 전체 합 : 비용 전체 합이면 된다.
  const rates = computeTokenRates({
    usage_report: { data: source.hourly.map(toBucketShape) },
    cost_report: { data: source.cost },
  });

  const byDate = new Map<string, UsageResult[]>();
  for (const bucket of source.hourly) {
    const date = kstDayOf(bucket.starting_at);
    const list = byDate.get(date);
    if (list) list.push(...bucket.results);
    else byDate.set(date, [...bucket.results]);
  }

  const dates = [...byDate.keys()].sort();

  return {
    raw: {
      usage_report: {
        data: dates.map((date) => ({
          // 앞 10글자가 곧 날짜다 — adaptAnthropic 이 그것만 본다.
          starting_at: `${date}T00:00:00Z`,
          ending_at: `${date}T23:59:59Z`,
          results: byDate.get(date)!,
        })),
      },
      cost_report: {
        data: dates.map((date) => ({
          starting_at: `${date}T00:00:00Z`,
          ending_at: `${date}T23:59:59Z`,
          results: estimateCostResults(byDate.get(date)!, rates),
        })),
      },
      api_keys: source.apiKeys,
    },
    rates,
  };
}

/** computeTokenRates 는 `ending_at` 을 안 보지만 타입을 맞춰 준다. */
function toBucketShape(b: HourBucket) {
  return { starting_at: b.starting_at, ending_at: b.starting_at, results: b.results };
}
