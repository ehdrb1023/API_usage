/**
 * API 키 → **어느 배포 프로젝트에 들어가 있나** 를 찾는 대조 로직.
 *
 * 벤더 Admin API 는 키가 어디서 쓰이는지 알려 주지 않는다. 그래서 두 단계로 맞춘다.
 *
 *   1차 이름 대조 — 키 이름과 프로젝트 이름을 정규화해 비교한다. 팀이 키 이름을
 *                   프로젝트 이름에 맞춰 지어 왔으므로 대부분 여기서 잡힌다.
 *   2차 값 대조   — 프로젝트 환경변수 값을 벤더가 주는 힌트(`앞자리...뒤4자`)와 맞춘다.
 *                   1차로 찾은 프로젝트가 **정말 그 키를 쓰는지** 확인하는 용도이고,
 *                   이름이 전혀 다른 프로젝트에 들어간 키도 이걸로 잡힌다.
 *
 * ⚠️ 값 대조는 **읽을 수 있는 변수에서만** 된다. 호스팅이 "sensitive" 로 저장한 변수는
 *    API 로도 값을 돌려주지 않는다. 그때는 `sensitive` 로 표시하고 이름 대조만 믿는다.
 *
 * ⚠️ 여기에는 **키 원문이 들어오지 않는다.** 호출하는 쪽이 복호화 직후 `maskKey()` 로
 *    힌트와 같은 모양으로 줄여서 넘긴다. 캐시·디스크에 원문이 남지 않게 하려는 것이다.
 *
 * 벤더 중립 — 벤더 이름을 쓰지 않는다. 벤더별 차이(값 접두사·변수 이름)는
 * `KeyFamily` 로 받는다.
 */

/** 대조할 키 하나. */
export type KeySubject = {
  id: string;
  /** 벤더 콘솔의 키 이름 그대로 (표시용으로 가공하기 전). */
  name: string;
  /** 벤더가 주는 가린 값. 예: `sk-xxx-api03-R2D...igAA`, `sk-proj-*****abcd` */
  hint?: string | null;
};

/** 호스팅(배포) 프로젝트 하나. */
export type HostProject = {
  name: string;
  /** 사람이 알아볼 도메인. 커스텀 도메인이 앞에 온다. */
  domains: string[];
  vars: HostVar[];
};

export type HostVar = {
  key: string;
  /** "plain" | "encrypted" | "sensitive" … — 값을 못 읽는 타입인지 판단에 쓴다. */
  type: string;
  targets: string[];
  /** `maskKey()` 결과. 못 읽었거나 키 모양이 아니면 null. */
  masked: string | null;
};

/** 벤더별 차이. `lib/services.ts` 가 서비스마다 준다. */
export type KeyFamily = {
  /** 이 벤더 키 값의 접두사. 예: `sk-` */
  valuePrefix: string;
  /** 접두사가 같아도 이 벤더 키가 아닌 것. 다른 벤더 키·관리자 키. */
  excludePrefixes?: string[];
  /** 이 벤더 키가 담겼을 법한 변수 이름. 값을 못 읽을 때 "있긴 하다" 판단에 쓴다. */
  varName: RegExp;
};

/** 수동 지정. `config/key-locations.json` — 키 id 또는 키 이름 → 프로젝트 이름들. */
export type ManualLocations = Record<string, string[]>;

export type LocationBy = "manual" | "name" | "similar" | "value";

/**
 * 그 프로젝트에서 값 대조가 어떻게 됐나.
 *   match     — 변수 값이 이 키 힌트와 맞는다
 *   mismatch  — 같은 벤더 키가 들어 있는데 **다른 키**다
 *   sensitive — 벤더 키로 보이는 변수가 있지만 값을 못 읽는다
 *   none      — 벤더 키로 보이는 변수가 아예 없다
 */
export type ValueCheck = "match" | "mismatch" | "sensitive" | "none";

export type KeyLocation = {
  project: string;
  domains: string[];
  by: LocationBy;
  value: ValueCheck;
  /** 값이 맞은 변수 (match 일 때) 또는 대조한 변수. `이름 [대상]` 형식. */
  vars: string[];
};

export type KeyLocationResult = {
  locations: KeyLocation[];
  /** 못 찾은 이유 같은 한 줄. */
  note?: string;
};

// ---------------------------------------------------------------- 값 모양

/** 힌트 앞부분으로 남길 길이. 벤더 힌트(`sk-xxx-api03-R2D`)와 같은 길이. */
const MASK_HEAD = 16;
const MASK_TAIL = 4;

/**
 * 키 원문 → `앞16자...뒤4자`. **키 모양(`sk-`)이 아니면 null** — 키가 아닌 값은
 * 대조할 이유도, 들고 있을 이유도 없다.
 */
export function maskKey(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v.startsWith("sk-") || v.length < MASK_HEAD + MASK_TAIL + 4) return null;
  return `${v.slice(0, MASK_HEAD)}...${v.slice(-MASK_TAIL)}`;
}

/** `앞...뒤` / `앞*****뒤` 둘 다 받는다. */
function splitHint(hint: string): { head: string; tail: string } | null {
  const m = /^([^.*]*)(?:\.{3}|\*+)(.*)$/.exec(hint.trim());
  if (!m) return null;
  return { head: m[1], tail: m[2] };
}

/**
 * 힌트와 가린 값이 같은 키를 가리키나. 둘 다 앞·뒤 일부만 있으므로
 * **짧은 쪽 길이만큼** 앞뒤를 비교한다. 뒤 4자는 반드시 있어야 한다.
 */
export function hintMatches(hint: string, masked: string): boolean {
  const a = splitHint(hint);
  const b = splitHint(masked);
  if (!a || !b) return false;
  const tail = Math.min(a.tail.length, b.tail.length);
  if (tail < MASK_TAIL) return false;
  if (a.tail.slice(-tail) !== b.tail.slice(-tail)) return false;
  const head = Math.min(a.head.length, b.head.length);
  return a.head.slice(0, head) === b.head.slice(0, head);
}

/**
 * 힌트가 뒤 4자 + 공개 접두사뿐인가. 이 경우 값 대조는 1/65536 수준으로 겹칠 수 있어
 * 화면에 "뒤 4자 일치" 로 약하게 표시한다.
 */
export function isWeakHint(hint: string): boolean {
  const h = splitHint(hint);
  // `sk-proj-` 처럼 하이픈으로 끝나는 머리는 종류 표시일 뿐 키 내용이 아니다.
  return !!h && /^[a-z]+(-[a-z0-9]+)*-$/i.test(h.head);
}

function inFamily(masked: string, family: KeyFamily): boolean {
  if (!masked.startsWith(family.valuePrefix)) return false;
  return !(family.excludePrefixes ?? []).some((p) => masked.startsWith(p));
}

// ---------------------------------------------------------------- 이름

/** 이름 비교에서 무시할 조각. 키 용도 표시일 뿐 프로젝트 이름이 아니다. */
const NOISE = new Set(["my", "test", "key", "api", "prod", "dev", "stage", "staging"]);

/** 소문자 + 구분자(`.` `_` 공백)를 `-` 로. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[._\s/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 의미 있는 조각. 숫자 꼬리(`team2`, `bot-1`)와 잡음 단어를 뺀다. */
function coreTokens(s: string): string[] {
  return normalize(s)
    .split("-")
    .map((t) => t.replace(/\d+$/, ""))
    .filter((t) => t.length > 0 && !NOISE.has(t));
}

const compact = (s: string) => normalize(s).replace(/-/g, "");

/** 이름이 이보다 많은 프로젝트와 비슷하면 후보로 쓰지 않는다 — 추측이 된다. */
export const MAX_SIMILAR = 3;

type NameHit = { project: HostProject; by: "name" | "similar" };

function matchByName(name: string, projects: HostProject[]): { hits: NameHit[]; note?: string } {
  const key = compact(name);
  if (!key) return { hits: [] };

  const exact = projects.filter((p) => compact(p.name) === key);
  if (exact.length) return { hits: exact.map((project) => ({ project, by: "name" })) };

  const tokens = coreTokens(name);
  const core = tokens.join("");
  if (!core) return { hits: [] };
  const coreExact = projects.filter((p) => compact(p.name) === core);
  if (coreExact.length) return { hits: coreExact.map((project) => ({ project, by: "name" })) };

  const similar = projects.filter((p) => {
    const pTokens = normalize(p.name).split("-");
    // 조각이 전부 프로젝트 이름 조각에 있다 (`crm` → `speciai-crm`)
    if (tokens.every((t) => pTokens.includes(t))) return true;
    // 붙여 쓴 이름 (`teamai` → `team-ai-kr`). 짧은 조각은 우연히 겹치므로 4자 이상만.
    return core.length >= 4 && compact(p.name).includes(core);
  });
  if (similar.length > MAX_SIMILAR) {
    return {
      hits: [],
      note: `이름이 비슷한 프로젝트가 ${similar.length}개라 특정할 수 없습니다 — config/key-locations.json 에 지정하세요.`,
    };
  }
  return { hits: similar.map((project) => ({ project, by: "similar" })) };
}

// ---------------------------------------------------------------- 조립

function describeVar(v: HostVar): string {
  return v.targets.length ? `${v.key} [${v.targets.join(", ")}]` : v.key;
}

/** 이 프로젝트에서 이 키의 값 대조 결과. */
function checkValue(
  project: HostProject,
  hint: string | null | undefined,
  family: KeyFamily,
): { value: ValueCheck; vars: string[] } {
  if (hint) {
    const hit = project.vars.filter((v) => v.masked && hintMatches(hint, v.masked));
    if (hit.length) return { value: "match", vars: hit.map(describeVar) };
  }
  const readable = project.vars.filter((v) => v.masked && inFamily(v.masked, family));
  if (readable.length && hint) return { value: "mismatch", vars: readable.map(describeVar) };

  const named = project.vars.filter((v) => family.varName.test(v.key));
  const hidden = named.filter((v) => !v.masked);
  if (hidden.length) return { value: "sensitive", vars: hidden.map(describeVar) };
  return { value: "none", vars: [] };
}

const BY_ORDER: Record<LocationBy, number> = { value: 0, manual: 1, name: 2, similar: 3 };
const VALUE_ORDER: Record<ValueCheck, number> = { match: 0, sensitive: 1, none: 2, mismatch: 3 };

/**
 * 키마다 사용처를 찾는다. 결과의 키는 `KeySubject.id`.
 *
 * 우선순위: 수동 지정 > 이름 대조. 값 대조는 둘과 **별개로** 전 프로젝트를 훑는다 —
 * 이름으로 못 찾은 프로젝트에 키가 들어가 있으면 그것도 사용처다.
 */
export function locateKeys(
  subjects: KeySubject[],
  projects: HostProject[],
  family: KeyFamily,
  manual: ManualLocations = {},
): Record<string, KeyLocationResult> {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const out: Record<string, KeyLocationResult> = {};

  for (const s of subjects) {
    const found = new Map<string, KeyLocation>();
    const notes: string[] = [];
    const add = (project: HostProject, by: LocationBy) => {
      if (found.has(project.name)) return;
      found.set(project.name, {
        project: project.name,
        domains: project.domains,
        by,
        ...checkValue(project, s.hint, family),
      });
    };

    const pinned = manual[s.id] ?? manual[s.name];
    if (pinned) {
      for (const name of pinned) {
        const p = byName.get(name);
        if (p) add(p, "manual");
        else notes.push(`지정한 프로젝트 "${name}" 가 목록에 없습니다.`);
      }
    } else {
      const { hits, note } = matchByName(s.name, projects);
      for (const h of hits) add(h.project, h.by);
      if (note) notes.push(note);
    }

    if (s.hint) {
      for (const p of projects) {
        if (found.has(p.name)) continue;
        if (p.vars.some((v) => v.masked && hintMatches(s.hint!, v.masked))) add(p, "value");
      }
    }

    const locations = [...found.values()].sort(
      (a, b) =>
        VALUE_ORDER[a.value] - VALUE_ORDER[b.value] ||
        BY_ORDER[a.by] - BY_ORDER[b.by] ||
        a.project.localeCompare(b.project),
    );
    out[s.id] = {
      locations,
      note: notes.length ? notes.join(" ") : locations.length ? undefined : "일치하는 프로젝트가 없습니다.",
    };
  }
  return out;
}
