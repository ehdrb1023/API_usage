/**
 * KST 하루 비용을 만들어내기 위한 **단가 역산**.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * Anthropic 은 리포트가 두 개인데 시간 해상도가 다르다.
 *   usage_report (토큰)  bucket_width = 1d | 1h | 1m
 *   cost_report  (비용)  bucket_width = **1d 뿐**
 *
 * 그런데 그 1d 는 UTC 자정 기준이다. KST 자정(=UTC 15:00)으로 하루를 끊으면
 * 비용은 어느 쪽 UTC 날짜에도 통째로 속하지 않는다. 토큰은 1h 버킷으로 정확히
 * 재구성되지만 비용은 방법이 없다.
 *
 * ── 그래서 무엇을 하나 ─────────────────────────────────────────────────────
 * 최근 UTC 날짜들의 (비용 ÷ 토큰) 으로 **단가**를 역산해 두고, KST 오늘의 실측
 * 토큰 수에 곱한다. 단가는 (모델 × 토큰 종류) 조합 안에서 사실상 상수라
 * (예: sonnet-5 cache_read = $0.20/MTok) 오차가 작다.
 *
 * ⚠️ 그래도 **추정치다.** 오차가 생기는 지점:
 *   - 같은 모델·토큰 종류라도 컨텍스트 200k 초과분은 단가가 다르다. usage_report 를
 *     `context_window` 로 group_by 하지 않으므로 최근 며칠의 가중평균이 섞인다.
 *   - batch 티어(50% 할인)도 같은 이유로 섞인다.
 *   - 웹 검색·코드 실행처럼 토큰이 아닌 비용은 애초에 토큰에 비례하지 않아 **뺀다**
 *     (`nonTokenShare` 로 얼마나 뺐는지는 알려준다).
 *   - 조회 구간에 없던 새 모델이면 토큰 종류 평균 → 전체 평균 순으로 떨어진다.
 *
 * 정확한 청구액은 UTC 하루가 닫힌 뒤 cost_report 값이 정답이다. 대시보드 본문은
 * 그쪽을 쓰고, 미니 위젯의 "오늘(KST)" 만 이 추정을 쓴다.
 *
 * ✅ 2026-08-25 실측 — 하루를 빼고 나머지 20일로 단가를 만든 뒤 그 하루를 맞히는
 *    방식(hold-out)으로 8/18~8/24 7일을 검증했다. 오차 **±0.1% 이내**:
 *      8/18 $24.04 → $24.04   8/20 $34.96 → $34.98 (+0.1%)   8/24 $12.05 → $12.05
 *    같은 기간 비토큰 비용 비중은 0.3% 였다. 단가가 조합 안에서 상수라는 전제가
 *    실제로 성립한다는 뜻이다. (검증 스크립트는 남기지 않았다 — 위 설명대로
 *    computeTokenRates/estimateCostResults 를 하루씩 빼며 돌리면 재현된다.)
 */

import {
  TOKEN_TYPE_PICKERS,
  type AnthropicRaw,
  type CostResult,
  type UsageResult,
} from "@/lib/adapters/anthropic";

const CENTS_PER_USD = 100;

export type TokenRates = {
  /** `${model}\t${tokenType}` → USD/토큰 */
  byModelTokenType: Map<string, number>;
  /** tokenType → USD/토큰 (모델 가중평균). 새 모델이 나왔을 때의 대안. */
  byTokenType: Map<string, number>;
  /** 전체 블렌디드 USD/토큰. 최후의 수단. */
  blended: number;
  /**
   * 토큰이 아닌 비용(웹 검색·코드 실행 등)이 전체 비용에서 차지하는 비율.
   * 추정에서 빠지는 몫이라, 화면에 얼마나 과소 계상되는지 알려주는 데 쓴다.
   */
  nonTokenShare: number;
  /** 단가를 뽑아낸 UTC 날짜 수. 0 이면 추정 자체가 불가능하다. */
  days: number;
};

const rateKey = (model: string, tokenType: string) => `${model}\t${tokenType}`;

/**
 * 최근 UTC 하루 단위 원본에서 단가를 역산한다.
 *
 * 진행 중인 오늘(UTC)은 **일부러 포함한다** — 토큰과 비용이 같은 구간에서 함께
 * 잘리므로 비율은 유지되고, 오늘 처음 쓴 모델의 단가를 잡아 주기 때문이다.
 */
export function computeTokenRates(raw: AnthropicRaw): TokenRates {
  const tokens = new Map<string, number>(); // model\ttokenType -> 토큰
  const cost = new Map<string, number>(); //   model\ttokenType -> USD

  for (const bucket of raw.usage_report?.data ?? []) {
    for (const r of bucket.results) {
      const model = r.model;
      if (!model) continue; // 모델을 모르면 단가를 붙일 축이 없다.
      for (const [tokenType, pick] of Object.entries(TOKEN_TYPE_PICKERS)) {
        const n = pick(r);
        if (n <= 0) continue;
        const k = rateKey(model, tokenType);
        tokens.set(k, (tokens.get(k) ?? 0) + n);
      }
    }
  }

  let tokenCost = 0;
  let nonTokenCost = 0;

  for (const bucket of raw.cost_report?.data ?? []) {
    for (const r of bucket.results) {
      const usd = Number(r.amount) / CENTS_PER_USD;
      if (!Number.isFinite(usd) || usd === 0) continue;

      if (!r.model || !r.token_type) {
        // 토큰에 비례하지 않는 비용. 추정에서 빼되 비중은 기억해 둔다.
        nonTokenCost += usd;
        continue;
      }
      tokenCost += usd;
      const k = rateKey(r.model, r.token_type);
      cost.set(k, (cost.get(k) ?? 0) + usd);
    }
  }

  const byModelTokenType = new Map<string, number>();
  const tokensByType = new Map<string, number>();
  const costByType = new Map<string, number>();
  let totalTokens = 0;

  for (const [k, n] of tokens) {
    const tokenType = k.split("\t")[1];
    tokensByType.set(tokenType, (tokensByType.get(tokenType) ?? 0) + n);
    totalTokens += n;

    const usd = cost.get(k);
    if (usd !== undefined && n > 0) byModelTokenType.set(k, usd / n);
  }
  for (const [k, usd] of cost) {
    const tokenType = k.split("\t")[1];
    costByType.set(tokenType, (costByType.get(tokenType) ?? 0) + usd);
  }

  const byTokenType = new Map<string, number>();
  for (const [tokenType, n] of tokensByType) {
    const usd = costByType.get(tokenType);
    if (usd !== undefined && n > 0) byTokenType.set(tokenType, usd / n);
  }

  const totalCost = tokenCost + nonTokenCost;

  return {
    byModelTokenType,
    byTokenType,
    blended: totalTokens > 0 ? tokenCost / totalTokens : 0,
    nonTokenShare: totalCost > 0 ? nonTokenCost / totalCost : 0,
    days: (raw.cost_report?.data ?? []).length,
  };
}

/** 단가 조회. 모델·토큰종류 → 토큰종류 → 전체 순으로 떨어진다. */
export function rateFor(
  rates: TokenRates,
  model: string,
  tokenType: string,
): number {
  return (
    rates.byModelTokenType.get(rateKey(model, tokenType)) ??
    rates.byTokenType.get(tokenType) ??
    rates.blended
  );
}

/**
 * 사용량 결과(시간 버킷을 모은 것)에 단가를 곱해 **cost_report 모양의 결과**를 만든다.
 *
 * 굳이 원본과 같은 모양으로 만드는 이유: 이렇게 해 두면 기존 `adaptAnthropic()` 을
 * 그대로 태울 수 있다. 모델별 집계도, API 키별 비용 안분도, 키 이름 매핑도 전부
 * 이미 거기 있다 — KST 전용 집계 코드를 새로 쓰면 그 로직이 두 벌이 된다.
 */
export function estimateCostResults(
  usageResults: UsageResult[],
  rates: TokenRates,
): CostResult[] {
  const tokens = new Map<string, number>();

  for (const r of usageResults) {
    const model = r.model;
    if (!model) continue; // 모델 미상 → 단가를 못 붙인다. 토큰 수에는 그대로 남는다.
    for (const [tokenType, pick] of Object.entries(TOKEN_TYPE_PICKERS)) {
      const n = pick(r);
      if (n <= 0) continue;
      const k = rateKey(model, tokenType);
      tokens.set(k, (tokens.get(k) ?? 0) + n);
    }
  }

  const out: CostResult[] = [];
  for (const [k, n] of tokens) {
    const [model, tokenType] = k.split("\t");
    const usd = n * rateFor(rates, model, tokenType);
    if (usd <= 0) continue;
    out.push({
      // ⚠️ cost_report 와 동일하게 **센트 문자열**. adaptAnthropic 이 /100 한다.
      amount: String(usd * CENTS_PER_USD),
      currency: "USD",
      model,
      description: null,
      token_type: tokenType,
    });
  }
  return out;
}
