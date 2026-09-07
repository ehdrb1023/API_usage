/**
 * 보드 집계 — 로컬 로그를 codeburn 식 패널로 접는다.
 *
 * ── codeburn 과 축이 다르다. 일부러 다르다 ────────────────────────────────
 * codeburn 은 토큰을 **API 단가로 환산해 달러**를 보여준다. 정액권으로 쓰는
 * Claude Code 에는 그 금액이 존재하지 않는다 — 종량제 장부에 한 줄도 안 올라가고
 * (`docs/subscription-quota.md` 0절), 우리가 실제로 내는 돈도 아니다.
 * "$71.51 썼다" 는 **안 낸 돈**이다. 그래서 여기서는 달러를 쓰지 않는다.
 *
 * 대신 정액권에서 실제로 닳는 것을 축으로 쓴다 — **퍼센트와 토큰**.
 * 달러 축이 필요하면 그건 대시보드 본문(Admin API)이 이미 한다. 섞지 않는다.
 *
 * 순수 함수다. fs·네트워크 없음 — 스캔 결과를 받아서 접기만 한다.
 */

import { kstDayOf } from "@/lib/kst";
import type { LocalRow, ToolEvent } from "@/lib/local/scan";

export type Totals = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  calls: number;
};

export type Bucket = Totals & { key: string };

export type Board = {
  totals: Totals;
  sessions: number;
  /** 캐시읽기 / (캐시읽기 + 캐시생성 + 입력). 0~1. */
  cacheHitRate: number;
  /** KST 날짜별. 최신 우선. */
  daily: Bucket[];
  byProject: Bucket[];
  byModel: Bucket[];
  /** 도구 호출 수. 많은 순. */
  tools: Array<{ key: string; calls: number }>;
  /** Bash 명령 첫 낱말. 많은 순. */
  shell: Array<{ key: string; calls: number }>;
};

export function emptyTotals(): Totals {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
}

export function addRow(t: Totals, row: LocalRow): void {
  t.input += row.input;
  t.cacheRead += row.cacheRead;
  t.cacheWrite += row.cacheWrite5m + row.cacheWrite1h;
  t.output += row.output;
  t.calls += 1;
}

/** 캐시읽기 포함 총량. 한도가 이걸 어떻게 세는지는 모른다 (`quota-calibration.ts`). */
export function total(t: Totals): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

/** 캐시읽기 제외 총량. */
export function totalWithoutCache(t: Totals): number {
  return t.input + t.cacheWrite + t.output;
}

/**
 * `projects/-home-martin1023-API-usage` → `API-usage`.
 *
 * cwd 가 있으면 그쪽을 쓴다 — 세션 중간에 디렉토리를 옮겨도 마지막 자리가 맞다.
 * 둘 다 없으면 `(알 수 없음)` 으로 남긴다. 조용히 버리면 합계가 안 맞는다.
 */
export function projectLabel(row: LocalRow): string {
  const source = row.cwd || row.projectDir;
  if (!source) return "(알 수 없음)";
  const cleaned = source.replace(/[/-]+$/, "");
  const last = cleaned.split(/[/]/).pop() ?? cleaned;
  if (last && last !== cleaned) return last;
  // projectDir 형식(`-home-martin1023-API-usage`)은 슬래시가 없다.
  const parts = cleaned.split("-").filter(Boolean);
  return parts.length ? parts.slice(-1)[0] : cleaned;
}

export function buildBoard(rows: LocalRow[], tools: ToolEvent[]): Board {
  const totals = emptyTotals();
  const sessions = new Set<string>();
  const daily = new Map<string, Totals>();
  const byProject = new Map<string, Totals>();
  const byModel = new Map<string, Totals>();

  for (const row of rows) {
    addRow(totals, row);
    sessions.add(row.sessionId);
    bump(daily, kstDayOf(row.ts), row);
    bump(byProject, projectLabel(row), row);
    bump(byModel, row.model, row);
  }

  const toolCounts = new Map<string, number>();
  const shellCounts = new Map<string, number>();
  for (const t of tools) {
    toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + 1);
    if (t.command) shellCounts.set(t.command, (shellCounts.get(t.command) ?? 0) + 1);
  }

  const denominator = totals.cacheRead + totals.cacheWrite + totals.input;

  return {
    totals,
    sessions: sessions.size,
    cacheHitRate: denominator > 0 ? totals.cacheRead / denominator : 0,
    // 날짜는 최신 우선. 나머지는 쓴 양 순.
    daily: toBuckets(daily).sort((a, b) => b.key.localeCompare(a.key)),
    byProject: toBuckets(byProject).sort((a, b) => total(b) - total(a)),
    byModel: toBuckets(byModel).sort((a, b) => total(b) - total(a)),
    tools: countList(toolCounts),
    shell: countList(shellCounts),
  };
}

function bump(map: Map<string, Totals>, key: string, row: LocalRow): void {
  let t = map.get(key);
  if (!t) {
    t = emptyTotals();
    map.set(key, t);
  }
  addRow(t, row);
}

function toBuckets(map: Map<string, Totals>): Bucket[] {
  return [...map].map(([key, t]) => ({ key, ...t }));
}

function countList(map: Map<string, number>): Array<{ key: string; calls: number }> {
  return [...map]
    .map(([key, calls]) => ({ key, calls }))
    .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

/**
 * 구간 시작 시각. `today` 는 KST 자정이다 — 이 프로젝트의 하루 경계다
 * (`lib/kst.ts`, ADR-001). UTC 자정으로 자르면 오전 9시 이전 작업이 어제로 간다.
 */
export function rangeStart(range: string, now: Date = new Date()): string {
  const days = RANGES[range];
  if (days === undefined) {
    throw new Error(`알 수 없는 구간: ${range} (${Object.keys(RANGES).join("·")})`);
  }
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const kstMidnight = Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate(),
  );
  return new Date(kstMidnight - KST_OFFSET_MS - (days - 1) * 86_400_000).toISOString();
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const RANGES: Record<string, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
};
