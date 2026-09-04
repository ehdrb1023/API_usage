/**
 * 선불 잔액 조립 — **소진액을 어디서 가져올 것인가.**
 *
 * ── 층 나누기 ──────────────────────────────────────────────────────────────
 * `balance.ts`      순수 계산 (넣은 돈 − 쓴 돈)
 * `prepaid-rows.ts` 판정 — 이 숫자를 화면에 내보내도 되는가. **테스트가 여기 붙는다**
 * `prepaid.ts`      ← 여기. 벤더 호출·캐시. IO 만 한다
 *
 * ── ⚠️ 본문 시리즈로는 안 된다 ─────────────────────────────────────────────
 * 대시보드 본문은 `kstMonthWindow()` 로 **전월 1일부터**만 조회한다. 그런데
 * 충전 창은 첫 충전일부터다 (실측: Anthropic API 크레딧이 2026-06-04 부터).
 * 본문 구간으로 소진을 세면 **6·7월에 쓴 돈이 빠져 잔액이 실제보다 많아 보인다.**
 * 그래서 여기서는 `since` 부터 다시 조회한다 — 1일 버킷 비용만이라 가볍다
 * (사용량 1시간 버킷 페이지네이션과 달리 한두 페이지로 끝난다).
 *
 * 서버 전용 (네트워크). 클라이언트 컴포넌트에서 import 금지 —
 * 타입만 필요하면 `prepaid-rows.ts` 에서 `import type` 으로 가져갈 것.
 */

import { unstable_cache } from "next/cache";

import { toCostDays as anthropicCostDays } from "@/lib/adapters/anthropic";
import { toCostDays as openaiCostDays } from "@/lib/adapters/openai";
import { fetchAllAnthropicCostBuckets } from "@/lib/clients/anthropic";
import { fetchAllOpenAiCostBuckets, toUnixSeconds } from "@/lib/clients/openai";
import { getDataSourceMode } from "@/lib/data-source";
import { kstCacheKey, kstDay, kstDayStart } from "@/lib/kst";
import type { ServiceId, ServiceSeries } from "@/lib/types";

import { topupWindows, type TopupWindow } from "./balance";
import {
  buildPrepaidRows,
  selectTopups,
  VENDOR_SERVICE,
  type Coverage,
  type PrepaidView,
} from "./prepaid-rows";
import type { Receipt } from "./types";

export type { PrepaidRow, PrepaidView } from "./prepaid-rows";

/**
 * 선불 잔액 화면 데이터.
 *
 * **던지지 않는다.** 소진 조회가 실패하면 그 창만 `spent: null` 로 떨어지고
 * 넣은 돈·충전 이력은 그대로 나온다 — 영수증은 이미 손에 있는 사실이라
 * 벤더 API 사정과 무관하게 보여 줘야 한다.
 *
 * @param series 목업 모드에서 소진을 셀 원본. API 모드에서는 쓰지 않는다
 *               (구간이 전월 1일부터라 충전 창을 못 덮는다 — 위 주석 참고).
 */
export async function getPrepaidView(
  receipts: Receipt[],
  series: ServiceSeries[],
  now: Date = new Date(),
): Promise<PrepaidView> {
  const asOf = kstDay(now);
  const windows = topupWindows(receipts);

  // 창마다 소진을 조회한다. 한 벤더가 실패해도 나머지는 살린다.
  // `catch → null` 은 "못 조회했다" 이지 "안 썼다" 가 아니다 — 판정은 prepaid-rows 가 한다.
  const coverages = await Promise.all(
    windows.map((w) => coverageFor(w, series, now).catch(() => null)),
  );

  return {
    rows: buildPrepaidRows(windows, coverages, asOf),
    topups: selectTopups(receipts),
    asOf,
  };
}

/** 한 창의 소진액. 조회 수단이 없으면 null. */
async function coverageFor(
  window: TopupWindow,
  series: ServiceSeries[],
  now: Date,
): Promise<Coverage> {
  // 구독 초과분은 어떤 구간을 조회해도 안 잡힌다. 부르지도 않는다.
  if (window.pocket !== "api") return null;

  const service = VENDOR_SERVICE[window.vendor];
  if (!service) return null;

  if (getDataSourceMode() === "mock") return mockCoverage(service, window.since, series);
  return apiCoverage(service, window.since, now);
}

/**
 * 목업 모드 — 이미 받아 둔 시리즈에서 센다.
 *
 * 목업 구간은 본문과 같아서 충전 창을 못 덮는 게 정상이다. 그래도 `from` 을
 * 정직하게 돌려주면 화면이 "그 앞은 모름" 으로 표시한다.
 */
function mockCoverage(
  service: ServiceId,
  since: string,
  series: ServiceSeries[],
): Coverage {
  const points = series.find((s) => s.service === service)?.points ?? [];
  if (points.length === 0) return null;

  const spent = points
    .filter((p) => p.date >= since)
    .reduce((sum, p) => sum + p.costUsd, 0);

  return { from: points[0].date, spent: round(spent) };
}

/**
 * API 모드 — `since` 부터 다시 조회한다.
 *
 * **1일 버킷 비용만** 받는다. 잔액에 필요한 건 총액뿐이고, 사용량 1시간 버킷은
 * 구간이 길어지면 페이지가 수십 개가 된다.
 */
async function apiCoverage(
  service: ServiceId,
  since: string,
  now: Date,
): Promise<Coverage> {
  const spent = await cachedSpend(
    service,
    since,
    kstDayStart(since).toISOString(),
    now.toISOString(),
    kstCacheKey(now),
  );
  return spent === null ? null : { from: since, spent };
}

/**
 * 벤더 호출을 KST 하루 단위로 캐싱한다.
 *
 * 키에 `since` 를 넣는 이유: 새 충전이 들어와 창이 앞으로 당겨지면 구간이 달라지므로
 * 캐시도 갈려야 한다. `kstDate` 는 **KST 자정에 캐시 미스를 내는** 부분이다
 * (`lib/data-source.ts` 의 같은 패턴 — UTC 타이머로 잡으면 새 날짜의 첫 9시간이
 * 어제 캐시에 갇힌다).
 */
function cachedSpend(
  service: ServiceId,
  since: string,
  from: string,
  to: string,
  kstDate: string,
): Promise<number | null> {
  return unstable_cache(
    async () => fetchSpend(service, from, to),
    ["prepaid-spend", service, since, kstDate],
    { revalidate: 3600 },
  )();
}

/**
 * 실패는 null 로 돌려준다 — **0 을 돌려주면 "안 썼다" 가 된다.**
 *
 * ⚠️ `limit` 을 비우지 말 것. OpenAI 는 기본 7 이라 8일째부터 조용히 잘린다
 *    (`lib/clients/types.ts` 의 `OpenAiCostsParams` 주석).
 */
async function fetchSpend(
  service: ServiceId,
  from: string,
  to: string,
): Promise<number | null> {
  try {
    if (service === "claude") {
      const buckets = await fetchAllAnthropicCostBuckets({
        starting_at: from,
        ending_at: to,
        bucket_width: "1d",
        limit: 31,
        group_by: ["description", "workspace_id"],
      });
      return sumCost(anthropicCostDays(buckets));
    }

    const buckets = await fetchAllOpenAiCostBuckets({
      start_time: toUnixSeconds(from),
      end_time: toUnixSeconds(to),
      bucket_width: "1d",
      limit: 180,
      group_by: ["line_item", "project_id"],
    });
    return sumCost(openaiCostDays(buckets));
  } catch (error) {
    console.warn(
      "[prepaid] 소진 조회 실패",
      service,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function sumCost(days: { cost: { usd: number }[] }[]): number {
  let sum = 0;
  for (const d of days) for (const c of d.cost) sum += c.usd;
  return round(sum);
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
