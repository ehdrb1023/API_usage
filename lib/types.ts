/**
 * 대시보드가 다루는 정규화 모델.
 *
 * Claude 와 Vercel 은 원본 응답 구조가 완전히 다르다. UI 가 두 벤더의 스키마를
 * 직접 알지 않도록, 어댑터가 이 모양으로 변환한 뒤에만 화면으로 넘긴다.
 * 나중에 Supabase 를 추가할 때도 어댑터만 하나 더 쓰면 UI 는 그대로다.
 */

export type ServiceId = "claude" | "vercel";

export type RangeId = "7d" | "30d" | "mtd";

export type MetricFormat = "tokens" | "count" | "decimal" | "usd";

/** breakdown 표의 컬럼 정의. 서비스마다 다르다. */
export type MetricSpec = {
  key: string;
  label: string;
  format: MetricFormat;
  /** 단위 접미사 (예: "분", "GB"). 없으면 안 붙임 */
  unit?: string;
};

/** 하루 안에서 모델별 / 프로젝트별로 쪼갠 한 행. */
export type BreakdownItem = {
  key: string;
  label: string;
  costUsd: number;
  metrics: Record<string, number>;
};

export type DailyPoint = {
  /** YYYY-MM-DD (UTC 버킷 시작일) */
  date: string;
  costUsd: number;
  metrics: Record<string, number>;
  items: BreakdownItem[];
};

export type ServiceSeries = {
  service: ServiceId;
  label: string;
  /** breakdown 축 이름 — "모델" / "프로젝트" */
  breakdownLabel: string;
  /** 카드에 쓸 대표 사용량 지표 키 */
  primaryMetric: string;
  metricSpecs: MetricSpec[];
  /** 날짜 오름차순 */
  points: DailyPoint[];
  source: "mock" | "api";
  /** 화면 하단에 띄울 주의문 */
  note?: string;
};
