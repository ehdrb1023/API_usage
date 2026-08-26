/**
 * 단가 역산 — **KST 하루 비용을 만들어내기 위한** 벤더 중립 계산.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * Claude 와 GPT 는 놀랍도록 같은 제약을 갖고 있다. 둘 다 리포트가 두 개인데
 * 시간 해상도가 다르다.
 *
 *   Anthropic  usage_report  1d | 1h | 1m      cost_report  **1d 뿐**
 *   OpenAI     usage/…       1d | 1h | 1m      costs        **1d 뿐**
 *
 * 그리고 그 1d 는 둘 다 **UTC 자정** 기준이다. 우리는 하루를 KST 자정
 * (= UTC 15:00)으로 끊는다. 토큰은 1시간 버킷으로 정확히 재구성되지만
 * 비용은 어느 UTC 날짜에도 통째로 속하지 않아 자를 방법이 없다.
 *
 * ── 그래서 무엇을 하나 ─────────────────────────────────────────────────────
 * 최근 UTC 날짜들의 (비용 ÷ 토큰) 으로 **단가**를 역산해 두고, KST 하루의 실측
 * 토큰 수에 곱한다. 단가는 (모델 × 토큰 종류) 조합 안에서 사실상 상수라
 * (예: sonnet-5 cache_read = $0.30/MTok) 오차가 작다.
 *
 * ⚠️ 그래도 **추정치다.** 오차가 생기는 지점:
 *   - 같은 모델·토큰 종류라도 컨텍스트 200k 초과분은 단가가 다르다. 사용량을
 *     `context_window` 로 group_by 하지 않으므로 최근 며칠의 가중평균이 섞인다.
 *   - batch 티어(50% 할인)도 같은 이유로 섞인다.
 *   - 웹 검색·코드 실행처럼 토큰이 아닌 비용은 애초에 토큰에 비례하지 않아 **뺀다**
 *     (`nonTokenShare` 로 얼마나 뺐는지는 알려준다).
 *   - 조회 구간에 없던 새 모델이면 토큰 종류 평균 → 전체 평균 순으로 떨어진다.
 *
 * ✅ 2026-08-25 Anthropic 실측 — 하루를 빼고 나머지 20일로 단가를 만든 뒤 그 하루를
 *    맞히는 방식(hold-out)으로 8/18~8/24 7일을 검증했다. 오차 **±0.1% 이내**:
 *      8/18 $24.04 → $24.04   8/20 $34.96 → $34.98 (+0.1%)   8/24 $12.05 → $12.05
 *    같은 기간 비토큰 비용 비중은 0.3% 였다. 단가가 조합 안에서 상수라는 전제가
 *    실제로 성립한다는 뜻이다.
 *    OpenAI 쪽은 **아직 같은 검증을 못 했다** — `docs/openai-integration.md` 참고.
 */

import type { CostRow, DayRows, UsageRow } from "@/lib/adapters/core";

/**
 * ⚠️ `Map` 이 아니라 평범한 객체다. 이 값은 `unstable_cache` 에 들어가는데
 *    캐시는 JSON 직렬화를 거치므로 `Map` 은 `{}` 로 뭉개진다. 한 번 겪으면
 *    "단가가 전부 0" 이라는 조용한 오작동으로 나타난다.
 */
export type TokenRates = {
  /** `${model}\t${tokenKind}` → USD/토큰 */
  byModelTokenType: Record<string, number>;
  /** tokenKind → USD/토큰 (모델 가중평균). 새 모델이 나왔을 때의 대안. */
  byTokenType: Record<string, number>;
  /** 전체 블렌디드 USD/토큰. 최후의 수단. */
  blended: number;
  /**
   * 토큰이 아닌 비용(웹 검색·코드 실행 등)이 전체 비용에서 차지하는 비율.
   * 추정에서 빠지는 몫이라, 화면에 얼마나 과소 계상되는지 알려주는 데 쓴다.
   */
  nonTokenShare: number;
  /** 단가를 뽑아낸 날 수. **0 이면 추정 자체가 불가능하다** 는 신호다. */
  days: number;
};

export const EMPTY_RATES: TokenRates = {
  byModelTokenType: {},
  byTokenType: {},
  blended: 0,
  nonTokenShare: 0,
  days: 0,
};

const rateKey = (model: string, tokenKind: string) => `${model}\t${tokenKind}`;

/**
 * 하루 단위 원본에서 단가를 역산한다.
 *
 * 진행 중인 오늘은 **일부러 포함한다** — 토큰과 비용이 같은 구간에서 함께 잘리므로
 * 비율은 유지되고, 오늘 처음 쓴 모델의 단가를 잡아 주기 때문이다.
 *
 * ⚠️ 넣는 원본은 **벤더가 준 실측 비용**이어야 한다. 이 함수가 만든 추정 비용을
 *    다시 넣으면 순환이 되어 오차가 눈덩이처럼 커진다.
 */
export function computeRates(days: DayRows[]): TokenRates {
  const tokens = new Map<string, number>(); // model\ttokenKind -> 토큰
  const cost = new Map<string, number>(); //   model\ttokenKind -> USD

  for (const day of days) {
    for (const row of day.usage) {
      const model = row.model;
      if (!model) continue; // 모델을 모르면 단가를 붙일 축이 없다.
      for (const [tokenKind, n] of Object.entries(row.tokens)) {
        if (!(n > 0)) continue;
        const k = rateKey(model, tokenKind);
        tokens.set(k, (tokens.get(k) ?? 0) + n);
      }
    }
  }

  let tokenCost = 0;
  let nonTokenCost = 0;
  let daysWithCost = 0;

  for (const day of days) {
    if (day.cost.length > 0) daysWithCost += 1;
    for (const row of day.cost) {
      const usd = row.usd;
      if (!Number.isFinite(usd) || usd === 0) continue;

      if (!row.model || !row.tokenKind) {
        // 토큰에 비례하지 않는 비용. 추정에서 빼되 비중은 기억해 둔다.
        nonTokenCost += usd;
        continue;
      }
      tokenCost += usd;
      const k = rateKey(row.model, row.tokenKind);
      cost.set(k, (cost.get(k) ?? 0) + usd);
    }
  }

  const byModelTokenType: Record<string, number> = {};
  const tokensByType = new Map<string, number>();
  const costByType = new Map<string, number>();
  let totalTokens = 0;

  for (const [k, n] of tokens) {
    const tokenKind = k.split("\t")[1];
    tokensByType.set(tokenKind, (tokensByType.get(tokenKind) ?? 0) + n);
    totalTokens += n;

    const usd = cost.get(k);
    if (usd !== undefined && n > 0) byModelTokenType[k] = usd / n;
  }
  for (const [k, usd] of cost) {
    const tokenKind = k.split("\t")[1];
    costByType.set(tokenKind, (costByType.get(tokenKind) ?? 0) + usd);
  }

  const byTokenType: Record<string, number> = {};
  for (const [tokenKind, n] of tokensByType) {
    const usd = costByType.get(tokenKind);
    if (usd !== undefined && n > 0) byTokenType[tokenKind] = usd / n;
  }

  const totalCost = tokenCost + nonTokenCost;

  return {
    byModelTokenType,
    byTokenType,
    blended: totalTokens > 0 ? tokenCost / totalTokens : 0,
    nonTokenShare: totalCost > 0 ? nonTokenCost / totalCost : 0,
    days: daysWithCost,
  };
}

/** 단가 조회. 모델·토큰종류 → 토큰종류 → 전체 순으로 떨어진다. */
export function rateFor(
  rates: TokenRates,
  model: string,
  tokenKind: string,
): number {
  return (
    rates.byModelTokenType[rateKey(model, tokenKind)] ??
    rates.byTokenType[tokenKind] ??
    rates.blended
  );
}

/**
 * 사용량 행(시간 버킷을 모은 것)에 단가를 곱해 **비용 행**을 만든다.
 *
 * 굳이 원본과 같은 모양(CostRow)으로 만드는 이유: 이렇게 해 두면 기존
 * `buildDailyPoints()` 를 그대로 태울 수 있다. 모델별 집계도, API 키별 비용 안분도,
 * 키 이름 매핑도 전부 이미 거기 있다 — KST 전용 집계 코드를 새로 쓰면 그 로직이
 * 두 벌이 된다.
 */
export function estimateCostRows(usage: UsageRow[], rates: TokenRates): CostRow[] {
  const tokens = new Map<string, number>();

  for (const row of usage) {
    const model = row.model;
    if (!model) continue; // 모델 미상 → 단가를 못 붙인다. 토큰 수에는 그대로 남는다.
    for (const [tokenKind, n] of Object.entries(row.tokens)) {
      if (!(n > 0)) continue;
      const k = rateKey(model, tokenKind);
      tokens.set(k, (tokens.get(k) ?? 0) + n);
    }
  }

  const out: CostRow[] = [];
  for (const [k, n] of tokens) {
    const [model, tokenKind] = k.split("\t");
    const usd = n * rateFor(rates, model, tokenKind);
    if (usd <= 0) continue;
    out.push({ usd, model, tokenKind });
  }
  return out;
}
