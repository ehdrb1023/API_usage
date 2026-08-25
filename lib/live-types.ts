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
  metricSpecs: LiveMetricSpec[];
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
