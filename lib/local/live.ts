/**
 * 로컬 세션 로그 → 미니 위젯이 보는 **"오늘"(KST) 스냅샷**.
 *
 * ── 이 서비스만 축이 여러 개다 ────────────────────────────────────────────
 * Claude·GPT 탭은 축이 둘이다 (모델 / API 키). 로컬 로그는 한 줄마다 세션·작업
 * 디렉토리·git 저장소·브랜치가 전부 붙어 있어서, 같은 하루를 여섯 가지로 쪼갤 수 있다.
 *
 *   세션      "지금 이 세션이 얼마 쓰고 있나" — 이 기능을 만든 이유
 *   프로젝트  Claude Code 가 세션을 묶어 두는 단위 (세션을 시작한 자리)
 *   저장소    cwd 에서 위로 올라가며 찾은 git 루트. 모노레포의 여러 앱이 하나로 묶인다
 *   디렉토리  그 응답 시점의 cwd 그대로
 *   브랜치    gitBranch
 *   모델      벤더 탭과 같은 축
 *
 * 미니 위젯·선택창은 `LiveGroup[]` 을 그냥 훑어 그리므로 화면 코드는 손대지 않는다.
 *
 * ── 숫자의 성격 ───────────────────────────────────────────────────────────
 * **토큰은 실측, 비용은 환산치다.** 로그에 금액이 없어서 공개 단가표를 곱한다
 * (`lib/local/pricing.ts`). 구독(Pro·Max)으로 쓰는 중이라면 실제로는 과금되지
 * 않는 금액이고, "같은 토큰을 API 로 썼다면 얼마" 라는 뜻이다.
 *
 * 서버 전용 (fs). 클라이언트에서 import 금지 — 타입은 lib/live-types.ts.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { kstDayStart, kstTodayWindow } from "@/lib/kst";
import {
  COST_METRIC_KEY,
  type LiveEntry,
  type LiveGroup,
  type LiveMetricSpec,
  type LiveService,
} from "@/lib/live-types";
import { CHECKED_ON, costOf, priceOf } from "@/lib/local/pricing";
import { hasLocalLogs, scanLocalUsage, type LocalRow } from "@/lib/local/scan";

/** 벤더가 아니라 "이 컴퓨터의 Claude Code" 라서 별도 id 를 쓴다. */
export const LOCAL_SERVICE_ID = "cc" as const;

const METRICS: LiveMetricSpec[] = [
  { key: COST_METRIC_KEY, label: "비용", format: "usd", estimated: true },
  { key: "totalTokens", label: "총 토큰", format: "tokens" },
  { key: "inputTokens", label: "입력", format: "tokens" },
  { key: "cacheReadTokens", label: "캐시 읽기", format: "tokens" },
  { key: "cacheWriteTokens", label: "캐시 생성", format: "tokens" },
  { key: "outputTokens", label: "출력", format: "tokens" },
  { key: "requests", label: "요청", format: "count" },
];

const PRIMARY_METRIC = "totalTokens";

/** 이 기능을 켤 수 있는가. 로그 폴더가 없으면(배포 환경) 조용히 꺼진다. */
export function hasLocalService(): boolean {
  return hasLocalLogs();
}

/**
 * 로컬 스캔 주기(초). 벤더와 **따로** 두는 이유는 쿼터가 없기 때문이다 —
 * Admin API 는 시간당 90회라 60초가 한계지만, 로컬 파일은 몇 초마다 읽어도 공짜다.
 * "지금 얼마 쓰고 있나" 는 1분 지연이면 실시간이라고 하기 어렵다.
 */
export function localRefreshSeconds(): number {
  const raw = Number(process.env.LOCAL_REFRESH_SECONDS);
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : 10;
}

/**
 * KST 오늘의 로컬 사용량.
 *
 * 스캔 구간은 **어제 자정부터**다. 오늘치만 필요하지만, 자정 직후에 구간을 오늘로만
 * 잡으면 캐시가 통째로 비워졌다가 다시 채워지면서 파일을 전부 다시 열게 된다.
 * 하루치 여유를 두면 그 재읽기가 사라진다 (구간 밖 행은 집계에서 뺀다).
 */
export async function buildLocalLiveService(now: Date = new Date()): Promise<LiveService> {
  const window = kstTodayWindow(now);
  const scanFrom = new Date(kstDayStart(window.date).getTime() - 24 * 60 * 60 * 1000);

  const { rows, titles } = await scanLocalUsage(scanFrom.toISOString());
  const today = rows.filter((r) => r.ts >= window.from);

  const unpriced = new Set<string>();
  for (const r of today) if (!priceOf(r.model, r.speed)) unpriced.add(r.model);

  return {
    id: LOCAL_SERVICE_ID,
    label: "Claude Code",
    date: window.date,
    boundary: "KST",
    boundaryNote: `한국시간 ${window.date} 00:00 부터 지금까지 (매일 자정 리셋)`,
    freshness:
      `${localRefreshSeconds()}초마다 로컬 로그를 다시 읽습니다 · ` +
      `토큰은 실측, 비용은 ${CHECKED_ON} 기준 공개 단가표로 환산한 값입니다`,
    asOf: now.toISOString(),
    primaryMetric: PRIMARY_METRIC,
    metricSpecs: METRICS,
    unverified: unpriced.size
      ? `단가표에 없는 모델이 있어 그 몫은 비용 0 으로 빠져 있습니다: ${[...unpriced].join(", ")}. ` +
        "lib/local/pricing.ts 에 추가하세요."
      : undefined,
    groups: buildGroups(today, titles, now),
  };
}

// ---------------------------------------------------------------- 축별 집계

function buildGroups(
  rows: LocalRow[],
  titles: Map<string, string>,
  now: Date,
): LiveGroup[] {
  const sessions = groupBy(rows, (r) => r.sessionId);

  return [
    {
      key: "total",
      label: "전체",
      entries: [{ ...toEntry("total", "전체", rows), label: "전체" }],
    },
    { key: "session", label: "세션별", entries: sessionEntries(rows, sessions, titles, now) },
    {
      key: "project",
      label: "프로젝트별",
      entries: axisEntries(rows, "project", (r) => r.projectDir, {
        // 폴더 이름(`-home-martin1023-Speciai-lawsync`)은 되돌릴 수 없다 —
        // 이름에 원래 있던 하이픈과 경로 구분자가 구별되지 않기 때문이다.
        // 그래서 라벨은 그 안의 **가장 짧은 cwd** 에서 뽑는다.
        label: (rs) => path.basename(shortestCwd(rs)) || rs[0].projectDir,
        title: (rs) => shortestCwd(rs) || rs[0].projectDir,
      }),
    },
    {
      key: "repo",
      label: "저장소별",
      entries: axisEntries(rows, "repo", (r) => repoRootOf(r.cwd) ?? NO_GIT, {
        label: (rs, key) => (key === NO_GIT ? "(git 저장소 아님)" : path.basename(key)),
        title: (_rs, key) => (key === NO_GIT ? undefined : key),
      }),
    },
    {
      key: "dir",
      label: "디렉토리별",
      entries: axisEntries(rows, "dir", (r) => r.cwd || "(미상)", {
        label: (_rs, key) => shortenPath(key),
        title: (_rs, key) => key,
      }),
    },
    {
      key: "branch",
      label: "브랜치별",
      entries: axisEntries(rows, "branch", (r) => r.branch ?? "(브랜치 없음)", {
        label: (_rs, key) => key,
      }),
    },
    {
      key: "model",
      label: "모델별",
      entries: axisEntries(rows, "model", (r) => r.model, {
        label: (_rs, key) => key,
        badge: (rs, key) => (priceOf(key, rs[0].speed) ? undefined : "단가 미상"),
      }),
    },
  ];
}

const NO_GIT = "__nogit__";

/**
 * 세션 축. 다른 축과 달리 **"지금 활성 세션"** 이라는 고정 항목이 앞에 붙는다.
 *
 * 세션 id 는 매번 새로 생기므로 `session:<uuid>` 줄을 미니 창에 걸어 두면 내일은
 * 빈 줄이 된다. `session:active` 는 스냅샷을 만들 때마다 **가장 최근에 응답이 있었던
 * 세션**으로 다시 붙으므로, 한 번 걸어 두면 계속 "지금 쓰는 세션" 을 가리킨다.
 */
function sessionEntries(
  all: LocalRow[],
  sessions: Map<string, LocalRow[]>,
  titles: Map<string, string>,
  now: Date,
): LiveEntry[] {
  const named = (id: string) => titles.get(id) ?? `세션 ${id.slice(0, 8)}`;

  const entries = [...sessions.entries()]
    .map(([id, rs]) => ({
      ...toEntry(`session:${id}`, named(id), rs),
      hint: `${path.basename(shortestCwd(rs))} · ${agoLabel(lastTs(rs), now)}`,
      title: id,
    }))
    .sort((a, b) => b.metrics[COST_METRIC_KEY] - a.metrics[COST_METRIC_KEY]);

  if (all.length === 0) return entries;

  // 가장 최근 응답이 있었던 세션 = 지금 쓰고 있는 세션.
  const latest = all.reduce((a, b) => (a.ts >= b.ts ? a : b));
  const rows = sessions.get(latest.sessionId) ?? [];

  const active: LiveEntry = {
    ...toEntry("session:active", `지금 세션 · ${named(latest.sessionId)}`, rows),
    hint: `${path.basename(shortestCwd(rows))} · ${agoLabel(latest.ts, now)}`,
    title: latest.sessionId,
  };

  return [active, ...entries];
}

type AxisLabels = {
  label: (rows: LocalRow[], key: string) => string;
  title?: (rows: LocalRow[], key: string) => string | undefined;
  badge?: (rows: LocalRow[], key: string) => string | undefined;
};

function axisEntries(
  rows: LocalRow[],
  prefix: string,
  pick: (row: LocalRow) => string,
  labels: AxisLabels,
): LiveEntry[] {
  const entries = [...groupBy(rows, pick).entries()]
    .map(([key, rs]) => ({
      ...toEntry(`${prefix}:${key}`, labels.label(rs, key), rs),
      title: labels.title?.(rs, key),
      badge: labels.badge?.(rs, key),
    }))
    .sort((a, b) => b.metrics[COST_METRIC_KEY] - a.metrics[COST_METRIC_KEY]);

  return disambiguate(entries);
}

/**
 * 라벨이 겹치는 항목에 상위 경로를 붙여 구분한다.
 *
 * 라벨을 경로의 마지막 칸으로 줄이기 때문에 생기는 문제다. 실제로 겹친다 —
 * 중첩 git 저장소(`~/yulam` 안에 `~/yulam/yulam`)는 둘 다 라벨이 "yulam" 이 되고,
 * 모노레포의 `apps/web` 은 저장소가 달라도 전부 "web" 이 된다. 그대로 두면 표에
 * 같은 이름이 두 줄 뜨고 **어느 쪽이 어느 것인지 알 방법이 없다.**
 */
function disambiguate(entries: LiveEntry[]): LiveEntry[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);

  return entries.map((e) =>
    (counts.get(e.label) ?? 0) > 1 && e.title
      ? { ...e, hint: shortenPath(path.dirname(e.title)) }
      : e,
  );
}

/** 행 묶음 하나를 지표로 접는다. 모든 축이 이 함수를 지나므로 합계가 어긋날 수 없다. */
function toEntry(id: string, label: string, rows: LocalRow[]): LiveEntry {
  let cost = 0;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;

  for (const r of rows) {
    cost += costOf(r, r.model, r.speed, r.tier);
    input += r.input;
    cacheRead += r.cacheRead;
    // 화면에는 5분/1시간을 "캐시 생성" 한 줄로 합친다. 단가는 위에서 이미
    // 따로 곱한 뒤라, 여기서 합쳐도 비용이 뭉개지지 않는다.
    cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
    output += r.output;
  }

  return {
    id,
    label,
    metrics: {
      [COST_METRIC_KEY]: cost,
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      totalTokens: input + cacheRead + cacheWrite + output,
      requests: rows.length,
    },
  };
}

// ---------------------------------------------------------------- 잡일

function groupBy(
  rows: LocalRow[],
  pick: (row: LocalRow) => string,
): Map<string, LocalRow[]> {
  const out = new Map<string, LocalRow[]>();
  for (const r of rows) {
    const k = pick(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function lastTs(rows: LocalRow[]): string {
  return rows.reduce((a, b) => (a >= b.ts ? a : b.ts), "");
}

/** 같은 묶음 안에서 가장 위쪽 디렉토리. 프로젝트·세션의 대표 경로로 쓴다. */
function shortestCwd(rows: LocalRow[]): string {
  let best = "";
  for (const r of rows) {
    if (!r.cwd) continue;
    if (!best || r.cwd.length < best.length) best = r.cwd;
  }
  return best;
}

/** `/home/me/Speciai/lawsync/apps/web` → `lawsync/apps/web` (뒤 3칸). */
function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 3 ? p : `…/${parts.slice(-3).join("/")}`;
}

function agoLabel(iso: string, now: Date): string {
  const min = Math.floor((now.getTime() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(min) || min < 0) return "방금";
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  return `${Math.floor(min / 60)}시간 전`;
}

/**
 * cwd 에서 위로 올라가며 `.git` 을 찾는다. 결과를 캐시하는 이유는 이 함수가
 * 행마다 불리기 때문이다 — 서로 다른 cwd 는 많아야 수십 개다.
 *
 * cwd 가 이미 지워졌으면 못 찾고 null 이 된다. 그 몫은 "(git 저장소 아님)" 으로 묶인다.
 */
const repoCache = new Map<string, string | null>();

function repoRootOf(cwd: string): string | null {
  if (!cwd) return null;
  const hit = repoCache.get(cwd);
  if (hit !== undefined) return hit;

  let dir = cwd;
  let found: string | null = null;
  // 루트(`/`)에 닿으면 path.dirname 이 자기 자신을 돌려주므로 그때 멈춘다.
  for (;;) {
    // turbopackIgnore: 저장소 바깥의 동적 경로다 (lib/local/scan.ts 의 같은 주석 참고).
    if (existsSync(/* turbopackIgnore: true */ path.join(dir, ".git"))) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  repoCache.set(cwd, found);
  return found;
}
