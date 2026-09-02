/**
 * 미니 위젯(/mini)이 1분마다 받아 가는 "오늘" 스냅샷.
 *
 * ── 모든 서비스의 "오늘" 이 같다 ──────────────────────────────────────────
 * **KST 오늘** (00:00 KST = 15:00 UTC). AI 벤더는 사용량을 1시간 버킷으로 주므로
 * 정확히 재구성된다. 예전에는 Vercel(미 태평양시)·Supabase(UTC)가 섞여 있어서
 * 줄마다 기준 배지를 달아야 했지만, AI API 만 다루기로 하면서 그 복잡도가 사라졌다.
 *
 * ── 오늘 비용은 추정치다 ──────────────────────────────────────────────────
 * 토큰은 실측이고 비용만 추정이다. 두 벤더 모두 비용 리포트가 UTC 하루 단위라
 * KST 오늘로 자를 수 없어서, 하루 캐시에서 역산해 둔 단가를 오늘 토큰에 곱한다.
 * 단가를 매 분 다시 구하지 않는 것이 핵심이다 — 그러면 분당 벤더 호출이 배로 뛴다.
 *
 * 서버 전용이다 (API 키·fs). 클라이언트에서 import 금지 — 타입은 lib/live-types.ts.
 */

import { buildDailyPoints, type UsageRow } from "@/lib/adapters/core";
import { loadClientKeyNames } from "@/lib/client-keys";
import {
  getDataSourceMode,
  getTodayUsage,
  getVendorDays,
  liveRefreshSeconds,
} from "@/lib/data-source";
import { buildKstToday } from "@/lib/kst-days";
import { kstDay, kstTime, kstTodayWindow } from "@/lib/kst";
import {
  COST_METRIC_KEY,
  type LiveEntry,
  type LiveGroup,
  type LiveMetricSpec,
  type LiveService,
  type LiveSnapshot,
} from "@/lib/live-types";
import {
  buildLocalLiveService,
  hasLocalService,
  localRefreshSeconds,
} from "@/lib/local/live";
import { enabledServices, type ServiceDefinition } from "@/lib/services";
import type { BreakdownItem, DailyPoint, MetricSpec } from "@/lib/types";

const COST_SPEC: LiveMetricSpec = {
  key: COST_METRIC_KEY,
  label: "비용",
  format: "usd",
  // 비용은 언제나 추정치다 (위 주석 참고). 화면에 ~ 가 붙는다.
  estimated: true,
};

/**
 * 무엇까지 담을지. `"local"` 은 **벤더를 아예 건드리지 않는다.**
 *
 * 미니 위젯이 로컬 세션만 자주 갱신할 때 쓴다 — 로컬 로그는 쿼터가 없어서 몇 초마다
 * 읽어도 공짜인데, 같은 요청에 벤더 조회가 딸려 오면 Admin API 시간당 90회를 태운다.
 */
export type LiveScope = "all" | "local";

export async function getLiveSnapshot(
  now: Date = new Date(),
  scope: LiveScope = "all",
): Promise<LiveSnapshot> {
  const mode = getDataSourceMode();

  const [vendors, local] = await Promise.all([
    scope === "local"
      ? Promise.resolve([])
      : Promise.all(enabledServices(mode).map((service) => guard(service, now))),
    // 로그가 없으면(배포 환경) 이 서비스는 아예 안 뜬다.
    hasLocalService() ? guardLocal(now).then((s) => [s]) : Promise.resolve([]),
  ]);

  return {
    updatedAt: now.toISOString(),
    kstDate: kstDay(now),
    kstTime: kstTime(now),
    source: mode,
    // 폴링 주기를 클라이언트가 정하면 서버 캐시 구간과 어긋난다. 서버가 정해 준다.
    refreshSeconds: liveRefreshSeconds(),
    localRefreshSeconds: localRefreshSeconds(),
    services: [...vendors, ...local],
  };
}

/**
 * 로컬 로그 읽기가 실패해도 벤더 줄은 계속 보여야 한다 (`guard` 와 같은 원칙).
 * 권한 문제·깨진 파일 하나로 미니 창 전체가 죽으면 안 된다.
 */
async function guardLocal(now: Date): Promise<LiveService> {
  try {
    return await buildLocalLiveService(now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[live] 로컬 세션 로그 읽기 실패", message);
    return {
      id: "cc",
      label: "Claude Code",
      date: "",
      boundary: "KST",
      boundaryNote: "",
      freshness: "",
      primaryMetric: COST_METRIC_KEY,
      metricSpecs: [COST_SPEC],
      groups: [],
      error: message,
    };
  }
}

/** 한 서비스가 죽어도 나머지 줄은 계속 보여야 한다 (getAllSeries 와 같은 원칙). */
async function guard(
  service: ServiceDefinition,
  now: Date,
): Promise<LiveService> {
  try {
    return await buildLiveService(service, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[live] ${service.id} 조회 실패`, message);
    return {
      id: service.id,
      label: service.label,
      date: "",
      boundary: "KST",
      boundaryNote: "",
      freshness: "",
      primaryMetric: COST_METRIC_KEY,
      metricSpecs: [COST_SPEC],
      groups: [],
      error: message,
    };
  }
}

/**
 * KST 오늘 = 1시간 버킷을 모은 것. 비용만 단가 역산으로 얹는다.
 *
 * 하루 버킷 하나를 만들어 **본문 대시보드와 똑같은 집계 함수**에 통과시킨다.
 * 모델별 집계·보조 축 비용 안분·키 이름 매핑이 전부 거기 있어서, 미니 위젯 전용
 * 집계 코드를 새로 쓰면 같은 로직이 두 벌이 되고 둘이 어긋나기 시작한다.
 */
async function buildLiveService(
  service: ServiceDefinition,
  now: Date,
): Promise<LiveService> {
  const window = kstTodayWindow(now);
  const mode = getDataSourceMode();
  const refreshSeconds = liveRefreshSeconds();

  const [daysFresh, clientKeyNames] = await Promise.all([
    getVendorDays(service.id),
    loadClientKeyNames(),
  ]);
  // 단가·키 목록은 하루 캐시에서 이미 나와 있다. 매 분 다시 구할 이유가 없다.
  const { days, rates, keys } = daysFresh.value;

  const today =
    mode === "mock"
      ? { value: mockTodayStandIn(days), at: Date.now(), stale: false as const }
      : await getTodayUsage(service.id, window.from, window.to);

  const build = { ...service.build, keys, clientKeyNames };
  const point = buildDailyPoints(
    [buildKstToday(window.date, today.value, rates)],
    build,
  )[0];

  /**
   * 선택창에는 **오늘 안 쓴 키·모델도** 떠야 한다. 지금 0 인 거래처를 골라 두고
   * 언제 쓰기 시작하는지 보는 게 이 위젯의 용도 중 하나이기 때문이다.
   * 그래서 조회 구간 전체에서 한 번이라도 등장한 항목을 0 으로 채워 붙인다.
   */
  const history = buildDailyPoints(days, build);
  const metricKeys = service.metricSpecs.map((m) => m.key);

  return {
    id: service.id,
    label: service.label,
    date: window.date,
    boundary: "KST",
    boundaryNote: `한국시간 ${window.date} 00:00 부터 지금까지 (매일 자정 리셋)`,
    freshness: today.stale
      ? `갱신 실패 — ${new Date(today.at).toISOString().slice(11, 16)}Z 값입니다. ` +
        `사유: ${today.reason ?? "알 수 없음"}`
      : `${refreshSeconds}초마다 갱신 · 토큰은 실측, 비용은 추정`,
    stale: today.stale,
    asOf: new Date(today.at).toISOString(),
    primaryMetric: service.primaryMetric,
    metricSpecs: [COST_SPEC, ...toLiveSpecs(service.metricSpecs)],
    unverified: service.unverified,
    groups: [
      totalGroup(point),
      {
        key: "model",
        label: `${service.breakdownLabel}별`,
        entries: withCatalog(entries(point?.items), catalog(history, "items"), metricKeys),
      },
      {
        key: "alt",
        label: `${service.altBreakdown.label}별`,
        entries: withCatalog(entries(point?.altItems), catalog(history, "altItems"), metricKeys),
      },
    ],
  };
}

/**
 * 목업 모드용. 목업에는 1시간 버킷이 없으니 **가장 최근 날짜**의 하루치를
 * "오늘" 인 척 쓴다. 화면 배치를 보려고 있는 경로라 정확도는 상관없다.
 */
function mockTodayStandIn(days: { usage: UsageRow[] }[]): UsageRow[] {
  return days[days.length - 1]?.usage ?? [];
}

// ---------------------------------------------------------------- 공통 변환

function toLiveSpecs(specs: MetricSpec[]): LiveMetricSpec[] {
  return specs.map((s) => ({
    key: s.key,
    label: s.label,
    format: s.format,
    unit: s.unit,
  }));
}

function totalGroup(point: DailyPoint | undefined): LiveGroup {
  return {
    key: "total",
    label: "전체",
    entries: [
      {
        id: "total",
        label: "전체",
        metrics: { ...(point?.metrics ?? {}), [COST_METRIC_KEY]: point?.costUsd ?? 0 },
      },
    ],
  };
}

function entries(items: BreakdownItem[] | undefined): LiveEntry[] {
  return (items ?? []).map((item) => ({
    id: item.key,
    label: item.label,
    hint: item.hint,
    badge: item.badge,
    metrics: { ...item.metrics, [COST_METRIC_KEY]: item.costUsd },
  }));
}

/** 조회 구간 전체에서 한 번이라도 등장한 항목 목록 (중복 제거, 라벨은 첫 등장 기준). */
function catalog(points: DailyPoint[], axis: "items" | "altItems"): LiveEntry[] {
  const seen = new Map<string, LiveEntry>();
  for (const p of points) {
    for (const item of p[axis] ?? []) {
      if (seen.has(item.key)) continue;
      seen.set(item.key, {
        id: item.key,
        label: item.label,
        hint: item.hint,
        badge: item.badge,
        metrics: {},
      });
    }
  }
  return [...seen.values()];
}

/**
 * 오늘 값이 있는 항목을 먼저, 오늘 0 인 항목을 뒤에 붙인다.
 *
 * 뒤쪽은 지표를 전부 0 으로 채운다 — `undefined` 로 두면 미니 창이 "—" 를 띄우는데,
 * "오늘 아직 안 씀" 과 "그런 항목이 없음" 은 다른 얘기다. $0.00 이라고 적어야 맞다.
 */
function withCatalog(
  today: LiveEntry[],
  all: LiveEntry[],
  metricKeys: string[],
): LiveEntry[] {
  const have = new Set(today.map((e) => e.id));
  const zeros = Object.fromEntries([
    [COST_METRIC_KEY, 0],
    ...metricKeys.map((k) => [k, 0] as const),
  ]);

  const idle = all
    .filter((e) => !have.has(e.id))
    .map((e) => ({ ...e, idle: true, metrics: { ...zeros } }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));

  return [...today, ...idle];
}
