/**
 * 미니 위젯(/mini)이 주고받는 모양. **클라이언트에서도 import 된다** —
 * 여기에 fs·API 키를 건드리는 코드를 넣지 말 것. 타입과 순수 함수만.
 *
 * 화면에 띄울 한 줄은 (항목, 지표) 한 쌍으로 정해진다.
 *   항목(entry) — "Claude 전체" / "claude-sonnet-5" / "우리 회사 키" / "Vercel 프로젝트 A"
 *   지표(metric) — "비용" / "총 토큰" / "요청·실행" …
 * 이 조합이면 "클로드 토큰", "버셀 비용", "특정 API 키의 출력 토큰" 이 전부
 * 같은 규칙 하나로 표현된다.
 */

import type { MetricFormat, ServiceId } from "@/lib/types";

/** 비용은 지표 목록에 항상 첫 줄로 끼워 넣는다. `metrics` 안의 예약 키. */
export const COST_METRIC_KEY = "costUsd";

export type LiveMetricSpec = {
  key: string;
  label: string;
  format: MetricFormat;
  unit?: string;
  /** 실측이 아니라 추정치인 지표. 화면에 ~ 를 붙인다. */
  estimated?: boolean;
};

export type LiveEntry = {
  /** 서비스 안에서 유일. 예: "total", "model:claude-sonnet-5", "key:apikey_01ABC" */
  id: string;
  label: string;
  /** 라벨 옆 작은 보조 표기 (키 앞자리 등) */
  hint?: string;
  /** 라벨 옆 배지. 예: "비활성" */
  badge?: string;
  /**
   * 오늘 사용량이 없어서 전부 0 인 항목. 선택창에는 나와야 하지만
   * (지금은 안 쓰는 키도 감시 대상이 될 수 있다) 목록 아래쪽으로 내린다.
   */
  idle?: boolean;
  /** COST_METRIC_KEY 포함 */
  metrics: Record<string, number>;
};

export type LiveGroup = {
  /** "total" | "model" | "key" | "project" */
  key: string;
  label: string;
  entries: LiveEntry[];
};

export type LiveService = {
  id: ServiceId;
  label: string;
  /** 이 서비스가 말하는 "오늘" (YYYY-MM-DD) */
  date: string;
  /** 하루를 끊는 기준. 예: "KST", "미 태평양시", "UTC" */
  boundary: string;
  boundaryNote: string;
  /** 이 서비스 숫자가 몇 분 단위로 갱신되는지에 대한 한 줄 설명 */
  freshness: string;
  /** 갱신에 실패해 예전 값을 대신 보여주는 중이면 true. */
  stale?: boolean;
  /** 이 숫자를 벤더에서 실제로 받아온 시각 (ISO). */
  asOf?: string;
  metricSpecs: LiveMetricSpec[];
  /** 선택창이 기본으로 노출할 지표. 나머지는 "지표 전체" 를 켜야 보인다. */
  primaryMetric: string;
  groups: LiveGroup[];
  /** 조회 실패 시 사유. 있으면 groups 는 비어 있다. */
  error?: string;
};

export type LiveSnapshot = {
  /** 스냅샷을 만든 시각 (ISO) */
  updatedAt: string;
  kstDate: string;
  kstTime: string;
  source: "mock" | "api";
  /** 클라이언트가 몇 초마다 다시 물어봐야 하는지. 서버 캐시 구간과 같은 값이다. */
  refreshSeconds: number;
  services: LiveService[];
};

/** 화면에 띄울 한 줄. localStorage 에 이 모양 그대로 저장한다. */
export type LiveLine = {
  service: ServiceId;
  entryId: string;
  metricKey: string;
  /** 항목이 사라졌을 때(모델 단종·키 삭제) 라벨이라도 남기기 위한 사본 */
  fallbackLabel: string;
};

export function lineId(line: LiveLine): string {
  return `${line.service}|${line.entryId}|${line.metricKey}`;
}

export function findService(
  snapshot: LiveSnapshot | null,
  service: ServiceId,
): LiveService | undefined {
  return snapshot?.services.find((s) => s.id === service);
}

export function findEntry(
  service: LiveService | undefined,
  entryId: string,
): LiveEntry | undefined {
  for (const g of service?.groups ?? []) {
    const hit = g.entries.find((e) => e.id === entryId);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 처음 열었을 때 띄우는 줄. 미니 창과 대시보드 선택창이 **같은 기본값**을 봐야 해서
 * 컴포넌트가 아니라 여기에 둔다.
 */
export const DEFAULT_LINES: LiveLine[] = [
  { service: "claude", entryId: "total", metricKey: COST_METRIC_KEY, fallbackLabel: "Claude 전체" },
  { service: "claude", entryId: "total", metricKey: "totalTokens", fallbackLabel: "Claude 전체" },
  { service: "vercel", entryId: "total", metricKey: COST_METRIC_KEY, fallbackLabel: "Vercel 전체" },
  { service: "supabase", entryId: "total", metricKey: COST_METRIC_KEY, fallbackLabel: "Supabase 전체" },
];
