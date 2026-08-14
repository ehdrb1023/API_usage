import type { BreakdownItem, DailyPoint, MetricSpec } from "@/lib/types";

/**
 * Vercel FOCUS v1.3 billing charges → 정규화 모델.
 *   GET /v1/billing/charges?from=&to=&teamId=
 *
 * 실제 응답은 JSONL(한 줄에 charge 1건)이라, 호출부에서 배열로 만들어 넘긴다.
 *
 * 알아둘 것:
 *  - 비용 필드가 두 개다. BilledCost = 청구 기준액, EffectiveCost = 크레딧·할인
 *    상각을 반영한 실질 원가. 대시보드의 "비용"은 BilledCost 를 쓴다.
 *  - 프로젝트는 최상위 필드가 아니라 Tags.ProjectName 에 중첩되어 있다.
 *  - ConsumedQuantity 와 PricingQuantity 는 단위가 다르다
 *    (250,000 requests vs 0.25 million requests). 사용량은 ConsumedQuantity 기준.
 */

export const VERCEL_METRICS: MetricSpec[] = [
  { key: "buildMinutes", label: "빌드 시간", format: "decimal", unit: "분" },
  { key: "invocations", label: "함수 실행", format: "count", unit: "회" },
  { key: "bandwidthGb", label: "대역폭", format: "decimal", unit: "GB" },
];

export const VERCEL_PRIMARY_METRIC = "invocations";

/** ServiceName → 우리 지표 키. 새 서비스가 늘면 여기에만 추가하면 된다. */
const SERVICE_TO_METRIC: Record<string, string> = {
  "Build Execution": "buildMinutes",
  "Function Invocations": "invocations",
  "Fluid Compute": "invocations",
  "Fast Data Transfer": "bandwidthGb",
  "Edge Requests": "invocations",
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
  Tags?: Record<string, string>;
};

export type VercelRaw = { charges: Charge[] };

const EMPTY_METRICS = () => ({
  buildMinutes: 0,
  invocations: 0,
  bandwidthGb: 0,
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
    item.costUsd += c.BilledCost ?? 0;

    const metricKey = SERVICE_TO_METRIC[c.ServiceName];
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
