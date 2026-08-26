import { promises as fs } from "node:fs";
import path from "node:path";

import { unstable_cache } from "next/cache";

import { buildDailyPoints, type UsageRow } from "@/lib/adapters/core";
import { loadClientKeyNames } from "@/lib/client-keys";
import { kstCacheKey } from "@/lib/kst";
import { computeRates } from "@/lib/token-rates";
import {
  SERVICES,
  enabledServices,
  getService,
  type ServiceDefinition,
  type VendorDays,
} from "@/lib/services";
import type { DayBoundary, ServiceId, ServiceSeries } from "@/lib/types";
import { createStaleFallback, type Fresh } from "@/lib/vendor-fallback";

/**
 * ★ 목업 ↔ 실제 API 스위치는 여기 한 곳뿐이다.
 *
 *   .env 의  DATA_SOURCE=mock   → mock/*.json 을 읽는다 (기본값)
 *            DATA_SOURCE=api    → 실제 API 를 호출한다
 *
 * 어느 쪽이든 같은 어댑터를 타고 같은 ServiceSeries 가 나오므로, 화면 코드는
 * 전혀 손대지 않아도 된다. 목업 파일이 실제 응답 스키마 그대로 생겼기 때문에
 * 가능한 구조다.
 *
 * 서버에서만 실행된다 (fs 접근 + API 키). 클라이언트 컴포넌트에서 import 금지.
 *
 * ── 이 파일이 하는 일 / 하지 않는 일 ──────────────────────────────────────
 *   한다   목업·실API 분기, 캐시, 실패 격리, ServiceSeries 조립
 *   안 한다 벤더별 조회 파라미터(→ lib/services.ts), 집계(→ lib/adapters/core.ts),
 *          KST 접기(→ lib/kst-days.ts), 단가 역산(→ lib/token-rates.ts)
 */

export type DataSourceMode = "mock" | "api";

export function getDataSourceMode(): DataSourceMode {
  return process.env.DATA_SOURCE === "api" ? "api" : "mock";
}

/**
 * 일 경계는 **모든 AI 벤더가 KST 하나**다. 예전처럼 서비스마다 다르지 않다 —
 * 배경은 `lib/types.ts` 의 `DayBoundary` 주석 참고.
 */
const KST_BOUNDARY: DayBoundary = {
  label: "KST",
  note:
    "하루는 한국시간 자정 기준입니다. 벤더 원본은 UTC 자정 기준이지만, " +
    "1시간 버킷을 KST 자정(= UTC 15:00 정각)에 맞춰 다시 합쳤습니다.",
};

// ---------------------------------------------------------------- 진입점

export async function getServiceSeries(id: ServiceId): Promise<ServiceSeries> {
  const service = getService(id);
  const mode = getDataSourceMode();

  const [days, clientKeyNames] = await Promise.all([
    mode === "mock" ? readMockDays(service) : (await getVendorDays(id)).value,
    loadClientKeyNames(),
  ]);

  return {
    service: service.id,
    label: service.label,
    breakdownLabel: service.breakdownLabel,
    dayBoundary: KST_BOUNDARY,
    primaryMetric: service.primaryMetric,
    metricSpecs: service.metricSpecs,
    points: buildDailyPoints(days.days, {
      ...service.build,
      keys: days.keys,
      clientKeyNames,
    }),
    source: mode,
    note: composeNote(service, mode),
    altBreakdown: service.altBreakdown,
  };
}

/**
 * 한 서비스가 죽어도 나머지 탭은 살린다.
 *
 * `Promise.all` 은 하나만 던져도 전부 날린다. 대신 실패한 서비스는
 * **빈 탭 + 사유** 로 남긴다 — 탭을 통째로 감추면 "왜 없지" 가 되고,
 * 페이지를 죽이면 멀쩡한 나머지도 못 본다.
 *
 * 전부 실패하면 그대로 던진다. 그때는 app/page.tsx 의 에러 화면이 사유를 보여준다.
 */
export async function getAllSeries(): Promise<ServiceSeries[]> {
  const mode = getDataSourceMode();
  const services = enabledServices(mode);

  if (services.length === 0) {
    throw new Error(
      "표시할 서비스가 없습니다. .env 에 ANTHROPIC_ADMIN_KEY 또는 OPENAI_ADMIN_KEY 를 " +
        "넣거나, DATA_SOURCE=mock 으로 되돌려 목업으로 확인하세요.",
    );
  }

  const results = await Promise.all(
    services.map(async (service) => {
      try {
        return await getServiceSeries(service.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[data-source] ${service.id} 조회 실패 — 빈 탭으로 표시합니다.`, message);
        return { service, error: message };
      }
    }),
  );

  const failures = results.filter(
    (r): r is { service: ServiceDefinition; error: string } => "error" in r,
  );
  if (failures.length === services.length) {
    throw new Error(failures.map((f) => `[${f.service.id}] ${f.error}`).join("\n\n"));
  }

  return results.map((r) => ("error" in r ? emptySeries(r.service, r.error) : r));
}

/** 조회에 실패한 서비스의 자리. 지표 정의가 없으므로 표·차트는 비어 있고 사유만 뜬다. */
function emptySeries(service: ServiceDefinition, error: string): ServiceSeries {
  return {
    service: service.id,
    label: service.label,
    breakdownLabel: service.breakdownLabel,
    dayBoundary: KST_BOUNDARY,
    primaryMetric: service.primaryMetric,
    metricSpecs: [],
    points: [],
    source: getDataSourceMode(),
    note: `${service.label} 데이터를 불러오지 못했습니다.\n${error}`,
  };
}

/** 화면 하단 각주. 미검증 벤더면 그 경고를 **맨 앞에** 둔다. */
function composeNote(service: ServiceDefinition, mode: DataSourceMode): string {
  const parts = [
    service.unverified,
    mode === "mock"
      ? "목업 데이터입니다. 실제 API 연동 시 필드명 확인 필요."
      : service.apiNote,
  ];
  return parts.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- 목업

async function readMockDays(service: ServiceDefinition): Promise<VendorDays> {
  const file = path.join(process.cwd(), "mock", service.mockFile);
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  const days = service.mockToDays(raw);

  // 목업은 벤더 실측 비용을 그대로 갖고 있으므로 단가도 거기서 뽑으면 된다.
  // 미니 위젯이 "오늘" 을 다시 계산할 때 이 단가를 쓴다.
  return { days, rates: computeRates(days), keys: mockKeys(raw) };
}

/** 목업 파일이 키·프로젝트 목록을 함께 담고 있으면 꺼낸다. 없으면 빈 목록. */
function mockKeys(raw: unknown): VendorDays["keys"] {
  const obj = raw as { api_keys?: VendorDays["keys"]; projects?: VendorDays["keys"] };
  return obj?.api_keys ?? obj?.projects ?? [];
}

// ---------------------------------------------------------------- 캐시

/**
 * ⚠️ 캐시 키가 **KST 날짜**다. 화면의 하루가 KST 이니 갱신도 KST 자정에 일어나야
 *    한다. UTC 자정(= KST 오전 9시)에 맞춰 두면 새 날짜의 첫 9시간이 어제 캐시에
 *    갇힌다. `revalidate` 는 날짜가 안 바뀌는 동안의 상한선일 뿐이다.
 *
 * ⚠️ 캐싱 범위를 **벤더 API 호출로만** 좁힌 것도 의도적이다. 페이지 전체를 캐싱하면
 *    `config/client-keys.json` 을 고쳐도 하루 동안 반영되지 않는다. 그 파일은
 *    "저장하고 새로고침하면 바로 보인다" 가 전제다. 무거운 건 어차피 네트워크다.
 *
 * ⚠️ 캐시에 들어가는 값은 **KST 하루로 접은 결과**다. 원본 1시간 버킷을 그대로
 *    넣으면 구간이 길어질수록 `unstable_cache` 의 2MB 제한에 걸린다.
 *    (실제로 Vercel charge 24.5MB 로 겪었던 문제다 — 원본을 캐싱할 이유가 없다.)
 */
const DAY_SECONDS = 24 * 60 * 60;

/**
 * 서비스별 캐시 함수. 레지스트리를 돌며 **모듈 로드 시 한 번** 만든다 —
 * 요청마다 `unstable_cache` 를 새로 부르면 캐시가 매번 새로 잡힌다.
 */
const daysCache = new Map<ServiceId, (kstDay: string) => Promise<VendorDays>>(
  SERVICES.map((service) => [
    service.id,
    unstable_cache(
      async (_kstDay: string) => service.fetchDays(),
      [`vendor-days:${service.id}`],
      { revalidate: DAY_SECONDS, tags: ["usage", `usage:${service.id}`] },
    ),
  ]),
);

/** 실패해도 직전 값을 계속 내보낸다. 429 면 `retry-after` 동안 아예 안 두드린다. */
const daysFallback = new Map<ServiceId, ReturnType<typeof createStaleFallback<VendorDays>>>(
  SERVICES.map((s) => [s.id, createStaleFallback<VendorDays>()]),
);
const todayFallback = new Map<ServiceId, ReturnType<typeof createStaleFallback<UsageRow[]>>>(
  SERVICES.map((s) => [s.id, createStaleFallback<UsageRow[]>()]),
);

/**
 * KST 하루로 재구성한 사용량 + 역산한 단가 + 키 목록.
 * 하루 캐시를 대시보드와 미니 위젯이 함께 쓴다 — 미니 위젯은 단가·키 목록만 꺼내
 * "KST 오늘" 에 다시 곱한다.
 */
export async function getVendorDays(id: ServiceId): Promise<Fresh<VendorDays>> {
  if (getDataSourceMode() === "mock") {
    const value = await readMockDays(getService(id));
    return { value, at: Date.now(), stale: false };
  }
  return daysFallback.get(id)!(() => daysCache.get(id)!(kstCacheKey()));
}

// ---------------------------------------------------------------- 실시간(KST)

/**
 * 실시간 갱신 주기(초). `.env` 의 `LIVE_REFRESH_SECONDS` 로 조절한다.
 *
 * ⚠️ 기본값 60초는 **한도에 가깝다.** Anthropic Admin API 는 시간당 90회인데
 *    60초 주기면 60회/시간을 쓴다. 같은 조직 키로 도는 인스턴스가 둘이면(로컬 개발
 *    서버 + 배포본) 넘긴다. 그럴 때는 120 이상으로 올리는 게 맞다.
 *    30초 미만은 받지 않는다 — 벤더가 그만큼 자주 갱신해 주지도 않는다.
 *
 * ⚠️ 서비스가 늘면 주기당 호출도 그만큼 늘어난다. GPT 를 켜면 벤더가 둘이라
 *    각각 60회/시간이 된다 (쿼터는 벤더별로 따로 세므로 서로를 잡아먹지는 않는다).
 */
export function liveRefreshSeconds(): number {
  const raw = Number(process.env.LIVE_REFRESH_SECONDS);
  return Number.isFinite(raw) && raw >= 30 ? Math.floor(raw) : 60;
}

/**
 * 캐시 키로 쓸 시간 구간. `revalidate` 초를 쓰지 않고 구간 문자열을 키에 넣는
 * 이유는 날짜 키와 같다 — "마지막 호출 + N초" 는 탭이 여러 개면 갱신 시점이
 * 제각각이 된다. 구간이 바뀌는 순간에만 미스가 나게 하면, 탭이 몇 개든 벤더 호출은
 * 구간당 1회로 고정된다.
 */
export function liveBucket(now: Date = new Date()): string {
  const ms = liveRefreshSeconds() * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms).toISOString();
}

const todayCache = new Map<
  ServiceId,
  (bucket: string, from: string, to: string) => Promise<UsageRow[]>
>(
  SERVICES.map((service) => [
    service.id,
    unstable_cache(
      async (_bucket: string, from: string, to: string) =>
        service.fetchTodayUsage(from, to),
      [`vendor-today:${service.id}`],
      // 구간 문자열이 키에 들어가므로 이 값은 상한선일 뿐이다.
      { revalidate: 600, tags: ["usage", `usage:${service.id}`, "live"] },
    ),
  ]),
);

/** KST 오늘 구간의 사용량 행. 미니 위젯 전용. */
export async function getTodayUsage(
  id: ServiceId,
  from: string,
  to: string,
): Promise<Fresh<UsageRow[]>> {
  return todayFallback.get(id)!(() => todayCache.get(id)!(liveBucket(), from, to));
}
