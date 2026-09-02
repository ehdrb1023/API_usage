/**
 * `~/.claude/projects/**\/*.jsonl` — Claude Code 가 남기는 **로컬 세션 로그** 읽기.
 *
 * ── 이 파일이 왜 있나 ─────────────────────────────────────────────────────
 * 벤더 Admin API 에는 세션·프로젝트·디렉토리 축이 아예 없다. `usage_report` 가
 * 나눠 주는 축은 `model` · `api_key_id` · `workspace_id` 뿐이다. "지금 이 세션이
 * 얼마 쓰고 있나" 는 그 API 로는 원리적으로 답할 수 없고, 로컬 로그에만 있다.
 *
 * ── 두 가지 함정 ──────────────────────────────────────────────────────────
 * 1. **한 응답이 여러 줄로 쪼개져 기록된다.** content 블록(text·tool_use…) 수만큼
 *    줄이 생기고 **모든 줄이 같은 usage 를 통째로 갖는다.** 그대로 더하면 비용이
 *    2배 가까이 부풀려진다 (2026-08-31 실측: 23,344줄 → 유니크 12,007건, 중복 49%).
 *    그래서 `(message.id, requestId)` 로 중복을 없앤다.
 * 2. **로그가 크다** (실측 238MB / 131파일). 미니 위젯이 1분마다 폴링하는데 매번
 *    전부 읽으면 안 된다. 그래서 두 겹으로 줄인다 —
 *      · 파일 mtime 이 조회 구간보다 오래됐으면 **열지도 않는다**
 *      · 연 파일도 **지난번 읽은 바이트 다음부터만** 읽는다 (JSONL 은 append-only)
 *    그 결과 정상 상태에서는 "오늘 건드린 세션 파일의 새 줄" 만 읽는다.
 *
 * 서버 전용이다 (fs). 클라이언트에서 import 금지.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 사용량 한 건 = 실제 API 응답 하나. 중복 제거가 끝난 상태다. */
export type LocalRow = {
  /** UTC ISO. KST 하루로 접는 것은 부르는 쪽의 일이다. */
  ts: string;
  model: string;
  sessionId: string;
  /** 그 응답 시점의 작업 디렉토리. 세션 중간에 바뀔 수 있다. */
  cwd: string;
  /** 세션 파일이 들어 있던 `projects/<...>` 폴더 이름. 세션이 시작된 자리다. */
  projectDir: string;
  branch: string | null;
  /** 서브에이전트(Task) 안에서 일어난 호출. */
  sidechain: boolean;
  /** "standard" | "fast" — 단가가 다르다. */
  speed: string;
  /** "standard" | "batch" | "priority" */
  tier: string;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
};

export type ScanResult = {
  rows: LocalRow[];
  /** sessionId → Claude Code 가 붙인 세션 제목. 라벨로 쓴다. */
  titles: Map<string, string>;
  /** 이번에 실제로 연 파일 수 / 전체 파일 수. 진단용. */
  opened: number;
  total: number;
};

/**
 * 로그 위치. `.env` 의 `CLAUDE_PROJECTS_DIR` 로 바꿀 수 있다 —
 * 여러 대에서 쓰는 로그를 한 곳에 모아 두는 경우를 위해서다.
 */
export function projectsDir(): string {
  return (
    process.env.CLAUDE_PROJECTS_DIR ||
    path.join(os.homedir(), ".claude", "projects")
  );
}

/**
 * 로그가 있는가. 없으면 이 기능 전체가 조용히 꺼진다 (배포 환경에는 당연히 없다).
 *
 * ⚠️ `turbopackIgnore` 가 필요하다. 경로가 홈 디렉토리·환경변수에서 오는 **동적
 *    경로**라, 번들러가 무엇을 읽을지 정적으로 알 수 없어서 "그럼 프로젝트 전체를
 *    배포에 넣자" 로 판단한다 (실제로 빌드 경고가 났다). 여기서 읽는 경로는 언제나
 *    저장소 **바깥**이므로 추적할 것이 애초에 없다.
 */
export function hasLocalLogs(): boolean {
  return existsSync(/* turbopackIgnore: true */ projectsDir());
}

// ---------------------------------------------------------------- 파일별 캐시

type FileState = {
  /** 여기까지는 읽었다 (마지막 줄바꿈 다음 바이트). */
  offset: number;
  mtimeMs: number;
  /** 조회 구간 안에 드는 행만 남긴다. 구간 밖으로 밀려나면 버린다. */
  rows: LocalRow[];
  /** 이 파일 안에서 이미 본 `(message.id, requestId)`. 증분 읽기의 중복 방지용. */
  seen: Set<string>;
  titles: Map<string, string>;
};

/**
 * 모듈 수명 캐시. 요청마다 새로 만들면 증분 읽기의 의미가 없다.
 *
 * ⚠️ 무한정 자라지 않는다 — `rows` 는 매 스캔에서 조회 구간으로 다시 잘리고,
 *    구간에서 완전히 벗어난 파일은 캐시에서 지운다.
 */
const cache = new Map<string, FileState>();

/** 한 번에 통째로 읽을 상한. 이보다 큰 꼬리는 비정상이라 보고 건너뛴다. */
const MAX_TAIL_BYTES = 256 * 1024 * 1024;

/**
 * 조회 구간 안의 사용량 행을 모두 모은다.
 *
 * @param sinceIso 이 시각(UTC ISO) 이후의 행만 남긴다.
 */
export async function scanLocalUsage(sinceIso: string): Promise<ScanResult> {
  const root = projectsDir();
  const files = await listSessionFiles(root);

  // mtime 이 구간 시작보다 오래된 파일은 그 안의 모든 줄이 구간 밖이다 — 열지 않는다.
  const sinceMs = Date.parse(sinceIso);

  const rows: LocalRow[] = [];
  const titles = new Map<string, string>();
  let opened = 0;

  const live = new Set<string>();

  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue; // 스캔 도중 지워졌다 (/clear 등).
    }

    const cached = cache.get(file);

    // 캐시가 있으면 그 안에 구간 안의 행이 남아 있을 수 있으니 오래된 파일도 살려 둔다.
    if (stat.mtimeMs < sinceMs && !cached) continue;

    const state = await readIncrementally(file, stat, cached);
    if (!state) continue;
    if (state !== cached) opened += 1;

    // 구간 밖으로 밀려난 행을 버린다. 이것이 캐시가 무한히 자라지 않는 이유다.
    state.rows = state.rows.filter((r) => r.ts >= sinceIso);

    if (state.rows.length === 0 && stat.mtimeMs < sinceMs) {
      // 구간 안에 아무것도 없고 새로 쓰이지도 않는 파일 — 캐시에서 뺀다.
      cache.delete(file);
      continue;
    }

    cache.set(file, state);
    live.add(file);
    rows.push(...state.rows);
    for (const [k, v] of state.titles) titles.set(k, v);
  }

  // 사라진 파일의 캐시를 정리한다.
  for (const key of cache.keys()) {
    if (!live.has(key)) cache.delete(key);
  }

  /**
   * 파일을 넘나드는 중복까지 한 번 더 거른다.
   *
   * 실측(2026-08-31, 131파일)에서는 중복이 **전부 같은 파일 안**이었지만, 세션을
   * 이어받는 경로(`--resume`·compaction)가 과거 줄을 새 파일로 옮겨 적을 수 있다.
   * 그때 두 번 세면 그대로 비용이 두 배가 되므로, 싼 값에 한 겹 더 둔다.
   */
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const k = `${r.sessionId}|${r.ts}|${r.model}|${r.output}|${r.cacheRead}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a, b) => a.ts.localeCompare(b.ts));

  return { rows: deduped, titles, opened, total: files.length };
}

/** `projects/<bucket>/<sessionId>.jsonl` 을 전부 찾는다. 깊이 2 고정이라 재귀가 필요 없다. */
async function listSessionFiles(root: string): Promise<string[]> {
  let buckets: string[];
  try {
    buckets = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // 로그 폴더가 없다 — 배포 환경이면 정상이다.
  }

  const out: string[] = [];
  for (const bucket of buckets) {
    const dir = path.join(root, bucket);
    try {
      for (const entry of await fs.readdir(dir)) {
        if (entry.endsWith(".jsonl")) out.push(path.join(dir, entry));
      }
    } catch {
      /* 폴더 하나 못 읽는다고 전체를 포기하지 않는다. */
    }
  }
  return out;
}

/**
 * 지난번 읽은 바이트 다음부터만 읽는다.
 *
 * ⚠️ 마지막 줄바꿈까지만 소비한다. JSONL 에 **아직 쓰이는 중인 줄**이 걸리면
 *    깨진 JSON 을 파싱하게 되는데, 그 줄은 다음 스캔에서 온전하게 다시 읽힌다.
 */
async function readIncrementally(
  file: string,
  stat: { size: number; mtimeMs: number },
  cached: FileState | undefined,
): Promise<FileState | null> {
  // 크기도 mtime 도 그대로면 새로 쓰인 게 없다.
  if (cached && cached.offset === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }

  // 파일이 줄어들었다 = 잘렸거나 새로 쓰였다. 처음부터 다시 읽는다.
  const reset = !cached || stat.size < cached.offset;
  const state: FileState = reset
    ? { offset: 0, mtimeMs: stat.mtimeMs, rows: [], seen: new Set(), titles: new Map() }
    : { ...cached, mtimeMs: stat.mtimeMs };

  const length = stat.size - state.offset;
  if (length <= 0) return state;
  if (length > MAX_TAIL_BYTES) {
    console.warn(`[local/scan] ${file} 의 새 구간이 너무 큽니다 (${length}B) — 건너뜁니다.`);
    return state;
  }

  let text: string;
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, state.offset);
    text = buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }

  const cut = text.lastIndexOf("\n");
  if (cut === -1) return state; // 아직 온전한 줄이 없다.

  const complete = text.slice(0, cut + 1);
  state.offset += Buffer.byteLength(complete, "utf8");

  const projectDir = path.basename(path.dirname(file));
  for (const line of complete.split("\n")) {
    if (!line) continue;
    absorb(line, projectDir, state);
  }

  return state;
}

/** 줄 하나를 해석해 상태에 반영한다. 관심 없는 줄은 JSON 파싱조차 하지 않는다. */
function absorb(line: string, projectDir: string, state: FileState): void {
  // 대부분의 줄(user·tool 결과·파일 스냅샷)은 여기서 걸러진다. 238MB 를 감당하는 힘이다.
  const isUsage = line.includes('"usage"');
  const isTitle = line.includes('"ai-title"');
  if (!isUsage && !isTitle) return;

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return; // 쓰이는 중이었거나 깨진 줄. 다음 스캔에서 다시 만난다.
  }

  if (o.type === "ai-title") {
    const id = o.sessionId;
    const title = o.aiTitle;
    if (typeof id === "string" && typeof title === "string") state.titles.set(id, title);
    return;
  }

  if (o.type !== "assistant") return;

  const message = o.message as
    | { id?: unknown; model?: unknown; usage?: Record<string, unknown> }
    | undefined;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return;

  const model = message?.model;
  // `<synthetic>` 은 API 를 부르지 않은 로컬 메시지다. 토큰도 비용도 없다.
  if (typeof model !== "string" || model.startsWith("<")) return;

  const ts = o.timestamp;
  const sessionId = o.sessionId;
  if (typeof ts !== "string" || typeof sessionId !== "string") return;

  // ★ 중복 제거. 한 응답이 content 블록 수만큼 줄로 쪼개져 있고 usage 는 전부 같다.
  const key = `${String(message?.id ?? "")}|${String(o.requestId ?? "")}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);

  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  // `cache_creation` 세부가 없는 옛 줄은 전부 5분 TTL 로 본다 (기본값이 5분이다).
  const legacyWrite = num(usage.cache_creation_input_tokens);
  const write5m = creation ? num(creation.ephemeral_5m_input_tokens) : legacyWrite;
  const write1h = creation ? num(creation.ephemeral_1h_input_tokens) : 0;

  state.rows.push({
    ts,
    model,
    sessionId,
    cwd: typeof o.cwd === "string" ? o.cwd : "",
    projectDir,
    branch: typeof o.gitBranch === "string" && o.gitBranch ? o.gitBranch : null,
    sidechain: o.isSidechain === true,
    speed: typeof usage.speed === "string" ? usage.speed : "standard",
    tier: typeof usage.service_tier === "string" ? usage.service_tier : "standard",
    // Anthropic 의 `input_tokens` 는 캐시 읽기·생성을 **뺀** 값이다 (벤더 탭과 뜻이 같다).
    input: num(usage.input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    output: num(usage.output_tokens),
  });
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 테스트·진단용. 캐시를 비운다. */
export function resetScanCache(): void {
  cache.clear();
}
