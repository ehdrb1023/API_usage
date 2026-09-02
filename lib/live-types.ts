/**
 * 미니 위젯(/mini)이 주고받는 모양. **클라이언트에서도 import 된다** —
 * 여기에 fs·API 키를 건드리는 코드를 넣지 말 것. 타입과 순수 함수만.
 *
 * 화면에 띄울 한 줄은 (항목, 지표) 한 쌍으로 정해진다.
 *   항목(entry) — "Claude 전체" / "claude-sonnet-5" / "○○법무법인 챗봇" / "GPT 전체"
 *   지표(metric) — "비용" / "총 토큰" / "요청" …
 * 이 조합이면 "클로드 토큰", "GPT 비용", "특정 API 키의 출력 토큰" 이 전부
 * 같은 규칙 하나로 표현된다.
 */

import type { LiveRange } from "@/lib/live-range";
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
  /** "total" | "model" | "alt" */
  key: string;
  label: string;
  entries: LiveEntry[];
};

export type LiveService = {
  id: ServiceId;
  label: string;
  /** 이 서비스가 말하는 "오늘" (YYYY-MM-DD) */
  date: string;
  /** 하루를 끊는 기준. **AI 벤더는 전부 "KST"** — 다른 값이 나오면 전제가 깨진 것이다. */
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
  /** 실응답으로 검증되지 않은 벤더면 그 경고. 미니 창에도 그대로 띄운다. */
  unverified?: string;
  /** 조회 실패 시 사유. 있으면 groups 는 비어 있다. */
  error?: string;
};

/**
 * 구독 한도 한 칸. **금액이 아니라 퍼센트다** — 벤더가 상한을 공개하지 않아서
 * "몇 토큰 남음" 은 만들 수 없다 (lib/quota.ts 주석 참고).
 */
export type QuotaWindow = {
  /** "session" | "weekly_all" | "weekly_scoped" — 벤더가 주는 값 그대로 */
  key: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  /** 이 시각에 0 으로 돌아간다 (ISO). 모르면 null */
  resetsAt: string | null;
  severity: string;
};

export type QuotaSnapshot = {
  windows: QuotaWindow[];
  /** false 면 한도를 넘겨도 과금이 아니라 **중단**이다. 화면 문구가 갈린다. */
  extraUsageEnabled: boolean;
  /** 조회 실패 사유. 있으면 windows 는 비어 있다. */
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
  /** 이 스냅샷이 담고 있는 구간. 클라이언트가 고른 값을 서버가 되돌려 준다. */
  range: LiveRange;
  services: LiveService[];
  /**
   * 구독 한도 잔량. 자격증명이 있는 환경(= 로컬)에서만 채워진다 — 배포본에서는
   * undefined 이고, 그때 미니 창은 이 줄을 통째로 그리지 않는다.
   */
  quota?: QuotaSnapshot;
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
  // GPT 키를 안 넣었으면 그 서비스가 스냅샷에 아예 없다. 줄은 "—" 로 뜨고,
  // 선택창에서 지우면 된다. 기본값에 넣어 두는 편이 "붙이면 바로 보인다".
  { service: "gpt", entryId: "total", metricKey: COST_METRIC_KEY, fallbackLabel: "GPT 전체" },
];
