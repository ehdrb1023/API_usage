/**
 * 미니 위젯의 조회 구간 — **오늘 / 7일 / 이번 달.**
 *
 * ── 왜 벤더를 더 부르지 않는가 ─────────────────────────────────────────────
 * 지난 날짜의 일별 집계는 이미 하루 캐시(`getVendorDays`)에 들어 있다. 미니 위젯이
 * 지금까지 그걸 "선택창 목록 채우기" 에만 쓰고 버렸는데, 구간 합계는 바로 그
 * 데이터를 더한 것이다. 그래서 구간을 바꿔도 **벤더 호출은 늘지 않는다.**
 *
 * 이게 중요한 이유는 Anthropic Admin API 가 **시간당 90회**이기 때문이다. 기본
 * 주기 60초면 이미 60회/시간을 쓰고 있어서, 구간마다 새로 조회하는 설계였다면
 * 버튼 한 번에 한도를 넘긴다.
 *
 * ── 오늘만 따로 받는 이유 ──────────────────────────────────────────────────
 * 하루 캐시는 하루에 한 번만 갱신된다. 오늘치는 그 안에 없거나 있어도 몇 시간 전
 * 값이라, 실시간으로 쓰려면 1시간 버킷을 따로 받아야 한다. 그래서 구간 합계는
 * **[캐시된 지난 날들] + [방금 받은 오늘]** 로 만든다.
 *
 * 그 결과 지난 날짜가 겹칠 수 있다 — 캐시가 오늘치를 이미 담고 있는 경우다.
 * `sumRange` 가 오늘 날짜를 **캐시 쪽에서 반드시 걷어내는** 이유가 이것이고,
 * 빠뜨리면 오늘 사용량이 조용히 두 배가 된다.
 */

import type { BreakdownItem, DailyPoint } from "@/lib/types";

export type LiveRange = "today" | "7d" | "mtd";

export const LIVE_RANGES: { id: LiveRange; label: string }[] = [
  { id: "today", label: "오늘" },
  { id: "7d", label: "7일" },
  { id: "mtd", label: "이번 달" },
];

export function isLiveRange(v: unknown): v is LiveRange {
  return v === "today" || v === "7d" || v === "mtd";
}

/** 구간의 [시작, 끝] KST 날짜 (양끝 포함). `today` 는 하루짜리 구간이다. */
export function liveRangeBounds(today: string, range: LiveRange): [string, string] {
  if (range === "mtd") return [`${today.slice(0, 7)}-01`, today];
  if (range === "7d") return [addDays(today, -6), today];
  return [today, today];
}

function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * 구간 합계 하나를 만든다.
 *
 * @param history  하루 캐시의 일별 집계 (오늘치가 섞여 있어도 된다 — 걷어낸다)
 * @param today    방금 받은 오늘 집계. 없으면(조회 실패) 지난 날들만으로 만든다
 */
export function sumRange(
  history: DailyPoint[],
  today: DailyPoint | undefined,
  todayDate: string,
  range: LiveRange,
): DailyPoint {
  const [from, to] = liveRangeBounds(todayDate, range);

  const past =
    range === "today"
      ? []
      : history.filter(
          // `< todayDate` 가 이 함수의 핵심이다. 위 주석 참고 — 빼면 오늘이 두 번 더해진다.
          (p) => p.date >= from && p.date <= to && p.date < todayDate,
        );

  const points = today ? [...past, today] : past;
  return {
    date: to,
    costUsd: points.reduce((s, p) => s + (p.costUsd ?? 0), 0),
    metrics: sumMetrics(points.map((p) => p.metrics)),
    items: sumItems(points.flatMap((p) => p.items ?? [])),
    altItems: sumItems(points.flatMap((p) => p.altItems ?? [])),
  };
}

function sumMetrics(all: (Record<string, number> | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of all) {
    for (const [k, v] of Object.entries(m ?? {})) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

/**
 * 같은 key 끼리 합친다. 라벨·힌트·배지는 **먼저 나온 것**을 쓴다.
 *
 * 키 이름은 바뀔 수 있다 (거래처 이름을 고치면 그날 이후로 새 이름이 온다).
 * 구간 안에서 이름이 둘이면 어느 쪽이든 하나를 골라야 하는데, 합계 줄에
 * 옛 이름이 뜨는 편이 낫다 — 최신 이름을 쓰면 "언제부터 이 이름이었나" 를
 * 알 수 없게 되고, 무엇보다 정렬이 날마다 흔들린다.
 */
function sumItems(items: BreakdownItem[]): BreakdownItem[] {
  const out = new Map<string, BreakdownItem>();
  for (const it of items) {
    const cur = out.get(it.key);
    if (!cur) {
      out.set(it.key, { ...it, metrics: { ...it.metrics } });
      continue;
    }
    cur.costUsd += it.costUsd ?? 0;
    for (const [k, v] of Object.entries(it.metrics ?? {})) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      cur.metrics[k] = (cur.metrics[k] ?? 0) + v;
    }
  }
  return [...out.values()].sort((a, b) => b.costUsd - a.costUsd);
}

/** 화면 머리말에 쓸 구간 설명. */
export function rangeNote(todayDate: string, range: LiveRange): string {
  const [from, to] = liveRangeBounds(todayDate, range);
  if (range === "today") return `한국시간 ${to} 00:00 부터 지금까지 (매일 자정 리셋)`;
  if (range === "mtd") return `한국시간 ${from} 부터 지금까지 (매월 1일 리셋)`;
  return `한국시간 ${from} ~ ${to} (7일, 오늘 포함)`;
}
