import type { BreakdownItem, DailyPoint, MetricSpec } from "@/lib/types";

/**
 * Anthropic Admin API → 정규화 모델.
 *
 * 원본은 두 엔드포인트로 나뉜다. 목업 파일에서도 같은 이름으로 분리해 뒀다.
 *   usage_report -> GET /v1/organizations/usage_report/messages   (토큰 수, 비용 없음)
 *   cost_report  -> GET /v1/organizations/cost_report             (비용, 토큰 수 없음)
 *
 * ⚠️ cost_report 의 `amount` 는 숫자가 아니라 '센트' 단위 decimal 문자열이다.
 *    "123.45" == $1.2345. 100 으로 나누지 않으면 금액이 100배가 된다.
 */

const CENTS_PER_USD = 100;

export const ANTHROPIC_METRICS: MetricSpec[] = [
  { key: "inputTokens", label: "입력", format: "tokens" },
  { key: "cacheReadTokens", label: "캐시 읽기", format: "tokens" },
  { key: "cacheWriteTokens", label: "캐시 생성", format: "tokens" },
  { key: "outputTokens", label: "출력", format: "tokens" },
  { key: "totalTokens", label: "총 토큰", format: "tokens" },
];

export const ANTHROPIC_PRIMARY_METRIC = "totalTokens";

type UsageResult = {
  model: string | null;
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  output_tokens: number;
};

type CostResult = {
  amount: string;
  currency: string;
  model: string | null;
  description: string | null;
};

type Bucket<T> = { starting_at: string; ending_at: string; results: T[] };

export type AnthropicRaw = {
  usage_report: { data: Bucket<UsageResult>[] };
  cost_report: { data: Bucket<CostResult>[] };
};

const EMPTY_METRICS = () => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

/** group_by=model 을 안 걸면 model 이 null 로 온다. 그때도 행이 사라지지 않게 한다. */
const modelKey = (m: string | null) => m ?? "(모델 미분류)";

export function adaptAnthropic(raw: AnthropicRaw): DailyPoint[] {
  // date -> model -> item
  const byDate = new Map<string, Map<string, BreakdownItem>>();

  const ensure = (date: string, model: string): BreakdownItem => {
    let models = byDate.get(date);
    if (!models) {
      models = new Map();
      byDate.set(date, models);
    }
    let item = models.get(model);
    if (!item) {
      item = { key: model, label: model, costUsd: 0, metrics: EMPTY_METRICS() };
      models.set(model, item);
    }
    return item;
  };

  for (const bucket of raw.usage_report?.data ?? []) {
    const date = bucket.starting_at.slice(0, 10);
    // 사용량이 없는 날도 버킷은 내려온다 (results: []). 0 으로 남겨두면 된다.
    if (!byDate.has(date)) byDate.set(date, new Map());

    for (const r of bucket.results) {
      const item = ensure(date, modelKey(r.model));
      const cacheWrite =
        (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
        (r.cache_creation?.ephemeral_1h_input_tokens ?? 0);

      item.metrics.inputTokens += r.uncached_input_tokens ?? 0;
      item.metrics.cacheReadTokens += r.cache_read_input_tokens ?? 0;
      item.metrics.cacheWriteTokens += cacheWrite;
      item.metrics.outputTokens += r.output_tokens ?? 0;
    }
  }

  for (const bucket of raw.cost_report?.data ?? []) {
    const date = bucket.starting_at.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, new Map());

    for (const r of bucket.results) {
      // cost_report 는 group_by 에 model 이 없다. 응답에는 model 필드가 실려오지만
      // null 일 수 있어서, 그 경우 description 에서 되살려 본다.
      const model = r.model ?? modelFromDescription(r.description);
      const item = ensure(date, modelKey(model));
      item.costUsd += Number(r.amount) / CENTS_PER_USD; // ← 센트 → USD
    }
  }

  return [...byDate.entries()]
    .map(([date, models]) => {
      const items: BreakdownItem[] = [...models.values()].map((item) => ({
        ...item,
        metrics: {
          ...item.metrics,
          // 단일 total_tokens 필드가 없어서 직접 합산한다
          totalTokens:
            item.metrics.inputTokens +
            item.metrics.cacheReadTokens +
            item.metrics.cacheWriteTokens +
            item.metrics.outputTokens,
        },
      }));
      items.sort((a, b) => b.costUsd - a.costUsd);

      const metrics: Record<string, number> = EMPTY_METRICS();
      let costUsd = 0;
      for (const item of items) {
        costUsd += item.costUsd;
        for (const k of Object.keys(metrics)) {
          metrics[k] += item.metrics[k] ?? 0;
        }
      }
      return { date, costUsd, metrics, items };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** "claude-sonnet-5 Usage - Input Tokens" 같은 문자열에서 모델명만 뽑는다. */
function modelFromDescription(description: string | null): string | null {
  if (!description) return null;
  const m = description.match(/^(claude[\w.-]*)/i);
  return m ? m[1] : null;
}
