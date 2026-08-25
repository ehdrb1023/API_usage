import type { ClientKeyNames } from "@/lib/client-keys";
import type { BreakdownItem, DailyPoint, MetricSpec } from "@/lib/types";

/**
 * Anthropic Admin API → 정규화 모델.
 *
 * 원본은 두 엔드포인트로 나뉜다. 목업 파일에서도 같은 이름으로 분리해 뒀다.
 *   usage_report -> GET /v1/organizations/usage_report/messages   (토큰 수, 비용 없음)
 *   cost_report  -> GET /v1/organizations/cost_report             (비용, 토큰 수 없음)
 *   api_keys     -> GET /v1/organizations/api_keys                (키 id → 이름·상태)
 *
 * ⚠️ cost_report 의 `amount` 는 숫자가 아니라 '센트' 단위 decimal 문자열이다.
 *    "123.45" == $1.2345. 100 으로 나누지 않으면 금액이 100배가 된다.
 *
 * 축은 두 개를 만든다. 같은 하루를 다르게 쪼갠 것뿐이라 두 축의 합계는 같다.
 *   items    — 모델별
 *   altItems — API 키별 (= 거래처에 내준 서비스별)
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
export type AnthropicApiKeyMeta = {
  id: string;
  name: string;
  /** "active" | "inactive" | "archived" (새 값이 올 수 있어 문자열로 받는다) */
  status: string;
  partial_key_hint?: string | null;
};

export type AnthropicRaw = {
  usage_report: { data: Bucket<UsageResult>[] };
  cost_report: { data: Bucket<CostResult>[] };
  /** 없으면 키 이름 대신 "(알 수 없는 키)" + id 가 표시된다. */
  api_keys?: AnthropicApiKeyMeta[];
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

/** api_key_id 가 null 인 사용분 — 콘솔(웹)에서 직접 쓴 몫. */
export const CONSOLE_KEY_ID = "__console__";
/** 어느 키에도 붙일 수 없었던 비용. 정상이라면 비어 있어야 한다. */
export const UNALLOCATED_KEY_ID = "__unallocated__";

/**
 * cost_report 의 `token_type` → usage_report 에서 같은 종류의 토큰을 꺼내는 함수.
 * 키별 비용 안분(아래 참고)의 가중치가 된다.
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

/** 가중치 맵의 와일드카드 축. 모델·토큰 종류를 가리지 않는 총량. */
const ANY = "*";
/** 모델명·token_type 에 공백이 없어서 공백 하나면 충분히 갈린다. */
const weightKey = (model: string, tokenType: string) =>
  `${model} ${tokenType}`;

export type AdaptAnthropicOptions = {
  /**
   * `config/client-keys.json` 의 api_key_id → 표시 이름 매핑.
   * Console 키 이름보다 **우선**한다. 없으면 지금까지와 동일하게 Console 이름을 쓴다.
   */
  clientKeyNames?: ClientKeyNames;
};

export function adaptAnthropic(
  raw: AnthropicRaw,
  options: AdaptAnthropicOptions = {},
): DailyPoint[] {
  const keyMeta = indexApiKeys(raw.api_keys, options.clientKeyNames ?? {});

  // date -> model -> item          (모델별 축)
  const byDate = new Map<string, Map<string, BreakdownItem>>();
  // date -> api_key_id -> item     (키별 축)
  const byDateKey = new Map<string, Map<string, BreakdownItem>>();
  // date -> "모델 토큰종류" -> api_key_id -> 토큰 수   (키별 비용 안분 가중치)
  const weights = new Map<string, Map<string, Map<string, number>>>();

  const ensureDate = (date: string) => {
    if (!byDate.has(date)) byDate.set(date, new Map());
    if (!byDateKey.has(date)) byDateKey.set(date, new Map());
  };

  const ensureItem = (
    table: Map<string, Map<string, BreakdownItem>>,
    date: string,
    key: string,
    decorate?: (item: BreakdownItem) => void,
  ): BreakdownItem => {
    ensureDate(date);
    const row = table.get(date)!;
    let item = row.get(key);
    if (!item) {
      item = { key, label: key, costUsd: 0, metrics: EMPTY_METRICS() };
      decorate?.(item);
      row.set(key, item);
    }
    return item;
  };

  const addWeight = (date: string, wk: string, keyId: string, tokens: number) => {
    let byWeightKey = weights.get(date);
    if (!byWeightKey) {
      byWeightKey = new Map();
      weights.set(date, byWeightKey);
    }
    let byKeyId = byWeightKey.get(wk);
    if (!byKeyId) {
      byKeyId = new Map();
      byWeightKey.set(wk, byKeyId);
    }
    byKeyId.set(keyId, (byKeyId.get(keyId) ?? 0) + tokens);
  };

  // ------------------------------------------------------------ 토큰 (usage)

  for (const bucket of raw.usage_report?.data ?? []) {
    const date = bucket.starting_at.slice(0, 10);
    // 사용량이 없는 날도 버킷은 내려온다 (results: []). 0 으로 남겨두면 된다.
    ensureDate(date);

    for (const r of bucket.results) {
      const cacheWrite =
        (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
        (r.cache_creation?.ephemeral_1h_input_tokens ?? 0);

      const addTokens = (item: BreakdownItem) => {
        item.metrics.inputTokens += r.uncached_input_tokens ?? 0;
        item.metrics.cacheReadTokens += r.cache_read_input_tokens ?? 0;
        item.metrics.cacheWriteTokens += cacheWrite;
        item.metrics.outputTokens += r.output_tokens ?? 0;
      };

      addTokens(ensureItem(byDate, date, modelKey(r.model)));

      const keyId = r.api_key_id ?? CONSOLE_KEY_ID;
      addTokens(
        ensureItem(byDateKey, date, keyId, (item) =>
          Object.assign(item, describeApiKey(keyId, keyMeta)),
        ),
      );

      // 안분 가중치. 모델까지 같은 (모델, 토큰 종류) 조합이 1순위,
      // 모델만 같은 조합이 2순위, 날짜 전체가 최후 수단이다.
      const model = r.model ?? ANY;
      for (const [tokenType, pick] of Object.entries(TOKEN_TYPE_PICKERS)) {
        const n = pick(r);
        if (n <= 0) continue;
        addWeight(date, weightKey(model, tokenType), keyId, n);
        addWeight(date, weightKey(model, ANY), keyId, n);
        addWeight(date, weightKey(ANY, ANY), keyId, n);
      }
    }
  }

  // ------------------------------------------------------------- 비용 (cost)

  for (const bucket of raw.cost_report?.data ?? []) {
    const date = bucket.starting_at.slice(0, 10);
    ensureDate(date);

    for (const r of bucket.results) {
      const usd = Number(r.amount) / CENTS_PER_USD; // ← 센트 → USD
      if (!Number.isFinite(usd)) continue;

      // cost_report 는 group_by 에 model 이 없다. 응답에는 model 필드가 실려오지만
      // null 일 수 있어서, 그 경우 description 에서 되살려 본다.
      const model = r.model ?? modelFromDescription(r.description);
      ensureItem(byDate, date, modelKey(model)).costUsd += usd;

      // ⚠️ cost_report 는 api_key_id 로 group_by 할 수 없다 (2026-08-14 실측: 400,
      //    "Valid options are description, workspace_id"). 그래서 키별 비용은
      //    같은 (날짜, 모델, 토큰 종류)의 토큰 수 비율로 **안분한 추정치**다.
      //    단가가 그 조합 안에서 일정하므로 오차는 작지만 0 은 아니다.
      const shares = weights.get(date);
      const candidates = [
        model ? weightKey(model, r.token_type ?? ANY) : undefined,
        model ? weightKey(model, ANY) : undefined,
        weightKey(ANY, ANY),
      ];

      let placed = false;
      for (const candidate of candidates) {
        if (!candidate) continue;
        const byKeyId = shares?.get(candidate);
        if (!byKeyId) continue;
        let total = 0;
        for (const n of byKeyId.values()) total += n;
        if (total <= 0) continue;

        for (const [keyId, n] of byKeyId) {
          ensureItem(byDateKey, date, keyId, (item) =>
            Object.assign(item, describeApiKey(keyId, keyMeta)),
          ).costUsd += (usd * n) / total;
        }
        placed = true;
        break;
      }

      if (!placed && usd !== 0) {
        ensureItem(byDateKey, date, UNALLOCATED_KEY_ID, (item) =>
          Object.assign(item, describeApiKey(UNALLOCATED_KEY_ID, keyMeta)),
        ).costUsd += usd;
      }
    }
  }

  // ------------------------------------------------------------------ 마무리

  return [...byDate.entries()]
    .map(([date, models]) => {
      const items = finalize([...models.values()]);
      const altItems = finalize([...(byDateKey.get(date)?.values() ?? [])]);

      const metrics: Record<string, number> = EMPTY_METRICS();
      let costUsd = 0;
      for (const item of items) {
        costUsd += item.costUsd;
        for (const k of Object.keys(metrics)) {
          metrics[k] += item.metrics[k] ?? 0;
        }
      }
      return { date, costUsd, metrics, items, altItems };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 총 토큰을 채우고 비용 내림차순으로 세운다. */
function finalize(items: BreakdownItem[]): BreakdownItem[] {
  return items
    .map((item) => ({
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
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

type ApiKeyIndex = {
  byId: Map<string, AnthropicApiKeyMeta>;
  /** 팀이 `config/client-keys.json` 에 지정한 이름. Console 이름보다 우선한다. */
  aliases: ClientKeyNames;
  /**
   * 같은 이름이 붙는 키가 둘 이상인 이름들. 표에서 구분자를 붙여야 한다.
   * **매핑을 적용한 뒤의 최종 이름** 기준이다 — 서로 다른 두 키에 같은 별칭을 달면
   * 그것도 겹침으로 잡힌다.
   */
  ambiguousNames: Set<string>;
};

function indexApiKeys(
  keys: AnthropicApiKeyMeta[] | undefined,
  aliases: ClientKeyNames,
): ApiKeyIndex {
  const byId = new Map<string, AnthropicApiKeyMeta>();
  for (const k of keys ?? []) byId.set(k.id, k);

  // 겹침 판정은 Console 목록과 매핑 파일의 **합집합**을 본다. 매핑에만 있는 id
  // (Console 에서 지워진 키 등)도 이름을 차지하기 때문이다.
  const nameCount = new Map<string, number>();
  for (const id of new Set([...byId.keys(), ...Object.keys(aliases)])) {
    const name = aliases[id] ?? byId.get(id)?.name;
    if (!name) continue; // 3순위(키 앞자리)는 id 라서 애초에 겹치지 않는다.
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }

  const ambiguousNames = new Set<string>();
  for (const [name, n] of nameCount) if (n > 1) ambiguousNames.add(name);

  return { byId, aliases, ambiguousNames };
}

/** 비활성으로 볼 상태. archived 는 실측으로 확인됐고 inactive 는 문서 기준. */
const INACTIVE_STATUSES = new Set(["archived", "inactive"]);

/** 3순위 라벨로 쓸 앞자리 길이. "apikey_" 7글자 + 식별자 9글자면 충분히 갈린다. */
const KEY_ID_PREFIX_LENGTH = 16;

function shortKeyId(keyId: string): string {
  return keyId.length > KEY_ID_PREFIX_LENGTH
    ? `${keyId.slice(0, KEY_ID_PREFIX_LENGTH)}…`
    : keyId;
}

/**
 * api_key_id → 화면에 쓸 라벨·배지·보조 식별자.
 *
 * 이름 우선순위:
 *   1. `config/client-keys.json` 매핑 (팀이 직접 관리)
 *   2. Console 에 등록된 키 이름
 *   3. 키 앞자리 (`apikey_01CUM5RW…`) — 위 둘 다 없을 때
 */
function describeApiKey(
  keyId: string,
  index: ApiKeyIndex,
): Pick<BreakdownItem, "label" | "badge" | "hint" | "title"> {
  if (keyId === CONSOLE_KEY_ID) return { label: "(콘솔 직접 사용)" };
  if (keyId === UNALLOCATED_KEY_ID) return { label: "(키 배분 불가)" };

  const alias = index.aliases[keyId];
  const meta = index.byId.get(keyId);
  const name = alias ?? meta?.name;

  // 3순위 — 매핑에도 Console 목록에도 없다 (삭제됐거나 다른 조직·워크스페이스의 키).
  // 라벨을 앞자리로 두되, 매핑 파일에 적어 넣으려면 전체 id 가 필요하므로 툴팁에 남긴다.
  if (!name) {
    return { label: shortKeyId(keyId), badge: "미등록", title: keyId };
  }

  return {
    label: name,
    badge:
      meta && INACTIVE_STATUSES.has(meta.status) ? "비활성" : undefined,
    // 같은 이름의 키가 여럿이면 이름만으로는 어느 쪽인지 알 수 없다.
    hint: index.ambiguousNames.has(name)
      ? (meta?.partial_key_hint ?? shortKeyId(keyId))
      : undefined,
    title: keyId,
  };
}

/** "claude-sonnet-5 Usage - Input Tokens" 같은 문자열에서 모델명만 뽑는다. */
function modelFromDescription(description: string | null): string | null {
  if (!description) return null;
  const m = description.match(/^(claude[\w.-]*)/i);
  return m ? m[1] : null;
}
