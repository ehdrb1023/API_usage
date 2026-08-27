/**
 * OpenAI Admin API(사용량·비용) → 공통 모델. **자리만 잡아 둔 상태다.**
 *
 *   usage   -> GET /v1/organization/usage/completions   (토큰 수, 비용 없음)
 *   costs   -> GET /v1/organization/costs               (비용, 토큰 수 없음)
 *
 * ⚠️⚠️ 이 파일의 필드명은 **공개 문서 기준이고 실제 응답으로 검증되지 않았다.**
 *      실 키를 넣기 전에 `docs/openai-integration.md` 의 체크리스트를 먼저 돌릴 것.
 *      틀릴 가능성이 높은 순서대로 거기에 적어 뒀다.
 *
 * ── Anthropic 과 다른 점 (여기서 가장 잘 틀린다) ──────────────────────────
 *
 * 1. **금액 단위가 반대다.** Anthropic 은 센트 문자열("123.45" = $1.2345),
 *    OpenAI 는 `amount.value` 가 **USD 실수**다. 100 을 나누면 100배 적게 나온다.
 *
 * 2. **경로가 단수다.** Anthropic `/v1/organizations/…`, OpenAI `/v1/organization/…`.
 *
 * 3. **시각이 unix 초다.** Anthropic 은 ISO8601 문자열, OpenAI 는 `start_time`
 *    정수(초). 그대로 넘기면 400 이 난다.
 *
 * 4. **`input_tokens` 에 캐시 읽기가 포함된다.** Anthropic 의
 *    `uncached_input_tokens` 는 캐시 읽기를 **뺀** 값인데, OpenAI 의 `input_tokens`
 *    는 `input_cached_tokens` 를 **포함한 총 입력**이다. 그대로 두면 탭마다
 *    "입력 토큰" 의 뜻이 달라지고 총합이 캐시 읽기만큼 부풀려진다.
 *    → 여기서 `inputTokens = input_tokens - input_cached_tokens` 로 **뺀다.**
 *       두 탭의 "입력" 은 언제나 "캐시를 타지 않은 입력" 이다.
 *
 * 5. **비용을 모델로 쪼갤 수 없다.** costs 의 group_by 는 `line_item`·`project_id`
 *    뿐이라 모델별 비용이 직접 나오지 않는다. Anthropic 의 cost_report 가
 *    api_key_id 로 못 쪼개는 것과 같은 제약이고, 대응도 같다 — 단가를 역산해
 *    (`lib/token-rates.ts`) KST 실측 토큰에 곱한다.
 *
 * 6. **보조 축은 API 키다. 다만 이름을 모으는 길이 다르다.** usage/completions 는
 *    `group_by=api_key_id` 를 지원하므로 사용량 자체는 Claude 탭과 똑같이 키 단위로
 *    쪼개진다. 문제는 **이름**이다 — OpenAI 에는 조직 전체 키를 한 번에 주는
 *    엔드포인트가 없어서(Anthropic 은 `/v1/organizations/api_keys` 하나로 끝난다),
 *    프로젝트를 먼저 나열하고 프로젝트마다
 *    `/v1/organization/projects/{id}/api_keys` 를 다시 두드려야 한다.
 *
 *    키가 안 붙는 사용분(콘솔·비 API 트래픽)은 `api_key_id` 가 null 로 오는데,
 *    그때는 **project_id 로 떨어뜨린다.** 전부 "콘솔" 한 덩어리로 뭉치는 것보다
 *    어느 프로젝트 몫인지라도 남는 편이 낫기 때문이다. 이름 매핑에는 키 id 와
 *    프로젝트 id 가 함께 들어가므로 어느 쪽이 와도 이름이 붙는다.
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

export const OPENAI_METRICS: MetricSpec[] = [
  { key: "inputTokens", label: "입력", format: "tokens" },
  { key: "cacheReadTokens", label: "캐시 읽기", format: "tokens" },
  { key: "outputTokens", label: "출력", format: "tokens" },
  { key: "totalTokens", label: "총 토큰", format: "tokens" },
  { key: "requests", label: "요청", format: "count" },
];

export const OPENAI_PRIMARY_METRIC = "totalTokens";

/**
 * ⚠️ `requests` 는 토큰이 아니므로 `totalOf` 에서 뺀다. 넣으면 "총 토큰" 에
 *    요청 수가 더해져 조용히 틀린 숫자가 된다.
 */
export const OPENAI_BUILD: BuildOptions = {
  metricKeys: ["inputTokens", "cacheReadTokens", "outputTokens", "requests"],
  totalKey: "totalTokens",
  totalOf: ["inputTokens", "cacheReadTokens", "outputTokens"],
};

/** 과금 축(token kind). Anthropic 의 `token_type` 에 대응한다. */
export const OPENAI_TOKEN_KINDS = {
  input: "input_tokens_uncached",
  cached: "input_cached_tokens",
  output: "output_tokens",
} as const;

/** GET /v1/organization/usage/completions 의 결과 행. */
export type OpenAiUsageResult = {
  object?: string;
  /** group_by 에 model 이 없으면 null/undefined. */
  model?: string | null;
  /** group_by 에 project_id 가 없으면 null. 보조 축(= 거래처)으로 쓴다. */
  project_id?: string | null;
  api_key_id?: string | null;
  /** ⚠️ `input_cached_tokens` 를 **포함한** 총 입력. 위 4번 참고. */
  input_tokens: number;
  input_cached_tokens?: number;
  output_tokens: number;
  num_model_requests?: number;
};

/** GET /v1/organization/costs 의 결과 행. */
export type OpenAiCostResult = {
  object?: string;
  /** ⚠️ **USD 실수**다. 센트가 아니다. */
  amount: { value: number; currency: string };
  /** 예: "gpt-4o-2024-08-06, input". 형식 미검증 — 아래 파서 주석 참고. */
  line_item?: string | null;
  project_id?: string | null;
};

export type OpenAiBucket<T> = {
  /** unix 초. Anthropic 과 달리 ISO 문자열이 아니다. */
  start_time: number;
  end_time: number;
  results: T[];
};

export type OpenAiProjectMeta = KeyMeta;

export type OpenAiRaw = {
  usage: { data: OpenAiBucket<OpenAiUsageResult>[] };
  costs: { data: OpenAiBucket<OpenAiCostResult>[] };
  /** 프로젝트 id → 이름. 없으면 id 앞자리로 표시된다. */
  projects?: OpenAiProjectMeta[];
};

// ---------------------------------------------------------------- 변환

/** usage 결과 행 → 공통 사용량 행. */
export function toUsageRows(results: OpenAiUsageResult[]): UsageRow[] {
  return results.map((r) => {
    const cached = r.input_cached_tokens ?? 0;
    // ⚠️ 캐시 읽기를 빼서 Anthropic 과 같은 뜻으로 맞춘다 (위 4번).
    //    음수 방지: 문서와 달리 input_tokens 가 캐시를 제외한 값일 가능성에 대비한다.
    const uncached = Math.max(0, (r.input_tokens ?? 0) - cached);
    const output = r.output_tokens ?? 0;

    const tokens: Record<string, number> = {};
    if (uncached > 0) tokens[OPENAI_TOKEN_KINDS.input] = uncached;
    if (cached > 0) tokens[OPENAI_TOKEN_KINDS.cached] = cached;
    if (output > 0) tokens[OPENAI_TOKEN_KINDS.output] = output;

    return {
      model: r.model ?? null,
      // 보조 축은 API 키다 (위 6번). 키가 안 붙는 사용분은 프로젝트로 떨어뜨리고,
      // 그것마저 없으면 콘솔 직접 사용으로 본다.
      keyId: r.api_key_id ?? r.project_id ?? null,
      metrics: {
        inputTokens: uncached,
        cacheReadTokens: cached,
        outputTokens: output,
        requests: r.num_model_requests ?? 0,
      },
      tokens,
    };
  });
}

/**
 * costs 결과 행 → 공통 비용 행. **금액은 이미 USD 라 나누지 않는다.**
 *
 * `line_item` 에서 모델·토큰 종류를 뽑아낼 수 있으면 단가 역산이 (모델 × 토큰 종류)
 * 조합까지 내려가고, 못 뽑으면 블렌디드 단가 하나로 떨어진다. 후자여도 동작은
 * 하지만 입력·출력 단가 차이(보통 3~8배)가 평균으로 뭉개져 모델별 비용이 부정확해진다.
 *
 * ⚠️ **`line_item` 의 실제 형식은 미검증이다.** 실 키가 생기면 원문을 떠서
 *    `docs/openai-integration.md` 에 적고 이 파서를 고칠 것. 못 맞히면 조용히
 *    블렌디드로 떨어지므로 **틀려도 티가 안 난다** — 그래서 확인이 필요하다.
 */
export function toCostRows(results: OpenAiCostResult[]): CostRow[] {
  const out: CostRow[] = [];
  for (const r of results) {
    const usd = r.amount?.value;
    if (!Number.isFinite(usd)) continue;
    const parsed = parseLineItem(r.line_item ?? null);
    out.push({ usd: usd as number, model: parsed.model, tokenKind: parsed.tokenKind });
  }
  return out;
}

/** "gpt-4o-2024-08-06, input" → { model, tokenKind }. 못 알아보면 둘 다 null. */
function parseLineItem(lineItem: string | null): {
  model: string | null;
  tokenKind: string | null;
} {
  if (!lineItem) return { model: null, tokenKind: null };

  const [head, tail] = lineItem.split(",", 2).map((s) => s.trim());
  if (!tail) return { model: head || null, tokenKind: null };

  const kind = tail.toLowerCase();
  if (kind.includes("cach")) {
    return { model: head, tokenKind: OPENAI_TOKEN_KINDS.cached };
  }
  if (kind.includes("output")) {
    return { model: head, tokenKind: OPENAI_TOKEN_KINDS.output };
  }
  if (kind.includes("input")) {
    return { model: head, tokenKind: OPENAI_TOKEN_KINDS.input };
  }
  // 토큰이 아닌 항목(웹 검색·이미지 등). 단가 역산에서 빠지고 비중만 기록된다.
  return { model: head, tokenKind: null };
}

/** unix 초 → ISO 문자열. KST 접기는 ISO 만 다룬다. */
export function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** 1시간 버킷 → KST 접기용 입력. */
export function toHourBuckets(buckets: OpenAiBucket<OpenAiUsageResult>[]): HourBucket[] {
  return buckets.map((b) => ({
    startedAt: toIso(b.start_time),
    usage: toUsageRows(b.results),
  }));
}

/** UTC 하루 비용 버킷 → 단가 역산용 입력. */
export function toCostDays(buckets: OpenAiBucket<OpenAiCostResult>[]): CostDay[] {
  return buckets.map((b) => ({
    date: toIso(b.start_time).slice(0, 10),
    cost: toCostRows(b.results),
  }));
}

/** 목업·이미 하루로 접힌 원본 → DayRows. */
export function toDayRows(raw: OpenAiRaw): DayRows[] {
  const byDate = new Map<string, DayRows>();

  const ensure = (date: string): DayRows => {
    let day = byDate.get(date);
    if (!day) {
      day = { date, usage: [], cost: [] };
      byDate.set(date, day);
    }
    return day;
  };

  for (const bucket of raw.usage?.data ?? []) {
    ensure(toIso(bucket.start_time).slice(0, 10)).usage.push(...toUsageRows(bucket.results));
  }
  for (const bucket of raw.costs?.data ?? []) {
    ensure(toIso(bucket.start_time).slice(0, 10)).cost.push(...toCostRows(bucket.results));
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function adaptOpenAi(
  raw: OpenAiRaw,
  options: { clientKeyNames?: ClientKeyNames } = {},
): DailyPoint[] {
  return adaptOpenAiDays(toDayRows(raw), raw.projects, options.clientKeyNames);
}

export function adaptOpenAiDays(
  days: DayRows[],
  projects: OpenAiProjectMeta[] | undefined,
  clientKeyNames: ClientKeyNames | undefined,
): DailyPoint[] {
  return buildDailyPoints(days, { ...OPENAI_BUILD, keys: projects, clientKeyNames });
}
