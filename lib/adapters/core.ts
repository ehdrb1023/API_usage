/**
 * 벤더 중립 집계 코어 — **AI API 벤더가 둘 이상이라서** 있는 파일이다.
 *
 * Claude(Anthropic)와 GPT(OpenAI)는 응답 스키마가 다르지만, 대시보드가 해야 하는
 * 일은 글자 그대로 같다:
 *
 *   1. 하루를 **모델별**과 **API 키별** 두 축으로 쪼갠다 (합계는 서로 같아야 한다)
 *   2. 키 표시 이름을 우선순위대로 고른다 (팀 매핑 → 벤더 콘솔 이름 → 키 앞자리)
 *   3. 비용을 키별로 **안분**한다 — 두 벤더 모두 비용 리포트를 api_key_id 로
 *      group_by 할 수 없어서, 같은 (날짜·모델·토큰 종류)의 토큰 수 비율로 나눈다
 *
 * 3번이 이 파일이 존재하는 진짜 이유다. 벤더마다 따로 쓰면 두 벌이 되고, 한쪽만
 * 고쳐지면서 "Claude 탭은 맞는데 GPT 탭은 합계가 안 맞는" 상태로 간다.
 *
 * 벤더 어댑터(`adapters/anthropic.ts`, `adapters/openai.ts`)가 하는 일은
 * **원본 → DayRows 변환뿐**이다. 집계 규칙은 여기 한 곳에만 있다.
 *
 * ── 축이 두 개인 것에 주의 ────────────────────────────────────────────────
 *   `UsageRow.metrics`  화면에 표시할 지표 (입력·캐시·출력·총 토큰·요청 수 …)
 *   `UsageRow.tokens`   **과금 축** (벤더가 값을 매기는 단위 = token_type)
 *
 * 둘을 합치면 안 된다. Anthropic 은 캐시 생성 5분/1시간의 단가가 2배 차이인데
 * 화면에는 "캐시 생성" 한 줄로 합쳐 보여준다. 과금 축을 화면 축으로 뭉개면
 * 단가 역산이 두 단가의 평균으로 뭉개져 비용 추정이 틀어진다.
 */

import type { ClientKeyNames } from "@/lib/client-keys";
import type { BreakdownItem, DailyPoint } from "@/lib/types";

/** 사용량 한 줄. 벤더 응답의 결과 행 하나에 대응한다. */
export type UsageRow = {
  /** group_by 에 model 이 없거나 벤더가 null 을 주면 null. */
  model: string | null;
  /** api_key_id. null 이면 콘솔에서 직접 쓴 몫으로 본다. */
  keyId: string | null;
  /** 화면 지표 키 → 값. `BuildOptions.metricKeys` 와 같은 이름을 쓴다. */
  metrics: Record<string, number>;
  /** 과금 축(token_type) → 토큰 수. 단가 역산과 비용 안분에만 쓴다. */
  tokens: Record<string, number>;
};

/** 비용 한 줄. 금액은 **USD 로 환산이 끝난 값**이어야 한다. */
export type CostRow = {
  usd: number;
  model: string | null;
  /** 과금 축(token_type). null 이면 토큰에 비례하지 않는 비용(웹 검색 등). */
  tokenKind: string | null;
};

/** 하루치. `date` 는 이미 **KST 날짜**로 접힌 상태여야 한다 (`lib/kst-days.ts`). */
export type DayRows = {
  /** YYYY-MM-DD */
  date: string;
  usage: UsageRow[];
  cost: CostRow[];
};

/** 벤더 콘솔에서 읽어 온 API 키 메타. 표시 이름·상태 배지에 쓴다. */
export type KeyMeta = {
  id: string;
  name: string;
  /** "active" | "inactive" | "archived" (새 값이 올 수 있어 문자열로 받는다) */
  status: string;
  partial_key_hint?: string | null;
};

export type BuildOptions = {
  /** 화면 지표 키. 여기 없는 키는 집계되지 않는다. */
  metricKeys: string[];
  /** 합계 지표 키. 예: "totalTokens". */
  totalKey?: string;
  /** `totalKey` 에 합산할 지표. 기본은 `metricKeys` 전부 — 요청 수처럼 토큰이 아닌 지표는 빼야 한다. */
  totalOf?: string[];
  keys?: KeyMeta[];
  /** `config/client-keys.json` 매핑. 벤더 콘솔 이름보다 **우선**한다. */
  clientKeyNames?: ClientKeyNames;
};

/** api_key_id 가 null 인 사용분 — 콘솔(웹)에서 직접 쓴 몫. */
export const CONSOLE_KEY_ID = "__console__";
/** 어느 키에도 붙일 수 없었던 비용. 정상이라면 비어 있어야 한다. */
export const UNALLOCATED_KEY_ID = "__unallocated__";

/** group_by=model 을 안 걸면 model 이 null 로 온다. 그때도 행이 사라지지 않게 한다. */
export const UNKNOWN_MODEL_LABEL = "(모델 미분류)";

/** 가중치 맵의 와일드카드 축. 모델·토큰 종류를 가리지 않는 총량. */
const ANY = "*";
/** 모델명·token_type 에 공백이 없어서 공백 하나면 충분히 갈린다. */
const weightKey = (model: string, tokenKind: string) => `${model} ${tokenKind}`;

const modelKey = (m: string | null) => m ?? UNKNOWN_MODEL_LABEL;

/**
 * DayRows → 화면이 보는 DailyPoint.
 *
 * 날짜 오름차순으로 정렬해서 돌려준다. 빈 하루(사용량 0)도 버리지 않는다 —
 * 차트에서 구멍이 되면 "데이터가 없는 날" 과 "안 쓴 날" 이 구별되지 않는다.
 */
export function buildDailyPoints(
  days: DayRows[],
  options: BuildOptions,
): DailyPoint[] {
  const index = indexKeys(options.keys, options.clientKeyNames ?? {});
  const zeros = () => emptyMetrics(options);

  return days
    .map((day) => buildOneDay(day, options, index, zeros))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildOneDay(
  day: DayRows,
  options: BuildOptions,
  index: KeyIndex,
  zeros: () => Record<string, number>,
): DailyPoint {
  const byModel = new Map<string, BreakdownItem>();
  const byKey = new Map<string, BreakdownItem>();
  /** "모델 토큰종류" → keyId → 토큰 수. 비용 안분의 가중치다. */
  const weights = new Map<string, Map<string, number>>();

  const ensure = (
    table: Map<string, BreakdownItem>,
    key: string,
    decorate?: (item: BreakdownItem) => void,
  ): BreakdownItem => {
    let item = table.get(key);
    if (!item) {
      item = { key, label: key, costUsd: 0, metrics: zeros() };
      decorate?.(item);
      table.set(key, item);
    }
    return item;
  };

  const ensureKeyItem = (keyId: string) =>
    ensure(byKey, keyId, (item) => Object.assign(item, describeKey(keyId, index)));

  const addWeight = (wk: string, keyId: string, tokens: number) => {
    let byKeyId = weights.get(wk);
    if (!byKeyId) {
      byKeyId = new Map();
      weights.set(wk, byKeyId);
    }
    byKeyId.set(keyId, (byKeyId.get(keyId) ?? 0) + tokens);
  };

  // ------------------------------------------------------------ 사용량 (토큰)

  for (const row of day.usage) {
    const keyId = row.keyId ?? CONSOLE_KEY_ID;

    const addMetrics = (item: BreakdownItem) => {
      for (const k of options.metricKeys) {
        item.metrics[k] += row.metrics[k] ?? 0;
      }
    };

    addMetrics(ensure(byModel, modelKey(row.model)));
    addMetrics(ensureKeyItem(keyId));

    // 안분 가중치. (모델, 토큰 종류)가 1순위, 모델만 같은 조합이 2순위,
    // 날짜 전체가 최후 수단이다. 아래 비용 루프가 이 순서로 찾아 내려간다.
    const model = row.model ?? ANY;
    for (const [tokenKind, n] of Object.entries(row.tokens)) {
      if (!(n > 0)) continue;
      addWeight(weightKey(model, tokenKind), keyId, n);
      addWeight(weightKey(model, ANY), keyId, n);
      addWeight(weightKey(ANY, ANY), keyId, n);
    }
  }

  // ------------------------------------------------------------- 비용

  for (const row of day.cost) {
    if (!Number.isFinite(row.usd)) continue;

    ensure(byModel, modelKey(row.model)).costUsd += row.usd;

    // 벤더의 비용 리포트는 api_key_id 로 group_by 할 수 없다 (두 벤더 모두).
    // 그래서 키별 비용은 같은 (날짜·모델·토큰 종류) 토큰 수 비율로 **안분한 추정치**다.
    // 단가가 그 조합 안에서 상수라 오차는 작지만 0 은 아니다.
    const candidates = [
      row.model ? weightKey(row.model, row.tokenKind ?? ANY) : undefined,
      row.model ? weightKey(row.model, ANY) : undefined,
      weightKey(ANY, ANY),
    ];

    let placed = false;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const byKeyId = weights.get(candidate);
      if (!byKeyId) continue;

      let total = 0;
      for (const n of byKeyId.values()) total += n;
      if (total <= 0) continue;

      for (const [keyId, n] of byKeyId) {
        ensureKeyItem(keyId).costUsd += (row.usd * n) / total;
      }
      placed = true;
      break;
    }

    // 토큰이 하나도 없는 날의 비용 — 붙일 축이 없으니 별도 행으로 드러낸다.
    if (!placed && row.usd !== 0) {
      ensureKeyItem(UNALLOCATED_KEY_ID).costUsd += row.usd;
    }
  }

  // ------------------------------------------------------------------ 마무리

  const items = finalize([...byModel.values()], options);
  const altItems = finalize([...byKey.values()], options);

  const metrics = zeros();
  let costUsd = 0;
  for (const item of items) {
    costUsd += item.costUsd;
    for (const k of Object.keys(metrics)) metrics[k] += item.metrics[k] ?? 0;
  }

  return { date: day.date, costUsd, metrics, items, altItems };
}

function emptyMetrics(options: BuildOptions): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of options.metricKeys) out[k] = 0;
  if (options.totalKey) out[options.totalKey] = 0;
  return out;
}

/** 합계 지표를 채우고 비용 내림차순으로 세운다. */
function finalize(items: BreakdownItem[], options: BuildOptions): BreakdownItem[] {
  const totalKey = options.totalKey;
  const totalOf = options.totalOf ?? options.metricKeys;

  return items
    .map((item) => {
      if (!totalKey) return item;
      let total = 0;
      for (const k of totalOf) total += item.metrics[k] ?? 0;
      // 벤더가 단일 "총 토큰" 필드를 주지 않아서 직접 합산한다 (두 벤더 모두).
      return { ...item, metrics: { ...item.metrics, [totalKey]: total } };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
}

// ---------------------------------------------------------------- 키 표시 이름

type KeyIndex = {
  byId: Map<string, KeyMeta>;
  /** 팀이 `config/client-keys.json` 에 지정한 이름. 콘솔 이름보다 우선한다. */
  aliases: ClientKeyNames;
  /**
   * 같은 이름이 붙는 키가 둘 이상인 이름들. 표에서 구분자를 붙여야 한다.
   * **매핑을 적용한 뒤의 최종 이름** 기준이다 — 서로 다른 두 키에 같은 별칭을 달면
   * 그것도 겹침으로 잡힌다.
   */
  ambiguousNames: Set<string>;
};

function indexKeys(keys: KeyMeta[] | undefined, aliases: ClientKeyNames): KeyIndex {
  const byId = new Map<string, KeyMeta>();
  for (const k of keys ?? []) byId.set(k.id, k);

  // 겹침 판정은 콘솔 목록과 매핑 파일의 **합집합**을 본다. 매핑에만 있는 id
  // (콘솔에서 지워진 키 등)도 이름을 차지하기 때문이다.
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

/** 비활성으로 볼 상태. Anthropic 은 archived, OpenAI 는 deleted 를 쓴다. */
const INACTIVE_STATUSES = new Set(["archived", "inactive", "deleted", "disabled"]);

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
 *   2. 벤더 콘솔에 등록된 키 이름
 *   3. 키 앞자리 (`apikey_01CUM5RW…`) — 위 둘 다 없을 때
 */
function describeKey(
  keyId: string,
  index: KeyIndex,
): Pick<BreakdownItem, "label" | "badge" | "hint" | "title"> {
  // 합성 행은 매핑 대상이 아니다 — 실제 키가 아니라 우리가 만든 자리다.
  if (keyId === CONSOLE_KEY_ID) return { label: "(콘솔 직접 사용)" };
  if (keyId === UNALLOCATED_KEY_ID) return { label: "(키 배분 불가)" };

  const alias = index.aliases[keyId];
  const meta = index.byId.get(keyId);
  const name = alias ?? meta?.name;

  // 3순위 — 매핑에도 콘솔 목록에도 없다 (삭제됐거나 다른 조직·프로젝트의 키).
  // 라벨을 앞자리로 두되, 매핑 파일에 적어 넣으려면 전체 id 가 필요하므로 툴팁에 남긴다.
  if (!name) {
    return { label: shortKeyId(keyId), badge: "미등록", title: keyId };
  }

  return {
    label: name,
    badge: meta && INACTIVE_STATUSES.has(meta.status) ? "비활성" : undefined,
    // 같은 이름의 키가 여럿이면 이름만으로는 어느 쪽인지 알 수 없다.
    hint: index.ambiguousNames.has(name)
      ? (meta?.partial_key_hint ?? shortKeyId(keyId))
      : undefined,
    title: keyId,
  };
}
