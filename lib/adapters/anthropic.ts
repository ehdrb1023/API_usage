/**
 * Anthropic Admin API → 공통 모델. **이 파일은 변환만 한다** — 집계 규칙은
 * `lib/adapters/core.ts` 에, 단가 역산은 `lib/token-rates.ts` 에 있다.
 *
 * 원본은 세 엔드포인트로 나뉜다. 목업 파일에서도 같은 이름으로 분리해 뒀다.
 *   usage_report -> GET /v1/organizations/usage_report/messages   (토큰 수, 비용 없음)
 *   cost_report  -> GET /v1/organizations/cost_report             (비용, 토큰 수 없음)
 *   api_keys     -> GET /v1/organizations/api_keys                (키 id → 이름·상태)
 *
 * ⚠️ cost_report 의 `amount` 는 숫자가 아니라 **'센트' 단위 decimal 문자열**이다.
 *    "123.45" == $1.2345. 100 으로 나누지 않으면 금액이 100배가 된다.
 *    OpenAI 는 정반대로 **USD 실수**를 준다 (`adapters/openai.ts`). 두 벤더를
 *    나란히 만질 때 가장 잘 틀리는 지점이라, 환산은 각 어댑터 안에서 끝낸다 —
 *    코어(`CostRow.usd`)로 넘어간 뒤에는 언제나 USD 다.
 */

import {
  buildDailyPoints,
  type BuildOptions,
  type CostRow,
  type DayRows,
  type KeyMeta,
  type UsageRow,
} from "@/lib/adapters/core";
import type { ClientKeyNames } from "@/lib/client-keys";
import type { CostDay, HourBucket } from "@/lib/kst-days";
import type { DailyPoint, MetricSpec } from "@/lib/types";

export { CONSOLE_KEY_ID, UNALLOCATED_KEY_ID } from "@/lib/adapters/core";

const CENTS_PER_USD = 100;

export const ANTHROPIC_METRICS: MetricSpec[] = [
  { key: "inputTokens", label: "입력", format: "tokens" },
  { key: "cacheReadTokens", label: "캐시 읽기", format: "tokens" },
  { key: "cacheWriteTokens", label: "캐시 생성", format: "tokens" },
  { key: "outputTokens", label: "출력", format: "tokens" },
  { key: "totalTokens", label: "총 토큰", format: "tokens" },
];

export const ANTHROPIC_PRIMARY_METRIC = "totalTokens";

/**
 * 집계 옵션. `metricSpecs` 에서 합계 지표를 뺀 것이 `metricKeys` 다 —
 * 합계는 코어가 만들어 주므로 여기서 더하면 두 번 더해진다.
 */
export const ANTHROPIC_BUILD: BuildOptions = {
  metricKeys: ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"],
  totalKey: "totalTokens",
};

export type UsageResult = {
  model: string | null;
  /** `group_by[]=api_key_id` 를 안 걸면 null. 콘솔에서 직접 쓴 사용분도 null. */
  api_key_id?: string | null;
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  output_tokens: number;
};

export type CostResult = {
  amount: string;
  currency: string;
  model: string | null;
  description: string | null;
  /** 예: "uncached_input_tokens". 비-토큰 비용이면 null. */
  token_type?: string | null;
};

export type Bucket<T> = { starting_at: string; ending_at: string; results: T[] };

/** List API Keys 응답에서 표시에 필요한 것만 추린 모양. */
export type AnthropicApiKeyMeta = KeyMeta & { partial_key_hint?: string | null };

export type AnthropicRaw = {
  usage_report: { data: Bucket<UsageResult>[] };
  cost_report: { data: Bucket<CostResult>[] };
  /** 없으면 키 이름 대신 "(알 수 없는 키)" + id 가 표시된다. */
  api_keys?: AnthropicApiKeyMeta[];
};

/**
 * cost_report 의 `token_type` 값들. 단가 역산·비용 안분의 축이다.
 *
 * ⚠️ 화면 지표(`ANTHROPIC_METRICS`)와 **일부러 다르다.** 캐시 생성 5분/1시간은
 *    단가가 2배 차이인데 화면에는 "캐시 생성" 한 줄로 합쳐 보여준다. 과금 축까지
 *    합치면 단가가 두 값의 평균으로 뭉개져 비용 추정이 틀어진다.
 */
export const TOKEN_TYPE_PICKERS: Record<string, (r: UsageResult) => number> = {
  uncached_input_tokens: (r) => r.uncached_input_tokens ?? 0,
  cache_read_input_tokens: (r) => r.cache_read_input_tokens ?? 0,
  output_tokens: (r) => r.output_tokens ?? 0,
  "cache_creation.ephemeral_5m_input_tokens": (r) =>
    r.cache_creation?.ephemeral_5m_input_tokens ?? 0,
  "cache_creation.ephemeral_1h_input_tokens": (r) =>
    r.cache_creation?.ephemeral_1h_input_tokens ?? 0,
};

// ---------------------------------------------------------------- 변환

/** usage_report 결과 행 → 공통 사용량 행. */
export function toUsageRows(results: UsageResult[]): UsageRow[] {
  return results.map((r) => {
    const cacheWrite =
      (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
      (r.cache_creation?.ephemeral_1h_input_tokens ?? 0);

    const tokens: Record<string, number> = {};
    for (const [tokenKind, pick] of Object.entries(TOKEN_TYPE_PICKERS)) {
      const n = pick(r);
      if (n > 0) tokens[tokenKind] = n;
    }

    return {
      model: r.model ?? null,
      keyId: r.api_key_id ?? null,
      metrics: {
        inputTokens: r.uncached_input_tokens ?? 0,
        cacheReadTokens: r.cache_read_input_tokens ?? 0,
        cacheWriteTokens: cacheWrite,
        outputTokens: r.output_tokens ?? 0,
      },
      tokens,
    };
  });
}

/** cost_report 결과 행 → 공통 비용 행. **여기서 센트를 USD 로 바꾼다.** */
export function toCostRows(results: CostResult[]): CostRow[] {
  const out: CostRow[] = [];
  for (const r of results) {
    const usd = Number(r.amount) / CENTS_PER_USD;
    if (!Number.isFinite(usd)) continue;
    out.push({
      usd,
      // cost_report 는 group_by 에 model 이 없다. 응답에 model 이 실려오지만
      // null 일 수 있어서, 그 경우 description 에서 되살려 본다.
      model: r.model ?? modelFromDescription(r.description),
      tokenKind: r.token_type ?? null,
    });
  }
  return out;
}

/** 1시간 버킷 → KST 접기용 입력. */
export function toHourBuckets(buckets: { starting_at: string; results: UsageResult[] }[]): HourBucket[] {
  return buckets.map((b) => ({
    startedAt: b.starting_at,
    usage: toUsageRows(b.results),
  }));
}

/** UTC 하루 비용 버킷 → 단가 역산용 입력. */
export function toCostDays(buckets: Bucket<CostResult>[]): CostDay[] {
  return buckets.map((b) => ({
    date: b.starting_at.slice(0, 10),
    cost: toCostRows(b.results),
  }));
}

/**
 * 목업·이미 하루로 접힌 원본 → DayRows.
 *
 * 사용량 버킷과 비용 버킷은 별개 배열이라 **날짜로 합쳐야** 한다. 한쪽에만 있는
 * 날짜도 버리지 않는다 — 사용량 0 인 날, 비용만 잡힌 날 모두 실제로 나온다.
 */
export function toDayRows(raw: AnthropicRaw): DayRows[] {
  const byDate = new Map<string, DayRows>();

  const ensure = (date: string): DayRows => {
    let day = byDate.get(date);
    if (!day) {
      day = { date, usage: [], cost: [] };
      byDate.set(date, day);
    }
    return day;
  };

  for (const bucket of raw.usage_report?.data ?? []) {
    // 앞 10글자가 곧 날짜다. 하루로 접힌 뒤에는 시각이 의미를 갖지 않는다.
    ensure(bucket.starting_at.slice(0, 10)).usage.push(...toUsageRows(bucket.results));
  }
  for (const bucket of raw.cost_report?.data ?? []) {
    ensure(bucket.starting_at.slice(0, 10)).cost.push(...toCostRows(bucket.results));
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export type AdaptAnthropicOptions = {
  /**
   * `config/client-keys.json` 의 api_key_id → 표시 이름 매핑.
   * 콘솔 키 이름보다 **우선**한다. 없으면 콘솔 이름을 쓴다.
   */
  clientKeyNames?: ClientKeyNames;
};

/** 하루로 접힌 원본 → 화면 모델. 목업 경로와 테스트가 쓰는 진입점이다. */
export function adaptAnthropic(
  raw: AnthropicRaw,
  options: AdaptAnthropicOptions = {},
): DailyPoint[] {
  return adaptAnthropicDays(toDayRows(raw), raw.api_keys, options.clientKeyNames);
}

/** 이미 DayRows 로 접힌 실 API 경로용. */
export function adaptAnthropicDays(
  days: DayRows[],
  keys: AnthropicApiKeyMeta[] | undefined,
  clientKeyNames: ClientKeyNames | undefined,
): DailyPoint[] {
  return buildDailyPoints(days, { ...ANTHROPIC_BUILD, keys, clientKeyNames });
}

/** "claude-sonnet-5 Usage - Input Tokens" 같은 문자열에서 모델명만 뽑는다. */
function modelFromDescription(description: string | null): string | null {
  if (!description) return null;
  const m = description.match(/^(claude[\w.-]*)/i);
  return m ? m[1] : null;
}
