/**
 * 대시보드가 다루는 정규화 모델.
 *
 * 벤더마다 원본 응답 구조가 완전히 다르다. UI 가 그 스키마를 직접 알지 않도록,
 * 어댑터가 이 모양으로 변환한 뒤에만 화면으로 넘긴다.
 *
 * **이 대시보드는 AI API 비용만 다룬다** (2026-08-26 확정). 인프라 비용
 * (Vercel·Supabase 등)은 범위 밖이고, 관련 코드는 같은 날 전부 걷어냈다.
 * 새 벤더는 `lib/services.ts` 에 정의 하나를 추가하는 것으로 끝난다.
 */

/**
 * 벤더는 `lib/services.ts` 에 등록한다. 화면 탭 순서도 거기 배열 순서를 따른다.
 *
 * `"cc"` 만 성격이 다르다 — 벤더 Admin API 가 아니라 **이 컴퓨터의 Claude Code
 * 세션 로그**(`~/.claude/projects`)를 읽는다. 그래서 레지스트리에 없고
 * 미니 위젯(실시간) 경로에만 나타난다. 배경은 `lib/local/live.ts` 주석 참고.
 */
export type ServiceId = "claude" | "gpt" | "cc";

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
  /** YYYY-MM-DD — **KST 자정 기준**. `lib/kst-days.ts` 가 접어 준 날짜다. */
  date: string;
  costUsd: number;
  metrics: Record<string, number>;
  items: BreakdownItem[];
  /**
   * 두 번째 breakdown 축. Claude 는 API 키별(= 거래처), GPT 는 프로젝트별.
   * 합계는 `items` 와 같아야 한다 — 같은 하루를 다른 축으로 쪼갠 것뿐이다.
   */
  altItems?: BreakdownItem[];
};

/**
 * 일 경계 기준. **모든 서비스가 KST 자정이다** — 예외를 만들지 않는다.
 *
 * 예전에는 서비스마다 달랐다 (Anthropic UTC, Vercel 미 태평양시, Supabase UTC).
 * 같은 "8월 13일" 이 탭마다 다른 24시간을 가리켜서, 화면에 경고 배너까지
 * 달아야 했다. AI API 만 다루기로 하면서 그 문제가 사라졌다 — 두 벤더 모두
 * 사용량을 1시간 버킷으로 주므로 KST 자정(= UTC 15:00 정각)에 정확히 맞춰
 * 다시 접을 수 있다 (`lib/kst-days.ts`).
 *
 * ⚠️ 새 벤더가 1시간 버킷을 지원하지 않으면 이 전제가 깨진다. 그때는 KST 라고
 *    우기지 말고 여기 `label` 을 다르게 주고 화면에 그대로 드러낼 것.
 */
export type DayBoundary = {
  /** 헤더 배지용 짧은 표기. 예: "KST" */
  label: string;
  /** 각주용 한 줄 설명. */
  note: string;
};

export type ServiceSeries = {
  service: ServiceId;
  label: string;
  /** breakdown 축 이름 — 두 벤더 모두 "모델" */
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
