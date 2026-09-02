/**
 * 로컬 세션 로그용 **정적 단가표**.
 *
 * ── 왜 벤더 탭과 다른 방식인가 ────────────────────────────────────────────
 * Claude·GPT 탭은 벤더의 cost_report 에서 단가를 **역산**한다 (`lib/token-rates.ts`).
 * 실제 청구액에서 나온 값이라 정확하지만, 로컬 세션 로그에는 그 축이 아예 없다.
 * `~/.claude/projects/**.jsonl` 에는 토큰 수만 있고 금액은 한 글자도 없다.
 *
 * 그래서 여기서는 공개 단가표를 그대로 곱한다 (CodeBurn 이 LiteLLM 가격표를 쓰는 것과
 * 같은 방식이다). 토큰 수는 실측이고 **금액만 환산치**다.
 *
 * ⚠️ 이 금액이 청구서와 같다는 뜻이 아니다. 두 가지 이유가 있다.
 *   1. Claude Code 를 **구독(Pro·Max)** 으로 쓰면 토큰당 과금 자체가 없다.
 *      그때 이 값은 "같은 토큰을 API 로 썼다면 얼마" 라는 환산액이다.
 *   2. API 키로 쓰더라도 장기 컨텍스트 할증·배치 할인 등은 로그에 안 남는다.
 *
 * ⚠️ 단가는 사람이 손으로 갱신한다. 아래 CHECKED_ON 을 같이 고칠 것 —
 *    언제 기준 표인지 모르면 화면의 숫자를 믿을 수 없다.
 */

/** 이 표를 마지막으로 확인한 날. 화면 각주에 그대로 나간다. */
export const CHECKED_ON = "2026-08-31";

const MTOK = 1_000_000;

export type ModelPrice = {
  /** USD / 1M 입력 토큰 */
  input: number;
  /** USD / 1M 출력 토큰 */
  output: number;
};

/**
 * 표준 속도 단가 (USD / MTok).
 *
 * ⚠️ 여기 없는 모델은 **비용을 0 으로 두고 "단가 미상" 으로 표시**한다.
 *    모르는 모델에 비슷한 단가를 짐작해 넣으면, 틀린 숫자가 조용히 그럴듯하게 뜬다.
 */
const STANDARD: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * 패스트 모드 단가. 같은 모델을 더 빠르게 돌리는 대신 값이 다르다.
 * 로그의 `usage.speed` 가 "fast" 면 이쪽을 쓴다 (Opus 5 · 4.8 만 지원).
 */
const FAST: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 10, output: 50 },
};

/**
 * 입력 단가에 곱하는 배수. 캐시 생성은 TTL 에 따라 다르고, 캐시 읽기는 1/10 이다.
 * 5분/1시간을 합쳐서 계산하면 안 되는 이유가 이것이다 — 배수가 1.6배 차이난다.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
/** 배치 티어는 전체 50%. 로그의 `usage.service_tier` 가 "batch" 일 때만. */
export const BATCH_MULTIPLIER = 0.5;

/** 과금 축. 화면 지표(입력·캐시 읽기·캐시 생성·출력)와 **일부러 다르다**. */
export type TokenCounts = {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
};

/**
 * `claude-sonnet-4-5-20250929` 처럼 날짜가 붙은 id 에서 날짜를 뗀다.
 * 로그에는 보통 날짜 없는 id 가 오지만, 예전 버전이 남긴 줄이 섞일 수 있다.
 */
export function normalizeModel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** 단가를 찾는다. 모르는 모델이면 null — 부르는 쪽이 "단가 미상" 으로 드러내야 한다. */
export function priceOf(model: string, speed?: string): ModelPrice | null {
  const id = normalizeModel(model);
  if (speed === "fast") {
    // 패스트 표에 없으면 표준 단가로 떨어진다. 그 모델은 패스트를 지원하지 않으므로
    // 애초에 speed=fast 가 올 수 없지만, 새 모델이 생겨도 0 이 되지는 않게 둔다.
    return FAST[id] ?? STANDARD[id] ?? null;
  }
  return STANDARD[id] ?? null;
}

/**
 * 토큰 수 → USD.
 *
 * 모르는 모델이면 0 을 돌려준다. 호출자는 `priceOf` 로 미리 확인해서 그 모델을
 * "단가 미상" 으로 표시할 것 — 0 을 그냥 합계에 섞으면 과소 계상이 안 보인다.
 */
export function costOf(
  tokens: TokenCounts,
  model: string,
  speed?: string,
  tier?: string,
): number {
  const price = priceOf(model, speed);
  if (!price) return 0;

  const inRate = price.input / MTOK;
  const outRate = price.output / MTOK;

  const usd =
    tokens.input * inRate +
    tokens.cacheRead * inRate * CACHE_READ_MULTIPLIER +
    tokens.cacheWrite5m * inRate * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheWrite1h * inRate * CACHE_WRITE_1H_MULTIPLIER +
    tokens.output * outRate;

  return tier === "batch" ? usd * BATCH_MULTIPLIER : usd;
}

/** 화면 각주용 — 표에 들어 있는 모델 목록. */
export function pricedModels(): string[] {
  return Object.keys(STANDARD);
}
