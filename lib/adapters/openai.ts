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

/**
 * 과금 축(token kind). Anthropic 의 `token_type` 에 대응한다.
 *
 * ⚠️ **화면 지표가 아니다.** 단가 역산과 비용 안분에만 쓴다 (절대규칙 3번).
 *
 * ── 왜 모달리티까지 쪼개는가 ───────────────────────────────────────────────
 * costs 의 `line_item` 이 `"gpt-image-1 image, output"` 처럼 **모달리티별로**
 * 나뉘어 오고 단가도 서로 다르다. 사용량을 같은 축으로 안 쪼개면 이미지 출력
 * 단가가 텍스트 출력에 섞여 조용히 틀린다. 실제로 이미지 출력이 이 조직 지출의
 * 대부분($25 / $27)이라 무시할 수 없다.
 */
export const OPENAI_TOKEN_KINDS = {
  /** 캐시를 타지 않은 입력. */
  input: (modality: Modality) => `${modality}.input`,
  /** 캐시 **읽기**. */
  cached: (modality: Modality) => `${modality}.cached_input`,
  output: (modality: Modality) => `${modality}.output`,
  /**
   * 캐시 **생성**. 읽기와 단가가 다르다 — 합치면 절대규칙 3번 위반이다.
   * 모달리티로 안 쪼개진다 (벤더가 `input_cache_write_tokens` 하나만 준다).
   */
  cacheWrite: "cache_writes",
} as const;

export type Modality = "text" | "image" | "audio";

/**
 * 모델 이름 정규화 — **usage 와 costs 가 서로 다른 이름을 준다.**
 *
 * 2026-08-27 실측:
 *   usage "gpt-image-1-2025-04-23"      costs "gpt-image-1"            (날짜가 usage 에만)
 *   usage "gpt-image-2"                 costs "gpt-image-2-2026-04-21" (날짜가 costs 에만)
 *   usage "gpt-4o-2024-08-06"           costs "gpt-4o-2024-08-06"      (양쪽 같음)
 *
 * **방향이 일정하지 않아** 한쪽만 맞추면 다른 쪽이 깨진다. 그래서 양쪽에서
 * 끝의 `-YYYY-MM-DD` 를 떼어 같은 이름으로 만든다. 안 맞추면 단가 조인이 실패해
 * 조용히 블렌디드 단가로 떨어지고, 화면의 모델별 표에는 같은 모델이 **두 줄**로
 * 나온다 (한 줄은 토큰만, 다른 줄은 비용만).
 *
 * 대가: 같은 모델의 날짜별 버전이 한 줄로 합쳐진다. 버전마다 단가가 다르면
 * 그만큼 섞이지만, 아예 매칭이 안 되는 것보다는 훨씬 낫다.
 */
export function normalizeModel(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/**
 * GET /v1/organization/usage/completions 의 결과 행.
 * 필드는 `lib/clients/types.ts` 의 같은 이름 타입과 맞춰 둔다 (2026-08-27 실측 기준).
 */
export type OpenAiUsageResult = {
  object?: string;
  /** group_by 에 model 이 없으면 null/undefined. */
  model?: string | null;
  /** group_by 에 project_id 가 없으면 null. */
  project_id?: string | null;
  api_key_id?: string | null;

  /** ✅ `input_cached_tokens` 를 **포함한** 총 입력 (실측 확인). */
  input_tokens: number;
  input_cached_tokens?: number;
  /** ✅ 캐시를 뺀 입력을 벤더가 직접 준다. 없으면 빼서 만든다. */
  input_uncached_tokens?: number;
  /** 캐시 **생성**. 읽기와 단가가 다르다. */
  input_cache_write_tokens?: number;
  output_tokens: number;
  num_model_requests?: number;

  /** ⚠️ 입력 쪽 모달리티 필드는 **캐시를 뺀 값**이다 (2026-08-27 실측). */
  input_text_tokens?: number;
  input_image_tokens?: number;
  input_audio_tokens?: number;
  input_cached_text_tokens?: number;
  input_cached_image_tokens?: number;
  input_cached_audio_tokens?: number;
  output_text_tokens?: number;
  output_image_tokens?: number;
  output_audio_tokens?: number;
};

/** GET /v1/organization/costs 의 결과 행. */
export type OpenAiCostResult = {
  object?: string;
  /** ⚠️ **USD 실수**다. 센트가 아니다. */
  amount: { value: number; currency: string };
  /** ✅ 실측 형식 `"<모델>[ <모달리티>], <방향>"` — `parseLineItem` 주석 참고. */
  line_item?: string | null;
  project_id?: string | null;
  api_key_id?: string | null;
  /** ✅ 과금 수량. 토큰이 아닌 항목(whisper)은 단위가 다르다. */
  quantity?: number;
  quantity_unit?: string | null;
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
    const n = (v: number | undefined | null) => (typeof v === "number" && v > 0 ? v : 0);

    const total = n(r.input_tokens);
    const cached = n(r.input_cached_tokens);
    // 벤더가 직접 준다. 없으면(옛 응답) 빼서 만든다. 음수 방지는 그대로 둔다.
    const uncached = r.input_uncached_tokens != null
      ? n(r.input_uncached_tokens)
      : Math.max(0, total - cached);
    const output = n(r.output_tokens);
    const cacheWrite = n(r.input_cache_write_tokens);

    // ⚠️ 입력 쪽 모달리티 필드는 **캐시를 뺀 값**이다 (2026-08-27 실측).
    const modalIn: Record<Modality, number> = {
      text: n(r.input_text_tokens),
      image: n(r.input_image_tokens),
      audio: n(r.input_audio_tokens),
    };
    const modalCached: Record<Modality, number> = {
      text: n(r.input_cached_text_tokens),
      image: n(r.input_cached_image_tokens),
      audio: n(r.input_cached_audio_tokens),
    };
    const modalOut: Record<Modality, number> = {
      text: n(r.output_text_tokens),
      image: n(r.output_image_tokens),
      audio: n(r.output_audio_tokens),
    };

    /**
     * 모달리티 합이 총계에 못 미치면 **남은 몫을 text 로 몰아넣는다.**
     * 벤더가 모달리티 필드를 안 준 옛 응답이나 새 모달리티가 생겼을 때
     * 토큰이 조용히 증발하는 걸 막는다. 총계는 언제나 보존된다.
     */
    const reconcile = (parts: Record<Modality, number>, expected: number) => {
      const sum = parts.text + parts.image + parts.audio;
      if (sum < expected) parts.text += expected - sum;
      return parts;
    };
    reconcile(modalIn, uncached);
    reconcile(modalCached, cached);
    reconcile(modalOut, output);

    const tokens: Record<string, number> = {};
    for (const m of ["text", "image", "audio"] as Modality[]) {
      if (modalIn[m] > 0) tokens[OPENAI_TOKEN_KINDS.input(m)] = modalIn[m];
      if (modalCached[m] > 0) tokens[OPENAI_TOKEN_KINDS.cached(m)] = modalCached[m];
      if (modalOut[m] > 0) tokens[OPENAI_TOKEN_KINDS.output(m)] = modalOut[m];
    }
    if (cacheWrite > 0) tokens[OPENAI_TOKEN_KINDS.cacheWrite] = cacheWrite;

    return {
      // 이름을 정규화해야 costs 와 조인된다 (normalizeModel 주석 참고).
      model: normalizeModel(r.model ?? null),
      // 보조 축은 API 키다. 키가 안 붙는 사용분은 프로젝트로 떨어뜨리고,
      // 그것마저 없으면 콘솔 직접 사용으로 본다.
      keyId: r.api_key_id ?? r.project_id ?? null,
      metrics: {
        // 화면 지표는 모달리티를 합친 값이다 (과금 축과 분리 — 절대규칙 3번).
        inputTokens: uncached,
        cacheReadTokens: cached,
        outputTokens: output,
        requests: n(r.num_model_requests),
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

/**
 * `line_item` → { model, tokenKind }. **2026-08-27 실측 34종을 기준으로 썼다.**
 *
 *   "gpt-5.6-terra, output"                → gpt-5.6-terra      / text.output
 *   "gpt-5.6-terra, cached input"          → gpt-5.6-terra      / text.cached_input
 *   "gpt-5.6-terra, cache writes"          → gpt-5.6-terra      / cache_writes
 *   "gpt-image-1 image, output"            → gpt-image-1        / image.output
 *   "gpt-image-2-2026-04-21 text, input"   → gpt-image-2        / text.input
 *   "whisper"                              → whisper            / null (토큰 아님)
 *
 * 모달리티가 없으면 텍스트 전용 모델이라는 뜻이라 `text` 로 본다.
 * 못 알아본 항목은 `tokenKind: null` 로 두어 단가 역산에서 빠지고
 * `nonTokenShare` 에 잡힌다 — 조용히 틀린 단가를 만드는 것보다 낫다.
 */
function parseLineItem(lineItem: string | null): {
  model: string | null;
  tokenKind: string | null;
} {
  if (!lineItem) return { model: null, tokenKind: null };

  const comma = lineItem.indexOf(",");
  if (comma === -1) {
    // "whisper" 처럼 방향이 없는 항목. 토큰 단위가 아닐 수 있다(초 단위 등).
    return { model: normalizeModel(lineItem.trim()) || null, tokenKind: null };
  }

  const head = lineItem.slice(0, comma).trim();
  const tail = lineItem.slice(comma + 1).trim().toLowerCase();

  // 모달리티는 모델명 **뒤에 공백으로** 붙어 온다. 떼어내지 않으면
  // "gpt-image-1 image" 라는 존재하지 않는 모델이 만들어진다.
  let modality: Modality = "text";
  let modelPart = head;
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) {
    const suffix = head.slice(lastSpace + 1).toLowerCase();
    if (suffix === "text" || suffix === "image" || suffix === "audio") {
      modality = suffix;
      modelPart = head.slice(0, lastSpace).trim();
    }
  }

  const model = normalizeModel(modelPart) || null;

  // ⚠️ 순서가 중요하다. "cached input" 과 "cache writes" 는 둘 다 "cach" 를
  //    포함하지만 단가가 다르다. 쓰기를 먼저 걸러야 한다.
  if (tail.includes("cache write")) {
    return { model, tokenKind: OPENAI_TOKEN_KINDS.cacheWrite };
  }
  if (tail.includes("cached")) {
    return { model, tokenKind: OPENAI_TOKEN_KINDS.cached(modality) };
  }
  if (tail.includes("output")) {
    return { model, tokenKind: OPENAI_TOKEN_KINDS.output(modality) };
  }
  if (tail.includes("input")) {
    return { model, tokenKind: OPENAI_TOKEN_KINDS.input(modality) };
  }
  return { model, tokenKind: null };
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
