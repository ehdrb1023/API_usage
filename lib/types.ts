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
  /** 라벨 옆에 작게 붙일 보조 식별자. 예: 이름이 겹칠 때의 키 앞자리 */
  hint?: string;
  /** 라벨 옆 배지. 예: "비활성" */
  badge?: string;
  /**
   * 라벨에 마우스를 올렸을 때 뜨는 전체 식별자.
   * `config/client-keys.json` 에 적어 넣으려면 잘리지 않은 api_key_id 가 필요하다.
   */
  title?: string;
};

export type DailyPoint = {
  /** YYYY-MM-DD (UTC 버킷 시작일) */
  date: string;
  costUsd: number;
  metrics: Record<string, number>;
  items: BreakdownItem[];
  /**
   * 두 번째 breakdown 축. 현재는 Claude 의 API 키(=거래처 서비스)별 집계만 채운다.
   * 합계는 `items` 와 같아야 한다 — 같은 하루를 다른 축으로 쪼갠 것뿐이다.
   */
  altItems?: BreakdownItem[];
};

/**
 * 일 경계 기준. **벤더마다 다르다** — 하드코딩하면 안 되는 이유:
 *   Anthropic 버킷은 `00:00:00Z` (UTC 자정) 시작
 *   Vercel charge 는 `07:00:00Z` (미 태평양시 자정) 시작 — 2026-08-14 실측
 * 같은 "8월 13일" 이라도 두 서비스가 가리키는 24시간이 서로 어긋난다.
 */
export type DayBoundary = {
  /** 헤더 배지용 짧은 표기. 예: "UTC", "미 태평양시 (UTC−7)" */
  label: string;
  /** 각주용 한 줄 설명. KST 환산까지 포함한다. */
  note: string;
};

export type ServiceSeries = {
  service: ServiceId;
  label: string;
  /** breakdown 축 이름 — "모델" / "프로젝트" */
  breakdownLabel: string;
  /** 이 시리즈의 날짜가 어느 타임존 자정 기준인지 */
  dayBoundary: DayBoundary;
  /** 카드에 쓸 대표 사용량 지표 키 */
  primaryMetric: string;
  metricSpecs: MetricSpec[];
  /** 날짜 오름차순 */
  points: DailyPoint[];
  source: "mock" | "api";
  /** 화면 하단에 띄울 주의문 */
  note?: string;
  /** 보조 breakdown 표(`DailyPoint.altItems`) 설정. 없으면 표를 그리지 않는다. */
  altBreakdown?: {
    /** 표 제목·첫 컬럼의 축 이름. 예: "서비스" */
    label: string;
    /** 표 상단에 띄울 안내문 */
    notice?: string;
    /** 표 하단 각주 */
    note?: string;
  };
};
