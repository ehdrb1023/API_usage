import type { BreakdownItem, DailyPoint, MetricSpec } from "@/lib/types";

/**
 * Vercel FOCUS v1.3 billing charges → 정규화 모델.
 *   GET /v1/billing/charges?from=&to=&teamId=
 *
 * 실제 응답은 JSONL(한 줄에 charge 1건)이라, 호출부에서 배열로 만들어 넘긴다.
 *
 * 알아둘 것:
 *  - 비용 필드가 두 개다. BilledCost = 청구 기준액, EffectiveCost = 크레딧·할인
 *    상각을 반영한 실질 원가. 대시보드의 "비용"은 **EffectiveCost** 를 쓴다.
 *    2026-08 실측: Committed(선결제 포함분) 플랜이라 8,708건 중 8,692건의
 *    BilledCost 가 0 이고 합계도 $0.0000000002 였다. 같은 구간 EffectiveCost
 *    합계는 $9.57 로, 실제로 소비한 원가는 이쪽에만 잡힌다.
 *  - 프로젝트는 최상위 필드가 아니라 Tags.ProjectName 에 중첩되어 있다.
 *  - ConsumedQuantity 와 PricingQuantity 는 단위가 다르다
 *    (250,000 requests vs 0.25 million requests). 사용량은 ConsumedQuantity 기준.
 */

/**
 * 지표는 **ConsumedUnit 이 같은 것끼리만** 묶는다. 분과 GB 를 한 칸에 더하면
 * 숫자가 의미를 잃기 때문이다. 실측 61종의 ServiceName 이 쓰는 단위는
 * minute / hour / gigabyte / gigabyte-hour / Invocations·Requests /
 * Reads·Writes·Operations·Units / Events·Data Points·Traces 로 갈린다.
 *
 * `gigabyte` 만 예외적으로 두 지표로 갈린다 — 전송량(Fast Data Transfer)과
 * 저장량(Blob Storage Size)은 단위가 같아도 성격이 완전히 다르다.
 */
export const VERCEL_METRICS: MetricSpec[] = [
  { key: "buildMinutes", label: "빌드 시간", format: "decimal", unit: "분" },
  { key: "invocations", label: "요청·실행", format: "count", unit: "회" },
  { key: "bandwidthGb", label: "전송량", format: "decimal", unit: "GB" },
  { key: "computeHours", label: "CPU 시간", format: "decimal", unit: "시간" },
  { key: "memoryGbHours", label: "메모리", format: "decimal", unit: "GB·h" },
  { key: "storageGb", label: "저장량", format: "decimal", unit: "GB" },
  { key: "dataOps", label: "데이터 연산", format: "count", unit: "건" },
  { key: "events", label: "이벤트", format: "count", unit: "건" },
];

export const VERCEL_PRIMARY_METRIC = "invocations";

/**
 * ServiceName → 지표 키. 2026-08-14 실제 응답에 등장한 61종을 전부 채웠다.
 * (이전에는 5종만 매핑돼 있었고, 그중 "Build Execution"·"Fluid Compute" 는
 *  실제 응답에 존재하지 않는 이름이라 8,708건 중 5,804건이 미분류였다.)
 *
 * 목록에 없는 이름이 새로 생기면 아래 UNIT_TO_METRIC 이 단위로 받아낸다.
 */
const SERVICE_TO_METRIC: Record<string, string> = {
  // minute
  "Build CPU Minutes": "buildMinutes",
  "Build Minutes": "buildMinutes",

  // Invocations / Requests / Execution Units
  "Function Invocations": "invocations",
  "Edge Requests": "invocations",
  "Edge Requests (Flat Rate)": "invocations",
  "Edge Middleware Invocations": "invocations",
  "Edge Function Execution Units": "invocations",
  "Microfrontends Routing": "invocations",
  "Service Requests": "invocations",
  "Firewall Rate Limit Requests": "invocations",
  "Connect Token Requests": "invocations",
  "Flag Requests": "invocations",
  "BotID Deep Analysis Requests": "invocations",

  // gigabyte — 전송
  "Fast Data Transfer": "bandwidthGb",
  "Fast Origin Transfer": "bandwidthGb",
  "Blob Data Transfer": "bandwidthGb",
  "Sandbox Data Transfer": "bandwidthGb",
  "Private Data Transfer": "bandwidthGb",
  "Drains Volume": "bandwidthGb",

  // gigabyte — 저장
  "Blob Storage Size": "storageGb",
  "Snapshot Storage": "storageGb",
  "VCR Storage": "storageGb",
  "Deployment Storage": "storageGb",
  "Serverless Function Storage": "storageGb",
  "Workflow Storage Writes": "storageGb",

  // hour
  "Fluid Active CPU": "computeHours",
  "Sandbox Active CPU": "computeHours",
  "Edge Requests - Additional CPU Duration": "computeHours",

  // gigabyte-hour
  "Fluid Provisioned Memory": "memoryGbHours",
  "Sandbox Provisioned Memory": "memoryGbHours",
  "Function Duration": "memoryGbHours",

  // Reads / Writes / Operations / Units / Transformations / Creations
  "ISR Reads": "dataOps",
  "ISR Writes": "dataOps",
  "Runtime Cache Reads": "dataOps",
  "Runtime Cache Writes": "dataOps",
  "Image Optimization Cache Reads": "dataOps",
  "Image Optimization Cache Writes": "dataOps",
  "Image Optimization Transformation": "dataOps",
  "Global Config Reads (formerly known as Edge Config Reads)": "dataOps",
  "Global Config Writes (formerly known as Edge Config Writes)": "dataOps",
  "Blob Simple Operations": "dataOps",
  "Blob Advanced Operations": "dataOps",
  "KMS Operations": "dataOps",
  "Queue Message Sends": "dataOps",
  "Queue Message Receives": "dataOps",
  "Queue Message Deletes": "dataOps",
  "Queue Visibility Changes": "dataOps",
  "Queue Notifications": "dataOps",
  "Sandbox Creations": "dataOps",

  // Events / Data Points / Traces
  "Observability Events": "events",
  "Web Analytics Events": "events",
  "Workflow Events": "events",
  "Speed Insights Data Points": "events",
  "AI Gateway Traces": "events",

  // 아래는 **일부러 매핑하지 않는다** — 사용량이 아니라 구독·정원 성격이라
  // 어느 지표에 더해도 숫자가 왜곡된다. 비용에는 정상적으로 포함된다.
  //   Pro, Observability Plus            (ConsumedUnit: null — 월 구독료)
  //   Speed Insights, Microfrontends Projects (Projects — 활성 프로젝트 수)
  //   Additional Team Seats              (Seats — 좌석 수)
  //   Vercel Agent                       (Credits — 크레딧 잔량)
  //   Workflow Storage Retention         (gigabyte-month — 보존 기간 가중치)
};

/**
 * ServiceName 이 위 목록에 없을 때의 안전망. Vercel 이 새 서비스를 추가해도
 * 단위만 같으면 자동으로 알맞은 칸에 들어간다.
 *
 * `gigabyte` 는 **일부러 뺐다.** 전송인지 저장인지 단위만으로 구분할 수 없어서,
 * 새 gigabyte 서비스는 위 목록에 손으로 추가해야 한다 (잘못 더하느니 빠뜨린다).
 */
const UNIT_TO_METRIC: Record<string, string> = {
  minute: "buildMinutes",
  hour: "computeHours",
  "gigabyte-hour": "memoryGbHours",
  Invocations: "invocations",
  Requests: "invocations",
  "Execution Units": "invocations",
  Reads: "dataOps",
  Writes: "dataOps",
  Operations: "dataOps",
  Units: "dataOps",
  Transformations: "dataOps",
  Creations: "dataOps",
  Events: "events",
  "Data Points": "events",
  Traces: "events",
};

type Charge = {
  BilledCost: number;
  EffectiveCost: number;
  BillingCurrency: string;
  ChargeCategory: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ConsumedQuantity: number | null;
  ConsumedUnit: string | null;
  ServiceName: string;
  /** FOCUS 의 Tags 는 자유 형식 맵이고, ProjectName 이 빠질 수 있다. */
  Tags?: Record<string, string | undefined>;
};

export type VercelRaw = { charges: Charge[] };

const EMPTY_METRICS = () => ({
  buildMinutes: 0,
  invocations: 0,
  bandwidthGb: 0,
  computeHours: 0,
  memoryGbHours: 0,
  storageGb: 0,
  dataOps: 0,
  events: 0,
});

export function adaptVercel(raw: VercelRaw): DailyPoint[] {
  // date -> project -> item
  const byDate = new Map<string, Map<string, BreakdownItem>>();

  for (const c of raw.charges ?? []) {
    const date = c.ChargePeriodStart.slice(0, 10);
    const project = c.Tags?.ProjectName ?? "(프로젝트 미지정)";

    let projects = byDate.get(date);
    if (!projects) {
      projects = new Map();
      byDate.set(date, projects);
    }
    let item = projects.get(project);
    if (!item) {
      item = { key: project, label: project, costUsd: 0, metrics: EMPTY_METRICS() };
      projects.set(project, item);
    }

    // ChargeCategory 에는 Usage 외에 Credit / Tax / Adjustment / Purchase 가 섞여 온다.
    // "청구 기준 총액"을 보여주는 게 목적이라 전부 더한다. 사용량 비용만 따로 보고
    // 싶어지면 여기서 c.ChargeCategory === "Usage" 로 거르면 된다.
    //
    // BilledCost 가 아니라 EffectiveCost 다 — Committed 플랜에서는 BilledCost 가
    // 거의 전부 0 이라 실제 소비가 화면에서 사라진다. 파일 상단 주석 참고.
    item.costUsd += c.EffectiveCost ?? 0;

    const metricKey =
      SERVICE_TO_METRIC[c.ServiceName] ??
      (c.ConsumedUnit ? UNIT_TO_METRIC[c.ConsumedUnit] : undefined);
    if (metricKey && c.ConsumedQuantity != null) {
      item.metrics[metricKey as keyof ReturnType<typeof EMPTY_METRICS>] +=
        c.ConsumedQuantity;
    }
  }

  return [...byDate.entries()]
    .map(([date, projects]) => {
      const items = [...projects.values()].sort((a, b) => b.costUsd - a.costUsd);

      const metrics = EMPTY_METRICS();
      let costUsd = 0;
      for (const item of items) {
        costUsd += item.costUsd;
        for (const k of Object.keys(metrics) as (keyof typeof metrics)[]) {
          metrics[k] += item.metrics[k] ?? 0;
        }
      }
      return { date, costUsd, metrics, items };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
